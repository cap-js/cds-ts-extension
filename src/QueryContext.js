'use strict';

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */
/** @typedef {import('./CqlLogic').CompletionEntry} CompletionEntry */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * @typedef {{ completions?: CompletionEntry[]; diagnostics?: Array<{ message: string; start: number; end: number; code: number }>; error?: string }} WorkerResult
 */

/** @typedef {{ entity: string; prefix: string }} BatchProbeRequest */

/** @typedef {{ fields: Record<string, CompletionEntry[]>; error?: string }} BatchProbeResult */

/** @typedef {(args: string[], logger: import('typescript/lib/tsserverlibrary').server.Logger) => WorkerResult | null} RunWorker */

/** @typedef {(projectRoot: string, probes: BatchProbeRequest[], logger: import('typescript/lib/tsserverlibrary').server.Logger) => BatchProbeResult | null} RunBatchWorker */

/**
 * @typedef {{ 'cds.ql.completion': boolean; 'cds.ql.hover': boolean; 'cds.ql.diagnostics': boolean; 'cds.ql.typeInference': boolean; 'cds.ql.debounceDelay': number }} PluginConfig
 */

/**
 * @typedef {{ origText: string; origSf: import('typescript/lib/tsserverlibrary').SourceFile; projectRoot: string; logger: import('typescript/lib/tsserverlibrary').server.Logger; runWorker: RunWorker; runBatchWorker: RunBatchWorker }} QueryContext
 */

// ---------------------------------------------------------------------------
// Config reader
// ---------------------------------------------------------------------------

/**
 * Reads the plugin config from whatever the host (the vscode-cds extension) sends
 * via `configurePlugin` / the tsconfig `options` object.
 *
 * Total by construction — the config is a versioned, additive contract across an
 * extension-bundled copy and a possibly-different project-installed copy:
 *   - a non-object `raw` (null/undefined) yields all-defaults;
 *   - each known flag defaults to `false` (features are opt-in) or its numeric
 *     default when absent or the wrong type;
 *   - unknown keys — including the payload's `schemaVersion` tag and any keys a
 *     newer extension adds — are ignored rather than rejected.
 * Never throw here: `onConfigurationChanged` must tolerate any shape.
 *
 * @param {Partial<Record<string, unknown>> | null | undefined} raw
 * @returns {PluginConfig}
 */
const readConfig = (raw) => {
    const cfg = raw ?? {};
    return {
        'cds.ql.completion': cfg['cds.ql.completion'] === true,
        'cds.ql.hover': cfg['cds.ql.hover'] === true,
        'cds.ql.diagnostics': cfg['cds.ql.diagnostics'] === true,
        'cds.ql.typeInference': cfg['cds.ql.typeInference'] === true,
        'cds.ql.debounceDelay': typeof cfg['cds.ql.debounceDelay'] === 'number' ? cfg['cds.ql.debounceDelay'] : 300,
    };
};

// ---------------------------------------------------------------------------
// Context resolver
// ---------------------------------------------------------------------------

/**
 * @param {string} fileName
 * @param {import('typescript/lib/tsserverlibrary').server.PluginCreateInfo} info
 * @param {TS} typescript
 * @param {Map<string, string>} originalSource
 * @param {RunWorker} runWorker
 * @param {RunBatchWorker} runBatchWorker
 * @param {import('typescript/lib/tsserverlibrary').server.Logger} logger
 * @param {string} projectRoot
 * @returns {QueryContext | null}
 */
function resolveQueryContext(fileName, info, typescript, originalSource, runWorker, runBatchWorker, logger, projectRoot) {
    const scriptInfo = info.project.getScriptInfo(fileName);
    const liveSnap = scriptInfo && /** @type {any} */ (scriptInfo).__cdsOrigSnap?.();
    const origText = liveSnap ? liveSnap.getText(0, liveSnap.getLength()) : originalSource.get(fileName);
    if (!origText?.includes('cds.ql')) return null;

    const scriptKind = /\.tsx?$/.test(fileName) ? typescript.ScriptKind.TS : typescript.ScriptKind.JS;
    const origSf = typescript.createSourceFile(fileName, origText, typescript.ScriptTarget.Latest, true, scriptKind);

    return { origText, origSf, projectRoot, logger, runWorker, runBatchWorker };
}

module.exports = { readConfig, resolveQueryContext };
