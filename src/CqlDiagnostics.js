'use strict';

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */

const { collectCqlAssignments, extractTemplateText } = require('./CqlTypeRewriter');
const { serviceAnnotationFor } = require('./ServiceAnnotation');
/** @typedef {import('./QueryContext').QueryContext} QueryContext */

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * @param {QueryContext} ctx
 * @param {TS} typescript
 * @returns {import('typescript').Diagnostic[]}
 */
function getCqlDiagnostics(ctx, typescript) {
    const { origText, origSf, projectRoot, runWorker, logger } = ctx;

    const assignments = collectCqlAssignments(typescript, origSf);
    if (!assignments.length) return [];

    const diagnostics = [];

    for (const { template } of assignments) {
        const queryText = extractTemplateText(typescript, template);
        const prefix = serviceAnnotationFor(typescript, origText, template, origSf);
        const result = runWorker([projectRoot, queryText, '-1', prefix ?? ''], logger);

        // +1 skips the opening backtick
        const templateContentStart = template.template.getStart(origSf) + 1;

        if (result?.error) {
            // Strict mode: the CDS model could not be loaded/compiled (missing @sap/cds,
            // or an unresolvable `using ... from '@capire/...'` content dependency). Rather
            // than silently offering nothing, mark the query with the compile error so the
            // user knows to install the missing dependency / fix the model.
            logger.info(`[cds-plugin] model unavailable for diagnostics: ${result.error}`);
            diagnostics.push({
                file: origSf,
                start: templateContentStart,
                length: Math.max(1, queryText.length),
                messageText: `CQL features unavailable: ${result.error}`,
                category: typescript.DiagnosticCategory.Warning,
                code: 0,
                source: 'cds',
            });
            continue;
        }
        if (!result?.diagnostics?.length) continue;

        for (const d of result.diagnostics) {
            diagnostics.push({
                file: origSf,
                start: templateContentStart + d.start,
                length: d.end - d.start,
                messageText: d.message,
                category: typescript.DiagnosticCategory.Error,
                code: d.code,
                source: 'cds',
            });
        }
    }

    return diagnostics;
}

module.exports = { getCqlDiagnostics };
