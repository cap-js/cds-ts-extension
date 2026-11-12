'use strict';
/**
 * CDS build plugin — validates cds.ql tagged-template queries at build time.
 * Registers a `cql-validator` build task that scans all .js/.ts source files
 * and logs a warning for each invalid query.
 */

// Resolve @sap/cds from the project root so we share the singleton that
// cds-dk already augmented with .build — not the copy in our own node_modules.
const cds = require(require.resolve('@sap/cds', { paths: [process.cwd(), __dirname] }));
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join, extname } = require('node:path');
const { validateCqlQuery } = require('./src/CqlLogic');
const { collectCqlTemplates, extractTemplateText } = require('./src/CqlTypeRewriter');
const { serviceAnnotationFor } = require('./src/ServiceAnnotation');

// Lazy-required so projects without a TypeScript installation can still load
// this file (e.g. pure-JS CAP projects that never invoke the scanner).
let _ts;
const getTs = () => (_ts ??= require('typescript'));

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
    const ts = getTs();
    const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
    const assignments = collectCqlTemplates(ts, sf);
    if (assignments.length === 0) return [];

    const results = [];
    for (const { template } of assignments) {
        const query = extractTemplateText(ts, template);
        const prefix = serviceAnnotationFor(ts, src, template, sf);
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

if (cds.build) {
    class CqlValidatorTask extends cds.build.Plugin {
        static hasTask() {
            return true;
        }

        async build() {
            let csn;
            try {
                csn = await this.model();
            } catch {
                // fall through to direct load
            }
            if (!csn) {
                try {
                    csn = await cds.load('*', { root: cds.root });
                } catch (err) {
                    log.warn(`cql-validator: could not load CDS model: ${err.message}`);
                    return;
                }
            }
            const defs = csn.definitions ?? {};
            runScan(cds.root, defs);
        }
    }
    cds.build.register('cql-validator', CqlValidatorTask);
}

module.exports = { scanFile, collectSourceFiles };
