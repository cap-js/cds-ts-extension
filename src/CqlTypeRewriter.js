'use strict';
/**
 * TS AST helpers and in-place snapshot rewriting for cds.ql type inference.
 *
 * For each `const v = (await) cds.ql\`...\`` declaration, rewrites the
 * initializer span in-place with a same-length JSDoc cast so TypeScript
 * infers the result type without shifting any character positions.
 */

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */

/** @typedef {import('./CqlLogic').CompletionEntry} CompletionEntry */
/** @typedef {import('./CqlLogic').ExpandColumn} ExpandColumn */
const { cdsTypeToTs, extractSourceRelations, parseCqlColumns, tokenizeCql } = require('./CqlLogic');
const { serviceAnnotationFor } = require('./ServiceAnnotation');
/** @typedef {import('./QueryContext').RunWorker} RunWorker */
/** @typedef {import('./QueryContext').RunBatchWorker} RunBatchWorker */
const { findAncestor, isCdsQlInit, isCdsQueryTag, isDestructurableVarDecl, isMemberAccess, isMemberOrCallAccess, isNamedVarDecl, isScopeBoundary, unwrapAwait } = require('./TsAstHelpers');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A resolved `cds.ql` tagged template, plus whether it was `await`ed.
 * @typedef {{ template: import('typescript').TaggedTemplateExpression; awaited: boolean }} CqlTemplateRef
 */

/**
 * @typedef {{ template: import('typescript').TaggedTemplateExpression; awaited: boolean; varName: string }} CqlAssignment
 */

// ---------------------------------------------------------------------------
// Template text extraction
// ---------------------------------------------------------------------------

/**
 * @param {TS} ts
 * @param {import('typescript').TaggedTemplateExpression} node
 * @returns {string}
 */
const extractTemplateText = (ts, { template }) =>
    ts.isNoSubstitutionTemplateLiteral(template) ? template.text : template.templateSpans.reduce((text, span) => text + ' ' + span.literal.text, template.head.text);

/** Returns the offset of `position` within the template literal content.
 * @param {TS} ts
 * @param {import('typescript').TaggedTemplateExpression} node
 * @param {number} position
 * @returns {number}
 */
const offsetInTemplate = (ts, node, position) =>
    // +1 to skip the opening backtick
    position - (node.template.pos + 1);

// ---------------------------------------------------------------------------
// AST traversal
// ---------------------------------------------------------------------------

/**
 * @param {TS} ts
 * @param {import('typescript').SourceFile} sourceFile
 * @param {number} position
 * @returns {import('typescript').TaggedTemplateExpression | null}
 */
function findCdsQueryTemplate(ts, sourceFile, position) {
    /** @type {(node: import('typescript').Node) => import('typescript').TaggedTemplateExpression | null} */
    const visit = (node) =>
        ts.isTaggedTemplateExpression(node) && isCdsQueryTag(ts, node.tag) && node.template.pos <= position && position <= node.template.end ? node : (ts.forEachChild(node, visit) ?? null);
    return visit(sourceFile);
}

/**
 * @param {TS} ts
 * @param {import('typescript').SourceFile} sourceFile
 * @param {number} position
 * @returns {CqlTemplateRef | null}
 */
function resolveToCdsQuery(ts, sourceFile, position) {
    const direct = findCdsQueryTemplate(ts, sourceFile, position);
    if (direct) return { template: direct, awaited: false };

    /** @type {(n: import('typescript').Node) => import('typescript').Node | null} */
    const findNode = (n) => (n.pos <= position && position <= n.end ? (ts.forEachChild(n, findNode) ?? n) : null);
    const node = findNode(sourceFile);
    if (!node) return null;

    const candidates = [];
    if (ts.isIdentifier(node)) candidates.push(node);

    let cur = node;
    while (cur && cur !== sourceFile) {
        if (isMemberAccess(ts, cur)) {
            let expr = cur.expression;
            while (isMemberOrCallAccess(ts, expr)) {
                expr = expr.expression;
            }
            if (ts.isIdentifier(expr)) candidates.push(expr);
        }
        cur = cur.parent;
    }

    for (const ident of candidates) {
        const tpl = findOriginatingTemplateInScope(ts, ident, sourceFile);
        if (tpl) return { template: tpl.template, awaited: tpl.awaited };
    }
    return null;
}

/** Like findOriginatingTemplate but scope-aware: searches only the innermost
 *  function/block that contains `ident`, so two variables named `x` in
 *  different scopes resolve to their own declarations.
 * @param {TS} ts
 * @param {import('typescript').Identifier} ident
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {CqlTemplateRef | null}
 */
function findOriginatingTemplateInScope(ts, ident, sourceFile) {
    const scope = findAncestor(ident, /** @type {(n: import('typescript').Node) => n is import('typescript').Node} */ ((n) => isScopeBoundary(ts, n))) ?? sourceFile;

    const name = ident.text;
    /** @type {CqlTemplateRef | null} */
    let found = null;
    function scan(/** @type {import('typescript').Node} */ n) {
        if (found) return;
        if (isNamedVarDecl(ts, n) && n.name.text === name) {
            const { expr: init, awaited } = unwrapAwait(ts, n.initializer);
            if (isCdsQlInit(ts, init)) found = { template: init, awaited };
        }
        // Don't recurse into nested scopes (they have their own `x`).
        if (!isScopeBoundary(ts, n) || n === scope) ts.forEachChild(n, scan);
    }
    scan(scope);
    return found;
}

/**
 * @param {TS} ts
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {CqlAssignment[]}
 */
function collectCqlAssignments(ts, sourceFile) {
    /** @type {CqlAssignment[]} */
    const results = [];
    function visit(/** @type {import('typescript').Node} */ node) {
        if (isDestructurableVarDecl(ts, node)) {
            const { expr: init, awaited } = unwrapAwait(ts, node.initializer);
            if (isCdsQlInit(ts, init)) {
                const varName = ts.isIdentifier(node.name) ? node.name.text : '[destructured]';
                results.push({ varName, template: init, awaited });
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return results;
}

/**
 * Collect every `cds.ql\`...\`` tagged template in a source file,
 * regardless of whether it is assigned to a variable. Use this for
 * validation passes (e.g. the build plugin) where side-effect queries
 * such as bare `await cds.ql\`UPDATE ...\`` must also be checked.
 *
 * @param {TS} ts
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {CqlTemplateRef[]}
 */
function collectCqlTemplates(ts, sourceFile) {
    /** @type {CqlTemplateRef[]} */
    const results = [];
    function visit(/** @type {import('typescript').Node} */ node) {
        if (isCdsQlInit(ts, /** @type {import('typescript').Expression} */ (node))) {
            const awaited = ts.isAwaitExpression(node.parent);
            results.push({ template: /** @type {import('typescript').TaggedTemplateExpression} */ (node), awaited });
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return results;
}

// ---------------------------------------------------------------------------
// Type string helpers
// ---------------------------------------------------------------------------

/**
 * @param {CompletionEntry[]} columns
 * @returns {string}
 */
function buildTypeString(columns) {
    const fields = columns.filter((c) => c.kind === 'field');
    return fields.length === 0 ? 'unknown' : `{ ${fields.map((c) => `${c.label}: ${cdsTypeToTs(c.detail)}`).join('; ')} }[]`;
}

/**
 * Returns the identifier token (and its span within the query text) at the
 * given cursor offset inside a CQL query string, or null if the cursor is not
 * on an identifier.
 * @param {string} queryText
 * @param {number} offset
 * @returns {{ name: string; start: number; end: number } | null}
 */
function fieldTokenAtOffset(queryText, offset) {
    const isIdChar = (/** @type {string} */ c) => /[a-zA-Z0-9_$]/.test(c);
    if (!(isIdChar(queryText[offset] ?? '') || isIdChar(queryText[offset - 1] ?? ''))) return null;
    let s = offset;
    while (s > 0 && isIdChar(/** @type {string} */ (queryText[s - 1]))) s--;
    let e = offset;
    while (e < queryText.length && isIdChar(/** @type {string} */ (queryText[e]))) e++;
    const name = queryText.slice(s, e);
    return name ? { name, start: s, end: e } : null;
}

// ---------------------------------------------------------------------------
// In-place snapshot rewriting
// ---------------------------------------------------------------------------

/**
 * Builds a replacement string of exactly `(end - start)` bytes:
 *  - Starts with `cast` (no newlines allowed in cast).
 *  - Preserves the same number of `\n` characters as the original span, placed
 *    at or after the cast end so the cast is never split mid-token.
 *    Newlines that originally fell inside the cast are shifted just past it,
 *    preserving their relative order.
 *  - All remaining bytes are spaces.
 *
 * Total byte count is unchanged, so all positions after `end` are unaffected.
 * @param {string} cast
 * @param {string} sourceText
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function padWithNewlines(cast, sourceText, start, end) {
    const budget = end - start;
    if (budget === cast.length) return cast;

    // Collect original newline relative offsets.
    const origNewlines = [];
    for (let i = start; i < end; i++) {
        if (sourceText[i] === '\n') origNewlines.push(i - start);
    }

    if (origNewlines.length === 0) return cast.padEnd(budget);

    // Place newlines: any that fall inside the cast are shifted to immediately after it,
    // maintaining their order.  Newlines already after the cast stay at their original offset.
    const buf = new Array(budget).fill(' ');
    for (let i = 0; i < cast.length; i++) buf[i] = cast[i];

    let nextAvail = cast.length; // next position after cast where a displaced newline can go
    for (const rel of origNewlines) {
        const pos = Math.max(rel, nextAvail);
        if (pos < budget) {
            buf[pos] = '\n';
            nextAvail = pos + 1;
        }
    }
    return buf.join('');
}

/**
 * Infers the TS type of a function-call result column.
 *   - `count` → `number` (row/value count).
 *   - arg-preserving aggregates (`max`/`min`/`sum`/`avg`) → the TS type of the
 *     single field argument, resolved via the field map.
 *   - anything else (unknown function, `*`, multi-arg, or unresolvable arg) →
 *     `unknown`.
 * @param {string} func lowercased function name
 * @param {string | undefined} arg single field argument name, if any
 * @param {Map<string, CompletionEntry>} fieldMap
 * @returns {string}
 */
function aggregateResultType(func, arg, fieldMap) {
    if (func === 'count') return 'number';
    if (func === 'max' || func === 'min' || func === 'sum' || func === 'avg') {
        // The arg may be qualified (`B.ID`) while fieldMap is keyed by bare
        // labels (`ID`) — fall back to the final path segment.
        const entry = arg ? (fieldMap.get(arg) ?? fieldMap.get(arg.split('.').pop() ?? arg)) : undefined;
        if (entry && !entry.target) return cdsTypeToTs(entry.detail);
    }
    return 'unknown';
}

/**
 * Recursively builds a TS object-type body string from a parsed column tree.
 * cols=null means SELECT * at this level → use all scalar fields from fieldMap.
 * Association columns with an expand sub-tree recurse into batchFields[target].
 * @param {ExpandColumn[] | null} cols
 * @param {Map<string, CompletionEntry>} fieldMap
 * @param {Record<string, CompletionEntry[]>} batchFields
 * @returns {string}
 */
function buildTypeBody(cols, fieldMap, batchFields) {
    const entries = [];
    if (cols === null) {
        // SELECT * — emit all scalar fields
        for (const [label, entry] of fieldMap) {
            if (!(entry.detail.startsWith('cds.Association') || entry.detail.startsWith('cds.Composition'))) entries.push(`${label}:${cdsTypeToTs(entry.detail)}`);
        }
    } else {
        for (const col of cols) {
            if (col.expand !== undefined) {
                // Association expand — look up target entity fields
                const assocEntry = fieldMap.get(col.field);
                const target = assocEntry?.target;
                const subFields = target ? batchFields[target] : undefined;
                const subMap = new Map((subFields ?? []).map((f) => [f.label, f]));
                const subBody = buildTypeBody(col.expand.length === 0 ? null : col.expand, subMap, batchFields);
                entries.push(`${col.alias}:{${subBody}}${assocEntry?.toMany ? '[]' : ''}`);
            } else if (col.func) {
                // Function-call column: infer the result type. `count` is always
                // numeric; arg-preserving aggregates (max/min/sum/avg) take the
                // type of their single field argument; anything else is unknown.
                entries.push(`${col.alias}:${aggregateResultType(col.func, col.arg, fieldMap)}`);
            } else {
                const entry = fieldMap.get(col.field);
                if (entry) {
                    // Association without explicit expand: produce implicit SELECT * expand
                    if (entry.target) {
                        const subFields = batchFields[entry.target];
                        const subMap = new Map((subFields ?? []).map((f) => [f.label, f]));
                        const subBody = buildTypeBody(null, subMap, batchFields);
                        entries.push(`${col.alias}:{${subBody}}${entry.toMany ? '[]' : ''}`);
                    } else {
                        entries.push(`${col.alias}:${cdsTypeToTs(entry.detail)}`);
                    }
                }
            }
        }
    }
    return entries.join(';');
}

/**
 * Resolves the row object-type *body* (e.g. `{ID:number;author:{name:string}[]}`)
 * for a single cds.ql query by probing the CDS model via the worker. Recurses into
 * association expand targets via a BFS so nested expands render as nested object
 * types — the same resolution the hover display reuses. Returns null on a worker
 * miss (model not loaded, entity unknown, or no columns resolvable) so callers can
 * skip caching and retry later. The returned body has NO leading `{`/trailing `}[]`
 * wrapper — callers wrap it for their context (array row, single row, Promise).
 * @param {TS} ts
 * @param {string} queryText
 * @param {string | undefined} effectivePrefix
 * @param {string} projectRoot
 * @param {RunBatchWorker} runBatchWorker
 * @param {import('typescript/lib/tsserverlibrary').server.Logger} logger
 * @returns {string | null}
 */
function resolveRowTypeBody(ts, queryText, effectivePrefix, projectRoot, runBatchWorker, logger) {
    // Collect all FROM/JOIN sources, probe each for fields, merge results
    const significant = tokenizeCql(queryText).filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
    const sources = extractSourceRelations(significant);
    if (!sources.length) return null;

    const probes = sources.map(({ entity }) => ({
        entity,
        prefix: entity.includes('.') ? '' : (effectivePrefix ?? ''),
    }));
    const batchResult = runBatchWorker(projectRoot, probes, logger);

    /** @type {import('./CqlLogic').CompletionEntry[]} */
    const allFields = [];
    for (const { entity } of sources) {
        const fields = batchResult?.fields?.[entity] ?? [];
        for (const f of fields) {
            if (!allFields.some((x) => x.label === f.label)) allFields.push(f);
        }
    }
    if (!allFields.length) return null;

    // Parse column tree (handles flat, postfix-projection and expand blocks)
    const fieldMap = new Map(allFields.map((c) => [c.label, c]));
    const parsedCols = parseCqlColumns(queryText);

    // Collect expand-target entity FQNs by BFS through the expand tree.
    const batchFields = /** @type {Record<string, import('./CqlLogic').CompletionEntry[]>} */ ({});
    if (parsedCols !== null) {
        for (const [entity, fields] of Object.entries(batchResult?.fields ?? {})) {
            if (fields) batchFields[entity] = fields;
        }

        let frontier = [{ cols: parsedCols, map: fieldMap }];

        while (frontier.length > 0) {
            const needed = new Set();
            for (const { cols, map } of frontier) {
                for (const col of cols) {
                    const t = map.get(col.field)?.target;
                    if (t && !batchFields[t]) needed.add(t);
                }
            }

            if (needed.size > 0) {
                const probes = [...needed].map((entity) => ({
                    entity,
                    prefix: entity.includes('.') ? '' : (effectivePrefix ?? ''),
                }));
                const result = runBatchWorker(projectRoot, probes, logger);
                for (const t of needed) {
                    const tf = result?.fields?.[t];
                    if (tf) batchFields[t] = tf;
                }
            }

            const next = [];
            for (const { cols, map } of frontier) {
                for (const col of cols) {
                    if (col.expand !== undefined && col.expand.length > 0) {
                        const t = map.get(col.field)?.target;
                        const subFields = t ? (batchFields[t] ?? []) : [];
                        const subMap = new Map(subFields.map((f) => [f.label, f]));
                        next.push({ cols: col.expand, map: subMap });
                    }
                }
            }
            frontier = next;
        }
    }

    const typeBody = buildTypeBody(parsedCols, fieldMap, batchFields);
    return typeBody ? typeBody : null;
}

/**
 * Builds the awaited result-value type for a write statement. CAP resolves an
 * awaited write query to an affected-row count (`UPDATE`/`DELETE`) or an insert
 * result (`INSERT`/`UPSERT`). We emit fixed concrete types rather than deriving
 * from `typeof cds` — `@sap/cds` is usually untyped, and an `any`-fallback guard
 * proved too brittle (it leaks back to `any`). The returned expression is the
 * **awaited value** type; the caller wraps it in `Promise<…>` when not awaited.
 *
 *   UPDATE / DELETE → `number` (affected-row count)
 *   INSERT / UPSERT → `{ affected: number }` (CAP InsertResult accessor)
 *
 * @param {'UPDATE' | 'DELETE' | 'INSERT' | 'UPSERT'} kind
 * @returns {string} the awaited value type expression
 */
function writeStatementValueType(kind) {
    return kind === 'INSERT' || kind === 'UPSERT' ? '{affected:number}' : 'number';
}

const WRITE_STATEMENT_RE = /^\s*(UPDATE|INSERT|UPSERT|DELETE)\b/i;

/**
 * Resolves the alias type expression (e.g. `{ID:number;title:string}[]` or its
 * `Promise<…>` form) for a single cds.ql query. Thin wrapper over
 * `resolveRowTypeBody` that applies the array/awaited wrapping. Returns null on a
 * worker miss so the caller can skip caching and retry later.
 * @param {TS} ts
 * @param {string} queryText
 * @param {string | undefined} effectivePrefix
 * @param {boolean} awaited
 * @param {string} projectRoot
 * @param {RunBatchWorker} runBatchWorker
 * @param {import('typescript/lib/tsserverlibrary').server.Logger} logger
 * @returns {string | null}
 */
function resolveTypeExpr(ts, queryText, effectivePrefix, awaited, projectRoot, runBatchWorker, logger) {
    // Write statements (UPDATE/INSERT/UPSERT/DELETE) don't return rows — their
    // awaited result is a count / insert-result, derivable purely from `typeof
    // cds` with no model probe. Short-circuit before touching the worker.
    const write = WRITE_STATEMENT_RE.exec(queryText);
    if (write) {
        const kind = /** @type {'UPDATE' | 'DELETE' | 'INSERT' | 'UPSERT'} */ (/** @type {string} */ (write[1]).toUpperCase());
        const value = writeStatementValueType(kind);
        return awaited ? value : `Promise<${value}>`;
    }

    const typeBody = resolveRowTypeBody(ts, queryText, effectivePrefix, projectRoot, runBatchWorker, logger);
    if (typeBody === null) return null;

    const innerType = `{${typeBody}}[]`;
    return awaited ? innerType : `Promise<${innerType}>`;
}

/**
 * Places the same-length cast for one resolved assignment into `replacements`
 * and appends its tail alias. Pure string/AST work — no worker involvement — so
 * it can run synchronously on every keystroke once the type is known.
 * @param {TS} ts
 * @param {import('typescript').SourceFile} sf
 * @param {string} fileName
 * @param {string} sourceText
 * @param {import('typescript').TaggedTemplateExpression} template
 * @param {string} varName
 * @param {string} typeExpr
 * @param {Array<{ start: number; end: number; text: string }>} replacements
 * @param {string[]} tailAliases
 * @param {Map<string, Array<{ start: number; end: number }>> | undefined} rewrittenRanges
 * @param {import('typescript/lib/tsserverlibrary').server.Logger} logger
 * @returns {void}
 */
function placeCast(ts, sf, fileName, sourceText, template, varName, typeExpr, replacements, tailAliases, rewrittenRanges, logger) {
    // Walk up from the template node to its VariableDeclaration
    const decl = findAncestor(template, ts.isVariableDeclaration);
    if (!decl) return;

    // Always use an alias so the cast in the source is a plain identifier —
    // inlining complex types with `{` or `<` breaks VS Code's syntax highlighter.
    // Alias name encodes the declaration line number: stable and unique per file.
    const lineNum = ts.getLineAndCharacterOfPosition(sf, decl.pos).line;
    const aliasName = `_q${lineNum}`;
    const isTs = /\.tsx?$/.test(fileName);

    if (isTs) {
        // TS strategy: replace only the template literal span
        // (template.template.pos → template.template.end) with:
        //   `` as unknown as _qN<spaces>
        // This leaves `const/let/var varName = (await) cds.ql` untouched.
        const tplLit = template.template;
        const replaceStart = tplLit.pos;
        const replaceEnd = tplLit.end;
        const budget = replaceEnd - replaceStart;
        const cast = `\`\` as unknown as ${aliasName}`;

        if (cast.length <= budget) {
            const text = padWithNewlines(cast, sourceText, replaceStart, replaceEnd);
            replacements.push({ start: replaceStart, end: replaceEnd, text });
            rewrittenRanges?.get(fileName)?.push({ start: replaceStart, end: replaceEnd }) ?? rewrittenRanges?.set(fileName, [{ start: replaceStart, end: replaceEnd }]);
            tailAliases.push(`type ${aliasName}=${typeExpr};`);
            logger.info(`[cds-plugin] rewrite ${varName}: alias=${aliasName} budget=${budget} cast-len=${cast.length} type=${typeExpr.slice(0, 60)}`);
        } else {
            logger.info(`[cds-plugin] type for ${varName} too long even for alias (budget=${budget}), skipping`);
        }
    } else {
        // JS strategy: JSDoc @type cast on the initializer span (name.end → initEnd).
        // The cast base must be a value whose type overlaps the query's (object/array)
        // type — otherwise TS2352 fires under `checkJs` ("neither type sufficiently
        // overlaps … convert to 'unknown' first"). A literal `0` (type `number`) does
        // NOT overlap an object/array type and trips exactly that error, so we use an
        // empty object literal `{}` instead: it overlaps object, array, and even
        // primitive result types. It costs one more budget char than `0` (2 chars vs
        // 1), which can push a query right at its budget limit to be skipped — an
        // acceptable trade for a cast that actually type-checks.
        const replaceStart = decl.name.end;
        const replaceEnd = decl.initializer?.end;
        if (replaceEnd === undefined) return;
        const budget = replaceEnd - replaceStart;
        const jsCast = ` = (/**@type{${aliasName}}*/({}))`;

        if (jsCast.length <= budget) {
            const text = padWithNewlines(jsCast, sourceText, replaceStart, replaceEnd);
            replacements.push({ start: replaceStart, end: replaceEnd, text });
            rewrittenRanges?.get(fileName)?.push({ start: replaceStart, end: replaceEnd }) ?? rewrittenRanges?.set(fileName, [{ start: replaceStart, end: replaceEnd }]);
            tailAliases.push(`/**@typedef {${typeExpr}} ${aliasName}*/`);
            logger.info(`[cds-plugin] rewrite ${varName}: alias=${aliasName} js-budget=${budget} type=${typeExpr.slice(0, 60)}`);
        } else {
            logger.info(`[cds-plugin] type for ${varName} too long even for alias (budget=${budget}), skipping`);
        }
    }
}

/**
 * For each `const v = (await) cds.ql\`...\`` in sourceText, replaces the
 * initializer span with a same-length cast so TypeScript infers T without
 * shifting any character positions.
 *
 * Returns the (possibly unchanged) rewritten text; updates originalSource as
 * a side-effect so completions/hover can still find the original templates.
 * @param {string} fileName
 * @param {string} sourceText
 * @param {TS} ts
 * @param {Map<string, string>} originalSource
 * @param {Map<string, { sourceText: string; rewritten: string }>} rewriteCache
 * @param {RunWorker} _runWorker
 * @param {RunBatchWorker} runBatchWorker
 * @param {import('typescript/lib/tsserverlibrary').server.Logger} logger
 * @param {string} projectRoot
 * @param {string | undefined} prefix
 * @param {Map<string, Array<{ start: number; end: number }>> | undefined} rewrittenRanges
 * @param {{ typeExprCache?: Map<string, string>; cacheOnly?: boolean } | undefined} opts
 * @returns {string}
 */
function rewriteSnapshot(fileName, sourceText, ts, originalSource, rewriteCache, _runWorker, runBatchWorker, logger, projectRoot, prefix, rewrittenRanges, opts) {
    const typeExprCache = opts?.typeExprCache;
    const cacheOnly = opts?.cacheOnly ?? false;
    const cached = rewriteCache.get(fileName);
    if (cached && cached.sourceText === sourceText) return cached.rewritten;

    // Clear stale ranges for this file before computing fresh ones
    rewrittenRanges?.delete(fileName);

    // Always record original so completions/hover can find templates
    originalSource.set(fileName, sourceText);

    const scriptKind = /\.tsx?$/.test(fileName) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
    const assignments = collectCqlAssignments(ts, sf);
    logger.info(`[cds-plugin] rewrite: ${assignments.length} assignments in ${fileName.split('/').pop()}`);

    if (assignments.length === 0) {
        rewriteCache.set(fileName, { sourceText, rewritten: sourceText });
        return sourceText;
    }

    /** @type {Array<{ start: number; end: number; text: string }>} */
    const replacements = [];
    /** @type {string[]} */
    const tailAliases = []; // type __cds_N = ...; lines appended at end
    let workerMiss = false; // true if any assignment was skipped because the worker returned no fields

    for (const { varName, template, awaited } of assignments) {
        const effectivePrefix = serviceAnnotationFor(ts, sourceText, template, sf) ?? prefix;
        const queryText = extractTemplateText(ts, template);

        // Type resolution is keyed purely by (queryText, prefix, awaited). If we've
        // resolved this exact query before, reuse the cached alias type expression —
        // no worker call needed. This lets the plugin re-place casts synchronously
        // when only the surrounding TS code changed, matching the live buffer exactly
        // (no debounce, no stale-snapshot flash).
        const cacheKey = `${awaited ? 'A' : 'P'} ${effectivePrefix ?? ''} ${queryText}`;
        const cachedTypeExpr = typeExprCache?.get(cacheKey);

        let typeExpr;
        if (cachedTypeExpr !== undefined) {
            typeExpr = cachedTypeExpr;
        } else if (cacheOnly && !WRITE_STATEMENT_RE.test(queryText)) {
            // Cache-only mode and this query isn't resolved yet — defer to async path.
            // Write statements (UPDATE/DELETE/INSERT/UPSERT) are exempt: they resolve
            // synchronously from typeof cds with no worker, so always place them now.
            workerMiss = true;
            continue;
        } else {
            const resolved = resolveTypeExpr(ts, queryText, effectivePrefix, awaited, projectRoot, runBatchWorker, logger);
            if (resolved === null) {
                workerMiss = true;
                continue;
            }
            typeExpr = resolved;
            typeExprCache?.set(cacheKey, typeExpr);
        }

        placeCast(ts, sf, fileName, sourceText, template, varName, typeExpr, replacements, tailAliases, rewrittenRanges, logger);
    }

    if (replacements.length === 0) {
        if (!workerMiss) rewriteCache.set(fileName, { sourceText, rewritten: sourceText });
        return sourceText;
    }

    replacements.sort((a, b) => b.start - a.start);
    let rewritten = sourceText;
    for (const { start, end, text } of replacements) rewritten = rewritten.slice(0, start) + text + rewritten.slice(end);

    // Append type aliases for declarations whose full type didn't fit inline.
    // These go on new lines at the very end — they don't affect byte offsets of
    // any existing lines, so the tsserver line→offset conversion remains correct
    // for all cursor positions within the original file content.
    if (tailAliases.length > 0) {
        const tail = '\n' + tailAliases.join('\n');
        rewritten += tail;
    }

    // Only cache when every assignment was resolved — if any worker call returned no
    // fields (model not yet loaded, entity not found transiently), skip caching so the
    // next snapshot call can retry and pick up the missing types.
    if (!workerMiss) {
        rewriteCache.set(fileName, { sourceText, rewritten });
    }
    logger.info(`[cds-plugin] rewrote ${fileName.split('/').pop()}, ${replacements.length} vars, ${tailAliases.length} tail aliases${workerMiss ? ' (partial — not cached)' : ''}`);
    return rewritten;
}

module.exports = {
    extractTemplateText,
    offsetInTemplate,
    findCdsQueryTemplate,
    resolveToCdsQuery,
    collectCqlAssignments,
    collectCqlTemplates,
    buildTypeString,
    buildTypeBody,
    resolveTypeExpr,
    fieldTokenAtOffset,
    resolveRowTypeBody,
    rewriteSnapshot,
    writeStatementValueType,
    WRITE_STATEMENT_RE,
};
