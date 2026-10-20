'use strict';

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */

/** @typedef {import('./CqlLogic').CompletionEntry} CompletionEntry */
const {
    cdsTypeToTs,
    CQL_KEYWORDS,
    extractSourceRelations,
    getTokenContext,
    tokenizeCql,
} = require('./CqlLogic');
const {
    extractTemplateText,
    findCdsQueryTemplate,
    offsetInTemplate,
    resolveRowTypeBody,
    resolveToCdsQuery,
} = require('./CqlTypeRewriter');
/** @typedef {import('./CqlTypeRewriter').CqlTemplateRef} CqlTemplateRef */
const { parseCqlColumns } = require('./CqlLogic');
const {
    isCdsQueryTag,
    isScopeBoundary,
    isNamedVarDecl,
    unwrapAwait,
} = require('./TsAstHelpers');
const { serviceAnnotationFor } = require('./ServiceAnnotation');
/** @typedef {import('./QueryContext').QueryContext} QueryContext */

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

/**
 * Builds the `displayParts` for a hovered CQL field. Two shapes:
 *   default            →  `(cds field) name: type`
 *   { leadingConst }   →  `const name: type`   (binding-element case)
 * @param {string} name
 * @param {string} tsType
 * @param {{ leadingConst?: boolean }} [opts]
 * @returns {import('typescript').SymbolDisplayPart[]}
 */
function fieldDisplayParts(
    name,
    tsType,
    opts,
) {
    const head = opts?.leadingConst
        ? [
              { kind: 'keyword', text: 'const' },
              { kind: 'space', text: ' ' },
          ]
        : [
              { kind: 'punctuation', text: '(' },
              { kind: 'text', text: 'cds field' },
              { kind: 'punctuation', text: ')' },
              { kind: 'space', text: ' ' },
          ];
    return [
        ...head,
        { kind: 'propertyName', text: name },
        { kind: 'punctuation', text: ':' },
        { kind: 'space', text: ' ' },
        { kind: 'keyword', text: tsType },
    ];
}

/**
 * Probes the CDS model for fields from all sources in a tagged template query.
 * Returns a field map keyed by display name (alias if SELECT has explicit cols).
 * @param {import('typescript').TaggedTemplateExpression} template
 * @param {TS} typescript
 * @param {string} origText
 * @param {import('typescript').SourceFile} origSf
 * @param {string} projectRoot
 * @param {QueryContext['runWorker']} runWorker
 * @param {QueryContext['logger']} logger
 * @returns {Map<string, CompletionEntry>}
 */
function buildFieldMap(
    template,
    typescript,
    origText,
    origSf,
    projectRoot,
    runWorker,
    logger,
) {
    const queryText = extractTemplateText(typescript, template);
    const prefix = serviceAnnotationFor(typescript, origText, template, origSf);
    const significant = tokenizeCql(queryText).filter(
        (t) => t.kind !== 'whitespace' && t.kind !== 'unknown',
    );
    const sources = extractSourceRelations(significant);
    const parsedCols = parseCqlColumns(queryText);
    // Flatten top-level columns only (expand sub-cols are nested; hover shows top-level shape)
    const selectedCols =
        parsedCols === null
            ? null
            : parsedCols.map((c) => ({ field: c.field, alias: c.alias }));
    const rawMap = new Map();

    for (const { entity } of sources) {
        const probePrefix = entity.includes('.') ? '' : (prefix ?? '');
        const probeQuery = `SELECT  FROM ${entity} WHERE `;
        const r = runWorker(
            [projectRoot, probeQuery, String(probeQuery.length), probePrefix],
            logger,
        );
        for (const f of r?.completions?.filter((c) => c.kind === 'field') ??
            []) {
            if (!rawMap.has(f.label)) rawMap.set(f.label, f);
        }
    }

    // Apply SELECT aliases: remap field names to their display aliases
    if (selectedCols !== null && selectedCols.length > 0) {
        const aliased = new Map();
        for (const { field, alias } of selectedCols) {
            const entry = rawMap.get(field);
            if (entry) aliased.set(alias, { ...entry, label: alias });
        }
        return aliased;
    }
    return rawMap;
}

/**
 * Resolves the row object-type *body* (e.g. `{ID:string;author:{name:string}[]}`)
 * for a tagged-template query, reusing the same nested-expand resolution as the
 * type rewriter so hover matches the inferred variable type exactly. Returns null
 * on a worker miss (model not loaded / no columns resolvable) so callers fall back
 * to `unknown`.
 * @param {import('typescript').TaggedTemplateExpression} template
 * @param {TS} typescript
 * @param {string} origText
 * @param {import('typescript').SourceFile} origSf
 * @param {string} projectRoot
 * @param {QueryContext['runBatchWorker']} runBatchWorker
 * @param {QueryContext['logger']} logger
 * @returns {string | null}
 */
function buildHoverRowBody(
    template,
    typescript,
    origText,
    origSf,
    projectRoot,
    runBatchWorker,
    logger,
) {
    const queryText = extractTemplateText(typescript, template);
    const prefix = serviceAnnotationFor(typescript, origText, template, origSf);
    return resolveRowTypeBody(
        typescript,
        queryText,
        prefix ?? undefined,
        projectRoot,
        runBatchWorker,
        logger,
    );
}

/** Walk up from a node to find the first VariableDeclaration whose initializer
 *  (after unwrapping await) is a cds.ql tagged template. Also handles the case
 *  where the initializer is an Identifier that resolves to a cds.ql assignment
 *  within the same scope. Returns null if no cds.ql source is found.
 * @param {import('typescript').Node} node
 * @param {TS} typescript
 * @param {import('typescript').SourceFile} origSf
 * @returns {CqlTemplateRef | null}
 */
function findCqlSourceDecl(
    node,
    typescript,
    origSf,
) {
    let cur = node;
    while (cur && cur.kind !== typescript.SyntaxKind.SourceFile) {
        if (typescript.isVariableDeclaration(cur) && cur.initializer) {
            const { expr: init, awaited } = unwrapAwait(
                typescript,
                cur.initializer,
            );
            if (
                typescript.isTaggedTemplateExpression(init) &&
                isCdsQueryTag(typescript, init.tag)
            )
                return { template: init, awaited };

            // Initializer is an identifier — follow it to its own cds.ql assignment
            if (typescript.isIdentifier(init)) {
                const scope = findAncestorScope(cur, typescript, origSf);
                const name = init.text;
                /** @type {{ template: import('typescript').TaggedTemplateExpression; awaited: boolean } | null} */
                let found = null;
                const scan = (/** @type {import('typescript').Node} */ n) => {
                    if (found) return;
                    if (isNamedVarDecl(typescript, n) && n.name.text === name) {
                        const { expr: iinit, awaited: iawaited } = unwrapAwait(
                            typescript,
                            n.initializer,
                        );
                        if (
                            typescript.isTaggedTemplateExpression(iinit) &&
                            isCdsQueryTag(typescript, iinit.tag)
                        )
                            found = { template: iinit, awaited: iawaited };
                    }
                    if (!isScopeBoundary(typescript, n) || n === scope)
                        typescript.forEachChild(n, scan);
                };
                scan(scope);
                if (found) return found;
            }
        }
        if (isScopeBoundary(typescript, cur)) break;
        cur = cur.parent;
    }
    return null;
}

/**
 * @param {import('typescript').Node} node
 * @param {TS} typescript
 * @param {import('typescript').SourceFile} root
 * @returns {import('typescript').Node}
 */
function findAncestorScope(
    node,
    typescript,
    root,
) {
    let cur = node.parent;
    while (cur && cur !== root) {
        if (isScopeBoundary(typescript, cur)) return cur;
        cur = cur.parent;
    }
    return root;
}

/**
 * @param {string} fileName
 * @param {number} position
 * @param {QueryContext} ctx
 * @param {TS} typescript
 * @returns {import('typescript').QuickInfo | null}
 */
function getCqlHover(
    fileName,
    position,
    ctx,
    typescript,
) {
    const { origText, origSf, projectRoot, runWorker } = ctx;

    // ── Case 1: cursor is directly inside a cds.ql template literal ──
    const template = findCdsQueryTemplate(typescript, origSf, position);
    if (template) {
        const queryText = extractTemplateText(typescript, template);
        const cursorOff = offsetInTemplate(typescript, template, position);
        const prefix = serviceAnnotationFor(
            typescript,
            origText,
            template,
            origSf,
        );
        const tokenCtx = getTokenContext(
            queryText,
            cursorOff,
            {},
            prefix ?? undefined,
        );

        if (tokenCtx?.kind === 'entity') {
            const probeQuery = `SELECT  FROM ${tokenCtx.token.value} WHERE `;
            const probePrefix = tokenCtx.token.value.includes('.')
                ? ''
                : (prefix ?? '');
            const result = runWorker(
                [
                    projectRoot,
                    probeQuery,
                    String(probeQuery.length),
                    probePrefix,
                ],
                ctx.logger,
            );
            const anyField = result?.completions?.find(
                (c) => c.kind === 'field',
            );
            const fqn = anyField?.entity ?? tokenCtx.token.value;
            const tokenStart =
                template.template.getStart(origSf) + 1 + tokenCtx.token.start;
            return {
                kind: typescript.ScriptElementKind.classElement,
                kindModifiers: '',
                textSpan: {
                    start: tokenStart,
                    length: tokenCtx.token.end - tokenCtx.token.start,
                },
                displayParts: [
                    { kind: 'punctuation', text: '(' },
                    { kind: 'text', text: 'cds entity' },
                    { kind: 'punctuation', text: ')' },
                    { kind: 'space', text: ' ' },
                    { kind: 'className', text: fqn },
                ],
                documentation: [],
            };
        }

        if (
            tokenCtx?.kind === 'field' &&
            !CQL_KEYWORDS.has(tokenCtx.token.value.toUpperCase())
        ) {
            const probeQuery = queryText.trimStart().startsWith('SELECT')
                ? queryText
                : `SELECT  FROM ${queryText.match(/FROM\s+(\S+)/i)?.[1] ?? ''} WHERE `;
            const probeOff = probeQuery.toUpperCase().indexOf('SELECT') + 7;
            const result = runWorker(
                [projectRoot, probeQuery, String(probeOff), prefix ?? ''],
                ctx.logger,
            );
            const field = result?.completions?.find(
                (c) => c.kind === 'field' && c.label === tokenCtx.token.value,
            );
            if (field) {
                const tsType = cdsTypeToTs(field.detail);
                const parts = fieldDisplayParts(tokenCtx.token.value, tsType);
                const docs = [];
                if (field.entity)
                    docs.push({
                        kind: 'text',
                        text: `Source: \`${field.entity}\``,
                    });
                if (field.detail) {
                    if (docs.length) docs.push({ kind: 'text', text: '\n\n' });
                    docs.push({
                        kind: 'text',
                        text: `CDS type: \`${field.detail}\``,
                    });
                }
                if (field.doc) {
                    if (docs.length) docs.push({ kind: 'text', text: '\n\n' });
                    docs.push({ kind: 'text', text: field.doc });
                }
                const tokenStart =
                    template.template.getStart(origSf) +
                    1 +
                    tokenCtx.token.start;
                return {
                    kind: typescript.ScriptElementKind.memberVariableElement,
                    kindModifiers: '',
                    textSpan: {
                        start: tokenStart,
                        length: tokenCtx.token.end - tokenCtx.token.start,
                    },
                    displayParts: parts,
                    documentation: docs,
                };
            }
        }

        return null;
    }

    // Find the leaf AST node at the cursor position
    /** @type {(n: import('typescript').Node) => import('typescript').Node | null} */
    const findNodeAt = (n) =>
        n.pos <= position && position <= n.end
            ? (typescript.forEachChild(n, findNodeAt) ?? n)
            : null;
    const leafNode = findNodeAt(origSf);

    // ── Case 2: cursor is on a property access chain rooted at a cds.ql variable ──
    // Handles: result.at(0)?.bookTitle  (hover on 'bookTitle' → show field type)
    // Also handles: result  (hover on result variable → show full array type)
    if (leafNode) {
        // Detect property access: cursor may land on the Identifier name or on the
        // QuestionDotToken (?.) immediately before it (they share the same start offset).
        let propName = null;
        let propSpan = null;
        if (
            typescript.isIdentifier(leafNode) &&
            leafNode.parent &&
            typescript.isPropertyAccessExpression(leafNode.parent) &&
            leafNode.parent.name === leafNode
        ) {
            propName = leafNode.text;
            propSpan = {
                start: leafNode.getStart(origSf),
                length: leafNode.getWidth(origSf),
            };
        } else if (
            leafNode.kind === typescript.SyntaxKind.QuestionDotToken &&
            leafNode.parent &&
            typescript.isPropertyAccessExpression(leafNode.parent)
        ) {
            // Cursor is on ?.  — treat as hover on the property name that follows
            const pae = leafNode.parent;
            propName = pae.name.text;
            propSpan = {
                start: pae.name.getStart(origSf),
                length: pae.name.getWidth(origSf),
            };
        }

        if (propName && propSpan) {
            const resolved = resolveToCdsQuery(typescript, origSf, position);
            if (resolved) {
                const fieldMap = buildFieldMap(
                    resolved.template,
                    typescript,
                    origText,
                    origSf,
                    projectRoot,
                    runWorker,
                    ctx.logger,
                );
                const fieldEntry = fieldMap.get(propName);
                if (fieldEntry) {
                    const tsType = cdsTypeToTs(fieldEntry.detail);
                    return {
                        kind: typescript.ScriptElementKind
                            .memberVariableElement,
                        kindModifiers: '',
                        textSpan: propSpan,
                        displayParts: fieldDisplayParts(propName, tsType),
                        documentation: [],
                    };
                }
            }
        }

        // Not a property access — try resolving as a direct cds.ql variable or chained reference
        if (typescript.isIdentifier(leafNode)) {
            const resolved = resolveToCdsQuery(typescript, origSf, position);
            if (resolved) {
                const rowBody = buildHoverRowBody(
                    resolved.template,
                    typescript,
                    origText,
                    origSf,
                    projectRoot,
                    ctx.runBatchWorker,
                    ctx.logger,
                );
                const typeStr =
                    rowBody === null ? 'unknown' : `{ ${rowBody} }[]`;
                const displayType = resolved.awaited
                    ? typeStr
                    : `Promise<${typeStr}>`;
                const span = {
                    start: leafNode.getStart(origSf),
                    length: leafNode.getWidth(origSf),
                };
                return {
                    kind: typescript.ScriptElementKind.variableElement,
                    kindModifiers: '',
                    textSpan: span,
                    displayParts: [{ kind: 'text', text: displayType }],
                    documentation: [],
                };
            }
        }
    }

    // ── Case 3: cursor is on a binding element destructured from a cds.ql result ──
    // Handles: const [{ID}] = await cds.ql`...`   (hover on 'ID' → field type)
    //          const [fst]  = await cds.ql`...`   (hover on 'fst' → row type)
    //          const [r1]   = result               (hover on 'r1'  → row type via result)
    if (leafNode && typescript.isIdentifier(leafNode)) {
        // Walk up: Identifier → BindingElement → (ObjectBindingPattern →) ArrayBindingPattern → VariableDeclaration
        let cur = leafNode.parent;
        let isNestedObjectField = false; // true when inside {field} inside [...{field}...]
        while (cur && cur.kind !== typescript.SyntaxKind.SourceFile) {
            if (typescript.isObjectBindingPattern(cur)) {
                isNestedObjectField = true;
            }
            if (
                typescript.isVariableDeclaration(cur) &&
                typescript.isArrayBindingPattern(cur.name) &&
                cur.initializer
            ) {
                const source = findCqlSourceDecl(cur, typescript, origSf);
                if (source) {
                    if (isNestedObjectField) {
                        // const [{ID}] = ... → show type of the specific field
                        const fieldMap = buildFieldMap(
                            source.template,
                            typescript,
                            origText,
                            origSf,
                            projectRoot,
                            runWorker,
                            ctx.logger,
                        );
                        const fieldEntry = fieldMap.get(leafNode.text);
                        if (fieldEntry) {
                            const tsType = cdsTypeToTs(fieldEntry.detail);
                            return {
                                kind: typescript.ScriptElementKind
                                    .memberVariableElement,
                                kindModifiers: '',
                                textSpan: {
                                    start: leafNode.getStart(origSf),
                                    length: leafNode.getWidth(origSf),
                                },
                                displayParts: fieldDisplayParts(
                                    leafNode.text,
                                    tsType,
                                    { leadingConst: true },
                                ),
                                documentation: [],
                            };
                        }
                    } else {
                        // const [fst] = ... or const [r1] = result → show row type
                        const rowBody = buildHoverRowBody(
                            source.template,
                            typescript,
                            origText,
                            origSf,
                            projectRoot,
                            ctx.runBatchWorker,
                            ctx.logger,
                        );
                        const rowType =
                            rowBody === null ? 'unknown' : `{ ${rowBody} }`;
                        return {
                            kind: typescript.ScriptElementKind.variableElement,
                            kindModifiers: '',
                            textSpan: {
                                start: leafNode.getStart(origSf),
                                length: leafNode.getWidth(origSf),
                            },
                            displayParts: [
                                { kind: 'keyword', text: 'const' },
                                { kind: 'space', text: ' ' },
                                { kind: 'localName', text: leafNode.text },
                                { kind: 'punctuation', text: ':' },
                                { kind: 'space', text: ' ' },
                                { kind: 'text', text: rowType },
                            ],
                            documentation: [],
                        };
                    }
                }
                break;
            }
            if (isScopeBoundary(typescript, cur)) break;
            cur = cur.parent;
        }
    }

    return null;
}

module.exports = { getCqlHover };
