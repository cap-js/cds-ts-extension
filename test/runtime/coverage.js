'use strict';
/**
 * V8-coverage helper for the differential ratchet (see test-runtime.js).
 *
 * The differential battery is run in a child process under `NODE_V8_COVERAGE`
 * (see coverage-runner.js); this module parses the emitted JSON and reports how
 * much of `src/cql/endpoints.js` the battery actually reached. That number is
 * the ratchet's guarantee: a committed floor that only moves up, so a code path
 * silently losing its model-derived case shows up as a coverage drop instead of
 * hiding behind a still-green (but assumption-mirroring) unit test.
 *
 * Why a child process: V8 block coverage flushes on clean process exit, and
 * enabling `NODE_V8_COVERAGE` for the test runner itself would fold the harness,
 * the ~230ms CSN compile, and node:test's own code into the measured surface.
 * Measuring a dedicated child that calls only the two public validator entry
 * points keeps the measured surface exactly the validator.
 *
 * Coverage model (verified against Node 24 output):
 *   - Each JSON file holds `result: [{ url, functions: [{ functionName,
 *     ranges: [{ startOffset, endOffset, count }] }] }]`. Offsets are byte
 *     offsets into the source; `count` is a block hit count.
 *   - A single `node` invocation can emit MORE THAN ONE file (an inspector
 *     child writes its own). Only some contain `endpoints.js`; the rest must be
 *     ignored, and same-url entries merged by summing counts.
 *   - `endpoints.js` yields 24 "functions": 12 named + 12 empty-name closures
 *     (arrow callbacks like `inSkippedParen`), PLUS one module-level whole-file
 *     span `{ startOffset: 0, endOffset: <eof>, count: 1 }`. That whole-file
 *     span is always covered and must be excluded from the denominator; the
 *     empty-name CLOSURES are real code and are kept.
 *
 * Pure + dependency-free, and it never `require`s endpoints.js (it reads the
 * source as text), so measuring never contaminates the measured surface.
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * @typedef {object} V8Range
 * @property {number} startOffset
 * @property {number} endOffset
 * @property {number} count
 */
/**
 * @typedef {object} V8Function
 * @property {string} functionName
 * @property {V8Range[]} ranges
 */
/** @typedef {{ functions: V8Function[] }} ScriptCoverage */
/** @typedef {{ fn?: string, startLine: number, endLine: number, reason: string }} Exclusion */

/**
 * Scan every `*.json` in `covDir`, keep only the `result[]` entries whose `url`
 * is `absFile`, and merge them into one `{ functions }` by summing the counts of
 * byte-identical ranges. Merging neutralizes the multi-file emit: a stray
 * inspector file contributes no matching entry (or only zero-count ranges), so
 * it can never lower a count. Returns `null` when no file mentions `absFile` —
 * the caller treats that as a hard failure, never a silent empty-coverage pass.
 *
 * @param {string} covDir   directory NODE_V8_COVERAGE wrote to
 * @param {string} absFile  absolute path of the source file of interest
 * @returns {ScriptCoverage | null}
 */
function loadMergedScriptCoverage(covDir, absFile) {
    // Build the expected file:// URL the platform-correct way (file:///C:/… on
    // Windows, URL-escaped spaces, etc.) rather than string-concatenating.
    const fileUrl = pathToFileURL(absFile).href;
    // Suffix fallback for macOS /private symlink normalization: compare the
    // trailing path segments on the URL form so it is slash-consistent across
    // platforms (V8 URLs always use forward slashes).
    const urlSuffix = fileUrl.slice(fileUrl.indexOf('://') + 2);
    /** @type {Map<string, V8Range>} key `start:end` -> merged range */
    const merged = new Map();
    let matched = false;
    for (const name of fs.readdirSync(covDir)) {
        if (!name.endsWith('.json')) continue;
        /** @type {any} */
        let json;
        try {
            json = JSON.parse(fs.readFileSync(path.join(covDir, name), 'utf8'));
        } catch {
            continue; // a half-written file is not our concern; skip it
        }
        for (const script of json.result ?? []) {
            // Exact URL match, or a suffix match on the URL form (handles the
            // /private symlink prefix on macOS) — both slash-consistent.
            if (script.url !== fileUrl && !String(script.url).endsWith(urlSuffix)) continue;
            matched = true;
            for (const fn of script.functions ?? []) {
                for (const r of fn.ranges ?? []) {
                    const key = `${r.startOffset}:${r.endOffset}`;
                    const prev = merged.get(key);
                    if (prev) prev.count += r.count;
                    else merged.set(key, { startOffset: r.startOffset, endOffset: r.endOffset, count: r.count });
                }
            }
        }
    }
    if (!matched) return null;
    // Re-shape into a single synthetic function; range identity is all the
    // coverage computation needs (per-function grouping is irrelevant once the
    // whole-file span is excluded by size).
    return { functions: [{ functionName: '', ranges: [...merged.values()] }] };
}

/**
 * Byte offset of the first character of each 1-based line. `index[1]` is line 1;
 * `index[0]` is unused. Used to resolve exclusion line ranges to byte windows
 * and to report uncovered ranges back as line numbers.
 * @param {string} sourceText
 * @returns {number[]}
 */
function buildLineOffsetIndex(sourceText) {
    const index = [0, 0];
    for (let i = 0; i < sourceText.length; i++) {
        if (sourceText[i] === '\n') index.push(i + 1);
    }
    return index;
}

/** Byte offset → 1-based line number (binary search over the line index). */
function offsetToLine(lineIndex, offset) {
    let lo = 1;
    let hi = lineIndex.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineIndex[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/**
 * Compute `endpoints.js` block coverage from merged V8 ranges.
 *
 * Denominator rule (verified against Node 24): count every range EXCEPT the
 * single module-level whole-file span (`startOffset === 0` spanning essentially
 * the whole file). Then drop any range fully contained inside an excluded
 * line-window from BOTH the numerator and denominator — those are the Class-C
 * defensive/unreachable guards that no honest model-derived case can reach, so
 * counting them would just invite contrived input. Fully-contained only: a range
 * merely overlapping an excluded window is kept, so exclusions never over-reach.
 *
 * @param {ScriptCoverage} scriptCov
 * @param {string} sourceText        contents of endpoints.js
 * @param {Exclusion[]} exclusions
 * @returns {{ covered: number, total: number, pct: number, uncovered: Array<{ startLine: number, endLine: number, snippet: string }> }}
 */
function computeEndpointsCoverage(scriptCov, sourceText, exclusions) {
    const lineIndex = buildLineOffsetIndex(sourceText);
    const eof = sourceText.length;
    // Resolve exclusion line ranges to byte windows [winStart, winEnd).
    const windows = (exclusions ?? []).map((e) => ({
        start: lineIndex[e.startLine] ?? 0,
        end: e.endLine + 1 < lineIndex.length ? lineIndex[e.endLine + 1] : eof,
    }));
    const inExcluded = (r) => windows.some((w) => r.startOffset >= w.start && r.endOffset <= w.end);
    const isWholeFileSpan = (r) => r.startOffset === 0 && r.endOffset >= eof - 1;

    const ranges = scriptCov.functions.flatMap((f) => f.ranges);
    let covered = 0;
    let total = 0;
    /** @type {Array<{ startLine: number, endLine: number, snippet: string }>} */
    const uncovered = [];
    const lines = sourceText.split('\n');
    for (const r of ranges) {
        if (isWholeFileSpan(r)) continue;
        if (inExcluded(r)) continue;
        total++;
        if (r.count > 0) {
            covered++;
        } else {
            const startLine = offsetToLine(lineIndex, r.startOffset);
            const endLine = offsetToLine(lineIndex, Math.max(r.startOffset, r.endOffset - 1));
            uncovered.push({ startLine, endLine, snippet: (lines[startLine - 1] ?? '').trim().slice(0, 80) });
        }
    }
    uncovered.sort((a, b) => a.startLine - b.startLine);
    return { covered, total, pct: total ? (covered / total) * 100 : 0, uncovered };
}

module.exports = { loadMergedScriptCoverage, buildLineOffsetIndex, computeEndpointsCoverage };
