# Phase 2 requirements-to-implementation matrix

Status values: `implemented`, `tested`, `deferred`, `blocked`, `not applicable`. A row is not `tested` from inspection alone. Evidence names the file, test, or command.

**Read this first.** Phase 2's deliverable list in `PLAN.md` is machinery plus results. This PR delivers the machinery, complete and tested. It delivers **no results**, and that is deliberate, not incomplete: see "Why no result exists yet" below. Engineering completion of Phase 2 was never investment evidence; with no ingested data it is not even research evidence — and ingestion is now the one thing between here and a research result (the charter is signed and D-32-confirmed).

## Why no result exists yet

One blocker remains to a registered result:

1. **No market data has been ingested.** The Phase 1 adapters are fixture-tested but have never run against a live source: SEC contact, FRED key, and Alpaca keys are all still owed. There is nothing to compute a 2007-2018 walk-forward from.

The owner gates that used to sit alongside it are cleared: the charter's four open decisions are resolved (D-39), the approval block and `risk.yaml` are signed (D-48), and D-32 (book-slot priority) was owner-confirmed on 2026-09-08 (the `ALPHA_CHARTER.md` §8 `Book-slot priority` row, matching `candidates.ts`). `charter show` reports `registrable: true`; ingestion is the sole thing left.

Computing and viewing a result before the charter is frozen would be irreversible. `docs/EXPERIMENT_PROTOCOL.md` section 3 makes viewing a result consume information: after a view, any change to the hypothesis, rules, grid, boundaries, metrics or costs is a new experiment with a parent, and the trial count for multiple-testing purposes is cumulative across the chain. A result viewed now, on numbers the owner never approved, would permanently spend a clean first look at the design period and would put every later registration downstream of it. So the machinery runs on deterministic synthetic fixtures instead, where a rule change shows up as a failing assertion rather than as a plausible-looking number.

## Deliverables

| # | Requirement (PLAN.md Phase 2) | Status | Evidence |
|---|---|---|---|
| 1 | Machine-readable charter: schema, loader, canonical hash | tested | `packages/core/src/strategy/charter.ts`, `strategies/etf-trend-vol/charter.yaml`, `packages/core/test/strategy-charter.test.ts` (21 tests) |
| 2 | Approval gate: an unapproved charter cannot be registered | tested | `assertRegistrable` / `registrabilityReasons`; `test/policy/charter-and-holdout.test.ts` (permanent CI gate over every tracked charter) |
| 3 | Candidate engine for the approved charter only: eligibility, ranking, entry, hysteresis hold, exit, with the deciding rule logged for every candidate | tested | `packages/core/src/strategy/candidates.ts`, `packages/core/test/strategy-candidates.test.ts` (21 tests) |
| 4 | Feature engine from point-in-time reads (momentum, trend, volatility, covariance, ADV, raw price) | tested | `packages/core/src/strategy/features.ts`, `packages/core/test/strategy-features.test.ts` (16 tests) |
| 5 | Deterministic portfolio construction and sizing: inverse volatility, per-ETF cap to a fixpoint, cluster cap, volatility target, cash floor, whole shares, rebalance band | tested | `packages/core/src/strategy/construct.ts`, `packages/core/test/strategy-construct.test.ts` (25 tests) |
| 6 | Leakage audit: an independent second check of `availableAt + delay <= decisionAt` over every read a run made | tested | `packages/core/src/research/leakage.ts`, `packages/core/test/research-leakage-coverage.test.ts`, and a clean audit over a whole backtest in `research-backtest.test.ts` |
| 7 | Coverage report with a citable report id | tested | `packages/core/src/research/coverage.ts`; measured through `asOf`, so it reports what a decision could have known |
| 8 | Walk-forward splits with purge and embargo | tested | `packages/core/src/research/walkforward.ts`, `packages/core/test/research-walkforward-stats.test.ts` |
| 9 | Holdout protocol, unopened | tested | `holdoutSplit` refuses without a stated open; `splitPlan` rejects any schedule overlapping the holdout; CI gate asserts no tracked charter's plan reaches it |
| 10 | Robustness: sensitivity grid enumerated from the charter, cost/delay/missing-data tiers, falsifier evaluation | tested | `packages/core/src/research/robustness.ts`, `packages/core/test/research-robustness.test.ts` (21 tests) |
| 11 | Cost, delay and parameter tests | tested | `costsFromCharter` per tier and multiplier; `enumerateTiers` covers base/adverse/stress, every stress multiplier, delays 0/2/5, missing rates 2%/5%; runner honours each |
| 12 | Benchmark attribution: cash timing versus selection, and factor regression | tested | `packages/core/src/research/attribution.ts`, `packages/core/test/research-attribution.test.ts` (17 tests) |
| 13 | Statistics: stationary block bootstrap, deflated Sharpe, concentration, regime labels | tested | `packages/core/src/research/stats.ts`; the bootstrap is seeded so a reported interval reproduces |
| 14 | Backtest runner: weekly decision loop, sealed decision records, two independent arms | tested | `packages/core/src/research/backtest.ts`, `packages/core/test/research-backtest.test.ts` (23 tests) |
| 15 | Result report: the protocol section 8 minimum set with the charter's "reasons it may not work" | tested | `packages/core/src/research/report.ts`, `packages/core/test/research-report.test.ts` (15 tests) |
| 16 | A written "reasons it may not work" carried into every report | tested | `reasons_it_may_not_work` in `charter.yaml`, copied verbatim into `ResultReport.reasonsItMayNotWork` |
| 17 | Walk-forward **results**, holdout **results**, robustness **results** | blocked | No data is ingested. See "Why no result exists yet". The code paths are tested on fixtures; the numbers require an ingest (the charter is signed and D-32-confirmed). |
| 18 | Experiment registration for the charter point | blocked | `assertRegistrable` passes and D-32 is owner-confirmed (2026-09-08); registration is now gated only on an ingest (`HANDOFF.md` §5) |

## Exit criteria

`PLAN.md` Phase 2 exit: "predeclared research tests complete and reported. Then stop."

| Exit criterion | Status | Notes |
|---|---|---|
| Every read used in a decision filters `availableAt + processingDelay <= decisionAt` | tested | Enforced by the repository, re-checked independently by the leakage auditor, and asserted clean over a full backtest and over every weekly decision in `test/temporal/strategy-decisions.test.ts` |
| A past decision does not change when the future arrives | tested | `test/temporal/strategy-decisions.test.ts`: a decision's full fingerprint is byte-identical after a corrected bar, a late dividend, and the rest of the window being appended |
| Sizing is invariant to signal magnitude | tested | `constructTargets` takes no momentum input at all; asserted in `strategy-construct.test.ts` |
| The book never breaches the charter's caps | tested | Book size, per-ETF cap, cluster cap and cash floor asserted at every decision of a full backtest |
| Long-only, unlevered, cash-funded | tested | Cash never negative, invested weight in [0, 1] at every session; a buy the cash cannot cover does not fill |
| No fill precedes its own decision | tested | `BacktestResult.executionOrderViolations` must be empty; asserted per decision |
| The holdout stays sealed | tested | CI gate; `splitPlan` has no `HOLDOUT` split and rejects an overlapping schedule |
| A result that cannot be cited says so | tested | `citableAsEvidence` is false with reasons for a DRAFT charter, a zero-delay run (`OPTIMISTIC_DELAY`), a survivorship label, or synthetic missing data |
| Predeclared research tests complete and **reported** | blocked | The tests are implemented and exercised; the report has no real numbers to carry until the charter is frozen and data is ingested |

## Known limitations in this tree

| Limitation | Direction of the error | Where |
|---|---|---|
| The NAV that sizes a position inside the decision loop uses running trade cash and does not credit dividends received so far; distributions are applied in the end-of-run NAV replay. The sizing NAV is therefore slightly below the reported NAV. | One-directional: positions can only come out smaller, never larger. Small for a distribution-light ETF universe, but it is a real inconsistency between the decision path and the accounting path. | `runBacktest` in `packages/core/src/research/backtest.ts` (commented at the mark). Closing it means running a `Portfolio` inside the loop so fills and dividend credits interleave in date order. |
| `VOLATILITY_CONTROLLED_PRIMARY` holds the primary benchmark at the strategy's own average realized equity weight rather than re-deriving a 10% ex-ante target on the benchmark with the 63-day estimator. | Approximates the charter's Secondary 2. It answers the question the charter cares about (does trend selection add anything beyond volatility control?) but is not literally the charter's construction. | `buildResultReport` in `packages/core/src/research/report.ts` |
| Missing-data injection is a deterministic modular pattern, not a random draw. | Reproducible by design, but a single pattern rather than a distribution of patterns. Every such run is labelled `SYNTHETIC_MISSING_DATA` and barred from evidence. | `runBacktest` |

## Deferred to a later phase

| Item | Phase | Why |
|---|---|---|
| Live ingest of the ETF universe and the first real coverage report | 2 (after credentials) | Needs `BLACKGOLD_ALPACA_KEY_ID`/`SECRET_KEY`, `BLACKGOLD_FRED_API_KEY`, `BLACKGOLD_SEC_USER_AGENT_CONTACT` |
| Corporate-action records for the 14 ETFs, reconciled across two sources | 2 (after credentials) | D-29: vendored as observations until an issuer feed is verified. The XLF/XLRE 2016 spin-off is the acceptance case |
| A real factor library for the attribution regression | 2 or later | `factorAttribution` reports "not performed" rather than approximating, per protocol section 10 |
| Compliance look-through evaluation of XLI/XLP and admission of XLE | 4 | The compliance engine is a Phase 4 deliverable; until then the conditional member is excluded |
| `risk.yaml` enforcement of the caps the charter cites | 4 | Phase 2 applies the charter's own caps; `RiskEngine` and `ComplianceEngine` (which may only shrink or block) are Phase 4 |
| Runtime-LLM overlay arm (`C1_LLM_OVERLAY`) | 3 | This charter declares no LLM in the signal and only two arms |
| Prospective falsifier F6 | 5 | Not evaluable from historical results; the harness says so rather than reporting a vacuous pass |

## Resource impact

No new runtime dependency, no new service, no schema migration. The feature engine holds a few hundred sessions for at most 14 entities plus a 14x14 covariance matrix; the charter's own estimate (section 22) is compute under one second and storage under 20 MB, and nothing here changes that. The heaviest addition is the bootstrap: 2000 resamples of a daily series is a few hundred milliseconds and runs only when a report is built.

Test-suite wall time is about 26 seconds, up from about 6 seconds at the Phase 1 baseline. Most of the increase is the backtest and report suites: a backtest re-reads its feature window at every decision instant, which is the honest cost of reading point-in-time and is deliberately not cached in production. Those two suites declare an explicit 30-second per-test budget (`vi.setConfig`) because vitest's 5-second default was never a realistic ceiling for a multi-decision backtest: the slowest test measured 4.2 seconds locally and timed out at 5.0 seconds on a slower CI runner, so the same commit passed and failed depending on which machine picked it up. The budget is roughly thirteen times the slowest observed test, so runner speed cannot decide the outcome while a genuine hang still fails.

## Evidence log

| Date | Command | Result |
|---|---|---|
| 2026-09-07 | `npm run check` (baseline, before any Phase 2 change) | 15 test files, 264 tests passed; lint, typecheck, identity and secret scan clean |
| 2026-09-07 | `npm run check` (final Phase 2 tree) | lint clean; typecheck clean; 45 test files, 494 tests passed (unit 439, policy 29, temporal 26); identity check ok; secret scan ok |
| 2026-09-07 | `node packages/core/dist/main.js charter show --path strategies/etf-trend-vol/charter.yaml` | `registrable: false` with all ten reasons listed; 12 admitted risk ETFs (XLE excluded) |
| 2026-09-07 | `node packages/core/dist/main.js charter plan --path strategies/etf-trend-vol/charter.yaml` | Design, 8 walk-forward and recent splits; holdout reported sealed; trial count 72; registered grid index 63; 10 sensitivity tiers |
| 2026-09-07 | `node packages/core/dist/main.js research coverage --path strategies/etf-trend-vol/charter.yaml --from 2026-01-02 --to 2026-06-30` | Exit code 1, all 13 universe members uncovered: correct for an empty store, and the reason a real coverage report is still owed |
| 2026-09-07 | CI on `bbf99ee` (PR #6), two runs of the same job on the same commit | One `success`, one `failure`. The failure was `research-backtest.test.ts > produces sealed weekly decisions and two independent arms`: `Test timed out in 5000ms` at 5290 ms. Not infrastructure - a test written with only 20% headroom against vitest's default |
| 2026-09-07 | `npm run check` after declaring a 30 s budget for the two backtest-backed suites and sharing their read-only fixture market | 494 tests still passing (no assertion changed); slowest test 4174 ms to 2249 ms; suite 44 s to 26 s |
| 2026-09-08 | `node packages/core/dist/main.js charter show --path strategies/etf-trend-vol/charter.yaml` (re-run after the owner signed, D-48) | `approvalState: APPROVED`, `charterVersion: 0.1.0`, `registrable: true`, `reasons: []`; 12 admitted risk ETFs (XLE excluded). Supersedes the 2026-09-07 `registrable: false` row above. `registrable: true` was necessary but not sufficient at the time; the remaining precondition — D-32 (book-slot priority), which `assertRegistrable` does not check — was owner-confirmed the same day (the §8 `Book-slot priority` row), leaving ingestion the sole gate — see "Why no result exists yet" |
