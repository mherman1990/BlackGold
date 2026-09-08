# Black Gold Discovery Pack

Prepared 2026-09-06. This is the deliverable required before any application code. Read this file first; it indexes everything else and ends with the decisions only Matt can make.

## Design in under 400 words

Black Gold is a self-hosted research, decision, and controlled-execution system for one ring-fenced investment sleeve, running as an Umbrel app on a Raspberry Pi 5. It exists to test two separable claims with evidence: that a versioned, deterministic systematic strategy adds after-cost, risk-adjusted value over a passive benchmark, and that a bounded runtime-LLM research layer adds measurable value on top of that strategy. Either claim failing is a valid product outcome.

Deterministic code owns everything numeric: timestamps, universes, candidate rules, portfolio construction, sizing, compliance, risk, account selection, order formation, order state, reconciliation, and performance. The runtime LLM, behind a provider adapter, receives sealed evidence packets built from point-in-time data and returns a schema-validated research assessment: evidence for and against, missing evidence, a thesis, the strongest dissent, falsifiers, an uncertainty label, and the option to abstain. It has no broker tools, sees no dollar totals or credentials, and its output never sets a size or forms an order.

Every decision timestamp records four synchronized arms: passive benchmark, deterministic strategy, deterministic plus the preregistered LLM feature, and LLM-only shadow. Experiments are registered before results are viewed; the holdout opens once; every trial is logged.

Data is point-in-time by construction. Each observation carries when it was observed, when it became public, its vintage, and its raw hash. Decisions may only read what was available at the decision time plus a processing delay. Macro series use vintages, SEC data uses acceptance timestamps, universes are date-effective snapshots, and current-constituent backtests cannot promote a stock strategy.

Execution is a persisted state machine with deterministic client order ids, an explicit unknown state, and reconciliation against broker truth before any retry. Exactly one account carries the sleeve role; every other account is reachable only through read-only types. Drawdowns and incidents halt new risk and preserve protective exits; automatic liquidation is never a default. Live trading requires a checklist plus an expiring authorization artifact bound to account hash, strategy versions, instruments, caps, and executable hash.

The build order is: repository foundation and safe simulations; point-in-time research kernel; one approved deterministic ETF strategy; a bounded LLM overlay with a locked ablation; household, compliance, and risk engines; prospective shadow and paper operations; a Schwab capability spike and gateway; human-approved micro-live; and, only by a separate later decision, strategy-specific limited automation.

## Pack contents

| # | Required item | Location | Status |
|---|---|---|---|
| 1 | Root `CLAUDE.md` and scoped rules | `CLAUDE.md`, `.claude/rules/{broker-gateway,temporal-data,umbrel-identity}.md` | Complete |
| 2 | Phase plan | `PLAN.md` | Complete |
| 3 | State | `STATE.md` | Complete |
| 4 | Handoff | `HANDOFF.md` | Complete |
| 5 | Decisions | `docs/DECISIONS.md` | Complete (25 proposed/accepted, 7 rejected) |
| 6 | Assumptions and gaps | `docs/ASSUMPTIONS_AND_GAPS.md` | Complete |
| 7 | Identity | `docs/IDENTITY.md` | Complete; port collision unverified |
| 8 | Repository and PR workflow | `docs/REPOSITORY_AND_PR_WORKFLOW.md` | Complete |
| 9 | Umbrel store and release | `docs/UMBREL_STORE_AND_RELEASE.md` | Complete; three Umbrel semantics unverified |
| 10 | Context provenance | `docs/CONTEXT_PROVENANCE.md` | Complete |
| 11 | Threat model | `docs/THREAT_MODEL.md` | Complete |
| 12 | Capability register and vendor registers | `docs/CAPABILITY_REGISTER.md`, `docs/capabilities/*.md` | Complete; Schwab entirely unverified |
| 13 | Data provenance spec | `docs/DATA_PROVENANCE_SPEC.md` | Complete |
| 14 | Experiment protocol | `docs/EXPERIMENT_PROTOCOL.md` | Complete |
| 15 | Draft Alpha Charters | `strategies/etf-trend-vol/`, `strategies/form4-insider-cluster/`, `strategies/filing-change-challenger/`, `strategies/README.md` | Drafts at Discovery; `etf-trend-vol` since signed/APPROVED (D-48, 2026-09-08), the other two remain drafts |
| 16 | Automation and live gates | `docs/AUTOMATION_AND_LIVE_GATES.md` | Complete |
| 17 | Resource budget | `docs/RESOURCE_BUDGET.md` | Proposed numbers pending Pi measurement |
| 18 | Repository tree and core interfaces | `docs/PROPOSED_REPOSITORY_TREE.md`, `docs/CORE_INTERFACES.md` | Proposal |
| 19 | Decision list | Below and `docs/DECISIONS.md` | Awaiting Matt |
| - | Full product specification | `docs/PRODUCT_SPEC.md` | Complete |

## What was verified, inferred, and recommended

- **Verified** from first-party sources today: Umbrel store schema, SEC fair access, FRED vintages, CFTC release timing, Alpaca paper omissions and order semantics, Anthropic batch window, Node LTS, Claude Code rules behaviour. Table in `docs/CAPABILITY_REGISTER.md`.
- **Inferred**: see `docs/ASSUMPTIONS_AND_GAPS.md`. The important ones: taxable Schwab sleeve, IEX-only free market data, `${APP_DATA_DIR}` semantics.
- **Recommended**: every D-xx row marked Proposed in `docs/DECISIONS.md`.
- **Unverified and blocking later phases**: all Schwab capabilities (portal requires login); Umbrel data-dir and manifest semantics (before Phase 0 manifests); ETF market data source (Phase 1).

## Blockers

1. `main` does not exist. Matt must create it from this branch's bootstrap commit or authorize Claude Code to (D-02).
2. Identifiers must be confirmed before any manifest is written (D-04), including a port check on the Pi.
3. Schwab capabilities cannot be verified without Matt's developer login; this blocks Phase 6, not Phase 0.

## Decisions for Matt

Each has a recommended default in `docs/DECISIONS.md`. Answer with the D-number.

| # | Question | Recommended default |
|---|---|---|
| D-02 | How should `main` be created? | Matt pushes the bootstrap commit as `main` |
| D-03 | One public repo with store inside, public GHCR image? | Yes |
| D-04 | Confirm store id `blackgold`, app id `blackgold-trading`, image `ghcr.io/mherman1990/blackgold`, port 8479 | Confirm after checking installed ports |
| D-06 | Branch protection, PR, merge, release authority as written? | Yes |
| D-08 | Long-only, unlevered, daily decisions, 5–60 day holding? | Yes |
| D-09 | Frozen liquid ETF universe first? | Yes |
| D-10 | First charter `etf-trend-vol`? | Yes |
| D-11 | Anthropic behind an adapter, Haiku/Sonnet tiering, pinned ids? | Yes |
| D-12 | Sleeve account: exists? taxable or IRA? which broker? | Taxable Schwab, dedicated |
| D-13 | Schwab consent scope and accepted blast radius | Sleeve-only if possible; otherwise no unattended automation until accepted in writing |
| D-14 | Restricted-theme seed and counsel review | Seed as written; counsel review before Phase 4 exit |
| D-15 | Risk budget and halt defaults | As written; halt not flatten |
| D-16 | Backup destination and Pi access | Second Pi or named bucket, age-encrypted; Matt-only access |
| D-17 | Notification and approval channel | ntfy or Pushover; approvals via signed local token |
| D-18 | Paper NAV and micro-live caps | Paper = intended real NAV; micro-live ≤$500/order, ≤$2,000 total |
| D-19 | Free-only data, with paid option before stock promotion? | Yes |
| D-20 | Household coverage and refresh cadence | Quarterly CSV; >120 days stale blocks new risk |
| D-21 | License | MIT |
| D-24 | ETF market data source | Alpaca free data (IEX-labelled) plus issuer distributions; re-evaluate before Phase 2 exit |
| D-25 | Alpaca paper for Phase 5? | Yes, with the internal fill/cost model |

Also confirm: Claude Code must not touch any other repository or app store (already enforced by the repository guard in `CLAUDE.md`).

## Stop

Nothing further is authorized. No application code, CI, manifests, images, broker calls, model calls, or Umbrel changes have been made.
