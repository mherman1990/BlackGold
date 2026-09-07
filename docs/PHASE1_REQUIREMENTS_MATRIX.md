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
| 2026-09-07 | `ci.yml` runs 34087278746 (push) and 34087280800 (pull_request) on PR #4 head `b3e08b6` (Phase 1 to `main`) | both green: checks job and multi-arch image job. Tree identical to the reviewed PR #3 head; no review threads |
| **tested (live)** | live ingest against FRED | DGS10: 3 windows, 4 artifacts, 16,880 observations, 5,103 distinct vintages matching FRED's own count, 0 conflicts. **Found CR-28 and CR-29** |
| **tested (live)** | live ingest against SEC EDGAR | CIK 320193: 1,590 observations across `sec.edgar.submissions` and `sec.edgar.form4`, 11 rows flagged `FORWARD_DATED_REPORT`, 0 inverted rows. **Found CR-30**, which blocked the run entirely on first attempt |
| **tested (live)** | live ingest against CFTC COT | legacy futures market 099741, Jan-Aug 2026: 34 weekly observations, 0 conflicts. Passed first time |
| **tested (live)** | live ingest against Alpaca bars | SPY + VTI, 2026 YTD on the free IEX feed: 340 bars over 170 sessions, prices stored as decimal strings, `availableAt` one hour after each close, 0 leakage and 0 OHLC violations. Session closes correctly follow DST (21:00 UTC in Jan/Feb, 20:00 from April) - the calendar behaviour R-07 required. Passed first time |

## What the first live ingest changed

Two of the four adapters failed on their very first real request. FRED was fixture-tested and passing, and
had never been pointed at the real API. The first
real request failed outright: FRED refuses a real-time period containing more than 2000 vintage dates, and
DGS10 has 5,103, so **no long-history daily series could be ingested at all**. Fixing it then surfaced a
second defect that would have been silent rather than loud - FRED clips each row's `realtime_start` to the
requested window, so chunking naively invents vintage dates later than the truth. That direction is
conservative for leakage, but it would have filled the point-in-time store with vintages that never existed.

Both are now `Verified` in the capability register (CR-28, CR-29) with the live evidence, and the fix is
tested both as pure window arithmetic and against the live API.

The generalisable lesson, recorded because it applies to the three adapters still unexercised: **a
fixture-tested adapter is evidence about the parser, not about the API.** One live probe per source is worth
more than another fixture, and should happen before the source is marked ready rather than after.

SEC then failed the same way for a different reason: EDGAR's `reportDate` is the scheduled *meeting* date on a
proxy statement, so it can be in the future, and using it as `observedAt` produced a fact effective before it
was knowable. The temporal-inversion guard refused the whole run - correctly, and loudly. That guard earning
its keep on the first real filing set is the strongest evidence yet that the point-in-time discipline is
enforced rather than aspirational.

CFTC and Alpaca passed first time. Alpaca is worth one note in its favour: session closes came back at 21:00
UTC in January and February and 20:00 UTC from April, which is 16:00 Eastern on both sides of the DST
boundary. That is the exact failure R-07 rejected wall-clock scheduling to avoid, and the calendar handled it
without prompting.
