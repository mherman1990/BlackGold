# Decisions

ADR-style register. Status values: **Accepted** (Matt decided or a fixed constraint), **Proposed** (Claude Code recommends a default; Matt must accept, replace, or reject), **Rejected**. A Proposed decision blocks the phase named in "Blocks" until resolved. Numbers are stable; never renumber.

| # | Decision | Status | Blocks |
|---|---|---|---|
| D-01 | Product name is Black Gold | Accepted | - |
| D-02 | Repository is `mherman1990/BlackGold`; `main` bootstrapped from the Discovery branch's first commit | Accepted (repo) / Proposed (bootstrap) | Phase 0 |
| D-03 | One public repository holding source and store; public GHCR package | Proposed | Phase 0 |
| D-04 | Umbrel identifiers per `docs/IDENTITY.md` | Proposed | Phase 0 |
| D-05 | Discovery lives on `claude/black-gold-trading-tool-n713ly` | Accepted | - |
| D-06 | Branch protection, PR, merge, and release authority per `docs/REPOSITORY_AND_PR_WORKFLOW.md` | Proposed | Phase 0 |
| D-07 | Node.js 24 LTS, TypeScript, SQLite WAL, ARM64+AMD64 containers | Accepted | - |
| D-08 | Mandate: long-only, unlevered, daily decisions, 5–60 trading-day holding | Proposed | Phase 2 |
| D-09 | Initial universe: frozen list of highly liquid ETFs | Proposed | Phase 1 |
| D-10 | First Alpha Charter to implement: `etf-trend-vol` | Proposed | Phase 2 |
| D-11 | Runtime LLM: Anthropic behind `ModelAdapter`, tiered Haiku/Sonnet/Opus, pinned IDs in config | Proposed | Phase 3 |
| D-12 | Sleeve is a dedicated taxable Schwab account | Proposed | Phase 4 (tax model), Phase 6 |
| D-13 | Schwab consent scope and accepted credential blast radius | Proposed (needs Matt) | Phase 6, Phase 7 |
| D-14 | Restricted-theme seed and compliance/counsel process | Proposed | Phase 4 |
| D-15 | Starting risk budget and halt behavior | Proposed | Phase 4 |
| D-16 | Backup destination and Pi access policy | Proposed | Phase 0 |
| D-17 | Notification and approval channel | Proposed | Phase 5 |
| D-18 | Paper capital and micro-live capital | Proposed | Phase 5, Phase 7 |
| D-19 | Data budget: free sources only for the ETF track; paid point-in-time data considered before stock promotion | Proposed | Phase 2 (stock track) |
| D-20 | Household-account coverage and refresh cadence | Proposed | Phase 4 |
| D-21 | Source license | Proposed | Phase 0 |
| D-22 | Anthropic Message Batches only for non-time-critical work | Accepted (engineering, verified 24 h window) | - |
| D-23 | Automatic flatten is never a default response | Accepted (from spec) | - |
| D-24 | Market data source for the ETF track | Proposed | Phase 1 |
| D-25 | Alpaca paper is the Phase 5 paper broker | Proposed | Phase 5 |
| R-01 | Postgres / Kafka / Kubernetes / vector DB | Rejected | - |
| R-02 | Local LLM on the Pi | Rejected | - |
| R-03 | Multi-agent committee (Scout/Analyst/Adjudicator) at MVP | Rejected | - |
| R-04 | Robinhood adapter now | Rejected (deferred) | - |
| R-05 | Building inside an existing ISA or multi-app repository | Rejected | - |
| R-06 | "Lightweight DGTW" benchmark | Rejected | - |
| R-07 | Wall-clock cron for market jobs | Rejected | - |

---

## D-01 Product name is Black Gold

**Status:** Accepted, 2026-09-06.
**Context:** The source prompt named the product Tiller. Matt instructed a rebrand to Black Gold (Iowa's black soil; oil; riches).
**Decision:** All identifiers, documents, and future code use Black Gold / `blackgold`. The prior name appears only in `docs/CONTEXT_PROVENANCE.md` and here.

## D-02 Repository and `main` bootstrap

**Status:** Repository accepted (Matt created `mherman1990/BlackGold`). Bootstrap method proposed.
**Context:** The remote is empty; no `main` exists. Claude Code must not push to a branch other than its assigned one.
**Decision (proposed):** The Discovery branch's root commit contains only `README.md` and `.gitignore`. Matt creates `main` from that commit (`git push origin <root-sha>:refs/heads/main`), sets it as default, enables protection, and opens the Discovery PR. See `docs/REPOSITORY_AND_PR_WORKFLOW.md`.
**Alternative:** Matt authorizes Claude Code to push the bootstrap commit to `main`.

## D-03 Topology and visibility

**Status:** Proposed.
**Recommendation:** One public repository containing source and the one-app store; public GHCR package.
**Tradeoff:** Simplest release path; umbrelOS can add the store by URL and pull anonymously. Source is visible, but the image would be inspectable in any case. Private source requires a second store repository and cross-repo release coordination.

## D-04 Umbrel identifiers

**Status:** Proposed. Confirm before the first Umbrel install and treat as immutable after.
**Values:** store id `blackgold`, store name Black Gold, app id `blackgold-trading`, image `ghcr.io/mherman1990/blackgold`, port `8479`, services `core`/`gateway`, data under `${APP_DATA_DIR}`. Full table and collision audit in `docs/IDENTITY.md`. Port collision against Matt's installed apps is unverified.

## D-05 Discovery branch

**Status:** Accepted (imposed by the session assignment).
**Decision:** `claude/black-gold-trading-tool-n713ly` is the Discovery branch instead of `claude/phase-00-discovery`. Future phases follow `claude/phase-XX-short-name`.

## D-06 Authority

**Status:** Proposed.
**Recommendation:** No direct pushes to `main`; owner approval plus green CI required; Claude Code never merges its own PR; releases only from an explicit `v*` tag after merge; GitHub App, workflows, and secrets are separately authorized. Full matrix in `docs/REPOSITORY_AND_PR_WORKFLOW.md`.

## D-07 Runtime

**Status:** Accepted (fixed constraint; LTS resolved 2026-09-06).
**Decision:** Node.js 24 "Krypton" (Active LTS), TypeScript strict, SQLite WAL single-writer via `better-sqlite3` or `node:sqlite` (choose in Phase 0 after ARM64 build test), decimal arithmetic library for money, `zod` for schemas. Pin exact versions in lockfile.

## D-08 Strategy mandate

**Status:** Proposed.
**Recommendation:** Long-only, unlevered, U.S.-listed ETFs then equities; decisions at most daily after the close; expected holding 5–60 trading days; no intraday.
**Tradeoff:** Slower turnover gives fewer observations but fits free-data latency, Pi reliability, and taxes. Intraday is incompatible with this architecture.

## D-09 Initial universe

**Status:** Proposed.
**Recommendation:** Frozen list of roughly 12 highly liquid broad/style/sector ETFs plus a T-bill ETF cash proxy (see `strategies/etf-trend-vol/ALPHA_CHARTER.md`). Stock universe research proceeds only after point-in-time membership and delisting coverage exist.
**Tradeoff:** Survivorship-safe and cheap but leaves little room for filing-based analysis until the stock track opens.

## D-10 First Alpha Charter

**Status:** Proposed.
**Recommendation:** `etf-trend-vol` first (validates the platform on survivorship-safe data), `form4-insider-cluster` second, `filing-change-challenger` only as a C1 experiment after Phase 3. Each charter is a draft until Matt approves it; approval freezes parameters.

## D-11 Runtime LLM provider

**Status:** Proposed. Not inferred from Claude Code being the builder.
**Criteria:** structured-output reliability with strict schemas, quality on filing-extraction tasks, latency under a synchronous post-close deadline, data-handling terms, current API support for prompt caching, and measured cost.
**Recommendation:** Anthropic via a `ModelAdapter`. Tiering: Haiku 4.5 for extraction/triage of sealed packets, Sonnet 5 for `ResearchAssessment` synthesis, Opus 5 only inside a registered experiment that must justify its cost. Prompt caching on the stable system prompt and ontology. Batches only for non-time-critical replay and reporting (D-22). Model IDs resolved from the provider's Models API at configuration time and pinned per strategy version; a silent fallback is prohibited. See `docs/capabilities/model-provider-capabilities.md`.
**Why Anthropic and not "because Claude Code":** it matches Matt's existing tiering practice, has first-party structured outputs, and its batch and caching behavior are verifiable. A second provider adapter is a Phase 3 stretch only if an ablation needs it.

## D-12 Sleeve account

**Status:** Proposed. Matt must state whether the account is open and whether it is taxable or an IRA.
**Recommendation:** Dedicated taxable Schwab account; track tax lots, estimated tax drag, and wash-sale uncertainty. An IRA changes tax, withdrawal, and household-allocation modelling and must be decided before Phase 4 tax modelling.

## D-13 Schwab consent and blast radius

**Status:** Proposed; blocking for Phases 6–7.
**Recommendation:** Link only the sleeve if Schwab's current consent flow allows account selection; import other holdings read-only by CSV. If the token necessarily reaches all household accounts, application-level controls reduce but do not remove credential-compromise risk, and unattended automation stays blocked until Matt explicitly accepts that residual risk in writing here. All Schwab capabilities are currently UNVERIFIED (portal returns 403 unauthenticated).

## D-14 Restricted-theme seed and compliance process

**Status:** Proposed.
**Seed (from Matt's role, not from any external list):** no new sleeve exposure to first-order soybean/biofuel/renewable-diesel/ethanol/ag-input/crop-protection/grain-merchandising names or ETFs concentrated in them; no exposure to companies Matt has met with in an ISA capacity in the past N days (N configurable, default 90); no positions taken during dated blackout windows Matt declares around policy events. Additions apply immediately; removals require a logged owner action, reason, and a 30-day cooling period.
**Process:** Short counsel review of the standing list and the add/remove policy before Phase 4 exit. Public-source allowlist only; no workplace connector exists in code.

## D-15 Risk budget and halt behavior

**Status:** Proposed. Engineering defaults, not advice.
**Starting proposal:** sleeve ≤5% of liquid investable assets; no leverage; single-stock ≤5% of sleeve NAV; single ETF ≤20%; per-position initial loss budget ≤0.35% of sleeve NAV; sector ≤20%; max 3 new positions per session; daily new-risk cap 1% of NAV; `HALT_NEW_RISK` at 2% daily loss or 8% peak-to-trough drawdown; `HOLD_ONLY` at 10%; manual re-arm required. Automatic flatten never (D-23). Full `risk.yaml` coverage list in `docs/PRODUCT_SPEC.md`.

## D-16 Backups and Pi access

**Status:** Proposed.
**Recommendation:** SQLite online backup nightly to `${APP_DATA_DIR}/backups/` (7 daily, 4 weekly), plus an age-encrypted copy pushed to a second Pi on Matt's fleet or a personal cloud bucket Matt names. Daily ledger seal hash included. Only Matt has SSH/umbrelOS access to the Pi; no shared accounts. Quarterly restore drill.

## D-17 Notification and approval channel

**Status:** Proposed.
**Recommendation:** Notifications via a self-hosted ntfy topic or Pushover (Matt's choice); approvals in Phase 7 via the local read-only web page plus a signed approval token, never via chat message parsing. No notification carries dollar totals or credentials.

## D-18 Paper and micro-live capital

**Status:** Proposed.
**Recommendation:** Paper NAV set equal to the intended real sleeve NAV so sizing is realistic. Micro-live starts at ≤$500 per order and ≤$2,000 total exposure for execution calibration only.

## D-19 Data budget

**Status:** Proposed.
**Recommendation:** Free sources only for the ETF track and all prospective collection. Before any stock-strategy promotion, evaluate a small paid budget (order of $30–100/month) for point-in-time constituents, delistings, and corporate actions if free coverage is inadequate. Reliable data likely has higher expected value than more LLM calls.

## D-20 Household coverage

**Status:** Proposed.
**Recommendation:** Quarterly CSV import of other accounts (brokerage, IRA, 401(k), cash) with coarse asset-class/sector/style exposures; staleness > 120 days blocks new risk. Career/income sensitivity recorded as conservative flags, never a dollar value. Dollar totals never leave the local config and never reach a model.

## D-21 License

**Status:** Proposed.
**Recommendation:** MIT for the source repository. It is permissive, compatible with a public Umbrel store, and imposes no obligation on Matt. Alternative: no license (all rights reserved), which still allows a public repository but discourages reuse. Add `LICENSE` in Phase 0 once decided.

## D-22 Batch API use

**Status:** Accepted (engineering).
**Fact (verified 2026-09-06):** Anthropic documents that most batches finish within an hour but results may take up to 24 hours and batches expire at 24 hours. **Decision:** Batches are used only for historical replay, reporting prose, and evaluation. Post-close decisions use synchronous calls with a deadline and abstain on timeout.

## D-23 Automatic flatten

**Status:** Accepted (from specification).
**Decision:** Drawdown, data, auth, model, or broker incidents default to `HALT_NEW_RISK` or `HOLD_ONLY`. `EMERGENCY_FLATTEN_AUTHORIZED` requires a separately authenticated manual command with an explicit order plan.

## D-24 Market data source for the ETF track

**Status:** Proposed.
**Options:** (a) Alpaca Market Data free tier (IEX-only, must not be labelled NBBO; adequate for daily bars on liquid ETFs) with issuer distribution data for total-return adjustment; (b) Stooq/Yahoo-style free daily bars (ToS and reliability concerns; not recommended for anything beyond exploratory); (c) a small paid EOD provider with consolidated bars, splits, and dividends.
**Recommendation:** Start with (a) for daily bars plus issuer-published distributions, record the venue entitlement on every bar, and re-evaluate (c) before Phase 2 exit if data-quality rules fire.

## D-25 Alpaca paper broker

**Status:** Proposed.
**Recommendation:** Use Alpaca paper in Phase 5 behind the `BrokerAdapter` interface, paired with Black Gold's own conservative fill/cost model, because Alpaca documents that paper omits market impact, leakage, latency slippage, queue position, price improvement, regulatory fees, and dividends. Paper results are never presented without the internal model's adjustments.

---

## Rejected

- **R-01** Postgres/Kafka/Kubernetes/vector DB: no measured need; violates the one-owner maintainability constraint.
- **R-02** Local LLM on the Pi: fixed constraint; RAM and thermal budget do not permit it.
- **R-03** Named multi-agent committee at MVP: agreement among models sharing data is not independent evidence. One bounded Analyst; a Skeptic must win an ablation.
- **R-04** Robinhood adapter: deferred until Matt requests it; interface kept clean.
- **R-05** Placing Black Gold in an existing repository: a live-trading system must not share release tags, CI, or history with unrelated apps.
- **R-06** "Lightweight DGTW": false precision without point-in-time characteristic data. Use VTI total return and exposure-matched blends.
- **R-07** Wall-clock cron for market jobs: holidays, early closes, and DST make `14:45 CT` unreliable. Use an exchange calendar and UTC.
