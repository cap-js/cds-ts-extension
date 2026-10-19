'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const TS = require('typescript');

const { rewriteSnapshot } = require('../src/CqlTypeRewriter');
const { getCqlHover } = require('../src/CqlHover');
/** @typedef {import('../src/QueryContext').RunWorker} RunWorker */
/** @typedef {import('../src/QueryContext').RunBatchWorker} RunBatchWorker */

// ---------------------------------------------------------------------------
// Helpers shared with index.ts (copied here to avoid importing plugin entry)
// ---------------------------------------------------------------------------

function filterClassifications(
    base,
    ranges,
    origLength,
) {
    const out = [];
    for (let i = 0; i < base.spans.length; i += 3) {
        const tokStart = base.spans[i];
        if (tokStart >= origLength) continue;
        if (ranges?.some((r) => tokStart >= r.start && tokStart < r.end))
            continue;
        out.push(tokStart, base.spans[i + 1], base.spans[i + 2]);
    }
    return { spans: out, endOfLineState: base.endOfLineState };
}

/**
 * Models the live buffer B as a single splice of the stale source A (mirrors
 * computeStaleEdit in index.ts): unchanged prefix, replaced middle, shifted suffix.
 */
function staleEditOf(
    a,
    b,
) {
    const min = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < min && a[prefix] === b[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < min - prefix &&
        a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
    )
        suffix++;
    return {
        prefix,
        staleSuffixStart: a.length - suffix,
        delta: b.length - a.length,
    };
}

/**
 * Reprojects raw semantic spans from the stale rewrite's coordinate system onto the
 * live buffer, applying the same range/tail filters as filterSemanticClassifications
 * in index.ts. Returns spans in live-buffer coordinates.
 */
function reprojectClassifications(
    base,
    ranges,
    origLength,
    staleEdit,
) {
    const out = [];
    for (let i = 0; i < base.spans.length; i += 3) {
        const tokStart = base.spans[i];
        if (tokStart >= origLength) continue;
        if (ranges?.some((r) => tokStart >= r.start && tokStart < r.end))
            continue;
        let projected = tokStart;
        if (staleEdit) {
            if (tokStart >= staleEdit.staleSuffixStart)
                projected = tokStart + staleEdit.delta;
            else if (tokStart >= staleEdit.prefix) continue;
        }
        out.push(projected, base.spans[i + 1], base.spans[i + 2]);
    }
    return { spans: out, endOfLineState: base.endOfLineState };
}

// ---------------------------------------------------------------------------
// Test infrastructure: build a LanguageService with a rewriting snapshot
// ---------------------------------------------------------------------------

const NO_LOGGER = {
    close() {},
    hasLevel() {
        return false;
    },
    loggingEnabled() {
        return false;
    },
    perftrc() {},
    info() {},
    startGroup() {},
    endGroup() {},
    msg() {},
    getLogFileName() {
        return undefined;
    },
};

const fieldsWorker =
    (fields) =>
    (_args, _logger) => ({
        completions: fields.map((f) => ({ ...f, kind: 'field' })),
    });

const fieldsBatchWorker =
    (
        fields,
    ) =>
    (_root, probes, _logger) => ({
        fields: Object.fromEntries(
            probes.map((p) => [
                p.entity,
                fields.map((f) => ({ ...f, kind: 'field' })),
            ]),
        ),
    });

/**
 * Batch worker that returns different fields per entity.
 * entityMap: { [entityName]: fields[] }. Entities not in map get empty fields.
 */
const perEntityBatchWorker =
    (
        entityMap,
    ) =>
    (_root, probes, _logger) => ({
        fields: Object.fromEntries(
            probes.map((p) => [
                p.entity,
                (entityMap[p.entity] ?? []).map((f) => ({
                    ...f,
                    kind: 'field',
                })),
            ]),
        ),
    });

/**
 * Builds a ts.LanguageService whose snapshot for `fileName` is the rewritten
 * version of `sourceText`.  Returns both the service and the rewritten ranges
 * so classification tests can apply the filter.
 */
function makeLs(
    fileName,
    sourceText,
    worker,
    batchWorker,
) {
    const origSource = new Map();
    const rewriteCache = new Map();
    const rwRangesMap = new Map();
    const emptyBatch = (_r, _p, _l) => ({ fields: {} });

    const rewritten = rewriteSnapshot(
        fileName,
        sourceText,
        TS,
        origSource,
        rewriteCache,
        worker,
        batchWorker ?? emptyBatch,
        NO_LOGGER,
        '/proj',
        undefined,
        rwRangesMap,
    );
    const rewrittenRanges = rwRangesMap.get(fileName) ?? [];

    const host = {
        getCompilationSettings: () => ({
            strict: true,
            target: TS.ScriptTarget.ES2020,
            module: TS.ModuleKind.ESNext,
            lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
            allowJs: true,
        }),
        getScriptFileNames: () => [fileName],
        getScriptVersion: () => '1',
        getScriptSnapshot: (f) => {
            if (f === fileName) return TS.ScriptSnapshot.fromString(rewritten);
            // serve lib files from the TS installation
            try {
                const { readFileSync } =
                    require('node:fs');
                const content = readFileSync(f, 'utf8');
                return TS.ScriptSnapshot.fromString(content);
            } catch {
                return undefined;
            }
        },
        getCurrentDirectory: () => '/proj',
        getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
        fileExists: (f) => {
            if (f === fileName) return true;
            try {
                const { existsSync } =
                    require('node:fs');
                return existsSync(f);
            } catch {
                return false;
            }
        },
        readFile: (f) => {
            try {
                const { readFileSync } =
                    require('node:fs');
                return readFileSync(f, 'utf8');
            } catch {
                return undefined;
            }
        },
        readDirectory: () => [],
    };

    const ls = TS.createLanguageService(host, TS.createDocumentRegistry());

    // LS backed by the original source — used for syntactic classifications,
    // mirroring the withOriginalSnapshot swap in index.ts.
    const origHost = {
        ...host,
        getScriptSnapshot: (f) => {
            if (f === fileName) return TS.ScriptSnapshot.fromString(sourceText);
            return host.getScriptSnapshot(f);
        },
    };
    const lsOrig = TS.createLanguageService(
        origHost,
        TS.createDocumentRegistry(),
    );

    return { ls, lsOrig, rewritten, rewrittenRanges, origText: sourceText };
}

/** Returns byte offset of the first occurrence of `needle` in `src`. */
function posOf(src, needle) {
    const idx = src.indexOf(needle);
    assert.ok(idx !== -1, `"${needle}" not found in source`);
    return idx;
}

// ---------------------------------------------------------------------------
// Semantic diagnostics
// ---------------------------------------------------------------------------

describe('LS integration — semantic diagnostics', () => {
    it('no TS errors in rewritten awaited TS file', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const diags = ls
            .getSemanticDiagnostics('test.ts')
            // ignore "cannot find name 'cds'" and lib-related noise
            .filter(
                (d) => ![2304, 2503, 2580, 2583, 2584, 1378].includes(d.code),
            );
        assert.deepEqual(
            diags.map((d) => d.code),
            [],
            'unexpected TS errors: ' +
                diags
                    .map(
                        (d) =>
                            `${d.code}: ${
                                typeof d.messageText === 'string'
                                    ? d.messageText
                                    : d.messageText.messageText
                            }`,
                    )
                    .join('; '),
        );
    });

    it('no TS errors in rewritten non-awaited TS file', () => {
        const src =
            'const result = cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const diags = ls
            .getSemanticDiagnostics('test.ts')
            .filter((d) => ![2304, 2503, 2580, 2583, 2584].includes(d.code));
        assert.deepEqual(
            diags.map((d) => d.code),
            [],
        );
    });

    it('no error 2454 (variable used before assigned)', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nconsole.log(result);\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const codes = ls.getSemanticDiagnostics('test.ts').map((d) => d.code);
        assert.ok(
            !codes.includes(2454),
            'must not have error 2454 (used before assigned)',
        );
    });

    it('no error 2322 (type not assignable)', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const codes = ls.getSemanticDiagnostics('test.ts').map((d) => d.code);
        assert.ok(
            !codes.includes(2322),
            'must not have error 2322 (type not assignable)',
        );
    });

    it('no error 1155 (const must be initialized)', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const codes = ls.getSemanticDiagnostics('test.ts').map((d) => d.code);
        assert.ok(
            !codes.includes(1155),
            'must not have error 1155 (const must be initialized)',
        );
    });
});

// ---------------------------------------------------------------------------
// Hover (getQuickInfoAtPosition)
// ---------------------------------------------------------------------------

describe('LS integration — hover', () => {
    it('hovering over result variable shows inferred array type (awaited)', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const pos = posOf(src, 'result');
        const info = ls.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info on result variable');
        const text = info.displayParts?.map((p) => p.text).join('') ?? '';
        // Should show the inferred array type, not "var undefined"
        assert.ok(
            !(text.includes('undefined') || text.includes('var undefined')),
            'hover must not show "undefined": ' + text,
        );
        assert.ok(
            text.includes('ID') ||
                text.includes('string') ||
                text.includes('_q'),
            'hover must reference the inferred type: ' + text,
        );
    });

    it('hovering over result variable shows Promise type (non-awaited)', () => {
        const src =
            'const result = cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const pos = posOf(src, 'result');
        const info = ls.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info on result variable');
        const text = info.displayParts?.map((p) => p.text).join('') ?? '';
        assert.ok(
            !(text.includes('undefined') || text.includes('var undefined')),
            'hover must not show "undefined": ' + text,
        );
    });

    it('hovering over cds.ql does not show "var undefined"', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        // Position on "ql" (the property name)
        const pos = posOf(src, '.ql') + 1;
        const info = ls.getQuickInfoAtPosition('test.ts', pos);
        // If there is hover info, it must not say "var undefined"
        if (info) {
            const text = info.displayParts?.map((p) => p.text).join('') ?? '';
            assert.ok(
                !text.includes('var undefined'),
                'hover over cds.ql must not show "var undefined", got: ' + text,
            );
        }
        // If no info: also fine — cds is not imported so TS may not resolve it
    });

    it('hovering over query keyword inside template returns no info (not a TS identifier)', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        // Position on "SELECT" — inside the template, rewritten to spaces/cast
        const pos = posOf(src, 'SELECT');
        const info = ls.getQuickInfoAtPosition('test.ts', pos);
        // TS should not produce hover info pointing to the _q alias for query keywords
        if (info) {
            const text = info.displayParts?.map((p) => p.text).join('') ?? '';
            assert.ok(
                !text.includes('_q'),
                'hover over SELECT must not expose alias internals, got: ' +
                    text,
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Token classification — no bleed over original source
// ---------------------------------------------------------------------------
//
// "Token bleed" regression suite.
//
// INVARIANT (must hold after every change to rewriteSnapshot / filterClassifications):
//   For every [start, length, kind] triple returned by getEncodedSyntacticClassifications
//   or getEncodedSemanticClassifications (after applying filterClassifications), if
//   `start` falls within the original source length then orig[start] === rewritten[start].
//
// A violation means VS Code will paint incorrect syntax colouring over a position
// in the file that the user is actually looking at.
//
// The suite covers every assignment shape the rewriter handles:
//   - non-awaited / awaited
//   - destructured array binding ([x] = ...)
//   - multiple templates in one file
//   - JOIN query (multiple FROM sources)
//   - @cds-service annotation
//   - multi-line template body
//   - identity rewrite (no worker fields → source unchanged)
//   - JS file (JSDoc strategy, not TS cast)
//
// It also covers the debounce-consistency invariant:
//   After a debounce timer fires and rewrittenRanges is updated, the ranges
//   must still be consistent with the snapshot that will be returned on the
//   next getSnapshot call.

describe('LS integration — classification token bleed', () => {
    /**
     * Core assertion: given a source string and its rewritten counterpart plus
     * the recorded rewritten ranges, verify that no token returned by either
     * classification API (after filtering) bleeds onto a position where the
     * original and rewritten bytes differ.
     */
    function assertNoBleed(
        label,
        src,
        worker,
        batch,
        fileName = 'test.ts',
    ) {
        const {
            ls,
            lsOrig,
            rewritten: rw,
            rewrittenRanges: ranges,
            origText,
        } = makeLs(fileName, src, worker, batch);

        const span = { start: 0, length: rw.length };

        // Syntactic: use original-source LS (mirrors withOriginalSnapshot in index.ts)
        const syntactic = lsOrig.getEncodedSyntacticClassifications(fileName, {
            start: 0,
            length: origText.length,
        });

        // Semantic: use rewritten LS with filter (type-aware, needs rewritten source)
        const semantic = filterClassifications(
            ls.getEncodedSemanticClassifications(
                fileName,
                span,
                TS.SemanticClassificationFormat.TwentyTwenty,
            ),
            ranges,
            origText.length,
        );

        // Syntactic tokens come from lsOrig (original source view) — check bounds only.
        for (let i = 0; i < syntactic.spans.length; i += 3) {
            const tokStart = syntactic.spans[i];
            assert.ok(
                tokStart < origText.length,
                `${label} [syntactic] token at [${tokStart}] is out of bounds (origLength=${origText.length})`,
            );
        }

        // Semantic tokens come from the rewritten LS with filter — positions outside
        // the rewritten range must be identical in both sources (no bleed).
        for (let i = 0; i < semantic.spans.length; i += 3) {
            const tokStart = semantic.spans[i];
            assert.equal(
                rw[tokStart],
                origText[tokStart],
                `${label} [semantic] token at [${tokStart}] bleeds onto original source — ` +
                    `orig[${tokStart}]=${JSON.stringify(origText[tokStart])} ` +
                    `rw[${tokStart}]=${JSON.stringify(rw[tokStart])} ` +
                    `context: ${JSON.stringify(origText.slice(Math.max(0, tokStart - 10), tokStart + 15))}`,
            );
        }
    }

    /** Also asserts that at least one rewritten range exists (i.e. a rewrite actually happened). */
    function assertRewrittenAndNoBleed(
        label,
        src,
        worker,
        batch,
        fileName = 'test.ts',
    ) {
        const origSource = new Map();
        const rewriteCache = new Map();
        const rwRangesMap = new Map();
        const noLog = {
            info: () => {},
            perftrc: () => {},
            close: () => {},
            hasLevel: () => false,
            loggingEnabled: () => false,
            startGroup: () => {},
            endGroup: () => {},
            msg: () => {},
            getLogFileName: () => undefined,
        };
        rewriteSnapshot(
            fileName,
            src,
            TS,
            origSource,
            rewriteCache,
            worker,
            batch,
            noLog,
            '/proj',
            undefined,
            rwRangesMap,
        );
        const ranges = rwRangesMap.get(fileName) ?? [];
        assert.ok(
            ranges.length > 0,
            `${label}: expected at least one rewritten range — rewrite may not have produced any replacements`,
        );
        assertNoBleed(label, src, worker, batch, fileName);
    }

    // Shared workers
    const worker = fieldsWorker([
        { label: 'ID', detail: 'cds.UUID' },
        { label: 'title', detail: 'cds.String' },
    ]);
    const batch = fieldsBatchWorker([
        { label: 'ID', detail: 'cds.UUID' },
        { label: 'title', detail: 'cds.String' },
    ]);

    // ── Shape: non-awaited ────────────────────────────────────────────────────

    it('non-awaited: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'non-awaited',
            'const result = cds.ql`SELECT ID FROM Books                         `;\nexport {};',
            worker,
            batch,
        );
    });

    // ── Shape: awaited ────────────────────────────────────────────────────────

    it('awaited: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'awaited',
            'const result = await cds.ql`SELECT ID FROM Books                   `;\nexport {};',
            worker,
            batch,
        );
    });

    // ── Shape: destructured array (non-awaited) ───────────────────────────────

    it('destructured array non-awaited: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'destructured-non-awaited',
            'const [first] = cds.ql`SELECT ID FROM Books                        `;\nexport {};',
            worker,
            batch,
        );
    });

    // ── Shape: destructured array (awaited) ──────────────────────────────────

    it('destructured array awaited: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'destructured-awaited',
            'const [first] = await cds.ql`SELECT ID FROM Books                  `;\nexport {};',
            worker,
            batch,
        );
    });

    // ── Shape: multiple templates in one file ─────────────────────────────────

    it('multiple templates in one file: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'multi-template',
            [
                'const a = await cds.ql`SELECT ID FROM Books                    `;',
                'const b = cds.ql`SELECT ID FROM Authors                        `;',
                'export {};',
            ].join('\n'),
            worker,
            batch,
        );
    });

    // ── Shape: JOIN query ─────────────────────────────────────────────────────

    it('JOIN query: no token bleed', () => {
        const joinBatch = fieldsBatchWorker([
            { label: 'ID', detail: 'cds.UUID' },
        ]);
        assertRewrittenAndNoBleed(
            'join',
            'const r = await cds.ql`SELECT b.ID FROM Books b JOIN Authors a ON b.ID = a.ID  `;\nexport {};',
            worker,
            joinBatch,
        );
    });

    // ── Shape: @cds-service annotation ───────────────────────────────────────

    it('@cds-service annotation: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'annotated',
            '// @cds-service MySvc\nconst r = await cds.ql`SELECT ID FROM Books                      `;\nexport {};',
            worker,
            batch,
        );
    });

    // ── Shape: multi-line template body ──────────────────────────────────────

    it('multi-line template body: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'multi-line',
            [
                'const result = await cds.ql`',
                '    SELECT ID, title',
                '    FROM Books       ',
                '`;\nexport {};',
            ].join('\n'),
            worker,
            batch,
        );
    });

    it('multi-line template preceded by other assignments: no token bleed', () => {
        // Regression: rewrittenRanges previously recorded end=replaceStart+cast.length
        // instead of end=replaceEnd, so the padded tail of a multi-line template was
        // outside the range. TS tokens inside that padding bled through filterClassifications.
        assertRewrittenAndNoBleed(
            'multi-line-preceded',
            [
                'const x = await cds.ql`SELECT * FROM Books                    `;',
                '// @cds-service AdminService',
                'const [fst] = await cds.ql`SELECT * FROM Books                `;',
                'const result = await cds.ql`',
                '    SELECT',
                '        ID, title',
                '    FROM Books',
                '    WHERE ID = 42',
                '`;\nexport {};',
            ].join('\n'),
            worker,
            batch,
        );
    });

    // ── Shape: identity rewrite (no worker fields) ───────────────────────────

    it('identity rewrite (no fields): no token bleed, no ranges', () => {
        // When worker returns no fields, rewriteSnapshot returns source unchanged.
        // filterClassifications must still work cleanly (ranges will be empty).
        assertNoBleed(
            'identity',
            'const result = await cds.ql`SELECT ID FROM Books`;\nexport {};',
            fieldsWorker([]),
            fieldsBatchWorker([]),
        );
    });

    // ── Tail aliases: tokens from appended type aliases must not bleed ────────
    //
    // rewriteSnapshot appends `type _qN={...}[];` after the original source.
    // TypeScript emits classification tokens for those positions. They must be
    // suppressed by filterClassifications (origLength guard), never returned to VS Code.

    it('tail alias tokens (beyond origLength) are suppressed', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                   `;\nexport {};';
        const {
            ls,
            lsOrig,
            rewritten: rw,
            rewrittenRanges: ranges,
            origText,
        } = makeLs('test.ts', src, worker, batch);

        assert.ok(
            rw.length > src.length,
            'rewrite must produce a tail alias for this test to be meaningful',
        );

        // Syntactic: original-source LS — tail alias tokens are absent by construction
        const syntactic = lsOrig.getEncodedSyntacticClassifications('test.ts', {
            start: 0,
            length: origText.length,
        });
        // Semantic: filtered rewritten LS — tail alias tokens suppressed by origLength guard
        const semantic = filterClassifications(
            ls.getEncodedSemanticClassifications(
                'test.ts',
                { start: 0, length: rw.length },
                TS.SemanticClassificationFormat.TwentyTwenty,
            ),
            ranges,
            origText.length,
        );

        for (const [kind, result] of [
            ['syntactic', syntactic],
            ['semantic', semantic],
        ]) {
            for (let i = 0; i < result.spans.length; i += 3) {
                const tokStart = result.spans[i];
                assert.ok(
                    tokStart < origText.length,
                    `${kind} token at [${tokStart}] is beyond origLength=${origText.length} — tail alias leaked through`,
                );
            }
        }
    });

    // ── Shape: JS file (JSDoc strategy) ──────────────────────────────────────

    it('JS file: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'js-file',
            'const result = await cds.ql`SELECT ID FROM Books                   `;\n',
            worker,
            batch,
            'test.js',
        );
    });

    // ── Specific positions: "await" and "cds" must not be overwritten ─────────

    it('"await" keyword position is not overwritten by rewrite tokens', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                   `;\nexport {};';
        const {
            ls,
            lsOrig,
            rewritten: rw,
            rewrittenRanges: ranges,
            origText,
        } = makeLs('test.ts', src, worker, batch);
        const awaitPos = posOf(src, 'await');

        for (const [kind, result] of [
            [
                'syntactic',
                lsOrig.getEncodedSyntacticClassifications('test.ts', {
                    start: 0,
                    length: origText.length,
                }),
            ],
            [
                'semantic',
                filterClassifications(
                    ls.getEncodedSemanticClassifications(
                        'test.ts',
                        { start: 0, length: rw.length },
                        TS.SemanticClassificationFormat.TwentyTwenty,
                    ),
                    ranges,
                    origText.length,
                ),
            ],
        ]) {
            for (let i = 0; i < result.spans.length; i += 3) {
                const tokStart = result.spans[i];
                const tokLen = result.spans[i + 1];
                if (tokStart <= awaitPos && tokStart + tokLen > awaitPos) {
                    assert.equal(
                        rw[tokStart],
                        origText[tokStart],
                        `${kind} token at [${tokStart}] overlaps "await" but byte differs`,
                    );
                }
            }
        }
    });

    it('"cds" identifier position is not overwritten by rewrite tokens', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                   `;\nexport {};';
        const {
            ls,
            lsOrig,
            rewritten: rw,
            rewrittenRanges: ranges,
            origText,
        } = makeLs('test.ts', src, worker, batch);
        const cdsPos = posOf(src, 'cds');

        for (const [kind, result] of [
            [
                'syntactic',
                lsOrig.getEncodedSyntacticClassifications('test.ts', {
                    start: 0,
                    length: origText.length,
                }),
            ],
            [
                'semantic',
                filterClassifications(
                    ls.getEncodedSemanticClassifications(
                        'test.ts',
                        { start: 0, length: rw.length },
                        TS.SemanticClassificationFormat.TwentyTwenty,
                    ),
                    ranges,
                    origText.length,
                ),
            ],
        ]) {
            for (let i = 0; i < result.spans.length; i += 3) {
                const tokStart = result.spans[i];
                const tokLen = result.spans[i + 1];
                if (tokStart <= cdsPos && tokStart + tokLen > cdsPos) {
                    assert.equal(
                        rw[tokStart],
                        origText[tokStart],
                        `${kind} token at [${tokStart}] overlaps "cds" but byte differs`,
                    );
                }
            }
        }
    });

    // ── Debounce consistency ──────────────────────────────────────────────────
    //
    // After the debounce timer fires and rewrittenRanges is updated, the ranges
    // recorded must be consistent with the snapshot that was just written to
    // the cache — i.e. rewriteSnapshot called with the same source must produce
    // the same ranges and the same rewritten text.

    it('debounce: ranges recorded by timer callback are consistent with rewritten snapshot', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                   `;\nexport {};';

        // First pass: simulate what the timer callback does
        const origSource1 = new Map();
        const rewriteCache1 = new Map();
        const rwRangesMap1 = new Map();
        const noLog = {
            info: () => {},
            perftrc: () => {},
            close: () => {},
            hasLevel: () => false,
            loggingEnabled: () => false,
            startGroup: () => {},
            endGroup: () => {},
            msg: () => {},
            getLogFileName: () => undefined,
        };

        const rewritten1 = rewriteSnapshot(
            'debounce.ts',
            src,
            TS,
            origSource1,
            rewriteCache1,
            worker,
            batch,
            noLog,
            '/proj',
            undefined,
            rwRangesMap1,
        );
        const ranges1 = rwRangesMap1.get('debounce.ts') ?? [];

        // Second pass: same source, fresh state (simulates re-entry after another keystroke)
        const origSource2 = new Map();
        const rewriteCache2 = new Map();
        const rwRangesMap2 = new Map();

        const rewritten2 = rewriteSnapshot(
            'debounce.ts',
            src,
            TS,
            origSource2,
            rewriteCache2,
            worker,
            batch,
            noLog,
            '/proj',
            undefined,
            rwRangesMap2,
        );
        const ranges2 = rwRangesMap2.get('debounce.ts') ?? [];

        // Both passes must produce identical output — deterministic
        assert.equal(
            rewritten1,
            rewritten2,
            'rewriteSnapshot must be deterministic for the same input',
        );
        assert.deepEqual(
            ranges1,
            ranges2,
            'rewritten ranges must be deterministic for the same input',
        );

        // The ranges from pass 1 must be consistent with the rewritten snapshot from pass 1
        for (const { start, end } of ranges1) {
            assert.ok(
                start >= 0 && end <= rewritten1.length,
                `range [${start},${end}] is out of bounds for rewritten snapshot length ${rewritten1.length}`,
            );
            // The byte immediately before the range must match in orig and rewritten (boundary check)
            if (start > 0) {
                assert.equal(
                    rewritten1[start - 1],
                    src[start - 1],
                    `byte just before rewritten range [${start},${end}] must be unchanged`,
                );
            }
        }

        // Now verify the ranges actually filter out all bleed from the rewritten snapshot
        const host = {
            getCompilationSettings: () => ({
                strict: true,
                target: TS.ScriptTarget.ES2020,
                module: TS.ModuleKind.ESNext,
            }),
            getScriptFileNames: () => ['debounce.ts'],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) =>
                f === 'debounce.ts'
                    ? TS.ScriptSnapshot.fromString(rewritten1)
                    : undefined,
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === 'debounce.ts',
            readFile: (f) => {
                try {
                    return require('node:fs').readFileSync(f, 'utf8');
                } catch {
                    return undefined;
                }
            },
            readDirectory: () => [],
        };
        const lsDebounce = TS.createLanguageService(
            host,
            TS.createDocumentRegistry(),
        );
        const span = { start: 0, length: rewritten1.length };

        for (const [kind, result] of [
            [
                'syntactic',
                filterClassifications(
                    lsDebounce.getEncodedSyntacticClassifications(
                        'debounce.ts',
                        span,
                    ),
                    ranges1,
                    src.length,
                ),
            ],
            [
                'semantic',
                filterClassifications(
                    lsDebounce.getEncodedSemanticClassifications(
                        'debounce.ts',
                        span,
                        TS.SemanticClassificationFormat.TwentyTwenty,
                    ),
                    ranges1,
                    src.length,
                ),
            ],
        ]) {
            for (let i = 0; i < result.spans.length; i += 3) {
                const tokStart = result.spans[i];
                assert.equal(
                    rewritten1[tokStart],
                    src[tokStart],
                    `debounce [${kind}] token at [${tokStart}] bleeds after timer callback ` +
                        '— ranges are stale or filter is incomplete',
                );
            }
        }
    });

    it('postfix projection single-line: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'postfix-single-line',
            'const result = await cds.ql`SELECT FROM Books { ID, title }       `;\nexport {};',
            worker,
            batch,
        );
    });

    // ── Root cause #1: debounce desync ────────────────────────────────────────
    //
    // While the user types, doRewrite() (index.ts) takes the DEBOUNCE branch: it
    // returns the rewrite computed for the PREVIOUS source (`lastRewritten`) and
    // only schedules a fresh rewrite `debounceMs` later. The recorded
    // `rewrittenRanges` still describe the OLD template span, and the classified
    // snapshot is the OLD rewrite — while the editor buffer is already the new B.
    //
    // The production code reprojects the stale semantic tokens onto B's coordinate
    // system (prefix unchanged, suffix shifted by the edit delta, edited region
    // dropped) so colour stays PUT instead of vanishing/smearing. This helper
    // asserts two properties across that edit boundary:
    //   1. no bleed  — every emitted token maps onto the SAME character in B.
    //   2. stability — every token a fresh self-consistent rewrite of B would emit
    //      OUTSIDE the edited region is present at the same live position in `projected`,
    //      so the colours don't flash off while the debounce catches up).

    function assertSmoothAcrossEdit(
        label,
        srcA,
        srcB,
        worker,
        batch,
        fileName = 'debounce.ts',
    ) {
        function hostFor(text) {
            return {
                getCompilationSettings: () => ({
                    strict: true,
                    target: TS.ScriptTarget.ES2020,
                    module: TS.ModuleKind.ESNext,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) =>
                    f === fileName
                        ? TS.ScriptSnapshot.fromString(text)
                        : undefined,
                getCurrentDirectory: () => '/proj',
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === fileName,
                readFile: (f) => {
                    try {
                        return require('node:fs').readFileSync(f, 'utf8');
                    } catch {
                        return undefined;
                    }
                },
                readDirectory: () => [],
            };
        }

        // Rewrite A → the stale rewrite + stale ranges the debounce branch holds
        // while B is being typed.
        const staleRewrite = rewriteSnapshot(
            fileName,
            srcA,
            TS,
            new Map(),
            new Map(),
            worker,
            batch,
            NO_LOGGER,
            '/proj',
            undefined,
            (() => {
                const m = new Map();
                assertSmoothAcrossEdit._m = m;
                return m;
            })(),
        );
        const staleRanges =
            (assertSmoothAcrossEdit._m.get(fileName)) ?? [];
        assert.ok(
            staleRanges.length > 0,
            `${label}: rewrite of A must produce ranges`,
        );

        const staleEdit = staleEditOf(srcA, srcB);
        const lsStale = TS.createLanguageService(
            hostFor(staleRewrite),
            TS.createDocumentRegistry(),
        );
        const lsLiveB = TS.createLanguageService(
            hostFor(srcB),
            TS.createDocumentRegistry(),
        );

        // Syntactic path in production classifies the LIVE original buffer (B).
        const syntactic = lsLiveB.getEncodedSyntacticClassifications(fileName, {
            start: 0,
            length: srcB.length,
        });
        // Semantic path: classify the stale rewrite of A, then reproject onto B —
        // exactly what index.ts does until the debounce timer refreshes.
        const projected = reprojectClassifications(
            lsStale.getEncodedSemanticClassifications(
                fileName,
                { start: 0, length: staleRewrite.length },
                TS.SemanticClassificationFormat.TwentyTwenty,
            ),
            staleRanges,
            srcA.length,
            staleEdit,
        );

        // (1) No bleed: every syntactic token is in bounds; every reprojected
        //     semantic token maps onto the SAME character the user sees in B.
        for (let i = 0; i < syntactic.spans.length; i += 3) {
            const tokStart = syntactic.spans[i];
            assert.ok(
                tokStart < srcB.length,
                `${label} [syntactic] token at [${tokStart}] out of bounds for B (len=${srcB.length})`,
            );
        }
        // Build the char at each projected token by reading the ORIGINAL stale char
        // and confirming it equals B at the projected position — a bleed would break
        // this equality.
        const staleOf = new Map(); // projected → stale start
        {
            const raw = lsStale.getEncodedSemanticClassifications(
                fileName,
                { start: 0, length: staleRewrite.length },
                TS.SemanticClassificationFormat.TwentyTwenty,
            ).spans;
            for (let i = 0; i < raw.length; i += 3) {
                const s = raw[i];
                if (s >= srcA.length) continue;
                if (staleRanges.some((r) => s >= r.start && s < r.end))
                    continue;
                if (s >= staleEdit.staleSuffixStart)
                    staleOf.set(s + staleEdit.delta, s);
                else if (s < staleEdit.prefix) staleOf.set(s, s);
            }
        }
        for (let i = 0; i < projected.spans.length; i += 3) {
            const p = projected.spans[i];
            const s = staleOf.get(p);
            if (s === undefined) continue;
            assert.equal(
                srcB[p],
                staleRewrite[s],
                `${label} [semantic] reprojected token at live [${p}] bleeds — ` +
                    `B[${p}]=${JSON.stringify(srcB[p])} staleChar=${JSON.stringify(staleRewrite[s])} ` +
                    `context: ${JSON.stringify(srcB.slice(Math.max(0, p - 10), p + 15))}`,
            );
        }

        // (2) Stability: a fresh self-consistent rewrite of B (what arrives when the
        //     debounce fires) — every semantic token it emits OUTSIDE the edited
        //     region must already be present at the same live position in `projected`,
        //     so nothing flashes off then on.
        const freshRewriteB = rewriteSnapshot(
            fileName,
            srcB,
            TS,
            new Map(),
            new Map(),
            worker,
            batch,
            NO_LOGGER,
            '/proj',
            undefined,
            (() => {
                const m = new Map();
                assertSmoothAcrossEdit._mb = m;
                return m;
            })(),
        );
        const freshRangesB =
            (assertSmoothAcrossEdit._mb.get(fileName)) ?? [];
        const lsFreshB = TS.createLanguageService(
            hostFor(freshRewriteB),
            TS.createDocumentRegistry(),
        );
        const freshB = reprojectClassifications(
            lsFreshB.getEncodedSemanticClassifications(
                fileName,
                { start: 0, length: freshRewriteB.length },
                TS.SemanticClassificationFormat.TwentyTwenty,
            ),
            freshRangesB,
            srcB.length,
            null, // fresh rewrite of B is already self-consistent — no reprojection
        );
        const projectedStarts = new Set();
        for (let i = 0; i < projected.spans.length; i += 3)
            projectedStarts.add(projected.spans[i]);
        // The live edited region [prefix, prefix+newLen) is where token identity is
        // genuinely unknown during the window; stability is only required outside it.
        const editLiveEnd = staleEdit.staleSuffixStart + staleEdit.delta;
        for (let i = 0; i < freshB.spans.length; i += 3) {
            const p = freshB.spans[i];
            if (p >= staleEdit.prefix && p < editLiveEnd) continue; // inside the edit
            assert.ok(
                projectedStarts.has(p),
                `${label} [stability] token at live [${p}] present in the fresh rewrite of B ` +
                    'but MISSING during the debounce window — it would flash on when the timer fires. ' +
                    `context: ${JSON.stringify(srcB.slice(Math.max(0, p - 10), p + 15))}`,
            );
        }
    }

    function assertNoBleedAcrossEdit(
        label,
        srcA,
        srcB,
        worker,
        batch,
        fileName = 'debounce.ts',
    ) {
        assertSmoothAcrossEdit(label, srcA, srcB, worker, batch, fileName);
    }

    it('debounce desync: stale rewrite of A must not bleed onto edited source B', () => {
        // Source A and an edited source B: B inserts ", title" into the SELECT list,
        // lengthening the template so every byte after the insertion shifts. The
        // trailing `const other = r;` statement is essential: it puts a semantic
        // token (`other`, `r`) AFTER the edit point that survives the stale-range
        // filter, so a desync actually smears colour onto a shifted character.
        // (Without a post-query reference the only surviving token sits before the
        // edit and the test can't observe the bug.)
        const srcA =
            'const r = await cds.ql`SELECT ID FROM Books        `;\nconst other = r;\nexport {};';
        const srcB =
            'const r = await cds.ql`SELECT ID, title FROM Books        `;\nconst other = r;\nexport {};';
        assert.ok(
            srcB.length > srcA.length,
            'edit must lengthen the source for this test to exercise desync',
        );
        assertNoBleedAcrossEdit('debounce', srcA, srcB, worker, batch);
    });

    // ── Root cause #2: intra-line offset shift compounded across an edit ──────
    //
    // padWithNewlines preserves the newline COUNT and total byte length of a
    // rewrite, so a self-consistent snapshot never bleeds. But across an edit,
    // the stale multi-line rewrite of A is measured against the live buffer B:
    // newlines relocated for A's cast no longer line up with B's lines, so a
    // token's (line, character) coordinate resolves to a different byte on screen.

    it('multi-line template across edit: relocated newlines must not shift positions', () => {
        const srcA = [
            '// @cds-service Svc',
            'const r = await cds.ql`',
            '        SELECT ID',
            '        FROM Books',
            '`;',
            'const other = r;',
            'export {};',
        ].join('\n');
        // Edit: add a column to the SELECT line (lengthens line 2, shifts the rest).
        const srcB = [
            '// @cds-service Svc',
            'const r = await cds.ql`',
            '        SELECT ID, title',
            '        FROM Books',
            '`;',
            'const other = r;',
            'export {};',
        ].join('\n');
        assert.ok(srcB.length > srcA.length, 'edit must lengthen the source');
        assertNoBleedAcrossEdit('multi-line-edit', srcA, srcB, worker, batch);
    });

    // ── Root cause #3: substitution templates break the 1:1 offset contract ───
    //
    // extractTemplateText collapses ${...} spans into a single space, so the query
    // text no longer maps 1:1 onto source bytes. The rewrite still replaces the
    // whole template.pos → template.end span. Whatever the rewriter does, syntax
    // highlighting must never be corrupted: either offsets are preserved, or the
    // template is left as an identity rewrite. These cases lock in the no-bleed
    // invariant for templates containing ${...} substitutions, both in a
    // self-consistent snapshot and across an edit.

    it('substitution template: no token bleed', () => {
        assertNoBleed(
            'substitution',
            'const id = 1;\nconst result = await cds.ql`SELECT ID, title FROM Books WHERE ID = ${id}`;\nexport {};',
            worker,
            batch,
        );
    });

    it('multi-span substitution template: no token bleed', () => {
        assertNoBleed(
            'multi-span-substitution',
            'const a = 1;\nconst b = 2;\nconst result = await cds.ql`SELECT ID FROM Books WHERE ID = ${a} AND x = ${b}`;\nexport {};',
            worker,
            batch,
        );
    });

    it('substitution template across edit: no token bleed', () => {
        const srcA =
            'const id = 1;\nconst r = await cds.ql`SELECT ID FROM Books WHERE ID = ${id}`;\nconst other = r;\nexport {};';
        // Edit: add a column before FROM, lengthening the template.
        const srcB =
            'const id = 1;\nconst r = await cds.ql`SELECT ID, title FROM Books WHERE ID = ${id}`;\nconst other = r;\nexport {};';
        assert.ok(srcB.length > srcA.length, 'edit must lengthen the source');
        assertNoBleedAcrossEdit('substitution-edit', srcA, srcB, worker, batch);
    });

    it('postfix projection multi-line: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'postfix-multi-line',
            '// @cds-service Svc\nconst result = await cds.ql`\n    SELECT FROM Books {\n        ID,\n        title\n    }\n`;\nexport {};',
            worker,
            batch,
        );
    });

    it('expand block single-line: no token bleed', () => {
        assertRewrittenAndNoBleed(
            'expand-single-line',
            'const result = await cds.ql`SELECT FROM Books { ID, title { ID } }  `;\nexport {};',
            worker,
            batch,
        );
    });
});

// ---------------------------------------------------------------------------
// Type inference via LanguageService + program checker
// ---------------------------------------------------------------------------

describe('LS integration — type inference', () => {
    /**
     * Resolves the actual expanded type of a variable in the rewritten snapshot
     * using a ts.Program built from the same rewritten text.
     * Returns the typeToString result with NoTruncation + InTypeAlias flags so
     * the alias is fully expanded.
     */
    function resolveVarType(rewritten, varName) {
        const host = TS.createCompilerHost({});
        const origGetSf = host.getSourceFile.bind(host);
        host.getSourceFile = (n, lang) =>
            n === 'test.ts'
                ? TS.createSourceFile(
                      n,
                      rewritten,
                      lang,
                      true,
                      TS.ScriptKind.TS,
                  )
                : origGetSf(n, lang);
        const prog = TS.createProgram(
            ['test.ts'],
            {
                strict: true,
                target: TS.ScriptTarget.ES2020,
                module: TS.ModuleKind.ESNext,
            },
            host,
        );
        const sf = prog.getSourceFile('test.ts');
        const checker = prog.getTypeChecker();
        let typeStr = '(not found)';
        TS.forEachChild(sf, (n) => {
            if (TS.isVariableStatement(n)) {
                for (const decl of n.declarationList.declarations) {
                    if (
                        TS.isIdentifier(decl.name) &&
                        decl.name.text === varName
                    ) {
                        const sym = checker.getSymbolAtLocation(decl.name);
                        if (sym) {
                            const t = checker.getTypeOfSymbolAtLocation(
                                sym,
                                decl.name,
                            );
                            typeStr = checker.typeToString(
                                t,
                                undefined,
                                TS.TypeFormatFlags.NoTruncation |
                                    TS.TypeFormatFlags.InTypeAlias,
                            );
                        }
                    }
                }
            }
        });
        return typeStr;
    }

    it('awaited result variable resolves to array type with field (not Promise, not alias)', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { rewritten } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const typeStr = resolveVarType(rewritten, 'result');
        assert.ok(
            !typeStr.includes('Promise'),
            'awaited result must not be a Promise type, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('ID') && typeStr.includes('string'),
            'awaited result must include the field type {ID: string}[], got: ' +
                typeStr,
        );
    });

    it('non-awaited result variable resolves to Promise wrapping the field type', () => {
        const src =
            'const result = cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { rewritten } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const typeStr = resolveVarType(rewritten, 'result');
        assert.ok(
            typeStr.includes('Promise'),
            'non-awaited result must be a Promise type, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('ID') && typeStr.includes('string'),
            'non-awaited result must include the field type, got: ' + typeStr,
        );
    });

    it('hover on result variable does not show "var undefined"', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const pos = posOf(src, 'result');
        const info = ls.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'must have hover info on result variable');
        const text = info.displayParts?.map((p) => p.text).join('') ?? '';
        assert.ok(
            !(text.includes('var undefined') || text.match(/\bundefined\b/)),
            'hover must not show "undefined", got: ' + text,
        );
        assert.ok(
            text.includes('result'),
            'hover must mention the variable name, got: ' + text,
        );
    });

    it('hover on cds.ql does not show "var undefined"', () => {
        const src =
            'const result = await cds.ql`SELECT ID FROM Books                      `;\nexport {};';
        const { ls } = makeLs(
            'test.ts',
            src,
            fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]),
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const pos = posOf(src, '.ql') + 1;
        const info = ls.getQuickInfoAtPosition('test.ts', pos);
        if (info) {
            const text = info.displayParts?.map((p) => p.text).join('') ?? '';
            assert.ok(
                !text.includes('var undefined'),
                'hover over cds.ql must not show "var undefined", got: ' + text,
            );
        }
        // null info is also fine — TS may not resolve cds without imports
    });

    it('second query in a two-query file resolves to correct type (not unknown)', () => {
        // Regression: second query was getting "unknown" when first query succeeded.
        const src = [
            'const q1 = await cds.ql`SELECT ID FROM Books                      `;',
            'const q2 = await cds.ql`SELECT ID FROM Authors                    `;',
            'export {};',
        ].join('\n');
        const worker = fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]);
        const { rewritten } = makeLs(
            'test.ts',
            src,
            worker,
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const q2Type = resolveVarType(rewritten, 'q2');
        assert.ok(
            q2Type.includes('ID') && q2Type.includes('string'),
            'second query must resolve to field type, not unknown — got: ' +
                q2Type,
        );
        assert.ok(
            !q2Type.includes('unknown'),
            'second query must not be "unknown", got: ' + q2Type,
        );
    });

    it('second non-awaited query resolves to Promise type (not unknown)', () => {
        const src = [
            'const q1 = cds.ql`SELECT ID FROM Books                      `;',
            'const q2 = cds.ql`SELECT ID FROM Authors                    `;',
            'export {};',
        ].join('\n');
        const worker = fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]);
        const { rewritten } = makeLs(
            'test.ts',
            src,
            worker,
            fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]),
        );
        const q2Type = resolveVarType(rewritten, 'q2');
        assert.ok(
            q2Type.includes('Promise'),
            'second non-awaited query must be Promise type, got: ' + q2Type,
        );
        assert.ok(
            !q2Type.includes('unknown'),
            'second non-awaited query must not be "unknown", got: ' + q2Type,
        );
    });

    it('getCqlHover: same-named variable in different scopes resolves to its own query type', () => {
        // Regression: resolveToCdsQuery was searching by variable name only (ignoring scope),
        // so the outer `x` (Authors) got the type of the inner `x` (Books) because
        // findOriginatingTemplate returned the first match in document order.
        const src = [
            'async function f() {',
            '  // @cds-service S',
            '  const x = await cds.ql`SELECT * FROM Books                       `;',
            '}',
            '// @cds-service S',
            'const x = await cds.ql`SELECT * FROM Authors                       `;',
            'export {};',
        ].join('\n');

        const worker = (args) => {
            const query = args[1] ?? '';
            if (query.includes('Books'))
                return {
                    completions: [
                        {
                            label: 'bookField',
                            detail: 'cds.String',
                            kind: 'field',
                        },
                    ],
                };
            if (query.includes('Authors'))
                return {
                    completions: [
                        {
                            label: 'authorField',
                            detail: 'cds.String',
                            kind: 'field',
                        },
                    ],
                };
            return { completions: [] };
        };
        const batchWorker = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    p.entity.includes('Books')
                        ? [
                              {
                                  label: 'bookField',
                                  detail: 'cds.String',
                                  kind: 'field',
                              },
                          ]
                        : [
                              {
                                  label: 'authorField',
                                  detail: 'cds.String',
                                  kind: 'field',
                              },
                          ],
                ]),
            ),
        });

        const origSource = new Map();
        const rewriteCache = new Map();
        const rewritten = rewriteSnapshot(
            'test.ts',
            src,
            TS,
            origSource,
            rewriteCache,
            worker,
            batchWorker,
            NO_LOGGER,
            '/proj',
            undefined,
        );
        const origSf = TS.createSourceFile(
            'test.ts',
            src,
            TS.ScriptTarget.ES2020,
            true,
            TS.ScriptKind.TS,
        );

        // Position of the outer `x` (module-level, line 5)
        const outerXLine = src
            .split('\n')
            .findIndex((l) => l.startsWith('const x'));
        const outerXPos =
            src
                .split('\n')
                .slice(0, outerXLine)
                .reduce((acc, l) => acc + l.length + 1, 0) + 'const '.length;

        const ctx = {
            origText: src,
            origSf,
            projectRoot: '/proj',
            logger: NO_LOGGER,
            runWorker: worker,
            runBatchWorker: batchWorker,
        };
        const hover = getCqlHover('test.ts', outerXPos, ctx, TS);
        assert.ok(hover, 'expected hover info on outer x');
        const text =
            hover.displayParts
                ?.map((p) => p.text)
                .join('') ?? '';
        assert.ok(
            text.includes('authorField'),
            'outer x (Authors query) hover must mention authorField, not bookField — got: ' +
                text,
        );
        assert.ok(
            !text.includes('bookField'),
            'outer x must not show Books type (scope collision) — got: ' + text,
        );
    });
});

// ---------------------------------------------------------------------------
// Type inference — expand / postfix-projection queries
// ---------------------------------------------------------------------------

describe('LS integration — type inference for expand queries', () => {
    function resolveVarType(rewritten, varName) {
        const host = TS.createCompilerHost({});
        const origGetSf = host.getSourceFile.bind(host);
        host.getSourceFile = (n, lang) =>
            n === 'test.ts'
                ? TS.createSourceFile(
                      n,
                      rewritten,
                      lang,
                      true,
                      TS.ScriptKind.TS,
                  )
                : origGetSf(n, lang);
        const prog = TS.createProgram(
            ['test.ts'],
            {
                strict: true,
                target: TS.ScriptTarget.ES2020,
                module: TS.ModuleKind.ESNext,
            },
            host,
        );
        const sf = prog.getSourceFile('test.ts');
        const checker = prog.getTypeChecker();
        let typeStr = '(not found)';
        TS.forEachChild(sf, (n) => {
            if (TS.isVariableStatement(n)) {
                for (const decl of n.declarationList.declarations) {
                    if (
                        TS.isIdentifier(decl.name) &&
                        decl.name.text === varName
                    ) {
                        const sym = checker.getSymbolAtLocation(decl.name);
                        if (sym) {
                            const t = checker.getTypeOfSymbolAtLocation(
                                sym,
                                decl.name,
                            );
                            typeStr = checker.typeToString(
                                t,
                                undefined,
                                TS.TypeFormatFlags.NoTruncation |
                                    TS.TypeFormatFlags.InTypeAlias,
                            );
                        }
                    }
                }
            }
        });
        return typeStr;
    }

    it('postfix projection: resolves to flat array type with listed fields', () => {
        // SELECT FROM Books { ID, title } → { ID: number; title: string }[]
        const src =
            'const result = await cds.ql`SELECT FROM Books { ID, title }  `;\nexport {};';
        const batch = fieldsBatchWorker([
            { label: 'ID', detail: 'cds.Integer' },
            { label: 'title', detail: 'cds.String' },
        ]);
        const { rewritten } = makeLs('test.ts', src, fieldsWorker([]), batch);
        const typeStr = resolveVarType(rewritten, 'result');
        assert.ok(
            !typeStr.includes('unknown'),
            'postfix type must not be unknown, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('ID'),
            'type must include ID, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('title'),
            'type must include title, got: ' + typeStr,
        );
    });

    it('expand block: association field produces nested array type when target is known', () => {
        // SELECT FROM Books { ID, author { name } } → { ID: number; author: { name: string }[] }[]
        const src =
            'const result = await cds.ql`SELECT FROM Books { ID, author { name } }  `;\nexport {};';
        const batch = perEntityBatchWorker({
            Books: [
                { label: 'ID', detail: 'cds.Integer' },
                {
                    label: 'author',
                    detail: 'cds.Association',
                    target: 'Svc.Authors',
                },
            ],
            'Svc.Authors': [{ label: 'name', detail: 'cds.String' }],
        });
        const { rewritten } = makeLs('test.ts', src, fieldsWorker([]), batch);
        const typeStr = resolveVarType(rewritten, 'result');
        assert.ok(
            !typeStr.includes('unknown'),
            'expand type must not be unknown, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('ID'),
            'type must include ID, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('author'),
            'type must include author, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('name'),
            'type must include nested name field, got: ' + typeStr,
        );
    });

    it('expand block: nested association produces doubly-nested type', () => {
        // SELECT FROM Books { author { address { street } } } → nested three levels
        const src =
            'const result = await cds.ql`SELECT FROM Books { author { address { street } } }  `;\nexport {};';
        const batch = perEntityBatchWorker({
            Books: [
                {
                    label: 'author',
                    detail: 'cds.Association',
                    target: 'Svc.Authors',
                },
            ],
            'Svc.Authors': [
                {
                    label: 'address',
                    detail: 'cds.Association',
                    target: 'Svc.Addresses',
                },
            ],
            'Svc.Addresses': [{ label: 'street', detail: 'cds.String' }],
        });
        const { rewritten } = makeLs('test.ts', src, fieldsWorker([]), batch);
        const typeStr = resolveVarType(rewritten, 'result');
        assert.ok(
            !typeStr.includes('unknown'),
            'nested expand type must not be unknown, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('author'),
            'type must include author, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('address'),
            'type must include address, got: ' + typeStr,
        );
        assert.ok(
            typeStr.includes('street'),
            'type must include street, got: ' + typeStr,
        );
    });

    it('expand block: no token bleed after classification filtering', () => {
        // Verify that expand rewritten snapshot + filtering produces no visible tokens
        // inside the original template span (no syntax highlighting bleed).
        const src =
            'const result = await cds.ql`SELECT FROM Books { ID, author { name } }  `;\nexport {};';
        const batch = perEntityBatchWorker({
            Books: [
                { label: 'ID', detail: 'cds.Integer' },
                {
                    label: 'author',
                    detail: 'cds.Association',
                    target: 'Svc.Authors',
                },
            ],
            'Svc.Authors': [{ label: 'name', detail: 'cds.String' }],
        });
        const {
            ls,
            rewritten: rw,
            rewrittenRanges: ranges,
            origText,
        } = makeLs('test.ts', src, fieldsWorker([]), batch);
        assert.ok(
            ranges.length > 0,
            'expand-with-target: expected rewrite to produce ranges',
        );
        const origLen = origText.length;
        for (const method of [
            'getEncodedSyntacticClassifications',
            'getEncodedSemanticClassifications',
        ]) {
            const base =
                method === 'getEncodedSyntacticClassifications'
                    ? ls.getEncodedSyntacticClassifications('test.ts', {
                          start: 0,
                          length: rw.length,
                      })
                    : ls.getEncodedSemanticClassifications(
                          'test.ts',
                          { start: 0, length: rw.length },
                          TS.SemanticClassificationFormat.TwentyTwenty,
                      );
            const filtered = filterClassifications(base, ranges, origLen);
            for (let i = 0; i < filtered.spans.length; i += 3) {
                const tokStart = filtered.spans[i];
                assert.strictEqual(
                    rw[tokStart],
                    origText[tokStart],
                    `expand-with-target [${method}] token at [${tokStart}] bleeds onto original source`,
                );
            }
        }
    });

    it('expand block: association without target resolves to empty-object array (not unknown)', () => {
        // When the worker returns no target for an association, the expand type is {}[] not unknown.
        // The rewrite must still happen (non-empty typeBody) so the variable is not "any".
        const src =
            'const result = await cds.ql`SELECT FROM Books { ID, author { name } }  `;\nexport {};';
        const batch = fieldsBatchWorker([
            { label: 'ID', detail: 'cds.Integer' },
            { label: 'author', detail: 'cds.Association' }, // no target
        ]);
        const { rewritten, rewrittenRanges } = makeLs(
            'test.ts',
            src,
            fieldsWorker([]),
            batch,
        );
        // Rewrite must have happened (range set)
        assert.ok(
            rewrittenRanges.length > 0,
            'rewrite must produce at least one range',
        );
        const typeStr = resolveVarType(rewritten, 'result');
        // Type may be {}[] for author but must not be the raw tagged-template type
        assert.ok(
            !(
                typeStr.startsWith('Promise<') ||
                typeStr.includes('TemplateStringsArray')
            ),
            'without await the raw tagged-template type must not appear, got: ' +
                typeStr,
        );
        assert.ok(
            typeStr.includes('ID'),
            'scalar field ID must appear in type, got: ' + typeStr,
        );
    });
});

// ---------------------------------------------------------------------------
// Scope resolution edge cases (getCqlHover / resolveToCdsQuery)
// ---------------------------------------------------------------------------

/** Shared worker for scope tests: Books→bookField, Authors→authorField, Orders→orderField */
const SCOPE_WORKER = (args) => {
    const query = args[1] ?? '';
    if (query.includes('Books'))
        return {
            completions: [
                {
                    label: 'bookField',
                    detail: 'cds.String',
                    kind: 'field',
                },
            ],
        };
    if (query.includes('Authors'))
        return {
            completions: [
                {
                    label: 'authorField',
                    detail: 'cds.String',
                    kind: 'field',
                },
            ],
        };
    if (query.includes('Orders'))
        return {
            completions: [
                {
                    label: 'orderField',
                    detail: 'cds.String',
                    kind: 'field',
                },
            ],
        };
    return { completions: [] };
};

const SCOPE_BATCH_WORKER = (_root, probes, _logger) => ({
    fields: Object.fromEntries(
        probes.map((p) => {
            if (p.entity.includes('Books'))
                return [
                    p.entity,
                    [
                        {
                            label: 'bookField',
                            detail: 'cds.String',
                            kind: 'field',
                        },
                    ],
                ];
            if (p.entity.includes('Authors'))
                return [
                    p.entity,
                    [
                        {
                            label: 'authorField',
                            detail: 'cds.String',
                            kind: 'field',
                        },
                    ],
                ];
            if (p.entity.includes('Orders'))
                return [
                    p.entity,
                    [
                        {
                            label: 'orderField',
                            detail: 'cds.String',
                            kind: 'field',
                        },
                    ],
                ];
            return [p.entity, []];
        }),
    ),
});

function hoverText(src, varName, occurrence = 0) {
    const origSf = TS.createSourceFile(
        'test.ts',
        src,
        TS.ScriptTarget.ES2020,
        true,
        TS.ScriptKind.TS,
    );
    const origSource = new Map();
    const rewriteCache = new Map();
    rewriteSnapshot(
        'test.ts',
        src,
        TS,
        origSource,
        rewriteCache,
        SCOPE_WORKER,
        SCOPE_BATCH_WORKER,
        NO_LOGGER,
        '/proj',
        undefined,
    );
    const ctx = {
        origText: src,
        origSf,
        projectRoot: '/proj',
        logger: NO_LOGGER,
        runWorker: SCOPE_WORKER,
        runBatchWorker: SCOPE_BATCH_WORKER,
    };
    // Find nth occurrence of `varName` as an identifier (preceded by space or start)
    let pos = -1;
    let count = 0;
    while (count <= occurrence) {
        pos = src.indexOf(varName, pos + 1);
        if (pos === -1)
            throw new Error(`"${varName}" occurrence ${occurrence} not found`);
        const before = src[pos - 1];
        if (before === ' ' || before === undefined || before === '\n') count++;
    }
    const info = getCqlHover('test.ts', pos, ctx, TS);
    return (
        info?.displayParts?.map((p) => p.text).join('') ??
        '(null)'
    );
}

describe('Scope resolution — getCqlHover handles same-named variables', () => {
    it('sibling scopes: hover in each function shows its own query type', () => {
        const src = [
            'function f() {',
            '  // @cds-service S',
            '  const x = cds.ql`SELECT * FROM Books                       `;',
            '}',
            'function g() {',
            '  // @cds-service S',
            '  const x = cds.ql`SELECT * FROM Authors                     `;',
            '}',
            'export {};',
        ].join('\n');

        // x in f → Books
        const fLine = src.split('\n').findIndex((l) => l.includes('Books'));
        const fPos =
            src
                .split('\n')
                .slice(0, fLine)
                .reduce((a, l) => a + l.length + 1, 0) +
            src.split('\n')[fLine].indexOf('x');
        const origSf = TS.createSourceFile(
            'test.ts',
            src,
            TS.ScriptTarget.ES2020,
            true,
            TS.ScriptKind.TS,
        );
        const origSource = new Map();
        const rewriteCache = new Map();
        rewriteSnapshot(
            'test.ts',
            src,
            TS,
            origSource,
            rewriteCache,
            SCOPE_WORKER,
            SCOPE_BATCH_WORKER,
            NO_LOGGER,
            '/proj',
            undefined,
        );
        const ctx = {
            origText: src,
            origSf,
            projectRoot: '/proj',
            logger: NO_LOGGER,
            runWorker: SCOPE_WORKER,
            runBatchWorker: SCOPE_BATCH_WORKER,
        };

        const textF =
            getCqlHover('test.ts', fPos, ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';
        assert.ok(
            textF.includes('bookField'),
            'x in f must show bookField, got: ' + textF,
        );
        assert.ok(
            !textF.includes('authorField'),
            'x in f must not show authorField, got: ' + textF,
        );

        // x in g → Authors
        const gLine = src.split('\n').findIndex((l) => l.includes('Authors'));
        const gPos =
            src
                .split('\n')
                .slice(0, gLine)
                .reduce((a, l) => a + l.length + 1, 0) +
            src.split('\n')[gLine].indexOf('x');
        const textG =
            getCqlHover('test.ts', gPos, ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';
        assert.ok(
            textG.includes('authorField'),
            'x in g must show authorField, got: ' + textG,
        );
        assert.ok(
            !textG.includes('bookField'),
            'x in g must not show bookField, got: ' + textG,
        );
    });

    it('nested scopes: inner variable shadows outer — hover on inner shows inner type', () => {
        const src = [
            '// @cds-service S',
            'const x = cds.ql`SELECT * FROM Books                       `;',
            'function inner() {',
            '  // @cds-service S',
            '  const x = cds.ql`SELECT * FROM Authors                   `;',
            '}',
            'export {};',
        ].join('\n');

        const origSf = TS.createSourceFile(
            'test.ts',
            src,
            TS.ScriptTarget.ES2020,
            true,
            TS.ScriptKind.TS,
        );
        const origSource = new Map();
        const rewriteCache = new Map();
        rewriteSnapshot(
            'test.ts',
            src,
            TS,
            origSource,
            rewriteCache,
            SCOPE_WORKER,
            SCOPE_BATCH_WORKER,
            NO_LOGGER,
            '/proj',
            undefined,
        );
        const ctx = {
            origText: src,
            origSf,
            projectRoot: '/proj',
            logger: NO_LOGGER,
            runWorker: SCOPE_WORKER,
            runBatchWorker: SCOPE_BATCH_WORKER,
        };

        // outer x (Books)
        const outerLine = src
            .split('\n')
            .findIndex((l) => l.startsWith('const x'));
        const outerPos =
            src
                .split('\n')
                .slice(0, outerLine)
                .reduce((a, l) => a + l.length + 1, 0) + 'const '.length;
        const outerText =
            getCqlHover('test.ts', outerPos, ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';
        assert.ok(
            outerText.includes('bookField'),
            'outer x must show bookField, got: ' + outerText,
        );
        assert.ok(
            !outerText.includes('authorField'),
            'outer x must not show authorField, got: ' + outerText,
        );

        // inner x (Authors)
        const innerLine = src
            .split('\n')
            .findIndex((l) => l.includes('Authors'));
        const innerPos =
            src
                .split('\n')
                .slice(0, innerLine)
                .reduce((a, l) => a + l.length + 1, 0) +
            src.split('\n')[innerLine].indexOf('x');
        const innerText =
            getCqlHover('test.ts', innerPos, ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';
        assert.ok(
            innerText.includes('authorField'),
            'inner x must show authorField, got: ' + innerText,
        );
        assert.ok(
            !innerText.includes('bookField'),
            'inner x must not show bookField, got: ' + innerText,
        );
    });

    it('arrow function as scope boundary', () => {
        const src = [
            '// @cds-service S',
            'const x = cds.ql`SELECT * FROM Books                       `;',
            'const fn = () => {',
            '  // @cds-service S',
            '  const x = cds.ql`SELECT * FROM Authors                   `;',
            '};',
            'export {};',
        ].join('\n');

        const origSf = TS.createSourceFile(
            'test.ts',
            src,
            TS.ScriptTarget.ES2020,
            true,
            TS.ScriptKind.TS,
        );
        const origSource = new Map();
        const rewriteCache = new Map();
        rewriteSnapshot(
            'test.ts',
            src,
            TS,
            origSource,
            rewriteCache,
            SCOPE_WORKER,
            SCOPE_BATCH_WORKER,
            NO_LOGGER,
            '/proj',
            undefined,
        );
        const ctx = {
            origText: src,
            origSf,
            projectRoot: '/proj',
            logger: NO_LOGGER,
            runWorker: SCOPE_WORKER,
            runBatchWorker: SCOPE_BATCH_WORKER,
        };

        // inner x inside arrow (Authors)
        const innerLine = src
            .split('\n')
            .findIndex((l) => l.includes('Authors'));
        const innerPos =
            src
                .split('\n')
                .slice(0, innerLine)
                .reduce((a, l) => a + l.length + 1, 0) +
            src.split('\n')[innerLine].indexOf('x');
        const innerText =
            getCqlHover('test.ts', innerPos, ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';
        assert.ok(
            innerText.includes('authorField'),
            'x inside arrow must show authorField, got: ' + innerText,
        );
        assert.ok(
            !innerText.includes('bookField'),
            'x inside arrow must not bleed Books type, got: ' + innerText,
        );
    });

    it('three variables with same name across three sibling functions', () => {
        const src = [
            'function a() { const x = cds.ql`SELECT * FROM Books    `; }',
            'function b() { const x = cds.ql`SELECT * FROM Authors  `; }',
            'function c() { const x = cds.ql`SELECT * FROM Orders   `; }',
            'export {};',
        ].join('\n');

        const origSf = TS.createSourceFile(
            'test.ts',
            src,
            TS.ScriptTarget.ES2020,
            true,
            TS.ScriptKind.TS,
        );
        const origSource = new Map();
        const rewriteCache = new Map();
        rewriteSnapshot(
            'test.ts',
            src,
            TS,
            origSource,
            rewriteCache,
            SCOPE_WORKER,
            SCOPE_BATCH_WORKER,
            NO_LOGGER,
            '/proj',
            undefined,
        );
        const ctx = {
            origText: src,
            origSf,
            projectRoot: '/proj',
            logger: NO_LOGGER,
            runWorker: SCOPE_WORKER,
            runBatchWorker: SCOPE_BATCH_WORKER,
        };

        const lines = src.split('\n');
        function posOfXOnLine(lineIdx) {
            return (
                lines.slice(0, lineIdx).reduce((a, l) => a + l.length + 1, 0) +
                lines[lineIdx].indexOf(' x ') +
                1
            );
        }

        const textA =
            getCqlHover('test.ts', posOfXOnLine(0), ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';
        const textB =
            getCqlHover('test.ts', posOfXOnLine(1), ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';
        const textC =
            getCqlHover('test.ts', posOfXOnLine(2), ctx, TS)
                ?.displayParts?.map((p) => p.text)
                .join('') ?? '(null)';

        assert.ok(
            textA.includes('bookField'),
            'a/x must show bookField, got: ' + textA,
        );
        assert.ok(
            textB.includes('authorField'),
            'b/x must show authorField, got: ' + textB,
        );
        assert.ok(
            textC.includes('orderField'),
            'c/x must show orderField, got: ' + textC,
        );
        assert.ok(
            !(textA.includes('authorField') || textA.includes('orderField')),
            'a/x must not bleed, got: ' + textA,
        );
        assert.ok(
            !(textB.includes('bookField') || textB.includes('orderField')),
            'b/x must not bleed, got: ' + textB,
        );
        assert.ok(
            !(textC.includes('bookField') || textC.includes('authorField')),
            'c/x must not bleed, got: ' + textC,
        );
    });

    it('rewrite assigns distinct aliases to same-named variables in different scopes', () => {
        const src = [
            'async function f() {',
            '  // @cds-service S',
            '  const x = await cds.ql`SELECT * FROM Books                       `;',
            '}',
            '// @cds-service S',
            'const x = await cds.ql`SELECT * FROM Authors                       `;',
            'export {};',
        ].join('\n');
        const origSource = new Map();
        const rewriteCache = new Map();
        const rw = rewriteSnapshot(
            'test.ts',
            src,
            TS,
            origSource,
            rewriteCache,
            SCOPE_WORKER,
            SCOPE_BATCH_WORKER,
            NO_LOGGER,
            '/proj',
            undefined,
        );
        const aliases = [...rw.matchAll(/type (_q\d+)=/g)].map((m) => m[1]);
        assert.equal(
            aliases.length,
            2,
            'expected 2 aliases for 2 distinct declarations, got: ' +
                aliases.join(', '),
        );
        const unique = new Set(aliases);
        assert.equal(
            unique.size,
            2,
            'alias names must be distinct, got duplicates: ' +
                aliases.join(', '),
        );
    });
});
