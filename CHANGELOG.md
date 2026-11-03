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
- Type inference for aggregate result columns: `count(...)` resolves to `number`, and `max`/`min`/`sum`/`avg` resolve to the type of their field argument, including qualified arguments such as `max(b.ID)` (so `max(ID) as ID` infers `{ ID: number }` instead of `{ ID: unknown }`).
- Support for draft shadow entities: a trailing `.drafts` on a query target (e.g. `FROM AdminService.Books.drafts`) is stripped and resolved against the base entity for diagnostics, completions, and type inference. Draft shadows are not materialised in the compiled CSN, so they are mapped to the base entity, which carries the same element set.
- Diagnostics for `UPDATE`, `INSERT`, and `UPSERT` statements: the target entity is validated (`Unknown entity or view`), as are the `SET` targets and `WHERE` fields of `UPDATE` and the column list / `ENTRIES` keys of `INSERT`/`UPSERT` (`Unknown field`). Generated foreign-key columns of managed associations (e.g. `flight_ID` for an association `flight`) are recognised as valid fields. Literal values (`SET` right-hand sides, `VALUES` lists) are never flagged. Previously these statements received no validation at all.
- Awaited result-type inference for write statements: `const n = await cds.ql\`UPDATE …\`` now infers a concrete type instead of `any` — `number` for `UPDATE`/`DELETE` (affected-row count) and `{ affected: number }` for `INSERT`/`UPSERT` (the CAP `InsertResult` accessor). The type is fixed (not derived from `@sap/cds` typings), so it needs no CDS model probe and is unaffected by whether the project ships cds type declarations.

### Changed
- The tokenizer now treats `:` as punctuation (previously it was emitted as an `unknown` token and discarded). This preserves the key/value delimiter in object-literal query forms such as `` cds.ql`UPDATE Books SET { title: ... }` `` and `ENTRIES { ID: ... }`, enabling their field/key validation.
- Split the monolithic `src/CqlLogic.js` into a self-contained `src/cql/` core along its dependency layers (`lexer`, `parser`, `cursor-analysis`, `csn-resolve`, `endpoints`, `diagnostic-codes`, `types.d.ts`). `CqlLogic.js` is now a thin re-export barrel preserving the historical import surface, so consumers and tests are unchanged. No behavior change.

### Deprecated

### Removed

### Fixed
- Eliminated false-positive `Unknown field` diagnostics on aggregate/scalar function names (e.g. `max`, `count`) used in SELECT columns.
- Eliminated false-positive `Unknown entity or view` diagnostics on draft shadow entities (`<Entity>.drafts`).
- Inline-dot expands (`` cds.ql`SELECT from Books { author.{ name } }` ``) now resolve correctly for completions and diagnostics at any nesting depth. Previously the association head (`author.`) retained its trailing dot, so completions inside the block returned nothing and the head itself was mis-flagged as an `Unknown field`.

### Security
