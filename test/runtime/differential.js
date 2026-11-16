'use strict';
/**
 * Differential oracle — the anti-drift heart of the runtime suite.
 *
 * Instead of checking a hand-written list of assumptions, this derives a query
 * battery *from the compiled model* and diffs the plugin's own outputs
 * (`validateCqlQuery`, `getSuggestions`) against the CSN truth set. The CSN is
 * the independent source of truth (produced by real `@sap/cds`), so a wrong
 * assumption in the plugin surfaces as a disagreement here even when unit tests
 * — written against the same assumption — stay green.
 *
 * Truth set per entity (what a column reference may legitimately be):
 *   - own elements (raw CSN)
 *   - synthesized managed-association FK columns (present in the odata flavor)
 *   - single-hop association paths `<assoc>.<targetElement>`
 *
 * Because the battery is generated from the model, its scope cannot be quietly
 * narrowed — shrinking it requires removing entities/elements from the fixture,
 * a conspicuous edit. `buildBattery` also reports a case count so the caller can
 * enforce a floor against a silent no-op (see test-runtime.js).
 *
 * No test framework here — pure functions.
 */

/** @typedef {import('./oracle').CsnFlavors} CsnFlavors */

/**
 * @typedef {object} TruthEntity
 * @property {string} fqn
 * @property {Set<string>} own        own element names (raw CSN)
 * @property {Set<string>} fks        synthesized FK column names (odata − own)
 * @property {Map<string, string>} assocs  association name -> target entity fqn
 */

/**
 * Derive the per-entity truth model from the compiled CSN flavors.
 * @param {CsnFlavors} flavors
 * @returns {Map<string, TruthEntity>}
 */
function deriveTruth(flavors) {
    const raw = flavors.raw.definitions;
    const odata = flavors.odata.definitions;
    /** @type {Map<string, TruthEntity>} */
    const truth = new Map();
    for (const [fqn, def] of Object.entries(raw)) {
        if (/** @type {any} */ (def).kind !== 'entity') continue;
        const elements = /** @type {Record<string, any>} */ (/** @type {any} */ (def).elements ?? {});
        const own = new Set(Object.keys(elements));
        const odElements = Object.keys(/** @type {any} */ (odata[fqn])?.elements ?? {});
        const fks = new Set(odElements.filter((n) => !own.has(n)));
        /** @type {Map<string, string>} */
        const assocs = new Map();
        for (const [name, el] of Object.entries(elements)) {
            if (el.target) assocs.set(name, el.target);
        }
        truth.set(fqn, { fqn, own, fks, assocs });
    }
    return truth;
}

/**
 * @typedef {object} BatteryCase
 * @property {string} query       full CQL query text (FQN form, no service prefix)
 * @property {boolean} valid      whether the model says this query is valid
 * @property {'own' | 'fk' | 'assoc-path' | 'invalid' | 'write-valid' | 'write-invalid' | 'shape-valid' | 'shape-invalid'} category  case category (for per-category anti-rot floors)
 * @property {string} why         short label for diagnostics
 */

/**
 * The battery is built in two parts (see docs atop this file):
 *
 *   1. A **canonical shape battery** — one case per `(query-shape × outcome)`
 *      equivalence class, generated off a single computed representative entity
 *      (`pickRepresentative`). Covers the validator's distinct code paths
 *      (parens, braces/expand, ORDER BY, aliases, dotted-path failures, …) with
 *      a constant number of cases, independent of fixture size. This is what the
 *      coverage ratchet guards.
 *   2. A small **per-entity sweep** — the only `O(entities)` part — re-asserting
 *      the own/fk/assoc-path/ghost categories for *every* entity, because those
 *      are where per-entity breadth catches real model drift.
 *
 * Case count is therefore bounded by `#shapes + O(entities) × few`, not by
 * `O(entities × templates)`, so the battery stops growing with the fixture.
 */

/**
 * A column name guaranteed absent from the truth sets (so the plugin must flag it).
 * @param {Set<string>} own
 * @param {Set<string>} fks
 * @returns {string}
 */
function ghostName(own, fks) {
    let n = 'ghost_col';
    let i = 0;
    while (own.has(n) || fks.has(n)) n = `ghost_col_${i++}`;
    return n;
}

/**
 * An entity FQN provably absent from the model — used to drive the "unknown
 * entity" diagnostics (SELECT FROM ghost; UPDATE ghost SET …) that a ghost
 * *column* can never reach.
 * @param {Map<string, TruthEntity>} truth
 * @returns {string}
 */
function ghostEntityName(truth) {
    let n = 'rt.GhostEntity';
    let i = 0;
    while (truth.has(n)) n = `rt.GhostEntity${i++}`;
    return n;
}

/**
 * @typedef {object} Representative
 * @property {string} fqn          representative entity FQN
 * @property {string} scalar       a scalar own column
 * @property {string} scalar2      a second scalar own column (for multi-assignment / expand lists)
 * @property {string} fk           a synthesized FK column
 * @property {string} assoc        a managed association name
 * @property {string} assocTarget  the association's target entity FQN
 * @property {string} targetScalar a scalar column on the association target
 * @property {string} ghostCol     a column name absent from the representative
 * @property {string} ghostEntity  an entity FQN absent from the model
 * @property {string} joinOther    a second entity sharing a column with the representative (for ambiguity)
 * @property {string} sharedCol    the column both share (ambiguous when unqualified across the join)
 */

/**
 * First association (of `assocs`) whose target entity is in the model and has at
 * least one scalar element — i.e. a navigable single-hop assoc-path.
 * @param {Map<string, TruthEntity>} truth
 * @param {Map<string, string>} assocs
 * @returns {{ assoc: string, assocTarget: string, targetScalar: string } | null}
 */
function findNavigableAssoc(truth, assocs) {
    for (const [name, target] of assocs) {
        const t = truth.get(target);
        if (!t) continue;
        const ts = [...t.own].find((n) => !t.assocs.has(n));
        if (ts) return { assoc: name, assocTarget: target, targetScalar: ts };
    }
    return null;
}

/**
 * Pick the representative entity for the shape battery: the first entity that
 * has a managed association (→ FK + assoc-path shapes), at least two scalar own
 * columns, and a synthesized FK — computed from the model, never hardcoded, so
 * the battery can't silently depend on a specific fixture name.
 * @param {Map<string, TruthEntity>} truth
 * @returns {Representative | null}
 */
function pickRepresentative(truth) {
    for (const { fqn, own, fks, assocs } of truth.values()) {
        const scalars = [...own].filter((n) => !assocs.has(n));
        if (scalars.length < 2 || fks.size === 0 || assocs.size === 0) continue;
        // Find an association whose target is itself in the model and has a scalar.
        const assocHit = findNavigableAssoc(truth, assocs);
        if (!assocHit) continue;
        const { assoc, assocTarget, targetScalar } = assocHit;
        // A second entity sharing a column with the representative, for JOIN ambiguity.
        let joinOther;
        let sharedCol;
        for (const other of truth.values()) {
            if (other.fqn === fqn) continue;
            const shared = [...own].find((n) => !assocs.has(n) && other.own.has(n) && !other.assocs.has(n));
            if (shared) {
                joinOther = other.fqn;
                sharedCol = shared;
                break;
            }
        }
        return {
            fqn,
            scalar: scalars[0],
            scalar2: scalars[1],
            fk: [...fks][0],
            assoc,
            assocTarget,
            targetScalar,
            ghostCol: ghostName(own, fks),
            ghostEntity: ghostEntityName(truth),
            joinOther: joinOther ?? fqn,
            sharedCol: sharedCol ?? scalars[0],
        };
    }
    return null;
}

/**
 * The canonical SELECT/DELETE shape battery: one case per `(shape × outcome)`
 * class. Each entry targets a distinct validator code path (see the per-range
 * map in the audit). All identifiers come from the representative, so the set is
 * model-derived yet constant in size.
 * @param {Representative} rep
 * @returns {BatteryCase[]}
 */
function buildShapeBattery(rep) {
    const E = rep.fqn;
    const { scalar, fk, assoc, targetScalar, ghostCol, ghostEntity, joinOther, sharedCol } = rep;
    /** @type {Array<[string, boolean, string]>} */
    const shapes = [
        // Qualified (source-alias) refs — success and failure. NB: a short alias
        // is used, not the bare FQN prefix (`rt.Books.ID`): the real compiler
        // accepts that, but the plugin mis-parses the dotted FQN as source `rt`
        // (known gap — see memory `cql-fqn-source-prefix-gap`). Alias form
        // exercises the same source-qualified validator path honestly.
        [`SELECT A.${scalar} FROM ${E} AS A`, true, 'alias-qualified ref via AS (ok)'],
        [`SELECT B.${scalar} FROM ${E} B`, true, 'implicit-alias-qualified ref (ok)'],
        [`SELECT A.${ghostCol} FROM ${E} AS A`, false, 'alias-qualified ghost (flagged)'],
        // Dotted association-path refs — success and both failure diagnostics.
        [`SELECT ${assoc}.${targetScalar} FROM ${E}`, true, 'assoc-path ref (ok)'],
        [`SELECT ${assoc}.${ghostCol} FROM ${E}`, false, 'assoc-path unknown terminal (flagged)'],
        [`SELECT ${scalar}.${targetScalar} FROM ${E}`, false, 'dotted ref off a scalar (flagged)'],
        [`SELECT ${ghostCol}.${targetScalar} FROM ${E}`, false, 'dotted ref off unknown source (flagged)'],
        // Unknown entity in FROM (reachable only via a ghost *entity*, not column).
        [`SELECT ${scalar} FROM ${ghostEntity}`, false, 'unknown entity in FROM (flagged)'],
        // Function-call args + star inside parens.
        [`SELECT max(${scalar}) FROM ${E}`, true, 'function-call arg (ok)'],
        [`SELECT count(*) FROM ${E}`, true, 'count(*) star in parens (ok)'],
        [`SELECT max(${ghostCol}) FROM ${E}`, false, 'ghost inside function call (flagged)'],
        // Subquery paren is skipped (its contents are not validated against E).
        [`SELECT ${scalar} FROM ${E} WHERE ${scalar} IN (SELECT 1)`, true, 'subquery paren skipped (ok)'],
        // Projection / expand braces — flat, nested, inline-dot, and ghost.
        [`SELECT FROM ${E} { ${scalar} }`, true, 'projection brace (ok)'],
        [`SELECT FROM ${E} { ${ghostCol} }`, false, 'projection brace ghost (flagged)'],
        [`SELECT FROM ${E} { ${assoc} { ${targetScalar} } }`, true, 'nested expand brace (ok)'],
        [`SELECT FROM ${E} { ${assoc}.{ ${targetScalar} } }`, true, 'inline-dot expand (ok)'],
        // ORDER BY / GROUP BY clauses + star.
        [`SELECT ${scalar} FROM ${E} ORDER BY ${scalar}`, true, 'ORDER BY clause (ok)'],
        [`SELECT ${scalar} FROM ${E} GROUP BY ${scalar}`, true, 'GROUP BY clause (ok)'],
        [`SELECT * FROM ${E}`, true, 'SELECT star (ok)'],
        // Multi-source: comma join + JOIN with ambiguous unqualified field.
        [`SELECT A.${scalar} FROM ${E} AS A, ${joinOther}`, true, 'comma multi-source (ok)'],
        [`SELECT ${sharedCol} FROM ${E} JOIN ${joinOther} ON ${E}.${sharedCol} = ${joinOther}.${sharedCol}`, false, 'ambiguous field across JOIN (flagged)'],
        // `one` singularizer keyword, and DELETE (flows through the SELECT path).
        [`SELECT one ${scalar} FROM ${E}`, true, 'one singularizer keyword (ok)'],
        [`DELETE FROM ${E} WHERE ${fk} = 1`, true, 'DELETE WHERE fk via SELECT path (ok)'],
    ];
    return shapes.map(([query, valid, why]) => ({ query, valid, category: valid ? 'shape-valid' : 'shape-invalid', why: `shape: ${why}` }));
}

/**
 * The per-entity sweep: own/fk/assoc-path/ghost for every entity. Keeps the
 * breadth that catches model drift an individual representative can't.
 * @param {Map<string, TruthEntity>} truth
 * @returns {BatteryCase[]}
 */
function buildEntitySweep(truth) {
    /** @type {BatteryCase[]} */
    const cases = [];
    for (const { fqn, own, fks, assocs } of truth.values()) {
        for (const col of own) {
            if (assocs.has(col)) continue; // associations are not scalar columns
            cases.push({ query: `SELECT ${col} FROM ${fqn}`, valid: true, category: 'own', why: `${fqn}.${col} (own)` });
        }
        for (const fk of fks) {
            cases.push({ query: `SELECT ${fk} FROM ${fqn}`, valid: true, category: 'fk', why: `${fqn}.${fk} (fk)` });
        }
        for (const [assoc, target] of assocs) {
            const targetEntity = truth.get(target);
            if (!targetEntity) continue;
            for (const tcol of targetEntity.own) {
                if (targetEntity.assocs.has(tcol)) continue;
                cases.push({ query: `SELECT ${assoc}.${tcol} FROM ${fqn}`, valid: true, category: 'assoc-path', why: `${fqn}.${assoc}.${tcol} (assoc-path)` });
            }
        }
        const ghost = ghostName(own, fks);
        cases.push({ query: `SELECT ${ghost} FROM ${fqn}`, valid: false, category: 'invalid', why: `${fqn}.${ghost} (ghost → must be flagged)` });
    }
    return cases;
}

/**
 * The SELECT/DELETE read battery: canonical shapes (constant) + per-entity sweep.
 * @param {Map<string, TruthEntity>} truth
 * @returns {BatteryCase[]}
 */
function buildBattery(truth) {
    const rep = pickRepresentative(truth);
    const shapes = rep ? buildShapeBattery(rep) : [];
    return [...shapes, ...buildEntitySweep(truth)];
}

/**
 * The canonical write-statement shape battery: one case per `(write-shape ×
 * outcome)` class off the representative entity. Covers every distinct field
 * position in `validateWriteStatement` (UPDATE SET assignment/object, WHERE,
 * multi-assignment; INSERT/UPSERT column-list and ENTRIES forms) plus the
 * ghost-entity target (unknown-entity diagnostic) a ghost *column* can't reach.
 * @param {Representative} rep
 * @returns {BatteryCase[]}
 */
function buildWriteShapeBattery(rep) {
    const E = rep.fqn;
    const { scalar, scalar2, fk, ghostCol, ghostEntity } = rep;
    /** @type {Array<[string, boolean, string]>} */
    const shapes = [
        // UPDATE SET — assignment, object, multi-assignment; FK target; ghosts.
        [`UPDATE ${E} SET ${scalar} = 1`, true, 'UPDATE SET assignment (ok)'],
        [`UPDATE ${E} SET { ${scalar}: 1 }`, true, 'UPDATE SET object form (ok)'],
        [`UPDATE ${E} SET ${scalar} = 1, ${scalar2} = 2`, true, 'UPDATE SET multi-assignment (ok)'],
        [`UPDATE ${E} SET ${fk} = 1`, true, 'UPDATE SET fk target (ok)'],
        [`UPDATE ${E} SET ${ghostCol} = 1`, false, 'UPDATE SET ghost (flagged)'],
        [`UPDATE ${E} SET { ${ghostCol}: 1 }`, false, 'UPDATE SET object ghost (flagged)'],
        // UPDATE WHERE — scalar, fk, ghost.
        [`UPDATE ${E} SET ${scalar} = 1 WHERE ${fk} = 1`, true, 'UPDATE WHERE fk (ok)'],
        [`UPDATE ${E} SET ${scalar} = 1 WHERE ${ghostCol} = 1`, false, 'UPDATE WHERE ghost (flagged)'],
        // INSERT / UPSERT — column-list, ENTRIES object, fk column; ghosts.
        [`INSERT INTO ${E} (${scalar}) VALUES (1)`, true, 'INSERT column-list (ok)'],
        [`INSERT INTO ${E} (${fk}) VALUES (1)`, true, 'INSERT column-list fk (ok)'],
        [`INSERT INTO ${E} ENTRIES { ${scalar}: 1 }`, true, 'INSERT ENTRIES object (ok)'],
        [`UPSERT INTO ${E} (${scalar}) VALUES (1)`, true, 'UPSERT column-list (ok)'],
        [`INSERT INTO ${E} (${ghostCol}) VALUES (1)`, false, 'INSERT column-list ghost (flagged)'],
        [`INSERT INTO ${E} ENTRIES { ${ghostCol}: 1 }`, false, 'INSERT ENTRIES ghost (flagged)'],
        // Unknown-entity write target (ghost *entity*, not column).
        [`UPDATE ${ghostEntity} SET ${scalar} = 1`, false, 'UPDATE unknown entity (flagged)'],
    ];
    return shapes.map(([query, valid, why]) => ({ query, valid, category: valid ? 'write-valid' : 'write-invalid', why: `write-shape: ${why}` }));
}

/**
 * Per-entity write sweep: one representative valid form + FK + ghost per entity,
 * so dropping write validation for any entity is caught across the fixture.
 * @param {Map<string, TruthEntity>} truth
 * @returns {BatteryCase[]}
 */
function buildWriteSweep(truth) {
    /** @type {BatteryCase[]} */
    const cases = [];
    for (const { fqn, own, fks, assocs } of truth.values()) {
        const scalar = [...own].find((n) => !assocs.has(n));
        if (scalar) {
            cases.push({ query: `UPDATE ${fqn} SET ${scalar} = 1`, valid: true, category: 'write-valid', why: `UPDATE ${fqn} SET ${scalar} (own scalar)` });
            cases.push({ query: `UPDATE ${fqn} SET ${ghostName(own, fks)} = 1`, valid: false, category: 'write-invalid', why: `UPDATE ${fqn} SET ghost (flagged)` });
        }
        for (const fk of fks) {
            cases.push({ query: `UPDATE ${fqn} SET ${fk} = 1`, valid: true, category: 'write-valid', why: `UPDATE ${fqn} SET ${fk} (fk)` });
        }
    }
    return cases;
}

/**
 * The write battery: canonical write shapes (constant) + per-entity write sweep.
 * @param {Map<string, TruthEntity>} truth
 * @returns {BatteryCase[]}
 */
function buildWriteBattery(truth) {
    const rep = pickRepresentative(truth);
    const shapes = rep ? buildWriteShapeBattery(rep) : [];
    return [...shapes, ...buildWriteSweep(truth)];
}

/**
 * @typedef {object} CompletionCase
 * @property {string} query    the (possibly partial) CQL text
 * @property {number} cursor   cursor byte offset into `query`
 * @property {'field' | 'entity' | 'keyword'} kind  the completion-item kind under test
 * @property {string[]} [mustInclude]  labels that MUST be offered (subset check)
 * @property {'field-subset-of-model'} [fieldRule]  if set, every offered field label must be a real model element
 * @property {string} [prefix]
 * @property {string} why
 */

/**
 * The completion battery drives `getSuggestions(query, cursor)` across the
 * distinct cursor positions the validate battery can't reach (completions need a
 * cursor offset, not a full query): statement-keyword start, FROM-source
 * entities, write target/body keyword clauses, mid-token entity retry, and
 * expand-scoped field completions. Built off the representative entity so the
 * expected labels are model-derived.
 * @param {Map<string, TruthEntity>} truth
 * @returns {CompletionCase[]}
 */
function buildCompletionBattery(truth) {
    const rep = pickRepresentative(truth);
    if (!rep) return [];
    const E = rep.fqn;
    const { assoc, targetScalar } = rep;
    const at = (q) => q.length; // cursor at end of the given text
    /** @type {CompletionCase[]} */
    const cases = [
        { query: '', cursor: 0, kind: 'keyword', mustInclude: ['SELECT'], why: 'statement keywords at empty start' },
        { query: `SELECT  FROM ${E}`, cursor: 'SELECT '.length, kind: 'field', fieldRule: 'field-subset-of-model', why: 'SELECT-list field completions' },
        { query: 'SELECT id FROM ', cursor: at('SELECT id FROM '), kind: 'entity', mustInclude: [E], why: 'FROM-source entity completions' },
        { query: `SELECT id FROM ${E} `, cursor: at(`SELECT id FROM ${E} `), kind: 'keyword', mustInclude: ['WHERE'], why: 'FROM transition keywords' },
        { query: 'DELETE ', cursor: at('DELETE '), kind: 'keyword', mustInclude: ['FROM'], why: 'DELETE target keyword' },
        { query: `DELETE FROM ${E} `, cursor: at(`DELETE FROM ${E} `), kind: 'keyword', mustInclude: ['WHERE'], why: 'DELETE body keyword' },
        { query: 'UPDATE ', cursor: at('UPDATE '), kind: 'entity', mustInclude: [E], why: 'UPDATE target entities' },
        { query: `UPDATE ${E} `, cursor: at(`UPDATE ${E} `), kind: 'keyword', mustInclude: ['SET'], why: 'UPDATE body keyword (!hasSet)' },
        { query: `UPDATE ${E} SET `, cursor: at(`UPDATE ${E} SET `), kind: 'field', fieldRule: 'field-subset-of-model', why: 'UPDATE SET field completions' },
        { query: 'INSERT ', cursor: at('INSERT '), kind: 'keyword', mustInclude: ['INTO'], why: 'INSERT target keyword' },
        {
            query: `SELECT FROM ${E} { ${assoc} {  } }`,
            cursor: `SELECT FROM ${E} { ${assoc} { `.length,
            kind: 'field',
            fieldRule: 'field-subset-of-model',
            mustInclude: [targetScalar],
            why: 'expand-scoped field completions',
        },
    ];
    return cases;
}

module.exports = {
    deriveTruth,
    buildBattery,
    buildWriteBattery,
    buildCompletionBattery,
    pickRepresentative,
    ghostEntityName,
};
