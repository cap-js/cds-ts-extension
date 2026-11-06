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
 * @property {'own' | 'fk' | 'assoc-path' | 'invalid'} category  case category (for per-category anti-rot floors)
 * @property {string} why         short label for diagnostics
 */

/**
 * Generate a diff battery from the truth model: for every entity, a valid query
 * per own-element, per synthesized FK, and per single-hop association-path
 * terminal element, plus a known-invalid ghost ref. Every valid reference is
 * emitted (no sampling) so a regression in any one is caught; cases are tagged
 * by category so the caller can enforce that each category is non-empty.
 * @param {Map<string, TruthEntity>} truth
 * @returns {BatteryCase[]}
 */
function buildBattery(truth) {
    /** @type {BatteryCase[]} */
    const cases = [];
    for (const { fqn, own, fks, assocs } of truth.values()) {
        for (const col of own) {
            // Associations are not scalar columns; a bare assoc ref is a separate concern.
            if (assocs.has(col)) continue;
            cases.push({ query: `SELECT ${col} FROM ${fqn}`, valid: true, category: 'own', why: `${fqn}.${col} (own)` });
        }
        for (const fk of fks) {
            cases.push({ query: `SELECT ${fk} FROM ${fqn}`, valid: true, category: 'fk', why: `${fqn}.${fk} (fk)` });
        }
        for (const [assoc, target] of assocs) {
            const targetEntity = truth.get(target);
            if (!targetEntity) continue;
            // Every terminal scalar element of the association target — not just the
            // first — so a regression affecting any later element is caught.
            for (const tcol of targetEntity.own) {
                if (targetEntity.assocs.has(tcol)) continue;
                cases.push({ query: `SELECT ${assoc}.${tcol} FROM ${fqn}`, valid: true, category: 'assoc-path', why: `${fqn}.${assoc}.${tcol} (assoc-path)` });
            }
        }
        // A ghost column that is provably absent from every legitimate reference.
        const ghost = ghostName(own, fks);
        cases.push({ query: `SELECT ${ghost} FROM ${fqn}`, valid: false, category: 'invalid', why: `${fqn}.${ghost} (ghost → must be flagged)` });
    }
    return cases;
}

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

module.exports = { deriveTruth, buildBattery };
