'use strict';
/**
 * Runtime oracle: drives a real `@sap/cds` installation to produce the ground
 * truth that the plugin's hand-coded assumptions (`src/cql/csn-resolve.js`) are
 * validated against.
 *
 * Two oracles:
 *   1. `compileFlavors(root)` — compiles the fixture model to the four CSN
 *      flavors the plugin's assumptions implicitly target. The plugin itself
 *      consumes the `raw` flavor (`cds.load('*', {root})`, see
 *      `src/cds-resolver-worker.js`), but synthesizes foreign-key columns that
 *      only materialize in the `odata` / `sql` flavors.
 *   2. `withSqlite(rawCsn, seed, fn)` — deploys the model to an in-memory sqlite
 *      database, seeds it, and runs real CQL so result shapes can be inspected.
 *
 * No test framework here — pure functions callable from `test-runtime.js`.
 */

const cds = require('@sap/cds');

/** Thrown by `withSqlite` when the sqlite driver cannot be loaded, so the
 *  caller can skip (not fail) the live-query half of the suite. `@cap-js/sqlite`
 *  defaults to the built-in `node:sqlite` driver (Node >=24, which this repo
 *  already requires), so no native module / `better-sqlite3` is needed — this
 *  guard is just a safety net for unexpected driver-load failures. */
class SqliteUnavailable extends Error {}

/**
 * @typedef {object} CsnFlavors
 * @property {any} raw     plain compiled CSN — what the plugin consumes
 * @property {any} linked  `cds.linked(raw)` — reflection view, same element set
 * @property {any} odata   `cds.compile.for.odata(raw)` — materializes FK elements
 * @property {string} sql  concatenated sqlite `CREATE TABLE` DDL
 */

/**
 * Compile the fixture model at `root` to every CSN flavor an assumption targets.
 * @param {string} root absolute path to the fixture project
 * @returns {Promise<CsnFlavors>}
 */
async function compileFlavors(root) {
    cds.root = root;
    const raw = await cds.load('*', { root });
    const linked = cds.linked(raw);
    const odata = cds.compile.for.odata(raw);
    const sqlOut = cds.compile.to.sql(raw, { dialect: 'sqlite', names: 'plain' });
    const sql = Array.isArray(sqlOut) ? sqlOut.join('\n') : String(sqlOut);
    return { raw, linked, odata, sql };
}

/**
 * Deploy `rawCsn` to a fresh in-memory sqlite DB, seed it, run `fn(db, cds)`.
 * Always deploy the RAW csn — deploy materializes the SQL DDL (and thus the FK
 * columns) internally; passing an already-odata-flavored CSN would double-process.
 *
 * Mutates `cds.env.requires.db` for the duration and disconnects in `finally`
 * so nothing leaks between tests sharing the process.
 *
 * @param {any} rawCsn
 * @param {Record<string, object[]>} seed  entity FQN -> rows to INSERT
 * @param {(db: any, cdsApi: any) => Promise<any>} fn
 * @returns {Promise<any>}
 * @throws {SqliteUnavailable} when the driver fails to load
 */
async function withSqlite(rawCsn, seed, fn) {
    const prevEnvDb = cds.env.requires.db;
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
    let db;
    try {
        db = await cds.connect.to('db');
    } catch (err) {
        cds.env.requires.db = prevEnvDb;
        throw new SqliteUnavailable(/** @type {Error} */ (err).message);
    }
    try {
        await cds.deploy(rawCsn).to(db);
        const { INSERT } = cds.ql;
        for (const [entity, rows] of Object.entries(seed)) {
            if (rows.length) await db.run(INSERT.into(entity).entries(rows));
        }
        return await fn(db, cds);
    } finally {
        if (db && typeof db.disconnect === 'function') await db.disconnect();
        cds.env.requires.db = prevEnvDb;
    }
}

/**
 * Parse the physical column names of a table out of the sqlite DDL. Used to
 * cross-check `elementNamesWithForeignKeys` against the real columns.
 * Table names use the `plain` naming convention: `rt.Books` -> `rt_Books`.
 * @param {string} sql
 * @param {string} tableName e.g. `rt_Books`
 * @returns {string[]}
 */
function sqlColumns(sql, tableName) {
    const re = new RegExp(`CREATE TABLE ${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
    const m = sql.match(re);
    if (!m) return [];
    return m[1]
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^(PRIMARY KEY|CONSTRAINT|UNIQUE|FOREIGN KEY)/i.test(line))
        .map((line) => line.split(/\s+/)[0])
        .filter(Boolean);
}

module.exports = { compileFlavors, withSqlite, sqlColumns, SqliteUnavailable };
