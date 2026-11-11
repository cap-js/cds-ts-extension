'use strict';
/**
 * CDS build plugin — validates cds.ql tagged-template queries at build/serve time.
 *
 * In build mode (`cds build`): registers a `cql-validator` build task that scans
 * all .js/.ts source files and logs a warning for each invalid query.
 *
 * In watch mode (`cds serve --watch`): runs the same scan once after the model is
 * served, so invalid queries surface in the terminal without blocking startup.
 */

const cds = require('@sap/cds');
const ts = require('typescript');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, extname } = require('node:path');
const { validateCqlQuery } = require('./src/CqlLogic');
const { collectCqlAssignments, extractTemplateText } = require('./src/CqlTypeRewriter');

const log = cds.log('cql-validator');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'gen', '.git', '@cds-models']);

/**
 * Recursively collect all .js and .ts files under `dir`, skipping SKIP_DIRS.
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function collectSourceFiles(dir, acc = []) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return acc;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let stat;
        try {
            stat = statSync(full);
        } catch {
            continue;
        }
        if (stat.isDirectory()) {
            collectSourceFiles(full, acc);
        } else {
            const ext = extname(name);
            if (ext === '.js' || ext === '.ts') acc.push(full);
        }
    }
    return acc;
}

/**
 * Scan one source file for cds.ql templates and return diagnostics with location.
 * This function is pure (no I/O after the caller supplies `src`) and exported for
 * direct use in tests.
 *
 * @param {string} filePath   absolute or relative path (used in diagnostic output only)
 * @param {string} src        raw file contents
 * @param {import('./src/csn').CsnDefs} defs  CSN definitions from cds.model.definitions
 * @returns {Array<{ file: string, line: number, col: number, message: string }>}
 */
function scanFile(filePath, src, defs) {
    const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
    const assignments = collectCqlAssignments(ts, sf);
    if (assignments.length === 0) return [];

    // Infer service prefix from an optional `// @cds-service <Name>` comment anywhere
    // in the file — the same convention used by the IDE plugin's ServiceAnnotation.
    const prefix = src.match(/@cds-service\s+(\S+)/)?.[1];

    const results = [];
    for (const { template } of assignments) {
        const query = extractTemplateText(ts, template);
        const diags = validateCqlQuery(query, defs, prefix);
        for (const d of diags) {
            // d.start is a byte offset into the query string (which starts after the
            // opening backtick). Convert to an absolute position in the source file,
            // then ask TS for line/character.
            const absOff = template.template.getStart(sf) + 1 + d.start;
            const { line, character } = sf.getLineAndCharacterOfPosition(absOff);
            results.push({ file: filePath, line: line + 1, col: character + 1, message: d.message });
        }
    }
    return results;
}

/**
 * Run a full scan of all source files under `root` and log any findings.
 * @param {string} root  project root directory
 * @param {import('./src/csn').CsnDefs} defs
 */
function runScan(root, defs) {
    let count = 0;
    for (const filePath of collectSourceFiles(root)) {
        let src;
        try {
            src = readFileSync(filePath, 'utf8');
        } catch {
            continue;
        }
        for (const d of scanFile(filePath, src, defs)) {
            log.warn(`${d.file}:${d.line}:${d.col}  ${d.message}`);
            count++;
        }
    }
    if (count === 0) log.info('cql-validator: no issues found');
}

// ---------------------------------------------------------------------------
// Build-mode registration (requires @sap/cds-dk >= 7.5.0)
// ---------------------------------------------------------------------------
if (cds.build?.register) {
    class CqlValidatorTask extends cds.build.Plugin {
        static get hasTask() {
            return true;
        }

        async build() {
            const defs = cds.model?.definitions ?? {};
            runScan(cds.root, defs);
        }
    }
    cds.build.register('cql-validator', CqlValidatorTask);
}

// ---------------------------------------------------------------------------
// Watch-mode: one-shot scan after the model is ready
// ---------------------------------------------------------------------------
if (cds.watched) {
    cds.once('served', () => {
        const defs = cds.model?.definitions ?? {};
        runScan(cds.root, defs);
    });
}

module.exports = { scanFile, collectSourceFiles };
