'use strict';
/**
 * Child process worker for CQL resolution.
 *
 * Invoked by the tsserver plugin via execFileSync. Resolves @sap/cds from the
 * project root (passed as argv[2]), loads the full model, and returns
 * completion suggestions or diagnostics as JSON on stdout.
 *
 * Single-query mode:
 *   argv[2] = projectRoot   (directory containing node_modules/@sap/cds)
 *   argv[3] = cqlQuery
 *   argv[4] = cursorOffset  (integer, for completions) | '-1' (for diagnostics)
 *   argv[5] = servicePrefix (optional)
 *
 * Batch probe mode (type inference — one model load, N entity probes):
 *   argv[2] = projectRoot
 *   argv[3] = '--batch'
 *   argv[4] = JSON array of { entity: string; prefix: string }
 */

const { createRequire } = require('node:module');
const { join, dirname, delimiter } = require('node:path');
const { createInterface } = require('node:readline');
const { watch } = require('node:fs');

const { getSuggestions, validateCqlQuery } = require('./CqlLogic');

/**
 * @typedef {import('./CqlLogic').CompletionEntry} CompletionEntry
 */
/**
 * @typedef {import('./csn').CsnDefs} CsnDefs
 */
/**
 * @typedef {import('./QueryContext').BatchProbeRequest} BatchProbeRequest
 */

/**
 * @typedef {{
 *   completions?: CompletionEntry[];
 *   diagnostics?: Array<{ message: string; start: number; end: number; code: number }>;
 *   error?: string;
 * }} WorkerResult
 */

/**
 * @typedef {{
 *   fields: Record<string, CompletionEntry[]>;
 *   error?: string;
 * }} BatchWorkerResult
 */

/**
 * @typedef {{
 *   id?: number;
 *   projectRoot?: string;
 *   kind?: 'single' | 'batch';
 *   args?: string[];
 *   probes?: BatchProbeRequest[];
 * }} IpcRequest
 */

/** Test-only injection point. Allows tests to replace fs.watch with a synchronous stub. */
const _testOverrides = /** @type {{ watch?: typeof import('node:fs').watch; globalRoots?: () => string[] }} */ ({
    watch: undefined,
    /** Override the candidate global module roots used when @sap/cds is not local. Bypasses the memo. */
    globalRoots: undefined,
});

/** Memoised global module roots (computed once per worker process). */
let cachedGlobalRoots;

/**
 * Candidate global `node_modules` roots to fall back to when a project has no
 * local `@sap/cds` (the common CAP quickstart case: `npm i -g @sap/cds-dk`).
 * Ordered so an explicit NODE_PATH wins, then the node-prefix-relative global
 * dir (nvm / npm default), then the well-known Homebrew locations. No shell is
 * used — the worker runs in a minimal non-interactive env where `npm root -g`
 * / a `cds` alias are unreliable.
 * @returns {string[]}
 */
function candidateGlobalRoots() {
    // Escape hatch (used by tests and available to users who want strictly-local
    // resolution): disable the global fallback entirely.
    if (process.env['CDS_LSP_NO_GLOBAL_FALLBACK']) return [];
    const roots = [];
    const nodePath = process.env['NODE_PATH'];
    if (nodePath) for (const p of nodePath.split(delimiter)) if (p) roots.push(p);
    roots.push(join(dirname(process.execPath), '..', 'lib', 'node_modules'));
    roots.push('/usr/local/lib/node_modules');
    roots.push('/opt/homebrew/lib/node_modules');
    return roots;
}

/**
 * Probe an entity for its field completions. When no explicit prefix is given
 * and the entity name is unqualified (no dot), auto-discovers the first
 * service that exposes `<service>.<entity>` in the model definitions.
 * @param {string} entity
 * @param {string | undefined} prefix
 * @param {CsnDefs} defs
 * @returns {CompletionEntry[]}
 */
function probeEntityFields(entity, prefix, defs) {
    const probeQuery = `SELECT  FROM ${entity} WHERE `;
    const explicit = getSuggestions(probeQuery, probeQuery.length, defs, prefix || undefined);
    const fields = explicit.filter((c) => c.kind === 'field');
    if (fields.length > 0 || prefix || entity.includes('.')) return fields;

    // No prefix supplied and no fields found — scan defs for a qualifying service
    const suffix = `.${entity}`;
    for (const key of Object.keys(defs)) {
        if (key.endsWith(suffix)) {
            const svc = key.slice(0, key.length - suffix.length);
            const candidates = getSuggestions(probeQuery, probeQuery.length, defs, svc).filter((c) => c.kind === 'field');
            if (candidates.length > 0) return candidates;
        }
    }
    return [];
}

/**
 * @param {string} projectRoot
 * @returns {Promise<{ cds: any; defs: CsnDefs } | { error: string }>}
 */
async function loadModel(projectRoot) {
    const globalRoots = _testOverrides.globalRoots?.() ?? (cachedGlobalRoots ??= candidateGlobalRoots());
    // Local first (a project-local @sap/cds must win), then each global root.
    // require.resolve with an explicit `paths` avoids any dependency on cwd,
    // NODE_PATH, or a shell. Loop one root at a time so we know which one hit
    // and so a corrupt install can fall through to the next candidate.
    const searchRoots = [projectRoot, ...globalRoots];
    const req = createRequire(join(projectRoot, 'package.json'));
    let cds;
    for (const root of searchRoots) {
        let resolvedPath;
        try {
            resolvedPath = req.resolve('@sap/cds', { paths: [root] });
        } catch {
            continue;
        }
        try {
            cds = req(resolvedPath);
            break;
        } catch {}
    }
    if (!cds) {
        return {
            error: `@sap/cds not found in ${projectRoot} (also searched global roots: ${globalRoots.join(', ')})`,
        };
    }
    try {
        const model = await cds.load('*', { root: projectRoot });
        return { cds, defs: model.definitions ?? {} };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { error: `cds.load failed: ${message}` };
    }
}

/**
 * @param {string | undefined} projectRoot
 * @param {string | undefined} cqlQuery
 * @param {string | undefined} cursorOffsetStr
 * @param {string | undefined} servicePrefix
 * @param {(result: WorkerResult) => void} write
 * @returns {Promise<void>}
 */
async function runWorkerMain(projectRoot, cqlQuery, cursorOffsetStr, servicePrefix, write) {
    if (!(projectRoot && cqlQuery && cursorOffsetStr)) {
        write({ error: 'missing arguments' });
        return;
    }

    const loaded = await loadModel(projectRoot);
    if ('error' in loaded) {
        write({ error: loaded.error });
        return;
    }
    const { defs } = loaded;

    const prefix = servicePrefix || undefined;
    const cursorOffset = Number.parseInt(cursorOffsetStr, 10);

    if (cursorOffset < 0) {
        const diagnostics = validateCqlQuery(cqlQuery, defs, prefix);
        write({ diagnostics });
    } else {
        const completions = getSuggestions(cqlQuery, cursorOffset, defs, prefix);
        write({ completions });
    }
}

/**
 * @param {string | undefined} projectRoot
 * @param {string | undefined} payloadJson
 * @param {(result: BatchWorkerResult) => void} write
 * @returns {Promise<void>}
 */
async function runBatchWorkerMain(projectRoot, payloadJson, write) {
    if (!(projectRoot && payloadJson)) {
        write({ fields: {}, error: 'missing arguments' });
        return;
    }

    let probes;
    try {
        probes = JSON.parse(payloadJson);
    } catch {
        write({ fields: {}, error: 'invalid batch payload' });
        return;
    }

    const loaded = await loadModel(projectRoot);
    if ('error' in loaded) {
        write({ fields: {}, error: loaded.error });
        return;
    }
    const { defs } = loaded;

    const fields = /** @type {Record<string, import('./CqlLogic').CompletionEntry[]>} */ ({});
    for (const { entity, prefix } of probes) {
        fields[entity] = probeEntityFields(entity, prefix, defs);
    }
    write({ fields });
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ReadableStream} stdin
 * @param {{ write: (s: string) => void }} stdout
 * @returns {Promise<void>}
 */
async function runMain(argv, stdin, stdout) {
    const [, , projectRoot, modeOrQuery, fourthArg, servicePrefix] = /** @type {string[]} */ (argv);
    if (modeOrQuery === '--batch') {
        function writeBatch(/** @type {BatchWorkerResult} */ result) {
            stdout.write(JSON.stringify(result) + '\n');
        }
        await runBatchWorkerMain(projectRoot, fourthArg, writeBatch).catch((e) => writeBatch({ fields: {}, error: String(e) }));
    } else if (modeOrQuery === '--persistent') {
        // Long-lived mode: model loaded once and cached; invalidated when .cds files change.
        // Protocol: newline-delimited JSON on stdin/stdout.
        // Request:  { id, kind: 'single'|'batch', projectRoot, args?, probes? }
        // Response: { id, result: WorkerResult | BatchWorkerResult }
        /** @type {CsnDefs | null} */
        let cachedDefs = null;
        /** @type {string | null} */
        let cachedRoot = null;
        /** @type {ReturnType<typeof setTimeout> | null} */
        let invalidateTimer = null;

        let watcher;
        try {
            const watchFn = _testOverrides.watch ?? watch;
            watcher = watchFn(/** @type {string} */ (projectRoot), { recursive: true }, (/** @type {import('node:fs').WatchEventType} */ _event, /** @type {string | Buffer | null} */ filename) => {
                if (typeof filename === 'string' && filename.endsWith('.cds')) {
                    if (invalidateTimer) clearTimeout(invalidateTimer);
                    invalidateTimer = setTimeout(() => {
                        cachedDefs = null;
                    }, 200);
                }
            });
            watcher.on('error', () => {
                /* ignore — model stays cached until process restart */
            });
        } catch {
            /* fs.watch unavailable on this platform */
        }

        const rl = createInterface({
            input: stdin,
            crlfDelay: Number.POSITIVE_INFINITY,
        });
        let inFlight = 0;
        let closed = false;
        /** @type {(() => void) | undefined} */
        let resolveAll;
        await /** @type {Promise<void>} */ (
            new Promise((resolve) => {
                resolveAll = resolve;
                rl.on('line', async (line) => {
                    inFlight++;
                    try {
                        let req;
                        try {
                            req = JSON.parse(line);
                        } catch {
                            return;
                        }
                        const root = req.projectRoot ?? projectRoot;
                        if (!root) {
                            stdout.write(
                                JSON.stringify({
                                    id: req.id,
                                    result: { error: 'missing projectRoot' },
                                }) + '\n',
                            );
                            return;
                        }

                        if (root !== cachedRoot || !cachedDefs) {
                            const loaded = await loadModel(root);
                            if ('error' in loaded) {
                                stdout.write(
                                    JSON.stringify({
                                        id: req.id,
                                        result: { error: loaded.error },
                                    }) + '\n',
                                );
                                return;
                            }
                            cachedDefs = loaded.defs;
                            cachedRoot = root;
                        }

                        let result;
                        if (req.kind === 'batch') {
                            const fields = /** @type {Record<string, import('./CqlLogic').CompletionEntry[]>} */ ({});
                            for (const { entity, prefix } of req.probes ?? []) {
                                fields[entity] = probeEntityFields(entity, prefix, cachedDefs);
                            }
                            result = { fields };
                        } else {
                            const [query, cursorStr, prefix] = req.args ?? [];
                            const offset = Number.parseInt(cursorStr ?? '-1', 10);
                            result =
                                offset < 0
                                    ? {
                                          diagnostics: validateCqlQuery(query ?? '', cachedDefs, prefix || undefined),
                                      }
                                    : {
                                          completions: getSuggestions(query ?? '', offset, cachedDefs, prefix || undefined),
                                      };
                        }
                        stdout.write(JSON.stringify({ id: req.id, result }) + '\n');
                    } finally {
                        inFlight--;
                        if (closed && inFlight === 0) resolveAll?.();
                    }
                });
                rl.on('close', () => {
                    closed = true;
                    if (inFlight === 0) resolve();
                });
            })
        );
        // Clean up the fs.watch handle so it doesn't keep the event loop alive
        // (critical when runMain is called in-process from tests).
        if (invalidateTimer) clearTimeout(invalidateTimer);
        try {
            watcher?.close();
        } catch {
            /* ignore */
        }
    } else {
        const write = (/** @type {WorkerResult} */ result) => stdout.write(JSON.stringify(result) + '\n');
        await runWorkerMain(projectRoot, modeOrQuery, fourthArg, servicePrefix, write).catch((e) => write({ error: String(e) }));
    }
}

module.exports = { _testOverrides, runWorkerMain, runBatchWorkerMain, runMain };

if (require.main === module) {
    runMain(process.argv, process.stdin, process.stdout).catch(() => process.exit(1));
}
