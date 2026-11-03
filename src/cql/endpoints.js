'use strict';
/**
 * Self-contained CQL feature endpoints — completions (getSuggestions) and
 * validation (validateCqlQuery / validateWriteStatement).
 * No LSP or external dependencies — safe to bundle into the tsserver plugin.
 */

const { csnEntryKind, csnText } = require('../csn');
const { tokenizeCql } = require('./lexer');
const { CqlDiagnosticCode } = require('./diagnostic-codes');
const { getCursorClause, extractSourceRelations, isFromJoinKw, stripTrailingDot } = require('./cursor-analysis');
const { resolveSource, resolveBaseType, followAssocPath, isToMany, elementNamesWithForeignKeys, GET_MODEL_SOURCES, SOURCE_KINDS } = require('./csn-resolve');

/** @typedef {import('./types').CqlToken} CqlToken */
/** @typedef {import('./types').CompletionEntry} CompletionEntry */
/** @typedef {import('./types').CqlDiagnostic} CqlDiagnostic */
/** @typedef {import('../csn').CsnDefs} CsnDefs */

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

    // Write statements (UPDATE / INSERT / UPSERT) have no FROM clause, so they
    // are validated by a dedicated path. DELETE has a FROM and flows through the
    // SELECT-oriented logic below.
    const head = significant[0];
    if (head && head.kind === 'identifier') {
        const kw = head.value.toUpperCase();
        if (kw === 'UPDATE' || kw === 'INSERT' || kw === 'UPSERT') {
            return validateWriteStatement(significant, defs, prefix);
        }
    }

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
                const parent = /** @type {import('../csn').CsnArtifact | null | undefined} */ (expandArtifactStack[expandArtifactStack.length - 1]);
                if (parent && lastIdentifier) {
                    const el = /** @type {import('../csn').CsnElement | undefined} */ (parent.elements?.[lastIdentifier]);
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
            lastIdentifier = stripTrailingDot(tok.value);
            continue;
        }

        lastIdentifier = stripTrailingDot(tok.value);

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

        // Inline-dot expand head (`author.{ … }`): the identifier carries a trailing
        // dot and is immediately followed by '{'. It is an association being opened,
        // not a field reference, so skip field validation — the brace-push path
        // resolves it via `lastIdentifier` (already dot-stripped above).
        if (tok.value.endsWith('.') && next && next.kind === 'punctuation' && next.value === '{') {
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
 * Validates an UPDATE / INSERT / UPSERT statement: resolves the target entity
 * and checks the field positions (SET targets + WHERE fields for UPDATE; the
 * column list / ENTRIES keys for INSERT/UPSERT). Literal values (RHS of `=`,
 * VALUES lists) are never validated. Tolerant of partial/mid-typing input.
 * @param {CqlToken[]} significant tokens with whitespace/unknown already removed
 * @param {CsnDefs} defs
 * @param {string} [prefix]
 * @returns {CqlDiagnostic[]}
 */
function validateWriteStatement(significant, defs, prefix) {
    /** @type {CqlDiagnostic[]} */
    const errors = [];
    const kw = /** @type {CqlToken} */ (significant[0]).value.toUpperCase();
    const isUpdate = kw === 'UPDATE';

    // Locate the target entity token.
    //   UPDATE <entity> …                → token at index 1
    //   INSERT|UPSERT INTO <entity> …     → token after the INTO keyword
    let entityIdx;
    if (isUpdate) {
        entityIdx = 1;
    } else {
        const intoIdx = significant.findIndex((t) => t.kind === 'keyword' && t.value.toUpperCase() === 'INTO');
        entityIdx = intoIdx === -1 ? -1 : intoIdx + 1;
    }
    const entityToken = entityIdx >= 0 ? significant[entityIdx] : undefined;
    if (!entityToken || entityToken.kind !== 'identifier') return errors; // partial input

    const resolved = resolveSource(defs, entityToken.value, prefix);
    if (!resolved) {
        errors.push({
            message: `Unknown entity or view '${entityToken.value}'`,
            start: entityToken.start,
            end: entityToken.end,
            code: CqlDiagnosticCode.UnknownEntity,
        });
        return errors;
    }
    const elements = elementNamesWithForeignKeys(resolved.artifact);

    /** Push an UnknownField diagnostic for `tok` unless its field exists. */
    const checkField = (/** @type {CqlToken} */ tok) => {
        // Qualified `alias.field` → validate the final segment (single source).
        const field = tok.value.includes('.') ? (tok.value.split('.').pop() ?? tok.value) : tok.value;
        const dot = tok.value.lastIndexOf('.');
        if (!elements.has(field)) {
            errors.push({
                message: `Unknown field '${field}'`,
                start: dot >= 0 ? tok.start + dot + 1 : tok.start,
                end: tok.end,
                code: CqlDiagnosticCode.UnknownField,
            });
        }
    };

    if (isUpdate) {
        // Find SET … and WHERE … regions.
        const setIdx = significant.findIndex((t) => t.kind === 'identifier' && t.value.toUpperCase() === 'SET');
        const whereIdx = significant.findIndex((t) => t.kind === 'keyword' && t.value.toUpperCase() === 'WHERE');
        const setEnd = whereIdx === -1 ? significant.length : whereIdx;

        if (setIdx !== -1) {
            const objectForm = significant[setIdx + 1]?.kind === 'punctuation' && significant[setIdx + 1]?.value === '{';
            if (objectForm) {
                // SET { field: value , field: value } — key is the identifier before each ':'
                for (let i = setIdx + 2; i < setEnd; i++) {
                    const t = /** @type {CqlToken} */ (significant[i]);
                    const nxt = significant[i + 1];
                    if (t.kind === 'identifier' && nxt && nxt.kind === 'punctuation' && nxt.value === ':') checkField(t);
                }
            } else {
                // SET field = value [, field = value] — the field is the
                // identifier at the start of each comma-separated assignment.
                let atTarget = true;
                for (let i = setIdx + 1; i < setEnd; i++) {
                    const t = /** @type {CqlToken} */ (significant[i]);
                    if (t.kind === 'punctuation' && t.value === ',') {
                        atTarget = true;
                        continue;
                    }
                    if (atTarget) {
                        if (t.kind === 'identifier') checkField(t);
                        atTarget = false; // only the first token of the assignment is the target
                    }
                }
            }
        }

        // WHERE clause: validate identifier operands (the LHS/RHS of predicates),
        // skipping keywords/operators/literals. A function call `fn(field)` keeps
        // the field as a plain identifier operand, so no special handling needed.
        if (whereIdx !== -1) {
            for (let i = whereIdx + 1; i < significant.length; i++) {
                const t = /** @type {CqlToken} */ (significant[i]);
                if (t.kind !== 'identifier') continue;
                // Skip function names (identifier immediately followed by '(').
                const nxt = significant[i + 1];
                if (nxt && nxt.kind === 'punctuation' && nxt.value === '(') continue;
                // Skip SQL logical keywords that tokenize as identifiers are not a
                // concern here (AND/OR/NOT/IN/IS/LIKE/BETWEEN are keywords).
                checkField(t);
            }
        }
        return errors;
    }

    // INSERT / UPSERT — validate column names only.
    // Column list: `( c , c )` directly after the entity, or after a COLUMNS id.
    // ENTRIES object: `{ c : v , c : v }` — keys are identifiers before ':'.
    const entriesIdx = significant.findIndex((t) => t.kind === 'identifier' && t.value.toUpperCase() === 'ENTRIES');
    const valuesIdx = significant.findIndex((t) => t.kind === 'identifier' && t.value.toUpperCase() === 'VALUES');

    if (entriesIdx !== -1) {
        const braceStart = entriesIdx + 1;
        if (significant[braceStart]?.kind === 'punctuation' && significant[braceStart]?.value === '{') {
            for (let i = braceStart + 1; i < significant.length; i++) {
                const t = /** @type {CqlToken} */ (significant[i]);
                if (t.kind === 'punctuation' && t.value === '}') break;
                const nxt = significant[i + 1];
                if (t.kind === 'identifier' && nxt && nxt.kind === 'punctuation' && nxt.value === ':') checkField(t);
            }
        }
        return errors;
    }

    // Column-list form: the first '(' after the entity (and before VALUES) holds
    // the column names. Any identifier inside that paren group is a column.
    let openIdx = -1;
    for (let i = entityIdx + 1; i < significant.length; i++) {
        const t = /** @type {CqlToken} */ (significant[i]);
        if (valuesIdx !== -1 && i >= valuesIdx) break; // don't descend into VALUES
        if (t.kind === 'punctuation' && t.value === '(') {
            openIdx = i;
            break;
        }
    }
    if (openIdx !== -1) {
        let depth = 0;
        for (let i = openIdx; i < significant.length; i++) {
            const t = /** @type {CqlToken} */ (significant[i]);
            if (t.kind === 'punctuation' && t.value === '(') depth++;
            else if (t.kind === 'punctuation' && t.value === ')') {
                depth--;
                if (depth === 0) break;
            } else if (t.kind === 'identifier') checkField(t);
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

module.exports = { getSuggestions, validateCqlQuery };
