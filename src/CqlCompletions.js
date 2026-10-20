'use strict';

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */

const { findCdsQueryTemplate, extractTemplateText, offsetInTemplate } = require('./CqlTypeRewriter');
const { findAncestor } = require('./TsAstHelpers');
const { serviceAnnotationFor } = require('./ServiceAnnotation');
/** @typedef {import('./QueryContext').QueryContext} QueryContext */

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

/**
 * @param {string} fileName
 * @param {number} position
 * @param {QueryContext} ctx
 * @param {TS} typescript
 * @returns {import('typescript').CompletionInfo | null}
 */
function getCqlCompletions(fileName, position, ctx, typescript) {
    const { origText, origSf, projectRoot, runWorker, logger } = ctx;

    const resolved = findCdsQueryTemplate(typescript, origSf, position);
    logger.info(`[cds-plugin] completions pos=${position} origTextLen=${origText.length} foundTemplate=${!!resolved}`);
    if (!resolved) return null;

    const queryText = extractTemplateText(typescript, resolved);
    const cursorOff = offsetInTemplate(typescript, resolved, position);
    const prefix = serviceAnnotationFor(typescript, origText, resolved, origSf);

    logger.info(`[cds-plugin] completions at offset ${cursorOff} prefix="${prefix}" in "${queryText.trim().slice(0, 60)}"`);

    const result = runWorker([projectRoot, queryText, String(cursorOff), prefix ?? ''], logger);
    if (result?.error) {
        // The model failed to load/compile (e.g. a missing `using ... from '@capire/...'`
        // dependency, or no @sap/cds resolvable). We stay strict — no partial model — but
        // surface *why* completions are empty instead of failing silently.
        logger.info(`[cds-plugin] no completions — model unavailable: ${result.error}`);
        return null;
    }
    if (!result?.completions?.length) return null;

    const entries = result.completions.map((c) => {
        const isEntity = c.kind === 'entity' || c.kind === 'view';
        return {
            name: c.label,
            kind: c.kind === 'field' ? typescript.ScriptElementKind.memberVariableElement : typescript.ScriptElementKind.classElement,
            kindModifiers: '',
            sortText: '0_' + c.label,
            labelDetails: c.detail ? { detail: `: ${c.detail}` } : undefined,
            ...(isEntity && !prefix
                ? /** @type {{ hasAction: true; source: string }} */ ({
                      hasAction: true,
                      source: `cds:${c.detail}`,
                  })
                : {}),
        };
    });

    return {
        isGlobalCompletion: false,
        isMemberCompletion: false,
        isNewIdentifierLocation: false,
        entries,
    };
}

// ---------------------------------------------------------------------------
// Completion entry details (annotation insertion)
// ---------------------------------------------------------------------------

/**
 * @param {string} fileName
 * @param {number} position
 * @param {string} entryName
 * @param {string | undefined} source
 * @param {QueryContext} ctx
 * @param {TS} typescript
 * @returns {import('typescript').CompletionEntryDetails | null}
 */
function getCqlCompletionDetails(fileName, position, entryName, source, ctx, typescript) {
    if (!source?.startsWith('cds:')) return null;

    const { origText, origSf } = ctx;

    const template = findCdsQueryTemplate(typescript, origSf, position);
    if (!template) return null;

    const stmt = findAncestor(template, typescript.isVariableStatement) ?? template;
    const stmtStart = stmt.getStart(origSf);
    const lineStart = origText.lastIndexOf('\n', stmtStart - 1) + 1;
    const indent = origText.slice(lineStart, stmtStart).match(/^(\s*)/)?.[1] ?? '';

    const fqn = source.slice(4);
    // The service prefix is the FQN minus its last segment (the entity name).
    // CAP service names are themselves dotted namespaces (e.g. the entity
    // `sap.capire.hotels.Hotels` belongs to service `sap.capire.hotels`), so
    // taking only the first segment ("sap") would scope to the wrong service.
    const lastDot = fqn.lastIndexOf('.');
    const serviceName = lastDot > 0 ? fqn.slice(0, lastDot) : undefined;
    if (!serviceName) return null;

    const annotation = `${indent}// @cds-service ${serviceName}\n`;
    const insertionSpan = { start: lineStart, length: 0 };

    return {
        name: entryName,
        kind: typescript.ScriptElementKind.classElement,
        kindModifiers: '',
        displayParts: [],
        codeActions: [
            {
                description: `Scope queries in this file to ${serviceName}`,
                changes: [
                    {
                        fileName,
                        textChanges: [{ span: insertionSpan, newText: annotation }],
                    },
                ],
            },
        ],
    };
}

module.exports = { getCqlCompletions, getCqlCompletionDetails };
