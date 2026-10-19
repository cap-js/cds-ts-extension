# Development

## Local setup

```sh
npm install
npm run check   # typecheck + format:check + lint + coverage — the full quality gate
```

`npm run check` is exactly what CI runs. Run it before pushing.

## Quality gates

- **`check`** runs, in order: `typecheck`, `format:check`, `lint`, `coverage`.
  All four must pass; CI runs this same command on push and PR.
- **Coverage thresholds** (in the `coverage` script) are **floors, not targets** —
  a ratchet set to the current state (lines 98%, functions 96.7%, branches 92%).
  They exist to prevent regressions; raise them if coverage improves, never lower
  them to make a change pass.
- **Lint severities** (`biome.json`): most correctness/suspicious rules are at
  `error`. A few stay softer on purpose and do **not** fail the gate:
  - `noExplicitAny` (`warn`) — there are legitimate `any` uses for tsserver
    internal APIs in `src/` plus heavy use in tests. Revisit as a dedicated
    typed-cleanup task, not incrementally.
  - `useNamingConvention`, `useAwait`, `noNonNullAssertion`, and a few others
    (`info`) — have known intentional violations (e.g. the `_testOverrides`
    injection const, `cds.ql.*` config keys). Kept visible but non-blocking.
  Note: `biome.json` is plain JSON — comments are not allowed there, so this list
  is the canonical record of *why* these are soft.
- **Node**: the `engines` field declares `>=24.0.0` and CI runs on Node 24, which
  is the supported floor. Develop on Node 24+.


## Live end-to-end loop (Extension Host)

The plugin is loaded by the `vscode-cds` extension as a TypeScript server plugin
registered under the name `cds-ts-plugin`.

### One-time wiring

In the `vscode-cds/extension` directory, add this package as a local dependency and
rebuild the extension bundle:

```sh
cd <path-to-vscode-cds>/extension
# Add the local package (only needed once; already in package.json if a colleague did this)
npm install
npm run bundle:debug
```

### The loop

1. **Launch the Extension Host.** In `<path-to-vscode-cds>`, run the **Launch Extension**
   debug configuration (F5). This opens an Extension Development Host with the local
   extension — and therefore this plugin — loaded.

2. **Enable the features.** The `cds.ql.*` capabilities default to off. In the Ext Host
   window's settings, enable the ones you're testing:
   - `cds.ql.completion`
   - `cds.ql.hover`
   - `cds.ql.diagnostics`
   - `cds.ql.typeInference`

   Open a `.ts`/`.js` file with a `` cds.ql`...` `` template in a CAP project and confirm
   completions/hover/diagnostics/inference behave.

3. **Iterate.** Edit source in this repo → in the Ext Host run
   **TypeScript: Restart TS Server** (Command Palette) to reload the plugin with your
   changes. No build step or extension reload needed — tsserver loads `src/` directly.

## Notes

- **CommonJS end-to-end.** tsserver loads the plugin via `export = pluginFactory`; the
  worker uses `require.main === module` and `worker_threads`. Do not add `"type":
  "module"` or emit ESM.
- **`typescript` and `@sap/cds` are not bundled.** The TS server injects its own
  `typescript`; `@sap/cds` is resolved at runtime from the user's project.
- **Restart the TS Server, not the extension.** The plugin runs inside the TypeScript
  server process. Only a TS Server restart reloads it.
