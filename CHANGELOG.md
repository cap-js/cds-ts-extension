# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Initial standalone extraction of the CDS TypeScript Language Service Plugin from the `@sap/cds-lsp` repository. Provides CQL-aware completions, hover, diagnostics, and type inference inside `` cds.ql`...` `` tagged template literals in `.js`/`.ts` files. See [`src/README.md`](./src/README.md) for the full feature and design documentation.
- `DEVELOPMENT.md` documenting the live Extension-Host development loop (watch build wired into the VS Code extension via `dist` symlinks, feature flags, TS Server restart).
- `build:watch` script and a VS Code `watch` task for incremental esbuild rebuilds.
- Support for aggregate/scalar function calls in SELECT columns (e.g. `` cds.ql`SELECT max(ID) as ID FROM Books` ``): the function name is no longer mistaken for a field, its field arguments are validated, and `fn(args) as alias` parses to a single correctly-aliased column.
- Type inference for aggregate result columns: `count(...)` resolves to `number`, and `max`/`min`/`sum`/`avg` resolve to the type of their field argument (so `max(ID) as ID` infers `{ ID: number }` instead of `{ ID: unknown }`).
- Support for draft shadow entities: a trailing `.drafts` on a query target (e.g. `FROM AdminService.Books.drafts`) is stripped and resolved against the base entity for diagnostics, completions, and type inference. Draft shadows are not materialised in the compiled CSN, so they are mapped to the base entity, which carries the same element set.

### Changed

### Deprecated

### Removed

### Fixed
- Eliminated false-positive `Unknown field` diagnostics on aggregate/scalar function names (e.g. `max`, `count`) used in SELECT columns.
- Eliminated false-positive `Unknown entity or view` diagnostics on draft shadow entities (`<Entity>.drafts`).

### Security
