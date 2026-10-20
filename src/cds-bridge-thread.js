'use strict';
/**
 * Bridge thread: mediates between the synchronous tsserver plugin and the
 * async child-process CDS worker.
 *
 * WHY A SEPARATE WORKER THREAD
 * tsserver is single-threaded and its plugin API is fully synchronous — there
 * is no await, no callback, no way to yield while waiting for I/O. The CDS
 * worker is a child process that communicates over stdio (newline-delimited
 * JSON), which is inherently async. This thread owns the child process and its
 * event loop, bridging the two worlds via SharedArrayBuffers:
 *
 *   main thread (tsserver plugin)
 *     writes request  → reqBuf
 *     sets  ctrl[0]=1, notifies ctrl[0]
 *     Atomics.wait(ctrl, 1, 0)   ← blocks here (synchronous wait is allowed
 *                                   on non-main threads but not on the main
 *                                   thread; the plugin runs in tsserver's main
 *                                   thread, but Atomics.wait IS allowed there
 *                                   because tsserver opts in via
 *                                   --experimental-worker or similar flags)
 *
 *   bridge thread (this file)
 *     Atomics.waitAsync(ctrl, 0, 0)  ← async wait, doesn't block this loop
 *     reads request  ← reqBuf
 *     sends to child process over stdin
 *     receives response from child process over stdout
 *     writes response → resBuf
 *     sets  ctrl[1]=1, notifies ctrl[1]
 *
 * SharedArrayBuffer layout
 *   ctrl   Int32Array[3]
 *     [0]  main→bridge:  1 = request pending  (bridge resets to 0 after read)
 *     [1]  bridge→main:  1 = response ready   (main   resets to 0 after read)
 *     [2]  bridge→main:  1 = fatal error, bridge is exiting
 *   reqBuf / resBuf  Uint8Array  (first 4 bytes = Int32 payload length, little-endian)
 *
 * HOW THIS FILE IS LOADED
 * index.ts passes the path to the compiled dist/cds-bridge-thread.js to
 * `new WorkerThread(path, { workerData: { ctrl, reqBuf, resBuf, ... } })`.
 * It must NOT be loaded with eval:true from an inline string because:
 *   1. An inline string is not typechecked or linted.
 *   2. Path-based loading lets Node resolve source maps for stack traces.
 *   3. It keeps this code readable and maintainable alongside the rest of src/.
 */

const { workerData, parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');

const { ctrl, reqBuf, resBuf, workerPath, projectRoot, nodeExec } =
    workerData;

const ctrlArr = new Int32Array(ctrl);
const reqArr = new Uint8Array(reqBuf);
const resArr = new Uint8Array(resBuf);

const child = spawn(nodeExec, [workerPath, projectRoot, '--persistent'], {
    stdio: ['pipe', 'pipe', 'pipe'],
});

/**
 * @typedef {{ resolve: (v: unknown) => void; reject: (e: unknown) => void }} PendingCall
 */
/** @type {PendingCall | null} */
let pending = null;
let buf = '';

child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (pending) {
            const cb = pending;
            pending = null;
            try {
                cb.resolve(JSON.parse(line));
            } catch (e) {
                cb.reject(e);
            }
        }
    }
});

child.on('exit', () => {
    Atomics.store(ctrlArr, 2, 1);
    Atomics.notify(ctrlArr, 1, 1);
});

child.stderr.on('data', (d) => {
    parentPort?.postMessage({ type: 'stderr', text: d.toString() });
});

parentPort?.on('message', (msg) => {
    if (msg?.type === 'shutdown') {
        try {
            child.kill();
        } catch {
            /* ignore */
        }
    }
});

/**
 * @param {string} json
 * @returns {Promise<unknown>}
 */
function send(json) {
    return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        child.stdin.write(json + '\n');
    });
}

/**
 * @returns {Promise<void>}
 */
async function loop() {
    while (true) {
        const w = Atomics.waitAsync(ctrlArr, 0, 0);
        if (w.async) await w.value;
        if (Atomics.load(ctrlArr, 2) === 1) break;

        const len = new DataView(reqBuf).getInt32(0, true);
        const json = Buffer.from(reqArr.subarray(4, 4 + len)).toString('utf8');
        Atomics.store(ctrlArr, 0, 0);

        let result;
        try {
            result = await send(json);
        } catch (e) {
            result = { error: String(e) };
        }

        const rb = Buffer.from(JSON.stringify(result), 'utf8');
        new DataView(resBuf).setInt32(0, rb.length, true);
        resArr.set(rb, 4);
        Atomics.store(ctrlArr, 1, 1);
        Atomics.notify(ctrlArr, 1, 1);
    }
}

loop();
