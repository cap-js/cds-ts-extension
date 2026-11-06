'use strict';
/**
 * Cursor / editor-context analysis — given a cursor offset, determine the CQL
 * clause and token context, and extract FROM/JOIN source relations.
 * Self-contained: no LSP or external dependencies.
 */

const { tokenizeCql } = require('./lexer');
const { resolveSource } = require('./csn-resolve');

/** @typedef {import('./types').CqlToken} CqlToken */
/** @typedef {import('./types').CqlSource} CqlSource */
/** @typedef {import('../csn').CsnDefs} CsnDefs */

/** @param {CqlToken | undefined} t @returns {boolean} */
const isFromJoinKw = (t) => t?.kind === 'keyword' && /^(FROM|JOIN|INNER|LEFT|RIGHT|FULL|CROSS)$/i.test(t.value);

/**
 * @typedef {
 *   | { kind: 'entity', fqn: string, token: CqlToken }
 *   | { kind: 'field', token: CqlToken }
 *   | { kind: 'alias', token: CqlToken }
 *   | { kind: 'unknown', token: CqlToken }
 * } CqlTokenContext
 */

/**
 * Given a query string and a cursor offset, returns semantic context for the
 * identifier token under the cursor: whether it is a FROM/JOIN entity name,
 * a field reference, an alias definition, or something else.
 * @param {string} query
 * @param {number} cursorOffset
 * @param {CsnDefs} defs
 * @param {string} [prefix]
 * @returns {CqlTokenContext | null}
 */
function getTokenContext(query, cursorOffset, defs, prefix) {
    const tokens = tokenizeCql(query);
    const token = tokens.find((t) => t.kind === 'identifier' && t.start <= cursorOffset && cursorOffset <= t.end);
    if (!token) return null;

    const significant = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
    const tokIdx = significant.indexOf(token);
    if (tokIdx < 0) return { kind: 'unknown', token };

    const prev = significant[tokIdx - 1];
    const prev2 = significant[tokIdx - 2];

    // Alias definition: immediately after AS, or implicit alias (identifier after FROM-source identifier)
    if (prev?.kind === 'keyword' && prev.value.toUpperCase() === 'AS') {
        return { kind: 'alias', token };
    }

    // Entity name: immediately after FROM/JOIN keywords, or after another identifier that follows FROM/JOIN
    // (the entity itself — not its alias)

    if (isFromJoinKw(prev)) {
        // Token is directly after FROM/JOIN — it's the entity name
        const resolved = resolveSource(defs, token.value, prefix);
        return { kind: 'entity', fqn: resolved?.fqn ?? token.value, token };
    }
    if (prev?.kind === 'identifier' && isFromJoinKw(prev2)) {
        // e.g. FROM Books B — prev is 'Books' (entity), current token is implicit alias
        return { kind: 'alias', token };
    }

    return { kind: 'field', token };
}

/**
 * @typedef {
 *   | { kind: 'select-item', sources: CqlSource[], expandPath: string[] }
 *   | { kind: 'from-source' }
 *   | { kind: 'where-expr', sources: CqlSource[] }
 *   | { kind: 'order-by', sources: CqlSource[] }
 *   | { kind: 'delete-target' }
 *   | { kind: 'delete-body' }
 *   | { kind: 'update-target' }
 *   | { kind: 'update-body', hasSet: boolean }
 *   | { kind: 'insert-target' }
 *   | { kind: 'insert-body' }
 *   | { kind: 'unknown' }
 * } CqlClause
 */

const isNonNull = (/** @type {unknown} */ x) => x !== null;

/**
 * Strips a single trailing '.' from an inline-dot expand head (`author.` → `author`).
 * The tokenizer emits the association before an inline-dot expand (`author.{ … }`) as one
 * identifier token with a trailing dot; mirrors the stripping `parseBraceBlock` already does.
 * @param {string} s
 * @returns {string}
 */
const stripTrailingDot = (s) => (s.endsWith('.') ? s.slice(0, -1) : s);

/**
 * @param {CqlToken[]} tokens
 * @param {number} cursorOffset
 * @returns {CqlClause}
 */
function getCursorClause(tokens, cursorOffset) {
    const significant = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');

    /** @type {CqlClause} */
    let clause = { kind: 'unknown' };
    const fromSources = [];
    let depth = 0;
    let braceDepth = 0;
    // Stack of association names — one entry per open '{', null for the outermost postfix block
    const expandStack = [];
    let afterOrderKeyword = false;
    let pendingEntity = null;
    let expectAlias = false;
    // Set when `AS` is seen inside a projection block: the next identifier is a column
    // alias (`assoc AS alias`), which must NOT overwrite lastIdentifier (the association
    // name that scopes an expand block opening after the alias).
    let expectColumnAlias = false;
    // The identifier token immediately before a '{' or '.{' — becomes the expand name
    let lastIdentifier = null;
    // True once SELECT has been seen with no columns before FROM (postfix projection)
    let postfixMode = false;
    // True once we've passed the entity name after FROM in postfix mode
    let postfixEntitySeen = false;
    // Write-statement tracking: which write head opened the query, and whether its
    // target entity has been named yet. null for SELECT (or no statement yet).
    /** @type {'delete' | 'update' | 'insert' | null} */
    let writeKind = null;
    let writeEntitySeen = false;

    for (const tok of significant) {
        if (tok.start >= cursorOffset) break;

        // Paren depth (subqueries)
        if (tok.kind === 'punctuation' && tok.value === '(') {
            depth++;
            pendingEntity = null;
            expectAlias = false;
            lastIdentifier = null;
            continue;
        }
        if (tok.kind === 'punctuation' && tok.value === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth > 0) continue;

        // Brace handling for expand blocks
        if (tok.kind === 'punctuation' && tok.value === '{') {
            // A postfix entity pending from `FROM Entity {` must be flushed to sources
            // before entering the projection — otherwise it lingers and later `AS`
            // tokens are misread as entity aliases.
            if (pendingEntity !== null) {
                fromSources.push({ entity: pendingEntity, ref: pendingEntity });
                pendingEntity = null;
            }
            braceDepth++;
            if (braceDepth === 1 && postfixMode && postfixEntitySeen) {
                // Outermost postfix projection brace — enter select-item
                expandStack.push(null);
                clause = {
                    kind: 'select-item',
                    sources: fromSources,
                    expandPath: [],
                };
            } else if (braceDepth > 0) {
                // Nested expand — the association name is the identifier just before '{'
                expandStack.push(lastIdentifier);
                clause = {
                    kind: 'select-item',
                    sources: fromSources,
                    expandPath: expandStack.filter(isNonNull),
                };
            }
            lastIdentifier = null;
            continue;
        }
        if (tok.kind === 'punctuation' && tok.value === '}') {
            if (braceDepth > 0) {
                expandStack.pop();
                braceDepth--;
                if (braceDepth === 0) {
                    clause = { kind: 'unknown' };
                } else {
                    clause = {
                        kind: 'select-item',
                        sources: fromSources,
                        expandPath: expandStack.filter(isNonNull),
                    };
                }
            }
            lastIdentifier = null;
            continue;
        }
        if (tok.kind === 'keyword') {
            const kw = tok.value.toUpperCase();
            if (pendingEntity !== null && kw !== 'AS') {
                fromSources.push({ entity: pendingEntity, ref: pendingEntity });
                pendingEntity = null;
            }
            if (kw !== 'ORDER' && kw !== 'GROUP' && kw !== 'BY') afterOrderKeyword = false;
            // Inside a projection block, `AS` introduces a column alias (`assoc AS alias { … }`).
            // Preserve lastIdentifier (the association name) so an expand block opening after
            // the alias is still scoped to the association, not the alias. Elsewhere `AS`
            // clears it as before.
            if (!(kw === 'AS' && braceDepth > 0)) lastIdentifier = null;

            // Detect postfix: SELECT immediately followed by FROM
            if (kw === 'SELECT') {
                clause = {
                    kind: 'select-item',
                    sources: fromSources,
                    expandPath: [],
                };
                expectAlias = false;
                postfixMode = false;
                postfixEntitySeen = false;
                // We'll detect postfix when FROM comes next with nothing in between
                // (tracked by checking whether any identifier was seen between SELECT and FROM)
            } else if (kw === 'DELETE') {
                writeKind = 'delete';
                writeEntitySeen = false;
                clause = { kind: 'delete-target' };
                expectAlias = false;
            } else if (kw === 'UPDATE') {
                writeKind = 'update';
                writeEntitySeen = false;
                clause = { kind: 'update-target' };
                expectAlias = false;
            } else if (kw === 'INSERT' || kw === 'UPSERT') {
                writeKind = 'insert';
                writeEntitySeen = false;
                clause = { kind: 'insert-target' };
                expectAlias = false;
            } else if (kw === 'INTO') {
                // INSERT/UPSERT INTO <entity> — reuse from-source entity completion.
                clause = { kind: 'from-source' };
                expectAlias = false;
            } else if (kw === 'SET') {
                // UPDATE <entity> SET <assignments> — stays in update-body, hasSet true.
                if (writeKind === 'update') clause = { kind: 'update-body', hasSet: true };
                expectAlias = false;
            } else if (kw === 'FROM') {
                if (clause.kind === 'select-item' && clause.expandPath !== undefined && clause.expandPath.length === 0 && fromSources.length === 0 && pendingEntity === null) {
                    // Nothing seen between SELECT and FROM → postfix mode
                    postfixMode = true;
                    postfixEntitySeen = false;
                }
                clause = { kind: 'from-source' };
                expectAlias = false;
            } else if (kw === 'JOIN' || kw === 'INNER' || kw === 'LEFT' || kw === 'RIGHT' || kw === 'FULL' || kw === 'CROSS') {
                clause = { kind: 'from-source' };
                expectAlias = false;
            } else if (kw === 'WHERE' || kw === 'HAVING' || kw === 'ON') {
                clause = { kind: 'where-expr', sources: fromSources };
                expectAlias = false;
            } else if (kw === 'ORDER' || kw === 'GROUP') {
                afterOrderKeyword = true;
                expectAlias = false;
            } else if (kw === 'BY') {
                if (afterOrderKeyword) clause = { kind: 'order-by', sources: fromSources };
                expectAlias = false;
            } else if (kw === 'AS') {
                if (pendingEntity !== null) expectAlias = true;
                else if (braceDepth > 0) expectColumnAlias = true;
            }
            continue;
        }

        if (tok.kind === 'identifier') {
            if (expectColumnAlias) {
                // Column alias (`assoc AS alias`): consume it without clobbering
                // lastIdentifier, so a following '{' still scopes to the association.
                expectColumnAlias = false;
                continue;
            }
            lastIdentifier = stripTrailingDot(tok.value);
            if (expectAlias) {
                fromSources.push({ entity: pendingEntity, ref: tok.value });
                pendingEntity = null;
                expectAlias = false;
            } else if (clause.kind === 'update-target') {
                // UPDATE <entity> — entity named; body expects SET/WHERE next.
                writeEntitySeen = true;
                clause = { kind: 'update-body', hasSet: false };
            } else if (clause.kind === 'from-source') {
                if (pendingEntity === null) {
                    pendingEntity = tok.value;
                    if (postfixMode) postfixEntitySeen = true;
                }
                if (writeKind === 'delete') {
                    // DELETE FROM <entity> — entity named; WHERE may follow.
                    writeEntitySeen = true;
                    clause = { kind: 'delete-body' };
                } else if (writeKind === 'insert') {
                    // INSERT/UPSERT INTO <entity> — entity named; column/VALUES/ENTRIES body.
                    writeEntitySeen = true;
                    clause = { kind: 'insert-body' };
                } else if (!postfixMode) {
                    clause = { kind: 'unknown' };
                }
            }
        }
    }

    if (pendingEntity !== null) fromSources.push({ entity: pendingEntity, ref: pendingEntity });

    if (clause.kind === 'select-item' || clause.kind === 'where-expr' || clause.kind === 'order-by') {
        clause.sources = fromSources;
    }

    return clause;
}

/**
 * @param {CqlToken[]} significant
 * @returns {CqlSource[]}
 */
function extractSourceRelations(significant) {
    const sources = [];
    let depth = 0;
    let pendingEntity = null;
    let expectAlias = false;
    let inFromJoin = false;

    for (const tok of significant) {
        if (tok.kind === 'punctuation' && tok.value === '(') {
            depth++;
            pendingEntity = null;
            expectAlias = false;
            continue;
        }
        if (tok.kind === 'punctuation' && tok.value === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth > 0) continue;

        if (tok.kind === 'keyword') {
            const kw = tok.value.toUpperCase();
            if (pendingEntity !== null && kw !== 'AS') {
                sources.push({ entity: pendingEntity, ref: pendingEntity });
                pendingEntity = null;
            }
            inFromJoin = isFromJoinKw(tok);
            if (kw === 'AS' && pendingEntity !== null) {
                expectAlias = true;
            } else if (!inFromJoin) {
                expectAlias = false;
            }
            continue;
        }

        if (tok.kind === 'identifier') {
            if (expectAlias) {
                sources.push({
                    entity: /** @type {string} */ (pendingEntity),
                    ref: tok.value,
                });
                pendingEntity = null;
                expectAlias = false;
            } else if (pendingEntity !== null) {
                // implicit alias
                sources.push({ entity: pendingEntity, ref: tok.value });
                pendingEntity = null;
            } else if (inFromJoin) {
                pendingEntity = tok.value;
                inFromJoin = false;
            }
        } else {
            if (pendingEntity !== null) {
                sources.push({ entity: pendingEntity, ref: pendingEntity });
                pendingEntity = null;
            }
            expectAlias = false;
        }
    }

    if (pendingEntity !== null) sources.push({ entity: pendingEntity, ref: pendingEntity });
    return sources;
}

module.exports = { getTokenContext, getCursorClause, extractSourceRelations, isFromJoinKw, stripTrailingDot };
