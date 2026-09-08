# Alpha Charter: `etf-trend-vol`

**Status: APPROVED** — the binding approval is the signed `approval:` block in `strategies/etf-trend-vol/charter.yaml` (owner-signed 2026-09-08, D-48). This prose file is its human-readable specification companion.

| Field | Value |
|---|---|
| Strategy ID | `etf-trend-vol` |
| Charter version | `0.1.0` (the executed `charter.yaml`; this prose file was drafted as `0.1.0-draft`) |
| Companion schema | `strategies/etf-trend-vol/charter.yaml` (written and signed — the only form the code executes) |
| Owner | Matt Herman |
| Author of draft | Black Gold Discovery Pack |
| Approval state | APPROVED in `charter.yaml` (approved_by Matt Herman, 2026-09-08, D-48); D-32 owner-confirmed (§8). Registration hash assigned at experiment registration. |
| Intended phase | Phase 2 (first deterministic Alpha Charter), then Phase 5 shadow/paper |
| Runtime LLM in signal | No |

Every number in this document is a PROPOSED default. Proposals are frozen at registration and may not be tuned after any result is viewed. A change to any frozen value after registration is a new charter version and a new experiment (see `docs/EXPERIMENT_PROTOCOL.md`).

## Owner approval block

> **The binding approval is the signed `approval:` block in `charter.yaml`** — state `APPROVED`, approved_by `Matt Herman`, approval_date `2026-09-08`, code_commit `474d0dc`, approval_ref `docs/DECISIONS.md#D-39` (recorded as D-48). That block is the only form the code executes and the one `assertRegistrable` checks. The template below is a non-binding human mirror of that signature; Claude Code did not fill it in (signing is the owner's act), and the owner may countersign it here but need not.

```
Charter:        etf-trend-vol 0.1.0-draft
Approved by:    ______________________ (Matt Herman)
Approval date:  ______________________ (UTC)
Code commit:    ______________________
Charter hash:   ______________________
Decision refs:  docs/DECISIONS.md D-08 (mandate), D-09 (universe), D-10 (first charter), D-15 (risk budget), D-19 (data budget), D-24 (market data source)
Conditions:     ______________________
```

## 1. Purpose

This is the operational baseline. It has two jobs:

1. Test one plausible, simple, well-documented hypothesis (medium-horizon trend plus volatility control across liquid ETFs) with realistic costs.
2. Exercise the whole research kernel (point-in-time store, total-return ledger, simulator, benchmark engine, experiment registry, shadow ledger) on data that has no survivorship problem, no filing parser, and no LLM.

A valid outcome is "this does not beat VTI after costs." That outcome still completes job 2.

## 2. Investable universe and membership rule

### 2.1 Frozen list

The universe is a frozen list. Membership is known on every decision date by construction: the list is fixed at registration and does not change until a new charter version. No ETF is added or removed in reaction to results.

| Ticker | Role | Approx. inception | Why included | Compliance note |
|---|---|---|---|---|
| VTI | Broad U.S. market | 2001 | Primary benchmark instrument; the "do nothing" alternative inside the universe | none |
| QQQ | Large-cap growth / Nasdaq-100 | 1999 | Distinct factor exposure from VTI; deepest liquidity of any style proxy | none |
| IWM | Small cap | 2000 | Size exposure; historically different trend behavior from large caps | none |
| VTV | Large value | 2004 | Value style leg | none |
| VUG | Large growth | 2004 | Growth style leg; pairs with VTV | none |
| XLK | Technology | 1998 | Sector leg | none |
| XLF | Financials | 1998 | Sector leg; XLRE spin-off in 2016 is a corporate-action test fixture | none |
| XLV | Health care | 1998 | Sector leg; low correlation to XLK/XLE | none |
| XLI | Industrials | 1998 | Sector leg | look-through check: holds ag-machinery names |
| XLP | Consumer staples | 1998 | Defensive sector leg | look-through check: holds ag-processing names |
| XLU | Utilities | 1998 | Defensive, rate-sensitive leg | none |
| XLY | Consumer discretionary | 1998 | Cyclical sector leg | none |
| XLE | Energy | 1998 | Sector leg with the lowest correlation to the rest | CONDITIONAL: holds refiners with RFS/45Z exposure (restricted theme). Included only if the compliance policy adopts a diversified-ETF look-through rule that admits it. Otherwise the risk universe is 12 ETFs. |
| BIL | Cash proxy (1-3 month T-bills) | 2007 | Cash leg for research and, if approved, live | none |

Excluded on purpose: SPY (redundant with VTI; kept as a secondary comparator), XLB (materials; concentrated in ag-input names that are a restricted theme), XLRE and XLC (history starts 2015 and 2018), international, bonds beyond T-bills, gold, commodities, leveraged or inverse products. Bond and gold legs are a candidate for a later charter version, not this one.

SGOV is the likely live cash instrument (lower fee) but has history only from 2020. Proposal: BIL is the research cash series; the live cash instrument is a `risk.yaml` decision recorded in `docs/DECISIONS.md`. If SGOV is chosen live, the shadow ledger records both.

### 2.2 Look-through rule (proposal for the compliance policy)

Restricted themes seeded from Matt's ISA exposure (soybean, biofuel, ag inputs) default to no new sleeve exposure. A diversified ETF is proposed to be admissible when the aggregate weight of restricted-theme issuers in the latest published holdings is at or below 10% of ETF NAV, re-checked quarterly by deterministic code from the issuer's holdings file. This threshold is a compliance decision, not a research parameter. Until the compliance policy is approved, XLE is excluded and XLI/XLP are flagged.

### 2.3 Survivorship honesty

All 14 tickers were chosen in 2026 and all survived. That is mild selection bias: a 2007 researcher might have picked a different sector family or a style ETF that later closed. Mitigation: every risk ETF is among the largest and oldest in its category and would have been an obvious choice at any point since 2007; nothing launched after 2007 is included. This is disclosed, not eliminated.

## 3. Long/short and leverage posture

Long only. Unlevered. No margin, options, shorting, extended hours, or fractional-share dependence. Gross exposure is at most 100% of sleeve NAV minus minimum cash. Uninvested capital is held in BIL (or cash if `risk.yaml` says so).

## 4. Hypothesis and mechanism

**Hypothesis.** Over a 5 to 60 trading day horizon, holding the liquid ETFs with the strongest trailing 12-month total return (skipping the most recent month), conditional on each being above its own long-term moving average, and scaling total exposure to a fixed volatility target, produces a higher after-cost Sharpe ratio and a smaller maximum drawdown than holding VTI.

**Mechanism.** Two established effects, each with a long public literature:

- Time-series and cross-sectional momentum (Jegadeesh and Titman 1993; Moskowitz, Ooi and Pedersen 2012; Faber 2007 for the moving-average variant). Candidate causes: institutional flows that adjust slowly, anchoring and under-reaction to persistent information, and risk-management driven de-risking that extends drawdowns.
- Volatility management (Moreira and Muir 2017; Barroso and Santa-Clara 2015). Realized volatility is persistent while expected returns are not proportionally higher in high-volatility periods, so scaling exposure inversely to recent volatility improves risk-adjusted returns and clips drawdowns.

The strategy does not claim to forecast returns. It claims to change the shape of the return distribution (fewer deep drawdowns, similar or slightly lower CAGR) enough to raise Sharpe and Calmar after costs and taxes.

## 5. Why the effect could persist

- It is not arbitrage. It requires sitting in cash during rallies after crashes and accepting whipsaw losses. Many holders cannot or will not do that.
- The behavioral and institutional causes (benchmark-relative mandates, slow rebalancing, drawdown-driven de-risking) have not disappeared despite decades of publication.
- Capacity in liquid ETFs is enormous relative to a small sleeve, so crowding by a small account is not the risk; crowding by large trend followers is, and it shows up as weaker signal, not as our impact.

Honest counterpoint: the post-2009 record of simple trend rules on U.S. equities is worse than the pre-2009 record, and 2020 was a textbook whipsaw. Persistence is a hypothesis to be tested, not a premise.

## 6. Features, transformations, allowed data sources

### 6.1 Features (computed at each decision timestamp from records with `availableAt <= decisionAt`)

| Feature | Definition (PROPOSED) | Data |
|---|---|---|
| `mom_i` | Total return of ETF i from close t-252 to close t-21 (12-1 momentum) using dividend-adjusted closes | adjusted daily closes |
| `mom_cash` | Same window total return of BIL | adjusted daily closes |
| `trend_i` | 1 if adjusted close at t > simple moving average of adjusted closes over t-199..t, else 0 | adjusted daily closes |
| `vol_i` | Annualized standard deviation of daily log total returns over t-62..t (63 sessions), sqrt(252) scaling | adjusted daily closes |
| `cov` | Sample covariance of daily log total returns over the same 63 sessions, all risk ETFs | adjusted daily closes |
| `adv_i` | 20-session average daily dollar volume | unadjusted close x volume |
| `px_i` | Unadjusted close at t (for share quantities, fills, stops) | unadjusted daily bars |

Adjusted series are used only for signals and total-return accounting. Unadjusted series are used for execution simulation and share counts. Adjusted series are recomputed from the raw unadjusted series plus explicit dividend and split records; a vendor's pre-adjusted column is a cross-check, not the source of record (see `docs/DATA_PROVENANCE_SPEC.md`).

### 6.2 Allowed data sources (candidates; each must be probed and recorded in `docs/CAPABILITY_REGISTER.md` before use)

| Source | What | Licence / caveat (UNVERIFIED until probed) |
|---|---|---|
| Broker market-data API (Alpaca Market Data, free tier) | Daily OHLCV bars, raw and adjusted, plus corporate-action records | Likely the cleanest free source with an explicit API and terms; free tier is IEX-sourced for quotes, which is fine for daily bars but must never be labelled NBBO. Historical adjustment parameters, coverage start, and redistribution terms to verify. |
| Issuer websites (Vanguard, SSGA, Invesco, iShares) | Distribution history, holdings files, expense ratios | Public; format changes without notice; holdings files feed the look-through rule. |
| Stooq | Daily OHLCV with long history | Free for personal use; licence and adjustment methodology unclear; use as cross-check only. |
| Tiingo free tier | Daily adjusted and unadjusted prices | Personal-use free tier with request limits; terms to verify. |
| FRED `DTB3` | 3-month T-bill yield | Public; used only to extend the cash series before BIL inception in an exploratory pre-2007 run, never in the registered period. |
| Yahoo Finance via unofficial libraries | Daily prices | Terms of service prohibit automated redistribution; NOT approved for production ingestion. Manual spot-check only. |
| Schwab market data | Daily bars, quotes | ALL Schwab API claims are UNVERIFIED (developer portal returned 403 to unauthenticated fetch). Do not depend on it before Phase 6. |

Gaps: no free consolidated NBBO history, so spread assumptions are fixed constants (section 12) rather than measured. Corporate-action records for ETFs (XLF/XLRE 2016 spin-off, any reverse splits) must be reconciled across two sources before the backtest is trusted.

## 7. Per-input time semantics

| Input | Observation time (`observedAt`) | First public availability (`availableAt`) | Revision / vintage | Assumed processing delay |
|---|---|---|---|---|
| Daily unadjusted OHLCV bar | Session close (exchange calendar; 20:00 or 21:00 UTC depending on DST) | Official close published within minutes; assume close + 30 min | Late corrections possible for a few days; the store keeps every vintage and the decision uses the vintage available at `decisionAt` | 30 min |
| Dividend / distribution | Ex-date (effective), pay date (cash) | Declaration date (issuer press release) | Estimated vs final amounts can differ; the ledger records both with vintage | 1 session after declaration |
| Split / spin-off | Effective date | Announcement date | none | 1 session |
| BIL total return | Session close | close + 30 min | as above | 30 min |
| ETF holdings file (look-through) | Holdings as-of date | Issuer publication, typically next business day | Replaced monthly or daily; each file stored as its own vintage | 1 session |
| Exchange calendar (holidays, early closes) | n/a | Published years ahead | Stored as versioned fixture | none |

Rule enforced in code and tested: no feature at `decisionAt` may read a bar whose `availableAt` is later than `decisionAt`, including the 30 minute processing delay. A test fixture inserts a future-dated corrected bar and asserts the historical decision does not change.

## 8. Candidate rule, cadence, timestamps, entry, holding, rebalance, exit

| Item | PROPOSED default |
|---|---|
| Decision cadence | Weekly, on the last trading session of each exchange week |
| Decision timestamp `decisionAt` | Session close + 60 minutes (exchange calendar, UTC) |
| Assumed executable timestamp | Next trading session open + 5 minutes |
| Simulated fill reference | Next-session official open (unadjusted) plus costs in section 12 |
| Eligibility | `trend_i = 1` AND `mom_i > mom_cash` AND `adv_i >= 50M USD` |
| Entry rule | Rank eligible ETFs by `mom_i` descending. Enter any ETF ranked 1..5 that is not held. |
| Hold rule (hysteresis) | Keep a held ETF while it remains eligible AND ranked 1..7. |
| Book-slot priority | When the entry and hold rules together name more than 5 ETFs, every eligible held ETF ranked 1..7 keeps its book slot ahead of any newcomer and the lowest-ranked newcomers are left out until the book holds 5; this priority governs the book slot only and does not extend to the section 9 step 4 correlated-cluster cap, which stays strictly rank-ordered. |
| Exit rule | Exit at the next decision if `trend_i = 0`, OR `mom_i <= mom_cash`, OR rank > 7, OR compliance restriction added, OR the charter is paused. No price stop: volatility scaling and the trend flag are the loss control. |
| Holding period | Not fixed; expected median 8 to 20 weeks, minimum one week by construction |
| Rebalance rule | Compute targets weekly (section 9). Trade a line only if the absolute weight gap exceeds 2.0 percentage points of NAV, or on entry/exit. Cash leg absorbs residual. |
| Maximum positions | 5 risk ETFs plus cash |
| New positions per session | At most 5 (a full turnover week is allowed at this size) |

The decision is fully determined by the frozen list, the rule table above, and point-in-time data. Two independent implementations from this document must produce identical target weights on identical data; that is an acceptance test.

## 9. Deterministic portfolio construction and sizing

1. Let S be the set of ETFs to hold after applying entry, hold and exit rules (at most 5).
2. Raw weight: `w_i = (1 / vol_i) / sum_j (1 / vol_j)` over S.
3. Cap: no `w_i` above 20% of NAV (ETF cap from the proposed `risk.yaml`). Redistribute excess pro rata to uncapped members; repeat until stable; any residual goes to cash.
4. Correlated-cluster cap: cluster A = {VTI, QQQ, VUG, XLK, XLY}. At most 3 members of cluster A may be held; if the rank order selects more, the lowest-ranked extra members are skipped and the next eligible non-cluster ETFs (up to rank 7) fill the slots.
5. Volatility scaling: ex-ante portfolio volatility `sigma_p = sqrt(w' cov w)` annualized. Scale factor `k = min(1, 0.10 / sigma_p)`. Final `w_i = k * w_i`.
6. Cash weight = `1 - sum(w_i)`, held in BIL, never below 2% of NAV.
7. Share quantities are floored to whole shares at the last unadjusted close; rounding residual goes to cash.

Signal strength enters sizing only through `vol_i` and `cov`, never through momentum magnitude and never through any LLM output. `PortfolioConstructor` receives the target weights and applies `risk.yaml`; `RiskEngine` and `ComplianceEngine` can only shrink or block, never enlarge.

## 10. Capacity and liquidity constraints

- Every universe member trades hundreds of millions to tens of billions USD per day. A sleeve at the proposed cap (5% of liquid household assets) is orders of magnitude below 0.1% ADV participation for every name.
- Hard constraint in `risk.yaml`: any single order at or below 0.5% of 20-session ADV and at or below the maximum order notional. If either would be exceeded, the order is split across sessions or rejected; it is never enlarged.
- The strategy has effectively unlimited capacity at household scale. Capacity is not a falsifier here; cost and whipsaw are.

## 11. Benchmarks

| Role | Benchmark | Purpose |
|---|---|---|
| Primary | VTI total return, dividends reinvested | The mandate's passive alternative (`B0_PASSIVE`) |
| Secondary 1 | Exposure-matched blend: `e * VTI + (1 - e) * BIL`, where `e` is the strategy's realized average equity weight in each calendar month, applied ex post | Separates "held less equity" from "held better equity" |
| Secondary 2 | Static volatility-controlled VTI: VTI scaled to a 10% ex-ante volatility target with the same 63-day estimator, remainder in BIL | Isolates what trend selection adds beyond volatility control alone |
| Secondary 3 | Equal-weight of the 13 risk ETFs, rebalanced monthly | Isolates what selection adds beyond a naive diversified basket |
| Secondary 4 | SPY total return | Familiar comparator only |
| Attribution | Regression of monthly excess returns on market, size, value, momentum factors from a documented free factor library, if licence permits | Explain, not judge |

DGTW-style matching is not used; the universe is ETFs.

## 12. Cost, delay, dividend and tax assumptions

| Component | Base | Adverse | Stress |
|---|---|---|---|
| Commission | 0 USD (broker online ETF trades assumed commission free; verify per broker) | 0 | 0 |
| Half spread | 1 bp VTI/QQQ; 2 bp IWM/VTV/VUG and sector SPDRs; 1 bp BIL | 2x base | 4x base |
| Slippage vs open reference | 5 bp | 10 bp | 20 bp |
| Market-impact proxy | 0 (participation below 0.5% ADV) | 0 | 2 bp |
| Execution delay | Next open + 5 min | Next open + 1 full session | Two sessions |
| Dividends | Accrue at ex-date in NAV, cash received at pay date, reinvested at the next rebalance only | same | same |
| Expense ratios | Embedded in ETF prices; no separate charge | same | same |
| Borrow / financing | none (long only, unlevered) | | |
| Tax scenario | Taxable sleeve. Lots tracked; gains classified short or long term; scenario rates from config (federal marginal plus state), default federal 32% short-term, 15% long-term, state per config. Wash-sale flags on re-entry within 30 days of a loss sale in the same ticker. Household-wide wash-sale accuracy is NOT claimed. | | |

Results are reported gross and net at base, adverse and stress. A result that changes sign between base and 2x base cost is treated as absent.

## 13. Outcome metrics

**Primary metric (one):** difference in after-cost annualized Sharpe ratio between the strategy and VTI total return over the out-of-sample evaluation period, with a stationary block-bootstrap 90% confidence interval (block length 21 sessions) and a deflated-Sharpe adjustment for the registered trial count (section 15).

Pass threshold (PROPOSED): point estimate at least +0.10 and the bootstrap interval excludes zero on the aggregate walk-forward out-of-sample set. Failure to meet either is a fail, not "inconclusive but promising."

**Secondary risk metrics:** maximum drawdown and ratio to VTI maximum drawdown (target at or below 0.75); Calmar; CAGR; worst 21-session return; annualized one-way turnover; average equity exposure; months in cash above 50%; excess return versus Secondary 1 and Secondary 2; after-tax scenario CAGR; realized versus assumed cost in shadow/paper.

## 14. Evaluation design

### 14.1 Historical

Registered history begins 2007-06-01 (BIL inception; all other members have longer history). The rule has no fitted parameters, so "training" means the design period the author is allowed to look at.

| Segment | Dates | Use |
|---|---|---|
| Design / validation | 2007-06-01 to 2018-12-31 | The only period visible while drafting and registering. Walk-forward reporting in calendar-year blocks. |
| Sealed holdout | 2019-01-01 to 2024-12-31 | Opened exactly once, after registration, by the controlled holdout procedure in `docs/EXPERIMENT_PROTOCOL.md`. Includes 2020 whipsaw and 2022 bear. |
| Recent | 2025-01-01 to registration date | Reported separately; treated as quasi-forward. |
| Prospective shadow | Registration date onward | Sealed decisions before outcomes (`SHADOW`, then `PAPER`). |

Purging and embargo: momentum windows overlap, so yearly blocks are evaluated with a 252-session embargo on the signal lookback at block boundaries where a fitted parameter would matter; because nothing is fitted, the embargo only affects the reporting of "first independent decision" counts.

### 14.2 Forward shadow

From registration, every weekly decision is written to the counterfactual ledger before the next open, for arms `B0_PASSIVE` and `B1_DETERMINISTIC`. There is no `C1_LLM_OVERLAY` arm for this charter. Prospective observations are scored with the same cost model and compared to the broker's paper fills once `PAPER` starts.

### 14.3 Minimum useful number of independent decisions

- Weekly decision dates in the registered history: about 990. Effective independent observations are far fewer because the 12-month signal overlaps; the charter counts non-overlapping monthly blocks: about 225 historically, about 155 in design and 72 in holdout.
- Minimum historical: 150 monthly-equivalent out-of-sample blocks spanning at least two drawdowns of 20% or more in VTI. Met by the proposed dates.
- Minimum prospective before `PAPER` to `LIVE_MANUAL` may be considered: 52 weekly decisions (12 months) with zero hard-rule violations. This proves operations, not alpha. The charter states plainly that 12 months of weekly data cannot distinguish skill from noise for this strategy.
- Minimum prospective before any `LIVE_LIMITED` request: 36 months of sealed observations, or a written owner decision that historical plus holdout evidence carries the weight.

## 15. Parameter ranges, trial count, multiple testing

The registered configuration is a single point. A fixed sensitivity grid is run once, reported in full, and used only to judge fragility. No grid member can be promoted without a new charter version.

| Parameter | Registered | Sensitivity grid |
|---|---|---|
| Momentum window | 252 skip 21 | {126 skip 21, 252 skip 21} |
| Trend SMA length | 200 | {150, 200} |
| Volatility window | 63 | {63} |
| Number held (entry / hold rank) | 5 / 7 | {4/6, 5/7, 6/8} |
| Volatility target | 10% | {8%, 10%, 12%} |
| Rebalance band | 2.0 pts | {1.0, 2.0} |

Trial count: 2 x 2 x 1 x 3 x 3 x 2 = 72 grid members, plus the registered point (which is a grid member). Deflated Sharpe ratio is computed with N = 72 trials and the observed cross-trial variance. Every trial is written to the trial ledger before any result is displayed. A registered result is reported as robust only if at least 75% of grid members share the sign of the primary metric.

## 16. Falsification, sensitivity, regime tests, failure modes

### 16.1 Decisive falsifier

After realistic base costs, the strategy fails to improve the primary metric over VTI on the aggregate walk-forward out-of-sample set AND fails to beat Secondary 2 (static volatility-controlled VTI). If either passes, the charter goes to owner review; if both fail, the hypothesis is rejected and the charter is marked `REJECTED` with results preserved.

### 16.2 Additional falsification conditions

- F1: Primary metric point estimate below +0.10 or interval includes zero.
- F2: Maximum drawdown not below 0.75 x VTI maximum drawdown.
- F3: Sign of the primary metric flips under adverse costs or a one-session extra delay.
- F4: Removing the single best 12-month window flips the sign (single-episode dependence).
- F5: Fewer than 75% of grid members agree in sign.
- F6: Prospective: after 36 months, the rolling paired excess return versus VTI is below the 10th percentile of the block-bootstrap distribution built from the historical record. Triggers PAUSE and review, not silent tuning.

### 16.3 Sensitivity tests (all preregistered)

Cost tiers; delay tiers; missing-bar handling (carry forward versus skip decision); alternate adjustment source; removing XLE (in case the compliance decision goes the other way); using SGOV instead of BIL from 2020; monthly instead of weekly cadence; two-week trend confirmation before exit.

### 16.4 Regime tests

Reported separately: 2007-2009 (GFC and 2009 rebound whipsaw), 2011, 2015-2016, 2018 Q4, 2020 Feb-Jun, 2022, 2023-2024 mega-cap concentration; rising versus falling 3-month T-bill yield; VIX above versus below 25 at decision time (VIX used ex post for labelling only, never as an input).

### 16.5 Failure modes

- Whipsaw: repeated exit near lows and re-entry near highs; the dominant known failure of trend rules.
- Momentum crash: sharp reversals after long trends (2009).
- Concentration: rank order piles into one correlated cluster; the cluster cap limits but does not remove this.
- Cash drag: extended periods in BIL during grinding bull markets.
- Cost creep: weekly cadence with tight bands trades more than assumed; measured by realized turnover in shadow.
- Data error: a bad bar or missed dividend flips a trend flag; cross-source price rule and stale-bar rule in `risk.yaml`.
- Tax drag: mostly short-term gains in a taxable sleeve can erase a modest pre-tax edge; reported as a scenario.

## 17. Promotion, downgrade, pause, sunset

| Transition | Rule |
|---|---|
| DRAFT to REGISTERED | Owner approval block signed; charter hash and code commit recorded; holdout sealed; trial ledger opened. |
| REGISTERED to ACTIVE (SHADOW) | Phase 2 research complete; leakage report clean; primary metric passed; owner accepts in writing. If the metric fails, the charter goes to REJECTED, never to ACTIVE. |
| SHADOW to PAPER | 26 weekly sealed decisions with zero missing records and zero hard-rule violations. |
| PAPER to LIVE_MANUAL | Section 14.3 prospective minimum; Phase 6 gateway complete; `LIVE_PROMOTION.md` and `LIVE_AUTHORIZATION` artifact; operational and investment scorecards reviewed. |
| Downgrade | Any hard-rule violation, unresolved high-severity incident, cost calibration error above 2x assumed, unapproved version change, or expired authorization returns the strategy to SHADOW or PAPER (see `docs/AUTOMATION_AND_LIVE_GATES.md`). |
| PAUSE | F6 triggers, data source outage above the staleness budget, or owner request. Positions move to HOLD_ONLY exits only. |
| SUNSET | Two consecutive annual reviews in PAUSE, or rejection under section 16.1, or owner decision. Positions are unwound per the exit rule; records are retained. |

Underperformance over a short window is never by itself a reason to change parameters. A changed parameter is a new version starting at DRAFT.

## 18. LLM requirement

Not required and not used in the signal, sizing, or exits. An optional, non-registered explanatory note may be generated after decisions for the weekly report; it has no arm, no metric, and cannot alter any field of the decision record.

## 19. Data feasibility

- Free daily bars for 14 ETFs since 2007 are widely available; the constraint is licence clarity and adjustment quality, not existence. A broker's market-data API is the cleanest candidate because it comes with explicit terms and a corporate-actions endpoint (UNVERIFIED until probed).
- Required corporate-action records are few and public (ETF distributions, the 2016 XLF/XLRE distribution, any splits).
- Gaps: no free NBBO history (spreads are assumed constants); no guarantee any free source's adjusted column matches our own reconstruction, hence two-source reconciliation.
- Storage: 14 tickers x ~4,800 sessions x a few hundred bytes is under 20 MB raw. Negligible.

## 20. Contamination risk

Low. No LLM in the signal. The residual risks are researcher hindsight (universe choice and parameter choice informed by knowing the last two decades) and the fact that the design period includes 2008. Mitigations: parameters are the most common published values rather than tuned ones, the holdout is sealed before registration and opened once, and the prospective record is the ultimate arbiter.

## 21. Estimated event count

About 990 weekly decision dates historically; about 225 non-overlapping monthly blocks; roughly 15 to 40 ETF entries or exits per year expected. Prospective: 52 decisions per year.

## 22. Pi fit

Trivial. Fourteen daily series, a 13x13 covariance, and a rank. Compute under one second; storage under 20 MB; network one small batch of requests per session. Well inside the budgets in `docs/RESOURCE_BUDGET.md`.

## 23. Reasons this may not work

- Trend and momentum on U.S. equity ETFs have been weaker since 2009 than before; the design period may flatter the rule.
- 2020 shows the cost of the trend flag: exit into the March low, re-enter in June. A rule that survives 2008 can still lose to VTI over a decade.
- Volatility targeting lowers CAGR in long calm bull markets; the Sharpe gain may not translate into wealth gain, and taxes on short-term gains erode it further.
- Weekly rebalancing at a small account produces many small trades whose fixed frictions may exceed assumptions.
- The universe is mostly one asset class. Most published trend-following success comes from multi-asset diversification, which this charter deliberately excludes in version 0.1.
- Beating Secondary 2 (volatility-controlled VTI) is a high bar. If the whole benefit is volatility control, the honest conclusion is "hold VTI and scale it," which is a simpler charter.
- The result may be real and still too small to matter after tax at sleeve scale.

## 24. Open decisions blocking registration

1. Compliance policy on diversified-ETF look-through (decides XLE, flags XLI/XLP).
2. Live cash instrument (BIL, SGOV, or plain cash).
3. Approval of `risk.yaml` defaults referenced here (20% ETF cap, 2% minimum cash, 0.5% ADV participation, 10% vol target).
4. Approval of the free data source after the capability probe.
