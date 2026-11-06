# CDS TypeScript Plugin

A TypeScript Language Service Plugin that provides CQL-aware completions, hover, and diagnostics inside `cds.ql\`...\`` tagged template literals in `.js`/`.ts` files.

## Activation

The plugin is registered automatically by the `vscode-cds` extension via `contributes.typescriptServerPlugins` in its `package.json`. No `tsconfig.json` entry is required in VS Code.

For editors that do not support `contributes.typescriptServerPlugins`, or to override options, add an explicit entry:

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "cds-ts-plugin" }
    ]
  }
}
```

### Activating for loose `.js` files (out-of-the-box, no tsconfig/jsconfig)

CAP service files are often plain `.js` with **no** `tsconfig.json`/`jsconfig.json`, and users frequently rely on a **global** `@sap/cds`/`@sap/cds-dk` install (never running `npm i` in the project). Both must work with zero setup. Two independent conditions must hold:

1. **The model must load.** The resolver worker resolves `@sap/cds` from the project first, then falls back to global module roots (`NODE_PATH` entries, the node-prefix-relative global `node_modules`, `/usr/local/lib/node_modules`, `/opt/homebrew/lib/node_modules`). No shell or `npm root -g` is used. Set `CDS_LSP_NO_GLOBAL_FALLBACK=1` to force strictly-local resolution. See `loadModel` in `cds-resolver-worker.ts`.

2. **tsserver must load the plugin for the file's project.** A tsserver plugin only runs for files tsserver has assigned to a project with the plugin enabled. For loose `.js` files this is the responsibility of the **`vscode-cds` extension** (a separate repo), which must:
   - register the plugin as `{ "name": "cds-ts-plugin", "enableForWorkspaceTypeScriptVersions": true }` under `contributes.typescriptServerPlugins` — the `enableForWorkspaceTypeScriptVersions` flag is required so the plugin loads under the project's own TypeScript version (the common CAP case);
   - declare `activationEvents` for `onLanguage:javascript` and `onLanguage:typescript` so opening a JS/TS file activates the extension and causes VS Code to open the file in tsserver (which triggers project assignment — including VS Code's built-in inferred JS project with `allowJs`);
   - push the feature flags on activation and on config change via `typescript.tsserver.pluginManager.getAPI` → `configurePlugin('cds-ts-plugin', { … })` (see "Live configuration from VS Code" below) — all flags default `false`, so without this call the plugin is inert;
   - **not** scaffold an on-disk `jsconfig`/`tsconfig` in the user's workspace.

If a `.js`/`.ts` file containing `cds.ql` is not assigned to a project, the plugin logs a one-time hint (`… is not assigned to a TS project — CQL features inactive …`) pointing at these extension-side prerequisites.


## Features

### Code completion
Inside a `cds.ql\`...\`` template literal:
- **Field completions** in `SELECT`, `WHERE`, `ORDER BY` clauses — drawn from the entity named in `FROM`/`JOIN`.
- **Entity completions** after `FROM` and `JOIN` — local entity and view names from the CDS model.
- **Expand block completions**: inside `entity { ... }` postfix-projection blocks and inline `assoc.{ ... }` expand blocks, completions are scoped to the association's target entity fields. Nested expand blocks (`author { address { | } }`) recurse through the association chain, including aliased expands (`author as writer { | }`).
- Completions work with relation aliases (`FROM Authors AS A`) and multiple `JOIN` sources.
- Selecting an entity completion without a `// @cds-service` annotation triggers an automatic annotation insertion code action.

### Hover
- Hovering over a **field name** inside the template shows its CDS type and source entity.
- Hovering over an **entity name** in `FROM`/`JOIN` shows `(cds entity) ServiceName.EntityName`.
- Hovering over the **result variable** (`const result = (await) cds.ql\`...\``) shows the inferred TypeScript type:
  - `awaited` → `{ field: type; ... }[]`
  - non-awaited → `Promise<{ field: type; ... }[]>`
  - Respects `SELECT col AS alias` — shows alias as property name.
  - Expand blocks (`author { name }`) appear as nested object types (`author: { name: string }[]`).
- Hovering over a **property access on a cds.ql result** (`result.at(0)?.bookTitle`, `result[0].ID`) shows the field type (`(cds field) bookTitle: string`). Works for both `?.` optional chains and regular `.` accesses.
- Hovering over a **binding element destructured from a cds.ql result**:
  - `const [{ID}] = await cds.ql\`...\`` → shows field type: `const ID: number`
  - `const [fst] = await cds.ql\`...\`` → shows row type: `const fst: { ID: number; ... }`
  - `const [r1] = result` (where `result` was assigned from `cds.ql`) → shows row type via `result`

### Type inference (snapshot rewriting)
For each `const v = (await) cds.ql\`...\`` declaration the plugin rewrites the snapshot seen by TypeScript so it infers the correct result type and provides property completions on the variable. Character positions are preserved; no source map changes are needed.

Two CQL column orderings are fully supported (per [CQL docs](https://cap.cloud.sap/docs/cds/cql#expressions)):
- **Classic**: `SELECT ID, title FROM Books` — flat column list between `SELECT` and `FROM`.
- **Postfix-projection**: `SELECT FROM Books { ID, title }` — `SELECT` still comes first; the column list follows the entity name in `{...}`.
- **Expand blocks**: `SELECT FROM Books { ID, author { name } }` — association fields produce nested object types (`author: { name: string }[]`). Nesting is recursive via BFS: each level of expand associations is resolved by probing target entity fields, so `author { address { street } }` correctly produces `author: { address: { street: string }[] }[]`. Inline dot-expand (`author.{ name }`) is equivalent, and aliased expands (`author as writer { name }`) nest under the alias.

The `one` singularizer keyword is recognized in classic projections: `SELECT one ID, title FROM Books` (case-insensitive, immediately after `SELECT`, before the column list). It is CAP's in-template equivalent of the fluent `SELECT.one` and is excluded from column resolution — the columns that follow it are validated and typed as usual.

> Note: `FROM Entity SELECT …` (the `FROM` keyword before `SELECT`) is **not** valid CQL and is intentionally not parsed — such a query yields no columns and the variable type degrades to `unknown`.

The rewrite differs by file type:

- **`.ts`/`.tsx` files**: Only the template literal (opening backtick through closing backtick, i.e. `template.template.pos → template.template.end`) is replaced with a same-length `as unknown as` cast:
  ```
  `` as unknown as _qN<spaces…>
  ```
  The `const`/`let`/`await`/`cds.ql` prefix is left completely untouched, so hover over `cds.ql` works correctly and no declaration-level TS errors are produced. The `as unknown as` assertion makes TypeScript treat the tagged-template result as `_qN`. All replacement bytes fall within the replaced span and are suppressed by the classification-filter proxy (no syntax-highlighting bleed).

  The full type lives in a tail alias appended after the last line: `type _qN = T;`

  The classification proxy handles two categories of token differently:

  **Syntactic classifications** (`getEncodedSyntacticClassifications`): VS Code calls this per-line to obtain syntax-highlight tokens. For any file with a rewritten snapshot, the proxy temporarily restores the original `getSnapshot` on the `ScriptInfo` object (`withOriginalSnapshot`), calls the underlying TS classifier, then restores the patched snapshot. Since tsserver is single-threaded this swap is safe. The result is that VS Code always sees tokens from the original source — including the full template-literal token `\`...\``, which the old filtering approach incorrectly dropped (its start position equals `replaceStart`, so it was classified as a "rewritten range" token and suppressed).

  **Semantic classifications** (`getEncodedSemanticClassifications`): These are type-aware and must use the rewritten source (so `_qN` alias tokens get correct type coloring). Injected tokens are filtered out before returning to VS Code:
  - Tokens whose start position falls inside a `rewrittenRange` (the span replacing the template literal).
  - Tokens whose start position is ≥ the original source length (tail-alias tokens `type _qN=…;`).

  **Deterministic semantic-colour freeze (the governing invariant).** Snapshot rewriting mutates the whole program TypeScript sees, so *any* transient difference in the served snapshot — a partial rewrite while a query resolves, or a stale one during the debounce window — makes tsserver re-run whole-file type inference and can recolour **unrelated** identifiers (e.g. `cds` in `cds.ql` flipping teal↔mint). Reprojecting token *positions* cannot fix this: the token is in the right place, its *classification id* changed. Chasing individual tokens never converges.

  The plugin enforces one invariant instead: **semantic classifications VS Code sees always come from a snapshot that is fully resolved for the current buffer; they change only when a fully-resolved rewrite lands, never mid-transition.** `getEncodedSemanticClassifications` decides per request:
  - **Fully resolved** (`rewriteCache.get(fileName)?.sourceText === liveBuffer`): classify against the rewritten snapshot, filter injected tokens, and store the result in `lastGoodSemantic` (keyed by `` `${fileName} ${span.start} ${format}` `` — *not* span length, which changes every keystroke) tagged with the live source it describes.
  - **Transition** (partial/stale snapshot): do **not** re-run the classifier. Take the `lastGoodSemantic` baseline and reproject it onto the live buffer via `spliceDiff(baseline.source, liveBuffer)` — tokens before the edit keep position, tokens after shift by `delta`, tokens inside the edited region drop. Classification ids are preserved verbatim, so colours are frozen.
  - **No baseline yet** (first classification before any full rewrite): fall back to filtering + reprojecting the current snapshot (the pre-freeze behaviour).

  This subsumes both flicker classes — positional drift *and* semantic-value changes — under a single rule, so it is robust to arbitrary edits rather than patched per observed token.

  **Synchronous rewrite from the type-expression cache (keeps the baseline fresh).** The inferred type for a query is fully determined by `(queryText, effectivePrefix, awaited)` — the surrounding TS code does not affect it. `rewriteSnapshot` therefore caches, per `_testOverrides`-injectable `typeExprCache: Map<string,string>`, the resolved type expression keyed by `` `${awaited?'A':'P'} ${prefix} ${queryText}` ``. On the debounce branch, `doRewrite` re-runs `rewriteSnapshot` with `{ typeExprCache, cacheOnly: true }`, which splices the cached casts into the **current** buffer. Two outcomes:

  - **Every query cached** (edit was in surrounding code, or before/after a query): all casts are re-placed **synchronously** at the new positions with **no worker call**, `rewriteCache` is refreshed, the pending timer is cleared, and the fresh snapshot — byte-for-byte the live buffer — is returned. This is "fully resolved" above, so the freeze baseline recomputes immediately and atomically.
  - **One query's text actually changed** (e.g. typing inside a query in a multi-query file): that query misses the cache and is left as **plain source** (its inference is pending), but every *other* query's cast is still placed at its correct **live** position. `doRewrite` returns this live-aligned partial snapshot immediately and schedules the worker to fill in the changed query. The freeze keeps every declaration's colour stable until the worker lands the full rewrite; only the query being actively edited lacks a type until then.

  `servedSource: Map<string,string>` records the source text each served snapshot was built from (the debounce path serves a live-aligned partial that is deliberately **not** written to `rewriteCache`, so the async retry still re-resolves the changed query). `computeStaleEdit` compares against `servedSource`, so the fallback reprojection is a no-op for these live-aligned snapshots and only engages for genuinely stale ones.

  **Debounce-desync smoothing (token reprojection, fallback).** Reprojection remains as a safety net for the case where no fully-resolved baseline exists yet, or the classified snapshot genuinely lags the live buffer. A naive filter that simply *dropped* the now-misaligned tokens produced a visible **flash** — colours after the edit point vanished, then snapped back when the debounce fired.

  Instead, `computeStaleEdit(fileName)` models B as a single splice of A (the common case for keystroke editing) by comparing the rewrite's source (`rewriteCache.get(fileName).sourceText`) against the live buffer (read via `withOriginalSnapshot`): a common **prefix**, a replaced middle, and a common **suffix** shifted by `delta = liveLen - staleLen`. `filterSemanticClassifications` then **reprojects** each surviving token onto B's coordinate system:
  - `tokStart < prefix` → keep unchanged (before the edit).
  - `tokStart ≥ staleSuffixStart` → shift to `tokStart + delta` (after the edit).
  - otherwise (inside the edited region) → drop; token identity is genuinely unknown until the fresh rewrite lands.

  Tokens keep their colour *in place* throughout the window instead of flashing off and on. When the debounce timer produces a consistent rewrite and calls `triggerTsServerRefresh`, `computeStaleEdit` returns `null` (source matches) and reprojection is a no-op. The tail-alias cutoff uses the **stale** revision's length (`rewriteCache…sourceText.length`), not the live buffer length, since tokens arrive in the classified snapshot's coordinate system.

  ```
  // original:  const result = await cds.ql`SELECT ID FROM Books`;
  // rewritten: const result = await cds.ql`` as unknown as _q1;
  //            ... (appended) type _q1={ID:string}[];
  ```

  Alias type: awaited → `{...}[]`; non-awaited → `Promise<{...}[]>`. TypeScript automatically applies `Awaited<>` to the awaited form, giving the variable the correct unwrapped type.

- **`.js`/`.jsx` files**: The initializer span (`name.end` → `initializer.end`) is replaced with a same-length JSDoc cast ` = (/**@type{_qN}*/(0))`. The type definition is appended as `/**@typedef {T} _qN*/`.

In both cases the alias name encodes the declaration line number (`_qN` where N is the 0-based line), making it stable across edits and unique within the file. Type aliases are always appended after the last line of the file — this does not affect any original-line byte offsets.

#### Triggering program rebuild on open

When a file is first opened (or after a window reload), the plugin patches `ScriptInfo.getSnapshot` so it returns the rewritten snapshot. However, tsserver caches the compiled program and only rebuilds it when the `ScriptInfo` version changes. Calling `markContainingProjectsAsDirty()` alone is insufficient because tsserver's `isProgramUptoDate` checks each file's version string — which only changes via `edit()` or `useText()` on the internal `ScriptVersionCache`.

To force a rebuild, the plugin calls `scriptInfo.editContent(0, 0, '')` (a zero-length insert at position 0) after patching. This bumps the SVC version counter without changing any source content, making `isProgramUptoDate` return `false` so tsserver re-reads the (now rewritten) snapshot on the next `updateGraph()` call.

### Diagnostics
CQL errors are reported in the Problems panel (source `cds`) with the following codes:

| Code | Meaning |
|------|---------|
| 9001 | Unknown entity or view in `FROM`/`JOIN` |
| 9002 | Unknown source alias in a qualified reference (`Z.field` where `Z` is not declared) |
| 9003 | Unknown field (qualified or unqualified) |
| 9004 | Ambiguous unqualified field present in multiple `JOIN` sources |

### Service annotation
A `// @cds-service <ServiceName>` comment on the line immediately before the statement scopes all queries in that block to the named service. Without it, FQN entity names (`ServiceName.Entity`) must be used in the query. `<ServiceName>` may itself be a dotted namespace (e.g. `sap.capire.hotels`); the auto-insert code action derives it from the completed entity's FQN by dropping only the final segment (the entity name).

## Configuration

All features are **disabled by default** (opt-in). Options are read from `info.config`, which tsserver populates from the `options` object in the `tsconfig.json` plugins entry. To opt in, add an explicit entry:

```json
{
  "compilerOptions": {
    "plugins": [{
      "name": "cds-ts-plugin",
      "options": {
        "cds.ql.completion":    true,
        "cds.ql.hover":         true,
        "cds.ql.diagnostics":   true,
        "cds.ql.typeInference": true
      }
    }]
  }
}
```

### Live configuration from VS Code

The plugin exports `onConfigurationChanged(config)` in its `PluginModule`. The `vscode-cds` extension can push settings changes live without restarting tsserver:

```typescript
// In the VS Code extension (activate + onDidChangeConfiguration):
const tsApi = await vscode.commands.executeCommand<{ configurePlugin: Function }>(
    'typescript.tsserver.pluginManager.getAPI', 0
);
function pushConfig() {
    const cfg = vscode.workspace.getConfiguration('cds.ql');
    tsApi?.configurePlugin('cds-ts-plugin', {
        'cds.ql.completion':    cfg.get<boolean>('completion',    false),
        'cds.ql.hover':         cfg.get<boolean>('hover',         false),
        'cds.ql.diagnostics':   cfg.get<boolean>('diagnostics',   false),
        'cds.ql.typeInference': cfg.get<boolean>('typeInference',  false),
    });
}
pushConfig();
vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('cds.ql')) pushConfig();
});
```

## Module layout

| File | Responsibility |
|------|---------------|
| `index.ts` | Plugin factory, snapshot patching, proxy wiring, `PersistentWorkerPool` |
| `QueryContext.ts` | Shared types (`RunWorker`, `PluginConfig`, `QueryContext`), `readConfig`, `resolveQueryContext` |
| `CqlCompletions.ts` | `getCqlCompletions`, `getCqlCompletionDetails` |
| `CqlHover.ts` | `getCqlHover` — Case 1 (field/entity inside template), Case 2 (result variable and property access on result), Case 3 (binding elements destructured from array) |
| `CqlDiagnostics.ts` | `getCqlDiagnostics` |
| `CqlTypeRewriter.ts` | `collectCqlAssignments`, `rewriteSnapshot` (accepts `{ typeExprCache, cacheOnly }` for synchronous cache-only rewrites), `resolveTypeExpr`, `placeCast` |
| `CqlLogic.ts` | Re-export barrel for the CQL core (`tokenizeCql`, `parseCqlColumns`, `getTokenContext`, `getCursorClause`, `extractSourceRelations`, `cdsTypeToTs`, `resolveBaseType`, `getSuggestions`, `validateCqlQuery`, `CQL_KEYWORDS`, `CqlDiagnosticCode`). Implementation lives in `cql/` (below) — preserves the historical import surface. |
| `cql/` | Self-contained CQL core (no LSP/external deps): `lexer.js` (`tokenizeCql`, `CQL_KEYWORDS`), `parser.js` (column/expand parsing), `cursor-analysis.js` (clause/token context, source extraction), `csn-resolve.js` (CDS→TS type + source/association resolution), `endpoints.js` (`getSuggestions`, `validateCqlQuery`), `diagnostic-codes.js` (`CqlDiagnosticCode`), `types.d.ts` (shared declarations). |
| `TsAstHelpers.ts` | Shared TypeScript AST predicates/walkers (`isCdsQlInit`, `findAncestor`, `unwrapAwait`, …) |
| `ServiceAnnotation.ts` | `// @cds-service` comment reader |
| `csn.ts` | Minimal CSN (`@sap/cds` reflected model) type shims — `CsnArtifact`, `CsnElement`, `CsnDefs`, plus `csnText`/`csnEntryKind`. Temporary until `@sap/cds` ships official CSN types. |
| `cds-resolver-worker.ts` | Child process worker — loads `@sap/cds`, resolves completions/diagnostics, prints JSON. Supports `--persistent` mode (long-lived, model cached, newline-delimited JSON IPC). |
| `cds-bridge-thread.ts` | `WorkerThread` bridge that owns the worker child process and its async stdio, letting the synchronous tsserver plugin block on `Atomics.wait` while I/O runs. |
| `test-overrides.ts` | `TestOverrides` type for the plugin's test-injection hook (separate module because `index.ts` uses `export =`, which bars named exports). |

The worker runs in **persistent mode**: one long-lived child process per `projectRoot` is kept alive by `PersistentWorkerPool` in `index.ts`. Requests and responses are exchanged as newline-delimited JSON over `stdin`/`stdout`. Synchronous IPC is implemented via a `WorkerThread` bridge that owns async I/O while the main thread blocks with `Atomics.wait`.

## Testing

Three test suites live in `test/`:

| File | Covers |
|------|--------|
| `test-ql-query.ts` | `CqlLogic`, `CqlTypeRewriter`, `CqlCompletions`, `CqlHover`, `CqlDiagnostics`, `QueryContext`, `ServiceAnnotation` — pure unit tests, no LSP server |
| `test-ql-ls.ts` | LanguageService integration through the same API VS Code uses — hover, semantic diagnostics, classification token-bleed filtering, type inference (incl. expand queries), and scope-collision handling for same-named result variables |
| `test-ql-plugin.ts` | Plugin proxy wiring — completions, hover, diagnostics, classification filtering, feature flags |

Run all suites:
```bash
npm test
# or individually:
node --test test/test-ql-query.js
```

Check coverage (Node's built-in `--experimental-test-coverage`, with the
thresholds enforced by the `check` gate):
```bash
npm run coverage
```


- **Template expressions** (`cds.ql\`SELECT ${expr} FROM ...\``) — interpolated parts are replaced with a single space; completions and validation inside expressions are not supported.
- **Subquery sources** — entities referenced only inside subqueries are not used for outer-clause completions or validation.
- **External services (`@cds.external`)** — services/entities annotated `@cds.external` are **not** part of the compiled model returned by `cds.load('*', { root })` (they are resolved at runtime against a remote/imported definition), so they never appear in the model definitions the plugin reads. CQL completion, validation, and type inference are therefore unavailable for external entities — a query like `` cds.ql`SELECT * FROM Bookings` `` scoped to an external service will not resolve its fields.
- **Uncompilable model (missing content dependencies)** — the plugin loads the *whole* model via `cds.load('*', { root })`; this is all-or-nothing. If the project references a CDS reuse package it hasn't installed (e.g. `using … from '@capire/xflights-data'` with that package absent), the compile aborts and **no** definitions are available, so **every** query in the project loses CQL support — not just the one that touches the missing import. This is deliberate: the plugin stays strict (a full model or none) rather than serving a partial/degraded model that would disagree with `cds watch`. Note that `@sap/cds` itself is resolved local-first then from global installs (see the activation section), so a globally-installed `@sap/cds-dk` is sufficient for *it* — but project-specific `@capire/*` content packages must still be installed. When the model can't compile, the failure is surfaced (not silent): the compile error is logged to the tsserver log, and when `cds.ql.diagnostics` is enabled it appears as a **warning** on the query (`CQL features unavailable: cds.load failed: …`).
- **Associations under `SELECT *`** — a bare `SELECT *` filters associations/compositions out of the inferred row type (only scalar fields are shown). Associations selected explicitly with an expand block (`author { name }`) or as a bare column (`{ author }`, treated as an implicit `SELECT *` expand) *are* rendered as nested object types, in both the inferred variable type and hover.
- **Rename / go-to-definition** — no cross-reference support between query fields and CDS model elements.
- **Performance** — each completion, hover, and diagnostic request uses a persistent child process per `projectRoot` (model loaded once on first request, reused via `PersistentWorkerPool`). Latency after warm-up is ~5–15 ms vs ~125 ms for the old per-call spawn approach.
