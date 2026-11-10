'use strict';
/**
 * Runtime assumption tests.
 *
 * Validates the hand-coded CDS assumptions in `src/cql/csn-resolve.js` against a
 * real `@sap/cds` runtime: it compiles the fixture model to every CSN flavor and
 * fires live CQL at an in-memory sqlite DB, then checks the plugin's output with
 * the zod schemas in `schemas.js`.
 *
 * The suite runs every time — the actual work (compile + deploy + queries + zod)
 * is only ~25ms; the dominant cost is Node startup, which any test process pays.
 * The zod schemas in `schemas.js` ARE the assertions; there is no stored baseline.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const { compileFlavors, withSqlite, sqlColumns, SqliteUnavailable } = require('./oracle');
const schemas = require('./schemas');
const { cdsTypeToTs, resolveBaseType, isToMany, elementNamesWithForeignKeys, followAssocPath } = require('../../src/cql/csn-resolve');
const { validateCqlQuery, getSuggestions } = require('../../src/cql/endpoints');
const { deriveTruth, buildBattery } = require('./differential');

const FIXTURE_ROOT = path.join(__dirname, '..', 'data', 'runtimeModel');

describe('runtime assumptions', () => {
    /** @type {import('./oracle').CsnFlavors} */
    let flavors;

    it('compiles the fixture to all CSN flavors', async () => {
        flavors = await compileFlavors(FIXTURE_ROOT);
        assert.ok(flavors.raw.definitions['rt.Books'], 'fixture failed to compile');
    });

    // --- CSN-flavor assertions (no native deps) ------------------------------

    it('cdsTypeToTs: builtin + alias type map matches raw CSN element types', () => {
        const el = flavors.raw.definitions['rt.Scalars'].elements;
        const claims = Object.entries(el)
            .filter(([, e]) => typeof (/** @type {any} */ (e).type) === 'string' && /** @type {any} */ (e).type.startsWith('cds.'))
            .map(([name, e]) => ({
                element: `rt.Scalars.${name}`,
                cdsType: /** @type {any} */ (e).type,
                tsClaim: cdsTypeToTs(/** @type {any} */ (e).type),
            }));
        // The live typeof cross-check is the sqlite test; here we only assert the
        // claim is a known mapping (possibly a union).
        const ALLOWED = new Set(['string', 'number', 'boolean', 'unknown']);
        for (const c of claims) {
            const members = c.tsClaim.split('|').map((s) => s.trim());
            assert.ok(
                members.every((m) => ALLOWED.has(m)),
                `unmapped: ${c.cdsType} -> ${c.tsClaim}`,
            );
        }
    });

    it('resolveBaseType: `Name` alias resolves to cds.String', () => {
        const resolved = resolveBaseType('rt.Name', flavors.raw.definitions);
        schemas.BaseTypeClaim.parse({ alias: 'rt.Name', resolvedBase: resolved ?? 'undefined', expectedBase: 'cds.String' });
    });

    it('elementNamesWithForeignKeys: synthesized FKs materialize in odata + SQL, unmanaged do not', () => {
        const fkClaims = [];
        for (const entity of ['rt.Books', 'rt.Authors']) {
            const raw = flavors.raw.definitions[entity];
            const ownNames = new Set(Object.keys(raw.elements));
            const synthesized = [...elementNamesWithForeignKeys(raw)].filter((n) => !ownNames.has(n));
            const odataElements = Object.keys(flavors.odata.definitions[entity].elements);
            const table = entity.replace('.', '_');
            const cols = sqlColumns(flavors.sql, table);
            // An FK is "unmanaged" (a bug) if the plugin synthesized it but it does not exist downstream.
            const unmanagedFks = synthesized.filter((fk) => !(odataElements.includes(fk) || cols.includes(fk)));
            const claim = { entity, synthesizedFks: synthesized, odataElements, sqlColumns: cols, unmanagedFks };
            schemas.FkSynthesisClaim.parse(claim);
            fkClaims.push({ entity, synthesizedFks: synthesized });
        }
        // Headline: Books synthesizes author_ID (managed) and NOT editor_ID (unmanaged).
        const books = fkClaims.find((c) => c.entity === 'rt.Books');
        assert.ok(books.synthesizedFks.includes('author_ID'), 'expected author_ID to be synthesized');
        assert.ok(!books.synthesizedFks.includes('editor_ID'), 'unmanaged editor must NOT synthesize editor_ID');
    });

    it('followAssocPath + assoc target: managed `author` resolves to rt.Authors with odata FK annotation', () => {
        const raw = flavors.raw.definitions;
        const terminal = followAssocPath(raw, 'rt.Books', ['author']);
        assert.equal(terminal && terminal === raw['rt.Authors'], true, 'followAssocPath did not reach rt.Authors');
        const rawTarget = raw['rt.Books'].elements.author.target ?? null;
        const odataBooks = flavors.odata.definitions['rt.Books'].elements;
        const odataFkAnnotationPresent = Object.values(odataBooks).some((e) => /** @type {any} */ (e)['@odata.foreignKey4'] === 'author');
        schemas.AssocPathClaim.parse({ entity: 'rt.Books', assoc: 'author', rawTarget, expectedTarget: 'rt.Authors', odataFkAnnotationPresent });
    });

    it('resolveSource .drafts stripping: no `.drafts` shadow is materialized in any flavor', () => {
        const rawHasDraftShadow = Object.keys(flavors.raw.definitions).some((n) => n.endsWith('.drafts'));
        const odataHasDraftShadow = Object.keys(flavors.odata.definitions).some((n) => n.endsWith('.drafts'));
        schemas.DraftShadowClaim.parse({ draftEntity: 'rt.Orders', rawHasDraftShadow, odataHasDraftShadow });
    });

    // --- live-query assertions (need sqlite; skippable) ----------------------

    it('live queries: FK column, expand cardinality, type round-trip, aggregate', async (t) => {
        const raw = flavors.raw.definitions;
        const seed = {
            'rt.Addresses': [{ ID: 1, city: 'Vienna', country: 'AT' }],
            'rt.Authors': [{ ID: 1, name: 'Ada', address_ID: 1 }],
            'rt.Books': [
                { ID: 10, title: 'A', stock: 5, author_ID: 1 },
                { ID: 11, title: 'B', stock: 3, author_ID: 1 },
            ],
            'rt.Scalars': [
                {
                    ID: 1,
                    s_string: 'x',
                    s_large: 'y',
                    s_uuid: '00000000-0000-0000-0000-000000000001',
                    s_bool: true,
                    s_int: 42,
                    s_int64: 99,
                    s_decimal: 1.5,
                    s_double: 2.5,
                    s_date: '2020-01-01',
                    s_time: '10:00:00',
                    s_datetime: '2020-01-01T10:00:00Z',
                    s_ts: '2020-01-01T10:00:00.000Z',
                    s_alias: 'z',
                },
            ],
        };

        let live;
        try {
            live = await withSqlite(flavors.raw, seed, async (db) => {
                const toMany = await db.run({
                    SELECT: {
                        from: { ref: ['rt.Authors'] },
                        columns: [{ ref: ['ID'] }, { ref: ['books'], expand: [{ ref: ['ID'] }, { ref: ['title'] }] }],
                        orderBy: [{ ref: ['ID'] }],
                    },
                });
                const toOne = await db.run({
                    SELECT: {
                        from: { ref: ['rt.Books'] },
                        columns: [{ ref: ['ID'] }, { ref: ['author'], expand: [{ ref: ['ID'] }, { ref: ['name'] }] }],
                        orderBy: [{ ref: ['ID'] }],
                    },
                });
                const flat = await db.run({
                    SELECT: { from: { ref: ['rt.Books'] }, columns: [{ ref: ['author_ID'] }], orderBy: [{ ref: ['ID'] }] },
                });
                const agg = await db.run({
                    SELECT: { from: { ref: ['rt.Books'] }, columns: [{ func: 'count', args: ['*'], as: 'n' }] },
                });
                const scalars = await db.run({ SELECT: { from: { ref: ['rt.Scalars'] } } });
                const upd = await db.run(cds.ql.UPDATE('rt.Books').set({ title: 'B' }).where({ ID: 10 }));
                const del = await db.run(cds.ql.DELETE.from('rt.Books').where({ ID: 11 }));
                return { toMany, toOne, flat, agg, scalars: scalars[0], upd, del };
            });
        } catch (err) {
            if (err instanceof SqliteUnavailable) {
                t.skip(`sqlite driver unavailable: ${err.message}`);
                return;
            }
            throw err;
        }

        // FK column is real & queryable.
        assert.equal(live.flat[0].author_ID, 1, 'synthesized author_ID is not a queryable column');

        // Expand cardinality vs isToMany.
        schemas.ToManyExpandRow.array().parse(live.toMany);
        schemas.ToOneExpandRow.array().parse(live.toOne);
        schemas.CardinalityClaim.parse({
            entity: 'rt.Authors',
            element: 'books',
            isToManyClaim: isToMany(raw['rt.Authors'].elements.books),
            liveExpandIsArray: Array.isArray(live.toMany[0].books),
        });
        schemas.CardinalityClaim.parse({
            entity: 'rt.Books',
            element: 'author',
            isToManyClaim: isToMany(raw['rt.Books'].elements.author),
            liveExpandIsArray: Array.isArray(live.toOne[0].author),
        });

        // Aggregate shape.
        schemas.AggregateRow.parse(live.agg[0]);

        // UPDATE/DELETE return number (affected-row count) — plugin claims 'number'.
        assert.equal(typeof live.upd, 'number', 'UPDATE must return a number');
        assert.equal(typeof live.del, 'number', 'DELETE must return a number');

        // cdsTypeToTs claim vs live typeof, per scalar element.
        const scalarEls = raw['rt.Scalars'].elements;
        for (const [name, value] of Object.entries(live.scalars)) {
            const el = scalarEls[name];
            if (!el || typeof el.type !== 'string') continue;
            schemas.TypeMapClaim.parse({
                element: `rt.Scalars.${name}`,
                cdsType: el.type,
                tsClaim: cdsTypeToTs(el.type),
                liveTypeof: /** @type {any} */ (value === null ? 'object' : typeof value),
            });
        }
    });
});

// ---------------------------------------------------------------------------
// Differential oracle — diff the plugin's own outputs against CSN truth.
// The battery is derived from the compiled model, so its scope scales with the
// fixture and cannot be silently narrowed. A disagreement here is a real
// plugin-vs-runtime defect (the kind unit tests, written against the same
// assumption, cannot catch).
// ---------------------------------------------------------------------------

describe('differential oracle (plugin vs CSN truth)', () => {
    /** @type {import('./oracle').CsnFlavors} */
    let flavors;
    /** @type {Map<string, import('./differential').TruthEntity>} */
    let truth;
    /** @type {import('./differential').BatteryCase[]} */
    let battery;

    it('derives a battery covering every case category (anti-rot)', async () => {
        flavors = await compileFlavors(FIXTURE_ROOT);
        truth = deriveTruth(flavors);
        battery = buildBattery(truth);
        assert.ok(truth.size >= 4, `expected >=4 entities in truth model, got ${truth.size}`);
        // Per-category floor: an aggregate count can be satisfied by own+ghost cases
        // alone, so deleting FK or association-path generation would stay green under
        // a single total floor. Require each category to be non-empty so removing any
        // generator fails loudly. Counts are derived from the fixture, which has
        // managed associations (→ FKs + assoc-paths) and plain columns.
        const byCat = (c) => battery.filter((x) => x.category === c).length;
        for (const cat of ['own', 'fk', 'assoc-path', 'invalid']) {
            assert.ok(byCat(cat) > 0, `differential battery has no '${cat}' cases — that generator may have been removed`);
        }
        assert.ok(battery.length >= 20, `differential battery too small (${battery.length}) — oracle may have been stubbed to a no-op`);
    });

    it('validateCqlQuery agrees with the model on every battery case', () => {
        /** @type {string[]} */
        const disagreements = [];
        for (const { query, valid, why } of battery) {
            const errs = validateCqlQuery(query, flavors.raw.definitions, undefined);
            const pluginSaysValid = errs.length === 0;
            if (pluginSaysValid !== valid) {
                disagreements.push(`${why}: model=${valid ? 'valid' : 'invalid'} plugin=${pluginSaysValid ? 'valid' : 'invalid'} [${errs.map((e) => e.message).join('; ')}]`);
            }
        }
        assert.deepEqual(disagreements, [], `plugin disagrees with CSN truth on ${disagreements.length} case(s):\n  ${disagreements.join('\n  ')}`);
    });

    it('getSuggestions offers only fields that exist in the model (no phantom completions)', () => {
        /** @type {string[]} */
        const phantoms = [];
        let checked = 0;
        for (const { fqn, own } of truth.values()) {
            // Cursor right after `SELECT ` in a from-known query → field completions.
            const query = `SELECT  FROM ${fqn}`;
            const cursor = 'SELECT '.length;
            const offered = getSuggestions(query, cursor, flavors.raw.definitions, undefined).filter((i) => i.kind === 'field');
            for (const item of offered) {
                checked++;
                if (!own.has(item.label)) phantoms.push(`${fqn}: offered field '${item.label}' not in model`);
            }
        }
        assert.ok(checked >= 20, `too few completion items checked (${checked}) — completion oracle may be a no-op`);
        assert.deepEqual(phantoms, [], `phantom completions:\n  ${phantoms.join('\n  ')}`);
    });
});
