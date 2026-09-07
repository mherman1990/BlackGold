# Alpha Charter: `form4-insider-cluster`

**Status: DRAFT - not approved; do not implement**

| Field | Value |
|---|---|
| Strategy ID | `form4-insider-cluster` |
| Charter version | `0.1.0-draft` |
| Companion schema | `strategies/form4-insider-cluster/charter.yaml` (generated at registration; not yet written) |
| Owner | Matt Herman |
| Author of draft | Black Gold Discovery Pack |
| Approval state | DRAFT. Owner approval: not given. Registration hash: none. |
| Intended phase | Research from Phase 1 data onward; implementation not before `etf-trend-vol` has completed Phase 2 |
| Runtime LLM in signal | Not in `B1_DETERMINISTIC`. Optional bounded extraction as a `C1_LLM_OVERLAY` feature only (section 18). |
| Stock-level promotion | BLOCKED until point-in-time universe membership and delisting coverage exist (section 2.3) |

Every number below is a PROPOSED default to be frozen at registration and not tuned after viewing results. Any later change is a new charter version.

## Owner approval block

```
Charter:        form4-insider-cluster 0.1.0-draft
Approved by:    ______________________ (Matt Herman)
Approval date:  ______________________ (UTC)
Code commit:    ______________________
Charter hash:   ______________________
Decision refs:  docs/DECISIONS.md D-08 (mandate), D-09 (universe), D-10 (first charter), D-14 (compliance), D-15 (risk budget), D-19 (data budget)
Conditions:     Point-in-time universe source approved: ______ (free / paid / none)
```

## 1. Purpose

First stock-level hypothesis. Tests whether clustered open-market insider purchases, identified by deterministic parsing of Form 4 with true EDGAR acceptance timestamps, predict positive medium-horizon excess returns after liquidity, quality and compliance filters and after realistic costs.

It also exercises the filing ingestion path (EDGAR fair-access client, raw artifact store, XML parser versioning) that any later filing-based work depends on.

## 2. Investable universe and membership rule

### 2.1 Definition

Common stock (not ADRs, not units, not preferreds, not warrants, not funds) of a U.S. domestic SEC registrant subject to Section 16, listed on NYSE, Nasdaq or NYSE American on the decision date, and passing on the decision date:

| Filter | PROPOSED default |
|---|---|
| Unadjusted close | at least 5.00 USD |
| Market capitalization | at least 300M USD (shares outstanding from the latest available 10-Q/10-K cover or dei XBRL fact x close) |
| 20-session average dollar volume | at least 5M USD |
| Listing status | active on the decision date per the point-in-time listing snapshot |
| Exclusions | issuer on the compliance restricted list; issuer tagged with a restricted theme (soybean, biofuel, ag inputs, and any theme added by the compliance policy); blank-check / SPAC (SIC 6770); issuers with a going-concern or delisting-notice 8-K in the prior 90 days when such a record is available |

### 2.2 Membership known as of each decision date

Membership at `decisionAt` is read from a date-effective universe snapshot table. A stock that later delisted must appear in the snapshot for the dates it was listed, and a stock listed today must be absent before its listing date. A current ticker list is not an acceptable substitute (`docs/DATA_PROVENANCE_SPEC.md`).

### 2.3 The survivorship and point-in-time gap (blocking)

Free sources give current membership (SEC `company_tickers.json`, exchange symbol directories, a broker's `assets` endpoint) but not historical listing and delisting dates with delisting returns. Without them:

- A historical backtest silently drops stocks that were acquired, went bankrupt or were delisted, which biases event studies of small and mid caps upward.
- Delisting returns (often deeply negative) are missing from the exit accounting.

Consequences written into this charter:

1. Historical results produced without point-in-time membership and delisting coverage are labelled `EXPLORATORY_SURVIVORSHIP_BIASED` and cannot support promotion past `SHADOW`.
2. From the first day of production ingestion, Black Gold snapshots the full listing universe daily (status, exchange, class, first/last seen) from an approved source, building its own point-in-time record going forward. That record is survivorship-safe from its start date and is sufficient for prospective evaluation.
3. Promotion to `PAPER` or beyond requires either (a) an approved paid point-in-time dataset covering the historical evaluation window, or (b) a prospective record of the minimum length in section 14 collected on Black Gold's own snapshots. Decision D-19 (data budget) decides which.

## 3. Long/short and leverage posture

Long only. Unlevered. No options, shorting, margin, extended hours. Gross exposure is bounded by the position count and sizing in section 9, expected to average well under 100% of sleeve NAV.

## 4. Hypothesis and mechanism

**Hypothesis.** When two or more distinct officers or directors of the same issuer buy stock on the open market within a 30 calendar day window, with aggregate value of at least 100k USD and no offsetting insider open-market sales in the window, the stock earns a positive after-cost excess return over the following 63 trading sessions relative to the passive benchmark.

**Mechanism.** Insiders hold private information about firm prospects and buy with their own money when they believe the stock is cheap. Purchases are more informative than sales because sales have many non-informational motives (liquidity, diversification, compensation). Clusters are more informative than single purchases because they aggregate independent judgements and are less likely to be signalling or noise. The market under-reacts because Form 4 processing is dispersed across thousands of filings, many in small and mid caps with thin analyst coverage, and because the information is soft (a judgement) rather than hard (a number).

## 5. Why the effect could persist

- Section 16 requires disclosure within two business days, so the information is public and fast, yet the literature (Lakonishok and Lee 2001; Cohen, Malloy and Pomorski 2012 on "opportunistic" versus routine trades; many practitioner studies) has reported persistent post-filing drift concentrated in small caps and clusters.
- Capacity is limited in the names where the effect is strongest, which discourages large funds and leaves room for small accounts.
- Counterpoint: this is one of the most studied public signals; data vendors sell it; quantitative funds trade it. The remaining effect may be small, concentrated in illiquid names below our filters, or already arbitraged by the time a 63-session holder enters.

## 6. Features, transformations, allowed data sources

### 6.1 Deterministic extraction from Form 4 XML

For each Form 4 or 4/A primary XML document:

| Field | XML location (verify against current EDGAR Form 4 XML technical specification) |
|---|---|
| Issuer CIK, ticker | `issuer/issuerCik`, `issuer/issuerTradingSymbol` |
| Reporting owner identity | `reportingOwner/reportingOwnerId/rptOwnerCik` |
| Relationship | `reportingOwnerRelationship/isDirector`, `isOfficer`, `isTenPercentOwner`, `officerTitle` |
| Transaction | `nonDerivativeTable/nonDerivativeTransaction`: `transactionDate`, `transactionCoding/transactionCode`, `transactionAmounts/transactionShares`, `transactionPricePerShare`, `transactionAcquiredDisposedCode`, `ownershipNature/directOrIndirectOwnership` |
| 10b5-1 flag | Cover checkbox introduced by the 2023 Rule 10b5-1 amendments (field name to verify); absent in older filings |
| Footnotes | `footnotes/footnote` text, stored raw for the optional LLM feature; never parsed by regex for the signal |
| Amendment | Form type 4/A supersedes the referenced original; the original event is recomputed with the amended values under a new vintage |

### 6.2 Qualifying purchase (PROPOSED)

All of: non-derivative; `transactionCode = P`; `acquiredDisposedCode = A`; price per share greater than 0; shares x price at least 25,000 USD; reporting owner is an officer or director (10%-owner-only filers excluded; sensitivity arm includes them); not flagged as a 10b5-1 plan transaction; `transactionDate` no more than 10 calendar days before the acceptance date (late filings are stale and excluded).

### 6.3 Cluster event (PROPOSED)

At a decision timestamp, for each issuer, consider qualifying purchases with `availableAt <= decisionAt` and `transactionDate` within the trailing 30 calendar days. A cluster event exists when: at least 2 distinct reporting-owner CIKs; aggregate value at least 100,000 USD; no qualifying open-market sale (`transactionCode = S`, officer or director, at least 25,000 USD) in the same window. An issuer generates at most one event per 90 calendar days (the first date the condition is met); later filings in the window are logged as `reinforcing`, not as new events.

### 6.4 Filters applied at the event (section 2.1) plus

- Not within a held position or its 90-day cooldown.
- Sector cap and correlated-cluster cap from `risk.yaml` not already exhausted.

### 6.5 Allowed data sources

| Source | Use | Caveat |
|---|---|---|
| SEC EDGAR submissions API `data.sec.gov/submissions/CIK##########.json` | Per-issuer filing list with `acceptanceDateTime`, form type, accession | Fair access: at most 10 requests/second across all machines, declared User-Agent; Black Gold budgets 2 requests/second. |
| SEC EDGAR daily and full index (`Archives/edgar/daily-index`) | Discovery of new Form 4 accessions across all issuers each session | Index publication lag to measure and record. |
| SEC EDGAR archive documents | Form 4 primary XML and footnotes, by accession | Raw artifact stored content-addressed with hash. |
| SEC DERA Insider Transactions (Form 3/4/5) structured data sets | Bulk historical backfill, quarterly files from 2006 | Field coverage of acceptance timestamp and footnotes to verify; if acceptance time is absent, the filing date plus a conservative same-day-close availability rule is used and labelled. |
| SEC XBRL company facts API | Shares outstanding (`dei:EntityCommonStockSharesOutstanding`) for market cap | Point-in-time by filing acceptance. |
| Broker market-data API (Alpaca) | Daily unadjusted and adjusted bars, corporate actions, current asset list for daily universe snapshots | Free tier terms and historical depth UNVERIFIED until probed; single-venue quotes must not be labelled NBBO. |
| Approved paid point-in-time universe dataset (if D-19 approves) | Historical membership, delistings, delisting returns | None chosen yet. |
| Exchange calendar fixture | Sessions, holidays, early closes | Versioned. |

Not allowed: news, social media, vendor insider-sentiment scores, any ISA or professional source, any 13F data (delayed; outside this hypothesis).

## 7. Per-input time semantics

| Input | `observedAt` / `effectiveAt` | `availableAt` | Revision / vintage | Assumed processing delay |
|---|---|---|---|---|
| Form 4 transaction | `transactionDate` (effective) | EDGAR `acceptanceDateTime` (UTC), plus dissemination delay. Section 16 filings accepted after the 17:30 ET cutoff are still disseminated the same evening (to verify; if not, availability is next business day 06:00 ET) | 4/A creates a new vintage; the original stays with `supersededBy` | 60 minutes after acceptance (polling interval plus parse) |
| Form 4 footnotes | as filing | as filing | as filing | same |
| Shares outstanding | Cover-page date | Acceptance of the 10-Q/10-K carrying it | New filing replaces; old vintage retained | 60 minutes |
| Daily bar | Session close | Close + 30 min | Corrections retained as vintages | 30 min |
| Universe snapshot | Snapshot time (daily, after close) | Snapshot time | Append only | none |
| Restricted list / themes | Owner edit time | Owner edit time | Versioned | none |
| Corporate actions (splits, cash mergers, delistings) | Effective date | Announcement or exchange notice | Versioned | 1 session |

A filing accepted after the current session's `decisionAt` belongs to the next decision. Tests: inject a filing with acceptance 1 minute after `decisionAt` and assert it is excluded; inject a 4/A that removes a purchase and assert the historical event is unchanged while the current vintage shows the amendment.

## 8. Candidate rule, cadence, timestamps, entry, holding, rebalance, exit

| Item | PROPOSED default |
|---|---|
| Decision cadence | Daily, every trading session |
| `decisionAt` | Session close + 90 minutes (UTC, exchange calendar) |
| Assumed executable timestamp | Next session open + 5 minutes |
| Simulated fill reference | Next-session official open (unadjusted) plus costs in section 12 |
| Candidate rule | All cluster events (6.3) passing filters (2.1, 6.4) with `availableAt <= decisionAt` |
| Entry rule | Enter every qualifying candidate up to the per-session limit (3 new positions), ranked by aggregate cluster value as a share of market cap descending if the limit binds |
| Holding period | Fixed 63 trading sessions from the fill session |
| Rebalance rule | None. Positions are not topped up, trimmed or re-weighted. A reinforcing cluster does not extend the holding period. |
| Exit rule | Time exit: sell at the open of session 64. Stop exit: if the unadjusted close is at or below 85% of the fill price, sell at the next open. Compliance exit: restriction added, sell at next open. Corporate exit: cash acquisition or delisting handled by the corporate-action ledger at the recorded terms. |
| Maximum open positions | 20 |
| New positions per session | 3 |

## 9. Deterministic portfolio construction and sizing

1. Per-position initial loss budget: 0.35% of sleeve NAV (proposed `risk.yaml`).
2. Stop distance: 15% of fill price (proposed). Weight `w = min(5% of NAV, 0.35% / 0.15) = 2.33% of NAV`.
3. Whole shares at the last unadjusted close; residual to cash.
4. Sector cap 20% of NAV, correlated-cluster cap per `risk.yaml`, gross exposure cap 100%, minimum cash 2%.
5. Cash is held in the approved cash instrument.
6. No signal-strength scaling in version 0.1: every accepted event gets the same weight. Ranking is used only to choose among candidates when the per-session limit binds. No LLM output touches any of the above.

Expected exposure: with 300 to 600 events per year and 63-session holds, the average number of open positions is roughly 20 x utilisation; at 2.33% each the portfolio is expected to run 20% to 47% invested. This is deliberately low and is why the exposure-matched benchmark matters.

## 10. Capacity and liquidity constraints

- Minimum 20-session ADV of 5M USD and a per-order participation cap of 0.5% of ADV. A 2.33% position in a sleeve of the proposed size is far below that cap for every qualifying name, so capacity is not binding at household scale.
- Slippage in small caps is the real constraint and is modelled by ADV tier in section 12.
- Names below 5M USD ADV are excluded even though the literature suggests the effect is strongest there; that trade-off is deliberate and stated.

## 11. Benchmarks

| Role | Benchmark | Purpose |
|---|---|---|
| Primary | VTI total return | Mandate passive alternative (`B0_PASSIVE`) |
| Secondary 1 | Exposure-matched blend of VTI and the cash instrument at the strategy's realized monthly equity weight | Separates cash drag from selection |
| Secondary 2 | IWM total return | The likely size tilt |
| Secondary 3 | Size-decile matched control: for each event, the equal-weighted 63-session return of all universe members in the same market-cap decile at the event date | Available only with point-in-time universe data; the cleanest event-level benchmark |
| Attribution | Regression on market, size, value, momentum factors from a documented free factor library, licence permitting | Explain, not judge |

## 12. Cost, delay, dividend and tax assumptions

| Component | Base | Adverse | Stress |
|---|---|---|---|
| Commission | 0 USD assumed for online stock trades; verify per broker | 0 | 0 |
| Half spread by ADV tier | 5M to 20M USD ADV: 15 bp; 20M to 100M: 8 bp; above 100M: 3 bp | 2x | 4x |
| Slippage vs open reference | 10 bp | 20 bp | 40 bp |
| Market-impact proxy | 0 below 0.5% ADV participation | 5 bp | 10 bp |
| Execution delay | Next open + 5 min | Next open + 1 session | 2 sessions |
| Dividends | Ex-date accrual, pay-date cash, held as cash | same | same |
| Delisting | Delisting return from the point-in-time dataset; if unknown, minus 100% for involuntary delistings and deal terms for acquisitions | same | same |
| Borrow / financing | none | | |
| Tax scenario | Taxable sleeve; 63-session holds are all short-term; config rates (default federal 32% short-term, state per config); wash-sale flags within 30 days per ticker; household-wide accuracy not claimed | | |

## 13. Outcome metrics

**Primary metric (one):** mean after-cost 63-session excess return per event versus the primary benchmark (VTI total return over the same sessions), measured in event time, with a 90% cluster-bootstrap confidence interval clustering events by calendar month of entry.

Pass threshold (PROPOSED): mean at least +1.0% per event net of base costs and the interval excludes zero on the out-of-sample set.

**Secondary risk metrics:** hit rate; median excess return; excess return versus Secondary 1 and Secondary 3; portfolio-level net Sharpe, maximum drawdown, Calmar; turnover; share of total profit from the top 10 events (concentration); stop-out rate; results by year, sector, market-cap tercile, cluster size (2 versus 3 or more insiders); realized versus assumed cost in paper.

## 14. Evaluation design

### 14.1 Historical

Form 4 structured XML is broadly available from 2006 onward. History before that is out of scope.

| Segment | Dates | Use |
|---|---|---|
| Design / validation | 2006-01-01 to 2017-12-31 | Visible while drafting; walk-forward in calendar-year blocks |
| Sealed holdout | 2018-01-01 to 2024-12-31 | Opened once after registration |
| Recent | 2025-01-01 to registration | Quasi-forward, reported separately |
| Prospective shadow | Registration onward | Sealed decisions before outcomes |

Overlapping 63-session holds require purging: events whose holding windows straddle a block boundary are assigned to the block of entry, and the first 63 sessions of each block are excluded from the primary metric of that block when a boundary-dependent choice exists. Historical segments are `EXPLORATORY_SURVIVORSHIP_BIASED` until section 2.3 is resolved.

### 14.2 Forward shadow

Every session, arms `B0_PASSIVE`, `B1_DETERMINISTIC`, and, once Phase 3 exists, `C1_LLM_OVERLAY` and `D1_LLM_ONLY_SHADOW` are written to the counterfactual ledger before the next open. Accepted and rejected candidates are logged with reason codes for each arm. Arms never see each other's output at the same timestamp.

### 14.3 Minimum useful number of independent events

- Estimated events: 300 to 600 per year after filters (section 21). Historical out-of-sample minimum: 400 events across at least 5 calendar years.
- Prospective minimum before `PAPER`: 150 sealed events and 6 months elapsed.
- Prospective minimum before `LIVE_MANUAL` consideration: 300 sealed events and 12 months elapsed, plus a resolved point-in-time universe (2.3). This proves operations and gives a first noisy read on the effect; it does not prove alpha. With a per-event standard deviation of roughly 15% over 63 sessions, 300 events give a standard error near 0.9% per event, which barely resolves the +1.0% threshold. The charter says so.
- Prospective minimum before any `LIVE_LIMITED` request: 800 sealed events or 30 months, whichever comes later.

## 15. Parameter ranges, trial count, multiple testing

| Parameter | Registered | Sensitivity grid |
|---|---|---|
| Cluster window | 30 days | {14, 30, 60} |
| Minimum distinct insiders | 2 | {2, 3} |
| Minimum aggregate value | 100k USD | {50k, 100k, 250k} |
| Minimum per-purchase value | 25k USD | {25k} |
| Holding period | 63 sessions | {42, 63, 126} |
| Stop distance | 15% | {none, 15%} |
| Include 10%-owner filers | no | {no, yes} |

Trial count: 3 x 2 x 3 x 1 x 3 x 2 x 2 = 216 grid members including the registered point. All are written to the trial ledger before display. The registered result is reported as robust only if at least 75% of grid members share the sign of the primary metric. A multiple-testing adjustment appropriate to event-time means (Bonferroni-style bound on the family, plus a deflated-Sharpe report at portfolio level) is applied; if sample sizes do not support the deflated Sharpe assumptions, only the family bound is reported.

## 16. Falsification, sensitivity, regime tests, failure modes

### 16.1 Decisive falsifier

The mean after-cost 63-session excess return per event on genuinely untouched data (sealed holdout with point-in-time universe, or the prospective record) is not distinguishable from zero at the 90% level, or falls below +1.0%, once true acceptance timestamps, exclusions, ADV-tiered costs and delisting returns are applied.

### 16.2 Additional falsification conditions

- F1: Primary metric fails on the aggregate out-of-sample set.
- F2: Effect disappears when events are restricted to names above 20M USD ADV (effect lives only where we cannot trade).
- F3: Sign flips under adverse costs or one extra session of delay (the effect is front-loaded and we are too slow).
- F4: Top 10 events explain more than 50% of cumulative profit.
- F5: Fewer than 75% of grid members agree in sign.
- F6: Effect present only in the survivorship-biased run and absent once point-in-time membership is used.
- F7: Prospective: after 300 events, the mean is negative or the interval is entirely below +0.5%. Triggers PAUSE.

### 16.3 Sensitivity tests

Cost tiers; delay tiers; excluding financials; excluding events within 5 sessions after a 10-Q/10-K acceptance (post-earnings purchases); excluding indirect ownership; treating 4/A amendments as new events versus revisions; alternate shares-outstanding source; requiring the cluster to be net of all insider sales rather than only large ones.

### 16.4 Regime tests

By year; 2008-2009; 2020; 2022; rising versus falling T-bill yields; VIX above versus below 25 at entry (ex-post label only); market-cap terciles; sector.

### 16.5 Failure modes

- Survivorship bias masquerading as alpha (the largest risk; section 2.3).
- Timestamp leakage: using `filingDate` instead of `acceptanceDateTime` can move availability a full session earlier for evening filings.
- Misclassified purchases: private placements, offering participation, exercises reported as P, or purchases by an insider's fund coded as P. Deterministic rules cannot see this; it lives in footnotes (section 18).
- Parser drift: EDGAR XML schema changes across years; parser version is recorded on every observation.
- Cash drag from low utilisation.
- Short-term tax on every gain.
- Index-rebalance and earnings-window confounds.
- Restricted-theme leakage: an issuer's theme tag is added after entry; compliance exit handles it but the record must show the exposure occurred.

## 17. Promotion, downgrade, pause, sunset

| Transition | Rule |
|---|---|
| DRAFT to REGISTERED | Approval block signed; point-in-time universe decision recorded (free, paid, or prospective-only); holdout sealed; trial ledger opened. |
| REGISTERED to ACTIVE (SHADOW) | Phase 2-equivalent research complete with leakage and coverage reports; results labelled for survivorship; owner accepts in writing. Exploratory results alone cannot move the charter past SHADOW. |
| SHADOW to PAPER | 150 sealed events, 6 months, zero missing records, zero hard-rule violations, universe snapshots complete for the whole period. |
| PAPER to LIVE_MANUAL | Section 14.3 minimum; point-in-time universe resolved; Phase 6 gateway; `LIVE_PROMOTION.md` and authorization artifact; both scorecards reviewed. |
| Downgrade | Hard-rule violation, high-severity incident, cost calibration error above 2x, parser or EDGAR outage beyond the staleness budget, unapproved version change, expired authorization. |
| PAUSE | F7, data outage, owner request. HOLD_ONLY: existing positions exit by rule, no new risk. |
| SUNSET | Rejection under 16.1, two annual reviews in PAUSE, or owner decision. |

## 18. LLM requirement (optional, C1 only)

Not required for `B1_DETERMINISTIC`. An optional `C1_LLM_OVERLAY` feature is proposed for Phase 3, evaluated only against the identical B1 candidate set:

- Timing: the Analyst runs AFTER deterministic selection, on the sealed evidence packet for each accepted candidate, before `decisionAt`. If no valid response by `decisionAt`, C1 abstains and equals B1 for that candidate (`abstain_timeout`).
- Packet contents: the Form 4 XML fields, footnote text, the 4/A chain, the issuer's 8-K item list and item text for Items 1.01, 2.02, 3.01, 4.02, 5.02, 8.01 accepted in the prior 30 days, the standard untrusted-content notice. No web access.
- Exact structured field: `purchaseContext` enum {`open_market`, `private_placement`, `offering_participation`, `plan_10b5_1`, `exercise_or_conversion_related`, `fund_or_affiliate_vehicle`, `unknown`} with a required footnote citation; and `contraryFilingFacts[]` from a fixed enum {`going_concern`, `delisting_notice`, `restatement`, `auditor_change`, `ceo_or_cfo_departure`, `covenant_breach`} each with a source citation. Plus the standard `ResearchAssessment` fields and `abstain`.
- Deterministic C1 rule (code, fixed at registration): veto the candidate if `purchaseContext` is any value other than `open_market` or `unknown`, or if `contraryFilingFacts` contains `going_concern`, `delisting_notice` or `restatement`. Nothing else changes. No sizing, no ranking, no adds.
- Model tier: extraction tier (Haiku-class) behind the `ModelAdapter`, exact model snapshot pinned per `docs/EXPERIMENT_PROTOCOL.md`. Model IDs live in config.
- Ablation that must justify it: paired B1 versus C1 primary metric on prospective candidates only. C1 is retained only if it improves the mean per-event net excess return by at least +0.5% with a 90% cluster-bootstrap interval excluding zero, after at least 300 prospective candidates of which at least 40 were vetoed. Extraction accuracy on a 50-packet human-labelled sample per quarter must be at least 85% field agreement as an operational gate (not as alpha evidence).
- Historical replay of this feature is `CONTAMINATED_REPLAY` (section 20) and cannot count toward the ablation.

## 19. Data feasibility

- Form 4 XML with acceptance timestamps: free, official, complete since 2006, rate-limited but well within budget at 2 requests/second. Historical backfill via the DERA structured data sets avoids millions of archive requests.
- Prices and corporate actions: free daily bars exist; corporate-action completeness for delisted names is the weak point.
- Point-in-time universe and delisting returns: NOT free in usable form. This is the single blocking gap and the reason stock-level promotion is blocked.
- Shares outstanding: free via XBRL company facts from 2009; sparse before that, so market-cap filter coverage is weaker in 2006-2008 and is reported in the coverage report.
- Storage: Form 4 XML around 10 KB each, 200k to 300k per year; restricted to the parsed fields plus raw XML for events only, the footprint is a few GB compressed over the history. Bulk download of every filing is not required and is not proposed.

## 20. Contamination risk

- `B1_DETERMINISTIC` historical replay: low contamination from the rule itself; HIGH survivorship bias until 2.3 is resolved; moderate researcher-hindsight risk (thresholds are common published values, not tuned).
- `C1_LLM_OVERLAY` historical replay: HIGH. The model may know what happened to the issuer. Sealed or anonymised packets may be used to test mechanics, injection defenses and abstention, and are labelled `CONTAMINATED_REPLAY`. Only prospective, timestamp-locked observations count.
- Prompt injection: footnotes and 8-K text are attacker-controlled public text. Defenses per `docs/THREAT_MODEL.md`; any instruction-like content in a packet is a test case.

## 21. Estimated event count

Order-of-magnitude, to be replaced by the coverage report: 200k to 300k Form 4 filings per year; perhaps 20k to 30k open-market purchase filings by officers or directors; clusters of 2 or more within 30 days and 100k USD or more, inside the liquid universe: roughly 400 to 900 per year; after the 90-day per-issuer rule and exclusions: 300 to 600 per year. Historical 2006 to 2024: 5,000 to 10,000 events, biased upward by survivorship until fixed.

## 22. Pi fit

- Ingestion: polling the daily index and a few hundred submissions files per session, at or below 2 requests/second with conditional requests and caching. Minutes per session.
- Parsing: XML parse of a few thousand small documents per day; negligible CPU.
- Storage: few GB compressed; within `docs/RESOURCE_BUDGET.md` if raw filings are kept only for events and their issuers.
- Backfill: the DERA quarterly sets are hundreds of MB each; a one-time multi-hour job on the Pi with resumable downloads.
- Optional LLM: network calls only; at 300 to 600 candidates per year at extraction-tier pricing, inference cost is small, subject to the per-day and per-month budgets.

## 23. Reasons this may not work

- The signal is famous. Vendors sell insider-cluster feeds; the residual after competition may be under our cost floor.
- The best-documented returns sit in micro caps we exclude for liquidity and cost reasons.
- Any historical evidence we can produce for free is survivorship-biased in exactly the direction that makes this look good.
- Two business days of Section 16 lag plus our next-open execution means the fast part of any drift is gone before entry.
- Utilisation is low, so even a real per-event edge produces a small portfolio-level effect that taxes and cash drag can erase.
- Insider purchases cluster after price declines; the "effect" may be a value or reversal exposure that a factor benchmark explains away.
- Footnote-level misclassification (private placements coded P) adds noise to B1 that only the C1 feature can remove, and C1 needs a year of prospective data to be judged.

## 24. Open decisions blocking registration

1. D-19: free-only versus paid point-in-time universe and delisting data; without a paid source, registration is prospective-only.
2. Compliance policy: restricted-theme tagging method for single issuers (SIC codes, keyword lists, manual list) and its update cadence.
3. `risk.yaml`: 0.35% per-position loss budget, 15% stop, 20 positions, 3 per session, 20% sector cap.
4. Whether `C1_LLM_OVERLAY` is registered together with B1 or as a separate later version.
