# Phase 1 requirements-to-implementation matrix

Status values: `implemented`, `tested`, `deferred`, `blocked`, `not applicable`. A row is not `tested` from inspection alone. Evidence names the file, test, or command.

| # | Requirement (PLAN.md Phase 1) | Status | Evidence |
|---|---|---|---|
| 1 | `PointInTimeObservation` contract and repository with the `asOf` rule | tested | `packages/core/src/data/pit/`, `packages/core/test/pit-repository.test.ts`, `test/temporal/lag-and-availability.test.ts` |
| 2 | Artifact store: content-addressed, zstd, outside git, metadata in SQLite, dedup, integrity | tested | `packages/core/src/data/artifacts/store.ts`, `packages/core/test/artifacts-http.test.ts` |
| 3 | Single allowlisted egress client with rate limiting and declared User-Agent | tested | `packages/core/src/data/http.ts`; policy test confines outbound HTTP to that file |
| 4 | Release-lag rules shared by adapters and fixtures | tested | `packages/core/src/data/lag-rules.ts`; fixtures |
| 5 | SEC EDGAR adapter (submissions, Form 4) | pending agent | |
| 6 | FRED/ALFRED adapter with vintages | pending agent | |
| 7 | CFTC COT adapter with release schedule | pending agent | |
| 8 | Alpaca IEX daily bars adapter (raw, labelled `iex`) | pending agent | |
| 9 | Ingest CLI with budget enforcement and ledger events; credentials never persisted | pending agent | |
| 10 | Raw and adjusted total-return series with corporate-action events | pending agent | |
| 11 | Date-effective entity map | pending agent | |
| 12 | Universe snapshots with survivorship label | pending agent | |
| 13 | Data-quality rules and reason codes | tested | `packages/core/src/data/quality.ts` |
| 14 | Experiment registry: freeze, viewed, once-only holdout, promotion refusal | pending agent | |
| 15 | Total-return NAV accounting with decimal arithmetic and tax lots | pending agent | |
| 16 | Conservative fill/cost simulator | pending agent | |
| 17 | Benchmark engine (VTI TR, VTI/T-bill blend, SPY) | pending agent | |
| 18 | The 16 temporal fixtures from `docs/DATA_PROVENANCE_SPEC.md` section 11 | 10 of 16 tested; 6 pending market/universe modules | `test/temporal/lag-and-availability.test.ts` |

## Exit criteria

| Exit criterion | Status | Notes |
|---|---|---|
| A future-dated or revised observation cannot enter a past decision (property test) | tested | fixtures 1 and 2; repository tests |
| Raw versus adjusted usage is enforced by types | pending | `RawBar` vs `TotalReturnSeries` types |
| Split, dividend, delisting, stale-bar, revision, release-lag, early-close, DST fixtures pass | partial | revision, release-lag, early-close, DST pass; split/dividend/delisting/stale-bar pending |
| Experiment results reproduce from snapshot ids and hashes | pending | registry |
| Final-holdout access is controlled and logged | pending | registry |

## Evidence log

| Date | Command | Result |
|---|---|---|
| 2026-09-07 | `npx vitest run --project temporal` | 12 passed |
| 2026-09-07 | `npx vitest run --project unit packages/core` | 44 passed (before adapters and research modules) |
