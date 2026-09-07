# Alpha Charter: `filing-change-challenger`

**Status: DRAFT - not approved; do not implement**

| Field | Value |
|---|---|
| Strategy ID | `filing-change-challenger` |
| Charter version | `0.1.0-draft` |
| Companion schema | `strategies/filing-change-challenger/charter.yaml` (generated at registration; not yet written) |
| Owner | Matt Herman |
| Author of draft | Black Gold Discovery Pack |
| Approval state | DRAFT. Owner approval: not given. Registration hash: none. |
| Kind | CHALLENGER FEATURE. Not a standalone strategy. Exists only as a `C1_LLM_OVERLAY` on a registered deterministic host. |
| Intended phase | Phase 3 at the earliest, only after a host charter has completed Phase 2 |
| Runtime LLM | Required. This charter is about whether the LLM adds value; the default expectation is that it does not. |
| Evidence rule | Historical replay is contaminated. All promotion evidence is prospective. |

Every number below is a PROPOSED default to be frozen at registration and not tuned after viewing results.

## Owner approval block

```
Charter:        filing-change-challenger 0.1.0-draft
Host charter:   ______________________ (e.g. form4-insider-cluster 0.1.x, or a separately chartered deterministic quality screen)
Approved by:    ______________________ (Matt Herman)
Approval date:  ______________________ (UTC)
Code commit:    ______________________
Charter hash:   ______________________
Model snapshot: ______________________ (exact provider model ID from config; never a remembered alias)
Prompt hash:    ______________________
Schema hash:    ______________________
Ontology hash:  ______________________
Decision refs:  docs/DECISIONS.md D-10 (first charter), D-11 (runtime LLM provider), D-19 (data budget)
```

## 1. What this is and is not

This charter registers one thing: a structured extraction, produced by the runtime LLM from a sealed pair of filing evidence packets (current versus prior), mapped by deterministic code to a single veto rule that is applied to candidates an otherwise identical deterministic process has already selected.

It is not a strategy. It never originates a candidate, never sizes, never ranks unless a later version registers a rank rule, and never runs without a host. If the host is paused, this is paused. If the host is rejected, this has nothing to evaluate.

The question it answers is narrow: on the same candidates, same timestamps, same portfolio and risk rules, same execution assumptions, does adding this one field improve the host's preregistered primary metric after costs? "The memos read well" is not an answer.

## 2. Investable universe and membership rule

Identical to the host charter. This feature cannot add a security the host did not select. Membership as of each decision date is inherited from the host's point-in-time universe snapshot, including the host's survivorship status label. If the host is `EXPLORATORY_SURVIVORSHIP_BIASED`, so is anything computed here.

Host options for version 0.1:

1. `form4-insider-cluster` candidates (preferred: a bounded, event-driven candidate stream of 300 to 600 per year with a natural "did anything change in the filings" question).
2. A separately chartered deterministic quality or value screen. Not drafted here; would need its own Alpha Charter first.

## 3. Long/short and leverage posture

Inherited from the host. Long only, unlevered. The feature can only remove candidates in version 0.1.

## 4. Hypothesis and mechanism

**Hypothesis.** Among candidates already selected by a deterministic rule, those whose most recent 8-K, 10-Q or 10-K shows a structured deterioration versus the prior comparable filing in a fixed set of categories (guidance direction, demand commentary, liquidity and covenants, going concern, restatement, auditor change, senior management departure) earn lower subsequent 63-session excess returns than those that do not. Removing them raises the host's mean per-event net excess return.

**Mechanism.** Long filings impose a reading cost. Changes in language between consecutive filings (a new risk factor, softened demand commentary, a covenant amendment) are information that is public, structured enough to extract against a fixed ontology, and slow to diffuse in names with thin coverage. A language model can perform the comparison at a cost far below an analyst. The hypothesis is only that this comparison, reduced to a few enumerated fields, identifies candidates the host should have skipped.

## 5. Why the effect could persist

- Processing cost is real and the population of small and mid caps with thin coverage is large; the information is dispersed across thousands of documents per quarter.
- Counterpoint, stated plainly: filing-language analysis is a well-worked area (Loughran and McDonald 2011 and successors; textual-change studies such as Cohen, Malloy and Nguyen 2020 "Lazy Prices"). Large funds now run language models over filings at scale. Whatever remained by 2026 is likely thin, and the host's own signal may already absorb most of it. The prior for this charter is that C1 equals B1.

## 6. Features, transformations, allowed data sources

### 6.1 Fixed ontology (frozen at registration; the hash is part of the registration)

| Field | Allowed values | Compared against |
|---|---|---|
| `guidance_direction` | `raised`, `maintained`, `lowered`, `withdrawn`, `not_provided` | Prior comparable filing |
| `demand_commentary` | `improved`, `unchanged`, `deteriorated`, `not_discussed` | Prior comparable filing |
| `capex_investment` | `increased`, `unchanged`, `decreased`, `not_discussed` | Prior comparable filing |
| `capital_return` | `initiated_or_increased`, `unchanged`, `reduced_or_suspended`, `not_discussed` | Prior comparable filing |
| `liquidity_covenant` | `strengthened`, `unchanged`, `weakened`, `breach_or_waiver`, `not_discussed` | Prior comparable filing |
| `going_concern` | `present_new`, `present_continuing`, `absent` | Prior comparable filing |
| `restatement` | `present_new`, `present_continuing`, `absent` | Prior comparable filing |
| `auditor_change` | `present`, `absent` | Current filing |
| `senior_management_departure` | `ceo`, `cfo`, `other_named_officer`, `none` | Current filing (8-K Item 5.02) |
| `new_material_risk_factor` | `present`, `absent` | Prior comparable filing |

Each non-default value requires at least one citation: `{ sourceId, section, charStart, charEnd }` into the sealed packet. Code verifies the cited span exists and that the value's required keywords or a semantic-consistency check passes; an uncited or unverifiable value is coerced to the default (`not_discussed`, `absent`, `none`) and the coercion is logged.

### 6.2 Structured output

```ts
type FilingChangeAssessment = ResearchAssessment & {
  ontologyVersion: string;
  currentFiling: { accession: string; formType: "8-K" | "10-Q" | "10-K"; acceptedAt: string };
  priorFiling?: { accession: string; formType: string; acceptedAt: string };
  fields: Record<OntologyFieldName, { value: string; citations: Citation[] }>;
  netChangeScore: number; // computed by code from fields, echoed for audit only; code value wins
};
```

`ResearchAssessment` is the base schema in the product spec (evidence for and against, missing evidence, thesis, strongest dissent, falsifiers, uncertainty, abstain). No sizing, account, order, or restriction fields exist in the schema; a response containing them is rejected.

### 6.3 Deterministic C1 rule (code, frozen)

```
score = sum over {guidance_direction, demand_commentary, capex_investment,
                  capital_return, liquidity_covenant, new_material_risk_factor}
        of map(value) where improving values = +1, deteriorating values = -1, else 0
veto  = score <= -2
     OR going_concern == present_new
     OR restatement == present_new
     OR liquidity_covenant == breach_or_waiver
     OR senior_management_departure in {ceo, cfo}
```

If `abstain` is true, the response is invalid, or no response arrives by `decisionAt`, the candidate is not vetoed and C1 equals B1 for that candidate, with reason code recorded. The LLM never emits the veto; it emits fields.

### 6.4 Packet construction (deterministic code)

- Current filing: the most recent 8-K (Items 1.01, 2.02, 2.05, 2.06, 3.01, 4.01, 4.02, 5.02, 8.01), 10-Q, or 10-K accepted within 45 calendar days before the host's `decisionAt`. If none, the feature abstains (`no_recent_filing`).
- Prior comparable: for a 10-Q, the 10-Q of the same fiscal quarter one year earlier and the immediately prior 10-Q or 10-K; for a 10-K, the prior 10-K; for an 8-K, the prior 8-K with the same items within 400 days, if any.
- Sections: 10-Q Part I Item 2 (MD&A) and Part II Item 1A; 10-K Items 1A, 7 and 9A; 8-K item text. Extracted by a deterministic sectioner with recorded version; failure to locate a section is a logged coverage gap, and the packet is marked partial.
- Token budget: 60,000 input tokens per packet; sections truncated deterministically from the end with a truncation flag.
- Untrusted-content notice included verbatim. No web access. No ticker or company name if the anonymised variant is selected for the contamination test; the production variant includes them because the prospective run is not contaminated by identity.

### 6.5 Allowed data sources

| Source | Use | Caveat |
|---|---|---|
| SEC EDGAR submissions API and archive | Filing lists with `acceptanceDateTime`; primary documents (HTML/iXBRL) | Fair access at most 10 requests/second; Black Gold uses 2/second with caching |
| Host charter's data | Candidates, timestamps, universe | Inherited |
| Runtime LLM provider via `ModelAdapter` | Extraction | Pinned snapshot; synchronous call with deadline; batch API allowed only for non-market-timed re-scoring and diagnostics because results may take up to 24 hours |

Not allowed: earnings-call transcripts (licence and availability unclear), news, analyst notes, any ISA or professional source.

## 7. Per-input time semantics

| Input | `observedAt` / `effectiveAt` | `availableAt` | Revision / vintage | Assumed processing delay |
|---|---|---|---|---|
| 8-K / 10-Q / 10-K | Period of report | EDGAR `acceptanceDateTime`; filings accepted after 17:30 ET are disseminated next business day 06:00 ET (rule to verify and record; Section 16 forms are the exception, not these) | Amendments (10-K/A, 10-Q/A) are new vintages; the original stays | 60 minutes after dissemination for retrieval and sectioning |
| Prior comparable filing | as above | as above, always earlier | as above | already stored |
| LLM assessment | Time of call | Response time; must be at or before host `decisionAt` or it abstains | Re-runs with a different model or prompt are new experiments, never overwrites | Synchronous deadline 120 seconds per call, 2 bounded retries |
| Ontology, prompt, schema | Registration | Registration | Any change is a new version | none |

Test: inject a 10-Q accepted 1 minute after `decisionAt` and assert the packet uses the previous filing. Test: a late LLM response is recorded but the decision shows `abstain_timeout` and C1 equals B1.

## 8. Candidate rule, cadence, timestamps, entry, holding, rebalance, exit

All inherited from the host. This charter adds exactly one step between host candidate selection and portfolio construction:

| Item | Value |
|---|---|
| Trigger | Host emits an accepted B1 candidate at its `decisionAt` |
| Deadline | The LLM call and validation must finish before the host's `decisionAt` (the packet is built as soon as the candidate is known; for `form4-insider-cluster` that is the same evening) |
| Effect | Veto or no-op. C1 arm records the candidate as `vetoed_by_filing_change` or `passed`. B1 arm is untouched. |
| Entry, holding period, rebalance, exit | Host rules, unchanged |

No arm's result influences another arm at the same timestamp. B1 does not know the veto happened. D1 (LLM-only diagnostic) is a separate ledger where the same assessments are scored without the host's filters; it is never eligible for live.

## 9. Deterministic portfolio construction and sizing

Inherited from the host without change. The vetoed candidate's slot is not refilled in version 0.1 (refilling would change the candidate set and break the paired comparison). Cash from a vetoed slot stays in the cash instrument. No LLM field enters sizing. `uncertainty` is explanatory metadata only.

## 10. Capacity and liquidity constraints

Inherited. The feature only reduces positions. Its own capacity constraint is inference budget and deadline: at 300 to 600 host candidates per year and one packet each, the load is trivial; the binding constraint is the per-call deadline on evenings with many candidates, handled by the per-session candidate limit of the host.

## 11. Benchmarks

The primary comparison is not a market benchmark. It is `B1_DETERMINISTIC` on the same candidates.

| Role | Benchmark |
|---|---|
| Primary | Host's `B1_DETERMINISTIC` arm, paired by candidate |
| Secondary | Host's primary benchmark (VTI total return) and exposure-matched blend, so the absolute level is visible |
| Diagnostic | `D1_LLM_ONLY_SHADOW`: portfolio of all host universe names with a recent filing, held or skipped by the veto alone; reported, never promoted |

## 12. Cost, delay, dividend and tax assumptions

Inherited from the host for trading costs, dividends and tax. Added:

| Component | Base | Adverse |
|---|---|---|
| Inference cost per packet | 60k input plus 2k output tokens at the extraction tier's configured price; recorded per call | 2x (retries, cache misses) |
| Inference budget | Per-day and per-month caps in config; exceeding a cap stops new assessments (C1 abstains, equals B1) and never stops reconciliation or risk | |
| Latency | 120 second deadline; abstain beyond it | |
| Human labelling cost | 50 packets per quarter for the extraction-accuracy gate; owner or delegate time, recorded | |

Inference cost is charged against C1 in the after-cost comparison, expressed as basis points of the average position so the comparison is honest.

## 13. Outcome metrics

**Primary metric (one):** paired difference in the host's primary metric between C1 and B1, computed only on candidates where the feature could have acted (a valid assessment existed). For `form4-insider-cluster` this is the difference in mean after-cost 63-session excess return per event, with a 90% cluster-bootstrap interval clustering by calendar month of entry. Because C1 only removes candidates, the paired difference is driven entirely by the realised returns of vetoed candidates; the metric is reported both as the portfolio-level difference and as the mean excess return of vetoed candidates alone (which should be negative if the feature works).

Pass threshold (PROPOSED): improvement of at least +0.5% per event in the host's mean net excess return, interval excluding zero, on prospective data only.

**Secondary metrics:** veto rate (expected 10% to 25%; a rate outside 5% to 40% is a calibration flag); mean and median excess return of vetoed versus passed candidates; extraction field agreement with human labels (operational gate at 85%); abstention rate and reasons; citation verification failure rate; injection test pass rate; inference cost per event; latency distribution; C1 minus B1 by year, sector, filing type, market-cap tercile.

## 14. Evaluation design

### 14.1 Historical

Historical replay of the LLM is contaminated: the model's training data may include the filings themselves, later news, and the stock's outcome. A historical run is therefore permitted only for:

- Mechanics: schema validity, citation verification, sectioner coverage, latency, cost.
- Bias diagnostics: an anonymised variant (issuer name, ticker, dates shifted, numbers preserved) compared with the identified variant; a large disagreement indicates the model is using identity rather than text.
- Injection and adversarial tests.

Every historical assessment is labelled `CONTAMINATED_REPLAY` and is excluded from the primary metric. There is no historical train, validation or holdout for alpha purposes. The host's own historical evidence stands on its own and is unaffected.

### 14.2 Prospective (the only evidence)

From registration, every host candidate receives an assessment before `decisionAt`, and arms B0, B1, C1 and D1 are written to the counterfactual ledger before the next open. The ablation plan is locked at registration: candidate counts, veto minimum, metric, threshold, and stopping rule below.

### 14.3 Minimum useful number of independent decisions

- 300 prospective host candidates with valid assessments, of which at least 60 were vetoed, and at least 12 calendar months elapsed. At 300 to 600 host events per year this is 8 to 14 months.
- Power statement: with a 63-session per-event standard deviation near 15%, 60 vetoed events give a standard error near 1.9% on the vetoed-group mean. The +0.5% portfolio-level threshold is therefore only resolvable if vetoed candidates are strongly negative (several percent). If the true effect is small, this design will correctly fail to promote. That is acceptable: a small effect would not survive inference cost and labelling effort anyway.
- Stopping rule: evaluate once at 300 candidates and again at 600. No interim peeking is used for promotion; interim looks are for operational health only and are logged.

## 15. Parameter ranges, trial count, multiple testing

| Parameter | Registered | Alternatives (reported only, never promoted without a new version) |
|---|---|---|
| Veto score threshold | -2 | {-1, -2, -3} |
| Hard-veto set | {going_concern new, restatement new, covenant breach, CEO or CFO departure} | {hard set only, score only, both} |
| Filing recency window | 45 days | {30, 45, 90} |
| Token budget | 60k | {60k} |
| Model snapshot | one pinned | none; a second model is a new version and a new experiment |
| Prompt | one pinned hash | none |

Trial count: 3 x 3 x 3 = 27 rule variants over the same assessments. All are logged before display. The family-wise bound is applied to the 27 variants; the registered point must pass on its own and at least 75% of variants must share its sign. Prompt and model variants are explicitly not a grid: each is a separate registered experiment, so the trial ledger cannot hide prompt shopping.

## 16. Falsification, sensitivity, regime tests, failure modes

### 16.1 Decisive falsifier

After 300 prospective host candidates with at least 60 vetoes, the paired C1 minus B1 difference in the host's primary metric, net of trading and inference cost, is not positive with a 90% interval excluding zero, OR the vetoed group's mean excess return is not negative. Either result rejects the feature. The result is recorded and the runtime LLM is excluded from the host's production signal, however persuasive the memos were.

### 16.2 Additional falsification conditions

- F1: Extraction field agreement with human labels below 85% on two consecutive quarterly samples (the feature is not measuring what the ontology says).
- F2: Anonymised versus identified variants disagree on more than 20% of fields in the bias diagnostic (the model is using identity, not text).
- F3: Veto rate outside 5% to 40%.
- F4: Improvement is concentrated: removing the 3 most negative vetoed events makes the difference non-positive.
- F5: Fewer than 75% of rule variants agree in sign.
- F6: Any successful injection producing a tool call, secret disclosure, configuration change or executable order in adversarial tests. This is an operational failure that halts the feature regardless of returns.

### 16.3 Sensitivity tests

Score threshold; hard-veto set; recency window; 10-Q only versus all forms; excluding 8-K-only packets; with and without the anonymisation; with and without MD&A truncation; cost at 2x inference price.

### 16.4 Regime tests

By calendar quarter of filing season; by filing type; by market-cap tercile; by host event type; high versus low market volatility at decision (ex-post label).

### 16.5 Failure modes

- Contaminated evidence presented as alpha (the reason historical results are excluded).
- Sectioner failure on unusual HTML or iXBRL producing empty or wrong sections; coverage report per filing.
- Hallucinated citations; code verifies every span.
- Prompt injection from filing text (public, attacker-writable in principle); defenses per `docs/THREAT_MODEL.md`.
- Model drift: a provider update changes behaviour; snapshot pinning and a silent-fallback prohibition.
- Latency on heavy filing days causing systematic abstention right when information is richest; the abstention rate by day is a metric.
- Asymmetry: a veto-only rule can only help by avoiding losers; if the host's losers are not identifiable from filings, the feature has no channel to add value.
- Low power: the design may fail to detect a real but small effect; that is a deliberate trade.
- Cost creep from retries and cache misses.

## 17. Promotion, downgrade, pause, sunset

| Transition | Rule |
|---|---|
| DRAFT to REGISTERED | Host charter is ACTIVE in at least SHADOW; approval block signed with model, prompt, schema, ontology hashes; ablation plan locked; injection suite passed; budgets set. |
| REGISTERED to ACTIVE (SHADOW) | Phase 3 exit criteria met: adversarial tests pass, invalid responses abstain safely, everything reproducible and redacted, historical assessments labelled contaminated. Activation means "runs in the C1 arm," not "affects trades." |
| C1 becomes part of the host's production signal | Only after the decisive falsifier is passed on prospective data and the owner approves a new host charter version that includes the feature. Until then, production trades (paper or live) follow B1. |
| Downgrade | F1, F2, F3, F6, budget breach, host downgrade, unapproved model or prompt change. Returns to research-only. |
| PAUSE | Host pause; provider outage beyond staleness budget; owner request. |
| SUNSET | Decisive falsifier fails at 600 candidates; or host sunset; or owner decision. Records retained; the negative result is written to `docs/DECISIONS.md` as evidence about LLM value. |

## 18. LLM requirement

Required, by definition. The exact structured contribution is the `fields` block of `FilingChangeAssessment` (section 6.1 and 6.2); the deterministic mapping to a veto is code (section 6.3). The ablation that must justify it is section 13 and 16.1: paired C1 versus B1 on prospective host candidates, after trading and inference cost, with the locked thresholds. Model tier: extraction tier (Haiku-class) by default behind the `ModelAdapter`; a synthesis-tier model is a separate registered experiment, not a fallback. Exact model IDs are configuration and are pinned at registration.

## 19. Data feasibility

- Filings and acceptance timestamps: free and complete from EDGAR.
- Sectioning 10-K and 10-Q HTML reliably across two decades of formatting is the hard engineering problem; prospective-only evaluation means only recent formats matter for the metric, which helps.
- Prior comparable filings for 8-K items are often absent; the packet falls back to "current only" and the field defaults apply.
- Human labels for the accuracy gate: 200 packets per year of owner or delegate time. This is a real cost and is stated.
- Gaps: no transcripts, no consensus data, so `guidance_direction` compares management's own prior statement, not the market's expectation.

## 20. Contamination risk

Highest of the three charters. The runtime model has plausibly seen the filings, the press coverage and the price path for any historical candidate. No historical result counts. The anonymised-versus-identified diagnostic is a check, not a cure. Prompt injection via filing text is a second contamination path and is treated as a security test, not a research nuisance.

## 21. Estimated event count

Equal to the host's accepted candidate count: 300 to 600 per year for `form4-insider-cluster`. Expected vetoes at 10% to 25%: 30 to 150 per year. This is why the minimum observation period is 8 to 14 months for the first look and likely two years for a decisive second look.

## 22. Pi fit

- No local inference. Network calls to the provider with a 120 second deadline; a few hundred per year.
- Packet building: downloading and sectioning two or three filings of 1 to 10 MB per candidate; seconds each. Storage for candidate filings only, a few GB per year compressed, within `docs/RESOURCE_BUDGET.md`.
- Failure mode on the Pi: provider outage or network loss during the evening window causes abstention, never a blocked host decision.

## 23. Reasons this may not work

- The prior is that C1 equals B1. Filing-language signals are heavily mined by well-resourced competitors and the host may already capture the residual.
- A veto-only rule has one channel to add value: the host's losers must be visible in filings. Insider clusters often follow bad news that is already in the filing, so the veto may remove exactly the contrarian events that work.
- Power is low at household-scale event counts. A true but small effect will not be detected, and the design accepts that.
- Extraction noise, sectioner failures and abstention dilute whatever signal exists.
- Inference and labelling costs are certain; the benefit is speculative.
- The most likely honest outcome is a documented negative result about LLM value in this role. That outcome is useful to the project and should not be argued away.

## 24. Open decisions blocking registration

1. Host selection and the host's own progress through Phase 2.
2. D-11: runtime LLM provider and the exact pinned snapshot.
3. Compliance review of the packet: confirmation that no restricted or professional source can enter the sealed packet.
4. Inference budget caps and the human-labelling commitment.
