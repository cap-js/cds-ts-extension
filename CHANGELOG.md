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
- Runtime assumption tests (`test/runtime/`): a suite that validates the plugin's hand-coded CDS assumptions in `src/cql/csn-resolve.js` against a real `@sap/cds` runtime — compiling a purpose-built fixture model to every CSN flavor (raw, linked, odata, SQL) and firing live CQL at an in-memory SQLite database (the built-in `node:sqlite` driver; no native module needed), then checking the plugin's output with zod schemas. Run via the new `test:runtime` script, wired into the `check` gate.
- Recognition of the `one` singularizer keyword in `SELECT` projections (e.g. `` cds.ql`SELECT one ID, title FROM Books` ``). `one` is CAP's in-template equivalent of the fluent `SELECT.one` (the compiled CQN carries `SELECT.one = true`, and the query returns a single row rather than an array). It is case-insensitive and must precede the column list. Previously the lexer treated `one` as an identifier, so it was mistaken for a selected field and produced a spurious `Unknown field 'one'` diagnostic and a bogus `{ one: … }` entry in the inferred result type; now it is a keyword, excluded from column resolution while the columns that follow it are still validated.
- Keyword completions in CQL templates: `getSuggestions` now offers clause-appropriate CQL keywords alongside field/entity completions — `DISTINCT`/`FROM` in the `SELECT` clause; `WHERE`/`ORDER BY`/`GROUP BY`/`HAVING`/`LIMIT`/`OFFSET`/`JOIN`/`INNER JOIN`/`LEFT JOIN`/`RIGHT JOIN`/`ON`/`AS` once a `FROM` source has been named; `AND`/`OR`/`NOT`/`LIKE`/`BETWEEN`/`IN`/`IS`/`NULL`/`EXISTS` in `WHERE`; `ASC`/`DESC` in `ORDER BY`. Keywords are suppressed inside projection/expand blocks and right after a bare `FROM` (where only entities apply), and the host sorts them below fields and entities.

### Changed
- The tokenizer now treats `:` as punctuation (previously it was emitted as an `unknown` token and discarded). This preserves the key/value delimiter in object-literal query forms such as `` cds.ql`UPDATE Books SET { title: ... }` `` and `ENTRIES { ID: ... }`, enabling their field/key validation.
- Split the monolithic `src/CqlLogic.js` into a self-contained `src/cql/` core along its dependency layers (`lexer`, `parser`, `cursor-analysis`, `csn-resolve`, `endpoints`, `diagnostic-codes`, `types.d.ts`). `CqlLogic.js` is now a thin re-export barrel preserving the historical import surface, so consumers and tests are unchanged. No behavior change.
- `cdsTypeToTs` now maps the `Int64`/`Integer64` and `Decimal`/`DecimalFloat` families to the union `string | number` instead of `number`. CAP's `ieee754compatible` feature (on by default in cds 10, matching the OData wire format) serializes these as strings to preserve precision beyond the IEEE-754 double range, but returns plain numbers when the feature is off — so the inferred type must be a union the caller handles. The smaller integer types (`Integer`, `Int16`, `Int32`) and `Double`/`Float` remain `number`. Surfaced by the new runtime assumption tests.

### Deprecated

### Removed

### Fixed
- Eliminated false-positive `Unknown field` diagnostics on aggregate/scalar function names (e.g. `max`, `count`) used in SELECT columns.
- Eliminated false-positive `Unknown entity or view` diagnostics on draft shadow entities (`<Entity>.drafts`).
- Inline-dot expands (`` cds.ql`SELECT from Books { author.{ name } }` ``) now resolve correctly for completions and diagnostics at any nesting depth. Previously the association head (`author.`) retained its trailing dot, so completions inside the block returned nothing and the head itself was mis-flagged as an `Unknown field`.
- Synthesized managed-association foreign-key columns (e.g. `author_ID` for an association `author`) are now accepted as valid fields in `SELECT` column and `WHERE` validation. Previously only the write-statement path recognised them, so a `` cds.ql`SELECT author_ID FROM Books` `` was mis-flagged `Unknown field`. Field validation and ambiguity detection now build their element sets from `elementNamesWithForeignKeys`, matching the write path.
- Association-path references in `SELECT` columns (e.g. `` cds.ql`SELECT author.name, author.address.city FROM Books` ``) are now resolved by following the association to its target entity. Previously any dotted reference was treated strictly as `sourceAlias.field`, so an association path whose first segment is not a `FROM`/`JOIN` alias was mis-flagged as `Unknown source`. Source-alias qualification still works (including the combined `alias.assoc.field`), foreign-key columns are accepted at every hop, and genuine errors are still reported precisely — an unnavigable first segment as `Unknown source`, an unknown terminal field as `Unknown field`.

### Security
