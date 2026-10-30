'use strict';
/**
 * Self-contained CQL tokenizer and query analysis logic.
 * No LSP or external dependencies — safe to bundle into the tsserver plugin.
 */

const { csnEntryKind, csnText } = require('./csn');
/** @typedef {import('./csn').CsnArtifact} CsnArtifact */
/** @typedef {import('./csn').CsnDefs} CsnDefs */
/** @typedef {import('./csn').CsnElement} CsnElement */

/**
 * @typedef {'keyword'|'identifier'|'number'|'string'|'operator'|'punctuation'|'star'|'whitespace'|'unknown'} CqlTokenKind
 */

/**
 * @typedef {{ kind: CqlTokenKind, value: string, start: number, end: number }} CqlToken
 */

/**
 * @typedef {{ name: string, tsType: string }} ResolvedColumn
 */

/**
 * @typedef {{
 *   label: string,
 *   kind: 'field'|'entity'|'view',
 *   detail: string,
 *   entity?: string,
 *   doc?: string,
 *   target?: string,
 *   toMany?: boolean
 * }} CompletionEntry
 */

/**
 * A column in a CQL projection — flat (no expand) or nested (expand block).
 * For a function-call column (`max(ID) as hi`), `func` is the lowercased
 * function name and `arg` is the single field argument (if any), used to infer
 * the result type.
 * @typedef {{ field: string, alias: string, expand?: ExpandColumn[], func?: string, arg?: string }} ExpandColumn
 */

/** @typedef {{ UnknownEntity: 9001, UnknownSource: 9002, UnknownField: 9003, AmbiguousField: 9004 }} CqlDiagnosticCodeEnum */
const CqlDiagnosticCode = Object.freeze({
    UnknownEntity: 9001,
    UnknownSource: 9002,
    UnknownField: 9003,
    AmbiguousField: 9004,
});

/**
 * @typedef {{ message: string, start: number, end: number, code: number }} CqlDiagnostic
 */

const CQL_KEYWORDS = new Set([
    'SELECT',
    'DISTINCT',
    'FROM',
    'WHERE',
    'JOIN',
    'ON',
    'AS',
    'INNER',
    'OUTER',
    'LEFT',
    'RIGHT',
    'FULL',
    'CROSS',
    'ORDER',
    'GROUP',
    'BY',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'UNION',
    'EXCEPT',
    'INTERSECT',
    'INTO',
    'AND',
    'OR',
    'NOT',
    'IN',
    'IS',
    'NULL',
    'LIKE',
    'BETWEEN',
    'EXISTS',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'ASC',
    'DESC',
]);

/**
 * @param {string} query
 * @returns {CqlToken[]}
 */
function tokenizeCql(query) {
    /** @type {CqlToken[]} */
    const tokens = [];
    let pos = 0;
    const len = query.length;

    while (pos < len) {
        const ch = /** @type {string} */ (query[pos]);

        // Whitespace
        if (/\s/.test(ch)) {
            const start = pos;
            while (pos < len && /\s/.test(/** @type {string} */ (query[pos]))) pos++;
            tokens.push({
                kind: 'whitespace',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Line comment
        if (ch === '/' && query[pos + 1] === '/') {
            const start = pos;
            while (pos < len && /** @type {string} */ (query[pos]) !== '\n') pos++;
            tokens.push({
                kind: 'whitespace',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Block comment
        if (ch === '/' && query[pos + 1] === '*') {
            const start = pos;
            pos += 2;
            while (pos < len && !(query[pos] === '*' && query[pos + 1] === '/')) pos++;
            pos += 2;
            tokens.push({
                kind: 'whitespace',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // String literal
        if (ch === "'") {
            const start = pos++;
            while (pos < len && /** @type {string} */ (query[pos]) !== "'") {
                if (/** @type {string} */ (query[pos]) === '\\') pos++;
                pos++;
            }
            pos++;
            tokens.push({
                kind: 'string',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Quoted identifier
        if (ch === '"') {
            const start = pos++;
            while (pos < len && /** @type {string} */ (query[pos]) !== '"') pos++;
            pos++;
            tokens.push({
                kind: 'identifier',
                value: query.slice(start + 1, pos - 1),
                start,
                end: pos,
            });
            continue;
        }

        // Star (standalone)
        if (ch === '*') {
            tokens.push({ kind: 'star', value: '*', start: pos, end: pos + 1 });
            pos++;
            continue;
        }

        // Operators
        if (/[=<>!+\-/%]/.test(ch)) {
            const start = pos;
            if ((ch === '<' || ch === '>' || ch === '!') && query[pos + 1] === '=') pos++;

            if (ch === '<' && query[pos + 1] === '>') pos++;
            pos++;
            tokens.push({
                kind: 'operator',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Punctuation
        if (/[,;()[\]{}]/.test(ch)) {
            tokens.push({
                kind: 'punctuation',
                value: ch,
                start: pos,
                end: pos + 1,
            });
            pos++;
            continue;
        }

        // Number
        if (/\d/.test(ch)) {
            const start = pos;
            while (pos < len && /[\d.]/.test(/** @type {string} */ (query[pos]))) pos++;
            tokens.push({
                kind: 'number',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Identifier or keyword (including dotted names like Books.title)
        if (/[a-zA-Z_$]/.test(ch)) {
            const start = pos;
            while (pos < len && /[a-zA-Z0-9_$.]/.test(/** @type {string} */ (query[pos]))) pos++;
            const value = query.slice(start, pos);
            const upper = value.toUpperCase();
            const kind = /** @type {'keyword' | 'identifier'} */ (CQL_KEYWORDS.has(upper) ? 'keyword' : 'identifier');
            tokens.push({ kind, value, start, end: pos });
            continue;
        }

        tokens.push({ kind: 'unknown', value: ch, start: pos, end: pos + 1 });
        pos++;
    }

    return tokens;
}

/**
 * Parses the column list from a CQL query into a recursive ExpandColumn tree.
 *
 * CQL has two valid projection orderings (see
 * https://cap.cloud.sap/docs/cds/cql#expressions):
 *   Classic:  SELECT ID, title FROM Books
 *   Postfix:  SELECT FROM Books { ID, author { name } }   (SELECT-first, braces after FROM)
 *   Inline:   SELECT FROM Books { ID, author.{ name } }
 *
 * Note: `FROM Entity SELECT …` (FROM keyword before SELECT) is NOT valid CQL and
 * is intentionally not parsed — such a query yields [] (no columns).
 *
 * Returns null when the column list is SELECT * (caller uses all-fields fallback).
 * Returns [] when SELECT/FROM are absent.
 * @param {string} queryText
 * @returns {ExpandColumn[] | null}
 */
function parseCqlColumns(queryText) {
    const toks = tokenizeCql(queryText).filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
    const selectIdx = toks.findIndex((t) => t.kind === 'keyword' && t.value.toUpperCase() === 'SELECT');
    if (selectIdx < 0) return [];

    const fromIdx = toks.findIndex((t, i) => i > selectIdx && t.kind === 'keyword' && t.value.toUpperCase() === 'FROM');
    if (fromIdx < 0) return [];

    // Postfix style: SELECT immediately followed by FROM (nothing between them)
    if (fromIdx === selectIdx + 1) {
        // Skip past entity name(s) and aliases to find the opening brace
        let i = fromIdx + 1;
        // consume: Entity [AS alias | alias] [JOIN ...]
        /** @param {number} idx @returns {CqlToken} */
        const at = (idx) => /** @type {CqlToken} */ (toks[idx]);
        while (i < toks.length && !(at(i).kind === 'punctuation' && at(i).value === '{')) {
            i++;
        }
        if (i >= toks.length) return null; // no brace block
        i++; // step past '{'
        const [cols] = parseBraceBlock(toks, i);
        return cols;
    }

    // Classic style: columns between SELECT and FROM
    const colToks = toks.slice(selectIdx + 1, fromIdx);
    return parseClassicColumns(colToks);
}

/**
 * Parse a comma-separated flat column list (classic SELECT style).
 * Returns null if the list is just '*'.
 * @param {CqlToken[]} toks
 * @returns {ExpandColumn[] | null}
 */
/**
 * If the token at `toks[i]` opens a function-call argument list (a '('),
 * returns the index just past the matching ')' and the single field argument
 * (when the parens contain exactly one identifier, e.g. `max(ID)`). Otherwise
 * returns `{ end: i, arg: undefined }`. Handles nested parens.
 * @param {CqlToken[]} toks
 * @param {number} i index of the '(' (or any token)
 * @returns {{ end: number, arg: string | undefined }}
 */
function skipBalancedParens(toks, i) {
    const open = /** @type {CqlToken | undefined} */ (toks[i]);
    if (!open || open.kind !== 'punctuation' || open.value !== '(') return { end: i, arg: undefined };
    let depth = 0;
    let j = i;
    /** @type {string[]} */
    const idents = [];
    while (j < toks.length) {
        const t = /** @type {CqlToken} */ (toks[j]);
        if (t.kind === 'punctuation' && t.value === '(') depth++;
        else if (t.kind === 'punctuation' && t.value === ')') {
            depth--;
            if (depth === 0) {
                // When the parens contain exactly one identifier token (e.g.
                // `max(ID)` or `max(B.ID)`) we expose it as the argument so the
                // result type can be inferred from that field. A `*`, multiple
                // identifiers, or no identifier at all leaves arg undefined.
                const arg = idents.length === 1 ? idents[0] : undefined;
                return { end: j + 1, arg };
            }
        } else if (t.kind === 'identifier') idents.push(t.value);
        j++;
    }
    return { end: j, arg: undefined }; // unbalanced — consume to end
}

/**
 * Parse a comma-separated classic column list (SELECT a, b, c FROM …).
 * @param {CqlToken[]} toks
 * @returns {ExpandColumn[] | null}
 */
function parseClassicColumns(toks) {
    // Filter to non-whitespace/unknown (already filtered by caller, but be safe)
    const sig = toks.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
    if (sig.length === 0) return null;
    if (sig.length === 1 && /** @type {CqlToken} */ (sig[0]).kind === 'star') return null; // SELECT *

    const result = [];
    let i = 0;
    while (i < sig.length) {
        const tok = /** @type {CqlToken} */ (sig[i]);
        if (tok.kind === 'punctuation' && tok.value === ',') {
            i++;
            continue;
        }
        if (tok.kind === 'star') {
            return null;
        } // SELECT *, col — treat as *
        if (tok.kind !== 'identifier') {
            i++;
            continue;
        }

        const bareField = tok.value.includes('.') ? (tok.value.split('.').pop() ?? tok.value) : tok.value;
        i++;

        // Function call: `fn(args)` — consume the argument span and name the
        // column after the function (overridden by a trailing AS alias below).
        // Record the function name and single field argument for type inference.
        const field = bareField;
        /** @type {string | undefined} */
        let func;
        /** @type {string | undefined} */
        let arg;
        if (i < sig.length && /** @type {CqlToken} */ (sig[i]).kind === 'punctuation' && /** @type {CqlToken} */ (sig[i]).value === '(') {
            func = bareField.toLowerCase();
            const r = skipBalancedParens(sig, i);
            i = r.end;
            arg = r.arg;
        }
        let alias = field;

        // AS alias only — implicit-alias detection is unreliable without comma boundaries
        if (i < sig.length && /** @type {CqlToken} */ (sig[i]).kind === 'keyword' && /** @type {CqlToken} */ (sig[i]).value.toUpperCase() === 'AS') {
            i++; // skip AS
            if (i < sig.length && /** @type {CqlToken} */ (sig[i]).kind === 'identifier') {
                alias = /** @type {CqlToken} */ (sig[i]).value;
                i++;
            }
        }
        result.push(func ? { field, alias, func, arg } : { field, alias });
    }
    return result.length > 0 ? result : null;
}

/**
 * Parse a brace-delimited expand block starting just after the opening '{'.
 * Returns [columns, nextIndex] where nextIndex points past the closing '}'.
 * Returns null columns for a '*'-only block.
 * @param {CqlToken[]} toks
 * @param {number} start
 * @returns {[ExpandColumn[] | null, number]}
 */
function parseBraceBlock(toks, start) {
    const result = [];
    /** @param {number} idx @returns {CqlToken} */
    const at = (idx) => /** @type {CqlToken} */ (toks[idx]);
    let i = start;
    while (i < toks.length) {
        const tok = at(i);

        if (tok.kind === 'punctuation' && tok.value === '}') {
            return [result.length > 0 ? result : null, i + 1];
        }
        if (tok.kind === 'punctuation' && tok.value === ',') {
            i++;
            continue;
        }
        if (tok.kind === 'star') {
            // consume remaining until '}'
            while (i < toks.length && !(at(i).kind === 'punctuation' && at(i).value === '}')) i++;
            return [null, i + 1]; // * → all fields
        }
        if (tok.kind !== 'identifier') {
            i++;
            continue;
        }

        // Identifier may have a trailing dot (inline expand: `author.{`) or a table qualifier
        const rawVal = tok.value.endsWith('.') ? tok.value.slice(0, -1) : tok.value;
        const field = rawVal.includes('.') ? (rawVal.split('.').pop() ?? rawVal) : rawVal;
        // If the raw value ended with '.', the '{' is the very next token (no separate '.' token)
        const hasDot = tok.value.endsWith('.');
        let alias = field;
        i++;

        // Function call: `fn(args)` — consume the argument span. A function
        // column cannot be an expand and has no trailing dot, so handle it
        // before the expand/AS logic. The column is named after the function
        // unless a trailing AS alias overrides it below. Record func/arg for
        // type inference.
        if (!hasDot && i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'punctuation' && /** @type {CqlToken} */ (toks[i]).value === '(') {
            const func = field.toLowerCase();
            const r = skipBalancedParens(toks, i);
            i = r.end;
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'keyword' && /** @type {CqlToken} */ (toks[i]).value.toUpperCase() === 'AS') {
                i++; // skip AS
                if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'identifier') {
                    alias = /** @type {CqlToken} */ (toks[i]).value;
                    i++;
                }
            }
            result.push({ field, alias, func, arg: r.arg });
            continue;
        }

        // Check for expand: `field {`, `field.{` (inline expand), or `field as alias {`.
        // The tokenizer merges `identifier.` into a single identifier token ending with '.'.
        // A separate '.' token is filtered out before this function is called, so we only
        // need to handle the hasDot (trailing-dot identifier) case and the bare '{' case.
        //
        // Order matters: consume an optional `AS alias` FIRST, then look for a following
        // '{'. CQL allows an aliased association expand (`address as residence { … }`),
        // so alias-parsing must not short-circuit expand detection.
        let isExpand = false;
        if (hasDot) {
            // Trailing dot already consumed in identifier — next token should be '{'
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'punctuation' && /** @type {CqlToken} */ (toks[i]).value === '{') {
                i++; // skip '{'
                isExpand = true;
            }
        } else {
            // Optional `AS alias`
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'keyword' && /** @type {CqlToken} */ (toks[i]).value.toUpperCase() === 'AS') {
                i++; // skip AS
                if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'identifier') {
                    alias = /** @type {CqlToken} */ (toks[i]).value;
                    i++;
                }
            }
            // Expand block may follow either the bare field or the `AS alias`.
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'punctuation' && /** @type {CqlToken} */ (toks[i]).value === '{') {
                i++; // skip '{'
                isExpand = true;
            }
        }

        if (isExpand) {
            const [nested, next] = parseBraceBlock(toks, i);
            i = next;
            result.push({ field, alias, expand: nested ?? [] });
        } else {
            result.push({ field, alias });
        }
    }
    return [result.length > 0 ? result : null, i];
}

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
 * @typedef {{ entity: string, ref: string }} CqlSource
 */

/**
 * @typedef {
 *   | { kind: 'select-item', sources: CqlSource[], expandPath: string[] }
 *   | { kind: 'from-source' }
 *   | { kind: 'where-expr', sources: CqlSource[] }
 *   | { kind: 'order-by', sources: CqlSource[] }
 *   | { kind: 'unknown' }
 * } CqlClause
 */

const isNonNull = (/** @type {unknown} */ x) => x !== null;

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
            lastIdentifier = tok.value;
            if (expectAlias) {
                fromSources.push({ entity: pendingEntity, ref: tok.value });
                pendingEntity = null;
                expectAlias = false;
            } else if (clause.kind === 'from-source') {
                if (pendingEntity === null) {
                    pendingEntity = tok.value;
                    if (postfixMode) postfixEntitySeen = true;
                }
                if (!postfixMode) clause = { kind: 'unknown' };
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

/**
 * Maps a CDS built-in type name to a TypeScript type string.
 * @param {string | undefined} typeName
 * @returns {string}
 */
function cdsTypeToTs(typeName) {
    if (!typeName) return 'unknown';
    const short = typeName.replace(/^cds\./, '').replace(/^.*\./, '');
    switch (short) {
        case 'UUID':
        case 'String':
        case 'LargeString':
        case 'Binary':
        case 'LargeBinary':
        case 'Date':
        case 'DateTime':
        case 'Timestamp':
        case 'Time':
        case 'User':
            return 'string';
        case 'Boolean':
            return 'boolean';
        case 'Integer':
        case 'Integer16':
        case 'Integer32':
        case 'Integer64':
        case 'Int16':
        case 'Int32':
        case 'Int64':
        case 'Decimal':
        case 'DecimalFloat':
        case 'Double':
        case 'Float':
            return 'number';
        default:
            return 'unknown';
    }
}

/**
 * Resolves a user-defined CDS type name to its primitive CDS base type by walking
 * the `defs` chain. Stops at built-in `cds.*` types or when the chain ends.
 * Returns the original `typeName` if no definition is found (caller maps to 'unknown').
 * @param {string | undefined} typeName
 * @param {CsnDefs} defs
 * @returns {string | undefined}
 */
function resolveBaseType(typeName, defs) {
    const seen = new Set();
    let current = typeName;
    while (current && !current.startsWith('cds.') && !seen.has(current)) {
        seen.add(current);
        const def = defs[current];
        if (!def) break;
        const next = def.type;
        if (!next || next === current) break;
        current = next;
    }
    return current;
}

const SOURCE_KINDS = new Set(['entity', 'view']);

/** True when an association/composition element's target cardinality is to-many
 *  (`cardinality.max` is `'*'` or a number > 1). To-one associations have no
 *  cardinality or `max === 1`.
 * @param {CsnElement} el
 * @returns {boolean}
 */
function isToMany(el) {
    const max = el?.cardinality?.max;
    return max === '*' || (typeof max === 'number' && max > 1);
}

/** @param {CqlToken | undefined} t @returns {boolean} */
const isFromJoinKw = (t) => t?.kind === 'keyword' && /^(FROM|JOIN|INNER|LEFT|RIGHT|FULL|CROSS)$/i.test(t.value);

/**
 * @param {CsnDefs} defs
 * @param {string} name
 * @param {string | undefined} prefix
 * @returns {{ fqn: string, artifact: CsnArtifact } | null}
 */
function resolveSource(defs, name, prefix) {
    // Draft shadow entities (`<Entity>.drafts`) are not materialised in the
    // compiled CSN — they are generated at runtime by the drafts feature. Strip
    // a trailing `.drafts` and resolve against the base entity, which carries
    // the same element set.
    const base = name.endsWith('.drafts') ? name.slice(0, -'.drafts'.length) : name;

    const key = prefix ? `${prefix}.${base}` : base;
    const artifact = defs[key];
    if (artifact?.kind && SOURCE_KINDS.has(artifact.kind)) return { fqn: key, artifact };
    // Also try fully-qualified lookup when name already includes a dot
    const byFqn = base.includes('.') ? defs[base] : undefined;
    if (byFqn?.kind && SOURCE_KINDS.has(byFqn.kind)) return { fqn: base, artifact: byFqn };
    return null;
}

/**
 * @param {CsnDefs} defs
 * @param {CqlSource[]} sources
 * @param {string | undefined} prefix
 * @returns {Array<{ ref: string, fqn: string, artifact: CsnArtifact }>}
 */
const GET_MODEL_SOURCES = (defs, sources, prefix) =>
    sources
        .map(({ entity, ref }) => {
            const r = resolveSource(defs, entity, prefix);
            return r ? { ref, fqn: r.fqn, artifact: r.artifact } : null;
        })
        .filter((s) => s !== null);

/**
 * Walk an association path through the model starting from startEntity.
 * e.g. startEntity='CatalogService.Books', path=['author', 'address']
 * returns the definition of the terminal entity (the one 'address' points to), or null.
 * @param {CsnDefs} defs
 * @param {string} startEntity
 * @param {string[]} path
 * @returns {CsnArtifact | null}
 */
function followAssocPath(defs, startEntity, path) {
    let current = defs[startEntity];
    if (!current) return null;
    for (const assocName of path) {
        const el = /** @type {import('./csn').CsnElement | undefined} */ (current.elements?.[assocName]);
        if (!el) return null;
        const fk = /** @type {import('./csn').CsnElement | undefined} */ (el['@odata.foreignKey4']);
        const targetName = /** @type {string | undefined} */ (el.target ?? fk?.target);
        if (!targetName) return null;
        current = defs[targetName];
        if (!current) return null;
    }
    return current;
}

/**
 * @param {string} query
 * @param {number} cursorOffset
 * @param {CsnDefs} defs
 * @param {string} [prefix]
 * @returns {CompletionEntry[]}
 */
function getSuggestions(query, cursorOffset, defs, prefix) {
    const tokens = tokenizeCql(query);
    let clause = getCursorClause(tokens, cursorOffset);

    // When the cursor is inside/at-end of an identifier token and clause is unknown,
    // the partial word was consumed as an entity name (e.g. "FROM Auth|").
    // Retry with the cursor moved to just before that token to detect FROM context.
    if (clause.kind === 'unknown') {
        const tokenAtCursor = tokens.find((t) => t.kind === 'identifier' && t.start < cursorOffset && t.end >= cursorOffset);
        if (tokenAtCursor) {
            clause = getCursorClause(tokens, tokenAtCursor.start);
        }
    }

    switch (clause.kind) {
        case 'select-item':
        case 'where-expr':
        case 'order-by': {
            const significant = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
            const effectiveSources = clause.sources.length > 0 ? clause.sources : extractSourceRelations(significant);
            const sources = GET_MODEL_SOURCES(defs, effectiveSources, prefix);
            /** @type {CompletionEntry[]} */
            const items = [];

            // If inside an expand block, scope completions to the terminal association's target entity
            const expandPath = clause.kind === 'select-item' ? clause.expandPath : [];
            if (expandPath.length > 0) {
                for (const { fqn } of sources) {
                    const terminal = followAssocPath(defs, fqn, expandPath);
                    if (!terminal) continue;
                    for (const [name, element] of Object.entries(terminal.elements ?? {})) {
                        const el = element;
                        const doc = csnText(el.doc) ?? el['@description']?.val ?? el['@title']?.val ?? undefined;
                        items.push({
                            label: name,
                            kind: 'field',
                            detail: resolveBaseType(el.type, defs) ?? '',
                            entity: fqn,
                            doc,
                            target: el.target ?? undefined,
                            toMany: el.target ? isToMany(el) : undefined,
                        });
                    }
                }
                return items;
            }

            for (const { fqn, artifact } of sources) {
                for (const [name, element] of Object.entries(artifact.elements ?? {})) {
                    const el = element;
                    const doc = csnText(el.doc) ?? el['@description']?.val ?? el['@title']?.val ?? undefined;
                    items.push({
                        label: name,
                        kind: 'field',
                        detail: resolveBaseType(el.type, defs) ?? '',
                        entity: fqn,
                        doc,
                        target: el.target ?? undefined,
                    });
                }
            }
            return items;
        }

        case 'from-source': {
            /** @type {CompletionEntry[]} */
            const items = [];
            const qualifier = prefix ? prefix + '.' : null;
            for (const [fqn, artifact] of Object.entries(defs)) {
                if (!(artifact.kind && SOURCE_KINDS.has(artifact.kind))) continue;
                if (qualifier) {
                    if (fqn.startsWith(qualifier)) {
                        const localName = fqn.slice(qualifier.length);
                        if (!localName.includes('.'))
                            items.push({
                                label: localName,
                                kind: csnEntryKind(artifact.kind),
                                detail: fqn,
                            });
                    }
                } else {
                    items.push({
                        label: fqn,
                        kind: csnEntryKind(artifact.kind),
                        detail: fqn,
                    });
                }
            }
            return items;
        }

        case 'unknown':
            return [];
    }
    return [];
}

/**
 * @param {string} query
 * @param {CsnDefs} defs
 * @param {string} [prefix]
 * @returns {CqlDiagnostic[]}
 */
function validateCqlQuery(query, defs, prefix) {
    const errors = [];
    const tokens = tokenizeCql(query);
    const significant = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');

    // Collect FROM/JOIN sources and validate them
    const fromEntries = collectFromSourceTokens(significant);
    const resolvedSources = [];
    for (const { entityToken, ref } of fromEntries) {
        const resolved = resolveSource(defs, entityToken.value, prefix);
        if (!resolved) {
            errors.push({
                message: `Unknown entity or view '${entityToken.value}'`,
                start: entityToken.start,
                end: entityToken.end,
                code: CqlDiagnosticCode.UnknownEntity,
            });
        } else {
            resolvedSources.push({
                ref,
                fqn: resolved.fqn,
                artifact: resolved.artifact,
            });
        }
    }

    if (resolvedSources.length === 0) return errors;

    // Per-source element sets (for ambiguity detection) and combined set
    const sourceElements = new Map(); // ref → element names
    const elementCount = new Map(); // name → how many sources have it
    for (const { ref, artifact } of resolvedSources) {
        const names = new Set(Object.keys(artifact.elements ?? {}));
        sourceElements.set(ref, names);
        for (const name of names) elementCount.set(name, (elementCount.get(name) ?? 0) + 1);
    }

    // Paren stack: each entry is 'args' (a function-call argument list, whose
    // field arguments are still validated) or 'skip' (a subquery/grouping paren
    // whose contents are ignored, e.g. `… IN (SELECT 1)`). Contents are skipped
    // whenever any enclosing paren is a 'skip' paren.
    /** @type {Array<'args' | 'skip'>} */
    const parenStack = [];
    const inSkippedParen = () => parenStack.includes('skip');
    let braceDepth = 0;
    // Stack of resolved entity artifacts — one per brace level; null = unresolvable
    const expandArtifactStack = [];
    let clause = 'none';
    let afterOrderKeyword = false;
    let expectAlias = false;
    let lastIdentifier = null; // identifier before a potential '{'
    let prevWasIdentifier = false; // previous significant token was an identifier (field or function-call candidate)

    for (let idx = 0; idx < significant.length; idx++) {
        const tok = /** @type {CqlToken} */ (significant[idx]);
        if (tok.kind === 'punctuation' && tok.value === '(') {
            // A '(' immediately after a bare identifier in a column/predicate
            // context is a function-call argument list (max(ID), count(x), …);
            // its arguments are still validated. Anything else (subquery,
            // grouping) is skipped wholesale.
            const isFnArgs = prevWasIdentifier && (clause === 'select' || clause === 'where' || clause === 'order_by');
            parenStack.push(isFnArgs ? 'args' : 'skip');
            prevWasIdentifier = false;
            continue;
        }
        if (tok.kind === 'punctuation' && tok.value === ')') {
            parenStack.pop();
            prevWasIdentifier = false;
            continue;
        }
        prevWasIdentifier = false;
        if (inSkippedParen()) continue;
        // Inside a function-argument paren a lone '*' (e.g. count(*)) is not a
        // field reference and must not be flagged.
        if (parenStack.length > 0 && tok.kind === 'star') continue;

        // Brace handling for expand blocks
        if (tok.kind === 'punctuation' && tok.value === '{') {
            braceDepth++;
            clause = 'select'; // brace blocks are always a select-projection context
            if (braceDepth === 1) {
                // Outermost postfix block — push first source's artifact
                const root = resolvedSources[0]?.artifact ?? null;
                expandArtifactStack.push(root);
            } else {
                // Nested expand — look up association target from parent artifact
                const parent = /** @type {import('./csn').CsnArtifact | null | undefined} */ (expandArtifactStack[expandArtifactStack.length - 1]);
                if (parent && lastIdentifier) {
                    const el = /** @type {import('./csn').CsnElement | undefined} */ (parent.elements?.[lastIdentifier]);
                    const targetName = /** @type {string | undefined} */ (el?.target);
                    expandArtifactStack.push(targetName ? (defs[targetName] ?? null) : null);
                } else {
                    expandArtifactStack.push(null);
                }
            }
            lastIdentifier = null;
            continue;
        }
        if (tok.kind === 'punctuation' && tok.value === '}') {
            if (braceDepth > 0) {
                expandArtifactStack.pop();
                braceDepth--;
            }
            lastIdentifier = null;
            continue;
        }
        if (tok.kind === 'punctuation' && tok.value === '.') {
            continue;
        }

        if (tok.kind === 'keyword') {
            const kw = tok.value.toUpperCase();
            if (kw !== 'ORDER' && kw !== 'GROUP' && kw !== 'BY') afterOrderKeyword = false;
            if (kw !== 'AS') expectAlias = false;
            lastIdentifier = null;
            switch (kw) {
                case 'SELECT':
                    clause = 'select';
                    break;
                case 'FROM':
                case 'JOIN':
                case 'INNER':
                case 'LEFT':
                case 'RIGHT':
                case 'FULL':
                case 'CROSS':
                    clause = 'none';
                    break;
                case 'WHERE':
                case 'HAVING':
                case 'ON':
                    clause = 'where';
                    break;
                case 'ORDER':
                case 'GROUP':
                    afterOrderKeyword = true;
                    break;
                case 'BY':
                    if (afterOrderKeyword) clause = 'order_by';
                    break;
                case 'AS':
                    expectAlias = true;
                    break;
            }
            continue;
        }

        if (tok.kind === 'star') {
            expectAlias = false;
            lastIdentifier = null;
            continue;
        }
        if (tok.kind !== 'identifier') {
            expectAlias = false;
            lastIdentifier = null;
            continue;
        }
        if (expectAlias) {
            expectAlias = false;
            lastIdentifier = tok.value;
            continue;
        }

        lastIdentifier = tok.value;

        // Any identifier here may be the name preceding a function-call '(' —
        // mark it so a following '(' is treated as an argument list rather than
        // a subquery/grouping paren.
        prevWasIdentifier = true;

        // Function call: an identifier immediately followed by '(' is a function
        // name (max, count, sum, …), not a field. Don't validate it; the opening
        // paren that follows becomes an 'args' paren whose arguments are checked.
        const next = significant[idx + 1];
        if (next && next.kind === 'punctuation' && next.value === '(') {
            continue;
        }

        if (clause === 'select' || clause === 'where' || clause === 'order_by') {
            // Inside an expand block — validate against the current expand context entity
            if (braceDepth > 0) {
                const expandArtifact = expandArtifactStack[expandArtifactStack.length - 1];
                if (expandArtifact) {
                    const elements = expandArtifact.elements ?? {};
                    if (!Object.hasOwn(elements, tok.value)) {
                        errors.push({
                            message: `Unknown field '${tok.value}'`,
                            start: tok.start,
                            end: tok.end,
                            code: CqlDiagnosticCode.UnknownField,
                        });
                    }
                }
                continue;
            }

            if (tok.value.includes('.')) {
                // Qualified reference: tableRef.fieldName
                const dotIdx = tok.value.indexOf('.');
                const tableRef = tok.value.slice(0, dotIdx);
                const field = tok.value.slice(dotIdx + 1);
                const src = resolvedSources.find((s) => s.ref === tableRef);
                if (!src) {
                    errors.push({
                        message: `Unknown source '${tableRef}'`,
                        start: tok.start,
                        end: tok.start + dotIdx,
                        code: CqlDiagnosticCode.UnknownSource,
                    });
                } else if (!sourceElements.get(tableRef)?.has(field)) {
                    errors.push({
                        message: `Unknown field '${field}' on '${src.fqn}'`,
                        start: tok.start + dotIdx + 1,
                        end: tok.end,
                        code: CqlDiagnosticCode.UnknownField,
                    });
                }
            } else {
                // Unqualified reference
                const count = elementCount.get(tok.value) ?? 0;
                if (count === 0) {
                    errors.push({
                        message: `Unknown field '${tok.value}'`,
                        start: tok.start,
                        end: tok.end,
                        code: CqlDiagnosticCode.UnknownField,
                    });
                } else if (count > 1) {
                    const sourceNames = resolvedSources
                        .filter((s) => sourceElements.get(s.ref)?.has(tok.value))
                        .map((s) => s.ref)
                        .join(', ');
                    errors.push({
                        message: `Ambiguous field '${tok.value}' exists in multiple sources: ${sourceNames}`,
                        start: tok.start,
                        end: tok.end,
                        code: CqlDiagnosticCode.AmbiguousField,
                    });
                }
            }
        }
    }

    return errors;
}

/**
 * @param {CqlToken[]} significant
 * @returns {Array<{ entityToken: CqlToken, ref: string }>}
 */
function collectFromSourceTokens(significant) {
    const result = [];
    let depth = 0;
    let pendingEntity = null;
    let expectAlias = false;
    let expectSource = false; // true only right after FROM/JOIN keyword

    for (const tok of significant) {
        if (tok.kind === 'punctuation' && tok.value === '(') {
            depth++;
            pendingEntity = null;
            expectAlias = false;
            expectSource = false;
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
                result.push({
                    entityToken: pendingEntity,
                    ref: pendingEntity.value,
                });
                pendingEntity = null;
            }
            const isFromJoin = isFromJoinKw(tok);
            if (kw === 'AS' && pendingEntity !== null) {
                expectAlias = true;
                expectSource = false;
            } else if (isFromJoin) {
                expectSource = true;
                expectAlias = false;
            } else {
                expectSource = false;
                expectAlias = false;
            }
            continue;
        }

        if (tok.kind === 'identifier') {
            if (expectAlias) {
                result.push({
                    entityToken: /** @type {CqlToken} */ (pendingEntity),
                    ref: tok.value,
                });
                pendingEntity = null;
                expectAlias = false;
            } else if (pendingEntity !== null) {
                // implicit alias (identifier immediately after entity, no AS)
                result.push({ entityToken: pendingEntity, ref: tok.value });
                pendingEntity = null;
                expectSource = false;
            } else if (expectSource) {
                pendingEntity = tok;
                expectSource = false;
            }
            // else: identifier in SELECT/WHERE/etc — ignore
        } else {
            if (pendingEntity !== null) {
                result.push({
                    entityToken: pendingEntity,
                    ref: pendingEntity.value,
                });
                pendingEntity = null;
            }
            expectAlias = false;
        }
    }

    if (pendingEntity !== null) result.push({ entityToken: pendingEntity, ref: pendingEntity.value });
    return result;
}

module.exports = {
    CQL_KEYWORDS,
    CqlDiagnosticCode,
    tokenizeCql,
    parseCqlColumns,
    getTokenContext,
    getCursorClause,
    extractSourceRelations,
    cdsTypeToTs,
    resolveBaseType,
    getSuggestions,
    validateCqlQuery,
};
