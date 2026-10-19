# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org/).

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Initial standalone extraction of the CDS TypeScript Language Service Plugin from the `@sap/cds-lsp` repository. Provides CQL-aware completions, hover, diagnostics, and type inference inside `` cds.ql`...` `` tagged template literals in `.js`/`.ts` files. See [`src/README.md`](./src/README.md) for the full feature and design documentation.
- `DEVELOPMENT.md` documenting the live Extension-Host development loop (watch build wired into the VS Code extension via `dist` symlinks, feature flags, TS Server restart).
- `build:watch` script and a VS Code `watch` task for incremental esbuild rebuilds.

### Changed

### Deprecated

### Removed

### Fixed

### Security
