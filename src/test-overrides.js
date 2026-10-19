'use strict';

/**
 * Type of the plugin's test-only injection point, exposed at runtime as
 * `pluginFactory._testOverrides`. Declared in its own module because
 * `index.ts` uses `export = pluginFactory` (required for tsserver plugins),
 * which cannot coexist with named ES exports.
 */

/** @typedef {import('typescript/lib/tsserverlibrary').server.Logger} TSServerLogger */
/** @typedef {import('./QueryContext').RunWorker} RunWorker */
/** @typedef {import('./QueryContext').RunBatchWorker} RunBatchWorker */
/** @typedef {import('./QueryContext').WorkerResult} WorkerResult */

/**
 * @typedef {{
 *   call(projectRoot: string, req: object, logger: TSServerLogger, timeoutMs?: number): unknown | null;
 *   shutdown(): Promise<void>;
 * }} WorkerPoolLike
 */

/**
 * @typedef {{
 *   rw?: RunWorker;
 *   rwBatch?: RunBatchWorker;
 *   workerPath?: string;
 *   bridgeThreadPath?: string;
 *   _runWorker: (args: string[], logger: TSServerLogger, timeoutMs?: number) => WorkerResult | null;
 *   _runBatchWorker: RunBatchWorker;
 *   _workerPool: WorkerPoolLike;
 *   _shutdownPool: () => Promise<void>;
 * }} TestOverrides
 */

module.exports = {};
