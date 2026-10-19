# @cap-js/cds-ts-extension

A [TypeScript Language Service Plugin](https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin)
that provides CQL-aware completions, hover, diagnostics, and type inference inside
`` cds.ql`...` `` tagged template literals in `.js`/`.ts` files.

It runs inside the TypeScript server process. After registration it has no dependency
on the CDS Language Server — it resolves `@sap/cds` directly from the user's project
(with a global-install fallback) via a child-process worker.

> The full design documentation — features, the snapshot-rewriting invariants,
> configuration, diagnostic codes, and the worker protocol — lives in
> [`DEVELOPMENT.md`](./DEVELOPMENT.md).

## Layout

| Path | Contents |
|------|----------|
| `src/` | Plugin source. `index.js` is the plugin factory; `cds-resolver-worker.js` is the child-process worker. No build step — tsserver loads the JS files directly. |
| `test/` | Native `node:test` suites; `test/data/distributedModel/` is a CDS fixture project. |

## Scripts

| Command | Description |
|---------|-------------|
| `npm test` | Run all three test suites. |
| `npm run typecheck` | `tsc --noEmit` (checks JS via JSDoc types). |
| `npm run lint` | Biome lint (fails on error-level diagnostics). |
| `npm run format` | Biome format (write). |
| `npm run coverage` | Run tests with native V8 coverage and enforce thresholds. |
| `npm run check` | Full quality gate: typecheck + lint + coverage. Mirrors CI. |

## Using the plugin locally in VS Code

The plugin is shipped and activated by the `vscode-cds` extension, which bundles it
as a dependency and registers it with tsserver via `contributes.typescriptServerPlugins`.

### Development setup (vscode-cds + this repo)

1. Open `vscode-cds` in VS Code.
2. Run `npm install` inside `vscode-cds/extension/` to install dependencies (this
   repo is referenced as `"file:../../cds-ts-plugin"`, so the local checkout is used).
3. Launch the **Extension Host** (`F5`).
4. In the newly opened window, open a CAP project.
5. Enable the features you want in VS Code settings (all are opt-in):

```json
"cds.ql.completion": true,
"cds.ql.hover": true,
"cds.ql.diagnostics": true,
"cds.ql.typeInference": true
```

6. Open a `.js` or `.ts` file that uses `` cds.ql`SELECT ...` ``.

Because `src/index.js` is the entry point directly, any edits to `src/` are picked up
after **TypeScript: Restart TS Server** — no build step required.

### Using a local checkout in a CAP project (without vscode-cds dev setup)

If you want to test the plugin in isolation inside a project:

```sh
# In your CAP project:
npm install /path/to/cds-ts-plugin
```

Then add to the project's `tsconfig.json` or `jsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@cap-js/cds-ts-extension" }]
  }
}
```

And enable features in `.vscode/settings.json`:

```json
"cds.ql.completion": true,
"cds.ql.hover": true,
"cds.ql.diagnostics": true,
"cds.ql.typeInference": true
```

## Requirements

- Node.js >= 24 (native test runner with coverage thresholds).
- `@sap/cds` is a devDependency so the worker/model-loading tests can load a real model.

## Coverage thresholds

Enforced via the native test runner (`--test-coverage-*`): lines 98%, functions 96.7%,
branches 92%.
