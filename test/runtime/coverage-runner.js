'use strict';
/**
 * Coverage-ratchet child runner.
 *
 * Spawned by the ratchet test (test-runtime.js) with `NODE_V8_COVERAGE` set, so
 * the V8 coverage it flushes on exit reflects ONLY the validator surface reached
 * by the model-derived batteries — nothing from the test harness. It compiles
 * the fixture, derives the truth model, builds every battery, and drives each
 * case through exactly the two public endpoints under measurement
 * (`validateCqlQuery`, `getSuggestions`). Validator output is intentionally
 * ignored here — correctness is asserted by the in-process agreement tests; this
 * process exists purely to exercise code paths for coverage.
 *
 * Contract with the parent:
 *   - On success: print a one-line JSON manifest `{ "cases": N }` to stdout and
 *     exit 0 (a clean exit is what flushes V8 block coverage). The manifest is
 *     the honest replacement for the old `battery.length >= 20` floor — it lets
 *     the parent assert the runner actually did work.
 *   - On any error: print to stderr and exit 1, so a broken runner fails the
 *     ratchet loudly instead of producing empty coverage that reads as a pass.
 */

const path = require('node:path');

const { compileFlavors } = require('./oracle');
const { deriveTruth, buildBattery, buildWriteBattery, buildCompletionBattery } = require('./differential');
const { validateCqlQuery, getSuggestions } = require('../../src/cql/endpoints');

const FIXTURE_ROOT = path.join(__dirname, '..', 'data', 'runtimeModel');

async function main() {
    const flavors = await compileFlavors(FIXTURE_ROOT);
    const defs = flavors.raw.definitions;
    const truth = deriveTruth(flavors);

    const validateCases = [...buildBattery(truth), ...buildWriteBattery(truth)];
    for (const { query } of validateCases) validateCqlQuery(query, defs, undefined);

    // Completion battery is additive (Phase 3c); tolerate its absence so the
    // runner can seed the baseline from the pre-completion battery first.
    const completionCases = typeof buildCompletionBattery === 'function' ? buildCompletionBattery(truth) : [];
    for (const { query, cursor, prefix } of completionCases) getSuggestions(query, cursor, defs, prefix);

    process.stdout.write(`${JSON.stringify({ cases: validateCases.length + completionCases.length })}\n`);
    // Force a clean exit so V8 flushes block coverage to NODE_V8_COVERAGE.
    process.exit(0);
}

main().catch((err) => {
    process.stderr.write(`coverage-runner failed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
});
