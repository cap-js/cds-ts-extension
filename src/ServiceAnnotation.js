'use strict';

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */

/**
 * Looks for a `// @cds-service <Name>` (or `// @cds.service: <Name>`) comment
 * on the line immediately above the statement containing the tagged template
 * expression. Returns the service name, or undefined.
 *
 * Uses `getStart(sf)` on the enclosing VariableStatement to skip leading
 * trivia — the annotation is the last non-empty line before that position.
 *
 * @param {TS} typescript
 * @param {string} sourceText
 * @param {import('typescript/lib/tsserverlibrary').TaggedTemplateExpression} node
 * @param {import('typescript/lib/tsserverlibrary').SourceFile} sf
 * @returns {string | undefined}
 */
function serviceAnnotationFor(typescript, sourceText, node, sf) {
    /** @type {import('typescript').Node} */
    let stmt = node;
    while (stmt.parent && stmt.parent !== sf) {
        if (typescript.isVariableStatement(stmt)) break;
        if (typescript.isExpressionStatement(stmt)) break;
        stmt = stmt.parent;
    }
    const stmtStart = stmt.getStart(sf);
    const before = sourceText.slice(0, stmtStart);
    const lines = before.split('\n');
    const prevLine = lines[lines.length - 2]?.trimEnd() ?? '';
    const m = prevLine.match(/\/\/\s*@cds[-.]service[:\s]\s*(\S+)/);
    return m?.[1];
}

module.exports = { serviceAnnotationFor };
