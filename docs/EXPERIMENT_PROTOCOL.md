# Black Gold Experiment Protocol

Status: Discovery specification. Governs every registered experiment run by the Black Gold research kernel, from the first historical backtest through prospective shadow and paper observation. Companion documents: `docs/AUTOMATION_AND_LIVE_GATES.md` (what evidence unlocks which mode), `docs/THREAT_MODEL.md` (contamination and injection risks referenced here), and each strategy's `strategies/<strategy_id>/ALPHA_CHARTER.md` (the hypothesis this protocol tests).

The protocol exists to make one outcome cheap and honest: "the strategy does not work" or "the LLM adds no value." A protocol that cannot produce that verdict is not a protocol.

## 1. Principles

1. The Alpha Charter is frozen before the experiment. The experiment tests the charter; it does not discover it.
2. Deterministic code owns every number. Metrics, splits, costs, and pass/fail evaluation are computed by versioned code from snapshot IDs. LLM output is an input feature at most, never a result.
3. Viewing results consumes information. Anything changed after viewing is a new experiment with a new ID. Old results are never edited or deleted.
4. The final holdout opens once. After it opens it is historical evidence, not a holdout.
5. Simpler baselines are always shown next to the candidate. A complex variant that does not beat the simpler variant after costs is not promoted, no matter how persuasive its memos.
6. Evidence has a hierarchy. Historical results are the weakest tier; nothing historical promotes an LLM feature.

## 2. What a registration freezes

Registration is a single commit to the experiment registry. It writes an immutable `experiment.yaml` plus a content hash. The runner refuses to execute if any frozen input no longer resolves to the same hash.

| Field group | Frozen content | Why it is frozen |
|---|---|---|
| Charter | `ALPHA_CHARTER.md` version and the machine-readable companion schema hash | The hypothesis cannot drift toward the data |
| Code | Git commit SHA of the research kernel; dirty working trees are rejected | Reproducibility |
| Data | Snapshot IDs for every dataset, plus the coverage report ID | Point-in-time correctness; later revisions cannot leak in |
| Component versions | Feature set version, strategy rule version, portfolio construction version, risk policy version | Any change is a new experiment |
| Model (if any) | Provider, exact model ID (never an alias), system and task prompt hashes, output schema hash, tool set (normally empty), decoding settings (temperature, top_p, max tokens, seed where supported), preprocessor version | LLM behavior is part of the strategy definition |
| Search space | Parameter grid, sampling rule, trial count N | Multiple-testing accounting requires a declared N |
| Time boundaries | Train, validation, walk-forward window schedule, final holdout start and end, purge and embargo lengths | Prevents boundary shopping |
| Metrics | One primary metric; a short list of secondary risk metrics | Prevents metric shopping |
| Cost model | Base assumptions and the sensitivity grid (see Section 5.9) | Prevents cost-assumption shopping |
| Pass/fail | Numeric thresholds on the primary metric against the named baseline arm, plus robustness conditions | The verdict is defined before it is known |
| Benchmark | Primary and secondary benchmarks per Section 9 | Benchmarks are chosen before results |
| Tax | Tax scenarios to report per Section 10 | Scenario set is declared, not tuned |

Model IDs are stored in the registration record only. Runtime code reads them from config; nothing is hardcoded.

### 2.1 `experiment.yaml` sketch

```yaml
experiment_id: EXP-2026-0007
registered_at_utc: 2026-11-03T14:12:09Z
registered_by: owner
parent_experiment_id: EXP-2026-0004      # null for a fresh hypothesis; required if results of a prior run were viewed
supersedes_reason: "Widened liquidity filter after viewing EXP-2026-0004 validation results"

charter:
  strategy_id: etf_trend_volctl
  charter_version: 1.2.0
  charter_hash: sha256:9c1f...
  owner_approval_ref: approvals/etf_trend_volctl-1.2.0.md

code:
  repo: mherman1990/BlackGold
  commit: 4f7a2c9e1b0d
  dirty_tree_allowed: false

data:
  snapshots:
    - dataset: prices_daily_total_return
      snapshot_id: snap_prices_20261031_a
    - dataset: universe_membership_pit
      snapshot_id: snap_univ_20261031_a
    - dataset: fred_alfred_vintages
      snapshot_id: snap_fred_20261031_a
  coverage_report_id: cov_20261031_a

versions:
  features: 3
  strategy_rules: 2
  portfolio_construction: 1
  risk_policy: 1
  cost_model: 2

model:                                  # omit entirely for B1-only experiments
  provider: anthropic
  model_id: <exact-model-id-from-config>
  prompt_hash: sha256:51ab...
  schema_hash: sha256:e0d2...
  tool_set: []
  decoding: { temperature: 0, top_p: 1, max_output_tokens: 2048, seed: 7 }
  preprocessor_version: 4
  contamination_label: HISTORICAL_REPLAY_CONTAMINATED   # see Section 7

arms: [B0_PASSIVE, B1_DETERMINISTIC, C1_LLM_OVERLAY, D1_LLM_ONLY_SHADOW]

search_space:
  grid:
    lookback_days: [126, 189, 252]
    vol_target_annual: [0.10, 0.12, 0.15]
  sampling: full_grid
  trial_count: 9

boundaries:
  train:        { start: 2008-01-02, end: 2016-12-30 }
  validation:   { start: 2017-01-03, end: 2019-12-31 }
  walk_forward: { window_years: 3, step_months: 12, purge_days: 21, embargo_days: 5 }
  holdout:      { start: 2020-01-02, end: 2025-12-31, opened: false }

metrics:
  primary: net_information_ratio_vs_primary_benchmark
  secondary: [max_drawdown, annual_turnover, net_cagr, downside_deviation, hit_rate]

costs:
  base:    { commission_bps: 0, half_spread_bps: 2, slippage_bps: 3, delay_bars: 1 }
  adverse: { commission_bps: 0, half_spread_bps: 5, slippage_bps: 8, delay_bars: 1 }
  stress_multipliers: [1.0, 2.0, 3.0]
  delay_sensitivity_bars: [0, 1, 2, 5]
  missing_data_rates: [0.00, 0.02, 0.05]

benchmarks:
  primary: VTI_total_return
  exposure_matched: { equity: VTI_total_return, cash: TBILL_3M_total_return }
  secondary: [SPY_total_return]

pass_fail:
  primary_condition: "C1 minus B1 paired net IR difference > 0.10 with block-bootstrap 90% CI excluding 0"
  robustness_conditions:
    - "No single year contributes more than 40% of cumulative excess return"
    - "Primary metric sign unchanged under 2x cost stress"
    - "Primary metric sign unchanged under 2-bar execution delay"
    - "Primary metric within 25% of point estimate for all adjacent grid cells"
  minimum_independent_decisions: 60

tax_scenarios: [pre_tax, taxable_short_long_split, tax_deferred]
```

## 3. The viewed-results rule

A result is "viewed" the moment any human or agent reads a metric, plot, table, or memo derived from it. The registry logs the first view timestamp for every result set.

After a view:

- Any change to hypothesis, features, rules, grid, boundaries, metrics, costs, or model configuration is a new `experiment_id` with `parent_experiment_id` set.
- The old result set is retained and remains visible in the trial ledger.
- The trial count for multiple-testing purposes is cumulative across the parent chain, not reset per experiment.

Automated agents are subject to the same rule. An agent that reads a result and then proposes a change has produced a new experiment proposal, not an edit.

### 3.1 The once-only holdout

- Holdout access is a privileged operation logged to the event ledger with the experiment ID, requester, and reason.
- The holdout may be opened only after validation and walk-forward results have been reviewed and a written decision to open exists.
- After opening, the boundaries record is rewritten as `holdout.opened: true` with the timestamp. Every descendant experiment inherits that flag and must declare a new, later holdout or state that no untouched holdout remains.
- A strategy chain with no untouched holdout can advance only on prospective evidence.

## 4. Trial ledger

Every evaluated parameter cell, in every arm, in every split, writes a row. Nothing is evaluated off-ledger. The ledger is the denominator for any multiple-testing statistic.

```yaml
trial_ledger_row:
  trial_id: EXP-2026-0007/t-004
  experiment_id: EXP-2026-0007
  arm: C1_LLM_OVERLAY
  split: walk_forward/2019-01-02_2021-12-31
  params: { lookback_days: 189, vol_target_annual: 0.12 }
  n_decisions: 34
  n_positions_opened: 41
  primary_metric: 0.31
  secondary_metrics: { max_drawdown: -0.187, annual_turnover: 1.9, net_cagr: 0.071 }
  gross_return: 0.263
  net_return: 0.214
  cost_scenario: base
  delay_bars: 1
  missing_data_rate: 0.00
  benchmark_return: 0.198
  block_bootstrap_ci_90: [-0.04, 0.58]
  contamination_label: HISTORICAL_REPLAY_CONTAMINATED
  code_commit: 4f7a2c9e1b0d
  snapshot_ids: [snap_prices_20261031_a, snap_univ_20261031_a]
  run_started_utc: 2026-11-03T15:01:44Z
  run_finished_utc: 2026-11-03T15:03:10Z
  runner_version: 0.4.1
  result_hash: sha256:aa03...
```

Rows are append-only. A re-run of an identical trial gets a new `trial_id` and must reproduce `result_hash`; a mismatch is a reproducibility incident.

## 5. Validation methods

All methods below are mandatory unless the charter documents why one does not apply.

### 5.1 Time-ordered splits only
Market observations are never randomly shuffled into folds. Splits are contiguous in time. Universe membership and features are queried point-in-time as of each decision timestamp.

### 5.2 Walk-forward with purging and embargo
Parameters are fit on a trailing window and evaluated on the next window. Where labels or holdings overlap the boundary, observations within the purge length are dropped from training and an embargo gap separates the training end from the test start. Purge and embargo lengths are set from the holding period in the charter and frozen at registration.

### 5.3 Block bootstrap confidence intervals
Confidence intervals on the primary metric use a block bootstrap with block length chosen to respect serial dependence in the decision series (documented in the run). Point estimates without intervals are not reported.

### 5.4 Parameter perturbation
Every reported cell is shown next to its adjacent grid cells and to reasonable alternative definitions of each feature (for example, a different volatility estimator). A result that holds at one cell and collapses at its neighbors is reported as fragile and fails promotion.

### 5.5 Regime, year, sector, liquidity, and event-type breakdowns
Results are broken down by calendar year, a preregistered regime classifier (for example, trailing benchmark drawdown state), sector, liquidity tercile, and, for event strategies, event type. Breakdowns are descriptive; they do not add trials to the ledger unless a parameter is chosen from them.

### 5.6 Concentration analysis
Report the share of cumulative excess return attributable to the top one, three, and five securities, the top sector, the best year, and the best single episode (a contiguous drawdown-to-peak run). The charter states maximum acceptable concentration; exceeding it fails promotion.

### 5.7 Cost stress
Every headline metric is recomputed at base costs, adverse costs, and at least 2x base costs. Results are shown before and after costs. A strategy whose primary metric changes sign at 2x base costs is reported as cost-fragile.

### 5.8 Execution delay and missing-data sensitivity
Recompute with the decision executed 0, 1, 2, and 5 bars later than assumed, and with 2% and 5% of feature inputs randomly marked missing (handled by the charter's declared missing-data rule). Report the degradation curve.

### 5.9 Cost model structure
The cost model includes commission, half spread, slippage as a function of participation, an execution delay, a market-impact proxy for the larger cells, dividends and distributions, and, where applicable, borrow and financing. Black Gold does not short or use leverage in early phases, so borrow and financing are zero but the fields exist. Alpaca paper fills are never used as the cost model; the independent conservative simulator is.

### 5.10 Multiple-testing statistics
The trial ledger is always reported. A deflated Sharpe ratio or probability-of-backtest-overfitting diagnostic is reported only when its assumptions are supported: sufficient trials and decisions, and return series whose skew and kurtosis have been checked. When the assumptions do not hold, the report says so and shows the raw ledger count instead. Never quote a sophisticated statistic to dress up a small sample.

### 5.11 Benchmark and exposure attribution
Excess return is decomposed against the primary benchmark and, where data support it, against size, value, momentum, sector, and cash-timing exposures. Residual return is what remains and is the only component that can be called candidate alpha.

## 6. Research arms

For every eligible decision timestamp the kernel records four synchronized arms:

| Arm | Definition | Live eligibility |
|---|---|---|
| `B0_PASSIVE` | The approved passive total-return benchmark held continuously | Not a strategy; reference only |
| `B1_DETERMINISTIC` | The registered strategy with no runtime-LLM intervention | Eligible if its own criteria pass |
| `C1_LLM_OVERLAY` | Identical candidates, timestamps, portfolio and risk rules, and execution assumptions as B1, plus only the preregistered runtime-LLM feature, veto, or rank rule | Eligible only on prospective evidence (Section 7) |
| `D1_LLM_ONLY_SHADOW` | An LLM-only diagnostic portfolio | Never automatically eligible |

### 6.1 Non-interaction rule
No arm's output at timestamp T may be an input to any other arm at T. Concretely:

- B1 finishes and seals its decision record before C1 runs.
- C1 receives B1's candidate list as a frozen input and may only apply its preregistered rule to it.
- D1 never sees B1 or C1 decisions.
- Shared inputs (prices, universe, evidence packets) are identical across arms by snapshot ID.
- The portfolio state of each arm is tracked separately; arms do not share positions or cash.

Each arm logs accepted and rejected candidates with the rule that accepted or rejected them.

### 6.2 Paired C1-versus-B1 evaluation
C1 is evaluated against B1 with paired observations: the same decision timestamps and the same candidate set. The preregistered metric is the paired difference in the primary metric, with a block-bootstrap interval on that difference. C1 is not compared to B0 as its primary test; beating the passive benchmark while failing to beat B1 means the LLM added nothing.

If C1 does not add robust after-cost value the runtime LLM is excluded from the production signal. Memo quality, citation quality, and plausibility are not evidence.

### 6.3 Confidence is metadata
Model-generated confidence never affects position size unless a new Alpha Charter defines a probabilistic target, the confidence has been calibrated prospectively, and the calibration-to-sizing relationship is approved. Default: confidence is explanatory metadata only.

## 7. LLM contamination rule

Any historical replay in which a current model evaluates evidence from before its training cutoff is contaminated: the model may know how the story ended. Contaminated results carry `contamination_label: HISTORICAL_REPLAY_CONTAMINATED` on every ledger row, plot, and report page.

Contaminated results may be used to:

- test mechanics: schema compliance, abstention, citation verification, injection resistance, latency and cost;
- test bias: whether the model systematically favors or penalizes particular sectors, sizes, or narratives.

Contaminated results may not be used as primary alpha evidence, and no LLM feature is promoted from them. Sealed or anonymized evidence packets reduce but do not remove contamination unless the model's knowledge boundary is defensible and documented; the default assumption is that it is not.

Promotion of any LLM feature requires prospective, timestamp-locked shadow observations: the evidence packet is sealed, the model's output is recorded and hashed before the outcome is knowable, and the outcome is joined later by deterministic code. The minimum count of such observations is set in the charter.

## 8. Minimum result set

Every result report contains, for every arm and every cost scenario, before and after costs:

- total return, gross and net
- CAGR where the window makes it meaningful
- volatility and downside deviation
- Sharpe and Sortino, with the caveat that neither is comparable across strategies with different return distributions
- maximum drawdown and Calmar
- beta to the primary benchmark
- alpha with its uncertainty against approved factors where data support it
- information ratio against the primary benchmark
- turnover
- hit rate, average win, average loss, profit factor where meaningful
- average and maximum gross exposure, cash share
- tail losses (worst 1%, 5% of decision-period returns)
- capacity and liquidity estimate (participation at assumed sleeve size)
- tax as a scenario (Section 10)
- the trial ledger count and, if supported, the multiple-testing statistic

The passive baseline and the simpler deterministic baseline are always shown on the same page as the candidate.

## 9. Evidence hierarchy

| Tier | Evidence | Can prove | Cannot prove |
|---|---|---|---|
| 1 | Historical backtest (train, validation, walk-forward) | The rule is implementable point-in-time; the hypothesis is not obviously false; cost and delay fragility | That the effect persists; anything about LLM value (contaminated) |
| 2 | Untouched holdout, opened once | The rule was not fit to the holdout period; one out-of-sample confirmation | Persistence beyond the holdout; LLM value (still contaminated) |
| 3 | Prospective shadow (sealed decisions, no orders) | Decisions can be made on time from allowed data; LLM outputs are uncontaminated; the deterministic and LLM arms diverge or do not | Execution feasibility; realized costs |
| 4 | Paper (broker paper orders plus independent fill model) | Order lifecycle mechanics; reconciliation; the gap between the internal simulator and a broker's simulator | Realized live costs (Alpaca paper does not model impact, latency slippage, queue position, price improvement, regulatory fees, or dividends) |
| 5 | Micro-live | Execution shortfall calibration; human approval workflow; protection and recovery behavior | Returns. A tiny live sample over 8 to 12 weeks proves nothing about alpha |

Higher tiers do not retroactively validate lower ones. A strategy that passes tier 5 on execution and fails tier 3 on returns has failed.

## 10. Benchmark policy

Benchmarks are named in the charter before any result exists.

- Primary: VTI total return for any broad long-only U.S. equity mandate.
- Exposure-matched: when the strategy holds material cash, an exposure-matched blend of VTI total return and 3-month Treasury-bill return, weighted by the strategy's realized daily equity exposure. This is the benchmark the information ratio is computed against for cash-holding strategies, because beating VTI while sitting in cash during a drawdown is cash timing, not stock selection.
- Secondary: SPY total return as a familiar comparator. It is never the primary benchmark.
- Style, sector, and factor regressions or matched liquid ETF benchmarks where point-in-time data support them.
- DGTW-style characteristic matching only if point-in-time size, book-to-market, and momentum characteristic data are adequate. Black Gold does not build a "lightweight DGTW" from partial data and call it equivalent. If the data are inadequate, the report says characteristic matching was not performed.

Daily NAV is computed from positions, cash, fills, fees, receivables, dividends and distributions, splits, and corporate actions, and reconciled against the broker in paper and live modes.

## 11. Tax scenario reporting

Tax is reported as a scenario, never as a single after-tax number.

- Scenarios are declared at registration. Default set: pre-tax; taxable with short-term and long-term rates applied to realized lots; tax-deferred.
- Rates are configuration, not code. The report states the rates used.
- Tax-lot activity (lots opened, closed, holding period at close) is reported for every arm so turnover cost can be seen in tax terms.
- Wash-sale treatment covers only the sleeve account. Black Gold does not claim household-wide wash-sale accuracy unless every relevant owner and spousal account and every substantially identical security is covered, which is out of scope. Reports carry that disclaimer.
- Black Gold never autonomously tax-loss harvests any account, including the sleeve.

## 12. Reporting and non-mutation

- Weekly and monthly reports answer the questions in the spec's reporting list, including what B1 decided before the LLM, what the LLM added, removed, or changed, and how B0, B1, C1, and D1 perform after costs with uncertainty.
- No report phrases a short noisy window as evidence of skill.
- A strategy is not modified in reaction to recent underperformance outside a registered research cycle. Underperformance triggers a review; a review may register a new experiment; only the new experiment's result can change the production rule.

## 13. Promotion conditions summary

A candidate may advance from research toward the modes described in `docs/AUTOMATION_AND_LIVE_GATES.md` only if all of the following hold:

1. The preregistered primary condition passes against the named baseline arm after costs, with an interval that excludes zero.
2. No single security, sector, year, or episode exceeds the charter's concentration limit.
3. The primary metric keeps its sign at 2x base costs and at the charter's delay stress.
4. Adjacent grid cells agree in sign and rough magnitude.
5. The minimum number of independent decisions in the charter is met.
6. For any LLM feature: the required count of prospective, timestamp-locked shadow observations exists and the paired C1-versus-B1 test passes on those observations alone.
7. The reviewer has written down the reasons the strategy may still not work.

Failing any condition is a legitimate and expected outcome. The registry records the failure with the same permanence as a pass.
