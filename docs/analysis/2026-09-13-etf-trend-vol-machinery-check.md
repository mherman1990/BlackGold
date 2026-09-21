# etf-trend-vol machinery check — DESIGN vs RECENT (2026-09-13)

> **This is not evidence.** Both runs described here are labelled
> `UNVERIFIED_SINGLE_SOURCE` with `citableAsEvidence: false`. Nothing in this
> note may be cited as promotion evidence, and this note does not do so. Its
> purpose is to record that the evaluation machinery runs end to end and
> produces economically coherent output across two regimes, and to raise one
> charter-level question for the owner. The sealed holdout (2019–2024) was not
> opened and is not discussed beyond noting that it remains sealed.
>
> **Where the `UNVERIFIED_SINGLE_SOURCE` label comes from — a correction.** The
> label is set on the **corporate-action** rows (dividends/splits), not on the
> daily bars. The Tiingo corporate-actions adapter flags every action
> `UNVERIFIED_SINGLE_SOURCE` unconditionally
> (`packages/core/src/data/adapters/tiingo-corporate-actions.ts:117`), and the
> backtest folds any promotion-blocking action-row flag into the run's labels
> (`packages/core/src/research/backtest.ts:226-231`, per D-49). Bars are never
> flagged single-source (they carry `STALE_BAR`/`GAP`/`OUTLIER` codes instead;
> see `packages/core/src/data/quality.ts`). So the blocker to a citable run is
> the corporate-actions data path, **not** the choice of a single bars vendor —
> a second *bars* source would not clear this label. The path that does is a
> reconciled ≥2-source corporate-actions file; see
> `docs/analysis/2026-09-13-path-to-citable-evidence.md`.

## What was run

Two single-split `research evaluate` runs on the Pi, charter `etf-trend-vol`
version 0.2.0 (`charterHash sha256:5c7f94da…`, `planHash sha256:4cbf5616…`),
source `tiingo.eod.bars.1d`:

```
research evaluate --path strategies/etf-trend-vol/charter.yaml \
  --source tiingo.eod.bars.1d --split recent
research evaluate --path strategies/etf-trend-vol/charter.yaml \
  --source tiingo.eod.bars.1d --split design
```

The holdout split is never evaluated by this command by construction.

## Results (verified facts, non-evidential)

| Split | Window | Decisions | Arm | Total return | Max drawdown |
|---|---|---|---|---|---|
| DESIGN (in-sample) | 2007-06-01 → 2018-12-31 | 606 | B1_DETERMINISTIC | +75.34% | −13.36% |
| | | | B0_PASSIVE | +91.18% | −54.04% |
| RECENT | 2025-01-01 → 2026-09-06 | 88 | B1_DETERMINISTIC | +2.67% | −15.36% |
| | | | B0_PASSIVE | +32.89% | −19.22% |

Primary metric `net_sharpe_difference_vs_primary_benchmark` (threshold +0.10):

> **SUPERSEDED (2026-09-20, PR #94). These two numbers are information ratios, not the primary metric.**
> The code computed `annualizedSharpe(strategy − VTI)` under the registered metric's name; ALPHA_CHARTER
> §13 registers a **difference of Sharpe ratios**, and the two disagree in magnitude and in sign. The
> statistic was corrected in PR #94 and **has not been run on real data**, so what replaces these numbers is
> unknown. Neither is evidence for or against the strategy — both runs were already
> `citableAsEvidence: false` — and "Passes?" was never an F1 verdict, since §13 scopes the pass rule to the
> aggregate walk-forward out-of-sample set. Kept as written, for the record of what was run.
> See `docs/analysis/2026-09-20-d51-primary-metric.md` §2f.

| Split | Point estimate | 95% CI | Passes? |
|---|---|---|---|
| DESIGN | −0.189 | [−0.642, +0.194] | no |
| RECENT | −1.735 | [−3.154, −0.886] | no |

Report hashes: DESIGN `reportHash sha256:64b4c692…` / `resultHash sha256:0abbe0f6…`;
RECENT `reportHash sha256:7df3eda6…` / `resultHash sha256:3031e1ae…`. Both splits
carry `registrable: true`, `citableAsEvidence: false`,
`promotionBlockingCodes: [UNVERIFIED_SINGLE_SOURCE]`.

## Reading (inference, not evidence)

The two windows show the expected trend/vol-target signature:

- **DESIGN spans the 2008 crash.** The strategy captured ~83% of passive's
  total return while cutting maximum drawdown by roughly four-fifths (−13% vs
  −54%). It side-stepped the bulk of the GFC. Approximate CAGR (derived, not
  from the tool): ~5.0% strategy vs ~5.8% passive; Calmar (CAGR / max DD)
  ~0.37 vs ~0.11.
- **RECENT is an uninterrupted bull run with no crash to protect against.** The
  strategy lagged badly (net Sharpe difference −1.74, whole CI below zero):
  classic trend-follower drag when there is no drawdown to avoid.

Over a full cycle the crash protection and the bull-run drag roughly offset on
a Sharpe basis, which is why DESIGN's net-Sharpe difference sits near zero with
a CI straddling it.

Caveats, restated: DESIGN is **in-sample** — the parameters were fit to this
window, so its favourable drawdown behaviour is partly by construction — and
both runs are single-source and uncitable.

## Machinery verdict

The evaluation runner reproduces coherent, regime-appropriate behaviour across
a crisis window and a calm window, with deterministic hashes and both arms
computed. That is what this exercise was for, and it holds.

## The charter-level question (owner's to decide)

The strategy **fails its own promotion gate even in-sample**
(`passes: false` on DESIGN, the window it was fit to). But note *what* the gate
measures. `net_sharpe_difference_vs_primary_benchmark` rewards full-period
risk-adjusted return and is nearly blind to the tail: a −54% vs −13% maximum
drawdown is almost invisible to a full-period Sharpe. The strategy's stated
economic thesis is **tail-risk / drawdown reduction**, which this primary
metric does not value.

So there is a genuine design question: **is net Sharpe difference the right
*primary* promotion metric for a strategy whose reason to exist is crash
protection?** A Calmar/MAR- or Sortino-based gate, or an explicit maximum-
drawdown constraint alongside the Sharpe test, would value what the strategy
actually delivers. This is recorded as **proposed decision D-51**.

This note changes no metric and resolves nothing. Changing the primary metric
or threshold is a charter edit and therefore a **new strategy version** that
inherits none of the prior work; the decision, and any re-signing, are the
owner's alone. Claude Code raises the question; it does not answer it.

## What would make a real verdict possible

1. **Reconciled corporate actions.** Clear `UNVERIFIED_SINGLE_SOURCE` by
   ingesting an operator-curated corporate-actions file whose every entry names
   ≥2 reconciled sources (`ingest corporate-actions --file`, D-29/D-49). This is
   data curation, not a code change, and it is the actual blocker to a citable
   run — the daily-bars vendor is not what the label gates on. Full steps in
   `docs/analysis/2026-09-13-path-to-citable-evidence.md`.
2. The **signed 0.2.0 charter** (D-50) — an owner act — for a registered
   experiment on this strategy version.
3. Only after those — and as a deliberate, one-time, owner-only act — the
   **sealed holdout**. It stays sealed until the owner chooses to spend it. In
   this system, citing any run as promotion evidence is itself owner-only.
