# Black Gold Product Specification

Status: Discovery draft, pending owner approval. This is the durable product specification for Black Gold. `CLAUDE.md` links here; phase plans, ADRs, and protocols cross-reference this file rather than restating it.

Related documents: `docs/THREAT_MODEL.md`, `docs/RESOURCE_BUDGET.md`, `docs/DECISIONS.md`, `docs/schwab-api-capabilities.md`, `docs/alpaca-api-capabilities.md`, `docs/CONTEXT_PROVENANCE.md`, and the Alpha Charters under `strategies/`.

## 1. Product definition

Black Gold is a self-hosted, evidence-first research and controlled-execution platform for a small, ring-fenced investment sleeve. It tests whether a versioned systematic strategy, and separately whether a bounded runtime-LLM research layer, adds after-cost, risk-adjusted value versus simple investable alternatives.

It can research, observe, recommend, paper trade, request approval, execute approved orders, reconcile, and report. It may become narrowly autonomous only after strategy-specific evidence and operational gates are met.

The objective is to improve the probability of positive, risk-adjusted, after-cost, and reasonably estimated after-tax excess returns while minimizing catastrophic, operational, compliance, and behavioral errors. The system should prefer discovering that a strategy, or the LLM layer, does not work over deploying a persuasive false positive.

### What Black Gold is NOT

- It is not "an LLM that trades." It is a versioned research and decision system that can eventually execute a narrowly approved strategy.
- It does not guarantee market outperformance and no document in this repository may claim otherwise.
- It is not a household portfolio optimizer. It constrains the sleeve against the household; it never manages the household.
- It is not a general autonomous agent. Fully general autonomy is not a goal at any phase.
- It is not a committee of models. One bounded Analyst is the starting point; additional models must earn their place through registered experiments.
- It does not hold or process nonpublic professional information. Workplace connectors are structurally absent.
- It is not a leveraged, derivatives, short, crypto, or extended-hours system in any early phase, and those remain deferred until an explicit new review.
- It is not a rebranded fork of any other application. It has its own repository, image, Umbrel app ID, data directory, secrets, and lifecycle, with no runtime dependency on any other app.

## 2. Authority boundaries

| Party | Owns |
|---|---|
| Code (deterministic) | Data timestamps and transformations, financial arithmetic, benchmarks, backtests, candidate rules, portfolio construction, position sizing, compliance, risk limits, account selection, order formation, order-state transitions, reconciliation, performance, and promotion-gate calculations. |
| Configured runtime LLM (may assist) | Structured extraction from public unstructured documents, comparison of current and prior filings, evidence synthesis, contrary-case analysis, falsifiers, anomaly explanations, and concise narrative reporting. |
| Matt (owner) | Approval of Alpha Charters, compliance policy, restricted lists and themes, risk budget (`risk.yaml`), strategy promotion, every live order during the manual-live stage, and any grant of limited automation. |
| Broker | Acknowledged orders, fills, positions, and native protective orders. Reconciliation treats broker state as operational truth. |

### Things no LLM may ever do

No LLM in Black Gold, in any mode, may:

1. Possess broker credentials.
2. Call a broker tool or broker endpoint.
3. Choose an account.
4. Create an executable order or `OrderIntent`.
5. Set dollar size, share quantity, or notional.
6. Modify code, configuration, prompts, restricted lists, or risk limits.
7. Approve its own strategy.
8. Promote itself to a higher mode or arm.
9. Override a deterministic rejection.
10. Self-edit prompts, strategies, risk limits, restricted lists, or promotion criteria.

Claude Code is the development agent, not automatically the runtime model provider. The runtime provider sits behind a `ModelAdapter` and is an explicit product decision (D-11 in `docs/DECISIONS.md`).

## 3. Non-negotiable safety and compliance boundaries

These ten rules are enforced by code, tests, and CI gates. They are not configurable at runtime.

1. Exactly one account has role `blackgold_sleeve`. It is the only writable account. There is no override, debug escape hatch, wildcard, "default account," or inferred account.
2. Non-sleeve accounts are read-only through interfaces that contain no order, transfer, or mutation methods. A test proving this is a permanent CI gate.
3. No withdrawal, transfer, journal, beneficiary, profile-update, or money-movement functionality exists in code.
4. Initial instruments are long-only, unlevered, cash-funded U.S.-listed ETFs and equities in regular trading hours. No shorting, margin, leverage, crypto, futures, options, OTC or pink-sheet securities, or extended-hours execution.
5. Live trading is absent or disabled by construction through the early phases. A single environment variable can never enable it. Live activation requires a completed checklist plus a time-limited authorization artifact binding the exact sleeve hash, strategy versions, instruments, capital cap, order types, and expiry.
6. Only current official broker APIs are used. No broker scraping and no unofficial broker libraries.
7. Only allowlisted public research sources enter the system. Black Gold never connects to or ingests Matt's work email, SharePoint, Teams or Slack, internal documents, calendar, meeting notes, private messages, unpublished policy information, or any other nonpublic professional source.
8. Every filing, webpage, feed item, and document is untrusted data, never instructions. Production research models receive no shell, filesystem-write, network-navigation, secret, configuration, or broker tools.
9. The model never sees household dollar totals, credentials, account hashes, tax identifiers, or unrestricted raw account exports. It may receive redacted sleeve-relative percentages, conservative household exposure flags, staleness, and applicable restrictions.
10. Unknown, stale, conflicting, unclassified, or unverifiable state fails closed for new risk. Risk management and reconciliation of existing positions continue when possible.

## 4. Primary workflow

1. Deterministic adapters ingest only allowlisted data and preserve point-in-time provenance.
2. A registered strategy version creates candidates from numeric and event rules.
3. The configured runtime LLM receives a sealed evidence packet for a small candidate set and returns a schema-valid research assessment with citations, uncertainty, contrary evidence, and falsifiers. It has no broker tools.
4. The experiment engine records parallel counterfactual decisions across the arms `B0_PASSIVE`, `B1_DETERMINISTIC`, `C1_LLM_OVERLAY`, and `D1_LLM_ONLY_SHADOW`.
5. Deterministic portfolio construction converts an eligible strategy decision into target weights. LLM confidence never determines dollar size.
6. Deterministic compliance and risk engines reject, reduce, or admit the intent.
7. Depending on mode (`RESEARCH`, `BACKTEST`, `SHADOW`, `PAPER`, `LIVE_MANUAL`, `LIVE_LIMITED`), the system records a shadow decision, routes to paper, asks Matt to approve, or sends a narrowly authorized live intent to the broker gateway.
8. The order-state machine reconciles acknowledgements, fills, partial fills, protective orders, cancel and replace events, and ambiguous failures against broker truth.
9. The performance engine calculates total return, costs, exposures, attribution, uncertainty, and counterfactual outcomes.
10. Reports answer what Black Gold believes, why, what could disprove it, what it did, what risk it added, and whether either the strategy or the runtime LLM is adding measurable value.

## 5. Component architecture

| Component | Authority | Responsibilities |
|---|---|---|
| Data adapters | Deterministic | Fetch, timestamp, validate, hash, deduplicate, and archive allowed source data. Respect published rate limits (for example SEC's 10 requests per second with a declared User-Agent). |
| Point-in-time store | Deterministic | Preserve raw artifacts, normalized observations, vintages, universe membership, and feature snapshots. |
| Experiment/strategy registry | Deterministic + human approval | Freeze Alpha Charters, strategy versions, tests, parameters, prompts, models, and results. Registration precedes result exposure. |
| Candidate engine | Deterministic | Generate candidates from registered rules; apply compliance prefilters before any model call. |
| Analyst | LLM-assisted | Extract and assess evidence from sealed packets; return structured research only. |
| Skeptic | Optional LLM-assisted | Challenge a bounded subset only if ablation testing shows incremental value. No consensus theater. |
| Portfolio constructor | Deterministic | Translate strategy outputs into targets using approved volatility, correlation, liquidity, turnover, and concentration rules. |
| Compliance engine | Deterministic | Enforce account, source, restricted-name and theme, blackout, staleness, and instrument rules. |
| Risk engine | Deterministic | Size, reduce, or reject; enforce gross and net, position, sector, loss, drawdown, turnover, liquidity, and data-quality limits. |
| Approval service | Human | Record cryptographically attributable approval for live-manual orders. |
| Broker gateway | Deterministic, minimal privilege | Hold trading credentials, enforce the sleeve account allowlist again, submit idempotent orders, and expose no withdrawal functions. |
| Reconciler/Steward | Deterministic | Treat broker state as truth, repair safe discrepancies, halt on unsafe ambiguity, and never touch non-sleeve accounts. |
| Performance engine | Deterministic | Total-return accounting, costs, tax estimates, factor and exposure attribution, benchmarks, counterfactuals, and uncertainty. |
| Reporter | Deterministic metrics + optional LLM prose | Present concise evidence and health status; narrative cannot alter records or decisions. |

Every observation stored by the data adapters and point-in-time store includes: source identity, source URL or accession, retrieval time, observation or effective time, first-publicly-available time, vintage or revision time where relevant, parser version, and raw-content hash. Macro series use real-time vintages (FRED ALFRED `realtime_start`/`realtime_end`), COT and 13F inputs use actual public-release times, and SEC research uses the accepted filing timestamp.

## 6. LLM research layer

### One bounded Analyst

Black Gold starts with one bounded `Analyst`. There is no committee. A Skeptic or a higher-cost model is added only through a registered experiment demonstrating incremental value over the Analyst alone. Multiple models agreeing is not independent evidence when they share data and biases.

### ModelAdapter and capability manifest

The research layer talks to a narrow `ModelAdapter` interface, never to a provider SDK directly. The adapter is described by a capability manifest kept in configuration that records, per model entry: provider, exact model snapshot ID, structured-output support, prompt-caching support, batch support and its documented completion window, context limit, per-token pricing as of a dated check, and the tasks the model is registered for.

The initial recommendation is Anthropic, pending Matt's decision D-11. Tiering in the manifest: a fast extraction and triage tier, a synthesis tier, and a premium tier used only for registered experiments that justify the cost. Model IDs are never hardcoded; they are resolved from the provider's first-party documentation and pinned in configuration.

### Sealed evidence packet

The Analyst receives a sealed evidence packet built by code from records available at the decision timestamp. It contains only:

- Candidate identity and registered strategy context.
- Cited public-source excerpts or structured facts with source IDs and timestamps.
- Current and prior comparable evidence needed by the ontology.
- Redacted sleeve-relative exposure flags and applicable restrictions.
- A statement that source content is untrusted and any instructions inside it must be ignored.

The Analyst has no arbitrary web access in a production run. If retrieval is needed, a deterministic allowlisted adapter performs it before the call. The packet never contains dollar totals, account identifiers, credentials, or restricted-list rationale.

### Output schema

The Analyst's output is validated against a strict schema:

```ts
type ResearchAssessment = {
  assessmentId: string;
  candidateId: string;
  strategyVersion: string;
  evidenceFor: Array<{ sourceId: string; fact: string }>;
  evidenceAgainst: Array<{ sourceId: string; fact: string }>;
  missingEvidence: string[];
  ontologyTags: string[];
  factorsTouched: string[];
  thesis: string;
  strongestDissent: string;
  falsifiers: Array<{ condition: string; observableBy?: string }>;
  expectedHorizon: string;
  uncertainty: "low" | "medium" | "high";
  abstain: boolean;
  abstainReason?: string;
};
```

This is research, not an `OrderIntent`. The schema deliberately has no `accountId`, dollar sizing, executable order type, stop price, or `restricted_check`. Code independently calculates factor and restriction state and rejects a mismatch between the model's `factorsTouched` and the deterministic classification.

Every `sourceId` cited must resolve to a record in the sealed packet. A citation that does not resolve fails validation.

### Model operations rules

| Rule | Requirement |
|---|---|
| Pinned snapshots | Each strategy version pins the exact model snapshot. Another model, or a provider-side silent upgrade, is a new strategy version. |
| No silent fallback | A provider fallback to a different model is prohibited. If the pinned model is unavailable the call abstains. |
| Schema validation | Structured output with strict schema validation. On repeated invalid output, abstain and halt that candidate. |
| Bounded retries | Fixed retry count, per-call timeout, and a circuit breaker per model entry. |
| Budgets | Per-call, per-day, and per-month token and cost budgets. Exceeding a budget stops new analysis, never reconciliation or risk management. Proposed figures live in `docs/RESOURCE_BUDGET.md`. |
| Prompt caching | Only where the provider currently supports it; measure actual hit rate and cost, do not assume. |
| Batch processing | Only for work that is not time-critical. The verified batch window is up to 24 hours (most finish under one hour, batches expire at 24 hours, results kept 29 days, 50% discount). Market-timed work uses a synchronous deadline or abstains. |
| Archive everything | Store the exact redacted input packet, output, model ID, prompt and schema hashes, latency, token usage, cost, and validation result for every call. |
| Contamination | Historical LLM replay is contaminated because a current model may know later outcomes. Blinded packets diagnose behavior but do not become primary promotion evidence. LLM contribution is established on locked prospective decisions or a defensibly uncontaminated sample. |

### Adversarial test list

The following are permanent test fixtures, run in CI against the Analyst pipeline:

- Prompt injection embedded in filing text, press releases, and feed items.
- Fake or unresolvable citations.
- Data exfiltration requests inside source content.
- Malformed, truncated, or oversized documents.
- Contradictory packets (current versus prior filing disagree).
- Unsupported claims not traceable to any packet fact.
- Attempts to emit fields outside the schema (account, size, order type).
- Provider returning a different model ID than the one pinned.

## 7. Financial picture and compliance layer

The goal is to constrain the sleeve against the household without turning Black Gold into a household optimizer or exposing totals to the LLM.

Schema-validated local configuration covers:

- Exactly one sleeve account.
- Other brokerage, IRA, 401(k), and cash accounts with their source and staleness.
- Known near-term liquidity needs.
- Coarse asset-class, sector, style, size, and theme exposure.
- Career and income sensitivity as conservative flags rather than a fake dollar valuation.
- Restricted securities, underlyings, themes, industries, both-sign economic mappings, ETFs, and dated blackout windows.
- Source date, coverage, uncertainty, and next required refresh.

Household dollar values and broker tokens are encrypted or excluded from git, logs, off-device reports, and model prompts. Position sizing dollars are computed only in code from sleeve state.

### Professional-information firewall

Matt's ISA role creates a material nonpublic information exposure. The firewall is structural:

- Public sources are explicitly allowlisted. Workplace connectors and paths do not exist in the application. There is no code path to ISA email, SharePoint, Teams, calendars, meeting notes, or internal briefs.
- First-order names and themes linked to Matt's professional exposure (soybean, biofuel, ag-input, and related names) default to no new sleeve exposure. They are not "hedged" with politically or reputationally sensitive opposite positions.
- Restricted-name and theme additions take effect immediately.
- Removals or relaxations require a logged owner action, a reason, an approved compliance policy, and a configurable cooling period before trading eligibility.
- Unknown ETF look-through, unknown factor classification, an active blackout, or a stale financial picture blocks new risk.
- An audit records restriction version and hash and rule result without sending sensitive rationale to the LLM.

### Cooling periods

| Change | Effect timing |
|---|---|
| Add a restricted name or theme | Immediate |
| Tighten a blackout window | Immediate |
| Remove a restricted name or theme | Logged owner action plus configurable cooling period (default proposed: 30 calendar days) before eligibility |
| Relax a theme restriction | Same as removal |
| Raise any risk cap in `risk.yaml` | New approved `risk.yaml` version; takes effect at next session start, never intraday |
| Lower any risk cap | Immediate |

Schwab and CSV imports for other accounts exist only as read-only inputs. Black Gold never trades, rebalances, tax-loss harvests, or places protective orders in those accounts. Reports state the limits of cross-account tax and exposure coverage.

## 8. Deterministic portfolio construction and risk engine

Candidate score, portfolio target, compliance verdict, risk verdict, and order intent are five separate objects. They are never combined in an LLM-generated proposal.

### `risk.yaml` required coverage

Matt must approve `risk.yaml` before Phase 1 implementation. It must cover:

- Sleeve cap as a percentage of liquid investable household assets.
- Allowed instruments, directions, sessions, and order types.
- Maximum single-stock and ETF weight.
- Per-position initial risk budget based on approved exit and stop logic.
- Maximum open positions and new positions per session.
- Sector, theme, factor, and correlated-cluster caps.
- Gross and net exposure and minimum cash.
- Volatility target or scaling rule.
- ADV participation, price, spread, and liquidity thresholds.
- Maximum order notional and quantity and turnover.
- Earnings and event blackout policy.
- PDT prevention where applicable.
- Stale, abnormal, and cross-source price rules.
- Daily loss and drawdown states.
- Financial-picture, data, model, broker-auth, and restriction staleness.
- Thesis expiry and deterministic exit behavior.

### Proposed starting risk budget

These are engineering defaults for discussion. They are not personalized investment advice and must be explicitly approved or replaced by Matt before any paper or live mode.

| Limit | Proposed default |
|---|---|
| Sleeve size | At most 5% of liquid investable household assets |
| Leverage | None; cash-funded only |
| Single-stock weight | At most 5% of sleeve NAV |
| Single ETF weight | At most 20% of sleeve NAV |
| Per-position initial loss budget | At most 0.35% of sleeve NAV, measured from entry to approved stop distance |
| Sector exposure | At most 20% of sleeve NAV |
| Daily new risk | Capped; sum of initial loss budgets opened in one session may not exceed a configured fraction of sleeve NAV |
| Daily loss halt | `HALT_NEW_RISK` at a configurable daily loss |
| Drawdown halt | `HALT_NEW_RISK` at 8 to 10% sleeve drawdown from high-water mark |

`PortfolioConstructor` uses only approved rules: sleeve NAV, current positions and cash, signal strength as defined by the Alpha Charter, covariance or correlation estimate, volatility, liquidity, turnover, constraints, and approved stop or exit distance. It never uses free-form LLM conviction.

`ComplianceEngine` and `RiskEngine` are deterministic collections of pure rules with reason codes, plus stateful limit tracking where necessary. Equivalent final guards run again inside the broker gateway.

### Halt semantics

| State | Behavior |
|---|---|
| `NORMAL` | All approved actions allowed within limits. |
| `HALT_NEW_RISK` | Reject entries and increases; cancel unfilled entry orders; preserve protective exits; continue reconciliation. Requires manual re-arm. |
| `HOLD_ONLY` | No new risk; only approved reductions and exits and protection maintenance. |
| `EMERGENCY_FLATTEN_AUTHORIZED` | Separately authenticated and manual by default, with an explicit order plan and acknowledgement of slippage and gap risk. |

A daily loss, drawdown, stale critical input, expired authorization, unknown broker state, or severe incident must never silently trigger unrestricted market liquidation. The default is halt or hold, notify, reconcile, and require manual re-arm unless Matt has separately approved a narrow deterministic emergency rule.

Broker stops and brackets are one layer, not a guarantee. Gap, halt, extended-hours, rejected-order, partial-fill, corporate-action, and stop-slippage residual risk is documented in `docs/THREAT_MODEL.md`. No leverage and conservative size are the primary controls.

## 9. Broker architecture and account isolation

Interfaces are provider-neutral; only adapters justified by the current phase are built.

### Process separation

| Process | Compose service | Holds | Does |
|---|---|---|---|
| `blackgold-core` | `core` | No live trading credential | Research, strategies, portfolio, compliance and risk, approvals, reporting, reconciliation orchestration |
| `blackgold-broker-gateway` | `gateway` | The broker trading credential only | Accepts a signed, authorized `OrderIntent`; revalidates mode, authorization, strategy version, account hash, instrument, side, quantity or notional, price freshness, and all hard caps; then calls allowlisted trading endpoints |

Non-sleeve reads use a separate interface with no mutation methods. If the provider token technically has broader power than the sleeve, the residual blast radius is documented; code separation is not broker-enforced permission.

The gateway has no generic HTTP proxy and no endpoint that accepts an arbitrary broker path or raw order JSON. Every `OrderIntent` carries an explicit sleeve account identifier supplied by trusted code; the gateway never infers it and rejects any intent whose identifier does not match the single registered `blackgold_sleeve` account.

### Capability register before implementation

Before any broker adapter is written, verify from current official Schwab and Alpaca documentation and safe non-live probes:

- OAuth flow, access and refresh lifetime, and whether refresh behavior is fixed or rolling.
- Consent and account-selection behavior and exactly which accounts and scopes the credential can access or mutate.
- Account-number and hash handling.
- Order preview and validation availability.
- Native parent/child, OCO, bracket, GTC, stop, stop-limit, fractional, option, and extended-hours behavior.
- Partial-fill and child-quantity behavior.
- Client order IDs and idempotency support.
- Rate limits, headers, retry guidance, streaming and event support, entitlements, and market-data venue and coverage.
- Paper or sandbox availability and deviations from live.
- Token revocation, reauthorization, and outage behavior.

Endpoint paths, JSON shapes, token durations, rate numbers, and protective-order semantics are not asserted until verified. The results go into `docs/schwab-api-capabilities.md` and `docs/alpaca-api-capabilities.md` with official citations, accessed dates, probes, sanitized evidence, and unresolved blockers. All Schwab claims are UNVERIFIED as of 2026-09-06 because the developer portal returned HTTP 403 to unauthenticated fetch. Alpaca paper trading is verified to not simulate market impact, information leakage, latency slippage, queue position for non-marketable limits, price improvement, regulatory fees, or dividends; the internal fill model must supply those. No live order is allowed during capability discovery.

`RobinhoodAgenticAdapter` is deferred. A clean interface is preserved but no Robinhood code is written unless Matt later requests it.

## 10. Durable order lifecycle

Orders use a persisted, event-sourced state machine. The state list is at minimum: `CREATED`, `VALIDATED`, `AWAITING_APPROVAL`, `APPROVED`, `SUBMITTING`, `UNKNOWN`, `ACKNOWLEDGED`, `PARTIALLY_FILLED`, `FILLED`, `PROTECTION_PENDING`, `PROTECTED`, `PROTECTION_FAILED`, `CANCEL_PENDING`, `CANCELED`, `REJECTED`, `EXIT_PENDING`, and `CLOSED`.

```text
CREATED -> VALIDATED -> AWAITING_APPROVAL -> APPROVED -> SUBMITTING
SUBMITTING -> ACKNOWLEDGED | REJECTED | UNKNOWN
ACKNOWLEDGED -> PARTIALLY_FILLED | FILLED | CANCEL_PENDING
FILLED/PARTIALLY_FILLED -> PROTECTION_PENDING -> PROTECTED | PROTECTION_FAILED
CANCEL_PENDING -> CANCELED | FILLED | UNKNOWN
PROTECTED -> EXIT_PENDING -> CLOSED | UNKNOWN
```

This sketch is a starting point. Legal transitions and invariants are specified per broker adapter; where broker semantics require a different explicit state, that state is added rather than overloading an existing one.

### Invariants

- The validated intent, authorization reference, risk snapshot, quote timestamp and source, and deterministic client-order ID are persisted before the first external side effect.
- On timeout, connection loss, or 5xx after submission, the order is set to `UNKNOWN`; broker state and order history are queried by client ID or another safe correlation before any retry. Blind resubmission never happens.
- Processing is idempotent under duplicate jobs, webhooks and events, reconnects, and reboots.
- Partial fills, out-of-order events, cancel/replace races, price and quantity rounding, rejected legs, expired orders, exchange halts, market closure, and corporate actions are handled explicitly.
- Broker-native parent/child protection is submitted as one supported construct when available. Atomicity is not claimed unless the broker guarantees it. If a native bracket cannot be submitted safely, the entry is rejected rather than emulating protection only on the Pi.
- An entry is not `PROTECTED` until broker truth confirms protection covering the filled quantity. If safe protection cannot be established, new risk stops, an urgent notification fires, and a preapproved reduction or cancel playbook runs.
- Unexpected sleeve orders or positions, ledger divergence, or an uncorrelated fill trigger a halt. No "repair" ever touches another account.

### Reconciliation points

Reconciliation runs at each of these points and treats broker state as truth:

1. On startup.
2. Before any new order.
3. After each broker event.
4. Periodically during a session on a watchdog schedule.
5. Relative to the actual exchange close (from the exchange calendar, not wall-clock).
6. After close.

The state machine is tested with deterministic recorded fixtures and fault injection at every network boundary.

## 11. Performance, benchmarking, and tax honesty

A benchmark is defined before results exist. At minimum:

- VTI total return for a broad long-only U.S. equity mandate.
- An exposure-matched blend of the approved equity benchmark and Treasury-bill or cash return when the strategy holds material cash.
- SPY as a secondary familiar comparator, not necessarily the primary benchmark.
- Documented style, sector, and factor regressions or matched liquid ETF benchmarks when supported.
- DGTW-style characteristic matching only if point-in-time characteristic data are adequate; no "lightweight" imitation called equivalent.

Daily NAV is tracked from positions, cash, fills, fees, receivables, dividends and distributions, splits, and corporate actions, and reconciled against the broker. Alpaca paper results receive independent dividend and friction adjustments because its simulator does not model every live component.

Reports show gross and net results, turnover, spread and slippage assumptions and realized execution shortfall, tax-lot activity, and configurable after-tax scenarios. Household-wide wash-sale accuracy is not claimed unless all relevant owner and spousal accounts and substantially identical securities are covered. Black Gold never autonomously tax-loss harvests other accounts.

### Weekly and monthly report questions

Every weekly and monthly report answers:

1. Is the system healthy and authorized?
2. What does each registered strategy currently signal, and from which timestamped evidence?
3. What did the deterministic strategy decide before the runtime LLM?
4. What exactly did the runtime LLM add, remove, or change?
5. What compliance and risk rules fired?
6. What did Matt approve and what did the broker acknowledge or fill?
7. Are all sleeve positions reconciled and protected as expected?
8. How are `B0_PASSIVE`, `B1_DETERMINISTIC`, `C1_LLM_OVERLAY`, and `D1_LLM_ONLY_SHADOW` performing after costs, with uncertainty?
9. Is performance explained by beta, size, value, momentum, sector, concentration, cash timing, or residual return?
10. What would falsify or sunset the strategy?
11. What data, model, broker, restriction, token, authorization, backup, or financial-picture action is due?

A short noisy window is never phrased as proof of skill. A strategy is not mutated in reaction to recent underperformance outside a registered research cycle.

## 12. Reliability, security, and Pi/Umbrel requirements

Measurable budgets are in `docs/RESOURCE_BUDGET.md`. Threats and residual risks are in `docs/THREAT_MODEL.md`.

### Persistence and audit

- SQLite in WAL mode at `${APP_DATA_DIR}/data/blackgold.sqlite`, with migrations and a single-writer design. Raw artifacts live at `${APP_DATA_DIR}/data/artifacts/`.
- Fixed-point or decimal arithmetic for money, price, quantity, fees, and return aggregation where binary float could violate an invariant.
- Append-only event records with previous-event hashes; a daily root hash is sealed to an encrypted off-device backup. This is tamper-evident, not immutable, and is described that way.
- Runtime trades, account data, raw research, and logs stay out of git. Code, schemas, redacted examples, approved configuration templates, prompts, ADRs, Alpha Charters, and documentation are committed.
- The SQLite online-backup mechanism or a proven WAL-safe process is used, integrity checks run on schedule, and restore drills are performed quarterly.
- Retention, pruning, vacuum and checkpoint policy, and near-full-disk behavior are defined. Audit and order records are never deleted merely to free space.

### Scheduling and time

- An exchange calendar drives market sessions, holidays, and early closes. Market-relative jobs are expressed from the actual session schedule, not a fixed wall-clock cron.
- UTC internally; `America/Chicago` only for display and notifications.
- Clock drift is detected and new orders fail closed when timestamps are untrustworthy.
- Every job has a deterministic idempotency key, persisted attempt and status, deadline, retry policy, and missed-run alert.

### Secrets and network

- No secrets in source, images, prompts, logs, error telemetry, notifications, fixtures, or git history.
- Docker secrets or an encrypted local store with documented key custody. The threat model states candidly what remains exposed while the Pi runs unattended.
- Administrative interfaces bind locally or Umbrel-only; no public internet exposure by default. Authentication, CSRF protection, secure cookies, and authorization precede any state-changing web UI.
- Egress allowlisting for the model, broker, market-data, notification, and approved public-data hosts where practical.
- Dependencies and images pinned by lockfile and digest, an SBOM produced, dependencies and images scanned, and update and rollback documented. A live trading stack is never auto-updated without a tested rollback. GHCR manifests reference `vX.Y.Z` or `sha-<12hex>` tags, never `latest`.

### Failure scenarios that must be tested

Reboot and power loss, database lock and corruption, full disk, expired token, invalid refresh, DNS and network loss, broker/model/data 429 and 5xx, delayed, duplicate, and out-of-order messages, stale quotes, exchange closure, DST, early close, and notification failure. Risk and reconciliation must not depend on an LLM or on notification delivery.

## 13. Product experience

Reports, and the later read-only Umbrel dashboard on the provisional port `8479`, show:

- Mode and authorization status.
- System, data, model, and broker health and staleness.
- Current sleeve NAV, exposures, cash, positions, protection state, and risk budget.
- Each candidate's evidence, contrary evidence, uncertainty, falsifier, expiry, and provenance.
- Deterministic decision, LLM overlay effect, risk and compliance verdict, human approval, and broker result as distinct objects.
- Performance for each experiment arm versus its approved total-return benchmark, before and after costs and with uncertainty.
- Whether apparent performance came from beta, style or sector concentration, leverage, timing, or residual return.
- Rejected decisions and their counterfactual outcomes.
- Incidents, rule hits, cost consumption, missing jobs, and actions Matt must take.

They never show:

- Raw agent chatter or unedited model transcripts.
- Qualitative confidence presented as a precise probability, unless calibration has been prospectively measured.
- Household dollar totals, credentials, account hashes, or tax identifiers.
- Restricted-list rationale tied to Matt's professional exposure.
- Any control that places, modifies, or cancels an order. The dashboard is read-only; approvals happen through the separate authenticated approval service.

## 14. Deferred scope

The following are explicitly out of scope until a new, separate review. Clean interfaces may be preserved; no code is written.

| Item | Status |
|---|---|
| Options, shorting, margin, leverage | Deferred; excluded by the ten rules |
| Crypto, futures, OTC, extended hours | Deferred; excluded by the ten rules |
| `RobinhoodAgenticAdapter` | Deferred; interface only |
| Paid alternative data | Deferred |
| Skeptic and broader agent roster | Deferred until a registered ablation shows incremental value |
| Richer interactive dashboard | Deferred; first dashboard is read-only |
| Household tax-loss harvesting or rebalancing | Permanently out of scope |
| Broader automation beyond a single approved strategy version | Deferred; not assumed to be desirable |

## 15. Governing principles

- A modest, testable strategy is better than elaborate unverifiable intelligence.
- Better research does not automatically imply profitable trading.
- Backtests are evidence, not proof; avoiding backtests is not rigor.
- More agents do not create independent evidence.
- Complexity must earn its place through measured incremental value.
- Code owns every number and every hard boundary.
- No narrative, confidence label, model vote, or human convenience overrides a deterministic reject.
- Every decision and side effect must be attributable, reproducible, and reconcilable.
- The system must survive bad data, malicious text, model error, API failure, network loss, duplicate work, restart, power loss, and storage pressure.
- Capital preservation and avoidance of catastrophic or noncompliant action take priority over headline return.
- The appropriate result may be to keep Black Gold in research mode, remove the runtime LLM from the signal, use only a simple systematic strategy, or hold the passive benchmark.
