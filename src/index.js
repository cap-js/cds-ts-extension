'use strict';
/**
 * TypeScript Language Service Plugin for CDS.
 *
 * Provides completions, hover, and diagnostics inside cds.ql`...` tagged
 * template literals in .js/.ts files. Calls @sap/cds via a child process
 * worker — no connection to the CDS LSP after registration.
 *
 * Loading: declared in vscode-cds package.json under contributes.typescriptServerPlugins.
 *
 * Feature flags (tsconfig.json plugins options, all default false / opt-in):
 *   "cds.ql.completion":    true  — enable completions inside templates
 *   "cds.ql.hover":         true  — enable hover inside templates and on result vars
 *   "cds.ql.diagnostics":   true  — enable CQL error diagnostics
 *   "cds.ql.typeInference": true  — enable snapshot rewriting for TypeScript type inference
 */

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */

const { Worker: WorkerThread } = require('node:worker_threads');
const { dirname, join } = require('node:path');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { readFileSync, writeFileSync, statSync } = require('node:fs');

const { rewriteSnapshot } = require('./CqlTypeRewriter');
const { getCqlCompletions, getCqlCompletionDetails } = require('./CqlCompletions');
const { getCqlHover } = require('./CqlHover');
const { getCqlDiagnostics } = require('./CqlDiagnostics');
const { readConfig, resolveQueryContext } = require('./QueryContext');

/** @typedef {import('./QueryContext').RunWorker} RunWorker */
/** @typedef {import('./QueryContext').RunBatchWorker} RunBatchWorker */
/** @typedef {import('./QueryContext').WorkerResult} WorkerResult */
/** @typedef {import('./QueryContext').BatchProbeResult} BatchProbeResult */
/** @typedef {import('./test-overrides').TestOverrides} TestOverrides */

// Path to the bundled worker script, co-located with this file in dist/
const WORKER_PATH = join(__dirname, 'cds-resolver-worker.js');
const BRIDGE_THREAD_PATH = join(__dirname, 'cds-bridge-thread.js');

// ---------------------------------------------------------------------------
// Persistent rewrite cache (survives tsserver restarts within a TTL window)
// ---------------------------------------------------------------------------

const DISK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * @typedef {Object} DiskCacheEntry
 * @property {string} rewritten
 * @property {Array<{ start: number; end: number }>} ranges
 * @property {number} writtenAt
 */

/**
 * How the live editor buffer differs from the source revision a rewrite was
 * computed for, modelled as a single spliced region: unchanged prefix, replaced
 * middle, suffix shifted by `delta`. See computeStaleEdit / spliceDiff.
 * @typedef {Object} SpliceEdit
 * @property {number} prefix
 * @property {number} staleSuffixStart
 * @property {number} delta
 */

/**
 * @param {string} projectRoot
 * @param {string} sourceText
 * @returns {string}
 */
function diskCachePath(projectRoot, sourceText) {
    const key = createHash('sha1')
        .update(projectRoot)
        .update('\0')
        .update(sourceText)
        .digest('hex');
    return join(tmpdir(), `cds-lsp-rewrite-${key}.json`);
}

/**
 * @param {string} path
 * @returns {DiskCacheEntry | null}
 */
function readDiskCache(path) {
    try {
        const stat = statSync(path);
        if (Date.now() - stat.mtimeMs > DISK_CACHE_TTL_MS) return null;
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {string} path
 * @param {DiskCacheEntry} entry
 * @returns {void}
 */
function writeDiskCache(path, entry) {
    try {
        writeFileSync(path, JSON.stringify(entry));
    } catch {
        /* ignore write failures */
    }
}

// ---------------------------------------------------------------------------
// Persistent worker pool
//
// Each projectRoot gets one long-lived child process running the CDS worker
// in --persistent mode (model loaded once, reused across requests).
//
// Synchronous IPC: a WorkerThread ("bridge") owns the child process and its
// async stdout I/O. The main thread writes a request to a SharedArrayBuffer,
// signals the bridge via Atomics.notify, then blocks with Atomics.wait until
// the bridge writes the response back and signals completion. Worker threads
// have their own event loop so async I/O runs while the main thread waits.
// ---------------------------------------------------------------------------

const IPC_BUF_SIZE = 1 * 1024 * 1024; // 1 MB max per request/response

// ctrl[0]: main→bridge  (1 = request pending, bridge resets to 0 after reading)
// ctrl[1]: bridge→main  (1 = response ready,  main   resets to 0 after reading)
// ctrl[2]: bridge→main  (1 = fatal error, bridge exiting)

/**
 * @typedef {Object} BridgeHandle
 * @property {InstanceType<typeof WorkerThread>} thread
 * @property {SharedArrayBuffer} ctrl
 * @property {SharedArrayBuffer} reqBuf
 * @property {SharedArrayBuffer} resBuf
 */

class PersistentWorkerPool {
    constructor() {
        /** @type {Map<string, BridgeHandle>} */
        this.bridges = new Map();
    }

    /**
     * @param {string} projectRoot
     * @param {import('typescript').server.Logger} logger
     * @returns {BridgeHandle}
     */
    getOrCreate(
        projectRoot,
        logger,
    ) {
        const existing = this.bridges.get(projectRoot);
        if (existing) return existing;

        const ctrl = new SharedArrayBuffer(3 * 4);
        const reqBuf = new SharedArrayBuffer(4 + IPC_BUF_SIZE);
        const resBuf = new SharedArrayBuffer(4 + IPC_BUF_SIZE);

        const thread = new WorkerThread(
            _TEST_OVERRIDES.bridgeThreadPath ?? BRIDGE_THREAD_PATH,
            {
                workerData: {
                    ctrl,
                    reqBuf,
                    resBuf,
                    workerPath: _TEST_OVERRIDES.workerPath ?? WORKER_PATH,
                    projectRoot,
                    nodeExec: process.execPath,
                },
            },
        );
        thread.on('message', (msg) => {
            if (msg.type === 'stderr')
                logger.info(`[cds-plugin] worker stderr: ${msg.text}`);
        });
        thread.on('error', (err) => {
            logger.info(`[cds-plugin] bridge error: ${err.message}`);
            this.bridges.delete(projectRoot);
        });
        const ctrlArr = new Int32Array(ctrl);
        // When the bridge signals a fatal error, remove the handle so next call respawns
        const watchFatal = setInterval(() => {
            if (Atomics.load(ctrlArr, 2) === 1) {
                this.bridges.delete(projectRoot);
                clearInterval(watchFatal);
            }
        }, 1000);
        watchFatal.unref();
        thread.unref();

        const handle = { thread, ctrl, reqBuf, resBuf };
        this.bridges.set(projectRoot, handle);
        logger.info(
            `[cds-plugin] spawned persistent worker for ${projectRoot}`,
        );
        return handle;
    }

    /**
     * @param {string} projectRoot
     * @param {object} req
     * @param {import('typescript').server.Logger} logger
     * @param {number} [timeoutMs]
     * @returns {unknown | null}
     */
    call(
        projectRoot,
        req,
        logger,
        timeoutMs = 5000,
    ) {
        try {
            const h = this.getOrCreate(projectRoot, logger);
            const ctrlArr = new Int32Array(h.ctrl);
            const reqArr = new Uint8Array(h.reqBuf);

            const json = JSON.stringify({ ...req, projectRoot });
            const bytes = Buffer.from(json, 'utf8');
            if (bytes.length + 4 > IPC_BUF_SIZE) {
                logger.info('[cds-plugin] request too large for IPC buffer');
                return null;
            }
            new DataView(h.reqBuf).setInt32(0, bytes.length, true);
            reqArr.set(bytes, 4);

            // Reset response flag, then signal bridge a request is ready
            Atomics.store(ctrlArr, 1, 0);
            Atomics.store(ctrlArr, 0, 1);
            Atomics.notify(ctrlArr, 0, 1);

            const r = Atomics.wait(ctrlArr, 1, 0, timeoutMs);
            if (r === 'timed-out') {
                logger.info('[cds-plugin] persistent worker timed out');
                return null;
            }
            if (Atomics.load(ctrlArr, 2) === 1) {
                logger.info(
                    '[cds-plugin] persistent worker exited unexpectedly',
                );
                this.bridges.delete(projectRoot);
                return null;
            }
            const len = new DataView(h.resBuf).getInt32(0, true);
            const resJson = Buffer.from(
                new Uint8Array(h.resBuf, 4, len),
            ).toString('utf8');
            const parsed = JSON.parse(resJson);
            return parsed?.result ?? null;
        } catch (e) {
            logger.info(
                `[cds-plugin] persistent worker error: ${e instanceof Error ? e.message : String(e)}`,
            );
            this.bridges.delete(projectRoot);
            return null;
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async shutdown() {
        const handles = Array.from(this.bridges.values());
        this.bridges.clear();
        await Promise.all(
            handles.map(async (h) => {
                // Kill the child process via message, then wake the bridge loop by
                // setting the fatal flag (ctrl[2]=1) and notifying ctrl[0] so the
                // Atomics.waitAsync in loop() resolves and sees the fatal flag.
                try {
                    h.thread.postMessage({ type: 'shutdown' });
                } catch {
                    /* ignore */
                }
                const ctrlArr = new Int32Array(h.ctrl);
                Atomics.store(ctrlArr, 2, 1);
                Atomics.notify(ctrlArr, 0, 1);
                // Give the bridge thread 200 ms to exit naturally, then force-terminate.
                await new Promise((r) => setTimeout(r, 200));
                try {
                    await h.thread.terminate();
                } catch {
                    /* ignore */
                }
            }),
        );
    }
}

const WORKER_POOL = new PersistentWorkerPool();

/**
 * @param {string[]} args
 * @param {import('typescript').server.Logger} logger
 * @param {number} [timeoutMs]
 * @returns {WorkerResult | null}
 */
function runWorker(
    args,
    logger,
    timeoutMs,
) {
    const r = WORKER_POOL.call(
        args[0] ?? '',
        { kind: 'single', args: args.slice(1) },
        logger,
        timeoutMs,
    );
    return /** @type {WorkerResult | null} */ (r);
}

/**
 * @param {string} projectRoot
 * @param {import('./QueryContext').BatchProbeRequest[]} probes
 * @param {import('typescript').server.Logger} logger
 * @returns {BatchProbeResult | null}
 */
function runBatchWorker(
    projectRoot,
    probes,
    logger,
) {
    const r = WORKER_POOL.call(projectRoot, { kind: 'batch', probes }, logger);
    return /** @type {BatchProbeResult | null} */ (r);
}

const PROJECT_ROOT_CACHE = new Map();

/**
 * @param {string} fileName
 * @returns {string}
 */
function projectRootFor(fileName) {
    const fileDir = dirname(fileName);
    const cached = PROJECT_ROOT_CACHE.get(fileDir);
    if (cached) return cached;
    let dir = fileDir;
    const { existsSync } = require('node:fs');
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(dir, 'package.json'))) {
            PROJECT_ROOT_CACHE.set(fileDir, dir);
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    const fallback = dirname(fileName);
    PROJECT_ROOT_CACHE.set(fileDir, fallback);
    return fallback;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/** Shape of internal tsserver ScriptInfo methods accessed by the plugin.
 * @typedef {import('typescript').server.ScriptInfo & { __cdsPatchedSnapshot?: boolean; __cdsOrigSnap?: () => import('typescript').IScriptSnapshot }} CdsPatchedScriptInfo
 */

/** @typedef {import('typescript').server.Project} CdsInternalProject */

/** Test-only injection point. Set before calling create(); cleared automatically after.
 * @type {TestOverrides}
 */
const _TEST_OVERRIDES = {};

/** @type {import('typescript').server.PluginModuleFactory} */
const pluginFactory = ({ typescript }) => {
    /** @type {import('./QueryContext').PluginConfig} */
    let config = readConfig({});
    /** @type {import('typescript').server.Logger | undefined} */
    let logger;

    return {
        create(info) {
            const ls = info.languageService;
            const project = info.project;
            logger = info.project.projectService.logger;
            config = readConfig(
                (info.config ?? {}),
            );

            // Resolve the CQL query context for a file — the same 8-arg call is
            // needed by every feature proxy method below.
            const ctxFor = (/** @type {string} */ fileName) =>
                resolveQueryContext(
                    fileName,
                    info,
                    typescript,
                    originalSource,
                    rw,
                    rwBatch,
                    logger ?? info.project.projectService.logger,
                    projectRootFor(fileName),
                );

            /**
             * @param {CdsPatchedScriptInfo | null} [si]
             * @returns {void}
             */
            function triggerTsServerRefresh(
                si,
            ) {
                if (si && typeof si.editContent === 'function')
                    si.editContent(0, 0, '');
                info.project.updateGraph();
                if (typeof project.refreshDiagnostics === 'function')
                    project.refreshDiagnostics();
            }

            /** @type {Map<string, { sourceText: string; rewritten: string }>} */
            const rewriteCache = new Map();
            /** @type {Map<string, string>} */
            const originalSource = new Map();
            /** @type {Map<string, Array<{ start: number; end: number }>>} */
            const rewrittenRanges = new Map();
            const patchedFiles = new Set();
            // Resolved alias type expressions keyed by `(awaited, prefix, queryText)`,
            // shared across all rewrites. Lets doRewrite rebuild a cast-accurate snapshot
            // synchronously (no worker) whenever only the surrounding TS code changed, so
            // the editor never sees a stale snapshot mid-edit.
            /** @type {Map<string, string>} */
            const typeExprCache = new Map();
            // The source text each most-recently-served snapshot was built from. The
            // debounce path serves a live-aligned partial rewrite (built from the current
            // buffer) without writing it to rewriteCache, so classified tokens are already
            // in the live coordinate system. computeStaleEdit compares against THIS, not
            // rewriteCache, so it correctly reports "no reprojection needed".
            /** @type {Map<string, string>} */
            const servedSource = new Map();
            // The last semantic classification computed against a FULLY-RESOLVED snapshot
            // (every query cast), tagged with the live source it describes. During any
            // transition (a partial/stale served snapshot, where whole-file type inference
            // would recolour unrelated identifiers), we reproject THIS onto the live buffer
            // instead of recomputing — so semantic colours only ever change when a fully
            // resolved rewrite lands, never mid-edit. Keyed per file.
            /** @type {Map<string, { source: string; result: { spans: number[]; endOfLineState: number } }>} */
            const lastGoodSemantic = new Map();

            /**
             * @typedef {Object} DebounceEntry
             * @property {ReturnType<typeof setTimeout> | undefined} timer
             * @property {string} lastRewritten
             * @property {CdsPatchedScriptInfo | null} scriptInfo
             */
            /** @type {Map<string, DebounceEntry>} */
            const debounceMap = new Map();

            /** @type {RunWorker} */
            const rw = _TEST_OVERRIDES.rw ?? runWorker;
            /** @type {RunBatchWorker} */
            const rwBatch =
                _TEST_OVERRIDES.rwBatch ?? runBatchWorker;

            /**
             * @param {string} fileName
             * @param {string} sourceText
             * @returns {string}
             */
            function doRewrite(fileName, sourceText) {
                const rewritten = doRewriteImpl(fileName, sourceText);
                // Every branch returns a snapshot built from THIS sourceText (cold-start
                // full rewrite, disk-cache hit for this text, or a live-aligned cacheOnly
                // partial). Record it as the coordinate baseline for computeStaleEdit so
                // reprojection only kicks in for genuinely stale classified snapshots.
                servedSource.set(fileName, sourceText);
                return rewritten;
            }

            /**
             * @param {string} fileName
             * @param {string} sourceText
             * @returns {string}
             */
            function doRewriteImpl(
                fileName,
                sourceText,
            ) {
                // All three rewriteSnapshot call sites below share the same 9
                // closure-captured args and differ only in the final opts object.
                const rewrite = (
                    /** @type {{ typeExprCache?: Map<string, string>; cacheOnly?: boolean } | undefined} */ opts,
                ) =>
                    rewriteSnapshot(
                        fileName,
                        sourceText,
                        typescript,
                        originalSource,
                        rewriteCache,
                        rw,
                        rwBatch,
                        logger ?? info.project.projectService.logger,
                        projectRootFor(fileName),
                        undefined,
                        rewrittenRanges,
                        opts,
                    );

                // Fast path: cache hit — source unchanged since last full rewrite
                const cached = rewriteCache.get(fileName);
                if (cached && cached.sourceText === sourceText)
                    return cached.rewritten;

                const entry = debounceMap.get(fileName);
                clearTimeout(entry?.timer);

                // Cold start: no prior result for this file — check disk cache first,
                // then fall back to a synchronous worker call so the editor never
                // shows `any` on first open or after a window reload.
                if (!entry?.lastRewritten) {
                    const projectRoot = projectRootFor(fileName);
                    const cachePath = diskCachePath(projectRoot, sourceText);
                    const hit = readDiskCache(cachePath);
                    if (hit) {
                        // Restore in-memory caches from disk so subsequent calls are instant
                        rewriteCache.set(fileName, {
                            sourceText,
                            rewritten: hit.rewritten,
                        });
                        originalSource.set(fileName, sourceText);
                        if (hit.ranges.length)
                            rewrittenRanges.set(fileName, hit.ranges);
                        debounceMap.set(fileName, {
                            timer: undefined,
                            lastRewritten: hit.rewritten,
                            scriptInfo: entry?.scriptInfo ?? null,
                        });
                        return hit.rewritten;
                    }
                    const fresh = rewrite({ typeExprCache });
                    // On worker miss, fresh === sourceText — don't cache or set lastRewritten
                    // so the next snapshot call retries the worker synchronously.
                    if (fresh !== sourceText) {
                        writeDiskCache(cachePath, {
                            rewritten: fresh,
                            ranges: rewrittenRanges.get(fileName) ?? [],
                            writtenAt: Date.now(),
                        });
                        debounceMap.set(fileName, {
                            timer: undefined,
                            lastRewritten: fresh,
                            scriptInfo: entry?.scriptInfo ?? null,
                        });
                    }
                    return fresh;
                }

                // Debounce path: the source changed since the last full rewrite.
                //
                // Rebuild the snapshot SYNCHRONOUSLY from the type-expression cache.
                // `cacheOnly` splices the cached casts into the CURRENT source text, so
                // the result is always aligned to the live buffer: queries whose text is
                // unchanged (the common case — the edit was in surrounding TS code, or in
                // a *different* query) get their casts placed at correct live positions
                // right now; a query whose text actually changed is left as plain source
                // (its inference is pending until the worker resolves it).
                //
                // Returning this live-aligned snapshot — instead of the previous revision's
                // rewrite (`lastRewritten`) — is what removes the highlight flash: every
                // *unchanged* declaration keeps its colour in its correct place with no
                // reprojection and no snap when the debounce timer later fires.
                const syncCacheOnly = rewrite({
                    typeExprCache,
                    cacheOnly: true,
                });
                if (rewriteCache.get(fileName)?.sourceText === sourceText) {
                    // Every query resolved from cache — adopt as the new baseline, no worker
                    // needed. Cancel any pending timer and return the fresh snapshot.
                    clearTimeout(entry.timer);
                    debounceMap.set(fileName, {
                        timer: entry.timer,
                        lastRewritten: syncCacheOnly,
                        scriptInfo: entry.scriptInfo,
                    });
                    return syncCacheOnly;
                }

                // A query's text changed (or was never resolved). The `syncCacheOnly`
                // snapshot is still live-aligned for every OTHER query, so serve it now and
                // schedule the worker to fill in the changed query's type. `rewrittenRanges`
                // was refreshed to the live-aligned cast spans by the cacheOnly pass above.
                const debounceMs = config['cds.ql.debounceDelay'];

                const timer = setTimeout(() => {
                    const fresh = rewrite({ typeExprCache });
                    const si = debounceMap.get(fileName)?.scriptInfo ?? null;
                    // Only update lastRewritten on success; on worker miss keep the last good rewrite
                    const newLastRewritten =
                        fresh !== sourceText
                            ? fresh
                            : (debounceMap.get(fileName)?.lastRewritten ??
                              fresh);
                    debounceMap.set(fileName, {
                        timer,
                        lastRewritten: newLastRewritten,
                        scriptInfo: si,
                    });
                    // Persist updated rewrite to disk for fast reload next time (skip on miss)
                    if (fresh !== sourceText) {
                        writeDiskCache(
                            diskCachePath(projectRootFor(fileName), sourceText),
                            {
                                rewritten: fresh,
                                ranges: rewrittenRanges.get(fileName) ?? [],
                                writtenAt: Date.now(),
                            },
                        );
                    }
                    triggerTsServerRefresh(si);
                }, debounceMs);

                // Serve the live-aligned partial rewrite (not the stale previous revision).
                debounceMap.set(fileName, {
                    timer,
                    lastRewritten: syncCacheOnly,
                    scriptInfo: entry.scriptInfo,
                });
                return syncCacheOnly;
            }

            // Patch languageServiceHost (closed/background files)
            const origGetScriptSnapshot =
                info.languageServiceHost.getScriptSnapshot.bind(
                    info.languageServiceHost,
                );
            info.languageServiceHost.getScriptSnapshot = (fileName) => {
                const base = origGetScriptSnapshot(fileName);
                if (
                    !(
                        base &&
                        /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(fileName)
                    )
                )
                    return base;
                const sourceText = base.getText(0, base.getLength());
                if (
                    !(
                        sourceText.includes('cds.ql') &&
                        config['cds.ql.typeInference']
                    )
                )
                    return base;
                originalSource.set(fileName, sourceText);
                const rewritten = doRewrite(fileName, sourceText);
                if (rewritten === sourceText) return base;
                return typescript.ScriptSnapshot.fromString(rewritten);
            };

            // Files we've already warned about missing a ScriptInfo (avoid log spam).
            const unassignedWarned = new Set();

            // Patch ScriptInfo.getSnapshot for open (editor) files
            /**
             * @param {string} fileName
             * @returns {void}
             */
            function patchScriptInfo(fileName) {
                if (patchedFiles.has(fileName)) return;
                const scriptInfo = info.project.getScriptInfo(
                    fileName,
                );
                if (!scriptInfo) {
                    // tsserver has not assigned this file to a project, so the plugin cannot
                    // attach its snapshot rewrite. For a loose .js file with no tsconfig/jsconfig
                    // this usually means the vscode-cds extension needs to register the plugin
                    // with `enableForWorkspaceTypeScriptVersions` and activate TS features for
                    // JavaScript (onLanguage:javascript). Surface it once as an actionable hint.
                    if (
                        /\.(js|jsx|mjs|cjs|ts|tsx)$/.test(fileName) &&
                        !unassignedWarned.has(fileName)
                    ) {
                        unassignedWarned.add(fileName);
                        logger?.info(
                            `[cds-plugin] ${fileName.split('/').pop()} is not assigned to a TS project — CQL features inactive. If this is a loose .js/.ts file, check that the vscode-cds extension registers @sap/cds-lsp with enableForWorkspaceTypeScriptVersions and activates on JavaScript/TypeScript.`,
                        );
                    }
                    return;
                }
                const si = /** @type {CdsPatchedScriptInfo} */ (scriptInfo);
                if (si.__cdsPatchedSnapshot) return;
                patchScriptInfoImpl(si, fileName);
            }

            /**
             * @param {CdsPatchedScriptInfo} scriptInfo
             * @param {string} fileName
             * @param {boolean} [triggerUpdate]
             * @returns {void}
             */
            function patchScriptInfoImpl(
                scriptInfo,
                fileName,
                triggerUpdate = true,
            ) {
                const origSnap = scriptInfo.getSnapshot.bind(scriptInfo);
                scriptInfo.__cdsOrigSnap = origSnap;
                scriptInfo.getSnapshot = () => {
                    const base = origSnap();
                    const sourceText = base.getText(0, base.getLength());
                    if (
                        !(
                            sourceText.includes('cds.ql') &&
                            config['cds.ql.typeInference']
                        )
                    )
                        return base;
                    originalSource.set(fileName, sourceText);
                    const rewritten = doRewrite(fileName, sourceText);
                    if (rewritten === sourceText) return base;
                    return typescript.ScriptSnapshot.fromString(rewritten);
                };
                scriptInfo.__cdsPatchedSnapshot = true;
                patchedFiles.add(fileName);
                const existing = debounceMap.get(fileName);
                debounceMap.set(fileName, {
                    timer: existing?.timer,
                    lastRewritten: existing?.lastRewritten ?? '',
                    scriptInfo,
                });
                logger?.info(
                    `[cds-plugin] patched ScriptInfo for ${fileName.split('/').pop()}`,
                );
                if (triggerUpdate) {
                    // A zero-length edit bumps the ScriptInfo's internal version counter so
                    // isProgramUptoDate() returns false and tsserver rebuilds the program with
                    // our rewritten snapshot (markContainingProjectsAsDirty alone is not enough).
                    triggerTsServerRefresh(scriptInfo);
                }
            }

            const proxy = /** @type {import('typescript').LanguageService} */ (Object.create(null));
            const _proxy = /** @type {Record<string, Function>} */ (/** @type {unknown} */ (proxy));
            const _ls = /** @type {Record<string, Function>} */ (/** @type {unknown} */ (ls));
            for (const k of Object.keys(ls)) {
                const method = _ls[k];
                if (typeof method === 'function') {
                    _proxy[k] = (
                        /** @type {unknown[]} */ ...args
                    ) =>
                        method.apply(
                            ls,
                            args,
                        );
                }
            }

            // Wrap project.updateGraph so every program rebuild — including the very first
            // one after tsserver adds files to the project — runs after our getSnapshot
            // patches are in place. This is necessary because enablePluginsWithOptions (which
            // calls create()) runs BEFORE files are added to the project, so the startup scan
            // below finds no files to patch; the wrapper catches the subsequent updateGraph.
            if (typeof project.updateGraph === 'function') {
                const origUpdateGraph = project.updateGraph.bind(info.project);
                project.updateGraph = () => {
                    if (
                        config['cds.ql.typeInference'] &&
                        typeof project.getScriptFileNames === 'function'
                    ) {
                        for (const fn of project.getScriptFileNames()) {
                            if (patchedFiles.has(fn)) continue;
                            const si = /** @type {CdsPatchedScriptInfo | undefined} */ (info.project.getScriptInfo(
                                fn,
                            ));
                            if (!si || si.__cdsPatchedSnapshot) continue;
                            const snap = si.getSnapshot();
                            const text = snap.getText(0, snap.getLength());
                            if (text.includes('cds.ql')) {
                                // Patch without triggering another updateGraph (we're inside one)
                                patchScriptInfoImpl(si, fn, false);
                                // Version bump so isProgramUptoDate() sees this file as changed
                                if (typeof si.editContent === 'function') {
                                    si.editContent(0, 0, '');
                                }
                            }
                        }
                    }
                    return origUpdateGraph();
                };
            }

            // Best-effort startup scan: patches any files already present when create() runs.
            // In practice getScriptFileNames() is empty here for tsconfig projects (files are
            // added after enablePluginsWithOptions returns), but the updateGraph wrapper above
            // covers that gap.
            if (typeof project.getScriptFileNames === 'function') {
                /** @type {string[]} */
                const cdsFileNames = [];
                for (const fileName of project.getScriptFileNames()) {
                    const si = /** @type {CdsPatchedScriptInfo | undefined} */ (info.project.getScriptInfo(
                        fileName,
                    ));
                    if (!si) continue;
                    const snap = si.__cdsOrigSnap?.() ?? si.getSnapshot();
                    const text = snap.getText(0, snap.getLength());
                    if (
                        text.includes('cds.ql') &&
                        config['cds.ql.typeInference']
                    ) {
                        if (
                            !(
                                patchedFiles.has(fileName) ||
                                si.__cdsPatchedSnapshot
                            )
                        ) {
                            patchScriptInfoImpl(si, fileName, false);
                        }
                        cdsFileNames.push(fileName);
                    }
                }
                if (cdsFileNames.length > 0) {
                    setImmediate(() => {
                        for (const fileName of cdsFileNames) {
                            const si = info.project.getScriptInfo(
                                fileName,
                            );
                            if (si && typeof si.editContent === 'function')
                                si.editContent(0, 0, '');
                        }
                        triggerTsServerRefresh();
                    });
                }
            }

            // ── Diagnostics ──────────────────────────────────────────────────

            proxy.getSemanticDiagnostics = (fileName) => {
                patchScriptInfo(fileName);
                const base = ls.getSemanticDiagnostics(fileName);
                if (!config['cds.ql.diagnostics']) return base;
                const ctx = ctxFor(fileName);
                if (!ctx) return base;
                return [...base, ...getCqlDiagnostics(ctx, typescript)];
            };

            // ── Completions ──────────────────────────────────────────────────

            proxy.getCompletionsAtPosition = (
                fileName,
                position,
                options,
                formatSettings,
            ) => {
                patchScriptInfo(fileName);
                const base = ls.getCompletionsAtPosition(
                    fileName,
                    position,
                    options,
                    formatSettings,
                );
                if (!config['cds.ql.completion']) return base;
                const ctx = ctxFor(fileName);
                if (!ctx) return base;
                const cds = getCqlCompletions(
                    fileName,
                    position,
                    ctx,
                    typescript,
                );
                if (!cds) return base;
                if (!base) return cds;
                return { ...base, entries: [...cds.entries, ...base.entries] };
            };

            proxy.getCompletionEntryDetails = (
                fileName,
                position,
                entryName,
                formatOptions,
                source,
                preferences,
                data,
            ) => {
                const base = ls.getCompletionEntryDetails(
                    fileName,
                    position,
                    entryName,
                    formatOptions,
                    source,
                    preferences,
                    data,
                );
                if (!config['cds.ql.completion']) return base;
                if (!source?.startsWith('cds:')) return base;
                const ctx = ctxFor(fileName);
                if (!ctx) return base;
                const cds = getCqlCompletionDetails(
                    fileName,
                    position,
                    entryName,
                    source,
                    ctx,
                    typescript,
                );
                if (!cds) return base;
                return {
                    ...base,
                    ...cds,
                    codeActions: [
                        ...(base?.codeActions ?? []),
                        ...(cds.codeActions ?? []),
                    ],
                };
            };

            // ── Hover ────────────────────────────────────────────────────────

            proxy.getQuickInfoAtPosition = (fileName, position) => {
                patchScriptInfo(fileName);
                const base = ls.getQuickInfoAtPosition(fileName, position);
                if (!config['cds.ql.hover']) return base;
                const ctx = ctxFor(fileName);
                if (!ctx) return base;
                return getCqlHover(fileName, position, ctx, typescript) ?? base;
            };

            // ── Syntax + semantic token filtering ────────────────────────────
            // getEncodedSyntacticClassifications: run against the ORIGINAL source so
            // VS Code gets correct syntax colours for the template literal content.
            // We temporarily restore the original getSnapshot on the ScriptInfo for
            // the duration of the call (tsserver is single-threaded, so this is safe),
            // then put the rewriting snapshot back immediately after.
            //
            // getEncodedSemanticClassifications: uses the rewritten source (needed for
            // type-aware colouring), but we drop tokens in rewritten ranges and beyond
            // the original source length so injected cast/alias tokens don't bleed.

            /**
             * @template T
             * @param {string} fileName
             * @param {() => T} fn
             * @returns {T}
             */
            function withOriginalSnapshot(fileName, fn) {
                const si = /** @type {CdsPatchedScriptInfo | undefined} */ (info.project.getScriptInfo(
                    fileName,
                ));
                const origSnap = si?.__cdsOrigSnap;
                if (!(si && origSnap && si.__cdsPatchedSnapshot)) return fn();
                const patchedSnap = si.getSnapshot.bind(si);
                si.getSnapshot = origSnap;
                try {
                    return fn();
                } finally {
                    si.getSnapshot = patchedSnap;
                }
            }

            /**
             * Describes how the live editor buffer differs from the source revision the
             * current rewrite/ranges were computed for, modelled as a single spliced
             * region (the common case for keystroke-by-keystroke editing):
             *   - bytes [0, prefix)                    are unchanged
             *   - bytes [prefix, staleSuffixStart)     were replaced by the edit
             *   - bytes [staleSuffixStart, staleLen)   are unchanged but shifted by `delta`
             * `delta` = liveLen - staleLen. Returned null when the rewrite is already
             * current (no reprojection needed).
             * @param {string} fileName
             * @returns {SpliceEdit | null}
             */
            function computeStaleEdit(fileName) {
                // The original text the current classified snapshot was built from. This
                // is the source doRewrite last SERVED (the live buffer at that moment),
                // which may be a live-aligned cacheOnly partial not written to rewriteCache.
                const stale =
                    servedSource.get(fileName) ??
                    rewriteCache.get(fileName)?.sourceText;
                if (stale === undefined) return null;
                const live = liveBufferOf(fileName);
                if (live === undefined) return null;
                return spliceDiff(stale, live);
            }

            /** The live (unrewritten) editor buffer text for a file, or undefined.
             * @param {string} fileName
             * @returns {string | undefined}
             */
            const liveBufferOf = (fileName) =>
                withOriginalSnapshot(fileName, () => {
                    const si = info.project.getScriptInfo(
                        fileName,
                    );
                    const snap = si?.getSnapshot();
                    return snap ? snap.getText(0, snap.getLength()) : undefined;
                });

            /**
             * Models `live` as a single spliced edit of `stale` (the common case for
             * keystroke editing): unchanged prefix, replaced middle, suffix shifted by
             * `delta = liveLen - staleLen`. Returns null when the two are identical.
             * @param {string} stale
             * @param {string} live
             * @returns {SpliceEdit | null}
             */
            function spliceDiff(
                stale,
                live,
            ) {
                if (live === stale) return null;
                const min = Math.min(stale.length, live.length);
                let prefix = 0;
                while (prefix < min && stale[prefix] === live[prefix]) prefix++;
                let suffix = 0;
                while (
                    suffix < min - prefix &&
                    stale[stale.length - 1 - suffix] ===
                        live[live.length - 1 - suffix]
                )
                    suffix++;
                return {
                    prefix,
                    staleSuffixStart: stale.length - suffix,
                    delta: live.length - stale.length,
                };
            }

            /**
             * Filters injected tokens (cast ranges + tail aliases) and, when the classified
             * snapshot is a stale rewrite of a prior revision, reprojects the surviving
             * tokens onto the live buffer's coordinate system so their colour stays put
             * while the debounce timer catches up. Tokens before the edit keep their
             * position; tokens after it shift by the edit's length delta; tokens landing
             * inside the edited region are dropped (their identity is genuinely unknown
             * until the fresh rewrite lands).
             * @param {{ spans: number[]; endOfLineState: number }} base
             * @param {Array<{ start: number; end: number }> | undefined} ranges
             * @param {number} origLength
             * @param {SpliceEdit | null} staleEdit
             * @returns {{ spans: number[]; endOfLineState: number }}
             */
            function filterSemanticClassifications(
                base,
                ranges,
                origLength,
                staleEdit,
            ) {
                const out = /** @type {number[]} */ ([]);
                for (let i = 0; i < base.spans.length; i += 3) {
                    const tokStart = /** @type {number} */ (base.spans[i]);
                    if (tokStart >= origLength) continue;
                    if (
                        ranges?.some(
                            (r) => tokStart >= r.start && tokStart < r.end,
                        )
                    )
                        continue;

                    let projected = tokStart;
                    if (staleEdit) {
                        if (tokStart >= staleEdit.staleSuffixStart) {
                            // After the edit: shift into live coordinates.
                            projected = tokStart + staleEdit.delta;
                        } else if (tokStart >= staleEdit.prefix) {
                            // Inside the edited region: identity unknown until refresh — drop.
                            continue;
                        }
                        // else: before the edit — position unchanged.
                    }
                    out.push(projected, /** @type {number} */ (base.spans[i + 1]), /** @type {number} */ (base.spans[i + 2]));
                }
                return { spans: out, endOfLineState: base.endOfLineState };
            }

            /**
             * Reprojects an ALREADY-FILTERED semantic result (spans in live-buffer
             * coordinates of some prior revision `from`) onto the current live buffer,
             * given the splice edit between them. Tokens before the edit keep position;
             * tokens after shift by `delta`; tokens inside the edited region are dropped.
             * Colours (span classification ids) are preserved verbatim — this is what
             * FREEZES semantic colours across a transition instead of recomputing them
             * against a degraded snapshot.
             * @param {{ spans: number[]; endOfLineState: number }} cached
             * @param {SpliceEdit | null} edit
             * @returns {{ spans: number[]; endOfLineState: number }}
             */
            function reprojectFiltered(
                cached,
                edit,
            ) {
                if (!edit) return cached;
                const out = /** @type {number[]} */ ([]);
                for (let i = 0; i < cached.spans.length; i += 3) {
                    const tokStart = /** @type {number} */ (cached.spans[i]);
                    let projected = tokStart;
                    if (tokStart >= edit.staleSuffixStart)
                        projected = tokStart + edit.delta;
                    else if (tokStart >= edit.prefix) continue; // inside the edit — unknown
                    out.push(
                        projected,
                        /** @type {number} */ (cached.spans[i + 1]),
                        /** @type {number} */ (cached.spans[i + 2]),
                    );
                }
                return { spans: out, endOfLineState: cached.endOfLineState };
            }

            proxy.getEncodedSyntacticClassifications = (fileName, span) => {
                patchScriptInfo(fileName);
                // If this file has been rewritten, classify the original source so the
                // template literal content gets correct syntax highlighting.
                if (rewrittenRanges.has(fileName)) {
                    return withOriginalSnapshot(fileName, () =>
                        ls.getEncodedSyntacticClassifications(fileName, span),
                    );
                }
                return ls.getEncodedSyntacticClassifications(fileName, span);
            };

            proxy.getEncodedSemanticClassifications = (
                fileName,
                span,
                format,
            ) => {
                patchScriptInfo(fileName);

                const live = liveBufferOf(fileName);
                // "Fully resolved" ⟺ the rewrite cache holds a full rewrite for the exact
                // live buffer. Only then is the type environment the classifier sees the
                // real one; otherwise it's a partial/stale snapshot whose whole-file
                // inference would recolour unrelated identifiers (the semantic-value flash).
                const fullyResolved =
                    live !== undefined &&
                    rewriteCache.get(fileName)?.sourceText === live;

                // Key the freeze cache by file + span START + format. VS Code requests the
                // whole document with a span whose LENGTH tracks the (changing) document
                // length, so including length here would miss on exactly the edit
                // transitions we must freeze across. Span offsets are absolute, so a
                // baseline captured at one length reprojects correctly regardless. Format
                // is included because classification ids are format-dependent.
                const cacheKey = `${fileName} ${span.start} ${format ?? ''}`;

                if (fullyResolved) {
                    // Classify against the fully-resolved rewritten snapshot, drop injected
                    // tokens (cast ranges + tail aliases), and freeze the result as the
                    // last-good baseline for this range. No reprojection needed — the served
                    // snapshot IS the live buffer.
                    const filtered = filterSemanticClassifications(
                        ls.getEncodedSemanticClassifications(
                            fileName,
                            span,
                            format,
                        ),
                        rewrittenRanges.get(fileName),
                        live.length,
                        null,
                    );
                    lastGoodSemantic.set(cacheKey, {
                        source: live,
                        result: filtered,
                    });
                    return filtered;
                }

                // Transition: reproject the last fully-resolved result for this range onto
                // the live buffer so colours stay frozen until a full rewrite lands. This
                // covers BOTH position drift and semantic-value changes (e.g. `cds` teal→
                // mint), because we never re-run the classifier against a degraded snapshot.
                const good =
                    live !== undefined
                        ? lastGoodSemantic.get(cacheKey)
                        : undefined;
                if (good && live !== undefined) {
                    return reprojectFiltered(
                        good.result,
                        spliceDiff(good.source, live),
                    );
                }

                // No last-good baseline yet (first classification before any full rewrite):
                // fall back to filtering+reprojecting the current (possibly partial) snapshot.
                const staleEdit = computeStaleEdit(fileName);
                const staleOrigLength =
                    servedSource.get(fileName)?.length ??
                    rewriteCache.get(fileName)?.sourceText.length ??
                    originalSource.get(fileName)?.length ??
                    Number.POSITIVE_INFINITY;
                return filterSemanticClassifications(
                    ls.getEncodedSemanticClassifications(
                        fileName,
                        span,
                        format,
                    ),
                    rewrittenRanges.get(fileName),
                    staleOrigLength,
                    staleEdit,
                );
            };

            return proxy;
        },

        onConfigurationChanged(newConfig) {
            // Total: readConfig tolerates any shape (null, unknown keys, a
            // `schemaVersion` tag from the host). Never throw here.
            config = readConfig(newConfig);
            const schema = newConfig?.['schemaVersion'];
            logger?.info(
                `[cds-plugin] config updated${schema !== undefined ? ` (schema ${String(schema)})` : ''}: ${JSON.stringify(config)}`,
            );
        },
    };
};

/** @type {import('typescript').server.PluginModuleFactory & { _testOverrides: typeof _TEST_OVERRIDES }} */ (pluginFactory)._testOverrides = _TEST_OVERRIDES;
_TEST_OVERRIDES._runWorker = runWorker;
_TEST_OVERRIDES._runBatchWorker = runBatchWorker;
_TEST_OVERRIDES._workerPool = WORKER_POOL;
_TEST_OVERRIDES._shutdownPool = () => WORKER_POOL.shutdown();
module.exports = pluginFactory;
