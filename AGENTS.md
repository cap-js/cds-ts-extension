# AGENTS.md

Guidance for any AI agent (and human) working in this repository. This file is
agent-agnostic by intent — it binds whatever tool is steering the repo.

## What this project is

A TypeScript Language Service plugin providing CQL-aware completions, hover,
diagnostics, and type inference inside `` cds.ql`...` `` tagged template literals.
The code is largely AI-authored and human-steered. See `README.md` /
`DEVELOPMENT.md` for architecture.

## The one rule that matters most: do not weaken safeguards to go green

This project leans on safeguards that check the plugin against an **independent
source of truth** (the real `@sap/cds` runtime), because ordinary tests and type
checks only verify "the code does what the code says" — they cannot catch a
*wrong assumption*. Several such bugs have shipped past green tests already
(e.g. `Int64`→`number`, association paths and foreign-key columns wrongly
rejected). The safeguards exist precisely to catch that class of error.

**Therefore, when a safeguard check fails:**

1. **The default is to fix the code**, not the check. A failing differential
   oracle, coverage gate, or corpus check almost always means a real defect.
2. **Relaxing a "dial" is a deliberate, separate, reviewed act.** Lowering a
   coverage/mutation threshold, adding a corpus suppression, loosening the
   differential battery, or changing a pinned dependency version requires:
   - explicit human sign-off, and
   - a stated reason (in the PR description and, ideally, a linked issue), and
   - **its own change** — never bundled quietly inside a feature/fix PR.
   A feature PR that also turns a dial down is the signature of rot; do not do it.
3. **Dials only ratchet in the safe direction.** Coverage thresholds and
   (future) mutation scores go up or hold, never down, absent sign-off per (2).

If you genuinely believe a safeguard is wrong (testing the wrong thing, not the
code being wrong), say so explicitly and ask — do not silently adjust it.

## Safeguards & where their dials live (the map)

| Safeguard | What it protects | Dial location |
|---|---|---|
| Coverage thresholds | tests actually execute the code | `coverage` script flags in `package.json` (`--test-coverage-lines/-functions/-branches`) |
| Differential runtime oracle | plugin agrees with real `@sap/cds` (not just with itself) | `test/runtime/differential.js` (battery derivation) + count floors in `test/runtime/test-runtime.js` |
| Runtime assumption suite | hand-coded CSN assumptions vs runtime | `test/runtime/` (zod schemas in `schemas.js`) |
| CHANGELOG gate | every change is recorded | `.github/workflows/check-changelog.yml` (skip only via the `no changelog` label, for docs-only) |
| _(future)_ Corpus false-positive sweep | no spurious diagnostics on real CAP projects | `test/corpus/` suppression registry + pinned `@capire/*` versions |
| _(future)_ Mutation score | tests are load-bearing, not rubber stamps | mutation config threshold |

The differential oracle's battery is **derived from the fixture model**, so its
scope cannot be narrowed by editing a list — only by removing fixture
entities/elements (a visible edit) — and the count floors fail loudly if it is
ever stubbed to a no-op. Keep it that way.

## Enforcement tiers

- **Blocking (in `npm run check`, must pass to merge):** typecheck, format, lint,
  coverage, runtime suite (incl. the differential oracle). These are deterministic
  — a red gate means a real defect, never flakiness. Keep flaky/external-dependent
  checks out of this tier.
- **Reporting (acknowledged, non-blocking):** _(future)_ full corpus sweep,
  mutation run, cds version matrix, adversarial AI review.

## Routine conventions

- `npm run check` is the full local gate; it mirrors CI.
- Record user-facing changes in `CHANGELOG.md` under `## [Unreleased]`.
- Prefer fixing the code over silencing a lint/type/test error.
