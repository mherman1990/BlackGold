# Phase 1 requirements-to-implementation matrix

Status values: `implemented`, `tested`, `deferred`, `blocked`, `not applicable`. A row is not `tested` from inspection alone. Evidence names the file, test, or command.

| # | Requirement (PLAN.md Phase 1) | Status | Evidence |
|---|---|---|---|
| 1 | `PointInTimeObservation` contract and repository with the `asOf` rule | tested | `packages/core/src/data/pit/`, `packages/core/test/pit-repository.test.ts`, `test/temporal/lag-and-availability.test.ts` |
| 2 | Artifact store: content-addressed, zstd, outside git, metadata in SQLite, dedup, integrity, per-write budget cap | tested | `packages/core/src/data/artifacts/store.ts`, `data/artifacts/verify.ts` (quarantine + ledger incident), `packages/core/test/artifacts-http.test.ts`, integrity fixture |
| 3 | Single allowlisted egress client with rate limiting and declared User-Agent | tested | `packages/core/src/data/http.ts`; policy test confines outbound HTTP to that file |
| 4 | Release-lag rules shared by adapters and fixtures | tested | `packages/core/src/data/lag-rules.ts`; fixtures |
| 5 | SEC EDGAR adapter (submissions, Form 4) | tested | `packages/core/src/data/adapters/sec-edgar.ts`, `packages/core/test/adapters-sec.test.ts`, fixtures under `test/fixtures/sec/` |
| 6 | FRED/ALFRED adapter with vintages | tested | `adapters/fred.ts`, `adapters-fred.test.ts`; API key stripped from every stored string |
| 7 | CFTC COT adapter with release schedule and Socrata paging | tested | `adapters/cftc-cot.ts`, `adapters-cot.test.ts`; federal-holiday release rule reproduces all 52 published 2026 dates (`us-federal-cot.test.ts`, CR-27); dataset ids marked UNVERIFIED (CR-26) |
| 8 | Alpaca IEX daily bars adapter (raw, labelled `iex`) | tested | `adapters/alpaca-bars.ts`, `adapters-alpaca.test.ts`; paging, repeated bars flagged STALE_BAR |
| 9 | Ingest CLI with budget enforcement and ledger events; credentials never persisted | tested | `packages/core/src/ingest/run.ts`, `ingest.test.ts` (greps every stored string for the fake keys) |
| 10 | Raw and adjusted total-return series with corporate-action events | tested | `packages/core/src/market/series.ts`, `market-series.test.ts` (raw-fills-equals-TR invariant), temporal fixtures |
| 11 | Date-effective, bitemporal entity map | tested | `market/entity-map.ts` (`knownFrom`/`closeKnownFrom`, `knownAt` resolution), `market-entity-map.test.ts`, symbol-change fixture |
| 12 | Universe snapshots with survivorship label | tested | `universe/snapshots.ts`, `universe-snapshots.test.ts`, survivorship fixture |
| 13 | Data-quality rules and reason codes | tested | `packages/core/src/data/quality.ts` |
| 14 | Experiment registry: freeze, viewed, once-only holdout, promotion refusal (registration and trial labels) | tested | `research/registry.ts` (DB triggers freeze definitions and log holdout once), `research-registry.test.ts` |
| 15 | Total-return NAV accounting with decimal arithmetic and tax lots | tested | `research/nav.ts`, `research-nav.test.ts` |
| 16 | Conservative fill/cost simulator | tested | `research/simulator.ts`, `research-simulator.test.ts`, stale-bar fixture |
| 17 | Benchmark engine (VTI TR, VTI/T-bill blend, SPY) | tested | `research/benchmarks.ts`, `research-benchmarks.test.ts` |
| 18 | The 16 temporal fixtures from `docs/DATA_PROVENANCE_SPEC.md` section 11 | tested (16 of 16; the split fixture's protection-order effect is a Phase 6 gateway item) | `test/temporal/lag-and-availability.test.ts`, `test/temporal/market-and-universe.test.ts` |

## Exit criteria

| Exit criterion | Status | Notes |
|---|---|---|
| A future-dated or revised observation cannot enter a past decision (property test) | tested | fixtures 1 and 2; repository tests |
| Raw versus adjusted usage is enforced by types | tested | `RawBar` (Dec raw prices) versus `TRPoint` (trIndex/adjClose) are distinct types; `RawSeries.load` accepts only `*.bars.1d` sources |
| Split, dividend, delisting, stale-bar, revision, release-lag, early-close, DST fixtures pass | tested | both temporal suites, 18 tests |
| Experiment results reproduce from snapshot ids and hashes | tested | trials must cite registered snapshot ids and the frozen commit (`FrozenInputMismatchError`); `asOf` scoped by snapshot id; result_hash stored per trial |
| Final-holdout access is controlled and logged | tested | `openHoldout` once only, after results are viewed, with reason, ledger event `experiment.holdout_opened`; DB trigger blocks a second open |

## Evidence log

| Date | Command | Result |
|---|---|---|
| 2026-09-07 | `npm run check` (final Phase 1 tree) | lint clean; typecheck clean; 32 test files, 248 tests passed (unit 214, policy 16, temporal 18); identity check ok; secret scan ok over 192 tracked files |
| 2026-09-07 | committed adapter tree verified alone in a clean worktree | tsc clean; 90 core tests passed |
| 2026-09-07 | `ci.yml` run 24 on PR #3 head `01f4d1d` | checks job red: gitleaks (full-history, pull_request event) flagged the synthetic Alpaca `next_page_token` in `test/fixtures/alpaca/bars-1d-page1.json` (commit `cdfcc95`) as `generic-api-key`; lint, typecheck, 248 tests, identity, and secret scan all passed. Push-event run 23 on the same commit was green because it scans only the tip |
| 2026-09-07 | gitleaks 8.24.3 locally, same range as CI (`--no-merges --first-parent <merge-base>..HEAD`) | reproduced the finding; `.gitleaksignore` fingerprint clears it (`no leaks found` on the range and on the working tree). The plural `[[allowlists]]` table is not honoured by 8.24.3, so the fingerprint file is used instead of a `.gitleaks.toml` |
| 2026-09-07 | Codex review of PR #3 (head `d760a51`): 6 P1 + 1 P2 findings | all verified as real and fixed: COT paging, federal-holiday COT release rule (CR-27), trial-label promotion refusal, artifact quarantine on verify failure, processing-delay overrides wired end to end, bitemporal entity map, per-write artifact budget. `npm run check`: lint clean; typecheck clean; 33 test files, 264 tests passed; identity ok; secret scan ok over 194 tracked files |
| 2026-09-07 | `ci.yml` runs 27 (push) and 28 (pull_request) on PR #3 head `e5c6a70` | both green: checks job (lint, typecheck, 264 tests, identity, secrets, gitleaks full history, manifest parse) and image job (multi-arch build, smoke). Codex code and security reviews completed; all seven threads answered and resolved |
| not run | live ingest against SEC, FRED, CFTC, Alpaca | needs credentials from Matt; adapters are fixture-tested only (Phase 5 first live ingest) |
