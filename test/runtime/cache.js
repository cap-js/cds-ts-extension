'use strict';
/**
 * Version-keyed snapshot cache. The runtime suite is expensive (compiles CDS,
 * spins up sqlite) but its result only changes when the CDS toolchain or the
 * fixture model changes. We key a committed snapshot on those inputs so the
 * common case (nothing relevant changed) short-circuits to a skip, while a
 * dependency bump or fixture edit forces a real re-run.
 *
 * The key is a content hash of the world the suite observes:
 *   - `@sap/cds` version
 *   - `@sap/cds-compiler` version (explicit devDep so this is deterministic)
 *   - a hash of every `.cds` file in the fixture
 *   - a manual `SCHEMA_VERSION` (bump when assumptions/schemas change without a
 *     dependency bump — otherwise the key would not move and CI would skip a
 *     changed assertion set).
 *
 * Writes only happen under `CDS_RUNTIME_FORCE` (see `test-runtime.js`), so CI's
 * normal path never mutates the snapshot on disk.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Bump when editing schemas.js / csn-resolve.js assumptions without a cds bump. */
const SCHEMA_VERSION = 1;

const FIXTURE_DIR = path.join(__dirname, '..', 'data', 'runtimeModel');
const SNAPSHOT_PATH = path.join(__dirname, 'snapshot.json');

/** sha256 hex of a string. */
function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** Recursively collect `.cds` file paths under `dir`, sorted for determinism. */
function cdsFiles(dir) {
    /** @type {string[]} */
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '@types') continue;
            out.push(...cdsFiles(full));
        } else if (entry.name.endsWith('.cds')) {
            out.push(full);
        }
    }
    return out.sort();
}

/** Hash of the fixture model: path + content of every `.cds` file. */
function fixtureHash() {
    const parts = cdsFiles(FIXTURE_DIR).map((f) => `${path.relative(FIXTURE_DIR, f)}\n${fs.readFileSync(f, 'utf8')}`);
    return sha256(parts.join('\n---\n'));
}

/**
 * @returns {{ key: string, versions: { cds: string, cdsCompiler: string }, schemaVersion: number, fixture: string }}
 */
function computeKey() {
    const cds = require('@sap/cds/package.json').version;
    const cdsCompiler = require('@sap/cds-compiler/package.json').version;
    const fixture = fixtureHash();
    const key = sha256(JSON.stringify({ cds, cdsCompiler, fixture, schemaVersion: SCHEMA_VERSION }));
    return { key, versions: { cds, cdsCompiler }, schemaVersion: SCHEMA_VERSION, fixture };
}

/** @returns {any | null} the parsed snapshot, or null if none exists. */
function readSnapshot() {
    try {
        return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Write the snapshot tab-indented with a trailing newline, matching the repo's
 * biome JSON formatting (tabs) so `format:check` stays green after a regen.
 * @param {object} snapshot
 */
function writeSnapshot(snapshot) {
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, '\t')}\n`, 'utf8');
}

module.exports = { computeKey, readSnapshot, writeSnapshot, SNAPSHOT_PATH, SCHEMA_VERSION };
