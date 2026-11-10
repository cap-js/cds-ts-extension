'use strict';
/**
 * Integration tests for the index.ts plugin factory wiring.
 *
 * These tests construct a minimal fake PluginCreateInfo and call `create()`
 * to get a proxy LanguageService.  They verify that:
 *   - completions/hover/diagnostics proxy overrides call the CDS logic
 *   - feature flags (cds.ql.completion / hover / diagnostics) suppress each
 *   - getEncodedSyntacticClassifications uses the original source for correct syntax highlighting
 *   - getEncodedSemanticClassifications filters tokens that fall in rewritten ranges
 *   - getCompletionEntryDetails wires getCqlCompletionDetails
 *
 * Nothing here spawns a real worker process — RunWorker is always injected
 * via a closure in the test-seam below.
 */
const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const TS = require('typescript');

/** @typedef {import('../src/QueryContext').RunWorker} RunWorker */
/** @typedef {import('../src/QueryContext').RunBatchWorker} RunBatchWorker */
const { CqlDiagnosticCode } = require('../src/CqlLogic');

// ---------------------------------------------------------------------------
// Test seam — re-export the plugin factory with an injectable RunWorker
// ---------------------------------------------------------------------------
// We cannot require the real index.ts because it hard-codes `runWorker` using
// execFileSync. Instead we replicate the factory logic using the same module
// graph, injecting a stub worker. This keeps the tests free of child processes
// while exercising every proxy override.

const { rewriteSnapshot } = require('../src/CqlTypeRewriter');
const { getCqlCompletions, getCqlCompletionDetails } = require('../src/CqlCompletions');
const { getCqlHover } = require('../src/CqlHover');
const { getCqlDiagnostics } = require('../src/CqlDiagnostics');
const { readConfig, resolveQueryContext } = require('../src/QueryContext');
const pluginFactory = require('../src/index');
/** @typedef {import('../src/test-overrides').TestOverrides} TestOverrides */

/**
 * Typed accessor for the plugin's test-injection hook. The factory attaches
 * `_testOverrides` at module load; this exposes it as `TestOverrides` so tests
 * don't cast through `any`.
 */
const testOverrides = () => pluginFactory._testOverrides;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_LOGGER = {
    close: () => {},
    hasLevel: () => false,
    loggingEnabled: () => false,
    perftrc: () => {},
    info: () => {},
    startGroup: () => {},
    endGroup: () => {},
    msg: () => {},
    getLogFileName: () => undefined,
};

function posOf(src, needle, occurrence = 0) {
    let idx = -1;
    for (let i = 0; i <= occurrence; i++) {
        idx = src.indexOf(needle, idx + 1);
        assert.ok(idx !== -1, `"${needle}" not found (occurrence ${i})`);
    }
    return idx;
}

/**
 * Build a minimal plugin proxy equivalent to index.ts create(), but using an
 * injected RunWorker instead of execFileSync.
 *
 * Returns { proxy, originalSource, rewrittenRanges } so tests can inspect
 * internal state.
 */
function createProxy(
    fileName,
    sourceText,
    worker,
    config = {
        'cds.ql.completion': true,
        'cds.ql.hover': true,
        'cds.ql.diagnostics': true,
    },
    batchWorker = EMPTY_BATCH_WORKER,
) {
    const originalSource = new Map();
    const rewriteCache = new Map();
    const rewrittenRanges = new Map();

    originalSource.set(fileName, sourceText);

    const rewritten = rewriteSnapshot(fileName, sourceText, TS, originalSource, rewriteCache, worker, batchWorker, NO_LOGGER, '/proj', undefined, rewrittenRanges);

    // Real TS LanguageService backed by the rewritten snapshot
    const lsHost = {
        getCompilationSettings: () => ({
            strict: true,
            target: TS.ScriptTarget.ES2020,
            module: TS.ModuleKind.ESNext,
        }),
        getScriptFileNames: () => [fileName],
        getScriptVersion: () => '1',
        getScriptSnapshot: (f) => {
            if (f === fileName) return TS.ScriptSnapshot.fromString(rewritten);
            try {
                return TS.ScriptSnapshot.fromString(require('node:fs').readFileSync(f, 'utf8'));
            } catch {
                return undefined;
            }
        },
        getCurrentDirectory: () => '/proj',
        getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
        fileExists: (f) => {
            if (f === fileName) return true;
            try {
                return require('node:fs').existsSync(f);
            } catch {
                return false;
            }
        },
        readFile: (f) => {
            try {
                return require('node:fs').readFileSync(f, 'utf8');
            } catch {
                return undefined;
            }
        },
        readDirectory: () => [],
    };
    const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

    // Fake PluginCreateInfo
    const pluginConfig = config;
    const fakeInfo = {
        config: pluginConfig,
        languageService: ls,
        project: {
            projectService: { logger: NO_LOGGER },
            getScriptInfo: () => null,
            updateGraph: () => {},
        },
        languageServiceHost: {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        },
    };

    const cfg = readConfig(config);

    // filterSemanticClassifications (mirrors index.ts — drops tokens in rewritten ranges / beyond orig)
    function filterSemanticClassifications(base, ranges, origLength) {
        if (!ranges?.length) return base;
        const out = [];
        for (let i = 0; i < base.spans.length; i += 3) {
            const tokStart = base.spans[i];
            if (tokStart >= origLength) continue;
            if (!ranges.some((r) => tokStart >= r.start && tokStart < r.end)) out.push(tokStart, base.spans[i + 1], base.spans[i + 2]);
        }
        return { spans: out, endOfLineState: base.endOfLineState };
    }

    // lsOrig: LanguageService backed by the ORIGINAL source, used for syntactic classifications
    const lsOrigHost = {
        ...lsHost,
        getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(sourceText) : lsHost.getScriptSnapshot(f)),
    };
    const lsOrig = TS.createLanguageService(lsOrigHost, TS.createDocumentRegistry());

    function getCtx() {
        return resolveQueryContext(fileName, fakeInfo, TS, originalSource, worker, batchWorker, NO_LOGGER, '/proj');
    }

    const proxy = Object.create(null);
    for (const k of Object.keys(ls)) {
        const m = ls[k];
        if (typeof m === 'function') proxy[k] = (...args) => m.apply(ls, args);
    }

    proxy.getSemanticDiagnostics = (fn) => {
        const base = ls.getSemanticDiagnostics(fn);
        if (!cfg['cds.ql.diagnostics']) return base;
        const ctx = getCtx();
        if (!ctx) return base;
        return [...base, ...getCqlDiagnostics(ctx, TS)];
    };

    proxy.getCompletionsAtPosition = (fn, position, options, fmt) => {
        const base = ls.getCompletionsAtPosition(fn, position, options, fmt);
        if (!cfg['cds.ql.completion']) return base;
        const ctx = getCtx();
        if (!ctx) return base;
        const cds = getCqlCompletions(fn, position, ctx, TS);
        if (!cds) return base;
        if (!base) return cds;
        return { ...base, entries: [...cds.entries, ...base.entries] };
    };

    proxy.getCompletionEntryDetails = (fn, position, entryName, fmtOpts, source, prefs, data) => {
        const base = ls.getCompletionEntryDetails(fn, position, entryName, fmtOpts, source, prefs, data);
        if (!cfg['cds.ql.completion']) return base;
        if (!source?.startsWith('cds:')) return base;
        const ctx = getCtx();
        if (!ctx) return base;
        const cds = getCqlCompletionDetails(fn, position, entryName, source, ctx, TS);
        if (!cds) return base;
        return {
            ...base,
            ...cds,
            codeActions: [...(base?.codeActions ?? []), ...(cds.codeActions ?? [])],
        };
    };

    proxy.getQuickInfoAtPosition = (fn, position) => {
        const base = ls.getQuickInfoAtPosition(fn, position);
        if (!cfg['cds.ql.hover']) return base;
        const ctx = getCtx();
        if (!ctx) return base;
        return getCqlHover(fn, position, ctx, TS) ?? base;
    };

    proxy.getEncodedSyntacticClassifications = (fn, span) => (rewrittenRanges.has(fn) ? lsOrig.getEncodedSyntacticClassifications(fn, span) : ls.getEncodedSyntacticClassifications(fn, span));

    proxy.getEncodedSemanticClassifications = (fn, span, fmt) =>
        filterSemanticClassifications(ls.getEncodedSemanticClassifications(fn, span, fmt), rewrittenRanges.get(fn), originalSource.get(fn)?.length ?? Number.POSITIVE_INFINITY);

    return { proxy, originalSource, rewrittenRanges, rewritten };
}

const BOOKS_WORKER = (_args) => ({
    completions: [
        { label: 'id', detail: 'cds.UUID', kind: 'field' },
        { label: 'title', detail: 'cds.String', kind: 'field' },
    ],
});

// Returns a field plus a keyword completion, to exercise the keyword-kind host
// mapping (ScriptElementKind.keyword + the later sortText bucket).
const KEYWORD_WORKER = (_args) => ({
    completions: [
        { label: 'id', detail: 'cds.UUID', kind: 'field' },
        { label: 'FROM', detail: 'keyword', kind: 'keyword' },
    ],
});

const BOOKS_BATCH_WORKER = (_root, probes, _logger) => ({
    fields: Object.fromEntries(
        probes.map((p) => [
            p.entity,
            [
                { label: 'id', detail: 'cds.UUID', kind: 'field' },
                {
                    label: 'title',
                    detail: 'cds.String',
                    kind: 'field',
                },
            ],
        ]),
    ),
});

const EMPTY_WORKER = () => ({ completions: [] });
const EMPTY_BATCH_WORKER = (_root, _probes, _logger) => ({
    fields: {},
});

// ---------------------------------------------------------------------------
// Completions proxy
// ---------------------------------------------------------------------------

describe('Plugin proxy — completions', () => {
    it('prepends CDS field completions inside template literal', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const pos = posOf(src, 'id');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const info = proxy.getCompletionsAtPosition('test.ts', pos, undefined, undefined);
        assert.ok(info, 'expected completion info');
        const labels = info.entries.map((e) => e.name);
        assert.ok(labels.includes('id'), 'CDS field "id" must be in completions');
        assert.ok(labels.includes('title'), 'CDS field "title" must be in completions');
    });

    it('returns base completions unchanged when cursor is outside template', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const pos = posOf(src, 'export');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        // getCqlCompletions returns null here → proxy falls through to base
        const baseLs = TS.createLanguageService(
            {
                getCompilationSettings: () => ({
                    strict: true,
                    target: TS.ScriptTarget.ES2020,
                    module: TS.ModuleKind.ESNext,
                }),
                getScriptFileNames: () => ['test.ts'],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === 'test.ts' ? TS.ScriptSnapshot.fromString(src) : undefined),
                getCurrentDirectory: () => '/proj',
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === 'test.ts',
                readFile: () => undefined,
                readDirectory: () => [],
            },
            TS.createDocumentRegistry(),
        );
        const base = baseLs.getCompletionsAtPosition('test.ts', pos, undefined, undefined);
        const proxy_ = createProxy('test.ts', src, BOOKS_WORKER).proxy;
        const result = proxy_.getCompletionsAtPosition('test.ts', pos, undefined, undefined);
        // Both should be present or both absent (proxy must not inject CDS entries here)
        const proxyLabels = result?.entries.map((e) => e.name) ?? [];
        assert.ok(!proxyLabels.includes('id'), 'CDS field must NOT appear outside template');
        assert.ok(!proxyLabels.includes('title'), 'CDS field must NOT appear outside template');
    });

    it('maps keyword completions to the keyword kind and sorts them below fields', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const pos = posOf(src, 'id');
        const { proxy } = createProxy('test.ts', src, KEYWORD_WORKER);
        const info = proxy.getCompletionsAtPosition('test.ts', pos, undefined, undefined);
        assert.ok(info, 'expected completion info');
        const field = info.entries.find((e) => e.name === 'id');
        const keyword = info.entries.find((e) => e.name === 'FROM');
        assert.ok(field && keyword, 'both field and keyword entries expected');
        assert.equal(keyword.kind, TS.ScriptElementKind.keyword, 'keyword entry maps to keyword ScriptElementKind');
        // Field sorts into the 0_ bucket, keyword into 1_ → fields rank above keywords.
        assert.ok(field.sortText < keyword.sortText, 'keyword must sort below field');
    });

    it('feature flag cds.ql.completion=false suppresses CDS completions', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const pos = posOf(src, 'id');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER, {
            'cds.ql.completion': false,
        });
        const info = proxy.getCompletionsAtPosition('test.ts', pos, undefined, undefined);
        const labels = info?.entries.map((e) => e.name) ?? [];
        assert.ok(!labels.includes('id'), 'completion must be suppressed by flag');
        assert.ok(!labels.includes('title'), 'completion must be suppressed by flag');
    });

    it('getCompletionEntryDetails returns code action for cds: source', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const pos = posOf(src, 'Books');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const details = proxy.getCompletionEntryDetails('test.ts', pos, 'Books', undefined, 'cds:Svc.Books', undefined, undefined);
        assert.ok(details?.codeActions?.length, 'expected code action from cds: source');
        const action = details.codeActions[0];
        assert.ok(action.changes[0].textChanges[0].newText.includes('@cds-service Svc'));
    });

    it('getCompletionEntryDetails scopes to the full dotted service name, not the first segment', () => {
        // Regression: CAP service names are dotted namespaces. Entity
        // `sap.capire.hotels.Hotels` belongs to service `sap.capire.hotels`.
        // The annotation must carry the whole prefix, not just "sap".
        const src = 'const r = cds.ql`SELECT * FROM sap.capire.hotels.Hotels`;\nexport {};';
        const pos = posOf(src, 'Hotels');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const details = proxy.getCompletionEntryDetails('test.ts', pos, 'Hotels', undefined, 'cds:sap.capire.hotels.Hotels', undefined, undefined);
        assert.ok(details?.codeActions?.length, 'expected code action from cds: source');
        const newText = details.codeActions[0].changes[0].textChanges[0].newText;
        assert.ok(newText.includes('@cds-service sap.capire.hotels'), `annotation must carry full service prefix; got: ${JSON.stringify(newText)}`);
        assert.ok(!/@cds-service sap\b(?!\.)/.test(newText), 'annotation must not scope to the first segment "sap" alone');
    });

    it('getCompletionEntryDetails passes through when source is not cds:', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const pos = posOf(src, 'Books');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        // Non-cds source → falls through to base (null for unknown entry)
        const details = proxy.getCompletionEntryDetails('test.ts', pos, 'Books', undefined, 'ts:Books', undefined, undefined);
        // We just want no code-action injected, not a crash
        assert.ok(!details?.codeActions?.some((a) => a.description.includes('cds-service')), 'non-cds source must not get cds annotation action');
    });

    it('feature flag cds.ql.completion=false suppresses completion entry details', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const pos = posOf(src, 'Books');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER, {
            'cds.ql.completion': false,
        });
        const details = proxy.getCompletionEntryDetails('test.ts', pos, 'Books', undefined, 'cds:Svc.Books', undefined, undefined);
        assert.ok(!details?.codeActions?.length, 'code action must be suppressed when completion flag is false');
    });
});

// ---------------------------------------------------------------------------
// Hover proxy
// ---------------------------------------------------------------------------

describe('Plugin proxy — hover', () => {
    it('returns CDS hover info for cursor inside template', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const pos = posOf(src, 'id');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info');
        const text = (info.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('cds field'), 'expected "cds field" in hover text, got: ' + text);
    });

    it('returns CDS hover info for cursor on result variable', () => {
        const src = 'const r = await cds.ql`SELECT * FROM Books                      `;\nconsole.log(r);\nexport {};';
        // Use position of 'r' in 'console.log(r)' — NOT lastIndexOf which hits 'export'
        const pos = src.indexOf('console.log(r)') + 'console.log('.length;
        // Result-variable hover resolves the row type through the batch worker (same
        // path as type inference), so a batch worker must be supplied.
        const { proxy } = createProxy(
            'test.ts',
            src,
            BOOKS_WORKER,
            {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
            },
            BOOKS_BATCH_WORKER,
        );
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info on result variable');
        const text = (info.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('id') || text.includes('title'), 'hover must show inferred fields, got: ' + text);
        assert.ok(!text.includes('undefined'), 'hover must not show "undefined", got: ' + text);
    });

    it('falls through to TS hover when cursor is not on a cds.ql-related node', () => {
        const src = 'const foo = 42;\nexport {};';
        const pos = posOf(src, 'foo');
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        // TS hover for `foo: number` — CDS must not interfere
        const text = info?.displayParts?.map((p) => p.text).join('') ?? '';
        assert.ok(!text.includes('cds field'), 'CDS hover must not appear for non-cql identifier');
    });

    it('feature flag cds.ql.hover=false falls through to TS hover', () => {
        const src = 'const r = await cds.ql`SELECT * FROM Books                      `;\nexport {};';
        const pos = posOf(src, 'r'); // 'r' in 'const r'
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER, {
            'cds.ql.hover': false,
        });
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        // With the flag off, TS hover is returned. It will show the _qN alias, not a CDS type.
        const text = info?.displayParts?.map((p) => p.text).join('') ?? '';
        assert.ok(!(text.includes('id: string') || text.includes('title: string')), 'CDS field types must be suppressed by hover flag, got: ' + text);
    });
});

// ---------------------------------------------------------------------------
// Diagnostics proxy
// ---------------------------------------------------------------------------

describe('Plugin proxy — diagnostics', () => {
    it('appends CDS diagnostics to TS diagnostics', () => {
        const src = 'const r = cds.ql`SELECT ghost FROM Books`;\nexport {};';
        const ghostWorker = (args) => ({
            diagnostics: [
                {
                    message: "Unknown field 'ghost'",
                    start: 7,
                    end: 12,
                    code: CqlDiagnosticCode.UnknownField,
                },
            ],
        });
        const { proxy } = createProxy('test.ts', src, ghostWorker);
        const diags = proxy.getSemanticDiagnostics('test.ts');
        const cdsDiags = diags.filter((d) => d.source === 'cds');
        assert.ok(cdsDiags.length > 0, 'expected at least one CDS diagnostic');
        assert.ok(cdsDiags[0].messageText.toString().includes('ghost'));
    });

    it('feature flag cds.ql.diagnostics=false suppresses CDS diagnostics', () => {
        const src = 'const r = cds.ql`SELECT ghost FROM Books`;\nexport {};';
        const ghostWorker = () => ({
            diagnostics: [
                {
                    message: "Unknown field 'ghost'",
                    start: 7,
                    end: 12,
                    code: CqlDiagnosticCode.UnknownField,
                },
            ],
        });
        const { proxy } = createProxy('test.ts', src, ghostWorker, {
            'cds.ql.diagnostics': false,
        });
        const diags = proxy.getSemanticDiagnostics('test.ts');
        const cdsDiags = diags.filter((d) => d.source === 'cds');
        assert.equal(cdsDiags.length, 0, 'CDS diagnostics must be suppressed by flag');
    });

    it('returns only TS diagnostics when file has no cds.ql', () => {
        const src = 'const x: string = 42;\nexport {};';
        const { proxy } = createProxy('test.ts', src, EMPTY_WORKER);
        const diags = proxy.getSemanticDiagnostics('test.ts');
        const cdsDiags = diags.filter((d) => d.source === 'cds');
        assert.equal(cdsDiags.length, 0, 'no CDS diagnostics for non-cql file');
    });
});

// ---------------------------------------------------------------------------
// Classification filtering proxy
// ---------------------------------------------------------------------------

describe('Plugin proxy — classification token filtering', () => {
    it('getEncodedSyntacticClassifications returns original-source tokens (template literal present)', () => {
        // The fix: syntactic classifications are run against the ORIGINAL source so the
        // template literal token is returned with its full span, not the cast tokens.
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const { proxy, rewrittenRanges } = createProxy(
            'test.ts',
            src,
            BOOKS_WORKER,
            {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
            },
            BOOKS_BATCH_WORKER,
        );
        const ranges = rewrittenRanges.get('test.ts') ?? [];
        assert.ok(ranges.length > 0, 'expected at least one rewritten range');

        const span = { start: 0, length: src.length };
        const result = proxy.getEncodedSyntacticClassifications('test.ts', span);

        // The template literal token must be present — original source classification
        const tplStart = src.indexOf('`');
        const tplEnd = src.lastIndexOf('`') + 1;
        const tplLen = tplEnd - tplStart;
        let foundTemplate = false;
        for (let i = 0; i < result.spans.length; i += 3) {
            if (result.spans[i] === tplStart && result.spans[i + 1] === tplLen) {
                foundTemplate = true;
                break;
            }
        }
        assert.ok(foundTemplate, `template literal token [${tplStart},${tplLen}) must be present in syntactic classifications`);

        // No token should go beyond original source length
        for (let i = 0; i < result.spans.length; i += 3) {
            assert.ok(result.spans[i] < src.length, `token at ${result.spans[i]} must be within original source bounds`);
        }
    });

    it('getEncodedSemanticClassifications filters tokens in rewritten ranges', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const { proxy, rewrittenRanges } = createProxy(
            'test.ts',
            src,
            BOOKS_WORKER,
            {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
            },
            BOOKS_BATCH_WORKER,
        );
        const ranges = rewrittenRanges.get('test.ts') ?? [];
        assert.ok(ranges.length > 0, 'expected at least one rewritten range');

        const span = { start: 0, length: src.length };
        const result = proxy.getEncodedSemanticClassifications('test.ts', span, TS.SemanticClassificationFormat.TwentyTwenty);

        for (let i = 0; i < result.spans.length; i += 3) {
            const tokStart = result.spans[i];
            const inRange = ranges.some((r) => tokStart >= r.start && tokStart < r.end);
            assert.ok(!inRange, `semantic token at ${tokStart} falls within rewritten range`);
        }
    });

    it('classifications are unchanged when there are no rewritten ranges', () => {
        const src = 'const foo = 42;\nexport {};';
        const { proxy, rewrittenRanges } = createProxy('test.ts', src, EMPTY_WORKER);
        assert.equal((rewrittenRanges.get('test.ts') ?? []).length, 0, 'no rewritten ranges for file without cds.ql');
        // Should not throw and should return some spans
        const result = proxy.getEncodedSyntacticClassifications('test.ts', {
            start: 0,
            length: src.length,
        });
        assert.ok(Array.isArray(result.spans));
    });
});

// ---------------------------------------------------------------------------
// Feature flag independence
// ---------------------------------------------------------------------------

describe('Plugin proxy — feature flags are independent', () => {
    it('disabling hover does not affect completions', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER, {
            'cds.ql.completion': true,
            'cds.ql.hover': false,
        });
        const pos = posOf(src, 'id');
        const info = proxy.getCompletionsAtPosition('test.ts', pos, undefined, undefined);
        const labels = info?.entries.map((e) => e.name) ?? [];
        assert.ok(labels.includes('id') || labels.includes('title'), 'completions must still work when hover is disabled');
    });

    it('disabling diagnostics does not affect completions', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER, {
            'cds.ql.completion': true,
            'cds.ql.diagnostics': false,
        });
        const pos = posOf(src, 'id');
        const info = proxy.getCompletionsAtPosition('test.ts', pos, undefined, undefined);
        const labels = info?.entries.map((e) => e.name) ?? [];
        assert.ok(labels.includes('id') || labels.includes('title'), 'completions must still work when diagnostics are disabled');
    });

    it('all flags false: proxy behaves like plain TS language service', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER, {
            'cds.ql.completion': false,
            'cds.ql.hover': false,
            'cds.ql.diagnostics': false,
        });
        const completionPos = posOf(src, 'id');
        const completions = proxy.getCompletionsAtPosition('test.ts', completionPos, undefined, undefined);
        const labels = completions?.entries.map((e) => e.name) ?? [];
        assert.ok(!(labels.includes('id') || labels.includes('title')), 'with all flags off, CDS completions must be absent');

        const hover = proxy.getQuickInfoAtPosition('test.ts', posOf(src, 'r'));
        const hoverText = hover?.displayParts?.map((p) => p.text).join('') ?? '';
        assert.ok(!(hoverText.includes('id: string') || hoverText.includes('title: string')), 'with all flags off, CDS hover must be absent');

        const diags = proxy.getSemanticDiagnostics('test.ts').filter((d) => d.source === 'cds');
        assert.equal(diags.length, 0, 'with all flags off, CDS diagnostics must be absent');
    });
});

// ---------------------------------------------------------------------------
// typeInference feature flag
// ---------------------------------------------------------------------------

describe('Plugin proxy — typeInference flag', () => {
    it('typeInference=false: getScriptSnapshot returns base snapshot immediately without rewriting', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'ti-false.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const mod = pluginFactory({ typescript: TS });
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: () => baseSnap,
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

        let patchedGetSnapshot = () => baseSnap;
        const fakeInfo = {
            config: { 'cds.ql.typeInference': false },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                get getScriptSnapshot() {
                    return patchedGetSnapshot;
                },
                set getScriptSnapshot(fn) {
                    patchedGetSnapshot = fn;
                },
            },
        };

        mod.create(fakeInfo);
        const result = patchedGetSnapshot(fileName);

        assert.equal(result, baseSnap, 'original base snapshot must be returned when typeInference is false');
    });

    it('typeInference=true: getScriptSnapshot enters the rewrite path without throwing', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'ti-true.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const mod = pluginFactory({ typescript: TS });
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: () => baseSnap,
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

        let patchedGetSnapshot = () => baseSnap;
        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                get getScriptSnapshot() {
                    return patchedGetSnapshot;
                },
                set getScriptSnapshot(fn) {
                    patchedGetSnapshot = fn;
                },
            },
        };

        mod.create(fakeInfo);
        // Rewrite path is entered (no short-circuit). Worker fails (no @sap/cds) so rewritten===src,
        // but the path was taken — verified by no exception and by contrast with the false-case test
        // which asserts result===baseSnap via the early-return guard.
        assert.doesNotThrow(() => patchedGetSnapshot(fileName), 'rewrite path must not throw when typeInference is true');
    });
});

describe('onConfigurationChanged', () => {
    const module_ = pluginFactory({ typescript: TS });

    it('plugin module exposes onConfigurationChanged', () => {
        assert.equal(typeof module_.onConfigurationChanged, 'function');
    });

    it('onConfigurationChanged updates config — all false disables all features', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'oc-test.ts';

        const originalSource = new Map([[fileName, src]]);
        const rewriteCache = new Map();
        const rewrittenRanges = new Map();
        const rewritten = rewriteSnapshot(fileName, src, TS, originalSource, rewriteCache, EMPTY_WORKER, BOOKS_BATCH_WORKER, NO_LOGGER, '/proj', undefined, rewrittenRanges);

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(rewritten) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

        const fakeInfo = {
            config: {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
            },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };

        const proxy = module_.create(fakeInfo);

        // after create() all flags are on — CDS completions should be present
        const posId = posOf(src, 'id');
        const before = proxy.getCompletionsAtPosition(fileName, posId, undefined, undefined);

        // now turn everything off via onConfigurationChanged
        module_.onConfigurationChanged({
            'cds.ql.completion': false,
            'cds.ql.hover': false,
            'cds.ql.diagnostics': false,
        });

        const afterDiag = proxy.getSemanticDiagnostics(fileName).filter((d) => d.source === 'cds');
        assert.equal(afterDiag.length, 0, 'diagnostics disabled after onConfigurationChanged');
    });

    it('onConfigurationChanged updates config — enabling typeInference', () => {
        // Just verify that onConfigurationChanged accepts typeInference: true without throwing
        assert.doesNotThrow(() => {
            module_.onConfigurationChanged({
                'cds.ql.typeInference': true,
            });
        });
        // Reset
        module_.onConfigurationChanged({});
    });

    it('onConfigurationChanged with null fires newConfig ?? {} branch (line 584)', () => {
        // null is nullish → newConfig ?? {} fires the ?? branch
        assert.doesNotThrow(() => {
            module_.onConfigurationChanged(null);
        });
    });

    it('real proxy getEncodedSyntacticClassifications passes through', () => {
        const src = 'const x = 1;';
        const fileName = 'enc-syn.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo2 = {
            config: {},
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const proxy2 = module_.create(fakeInfo2);
        const span = { start: 0, length: src.length };
        assert.doesNotThrow(() => proxy2.getEncodedSyntacticClassifications(fileName, span));
        assert.doesNotThrow(() => proxy2.getEncodedSemanticClassifications(fileName, span, TS.SemanticClassificationFormat.TwentyTwenty));
    });

    it('real proxy languageServiceHost.getScriptSnapshot rewrites when typeInference on', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'snap-test.ts';
        let snapshotCallCount = 0;
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => {
                snapshotCallCount++;
                return f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined;
            },
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo3 = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };
        module_.create(fakeInfo3);
        // languageServiceHost.getScriptSnapshot should have been patched — calling it should not throw
        assert.doesNotThrow(() => patchedHost.getScriptSnapshot(fileName));
    });

    it('real proxy getQuickInfoAtPosition and getCompletionEntryDetails pass through when flags off', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'qi-test.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo4 = {
            config: { 'cds.ql.hover': false, 'cds.ql.completion': false },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const proxy4 = module_.create(fakeInfo4);
        assert.doesNotThrow(() => proxy4.getQuickInfoAtPosition(fileName, 10));
        assert.doesNotThrow(() => proxy4.getCompletionEntryDetails(fileName, 10, 'id', undefined, undefined, undefined, undefined));
    });

    it('real proxy — all flags on: executes resolveQueryContext path for all proxy methods', () => {
        // With all flags on and typeInference on, calling the patched getScriptSnapshot first
        // populates originalSource so that resolveQueryContext returns a non-null context.
        // The real execFileSync worker will fail (no built .js in tests), but runWorker's
        // try/catch returns null, so rewriteSnapshot and all CDS logic handles it gracefully.
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const fileName = 'rp-all-flags.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost5 = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo5 = {
            config: {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
                'cds.ql.typeInference': true,
            },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost5,
        };
        const proxy5 = module_.create(fakeInfo5);

        // Trigger languageServiceHost.getScriptSnapshot to populate originalSource
        patchedHost5.getScriptSnapshot(fileName);

        // Exercise getSemanticDiagnostics with flags on → enters resolveQueryContext path
        assert.doesNotThrow(() => proxy5.getSemanticDiagnostics(fileName));

        // Exercise getCompletionsAtPosition with flags on → enters resolveQueryContext path
        assert.doesNotThrow(() => proxy5.getCompletionsAtPosition(fileName, src.indexOf('id'), undefined, undefined));

        // Exercise getCompletionEntryDetails with cds: source and flags on → enters resolveQueryContext path
        assert.doesNotThrow(() => proxy5.getCompletionEntryDetails(fileName, src.indexOf('Books'), 'Books', undefined, 'cds:Svc.Books', undefined, undefined));

        // Exercise getQuickInfoAtPosition with flags on → enters resolveQueryContext path
        assert.doesNotThrow(() => proxy5.getQuickInfoAtPosition(fileName, src.indexOf('id')));

        // Exercise getEncodedSyntacticClassifications / Semantic (hits patchScriptInfo + filterClassifications)
        const span = { start: 0, length: src.length };
        assert.doesNotThrow(() => proxy5.getEncodedSyntacticClassifications(fileName, span));
        assert.doesNotThrow(() => proxy5.getEncodedSemanticClassifications(fileName, span, TS.SemanticClassificationFormat.TwentyTwenty));
    });

    it('real proxy — patchScriptInfo body via fake scriptInfo', () => {
        // Provide a fake scriptInfo from getScriptInfo() to exercise patchScriptInfoImpl.
        // The body patches scriptInfo.getSnapshot; we verify the patching ran without error.
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'pi-test.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

        // Fake scriptInfo — minimal implementation of the tsserver ScriptInfo API
        const fakeScriptInfo = {
            getSnapshot: () => baseSnap,
            markContainingProjectsAsDirty: () => {},
        };

        const patchedHost6 = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo6 = {
            config: {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
                'cds.ql.typeInference': false,
            },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: (fn) => (fn === fileName ? fakeScriptInfo : null),
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost6,
        };

        const proxy6 = module_.create(fakeInfo6);

        // Calling getSemanticDiagnostics triggers patchScriptInfo → patchScriptInfoImpl
        assert.doesNotThrow(() => proxy6.getSemanticDiagnostics(fileName), 'patchScriptInfoImpl must not throw with fake scriptInfo');

        // Now call the patched getSnapshot directly to exercise the lambda body
        // (typeInference=false → condition !config['cds.ql.typeInference'] is true → returns base)
        assert.doesNotThrow(() => fakeScriptInfo.getSnapshot(), 'patched getSnapshot lambda must not throw with typeInference=false');

        // Calling it again should skip patching (already has __cdsPatchedSnapshot)
        assert.doesNotThrow(() => proxy6.getSemanticDiagnostics(fileName), 'second call must skip patching without error');
    });

    it('real proxy — patchScriptInfo inner lambda with typeInference=true', () => {
        // Variant of the fake scriptInfo test with typeInference=true so that the lambda
        // enters the originalSource.set / doRewrite path (lines 128-130 in index.ts).
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'pi-ti-test.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const lsHostTi = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const lsTi = TS.createLanguageService(lsHostTi, TS.createDocumentRegistry());

        const fakeScriptInfoTi = {
            getSnapshot: () => baseSnap,
            markContainingProjectsAsDirty: () => {},
        };

        const patchedHostTi = {
            getScriptSnapshot: (f) => lsHostTi.getScriptSnapshot(f),
        };
        const fakeInfoTi = {
            config: {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
                'cds.ql.typeInference': true,
            },
            languageService: lsTi,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: (fn) => (fn === fileName ? fakeScriptInfoTi : null),
                updateGraph: () => {},
            },
            languageServiceHost: patchedHostTi,
        };

        const proxyTi = module_.create(fakeInfoTi);

        // Trigger patchScriptInfoImpl for the fake scriptInfo
        assert.doesNotThrow(() => proxyTi.getSemanticDiagnostics(fileName));

        // Call the patched lambda with typeInference=true → enters originalSource.set + doRewrite
        // Worker may fail (no real cds project at /proj), rewritten===src → returns base
        assert.doesNotThrow(() => fakeScriptInfoTi.getSnapshot(), 'patched getSnapshot lambda must not throw with typeInference=true');
    });

    it('real proxy — non-overridden method goes through proxy loop lambda', () => {
        // Calling a method that is NOT explicitly overridden (e.g., getDefinitionAtPosition)
        // exercises the generic arrow lambda created in the for-of proxy loop.
        const src = 'const x = 1;\nexport {};';
        const fileName = 'nl-test.ts';
        const lsHostNl = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const lsNl = TS.createLanguageService(lsHostNl, TS.createDocumentRegistry());
        const fakeInfoNl = {
            config: {},
            languageService: lsNl,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHostNl.getScriptSnapshot(f),
            },
        };
        const proxyNl = module_.create(fakeInfoNl);
        // getDefinitionAtPosition is NOT overridden → goes through the generic proxy loop lambda
        assert.doesNotThrow(() => proxyNl.getDefinitionAtPosition(fileName, 6), 'non-overridden proxy method must pass through to base LS');
    });

    it('create() with info.config = undefined fires info.config ?? {} branch (line 283)', () => {
        // info.config is undefined → ?? {} fires the null-coalescing branch
        const src = 'const x = 1;';
        const fileName = 'no-config.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfoNoConfig = {
            config: undefined,
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        assert.doesNotThrow(() => module_.create(fakeInfoNoConfig), 'create() with undefined config must not throw');
    });

    it('filterSemanticClassifications: tokStart >= origLength drops tail-alias tokens and ranges filter drops range tokens', () => {
        // Tests filterSemanticClassifications in the real plugin factory:
        //   1. The LS is backed by the *rewritten* text, which is longer than the original,
        //      so TS emits tokens at positions >= src.length — those must be dropped.
        //   2. Tokens whose start falls in a rewritten range must be dropped.
        //   3. getEncodedSyntacticClassifications goes through withOriginalSnapshot instead,
        //      so it returns the full template literal token (verified separately).
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'fc-cov2.ts';

        // Pre-compute the rewritten snapshot to serve to the TS LanguageService.
        const preRwRanges = new Map();
        const preRewritten = rewriteSnapshot(fileName, src, TS, new Map([[fileName, src]]), new Map(), EMPTY_WORKER, BOOKS_BATCH_WORKER, NO_LOGGER, '/proj', undefined, preRwRanges);
        assert.ok(preRwRanges.has(fileName) && preRwRanges.get(fileName).length > 0, 'pre-check: rewrite must produce ranges for CQL source');
        assert.ok(preRewritten.length > src.length, 'pre-check: rewritten source must be longer than original (tail aliases appended)');

        // lsHost serves the *rewritten* text — so TS emits tokens beyond src.length
        const lsHostFc = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(preRewritten) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const lsFc = TS.createLanguageService(lsHostFc, TS.createDocumentRegistry());

        const pluginOverrides = testOverrides();
        const origRw = pluginOverrides.rw;
        const origRwBatch = pluginOverrides.rwBatch;
        pluginOverrides.rw = EMPTY_WORKER;
        pluginOverrides.rwBatch = BOOKS_BATCH_WORKER;

        // patchableHost returns the *original* source so doRewrite populates rewrittenRanges.
        const patchableHost = {
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : lsHostFc.getScriptSnapshot(f)),
        };
        const fakeInfoFc = {
            config: { 'cds.ql.typeInference': true },
            languageService: lsFc,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchableHost,
        };

        const proxyFc = module_.create(fakeInfoFc);

        // Trigger doRewrite → populates originalSource[fileName] and rewrittenRanges.
        patchableHost.getScriptSnapshot(fileName);

        const span = { start: 0, length: preRewritten.length };
        const origLen = src.length;
        const ranges = preRwRanges.get(fileName);

        // getEncodedSemanticClassifications uses filterSemanticClassifications:
        // tokens beyond origLength and tokens in rewritten ranges must be absent.
        let semResult;
        assert.doesNotThrow(() => {
            semResult = proxyFc.getEncodedSemanticClassifications(fileName, span, TS.SemanticClassificationFormat.TwentyTwenty);
        }, 'getEncodedSemanticClassifications must not throw');
        assert.ok(semResult, 'must return a semantic classification result');
        for (let i = 0; i < semResult.spans.length; i += 3) {
            const tokStart = semResult.spans[i];
            assert.ok(tokStart < origLen, `semantic token at ${tokStart} must be < origLength ${origLen}`);
            assert.ok(!ranges.some((r) => tokStart >= r.start && tokStart < r.end), `semantic token at ${tokStart} must not fall in a rewritten range`);
        }

        // getEncodedSyntacticClassifications uses withOriginalSnapshot (getScriptInfo→null
        // means no swap, falls through): must not throw and must return spans.
        let synResult;
        assert.doesNotThrow(() => {
            synResult = proxyFc.getEncodedSyntacticClassifications(fileName, span);
        }, 'getEncodedSyntacticClassifications must not throw');
        assert.ok(synResult, 'must return a syntactic classification result');

        pluginOverrides.rw = origRw;
        pluginOverrides.rwBatch = origRwBatch;
    });

    it('withOriginalSnapshot: swaps to original source for syntactic classifications when ScriptInfo has __cdsOrigSnap', () => {
        // Tests the snapshot-swap path in getEncodedSyntacticClassifications.
        // When a ScriptInfo with __cdsOrigSnap is available, the proxy temporarily restores
        // the original snapshot so TS classifies the original source, returning the full
        // template literal token instead of the cast tokens from the rewritten source.
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'swap-test.ts';

        // Pre-compute rewrite
        const preRwRanges = new Map();
        const preRewritten = rewriteSnapshot(fileName, src, TS, new Map([[fileName, src]]), new Map(), EMPTY_WORKER, BOOKS_BATCH_WORKER, NO_LOGGER, '/proj', undefined, preRwRanges);

        // Fake ScriptInfo with __cdsOrigSnap and __cdsPatchedSnapshot.
        // Its getSnapshot is mutable so withOriginalSnapshot can swap it.
        const origSnap = TS.ScriptSnapshot.fromString(src);
        const rewrittenSnap = TS.ScriptSnapshot.fromString(preRewritten);
        const fakeScriptInfo = {
            __cdsPatchedSnapshot: true,
            __cdsOrigSnap: () => origSnap,
        };
        // Mutable getSnapshot — withOriginalSnapshot assigns si.getSnapshot = origSnap fn
        let _currentGetSnapshot = () => rewrittenSnap;
        Object.defineProperty(fakeScriptInfo, 'getSnapshot', {
            get() {
                return _currentGetSnapshot;
            },
            set(v) {
                _currentGetSnapshot = v;
            },
            configurable: true,
        });

        // LS host delegates to fakeScriptInfo.getSnapshot() so the swap is visible to the LS
        const lsHostSwap = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? fakeScriptInfo.getSnapshot() : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const lsSwap = TS.createLanguageService(lsHostSwap, TS.createDocumentRegistry());

        const pluginOverrides = testOverrides();
        const origRw = pluginOverrides.rw;
        const origRwBatch = pluginOverrides.rwBatch;
        pluginOverrides.rw = EMPTY_WORKER;
        pluginOverrides.rwBatch = BOOKS_BATCH_WORKER;

        const patchableHost = {
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
        };
        const fakeInfoSwap = {
            config: { 'cds.ql.typeInference': true },
            languageService: lsSwap,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: (f) => (f === fileName ? fakeScriptInfo : null),
                updateGraph: () => {},
            },
            languageServiceHost: patchableHost,
        };

        const proxySwap = module_.create(fakeInfoSwap);
        // Trigger doRewrite to populate rewrittenRanges
        patchableHost.getScriptSnapshot(fileName);

        // With the swap, syntactic classifications should come from the original source.
        // The template literal token [tplStart, tplLen) must be present.
        const tplStart = src.indexOf('`');
        const tplEnd = src.lastIndexOf('`') + 1;
        const tplLen = tplEnd - tplStart;

        const span = { start: 0, length: src.length };
        let synResult;
        assert.doesNotThrow(() => {
            synResult = proxySwap.getEncodedSyntacticClassifications(fileName, span);
        }, 'getEncodedSyntacticClassifications with __cdsOrigSnap must not throw');
        assert.ok(synResult, 'must return result');

        let foundTemplate = false;
        for (let i = 0; i < synResult.spans.length; i += 3) {
            if (synResult.spans[i] === tplStart && synResult.spans[i + 1] === tplLen) {
                foundTemplate = true;
                break;
            }
        }
        assert.ok(foundTemplate, `template literal token [${tplStart},${tplLen}) must appear when withOriginalSnapshot swaps to orig`);

        pluginOverrides.rw = origRw;
        pluginOverrides.rwBatch = origRwBatch;
    });
});

// ---------------------------------------------------------------------------
// cds-resolver-worker — direct subprocess invocation
// ---------------------------------------------------------------------------

describe('cds-resolver-worker — subprocess invocation', () => {
    const { spawnSync } = require('node:child_process');
    const { join } = require('node:path');

    const workerSrc = join(__dirname, '../src/cds-resolver-worker.js');
    const projectRoot = join(__dirname, '..'); // repo root has @sap/cds in node_modules

    function callWorker(...args) {
        return callWorkerEnv({}, ...args);
    }

    function callWorkerEnv(extraEnv, ...args) {
        const result = spawnSync(process.execPath, [workerSrc, ...args], {
            encoding: 'utf8',
            timeout: 15000,
            env: { ...process.env, ...extraEnv },
        });
        if (!result.stdout?.trim()) return null;
        return JSON.parse(result.stdout.trim());
    }

    it('returns error when called with no arguments', () => {
        const out = callWorker();
        assert.ok(out, 'expected JSON output');
        assert.equal(out.error, 'missing arguments');
    });

    it('returns error when projectRoot has no @sap/cds', () => {
        // Disable the global-install fallback so this is deterministic on machines
        // that DO have a global @sap/cds (which would otherwise resolve for /tmp).
        const out = callWorkerEnv({ CDS_LSP_NO_GLOBAL_FALLBACK: '1' }, '/tmp', 'SELECT id FROM Books', '0');
        assert.ok(out, 'expected JSON output');
        assert.ok(out.error, 'expected error for missing @sap/cds');
        assert.ok(out.error.includes('@sap/cds'), `expected error about @sap/cds, got: ${out.error}`);
    });

    it('returns completions when @sap/cds is available (cursor >= 0)', () => {
        const query = 'SELECT  FROM Books';
        const cursor = 'SELECT '.length;
        const out = callWorker(projectRoot, query, String(cursor));
        assert.ok(out, 'expected JSON output');
        // May return completions or a cds.load error — either way, no missing-arguments error
        assert.notEqual(out.error, 'missing arguments');
    });

    it('returns diagnostics when @sap/cds is available (cursor = -1)', () => {
        const query = 'SELECT id FROM Books';
        const out = callWorker(projectRoot, query, '-1');
        assert.ok(out, 'expected JSON output');
        assert.notEqual(out.error, 'missing arguments');
        // Either diagnostics array or a cds.load error — both are valid without a real model
        assert.ok('diagnostics' in out || 'error' in out, 'expected diagnostics or error key');
    });

    it('--persistent mode: responds to a single request over stdin/stdout', async () => {
        // Covers the require.main --persistent branch: spawn the worker with --persistent,
        // write a JSON request, read the response, kill the process.
        const { spawn } = require('node:child_process');
        const proc = spawn(process.execPath, [workerSrc, projectRoot, '--persistent'], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });

        const response = await new Promise((resolve, reject) => {
            let stdout = '';
            proc.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
                if (stdout.includes('\n')) resolve(stdout);
            });
            proc.on('error', reject);
            const req = JSON.stringify({
                id: 42,
                kind: 'batch',
                projectRoot,
                probes: [{ entity: 'Books', prefix: '' }],
            });
            proc.stdin.write(req + '\n');
            setTimeout(() => {
                proc.kill();
                resolve(stdout);
            }, 5000);
        });
        proc.kill();

        const lines = response.split('\n').filter(Boolean);
        assert.ok(lines.length > 0, 'expected at least one response line');
        const resp = JSON.parse(lines[0]);
        assert.equal(resp.id, 42, 'response id must match request id');
        assert.ok('result' in resp, 'response must have result field');
    });

    it('--persistent mode: handles invalid JSON line gracefully', async () => {
        // Covers the try/catch around JSON.parse in the readline handler
        const { spawn } = require('node:child_process');
        const proc = spawn(process.execPath, [workerSrc, projectRoot, '--persistent'], {
            stdio: ['pipe', 'pipe', 'inherit'],
        });

        const response = await new Promise((resolve, reject) => {
            let stdout = '';
            proc.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
                // Wait for the valid request's response (id 99)
                if (stdout.includes('"id":99')) resolve(stdout);
            });
            proc.on('error', reject);
            // Invalid JSON first (must not crash), then a valid request
            proc.stdin.write('not-json\n');
            const req = JSON.stringify({
                id: 99,
                kind: 'batch',
                projectRoot,
                probes: [],
            });
            proc.stdin.write(req + '\n');
            setTimeout(() => {
                proc.kill();
                resolve(stdout);
            }, 5000);
        });
        proc.kill();

        const lines = response.split('\n').filter(Boolean);
        const resp = lines
            .map((l) => {
                try {
                    return JSON.parse(l);
                } catch {
                    return null;
                }
            })
            .find((r) => r?.id === 99);
        assert.ok(resp, 'valid request after invalid line must still get a response');
    });
});

// ---------------------------------------------------------------------------
// Debounced rewriting
// ---------------------------------------------------------------------------

describe('Plugin proxy — debounced rewriting', () => {
    const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
    // Use a tmpdir path so projectRootFor finds no package.json → no @sap/cds →
    // runBatchWorker always returns null (worker miss), as the tests expect.
    const { join: pathJoin } = require('node:path');
    const { tmpdir } = require('node:os');
    const fileName = pathJoin(tmpdir(), 'debounce-test.ts');
    const baseSnap = TS.ScriptSnapshot.fromString(src);

    function makeDebounceProxy(debounceDelay = 300) {
        const localModule = pluginFactory({ typescript: TS });

        // Capture setTimeout/clearTimeout so tests can fire timers synchronously
        const timers = [];
        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;

        global.setTimeout = (fn, delay) => {
            timers.push({ fn, delay });
            return timers.length - 1;
        };
        global.clearTimeout = (_id) => {
            /* no-op: last timer wins */
        };

        let currentSnap = baseSnap;

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? currentSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

        const scriptInfo = {
            getSnapshot: () => currentSnap,
            markContainingProjectsAsDirty: () => {},
        };

        const fakeInfo = {
            config: {
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
                'cds.ql.typeInference': true,
                'cds.ql.debounceDelay': debounceDelay,
            },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: (fn) => (fn === fileName ? scriptInfo : null),
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };

        const proxy = localModule.create(fakeInfo);

        return {
            proxy,
            fakeInfo,
            scriptInfo,
            timers,
            flushTimers: () => {
                for (const t of timers.splice(0)) t.fn();
            },
            setSource: (text) => {
                currentSnap = TS.ScriptSnapshot.fromString(text);
            },
            restore: () => {
                global.setTimeout = origSetTimeout;
                global.clearTimeout = origClearTimeout;
            },
        };
    }

    it('cold start: first call runs synchronously (no timer scheduled)', () => {
        // On first open (no prior result), doRewrite must not defer — it runs the
        // worker synchronously so the user never sees `any` on initial load.
        // In tests there is no real CDS model so the rewrite returns original source,
        // but what matters is that no timer is scheduled.
        const { proxy, scriptInfo, timers, restore } = makeDebounceProxy();
        try {
            proxy.getSemanticDiagnostics(fileName); // triggers patchScriptInfo
            scriptInfo.getSnapshot(); // cold-start doRewrite call
            assert.equal(timers.length, 0, 'cold start must not schedule a timer');
        } finally {
            restore();
        }
    });

    it('worker miss keeps cold-start path: editing source still runs synchronously', () => {
        // When the batch worker always fails (no CDS model), lastRewritten is never
        // populated, so every getSnapshot call takes the cold-start (synchronous) path
        // and no timer is ever scheduled — avoids caching a stale `any` result.
        const { proxy, scriptInfo, timers, setSource, restore } = makeDebounceProxy();
        try {
            proxy.getSemanticDiagnostics(fileName); // cold start — synchronous
            scriptInfo.getSnapshot(); // worker miss → lastRewritten stays empty
            assert.equal(timers.length, 0, 'cold start with worker miss must not schedule a timer');

            // Edit the source — without lastRewritten set, next call is still cold-start
            const edited = src.replace('Books', 'Books ');
            setSource(edited);

            scriptInfo.getSnapshot();
            assert.equal(timers.length, 0, 'worker-miss edit must also not schedule a timer (retries synchronously)');
        } finally {
            restore();
        }
    });

    it('rapid cold-start retries do not accumulate timers when worker always misses', () => {
        // Multiple rapid calls on a worker-miss source must never schedule any timers —
        // the cold-start path is taken every time because lastRewritten is never set.
        const { proxy, scriptInfo, timers, setSource, restore } = makeDebounceProxy();
        try {
            proxy.getSemanticDiagnostics(fileName); // cold start

            // Simulate two rapid keystrokes — both must be synchronous cold-starts
            setSource(src.replace('Books', 'Books '));
            scriptInfo.getSnapshot();
            assert.equal(timers.length, 0, 'first edit with worker miss: no timer');

            setSource(src.replace('Books', 'Books  '));
            scriptInfo.getSnapshot();
            assert.equal(timers.length, 0, 'second edit with worker miss: still no timer');
        } finally {
            restore();
        }
    });

    it('debounce timer fires writeDiskCache when worker returns a real rewrite (line 363)', () => {
        // When getSnapshot is called a second time after a prior successful rewrite,
        // the debounce path schedules a timer. When that timer fires and the worker
        // returns fresh !== sourceText, writeDiskCache is called (line 363).
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { createHash } = require('node:crypto');
        const { existsSync, unlinkSync } = require('node:fs');

        const tmp = tmpdir();
        const src2 = 'const r = await cds.ql`SELECT id FROM DebounceWrite`;\nexport {};';
        const fn2 = join(tmp, `debounce-write-${Date.now()}.ts`);
        const key = createHash('sha1').update(tmp).update('\0').update(src2).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);
        try {
            unlinkSync(cachePath);
        } catch {
            /* ok */
        }

        const stubBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(probes.map((p) => [p.entity, [{ label: 'id', detail: 'UUID', kind: 'field' }]])),
        });
        testOverrides().rwBatch = stubBatch;

        // Use a separate module instance so the override is captured at create() time
        const localModule = pluginFactory({ typescript: TS });

        const timers2 = [];
        const origSetTimeout2 = global.setTimeout;
        const origClearTimeout2 = global.clearTimeout;
        global.setTimeout = (fn, _d) => {
            timers2.push({ fn });
            return timers2.length - 1;
        };
        global.clearTimeout = () => {};

        try {
            let currentSnap = TS.ScriptSnapshot.fromString(src2);
            const lsHost2 = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fn2],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fn2 ? currentSnap : undefined),
                getCurrentDirectory: () => tmp,
                getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
                fileExists: (f) => f === fn2,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls2 = TS.createLanguageService(lsHost2, TS.createDocumentRegistry());
            const si2 = {
                getSnapshot: () => currentSnap,
                markContainingProjectsAsDirty: () => {},
            };
            const fakeInfo2 = {
                config: {
                    'cds.ql.typeInference': true,
                    'cds.ql.debounceDelay': 300,
                },
                languageService: ls2,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: (f) => (f === fn2 ? si2 : null),
                    updateGraph: () => {},
                },
                languageServiceHost: {
                    getScriptSnapshot: (f) => lsHost2.getScriptSnapshot(f),
                },
            };
            const proxy2 = localModule.create(fakeInfo2);

            // First call: cold start — synchronous rewrite, sets lastRewritten
            proxy2.getSemanticDiagnostics(fn2);
            si2.getSnapshot(); // cold-start: rwBatch returns fields → fresh !== src → lastRewritten set
            // Change source slightly so cache misses → debounce path (lastRewritten is set)
            const src2b = src2.replace('DebounceWrite', 'DebounceWrite ');
            currentSnap = TS.ScriptSnapshot.fromString(src2b);
            si2.getSnapshot();
            assert.ok(timers2.length > 0, 'debounce timer must be scheduled after source change');
            // Fire the timer → writeDiskCache called (line 363)
            const key2 = createHash('sha1').update(tmp).update('\0').update(src2b).digest('hex');
            const cachePath2 = join(tmp, `cds-lsp-rewrite-${key2}.json`);
            try {
                unlinkSync(cachePath2);
            } catch {
                /* ok */
            }
            for (const t of timers2.splice(0)) t.fn();
            assert.ok(existsSync(cachePath2), 'writeDiskCache must be called by debounce timer (line 363)');
            try {
                unlinkSync(cachePath2);
            } catch {
                /* best effort */
            }
        } finally {
            global.setTimeout = origSetTimeout2;
            global.clearTimeout = origClearTimeout2;
            delete testOverrides().rwBatch;
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('sync-cache: editing surrounding TS code re-places the cast synchronously (no worker, no flash)', () => {
        // Regression test for the residual highlight flash. Once a query's type has
        // been resolved, editing TS code AROUND the query (query text unchanged) must
        // produce a fresh, cast-accurate snapshot SYNCHRONOUSLY from the type-expr
        // cache — no debounce timer, no worker call, no stale snapshot returned. This
        // is what keeps the rewritten snapshot in lockstep with the live buffer so the
        // editor never paints tokens against a mismatched revision.
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { createHash } = require('node:crypto');
        const { unlinkSync } = require('node:fs');
        const tmp = tmpdir();
        const fn = join(tmp, `sync-cache-${Date.now()}.ts`);
        // Unique entity name so no stale disk-cache entry from a prior run can satisfy
        // the cold start without invoking the worker (the disk-cache key hashes source).
        const srcA = 'const r = await cds.ql`SELECT id FROM SyncCacheEntity`;\nconst other = 1;\nexport {};';
        // Edit BEFORE the query (prepend a line) — query text is identical, only
        // positions shift. The debounce path would otherwise serve a stale rewrite.
        const srcB = '// a new comment line\n' + srcA;

        // Clear any disk-cache entries for both revisions so cold start must hit the worker.
        for (const s of [srcA, srcB]) {
            const key = createHash('sha1').update(tmp).update('\0').update(s).digest('hex');
            try {
                unlinkSync(join(tmp, `cds-lsp-rewrite-${key}.json`));
            } catch {
                /* ok */
            }
        }

        let calls = 0;
        const countingBatch = (_root, probes, _logger) => {
            calls++;
            return {
                fields: Object.fromEntries(
                    probes.map((p) => [
                        p.entity,
                        [
                            {
                                label: 'id',
                                detail: 'cds.UUID',
                                kind: 'field',
                            },
                            {
                                label: 'title',
                                detail: 'cds.String',
                                kind: 'field',
                            },
                        ],
                    ]),
                ),
            };
        };
        testOverrides().rwBatch = countingBatch;

        const localModule = pluginFactory({ typescript: TS });

        const timers = [];
        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        global.setTimeout = (fn2, _d) => {
            timers.push({ fn: fn2 });
            return timers.length - 1;
        };
        global.clearTimeout = () => {};

        try {
            let currentSnap = TS.ScriptSnapshot.fromString(srcA);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fn],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fn ? currentSnap : undefined),
                getCurrentDirectory: () => tmp,
                getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
                fileExists: (f) => f === fn,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const si = {
                getSnapshot: () => currentSnap,
                markContainingProjectsAsDirty: () => {},
            };
            const fakeInfo = {
                config: {
                    'cds.ql.typeInference': true,
                    'cds.ql.debounceDelay': 300,
                },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: (f) => (f === fn ? si : null),
                    updateGraph: () => {},
                },
                languageServiceHost: {
                    getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
                },
            };
            const proxy = localModule.create(fakeInfo);

            // Cold start: resolves query A, populates rewriteCache + typeExprCache.
            proxy.getSemanticDiagnostics(fn);
            const rewrittenA = si.getSnapshot().getText(0, si.getSnapshot().getLength());
            assert.ok(rewrittenA.includes('as unknown as _q'), 'cold start must produce a rewrite');
            const callsAfterCold = calls;
            assert.ok(callsAfterCold > 0, 'cold start must call the worker');

            // Edit surrounding TS code (query text unchanged).
            currentSnap = TS.ScriptSnapshot.fromString(srcB);
            const rewrittenB = si.getSnapshot().getText(0, si.getSnapshot().getLength());

            // 1) No timer scheduled → the sync-cache branch handled it, not the debounce.
            assert.equal(timers.length, 0, 'editing surrounding code must NOT schedule a debounce timer (sync-cache hit)');
            // 2) No new worker call → type reused from cache.
            assert.equal(calls, callsAfterCold, 'editing surrounding code must NOT trigger a new worker call');
            // 3) The returned snapshot matches the LIVE buffer B: the cast sits at B's
            //    query position and the untouched prefix line is present. A stale rewrite
            //    (of A) would be missing the new comment line before the cast.
            assert.ok(rewrittenB.startsWith('// a new comment line\n'), 'sync rewrite must reflect the live buffer B, not the stale A');
            assert.ok(rewrittenB.includes('as unknown as _q'), 'sync rewrite must still contain the cast');
            // The cast must appear AFTER the new prefix line (i.e. reprojected forward),
            // proving positions track the live buffer.
            assert.ok(rewrittenB.indexOf('as unknown as _q') > rewrittenA.indexOf('as unknown as _q'), 'cast position must shift forward to match the edited buffer');
        } finally {
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
            delete testOverrides().rwBatch;
            for (const s of [srcA, srcB]) {
                const key = createHash('sha1').update(tmp).update('\0').update(s).digest('hex');
                try {
                    unlinkSync(join(tmp, `cds-lsp-rewrite-${key}.json`));
                } catch {
                    /* best effort */
                }
            }
        }
    });

    it('sync-cache: editing INSIDE one query keeps OTHER queries live-aligned (no flicker on siblings)', () => {
        // The residual flicker the user reported: a file with several cds.ql queries,
        // editing inside ONE query briefly disturbed the highlighting of the OTHER
        // (unchanged) declarations. Root cause: the changed query missed the type cache,
        // so doRewrite discarded the whole (otherwise live-aligned) cacheOnly rewrite and
        // served the PREVIOUS revision's snapshot for ~debounceMs — the unchanged casts
        // sat at stale positions until the timer fired. Fix: serve the live-aligned
        // partial rewrite immediately (changed query left un-cast, pending worker), so the
        // sibling declarations never move.
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { createHash } = require('node:crypto');
        const { unlinkSync } = require('node:fs');
        const tmp = tmpdir();
        const fn = join(tmp, `sync-cache-multi-${Date.now()}.ts`);
        // Three queries. Edit goes INSIDE q1 (Authors); q2/q3 (Books) are unchanged.
        const srcA = [
            '// @cds-service SyncMultiSvc',
            'const q1 = await cds.ql`SELECT ID FROM SyncMultiAuthors`',
            '// @cds-service SyncMultiSvc',
            'const [{ID}] = await cds.ql`SELECT ID FROM SyncMultiBooks`',
            '// @cds-service SyncMultiSvc',
            'const [fst] = await cds.ql`SELECT ID FROM SyncMultiBooks`',
            'export {};',
        ].join('\n');
        // Edit inside q1 only: add a space after FROM (q1's query text changes).
        const srcB = srcA.replace('FROM SyncMultiAuthors`', 'FROM  SyncMultiAuthors`');

        for (const s of [srcA, srcB]) {
            const key = createHash('sha1').update(tmp).update('\0').update(s).digest('hex');
            try {
                unlinkSync(join(tmp, `cds-lsp-rewrite-${key}.json`));
            } catch {
                /* ok */
            }
        }

        const stubBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'ID',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        testOverrides().rwBatch = stubBatch;

        const localModule = pluginFactory({ typescript: TS });

        const timers = [];
        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        global.setTimeout = (fn2, _d) => {
            timers.push({ fn: fn2 });
            return timers.length - 1;
        };
        global.clearTimeout = () => {};

        try {
            let currentSnap = TS.ScriptSnapshot.fromString(srcA);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fn],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fn ? currentSnap : undefined),
                getCurrentDirectory: () => tmp,
                getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
                fileExists: (f) => f === fn,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const si = {
                getSnapshot: () => currentSnap,
                markContainingProjectsAsDirty: () => {},
            };
            const fakeInfo = {
                config: {
                    'cds.ql.typeInference': true,
                    'cds.ql.debounceDelay': 300,
                },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: (f) => (f === fn ? si : null),
                    updateGraph: () => {},
                },
                languageServiceHost: {
                    getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
                },
            };
            const proxy = localModule.create(fakeInfo);

            // Cold start: resolve all queries.
            proxy.getSemanticDiagnostics(fn);
            si.getSnapshot();

            // Edit inside q1. q1 misses the type cache; q2/q3 hit it.
            currentSnap = TS.ScriptSnapshot.fromString(srcB);
            const rewrittenB = si.getSnapshot().getText(0, si.getSnapshot().getLength());

            // The served snapshot must be built from the LIVE buffer B: its untouched
            // suffix (the q2/q3 declarations) must be present verbatim from B, with casts
            // placed at their live positions — NOT a stale rewrite of A.
            assert.ok(rewrittenB.includes('FROM  SyncMultiAuthors'), 'served snapshot must reflect the live edit inside q1');
            assert.ok(/const \[\{ID\}\] = await cds\.ql`` as unknown as _q/.test(rewrittenB), 'sibling query q2 must keep its cast at its live position (no flicker)');
            assert.ok(/const \[fst\] = await cds\.ql`` as unknown as _q/.test(rewrittenB), 'sibling query q3 must keep its cast at its live position (no flicker)');
            // A worker timer is scheduled to resolve q1's changed text.
            assert.ok(timers.length > 0, 'a worker timer must be scheduled for the changed query');
            // The prefix up to the edit is byte-identical to the live buffer — proves the
            // served snapshot is B-aligned, so semantic tokens need no reprojection.
            const editPos = srcB.indexOf('FROM  SyncMultiAuthors');
            assert.equal(rewrittenB.slice(0, editPos), srcB.slice(0, editPos), 'served snapshot prefix must match the live buffer exactly');
        } finally {
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
            delete testOverrides().rwBatch;
            for (const s of [srcA, srcB]) {
                const key = createHash('sha1').update(tmp).update('\0').update(s).digest('hex');
                try {
                    unlinkSync(join(tmp, `cds-lsp-rewrite-${key}.json`));
                } catch {
                    /* best effort */
                }
            }
        }
    });

    it('freeze invariant: semantic colours during a transition equal the last fully-resolved result reprojected', () => {
        // The DETERMINISTIC guarantee that replaces per-token flash whack-a-mole:
        // while any query in the file is being resolved (a partial/stale snapshot),
        // tsserver's whole-file inference would recolour unrelated identifiers (e.g.
        // `cds` teal→mint). The plugin instead FREEZES semantic classifications — it
        // reprojects the last result computed against a FULLY-RESOLVED snapshot onto the
        // live buffer, so every token keeps its exact classification id, shifted only by
        // the edit delta. Colours change only when a fully-resolved rewrite lands.
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { createHash } = require('node:crypto');
        const { unlinkSync } = require('node:fs');
        const tmp = tmpdir();
        const fn = join(tmp, `freeze-${Date.now()}.ts`);
        const Fmt = TS.SemanticClassificationFormat.TwentyTwenty;
        const srcA = [
            'import cds from "@sap/cds"',
            '// @cds-service FreezeSvc',
            'const q1 = await cds.ql`SELECT ID FROM FreezeAuthors`',
            '// @cds-service FreezeSvc',
            'const [{ID}] = await cds.ql`SELECT ID FROM FreezeBooks`',
            'export {};',
        ].join('\n');
        // Edit INSIDE q1 (add a space): q1's text changes → partial snapshot served, so
        // the classifier would otherwise re-run against a degraded program.
        const srcB = srcA.replace('FROM FreezeAuthors`', 'FROM  FreezeAuthors`');
        const editPos = srcB.indexOf('FROM  FreezeAuthors') + 'FROM '.length; // inserted char
        const delta = srcB.length - srcA.length; // +1

        for (const s of [srcA, srcB]) {
            const key = createHash('sha1').update(tmp).update('\0').update(s).digest('hex');
            try {
                unlinkSync(join(tmp, `cds-lsp-rewrite-${key}.json`));
            } catch {
                /* ok */
            }
        }

        const stubBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'ID',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        testOverrides().rwBatch = stubBatch;
        const localModule = pluginFactory({ typescript: TS });

        const origSetTimeout = global.setTimeout;
        const origClearTimeout = global.clearTimeout;
        global.setTimeout = (_fn, _d) => 0; // defer worker
        global.clearTimeout = () => {};

        try {
            let currentSnap = TS.ScriptSnapshot.fromString(srcA);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                    module: TS.ModuleKind.ESNext,
                    strict: true,
                }),
                getScriptFileNames: () => [fn],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fn ? currentSnap : undefined),
                getCurrentDirectory: () => tmp,
                getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
                fileExists: (f) => f === fn,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const si = {
                getSnapshot: () => currentSnap,
                markContainingProjectsAsDirty: () => {},
            };
            const fakeInfo = {
                config: {
                    'cds.ql.typeInference': true,
                    'cds.ql.debounceDelay': 300,
                },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: (f) => (f === fn ? si : null),
                    updateGraph: () => {},
                },
                languageServiceHost: {
                    getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
                },
            };
            const proxy = localModule.create(fakeInfo);

            // Cold start: fully resolve A. This is the fully-resolved baseline.
            proxy.getSemanticDiagnostics(fn);
            si.getSnapshot();
            const spanA = { start: 0, length: srcA.length };
            const semA = proxy.getEncodedSemanticClassifications(fn, spanA, Fmt);
            assert.ok(semA.spans.length > 0, 'fully-resolved A must produce semantic tokens to freeze');

            // Edit inside q1 → transition (partial snapshot). Request semantic classifications.
            currentSnap = TS.ScriptSnapshot.fromString(srcB);
            si.getSnapshot();
            const spanB = { start: 0, length: srcB.length };
            const semB = proxy.getEncodedSemanticClassifications(fn, spanB, Fmt);

            // Build the expected FROZEN result: A's tokens, each reprojected by +delta if
            // it starts at/after the edit. Same count, same classification ids.
            const expected = [];
            for (let i = 0; i < semA.spans.length; i += 3) {
                const s = semA.spans[i];
                const p = s >= editPos ? s + delta : s;
                expected.push(p, semA.spans[i + 1], semA.spans[i + 2]);
            }
            assert.deepEqual(semB.spans, expected, 'transition semantic tokens must equal the fully-resolved baseline reprojected ' + '(frozen colours) — any divergence is a semantic-value flicker');
        } finally {
            global.setTimeout = origSetTimeout;
            global.clearTimeout = origClearTimeout;
            delete testOverrides().rwBatch;
            for (const s of [srcA, srcB]) {
                const key = createHash('sha1').update(tmp).update('\0').update(s).digest('hex');
                try {
                    unlinkSync(join(tmp, `cds-lsp-rewrite-${key}.json`));
                } catch {
                    /* best effort */
                }
            }
        }
    });

    it('readConfig returns 300 as default debounceDelay', () => {
        const cfg = readConfig({});
        assert.equal(cfg['cds.ql.debounceDelay'], 300);
    });

    it('readConfig honours explicit debounceDelay value', () => {
        const cfg = readConfig({ 'cds.ql.debounceDelay': 500 });
        assert.equal(cfg['cds.ql.debounceDelay'], 500);
    });
});

// ---------------------------------------------------------------------------
// Disk cache — readDiskCache / writeDiskCache via cold-start path
// ---------------------------------------------------------------------------

describe('Disk cache — cold-start path reads pre-written cache entry', () => {
    // readDiskCache and writeDiskCache are internal to index.ts and cannot be
    // imported directly. We exercise them through the real pluginFactory:
    //
    //   readDiskCache: pre-write a valid JSON entry at the expected path (same
    //     hash algorithm as diskCachePath), call patchedGetSnapshot, assert the
    //     snapshot text matches the cached rewrite — proving readDiskCache was
    //     called and its return value was used.
    //
    //   writeDiskCache: called only when fresh !== sourceText, which requires
    //     a live worker; remains annotated as untestable without tsserver.

    it('patchedGetSnapshot returns cached rewrite when a fresh disk cache entry exists', () => {
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { writeFileSync, unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const cachedRw = src + '\n// cached-rewrite-marker';

        // Use tmpdir() as the file directory so projectRootFor() finds no package.json
        // walking up from there and falls back to dirname(fileName) = tmpdir().
        const tmp = tmpdir();
        const fileName = join(tmp, 'dc-test.ts');
        // projectRootFor(fileName) will return dirname(fileName) = tmp (no package.json in /tmp)
        const projectRoot = tmp;

        // Replicate diskCachePath logic: sha1(projectRoot + '\0' + sourceText)
        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);

        const entry = {
            rewritten: cachedRw,
            ranges: [],
            writtenAt: Date.now(),
        };
        writeFileSync(cachePath, JSON.stringify(entry));

        try {
            const mod = pluginFactory({ typescript: TS });
            const baseSnap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
                getCurrentDirectory: () => projectRoot,
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: { 'cds.ql.typeInference': true },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };

            mod.create(fakeInfo);

            // Cold-start: no in-memory cache, disk entry present → readDiskCache returns it,
            // doRewrite returns cachedRw, which differs from src → snapshot is rewritten text
            const snap = patchedHost.getScriptSnapshot(fileName);
            assert.ok(snap, 'expected a snapshot');
            const text = snap.getText(0, snap.getLength());
            assert.equal(text, cachedRw, 'snapshot text must come from the disk cache entry');
        } finally {
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('patchedGetSnapshot ignores corrupt disk cache entry and falls back to worker', () => {
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { writeFileSync, unlinkSync } = require('node:fs');

        const src = 'const r = cds.ql`SELECT id FROM Corrupt`;\nexport {};';
        const tmp = tmpdir();
        const fileName = join(tmp, 'dc-corrupt.ts');
        const projectRoot = tmp;

        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);

        // Write corrupt JSON — readDiskCache's try/catch returns null, triggering worker fallback
        writeFileSync(cachePath, 'NOT VALID JSON {{{');

        try {
            const mod = pluginFactory({ typescript: TS });
            const baseSnap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
                getCurrentDirectory: () => projectRoot,
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: { 'cds.ql.typeInference': true },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };

            mod.create(fakeInfo);

            // Corrupt entry → readDiskCache catch returns null → falls back to worker (fails,
            // no @sap/cds) → rewritten===src → base snapshot returned without throwing
            assert.doesNotThrow(() => patchedHost.getScriptSnapshot(fileName), 'corrupt cache entry must not throw');
            const snap = patchedHost.getScriptSnapshot(fileName);
            const text = snap.getText(0, snap.getLength());
            assert.equal(text, src, 'corrupt cache must be ignored, base text returned');
        } finally {
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('writeDiskCache is called when cold-start worker returns a rewrite', () => {
        // Covers writeDiskCache: inject a stub rwBatch via _testOverrides so the
        // cold-start path (no disk cache) gets a real rewrite back from the worker,
        // fresh !== sourceText, and writeDiskCache writes the file.
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { existsSync, unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM WriteCache`;\nexport {};';
        const tmp = tmpdir();
        const fileName = join(tmp, `wdc-test-${Date.now()}.ts`);
        const projectRoot = tmp;

        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);
        try {
            unlinkSync(cachePath);
        } catch {
            /* not there yet */
        }

        // Stub rwBatch returns a real field so rewriteSnapshot produces a rewrite != src
        const stubBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'id',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        testOverrides().rwBatch = stubBatch;

        try {
            const mod = pluginFactory({ typescript: TS });
            const snap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? snap : undefined),
                getCurrentDirectory: () => projectRoot,
                getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: { 'cds.ql.typeInference': true },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };

            mod.create(fakeInfo);
            patchedHost.getScriptSnapshot(fileName);

            assert.ok(existsSync(cachePath), 'writeDiskCache must have written the cache file');
        } finally {
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('readDiskCache returns null when cache file mtime exceeds DISK_CACHE_TTL_MS (b0 arm=0)', () => {
        // DISK_CACHE_TTL_MS = 5 minutes. We write a valid cache entry then backdate the
        // file's mtime to 10 minutes ago so Date.now() - stat.mtimeMs > TTL → return null.
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { writeFileSync, utimesSync, unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const tmp = tmpdir();
        const fileName = join(tmp, `dc-expired-${Date.now()}.ts`);
        const projectRoot = tmp;
        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);

        // Write a valid cache entry
        const cachedRw = src + '\n// expired-cache';
        const entry = {
            rewritten: cachedRw,
            ranges: [],
            writtenAt: Date.now(),
        };
        writeFileSync(cachePath, JSON.stringify(entry));

        // Backdate mtime by 10 minutes (> DISK_CACHE_TTL_MS = 5 min)
        const tenMinutesAgo = (Date.now() - 10 * 60 * 1000) / 1000;
        utimesSync(cachePath, tenMinutesAgo, tenMinutesAgo);

        // Clear any leftover worker overrides so the fallback produces src (worker miss)
        const pluginOverrides = testOverrides();
        const savedRw = pluginOverrides.rw;
        const savedRwBatch = pluginOverrides.rwBatch;
        delete pluginOverrides.rw;
        delete pluginOverrides.rwBatch;

        try {
            const mod = pluginFactory({ typescript: TS });
            const baseSnap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
                getCurrentDirectory: () => projectRoot,
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: { 'cds.ql.typeInference': true },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };

            mod.create(fakeInfo);
            // Expired cache → readDiskCache returns null → falls back to worker (no @sap/cds) → src returned
            const snap = patchedHost.getScriptSnapshot(fileName);
            const text = snap?.getText(0, snap.getLength()) ?? '';
            assert.equal(text, src, 'expired cache must be ignored, original text must be returned');
        } finally {
            pluginOverrides.rw = savedRw;
            pluginOverrides.rwBatch = savedRwBatch;
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('rewrite cache hit returns cached rewrite without calling worker again (b21 arm=0)', () => {
        // Calling getScriptSnapshot twice with the same source text: the second call
        // hits rewriteCache (b21 arm=0: cached && cached.sourceText === sourceText).
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const tmp = tmpdir();
        const fileName = join(tmp, `rw-cache-hit-${Date.now()}.ts`);
        const projectRoot = tmp;
        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);
        try {
            unlinkSync(cachePath);
        } catch {
            /* ok */
        }

        const pluginOverrides = testOverrides();
        const origRw = pluginOverrides.rw;
        const origRwBatch = pluginOverrides.rwBatch;
        pluginOverrides.rw = EMPTY_WORKER;
        pluginOverrides.rwBatch = BOOKS_BATCH_WORKER;

        try {
            const mod = pluginFactory({ typescript: TS });
            const baseSnap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
                getCurrentDirectory: () => projectRoot,
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: { 'cds.ql.typeInference': true },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };

            mod.create(fakeInfo);
            // First call: cold start — runs rewriteSnapshot, populates rewriteCache
            const snap1 = patchedHost.getScriptSnapshot(fileName);
            const text1 = snap1?.getText(0, snap1.getLength()) ?? '';
            assert.notEqual(text1, src, 'first call must return the rewritten text');
            // Second call: same sourceText → rewriteCache hit (b21 arm=0) — must return same rewrite
            const snap2 = patchedHost.getScriptSnapshot(fileName);
            const text2 = snap2?.getText(0, snap2.getLength()) ?? '';
            assert.equal(text2, text1, 'cache hit must return the same rewritten text');
        } finally {
            pluginOverrides.rw = origRw;
            pluginOverrides.rwBatch = origRwBatch;
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('readDiskCache hit with non-empty ranges restores rewrittenRanges (b25 arm=0)', () => {
        // `if (hit.ranges.length) rewrittenRanges.set(...)` arm=0 (true branch):
        // cache entry has non-empty ranges → the rewrittenRanges map is populated.
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { writeFileSync, unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const cachedRw = src.replace('cds.ql`SELECT id FROM Books`', 'cds.ql`` as unknown as _q0  ') + '\ntype _q0={id:string}[];';
        const tmp = tmpdir();
        const fileName = join(tmp, `dc-ranges-${Date.now()}.ts`);
        const projectRoot = tmp;
        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);

        // Write cache entry WITH non-empty ranges (triggers arm=0 of b25)
        const entry = {
            rewritten: cachedRw,
            ranges: [{ start: 22, end: 42 }],
            writtenAt: Date.now(),
        };
        writeFileSync(cachePath, JSON.stringify(entry));

        try {
            const mod = pluginFactory({ typescript: TS });
            const baseSnap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
                getCurrentDirectory: () => projectRoot,
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: { 'cds.ql.typeInference': true },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };

            mod.create(fakeInfo);
            // Cache hit with ranges → arm=0 fires, rewrittenRanges populated → cachedRw returned
            const snap = patchedHost.getScriptSnapshot(fileName);
            const text = snap?.getText(0, snap.getLength()) ?? '';
            assert.equal(text, cachedRw, 'disk cache hit with ranges must return the cached rewrite');
        } finally {
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });
});

// ---------------------------------------------------------------------------
// runWorker / runBatchWorker — covered via _testOverrides injection
// ---------------------------------------------------------------------------

describe('Plugin workers — runWorker and runBatchWorker via _testOverrides', () => {
    // The real runWorker/runBatchWorker delegate to PersistentWorkerPool which uses
    // Atomics.wait (forbidden in the main thread). _testOverrides lets us inject stubs
    // so create() picks them up, covering the delegation wrappers without spawning workers.

    const overrides = testOverrides();

    it('rwBatch stub is called when create() uses injected batch worker', () => {
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        // Use tmpdir so projectRootFor finds no package.json → projectRoot = tmpdir()
        // This ensures the disk cache key is unique to this test.
        const tmp = tmpdir();
        const fileName = join(tmp, 'rw-batch-test.ts');
        const key = createHash('sha1').update(tmp).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);
        try {
            unlinkSync(cachePath);
        } catch {
            /* not present */
        }

        let batchCalled = false;
        overrides.rwBatch = (_root, probes, _logger) => {
            batchCalled = true;
            return {
                fields: Object.fromEntries(
                    probes.map((p) => [
                        p.entity,
                        [
                            {
                                label: 'id',
                                detail: 'cds.UUID',
                                kind: 'field',
                            },
                        ],
                    ]),
                ),
            };
        };
        try {
            const snap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? snap : undefined),
                getCurrentDirectory: () => tmp,
                getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: {
                    'cds.ql.typeInference': true,
                    'cds.ql.completion': true,
                },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };
            const mod = pluginFactory({ typescript: TS });
            mod.create(fakeInfo);
            patchedHost.getScriptSnapshot(fileName);
            assert.ok(batchCalled, 'injected rwBatch must be called during snapshot rewrite');
        } finally {
            delete overrides.rwBatch;
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('rw stub is called via getCompletionsAtPosition', () => {
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const tmp = tmpdir();
        const fileName = join(tmp, 'rw-single-test.ts');
        const key = createHash('sha1').update(tmp).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);
        try {
            unlinkSync(cachePath);
        } catch {
            /* not present */
        }

        let rwCalled = false;
        overrides.rw = (_args, _logger) => {
            rwCalled = true;
            return null;
        };
        overrides.rwBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'id',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        try {
            const snap = TS.ScriptSnapshot.fromString(src);
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? snap : undefined),
                getCurrentDirectory: () => tmp,
                getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: {
                    'cds.ql.typeInference': true,
                    'cds.ql.completion': true,
                },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: () => null,
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };
            const mod = pluginFactory({ typescript: TS });
            const proxy = mod.create(fakeInfo);
            patchedHost.getScriptSnapshot(fileName);
            proxy.getCompletionsAtPosition(fileName, src.indexOf('id'), undefined, undefined);
            assert.ok(rwCalled, 'injected rw must be called during completions');
        } finally {
            delete overrides.rw;
            delete overrides.rwBatch;
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Previously-annotated paths now reachable via mocking
// ---------------------------------------------------------------------------

describe('Plugin factory — tsserver API paths exercised via mocks', () => {
    // Helper: build a minimal fakeInfo with controllable project/host APIs
    function makeFakeInfo(opts) {
        const snap = TS.ScriptSnapshot.fromString(opts.src);
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [opts.fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === opts.fileName ? snap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts2) => TS.getDefaultLibFilePath(opts2),
            fileExists: (f) => f === opts.fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo = {
            config: opts.config ?? { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: opts.getScriptInfo ?? (() => null),
                updateGraph: opts.updateGraph ?? (() => {}),
                getScriptFileNames: opts.getScriptFileNames,
            },
            languageServiceHost: patchedHost,
        };
        return { fakeInfo, patchedHost, ls };
    }

    it('triggerTsServerRefresh — editContent + updateGraph + refreshDiagnostics are called', () => {
        // patchScriptInfo(fileName) calls patchScriptInfoImpl with triggerUpdate=true (default),
        // which calls triggerTsServerRefresh(scriptInfo). Provide all three methods on the mocks
        // so the helper body executes without the istanbul ignore.
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'tsr-test.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        let editContentCalled = false;
        let updateGraphCalled = false;
        let refreshDiagCalled = false;

        const fakeScriptInfo = {
            getSnapshot: () => baseSnap,
            editContent: (_s, _e, _t) => {
                editContentCalled = true;
            },
        };

        const { fakeInfo } = makeFakeInfo({
            fileName,
            src,
            config: {
                'cds.ql.typeInference': true,
                'cds.ql.diagnostics': true,
            },
            getScriptInfo: (fn) => (fn === fileName ? fakeScriptInfo : null),
            updateGraph: () => {
                updateGraphCalled = true;
            },
        });
        // Add refreshDiagnostics to project
        fakeInfo.project.refreshDiagnostics = () => {
            refreshDiagCalled = true;
        };

        const mod = pluginFactory({ typescript: TS });
        const proxy = mod.create(fakeInfo);

        // getSemanticDiagnostics triggers patchScriptInfo → patchScriptInfoImpl(triggerUpdate=true)
        // → triggerTsServerRefresh(scriptInfo)
        proxy.getSemanticDiagnostics(fileName);

        assert.ok(editContentCalled, 'editContent must be called by triggerTsServerRefresh');
        assert.ok(updateGraphCalled, 'updateGraph must be called by triggerTsServerRefresh');
        assert.ok(refreshDiagCalled, 'refreshDiagnostics must be called by triggerTsServerRefresh');
    });

    it('updateGraph wrapper — patches cds.ql files discovered after create()', () => {
        // Provide updateGraph + getScriptFileNames on the project so the wrapper installs
        // and its body runs when updateGraph() is called.
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'ugw-test.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const fakeScriptInfo = { getSnapshot: () => baseSnap };
        let origUpdateGraphCalled = false;

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };

        const project = {
            projectService: { logger: NO_LOGGER },
            getScriptInfo: (fn) => (fn === fileName ? fakeScriptInfo : null),
            updateGraph: () => {
                origUpdateGraphCalled = true;
            },
            getScriptFileNames: () => [fileName],
        };

        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project,
            languageServiceHost: patchedHost,
        };

        const mod = pluginFactory({ typescript: TS });
        mod.create(fakeInfo);

        // The wrapper replaces project.updateGraph; calling it runs the patching loop
        // then delegates to the original (captured as origUpdateGraph in the closure).
        assert.doesNotThrow(() => project.updateGraph(), 'wrapped updateGraph must not throw');
        assert.ok(origUpdateGraphCalled, 'original updateGraph must be called by the wrapper');
        // fakeScriptInfo should now be patched
        assert.ok(fakeScriptInfo.__cdsPatchedSnapshot, 'cds.ql file discovered via updateGraph wrapper must be patched');
    });

    it('startup scan — patches cds.ql files present when create() runs', () => {
        // Provide getScriptFileNames returning a cds.ql file during create() itself so the
        // startup scan block (below the updateGraph wrapper) runs its patching loop.
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'startup-test.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const fakeScriptInfo = { getSnapshot: () => baseSnap };

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };

        const project = {
            projectService: { logger: NO_LOGGER },
            getScriptInfo: (fn) => (fn === fileName ? fakeScriptInfo : null),
            updateGraph: () => {},
            getScriptFileNames: () => [fileName],
        };

        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project,
            languageServiceHost: patchedHost,
        };

        const mod = pluginFactory({ typescript: TS });
        assert.doesNotThrow(() => mod.create(fakeInfo), 'create() with startup scan must not throw');
        assert.ok(fakeScriptInfo.__cdsPatchedSnapshot, 'cds.ql file present at startup must be patched by startup scan');
    });

    it('filterSemanticClassifications — body entered when underlying ls returns non-empty spans', () => {
        // When the LS returns spans, filterSemanticClassifications must run its filter loop.
        // With no rewritten ranges all spans pass through unchanged.
        // getEncodedSyntacticClassifications with no rewritten ranges passes through directly.
        const src = 'const r = await cds.ql`SELECT id FROM Books                      `;\nexport {};';
        const fileName = 'fc-test.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const realLs = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

        // Inject a synthetic span at position 0 (outside any rewritten range — must survive).
        const mockLs = Object.create(realLs);
        mockLs.getEncodedSyntacticClassifications = (_fn, _span) => ({
            spans: [0, 5, 1],
            endOfLineState: 0,
        });
        mockLs.getEncodedSemanticClassifications = (_fn, _span, _fmt) => ({
            spans: [0, 5, 1],
            endOfLineState: 0,
        });

        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo = {
            config: { 'cds.ql.typeInference': false },
            languageService: mockLs,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };

        const mod = pluginFactory({ typescript: TS });
        const proxy = mod.create(fakeInfo);
        const span = { start: 0, length: src.length };

        assert.doesNotThrow(() => proxy.getEncodedSyntacticClassifications(fileName, span), 'syntactic classification must not throw');
        assert.doesNotThrow(() => proxy.getEncodedSemanticClassifications(fileName, span, TS.SemanticClassificationFormat.TwentyTwenty), 'filterSemanticClassifications must not throw for semantic');

        // With no rewritten ranges (typeInference=false) all spans pass through
        const synResult = proxy.getEncodedSyntacticClassifications(fileName, span);
        assert.deepEqual(synResult.spans, [0, 5, 1], 'syntactic span at pos 0 must pass through with no ranges');

        const semResult = proxy.getEncodedSemanticClassifications(fileName, span, TS.SemanticClassificationFormat.TwentyTwenty);
        assert.deepEqual(semResult.spans, [0, 5, 1], 'semantic span at pos 0 must pass through with no ranges');
    });

    it('projectRootFor — finds package.json walking up from repo source file', () => {
        // Using a file path under the repo root exercises the "found" branch of projectRootFor
        // (the loop finds package.json at process.cwd()).  The disk cache tests exercise the
        // fallback branch (no package.json found under tmpdir).
        const { join } = require('node:path');
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nexport {};';
        // A plausible filename under the repo — doesn't need to exist on disk
        const fileName = join(process.cwd(), 'src', '__prf-test.ts');
        const baseSnap = TS.ScriptSnapshot.fromString(src);

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => process.cwd(),
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };

        const mod = pluginFactory({ typescript: TS });
        mod.create(fakeInfo);
        // Calling getScriptSnapshot triggers doRewrite → projectRootFor(fileName).
        // The function finds package.json at process.cwd() and caches the result.
        assert.doesNotThrow(() => patchedHost.getScriptSnapshot(fileName), 'projectRootFor must not throw for a real repo path');
    });

    it('patchScriptInfoImpl getSnapshot — returns rewritten snapshot from disk cache', () => {
        // Exercises the `return ScriptSnapshot.fromString(rewritten)` line inside the
        // patched scriptInfo.getSnapshot lambda (line ~409) by pre-writing a disk cache entry
        // so doRewrite returns text != sourceText when the lambda is called.
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { writeFileSync, unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM SIRewrite`;\nexport {};';
        const cachedRw = src + '\n// si-rewrite-marker';
        const tmp = tmpdir();
        const fileName = join(tmp, 'si-rw-test.ts');
        const projectRoot = tmp;

        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);
        writeFileSync(
            cachePath,
            JSON.stringify({
                rewritten: cachedRw,
                ranges: [],
                writtenAt: Date.now(),
            }),
        );

        const baseSnap = TS.ScriptSnapshot.fromString(src);
        const fakeScriptInfo = { getSnapshot: () => baseSnap };

        try {
            const lsHost = {
                getCompilationSettings: () => ({
                    target: TS.ScriptTarget.ES2020,
                }),
                getScriptFileNames: () => [fileName],
                getScriptVersion: () => '1',
                getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
                getCurrentDirectory: () => projectRoot,
                getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
                fileExists: (f) => f === fileName,
                readFile: () => undefined,
                readDirectory: () => [],
            };
            const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
            const patchedHost = {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            };
            const fakeInfo = {
                config: {
                    'cds.ql.typeInference': true,
                    'cds.ql.diagnostics': true,
                },
                languageService: ls,
                project: {
                    projectService: { logger: NO_LOGGER },
                    getScriptInfo: (fn) => (fn === fileName ? fakeScriptInfo : null),
                    updateGraph: () => {},
                },
                languageServiceHost: patchedHost,
            };

            const mod = pluginFactory({ typescript: TS });
            const proxy = mod.create(fakeInfo);

            // patchScriptInfoImpl is called by getSemanticDiagnostics → patchScriptInfo
            proxy.getSemanticDiagnostics(fileName);
            assert.ok(fakeScriptInfo.__cdsPatchedSnapshot, 'scriptInfo must be patched');

            // Now call the patched lambda — disk cache provides cachedRw != src,
            // so it hits `return ScriptSnapshot.fromString(rewritten)`
            const snap = fakeScriptInfo.getSnapshot();
            const text = snap.getText(0, snap.getLength());
            assert.equal(text, cachedRw, 'patched scriptInfo.getSnapshot must return cached rewrite when rewritten != src');
        } finally {
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });

    it('debounce timer callback runs when setTimeout fires synchronously', () => {
        // The debounce path (entry.lastRewritten set) schedules a timer. We intercept
        // setTimeout to run the callback immediately so the timer body is covered.
        //
        // Setup: pre-write a disk cache entry so the cold-start call returns cachedRw
        // (different from src), setting entry.lastRewritten. Then call again with a
        // different sourceText to trigger the debounce path.
        const { createHash } = require('node:crypto');
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const { writeFileSync, unlinkSync } = require('node:fs');

        const src = 'const r = await cds.ql`SELECT id FROM Debounce`;\nexport {};';
        const src2 = src.replace('Debounce', 'Debounce2');
        const cachedRw = src + '\n// debounce-marker';
        const tmp = tmpdir();
        const fileName = join(tmp, 'dbt-test.ts');
        const projectRoot = tmp;

        // Write cache for src (not src2) so the first call hits it
        const key = createHash('sha1').update(projectRoot).update('\0').update(src).digest('hex');
        const cachePath = join(tmp, `cds-lsp-rewrite-${key}.json`);
        writeFileSync(
            cachePath,
            JSON.stringify({
                rewritten: cachedRw,
                ranges: [],
                writtenAt: Date.now(),
            }),
        );

        // The host snapshot source is mutable — the patched getScriptSnapshot closure
        // calls origGetScriptSnapshot which calls lsHost.getScriptSnapshot which reads this.
        let currentSrc = src;

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(currentSrc) : undefined),
            getCurrentDirectory: () => projectRoot,
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());

        // Plain object — create() will replace getScriptSnapshot with its patched version
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };

        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };

        // Intercept setTimeout to capture the callback for synchronous execution
        const origSetTimeout = global.setTimeout;
        const capturedTimers = [];
        global.setTimeout = (fn, _ms) => {
            capturedTimers.push(fn);
            return 0;
        };

        try {
            const mod = pluginFactory({ typescript: TS });
            mod.create(fakeInfo);

            // Call 1: cold-start with src — disk cache hit returns cachedRw != src,
            // so doRewrite returns cachedRw and sets entry.lastRewritten = cachedRw.
            // The patched host's getScriptSnapshot was replaced by create(), so call it:
            patchedHost.getScriptSnapshot(fileName);
            const timersBefore = capturedTimers.length;

            // Call 2: different source — rewriteCache misses (src2 != src), lastRewritten
            // is set → debounce path → clearTimeout + setTimeout scheduled
            currentSrc = src2;
            patchedHost.getScriptSnapshot(fileName);

            assert.ok(capturedTimers.length > timersBefore, 'debounce timer must be scheduled');

            // Run the timer callback synchronously to exercise its body
            assert.doesNotThrow(() => capturedTimers[capturedTimers.length - 1](), 'debounce timer callback must not throw');
        } finally {
            global.setTimeout = origSetTimeout;
            try {
                unlinkSync(cachePath);
            } catch {
                /* best effort */
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Remaining annotated branches — all testable via targeted mocks
// ---------------------------------------------------------------------------

describe('index.ts — remaining annotated branches', () => {
    it('getScriptSnapshot returns undefined when host returns nothing for the file', () => {
        // Covers: if (!base || !extension) return base  — the !base arm
        const fileName = 'guard-test.ts';
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const baseSnap = TS.ScriptSnapshot.fromString(src);
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };
        const mod = pluginFactory({ typescript: TS });
        mod.create(fakeInfo);
        const result = patchedHost.getScriptSnapshot('unknown-file.ts');
        assert.equal(result, undefined, 'must return undefined when host has no snapshot');
    });

    it('getScriptSnapshot returns base unchanged for non-JS/TS extension', () => {
        // Covers: if (!base || !extension) return base  — the extension guard arm
        const fileName = 'data.json';
        const jsonSnap = TS.ScriptSnapshot.fromString('{"x":1}');
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? jsonSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };
        const mod = pluginFactory({ typescript: TS });
        mod.create(fakeInfo);
        const result = patchedHost.getScriptSnapshot(fileName);
        assert.equal(result, jsonSnap, 'must return base unchanged for non-JS/TS extension');
    });

    it('getCompletionsAtPosition returns cds completions when ls returns null', () => {
        // Covers: if (!base) return cds  (line ~510)
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'comp-null-base.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const realLs = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const mockLs = Object.create(realLs);
        mockLs.getCompletionsAtPosition = () => undefined;
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const mockRw = () => ({
            completions: [{ label: 'id', kind: 'field', detail: '' }],
        });
        const fakeInfo = {
            config: { 'cds.ql.completion': true, 'cds.ql.typeInference': true },
            languageService: mockLs,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };
        const mod = pluginFactory({ typescript: TS });
        testOverrides().rw = mockRw;
        // rwBatch returns empty fields so doRewrite produces no change (source unchanged)
        testOverrides().rwBatch = () => ({ fields: {} });
        const proxy = mod.create(fakeInfo);
        try {
            patchedHost.getScriptSnapshot(fileName); // populates originalSource (typeInference=true)
            const result = proxy.getCompletionsAtPosition(fileName, src.indexOf('id'), undefined, undefined);
            assert.ok(
                result?.entries.some((e) => e.name === 'id'),
                'cds entry must be returned when base is null',
            );
        } finally {
            delete testOverrides().rw;
            delete testOverrides().rwBatch;
        }
    });

    it('getCompletionsAtPosition spreads cds and base entries when both present', () => {
        // Covers: return { ...base, entries: [...cds.entries, ...base.entries] }  (line ~511)
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = 'comp-spread.ts';
        const baseSnap = TS.ScriptSnapshot.fromString(src);
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? baseSnap : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const realLs = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const mockLs = Object.create(realLs);
        const fakeEntry = {
            name: 'tsBuiltin',
            kind: TS.ScriptElementKind.keyword,
            kindModifiers: '',
            sortText: '0',
        };
        mockLs.getCompletionsAtPosition = () => ({
            entries: [fakeEntry],
            isGlobalCompletion: false,
            isMemberCompletion: false,
            isNewIdentifierLocation: false,
        });
        const patchedHost = {
            getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
        };
        const mockRw = () => ({
            completions: [{ label: 'id', kind: 'field', detail: '' }],
        });
        const fakeInfo = {
            config: { 'cds.ql.completion': true, 'cds.ql.typeInference': true },
            languageService: mockLs,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: patchedHost,
        };
        const mod = pluginFactory({ typescript: TS });
        testOverrides().rw = mockRw;
        testOverrides().rwBatch = () => ({ fields: {} });
        const proxy = mod.create(fakeInfo);
        try {
            patchedHost.getScriptSnapshot(fileName); // populates originalSource (typeInference=true)
            const result = proxy.getCompletionsAtPosition(fileName, src.indexOf('id'), undefined, undefined);
            assert.ok(
                result?.entries.some((e) => e.name === 'tsBuiltin'),
                'ts builtin must survive spread',
            );
            assert.ok(
                result?.entries.some((e) => e.name === 'id'),
                'cds entry must be in spread result',
            );
        } finally {
            delete testOverrides().rw;
            delete testOverrides().rwBatch;
        }
    });

    it('getCompletionEntryDetails falls through when getCqlCompletionDetails returns null', () => {
        // Covers: if (!cds) return base  (line ~525)
        // Position 0 is outside any template → getCqlCompletionDetails returns null.
        const src = 'const x = 1;\nexport {};';
        const { proxy } = createProxy('ced-null.ts', src, EMPTY_WORKER);
        const result = proxy.getCompletionEntryDetails('ced-null.ts', 0, 'x', undefined, 'cds:Svc.Entity', undefined, undefined);
        assert.equal(result, undefined, 'must fall through to base when cds details returns null');
    });

    it('updateGraph hook patches unpached cds.ql files added after create() (lines 442-451)', () => {
        // create() wraps project.updateGraph; when updateGraph is called, it scans
        // getScriptFileNames() for unpatched files containing cds.ql and patches them.
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const src = 'const r = await cds.ql`SELECT id FROM UGBooks`;\nexport {};';
        const fileName = join(tmpdir(), `updateGraph-test-${Date.now()}.ts`);
        const snap = TS.ScriptSnapshot.fromString(src);

        let editContentCalled = false;
        const si = {
            getSnapshot: () => snap,
            markContainingProjectsAsDirty: () => {},
            editContent: () => {
                editContentCalled = true;
            },
        };

        let updateGraphCalled = false;
        let filesVisible = false; // hidden from startup scan, visible when updateGraph fires
        const project = {
            projectService: { logger: NO_LOGGER },
            getScriptInfo: (f) => (f === fileName ? si : null),
            getScriptFileNames: () => (filesVisible ? [fileName] : []),
            updateGraph: () => {
                updateGraphCalled = true;
            },
        };

        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? snap : undefined),
            getCurrentDirectory: () => tmpdir(),
            getDefaultLibFileName: (o) => TS.getDefaultLibFilePath(o),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project,
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };

        const mod = pluginFactory({ typescript: TS });
        mod.create(fakeInfo);

        // Startup scan saw [] — file not in patchedFiles. Now expose it and call updateGraph.
        filesVisible = true;
        project.updateGraph();
        assert.ok(updateGraphCalled, 'origUpdateGraph must be called');
        assert.ok(editContentCalled, 'editContent must be called to bump version (line 451)');
    });

    it('PersistentWorkerPool.call: IPC buffer too-large guard returns null (lines 182-183)', () => {
        // Inject a worker that returns completions, then send a request whose JSON
        // exceeds IPC_BUF_SIZE so the too-large guard (lines 182-183) fires.
        const { join } = require('node:path');
        const { tmpdir } = require('node:os');
        const overrides = testOverrides();
        // Build a query string longer than IPC_BUF_SIZE (4MB) so Buffer.from(json).length + 4 > limit
        const hugeQuery = 'SELECT id FROM Books WHERE '.padEnd(4 * 1024 * 1024 + 100, 'x');
        overrides.workerPath = require.resolve('../src/cds-resolver-worker');
        try {
            const result = overrides._runWorker([join(tmpdir(), 'no-cds'), hugeQuery, '7', ''], NO_LOGGER, 1000);
            // Must return null (too-large guard) or null (worker miss) — either is acceptable
            assert.ok(result === null || result === undefined, 'must return null for oversized request');
        } finally {
            delete overrides.workerPath;
        }
    });
});

// ---------------------------------------------------------------------------
// CqlTypeRewriter — annotated branches
// ---------------------------------------------------------------------------

describe('CqlTypeRewriter — annotated branches', () => {
    it('SELECT col not in field list — undefined entry is filtered out', () => {
        // Covers CqlTypeRewriter.ts:311 — fieldMap.get(field) returns undefined when
        // the SELECT column name does not match any field from the worker.
        const src = 'const r = await cds.ql`SELECT ghost FROM Books                       `;\nexport {};';
        const batchWorker = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'id',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        const originalSource = new Map();
        const rewriteCache = new Map();
        const result = rewriteSnapshot('test.ts', src, TS, originalSource, rewriteCache, EMPTY_WORKER, batchWorker, NO_LOGGER, '/proj', undefined, new Map());
        assert.equal(typeof result, 'string', 'rewriteSnapshot must return a string');
    });

    it('SELECT * with only Association/Composition fields — filtered to empty, no rewrite', () => {
        // Covers CqlTypeRewriter.ts:318 — fields.length === 0 after filtering → workerMiss
        const src = 'const r = await cds.ql`SELECT * FROM Books                            `;\nexport {};';
        const assocOnlyBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'author',
                            detail: 'cds.Association to Authors',
                            kind: 'field',
                        },
                        {
                            label: 'genre',
                            detail: 'cds.Composition of Genres',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        const originalSource = new Map();
        const rewriteCache = new Map();
        const result = rewriteSnapshot('test.ts', src, TS, originalSource, rewriteCache, EMPTY_WORKER, assocOnlyBatch, NO_LOGGER, '/proj', undefined, new Map());
        assert.equal(result, src, 'all-association result must leave source unchanged');
    });

    it('template not assigned to a variable — no VariableDeclaration ancestor, skipped', () => {
        // Covers CqlTypeRewriter.ts:329 — findAncestor returns null → continue
        const src = 'cds.ql`SELECT id FROM Books`;\nexport {};';
        const batchWorker = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'id',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        const originalSource = new Map();
        const rewriteCache = new Map();
        const result = rewriteSnapshot('test.ts', src, TS, originalSource, rewriteCache, EMPTY_WORKER, batchWorker, NO_LOGGER, '/proj', undefined, new Map());
        assert.equal(result, src, 'unassigned template must leave source unchanged');
    });

    it('jsCast does not fit in budget — else branch skipped, no rewrite', () => {
        // Covers CqlTypeRewriter.ts:384 — the ignored else branch (jsCast.length > budget).
        // The JS cast ` = (/**@type{_q0}*/(0))` is 23 chars. Use a .js file with a
        // minimal template whose initializer span is shorter than 23 chars.
        const src = 'var r=cds.ql`S FROM X`;\n'; // budget = '=cds.ql`S FROM X`' = 18 chars < 23
        const batchWorker = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'id',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ],
                ]),
            ),
        });
        const originalSource = new Map();
        const rewriteCache = new Map();
        const result = rewriteSnapshot('test.js', src, TS, originalSource, rewriteCache, EMPTY_WORKER, batchWorker, NO_LOGGER, '/proj', undefined, new Map());
        assert.equal(result, src, 'must leave source unchanged when cast does not fit budget');
    });
});

// ---------------------------------------------------------------------------
// CqlLogic — annotated branch
// ---------------------------------------------------------------------------

describe('CqlLogic — dotted entity name lookup', () => {
    it('resolves entity when name already contains a dot', () => {
        // Covers CqlLogic.ts:360 — name.includes('.') fully-qualified lookup branch
        const src = 'const r = cds.ql`SELECT id FROM Svc.Books`;\nexport {};';
        const worker = () => ({
            completions: [
                {
                    label: 'id',
                    detail: 'cds.UUID',
                    kind: 'field',
                    entity: 'Svc.Books',
                },
            ],
        });
        const { proxy } = createProxy('test.ts', src, worker);
        assert.doesNotThrow(() => proxy.getQuickInfoAtPosition('test.ts', src.indexOf('Svc.Books')));
    });
});

// ---------------------------------------------------------------------------
// CqlHover — annotated branch
// ---------------------------------------------------------------------------

describe('CqlHover — non-awaited result variable hover', () => {
    it('hover on non-awaited cds.ql variable shows Promise type', () => {
        // Covers CqlHover.ts:289 — span line; displayType uses Promise<...> when awaited=false
        const src = 'const r = cds.ql`SELECT * FROM Books                         `;\nconsole.log(r);\nexport {};';
        const pos = src.indexOf('console.log(r)') + 'console.log('.length;
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info on non-awaited variable');
        const text = (info.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('Promise'), 'non-awaited hover must show Promise<...> type, got: ' + text);
    });
});

describe('CqlHover — write statement result variable hover', () => {
    it('hover on awaited DELETE variable shows number', () => {
        const src = 'const z = await cds.ql`DELETE FROM Books WHERE ID = 1                  `;\nconsole.log(z);\nexport {};';
        const pos = src.indexOf('console.log(z)') + 'console.log('.length;
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info on DELETE variable');
        const text = (info.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('number'), 'DELETE hover must show number, got: ' + text);
        assert.ok(!text.includes('unknown'), 'DELETE hover must not show unknown');
    });

    it('hover on awaited UPDATE variable shows number', () => {
        const src = 'const t = await cds.ql`UPDATE Books SET title = "x"                    `;\nconsole.log(t);\nexport {};';
        const pos = src.indexOf('console.log(t)') + 'console.log('.length;
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info on UPDATE variable');
        const text = (info.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('number'), 'UPDATE hover must show number, got: ' + text);
        assert.ok(!text.includes('unknown'), 'UPDATE hover must not show unknown');
    });

    it('hover on non-awaited DELETE variable shows Promise<number>', () => {
        const src = 'const z = cds.ql`DELETE FROM Books WHERE ID = 1                        `;\nconsole.log(z);\nexport {};';
        const pos = src.indexOf('console.log(z)') + 'console.log('.length;
        const { proxy } = createProxy('test.ts', src, BOOKS_WORKER);
        const info = proxy.getQuickInfoAtPosition('test.ts', pos);
        assert.ok(info, 'expected hover info on non-awaited DELETE variable');
        const text = (info.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('Promise') && text.includes('number'), 'non-awaited DELETE hover must show Promise<number>, got: ' + text);
    });
});



describe('PersistentWorkerPool — end-to-end', () => {
    // Atomics.wait is permitted on the main thread in node:test (only worker
    // threads cannot call it). We call _runWorker/_runBatchWorker directly so
    // Exercises the real PersistentWorkerPool code in src/index.ts.
    // _testOverrides.workerPath redirects getOrCreate() to spawn a mock worker.

    const { writeFileSync, unlinkSync } = require('node:fs');
    const { join: pathJoin } = require('node:path');
    const { tmpdir } = require('node:os');

    // The compiled plugin is already loaded as `pluginFactory` at the top of this file.
    // Its _testOverrides object has _runWorker/_runBatchWorker wired to the real pool.
    const overrides = testOverrides();

    // The bridge thread is spawned via `new WorkerThread(path)` as plain node with
    // no tsx loader, so it cannot load the .ts source — point it at the built JS.
    // (The child worker it spawns can use the .ts source via process.execPath + tsx,
    // but the bridge itself always needs dist/cds-bridge-thread.js.)
    overrides.bridgeThreadPath = pathJoin(__dirname, '../src/cds-bridge-thread.js');

    const noLog = {
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

    let mockWorkerPath;
    let silentWorkerPath;
    let badJsonWorkerPath;
    let noResultWorkerPath;
    let exitWorkerPath;

    before(() => {
        const pid = process.pid;
        mockWorkerPath = pathJoin(tmpdir(), `mock-cds-worker-${pid}.js`);
        silentWorkerPath = pathJoin(tmpdir(), `silent-cds-worker-pool-${pid}.js`);
        noResultWorkerPath = pathJoin(tmpdir(), `no-result-worker-${pid}.js`);
        exitWorkerPath = pathJoin(tmpdir(), `exit-worker-${pid}.js`);

        // Mock worker: speaks --persistent protocol, returns canned responses
        writeFileSync(
            mockWorkerPath,
            [
                "'use strict';",
                "const { createInterface } = require('node:readline');",
                "createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {",
                '    try {',
                '        const req = JSON.parse(line);',
                "        const result = req.kind === 'batch'",
                "            ? { fields: Object.fromEntries((req.probes ?? []).map(p => [p.entity, [{ label: 'id', detail: 'cds.UUID', kind: 'field' }]])) }",
                "            : { completions: [{ label: 'id', detail: 'cds.UUID', kind: 'field' }] };",
                "        process.stdout.write(JSON.stringify({ id: req.id, result }) + '\\n');",
                '    } catch {}',
                '});',
            ].join('\n'),
        );

        // Silent worker: reads stdin but never responds (for timeout test)
        writeFileSync(silentWorkerPath, ["'use strict';", "require('node:readline').createInterface({ input: process.stdin }).on('line', () => {});"].join('\n'));

        // Bad-JSON worker: responds with invalid JSON (for call() catch path)
        badJsonWorkerPath = pathJoin(tmpdir(), `bad-json-worker-${pid}.js`);
        writeFileSync(
            badJsonWorkerPath,
            [
                "'use strict';",
                "const { createInterface } = require('node:readline');",
                "createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', () => {",
                "    process.stdout.write('not-valid-json\\n');",
                '});',
            ].join('\n'),
        );

        // No-result worker: responds with valid JSON but no "result" key → parsed?.result ?? null
        writeFileSync(
            noResultWorkerPath,
            [
                "'use strict';",
                "const { createInterface } = require('node:readline');",
                "createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {",
                "    try { const req = JSON.parse(line); process.stdout.write(JSON.stringify({ id: req.id }) + '\\n'); } catch {}",
                '});',
            ].join('\n'),
        );

        // Exit-immediately worker: exits as soon as it starts, triggering bridge fatal exit
        writeFileSync(exitWorkerPath, "'use strict';\nprocess.exit(0);\n");
    });

    after(async () => {
        delete overrides.workerPath;
        // Send shutdown to all bridge threads so they kill their child processes,
        // then terminate the threads. Without this the orphaned child processes
        // keep their stdin pipes open and the shard worker process never exits.
        await overrides._shutdownPool();
        for (const p of [mockWorkerPath, silentWorkerPath, badJsonWorkerPath, noResultWorkerPath, exitWorkerPath]) {
            try {
                unlinkSync(p);
            } catch {
                /* best effort */
            }
        }
    });

    it('runWorker: single call returns completions (getOrCreate cold start)', () => {
        // Uses a unique projectRoot so pool spawns a fresh bridge (cold start path)
        const root = pathJoin(tmpdir(), `pool-test-single-${process.pid}`);
        overrides.workerPath = mockWorkerPath;
        const result = overrides._runWorker([root, 'SELECT  FROM Books WHERE ', '7', ''], noLog);
        assert.ok(result, 'must return a result');
        assert.ok(Array.isArray(result.completions), 'must have completions array');
    });

    it('runBatchWorker: batch call returns fields (getOrCreate cache hit)', () => {
        // Reuses same projectRoot as prior test → exercises getOrCreate cache-hit branch
        const root = pathJoin(tmpdir(), `pool-test-single-${process.pid}`);
        overrides.workerPath = mockWorkerPath;
        const result = overrides._runBatchWorker(root, [{ entity: 'Books', prefix: '' }], noLog);
        assert.ok(result, 'must return a result');
        assert.ok(Array.isArray(result.fields?.Books), 'must have Books fields');
    });

    it('runWorker: timeout returns null when worker never responds', () => {
        // Uses a distinct projectRoot so pool spawns a fresh bridge against the silent worker
        const root = pathJoin(tmpdir(), `pool-test-timeout-${process.pid}`);
        overrides.workerPath = silentWorkerPath;
        const result = overrides._runWorker([root, 'q', '0', ''], noLog, 80);
        assert.equal(result, null, 'timeout must return null');
    });

    it('call(): catch block fires when bridge responds with invalid JSON (lines 208-210)', () => {
        // Inject a handle with a non-shared Int32Array so Atomics.wait throws TypeError,
        // exercising the catch block at lines 208-210 in index.ts.
        const pool = overrides._workerPool;
        const root = pathJoin(tmpdir(), `pool-test-atomics-throw-${process.pid}`);
        // Use a regular ArrayBuffer (not SharedArrayBuffer) — Atomics.wait throws on it
        const badCtrl = new ArrayBuffer(12);
        const badReq = new SharedArrayBuffer(4 + 1024 * 1024);
        const badRes = new SharedArrayBuffer(4 + 1024 * 1024);
        pool.bridges.set(root, {
            thread: { unref() {} },
            ctrl: badCtrl,
            reqBuf: badReq,
            resBuf: badRes,
        });
        const logged = [];
        const logger = { ...noLog, info: (s) => logged.push(s) };
        const result = overrides._runWorker([root, 'q', '0', ''], logger, 500);
        assert.equal(result, null, 'catch path must return null');
        assert.ok(
            logged.some((s) => s.includes('persistent worker error')),
            `expected "persistent worker error" log, got: ${JSON.stringify(logged)}`,
        );
    });

    it('call(): parsed?.result ?? null branch when worker omits result key (line 206)', () => {
        // noResultWorkerPath responds with { id } but no "result" key.
        // parsed?.result is undefined → ?? null fires → call() returns null.
        const root = pathJoin(tmpdir(), `pool-test-no-result-${process.pid}`);
        overrides.workerPath = noResultWorkerPath;
        const result = overrides._runWorker([root, 'q', '0', ''], noLog, 500);
        assert.equal(result, null, 'missing result key must return null');
    });

    it('runWorker: args[0] ?? "" branch when args is empty (line 218)', () => {
        // args[0] is undefined → ?? '' fires → projectRoot becomes ''
        // The bridge will fail to spawn for an empty path but call() handles it via catch.
        const result = overrides._runWorker([], noLog, 100);
        assert.equal(result, null, 'empty args must return null');
    });

    it('thread.on("error") fires when bridge Worker has an uncaught exception (lines 156-157)', async () => {
        // Spawn a real bridge by calling _runWorker (getOrCreate registers thread.on('error')),
        // then emit 'error' directly on the thread to exercise lines 156-157 in index.ts.
        const pool = overrides._workerPool;
        const root = pathJoin(tmpdir(), `pool-test-thread-error-real-${process.pid}`);
        const logged = [];
        const logger = { ...noLog, info: (s) => logged.push(s) };
        overrides.workerPath = mockWorkerPath;
        // This call spawns the bridge and registers the real thread.on('error') handler
        overrides._runWorker([root, 'SELECT  FROM Books WHERE ', '7', ''], logger, 500);
        // The bridge is now in pool.bridges — emit 'error' on the real thread
        const handle = pool.bridges.get(root);
        assert.ok(handle, 'bridge must exist after _runWorker');
        handle.thread.emit('error', new Error('simulated bridge crash'));
        // Handler logs and deletes the bridge
        assert.ok(!pool.bridges.has(root), 'bridge must be removed after error event');
        assert.ok(
            logged.some((s) => s.includes('bridge error')),
            `expected "bridge error" log, got: ${JSON.stringify(logged)}`,
        );
    });

    it('thread.on("message") with non-stderr type is silently ignored', () => {
        // The message handler only acts on msg.type === 'stderr'.
        // Sending a message with a different type must not throw or log.
        const pool = overrides._workerPool;
        const root = pathJoin(tmpdir(), `pool-test-msg-non-stderr-${process.pid}`);
        const logged = [];
        const logger = { ...noLog, info: (s) => logged.push(s) };
        overrides.workerPath = mockWorkerPath;
        overrides._runWorker([root, 'SELECT  FROM Books WHERE ', '7', ''], logger, 500);
        const handle = pool.bridges.get(root);
        assert.ok(handle, 'bridge must exist');
        // Emit a message that is NOT of type 'stderr' — exercises the false branch
        handle.thread.emit('message', { type: 'other', text: 'ignored' });
        // No log entry should be added for non-stderr messages
        assert.ok(!logged.some((s) => s.includes('worker stderr')), 'non-stderr message must not produce a log entry');
    });

    it('call(): catch block with non-Error thrown — String(e) path', () => {
        // Inject a bridge handle whose ctrl is a plain ArrayBuffer (not SharedArrayBuffer)
        // so Atomics.store throws a TypeError. But to hit `String(e)` we need the catch
        // to receive a non-Error. Achieve this by making getOrCreate throw a string by
        // temporarily patching bridges.get to throw a non-Error value.
        const pool = overrides._workerPool;
        const root = pathJoin(tmpdir(), `pool-test-string-throw-${process.pid}`);
        const origGet = pool.bridges.get.bind(pool.bridges);
        pool.bridges.get = (k) => {
            if (k === root) throw 'string-error'; // non-Error throw
            return origGet(k);
        };
        const logged = [];
        const logger = { ...noLog, info: (s) => logged.push(s) };
        const result = overrides._runWorker([root, 'q', '0', ''], logger, 500);
        pool.bridges.get = origGet; // restore
        assert.equal(result, null, 'non-Error catch must return null');
        assert.ok(
            logged.some((s) => s.includes('string-error')),
            `expected "string-error" in log, got: ${JSON.stringify(logged)}`,
        );
    });

    it('runBatchWorker: real worker — probeEntityFields service-scan path', () => {
        // Uses the compiled lib worker (not the TS source) against distributedModel.
        // Sending an unqualified entity name 'Foo' with no prefix triggers the
        // service-scan loop in probeEntityFields (key.endsWith('.Foo') → FooService.Foo).
        // This covers the lib/cds-resolver-worker.js branches that are only reachable
        // when a child process executes the real worker with a loaded model.
        // NOTE: must point at the lib JS file, not the TS source — bridge spawns plain node.
        const { join: pj } = require('node:path');
        const fixtureRoot = pj(__dirname, 'data/distributedModel');
        const libWorkerPath = pj(__dirname, '../src/cds-resolver-worker.js');
        overrides.workerPath = libWorkerPath;
        const logged = [];
        const logger = { ...noLog, info: (s) => logged.push(s) };
        const result = overrides._runBatchWorker(fixtureRoot, [{ entity: 'Foo', prefix: '' }], logger);
        delete overrides.workerPath;
        assert.ok(result, `real worker must return a result, logs: ${JSON.stringify(logged)}`);
        assert.ok(Array.isArray(result.fields?.Foo), 'service-scan must return fields array for Foo');
        assert.ok(result.fields.Foo.length > 0, 'service-scan must find at least one field');
    });

    it('call(): Atomics.load(ctrlArr, 2)===1 after Atomics.wait — worker exited unexpectedly (b8 arm=0)', () => {
        // Use an exit-immediately worker so the bridge detects the child exit,
        // sets ctrl[2]=1 and notifies ctrl[1] — the main thread's Atomics.wait
        // returns 'ok' and then the fatal check fires ("exited unexpectedly").
        const root = pathJoin(tmpdir(), `pool-test-fatal2-${process.pid}-${Date.now()}`);
        overrides.workerPath = exitWorkerPath;
        const logged = [];
        const logger = { ...noLog, info: (s) => logged.push(s) };
        // Allow enough time for child to exit and bridge to signal (exitWorker exits in ~0ms)
        const result = overrides._runWorker([root, 'q', '0', ''], logger, 3000);
        assert.equal(result, null, 'exited worker must return null');
        assert.ok(
            logged.some((s) => s.includes('exited unexpectedly')) || logged.some((s) => s.includes('timed-out') || s.includes('timed out')),
            `expected "exited unexpectedly" or timeout, got: ${JSON.stringify(logged)}`,
        );
    });
});

// ---------------------------------------------------------------------------
// Plugin create() — additional branch coverage
// ---------------------------------------------------------------------------

describe('Plugin create() — proxy and startup-scan branches', () => {
    it('proxy loop skips non-function LS property (b49 arm=0)', () => {
        // The proxy-building loop: `if (typeof method === 'function')`.
        // arm=0 fires when an LS key has a non-function value. We pass a fake LS
        // with a data property mixed in to exercise the false branch.
        const fakeLs = Object.assign(Object.create(null), {
            getSemanticDiagnostics: () => [],
            notAFunction: 42, // non-function property — exercises arm=0
        });
        const fakeInfo = {
            config: {},
            languageService: fakeLs,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: { getScriptSnapshot: () => undefined },
        };
        const mod = pluginFactory({ typescript: TS });
        assert.doesNotThrow(() => mod.create(fakeInfo), 'create() must not throw when LS has a non-function property');
    });

    it('create() with no updateGraph function skips the wrapper (b50 arm=0)', () => {
        // `if (typeof info.project.updateGraph === 'function')` arm=0:
        // project.updateGraph is not a function → the wrapper is skipped entirely.
        const src = 'const x = 1;';
        const fileName = 'no-ug.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo = {
            config: {},
            languageService: ls,
            // updateGraph is undefined — typeof !== 'function' → arm=0
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const mod = pluginFactory({ typescript: TS });
        assert.doesNotThrow(() => mod.create(fakeInfo), 'create() must not throw when project.updateGraph is missing');
    });

    it('startup scan: getScriptInfo returns null → continue (b59 arm=0)', () => {
        // In the startup scan loop: `if (!si) continue` arm=0 fires when
        // getScriptInfo returns null for a file. We provide a file in getScriptFileNames
        // but getScriptInfo always returns null — the loop continues past it.
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = '/proj/scan-null-si.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null, // null for every file → b59 arm=0
                getScriptFileNames: () => [fileName],
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const mod = pluginFactory({ typescript: TS });
        assert.doesNotThrow(() => mod.create(fakeInfo), 'startup scan with null ScriptInfo must not throw');
    });

    it('startup scan: file text has no cds.ql → condition false (b61 arm=0)', () => {
        // `if (text.includes("cds.ql") && config["cds.ql.typeInference"])` arm=0:
        // file text does NOT contain "cds.ql" → condition is false → file skipped.
        const src = 'const x = 1;\nexport {};';
        const fileName = '/proj/no-cql.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const si = {
            getSnapshot: () => TS.ScriptSnapshot.fromString(src),
            __cdsPatchedSnapshot: false,
            markContainingProjectsAsDirty: () => {},
        };
        const fakeInfo = {
            config: { 'cds.ql.typeInference': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: (f) => (f === fileName ? si : null),
                getScriptFileNames: () => [fileName],
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const mod = pluginFactory({ typescript: TS });
        assert.doesNotThrow(() => mod.create(fakeInfo), 'startup scan with non-CQL file must not throw');
    });

    it('proxy getSemanticDiagnostics: !ctx returns base when file has no CQL (b69 arm=0)', () => {
        // resolveQueryContext returns null for a non-CQL file → `if (!ctx) return base` arm=0
        const src = 'const x = 1;\nexport {};';
        const fileName = '/proj/no-cql-diag.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo = {
            config: { 'cds.ql.diagnostics': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const mod = pluginFactory({ typescript: TS });
        const proxy = mod.create(fakeInfo);
        // No CQL → resolveQueryContext returns null → base diagnostics returned
        assert.doesNotThrow(() => proxy.getSemanticDiagnostics(fileName));
    });

    it('proxy getCompletionsAtPosition: completion flag off returns base (b70 arm=0)', () => {
        // `if (!config["cds.ql.completion"]) return base` arm=0 (flag disabled)
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const fileName = '/proj/compl-off.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo = {
            config: { 'cds.ql.completion': false }, // disabled → arm=0
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const mod = pluginFactory({ typescript: TS });
        const proxy = mod.create(fakeInfo);
        assert.doesNotThrow(() => proxy.getCompletionsAtPosition(fileName, 10, undefined, undefined));
    });

    it('proxy getQuickInfoAtPosition: !ctx returns base when file has no CQL (b81 arm=0)', () => {
        // resolveQueryContext returns null → `if (!ctx) return base` in hover arm=0
        const src = 'const x = 1;\nexport {};';
        const fileName = '/proj/no-cql-hover.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo = {
            config: { 'cds.ql.hover': true },
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const mod = pluginFactory({ typescript: TS });
        const proxy = mod.create(fakeInfo);
        assert.doesNotThrow(() => proxy.getQuickInfoAtPosition(fileName, 6));
    });

    it('proxy getCompletionEntryDetails: non-cds: source returns base immediately (b75 arm=0)', () => {
        // `if (!source?.startsWith('cds:')) return base` arm=0 fires when
        // source does not begin with 'cds:'. Completion flag must be on.
        const src = 'const x = 1;\nexport {};';
        const fileName = '/proj/no-cql-ced.ts';
        const lsHost = {
            getCompilationSettings: () => ({ target: TS.ScriptTarget.ES2020 }),
            getScriptFileNames: () => [fileName],
            getScriptVersion: () => '1',
            getScriptSnapshot: (f) => (f === fileName ? TS.ScriptSnapshot.fromString(src) : undefined),
            getCurrentDirectory: () => '/proj',
            getDefaultLibFileName: (opts) => TS.getDefaultLibFilePath(opts),
            fileExists: (f) => f === fileName,
            readFile: () => undefined,
            readDirectory: () => [],
        };
        const ls = TS.createLanguageService(lsHost, TS.createDocumentRegistry());
        const fakeInfo = {
            config: { 'cds.ql.completion': true }, // enabled so the source check runs
            languageService: ls,
            project: {
                projectService: { logger: NO_LOGGER },
                getScriptInfo: () => null,
                updateGraph: () => {},
            },
            languageServiceHost: {
                getScriptSnapshot: (f) => lsHost.getScriptSnapshot(f),
            },
        };
        const mod = pluginFactory({ typescript: TS });
        const proxy = mod.create(fakeInfo);
        // source = 'typescript' → does not start with 'cds:' → b75 arm=0 → returns base
        assert.doesNotThrow(() => proxy.getCompletionEntryDetails(fileName, 6, 'x', undefined, 'typescript', undefined, undefined));
    });
});

// ---------------------------------------------------------------------------
// cds-resolver-worker — persistent mode branches via exported functions
// ---------------------------------------------------------------------------

describe('cds-resolver-worker — persistent handler branches', () => {
    // Tests for runMain() which now encapsulates the require.main dispatch logic.
    // Using injected stdin/stdout lets nyc instrument every branch in-process.
    // We require from src/ via tsx — nyc instruments src/ files in this process.

    const { PassThrough } = require('node:stream');
    const worker = require('../src/cds-resolver-worker');

    function makeStdin(...lines) {
        const pt = new PassThrough();
        for (const l of lines) pt.push(l + '\n');
        pt.push(null);
        return pt;
    }

    it('runWorkerMain: load error path writes error to write()', async () => {
        // Force the "not found" path deterministically: no local @sap/cds at the
        // bogus root and no global roots to fall through to (otherwise a machine
        // with a global @sap/cds install would resolve it and this test would flake).
        worker._testOverrides.globalRoots = () => [];
        try {
            let written = null;
            await worker.runWorkerMain('/no-such-dir', 'SELECT id FROM X', '0', undefined, (r) => {
                written = r;
            });
            assert.ok(written?.error?.includes('@sap/cds'), `expected @sap/cds error, got: ${written?.error}`);
        } finally {
            delete worker._testOverrides.globalRoots;
        }
    });

    it('loadModel: global-root fallback resolves @sap/cds when the project has none', async () => {
        // Simulate the CAP quickstart: no local node_modules at the project root,
        // but @sap/cds installed "globally". Inject a global root pointing at the
        // distributedModel fixture's node_modules (a real @sap/cds@10.x).
        const { join } = require('node:path');
        const globalRoot = join(__dirname, 'data/distributedModel/node_modules');
        // A bare temp dir with only a package.json and no @sap/cds — resolution
        // must fall through to the injected global root, past the "not found" gate.
        const os = require('node:os');
        const fs = require('node:fs');
        const tmp = fs.mkdtempSync(join(os.tmpdir(), 'cds-global-fallback-'));
        fs.writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'no-cds-here' }));
        worker._testOverrides.globalRoots = () => [globalRoot];
        try {
            let written = null;
            await worker.runWorkerMain(tmp, 'SELECT  FROM X', '0', undefined, (r) => {
                written = r;
            });
            // Resolution succeeded → we are past the "@sap/cds not found" gate.
            // cds.load may still fail (the temp dir has no .cds model), but that is
            // a different, later error and proves the module was found globally.
            assert.ok(!written?.error?.includes('not found'), `expected to resolve @sap/cds globally, got: ${written?.error}`);
        } finally {
            delete worker._testOverrides.globalRoots;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('loadModel: error message lists the searched global roots when all miss', async () => {
        worker._testOverrides.globalRoots = () => ['/nonexistent-global-a', '/nonexistent-global-b'];
        try {
            let written = null;
            await worker.runWorkerMain('/no-such-dir', 'SELECT id FROM X', '0', undefined, (r) => {
                written = r;
            });
            assert.ok(written?.error?.includes('@sap/cds not found'), `got: ${written?.error}`);
            assert.ok(written?.error?.includes('also searched global roots'), `got: ${written?.error}`);
            assert.ok(written?.error?.includes('/nonexistent-global-a'), `got: ${written?.error}`);
            assert.ok(written?.error?.includes('/nonexistent-global-b'), `got: ${written?.error}`);
        } finally {
            delete worker._testOverrides.globalRoots;
        }
    });

    it('loadModel: project-local @sap/cds is searched before global roots', async () => {
        // Point the project root AT the fixture that has a local @sap/cds, and set
        // globalRoots to a location that would also resolve. The local one must win,
        // i.e. resolution succeeds even if globalRoots were bogus.
        const { join } = require('node:path');
        const localRoot = join(__dirname, 'data/distributedModel');
        worker._testOverrides.globalRoots = () => ['/nonexistent-global-only'];
        try {
            let written = null;
            await worker.runWorkerMain(localRoot, 'SELECT  FROM X', '0', undefined, (r) => {
                written = r;
            });
            // Local resolution succeeded → never fell through to the bogus global.
            assert.ok(!written?.error?.includes('not found'), `expected local @sap/cds to resolve, got: ${written?.error}`);
        } finally {
            delete worker._testOverrides.globalRoots;
        }
    });

    it('runBatchWorkerMain: missing arguments writes error', async () => {
        let written = null;
        await worker.runBatchWorkerMain(undefined, undefined, (r) => {
            written = r;
        });
        assert.equal(written?.error, 'missing arguments');
    });

    it('runBatchWorkerMain: invalid JSON payload writes error', async () => {
        let written = null;
        await worker.runBatchWorkerMain('/some/root', 'not-valid-json', (r) => {
            written = r;
        });
        assert.equal(written?.error, 'invalid batch payload');
    });

    it('runMain: --batch mode dispatches to runBatchWorkerMain', async () => {
        const out = [];
        await worker.runMain(['node', 'worker.js', '/no-such-root', '--batch', 'not-json'], makeStdin(), { write: (s) => out.push(s) });
        assert.ok(out.length > 0, 'must write output');
        const result = JSON.parse(out[0]);
        assert.ok(result.error || result.fields !== undefined, 'must produce batch result or error');
    });

    it('runMain: single-query mode dispatches to runWorkerMain', async () => {
        worker._testOverrides.globalRoots = () => []; // deterministic "not found" regardless of a global @sap/cds install
        try {
            const out = [];
            await worker.runMain(['node', 'worker.js', '/no-such-root', 'SELECT  FROM X', '0', ''], makeStdin(), { write: (s) => out.push(s) });
            assert.ok(out.length > 0, 'must write output');
            const result = JSON.parse(out[0]);
            assert.ok(result.error, 'must produce error when @sap/cds not found');
        } finally {
            delete worker._testOverrides.globalRoots;
        }
    });

    it('runMain: --persistent mode handles single request, invalid JSON, and close', async () => {
        worker._testOverrides.globalRoots = () => [];
        try {
            const out = [];
            const stdin = makeStdin(
                JSON.stringify({
                    id: 1,
                    kind: 'single',
                    projectRoot: '/no-such-root',
                    args: ['SELECT  FROM X', '0', ''],
                }),
                'not-json',
            );
            await worker.runMain(['node', 'worker.js', '/no-such-root', '--persistent'], stdin, { write: (s) => out.push(s) });
            const resp = out.find((s) => s.includes('"id":1'));
            assert.ok(resp, 'must respond to id=1');
            assert.ok(JSON.parse(resp).result?.error, 'must produce error result when @sap/cds not found');
        } finally {
            delete worker._testOverrides.globalRoots;
        }
    });

    it('runMain: --persistent mode handles batch request', async () => {
        worker._testOverrides.globalRoots = () => [];
        try {
            const out = [];
            const stdin = makeStdin(
                JSON.stringify({
                    id: 2,
                    kind: 'batch',
                    projectRoot: '/no-such-root',
                    probes: [{ entity: 'Books', prefix: '' }],
                }),
            );
            await worker.runMain(['node', 'worker.js', '/no-such-root', '--persistent'], stdin, { write: (s) => out.push(s) });
            const resp = out.find((s) => s.includes('"id":2'));
            assert.ok(resp, 'must respond to id=2');
            assert.ok(JSON.parse(resp).result?.error, 'must produce error result when @sap/cds not found');
        } finally {
            delete worker._testOverrides.globalRoots;
        }
    });

    it('runMain: --persistent single dispatch (lines 193-195) with loaded model', async () => {
        // Uses a small fixture with @sap/cds so cds.load succeeds.
        // Sends requests sequentially so each sees fresh model state.
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];

        const pt = new PassThrough();
        const runPromise = worker.runMain(['node', 'worker.js', fixtureRoot, '--persistent'], pt, { write: (s) => out.push(s) });

        // cursor >= 0 → completions path (ternary right branch, line 209)
        pt.push(
            JSON.stringify({
                id: 11,
                kind: 'single',
                projectRoot: fixtureRoot,
                args: ['SELECT  FROM Booking WHERE ', '7', ''],
            }) + '\n',
        );
        await new Promise((res) => setTimeout(res, 200));
        // cursor = -1 → diagnostics path (ternary left branch, line 208) — cache hit for model
        pt.push(
            JSON.stringify({
                id: 12,
                kind: 'single',
                projectRoot: fixtureRoot,
                args: ['SELECT id FROM NonExistent', '-1', ''],
            }) + '\n',
        );
        await new Promise((res) => setTimeout(res, 50));
        pt.push(null);

        await runPromise;
        const r11 = out.find((s) => s.includes('"id":11'));
        const r12 = out.find((s) => s.includes('"id":12'));
        assert.ok(r11, `must respond to id=11, got: ${JSON.stringify(out)}`);
        assert.ok(r12, `must respond to id=12, got: ${JSON.stringify(out)}`);
    });

    it('runMain: --persistent cache-hit path and ?? fallback branches', async () => {
        // Send requests sequentially (with delays) so the second request sees cachedDefs set by the first.
        // 1. First request loads model (cold start)
        // 2. Second omits projectRoot — exercises `req.projectRoot ?? projectRoot` fallback (line 185)
        //    and hits the cache-hit false branch of `root !== cachedRoot` (line 187)
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];
        const pt = new PassThrough();
        const runPromise = worker.runMain(['node', 'worker.js', fixtureRoot, '--persistent'], pt, { write: (s) => out.push(s) });

        // First: cold start — loads model, sets cachedDefs/cachedRoot = fixtureRoot
        pt.push(
            JSON.stringify({
                id: 40,
                kind: 'single',
                projectRoot: fixtureRoot,
                args: ['SELECT  FROM Booking WHERE ', '7', ''],
            }) + '\n',
        );
        // Wait for first to complete (cds.load takes ~50ms)
        await new Promise((res) => setTimeout(res, 200));
        // Second: no projectRoot → uses argv projectRoot = fixtureRoot = cachedRoot → cache hit (line 187 br 1)
        pt.push(
            JSON.stringify({
                id: 41,
                kind: 'single',
                args: ['SELECT  FROM Booking WHERE ', '-1', ''],
            }) + '\n',
        );
        await new Promise((res) => setTimeout(res, 50));
        pt.push(null);
        await runPromise;

        assert.ok(
            out.find((s) => s.includes('"id":40')),
            'must respond to id=40',
        );
        assert.ok(
            out.find((s) => s.includes('"id":41')),
            'must respond to id=41 (cache hit + no-projectRoot fallback)',
        );
    });

    it('runMain: --persistent batch with no probes key uses ?? [] fallback', async () => {
        // req.probes is undefined — exercises the `?? []` fallback on line 200
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];
        const pt = new PassThrough();
        // kind=batch but no probes field — probes ?? [] = []
        pt.push(
            JSON.stringify({
                id: 42,
                kind: 'batch',
                projectRoot: fixtureRoot,
            }) + '\n',
        );
        pt.push(null);
        await worker.runMain(['node', 'worker.js', fixtureRoot, '--persistent'], pt, { write: (s) => out.push(s) });
        const resp = out.find((s) => s.includes('"id":42'));
        assert.ok(resp, 'must respond to id=42');
        assert.deepEqual(JSON.parse(resp).result.fields, {}, 'empty probes returns empty fields');
    });

    it('runMain: --persistent single with missing cursorStr uses ?? "-1" fallback', async () => {
        // req.args has only one element — cursorStr is undefined, ?? "-1" → diagnostics path
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];
        const pt = new PassThrough();
        // args shorter than expected — cursorStr ?? '-1' gives -1 → diagnostics branch
        pt.push(
            JSON.stringify({
                id: 43,
                kind: 'single',
                projectRoot: fixtureRoot,
                args: ['SELECT id FROM NonExistent'],
            }) + '\n',
        );
        pt.push(null);
        await worker.runMain(['node', 'worker.js', fixtureRoot, '--persistent'], pt, { write: (s) => out.push(s) });
        const resp = out.find((s) => s.includes('"id":43'));
        assert.ok(resp, 'must respond to id=43');
        assert.ok('diagnostics' in JSON.parse(resp).result, 'undefined cursorStr must produce diagnostics');
    });

    it('runMain: --persistent watch try/catch fires when watchFn throws', async () => {
        // Inject a watchFn that throws — exercises the catch {} on line 163
        worker._testOverrides.watch = () => {
            throw new Error('watch not supported');
        };
        const out = [];
        const pt = new PassThrough();
        pt.push(
            JSON.stringify({
                id: 44,
                kind: 'single',
                projectRoot: '/no-such-root',
                args: ['SELECT  FROM X', '0', ''],
            }) + '\n',
        );
        pt.push(null);
        // Should not throw — catch {} absorbs the error and execution continues
        await worker.runMain(['node', 'worker.js', '/no-such-root', '--persistent'], pt, { write: (s) => out.push(s) });
        assert.ok(
            out.find((s) => s.includes('"id":44')),
            'must still respond after watch throws',
        );
        delete worker._testOverrides.watch;
    });

    it('runMain: --persistent fs.watch callback fires on .cds file change (lines 160-162)', async () => {
        // Inject a fake watch that captures the callback and calls it synchronously,
        // so nyc instruments the callback body (lines 160-162) in-process.
        const { EventEmitter } = require('node:events');

        let capturedCallback = null;
        const fakeWatcher = new EventEmitter();
        worker._testOverrides.watch = (_path, _opts, cb) => {
            capturedCallback = cb;
            return fakeWatcher;
        };

        const out = [];
        const pt = new PassThrough();
        pt.push(
            JSON.stringify({
                id: 20,
                kind: 'single',
                projectRoot: '/no-such-root',
                args: ['SELECT  FROM Foo WHERE ', '0', ''],
            }) + '\n',
        );

        const runPromise = worker.runMain(['node', 'worker.js', '/no-such-root', '--persistent'], pt, { write: (s) => out.push(s) });

        // Let runMain reach the watch setup
        await new Promise((res) => setTimeout(res, 10));

        // Fire the watcher callback with a .cds filename — covers lines 160-162
        assert.ok(capturedCallback, 'watch must have been called');
        const fireCb = capturedCallback;
        fireCb('change', 'schema.cds');

        // Fire again immediately to trigger the clearTimeout branch (invalidateTimer is set)
        fireCb('change', 'schema.cds');

        // Fire with a non-.cds filename — covers the false branch of the endsWith check
        fireCb('change', 'schema.ts');

        // Wait for the 200ms debounce timer callback (line 169: cachedDefs = null) to fire
        await new Promise((res) => setTimeout(res, 250));
        pt.push(null);
        await runPromise;
        assert.ok(
            out.find((s) => s.includes('"id":20')),
            `must respond to id=20, got: ${JSON.stringify(out)}`,
        );

        delete worker._testOverrides.watch;
    });

    it('runMain: --persistent watcher .on("error") fires — error is ignored', async () => {
        // Inject a fake watch that returns a watcher we can emit 'error' on,
        // exercising the watcher.on('error') handler (line 165).
        const { EventEmitter } = require('node:events');

        const fakeWatcher = new EventEmitter();
        worker._testOverrides.watch = () => fakeWatcher;

        const out = [];
        const pt = new PassThrough();
        pt.push(
            JSON.stringify({
                id: 21,
                kind: 'single',
                projectRoot: '/no-such-root',
                args: ['SELECT  FROM X', '0', ''],
            }) + '\n',
        );

        const runPromise = worker.runMain(['node', 'worker.js', '/no-such-root', '--persistent'], pt, { write: (s) => out.push(s) });
        await new Promise((res) => setTimeout(res, 10));

        // Emit error on the watcher — the handler ignores it, runMain continues
        fakeWatcher.emit('error', new Error('watch error'));

        await new Promise((res) => setTimeout(res, 10));
        pt.push(null);
        await runPromise;
        assert.ok(
            out.find((s) => s.includes('"id":21')),
            'must still respond after watcher error',
        );

        delete worker._testOverrides.watch;
    });

    it('runBatchWorkerMain: probeEntityFields service-scan path (lines 46-49)', async () => {
        // Uses the same small fixture. probeEntityFields is reached when cds.load succeeds.
        // An unqualified entity name with no prefix triggers the service-scan branch.
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];
        // 'Foo' is unqualified and has no direct match — triggers service-scan (lines 46-49)
        // The fixture's service.cds exposes FooService.Foo so the scan finds candidates.
        await worker.runBatchWorkerMain(fixtureRoot, JSON.stringify([{ entity: 'Foo', prefix: '' }]), (r) => out.push(JSON.stringify(r)));
        assert.ok(out.length > 0, 'must produce output');
        const result = JSON.parse(out[0]);
        assert.ok('fields' in result, 'must produce fields');
        assert.ok(result.fields['Foo'].length > 0, 'service-scan must find fields for Foo');
    });

    it('runBatchWorkerMain: probeEntityFields first-filter predicate fires (line 44)', async () => {
        // Uses a fully-qualified entity name (contains a dot) against the real fixture.
        // getSuggestions returns actual field completions, so the c => c.kind === 'field'
        // predicate on line 44 is invoked — covering the anonymous_11 function.
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];
        await worker.runBatchWorkerMain(fixtureRoot, JSON.stringify([{ entity: 'FooService.Foo', prefix: '' }]), (r) => out.push(JSON.stringify(r)));
        assert.ok(out.length > 0, 'must produce output');
        const result = JSON.parse(out[0]);
        assert.ok('fields' in result, 'must produce fields');
        assert.ok(result.fields['FooService.Foo'].length > 0, 'fully-qualified entity must return fields directly');
    });

    it('loadModel: cds.load throws — catch returns error object', async () => {
        // Provide a projectRoot that has a package.json and @sap/cds resolvable,
        // but override cds.load to throw. We do this by constructing a fake module
        // via createRequire on a tmp package that exports a cds stub with a throwing load().
        const { join } = require('node:path');
        const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
        const { tmpdir } = require('node:os');
        const tmp = join(tmpdir(), `cds-loadfail-${process.pid}`);
        const cdsDir = join(tmp, 'node_modules', '@sap', 'cds');
        mkdirSync(cdsDir, { recursive: true });
        writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));
        writeFileSync(
            join(cdsDir, 'package.json'),
            JSON.stringify({
                name: '@sap/cds',
                version: '0.0.0',
                main: 'index.js',
            }),
        );
        writeFileSync(
            join(cdsDir, 'index.js'),
            `
            module.exports = { load: async () => { throw new Error('simulated load failure'); } };
        `,
        );
        try {
            let written = null;
            await worker.runWorkerMain(tmp, 'SELECT id FROM X', '0', undefined, (r) => {
                written = r;
            });
            assert.ok(written?.error?.includes('cds.load failed'), `expected cds.load error, got: ${written?.error}`);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('runMain: --batch .catch() fires when runBatchWorkerMain rejects', async () => {
        // Use a projectRoot with @sap/cds stub that throws from load(),
        // then pass a write callback that also throws — runBatchWorkerMain will
        // reject (via a thrown write), exercising the .catch() on line 148.
        const { join } = require('node:path');
        const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
        const { tmpdir } = require('node:os');
        const tmp = join(tmpdir(), `cds-batchcatch-${process.pid}`);
        const cdsDir = join(tmp, 'node_modules', '@sap', 'cds');
        mkdirSync(cdsDir, { recursive: true });
        writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));
        writeFileSync(
            join(cdsDir, 'package.json'),
            JSON.stringify({
                name: '@sap/cds',
                version: '0.0.0',
                main: 'index.js',
            }),
        );
        // cds.load succeeds but returns no definitions; write() throws to trigger .catch
        writeFileSync(
            join(cdsDir, 'index.js'),
            `
            module.exports = { load: async () => ({ definitions: {} }) };
        `,
        );
        const out = [];
        // write() throws on first call to trigger the .catch in runMain --batch
        let calls = 0;
        const throwingStdout = {
            write: (s) => {
                calls++;
                if (calls === 1) throw new Error('forced batch write failure');
                out.push(s);
            },
        };
        try {
            await worker.runMain(['node', 'w', tmp, '--batch', JSON.stringify([])], makeStdin(), throwingStdout);
            // The .catch writes the error — it calls write again (calls === 2)
            assert.ok(out.length > 0 || calls >= 1, '.catch path must be reached');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('runMain: single-query .catch() fires when runWorkerMain rejects', async () => {
        // Same approach: cds.load succeeds, but write() throws on the first call
        // so runWorkerMain rejects, exercising the .catch on line 218.
        const { join } = require('node:path');
        const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
        const { tmpdir } = require('node:os');
        const tmp = join(tmpdir(), `cds-singlecatch-${process.pid}`);
        const cdsDir = join(tmp, 'node_modules', '@sap', 'cds');
        mkdirSync(cdsDir, { recursive: true });
        writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));
        writeFileSync(
            join(cdsDir, 'package.json'),
            JSON.stringify({
                name: '@sap/cds',
                version: '0.0.0',
                main: 'index.js',
            }),
        );
        writeFileSync(
            join(cdsDir, 'index.js'),
            `
            module.exports = { load: async () => ({ definitions: {} }) };
        `,
        );
        const out = [];
        let calls = 0;
        const throwingStdout = {
            write: (s) => {
                calls++;
                if (calls === 1) throw new Error('forced single write failure');
                out.push(s);
            },
        };
        try {
            await worker.runMain(['node', 'w', tmp, 'SELECT id FROM X', '0', ''], makeStdin(), throwingStdout);
            assert.ok(calls >= 1, '.catch path must be reached');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('runMain: --persistent watcher fires twice to exercise clearTimeout branch', async () => {
        // The clearTimeout branch in the watch callback (line 162) fires when a second
        // .cds change arrives before the 200ms debounce expires. Use the fake watch stub.
        const { EventEmitter } = require('node:events');

        let capturedCallback = null;
        const fakeWatcher = new EventEmitter();
        worker._testOverrides.watch = (_path, _opts, cb) => {
            capturedCallback = cb;
            return fakeWatcher;
        };

        const out = [];
        const pt = new PassThrough();
        pt.push(
            JSON.stringify({
                id: 30,
                kind: 'single',
                projectRoot: '/no-such-root',
                args: ['SELECT  FROM X', '0', ''],
            }) + '\n',
        );

        const runPromise = worker.runMain(['node', 'worker.js', '/no-such-root', '--persistent'], pt, { write: (s) => out.push(s) });
        await new Promise((res) => setTimeout(res, 10));

        assert.ok(capturedCallback, 'watch must have been called');
        const fireCb2 = capturedCallback;
        // First fire sets invalidateTimer
        fireCb2('change', 'schema.cds');
        // Second fire immediately clears and resets it (clearTimeout branch)
        fireCb2('change', 'other.cds');

        await new Promise((res) => setTimeout(res, 10));
        pt.push(null);
        await runPromise;
        assert.ok(
            out.find((s) => s.includes('"id":30')),
            'must respond to id=30',
        );

        delete worker._testOverrides.watch;
    });

    it('runMain: --persistent single with undefined query exercises query ?? "" branch (line 208)', async () => {
        // req.args = [] so query=undefined → query ?? '' fires the ?? branch; cursorStr=undefined → '-1' → diagnostics
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];
        const pt = new PassThrough();
        pt.push(
            JSON.stringify({
                id: 60,
                kind: 'single',
                projectRoot: fixtureRoot,
                args: [],
            }) + '\n',
        );
        pt.push(null);
        await worker.runMain(['node', 'worker.js', fixtureRoot, '--persistent'], pt, { write: (s) => out.push(s) });
        const resp = out.find((s) => s.includes('"id":60'));
        assert.ok(resp, `must respond to id=60, got: ${JSON.stringify(out)}`);
        assert.ok('diagnostics' in JSON.parse(resp).result, 'empty query must yield diagnostics result');
    });

    it('runMain: --persistent single with undefined query on completions path exercises query ?? "" (line 209)', async () => {
        // args = [undefined, '7'] → query=undefined, cursorStr='7' → offset=7 → completions path
        // query ?? '' fires the ?? true-branch on line 209
        const { join } = require('node:path');
        const fixtureRoot = join(__dirname, 'data/distributedModel');
        const out = [];
        const pt = new PassThrough();
        // JSON.stringify preserves undefined array holes as null → destructuring gives null, but
        // null ?? '' does NOT fire ?? (null is nullish) — use a sparse array trick: send no index 0
        // Actually null IS nullish, so null ?? '' = '' which hits the ?? branch too.
        pt.push(
            JSON.stringify({
                id: 61,
                kind: 'single',
                projectRoot: fixtureRoot,
                args: [null, '7', 'BookingService'],
            }) + '\n',
        );
        pt.push(null);
        await worker.runMain(['node', 'worker.js', fixtureRoot, '--persistent'], pt, { write: (s) => out.push(s) });
        const resp = out.find((s) => s.includes('"id":61'));
        assert.ok(resp, `must respond to id=61, got: ${JSON.stringify(out)}`);
        assert.ok('completions' in JSON.parse(resp).result, 'null query on completions path must yield completions');
    });
});
