# Decisions

> 2026-09-06: Matt authorized adoption of every recommended default in this file, plus creation of `main`, the Discovery PR, and Phase 0 implementation. Items whose default depends on a fact only Matt knows are marked "Accepted default" with the open fact named.

ADR-style register. Status values: **Accepted** (Matt decided or a fixed constraint), **Proposed** (Claude Code recommends a default; Matt must accept, replace, or reject), **Rejected**. A Proposed decision blocks the phase named in "Blocks" until resolved. Numbers are stable; never renumber.

| # | Decision | Status | Blocks |
|---|---|---|---|
| D-01 | Product name is Black Gold | Accepted | - |
| D-02 | Repository is `mherman1990/BlackGold`; `main` bootstrapped from the Discovery branch's first commit | Accepted (repo and bootstrap; `main` created from e7fc3d9 on 2026-09-06) | Phase 0 |
| D-03 | One public repository holding source and store; public GHCR package | Accepted 2026-09-06 | Phase 0 |
| D-04 | Umbrel identifiers per `docs/IDENTITY.md` | Accepted 2026-09-06 (port check before install remains) | Phase 0 |
| D-05 | Discovery lives on `claude/black-gold-trading-tool-n713ly` | Accepted | - |
| D-06 | Branch protection, PR, merge, and release authority per `docs/REPOSITORY_AND_PR_WORKFLOW.md` | Accepted 2026-09-06 (branch protection settings pending Matt in GitHub UI) | Phase 0 |
| D-07 | Node.js 24 LTS, TypeScript, SQLite WAL, ARM64+AMD64 containers | Accepted | - |
| D-08 | Mandate: long-only, unlevered, daily decisions, 5–60 trading-day holding | Accepted 2026-09-06 | Phase 2 |
| D-09 | Initial universe: frozen list of highly liquid ETFs | Accepted 2026-09-06 | Phase 1 |
| D-10 | First Alpha Charter to implement: `etf-trend-vol` | Accepted 2026-09-06 | Phase 2 |
| D-11 | Runtime LLM: Anthropic behind `ModelAdapter`, tiered Haiku/Sonnet/Opus, pinned IDs in config | Accepted 2026-09-06 | Phase 3 |
| D-12 | Sleeve is a dedicated taxable Schwab account | Accepted default 2026-09-06; open fact: account existence | Phase 4 (tax model), Phase 6 |
| D-13 | Schwab consent scope and accepted credential blast radius | Accepted default 2026-09-06; written blast-radius acceptance still required in Phase 6 | Phase 6, Phase 7 |
| D-14 | Restricted-theme seed and compliance/counsel process | Accepted seed 2026-09-06; counsel review pending | Phase 4 |
| D-15 | Starting risk budget and halt behavior | Accepted 2026-09-06 | Phase 4 |
| D-16 | Backup destination and Pi access policy | Accepted default 2026-09-06; open fact: destination host | Phase 0 |
| D-17 | Notification and approval channel | Accepted 2026-09-06 (ntfy) | Phase 5 |
| D-18 | Paper capital and micro-live capital | Accepted 2026-09-06 | Phase 5, Phase 7 |
| D-19 | Data budget: free sources only for the ETF track; paid point-in-time data considered before stock promotion | Accepted 2026-09-06 | Phase 2 (stock track) |
| D-20 | Household-account coverage and refresh cadence | Accepted 2026-09-06 | Phase 4 |
| D-21 | Source license | Accepted 2026-09-06 (MIT) | Phase 0 |
| D-22 | Anthropic Message Batches only for non-time-critical work | Accepted (engineering, verified 24 h window) | - |
| D-23 | Automatic flatten is never a default response | Accepted (from spec) | - |
| D-24 | Market data source for the ETF track | Accepted 2026-09-06 | Phase 1 |
| D-25 | Alpaca paper is the Phase 5 paper broker | Accepted 2026-09-06 | Phase 5 |
| D-26 | Phase 0 implementation proceeds as a stacked PR on the Discovery branch | Accepted 2026-09-06 | - |
| D-27 | SQLite binding is `node:sqlite`; online backup via `VACUUM INTO` | Accepted 2026-09-06 | - |
| D-28 | Phase 1 authorized by Matt's "keep going" (2026-09-07); implemented as a stacked PR on the Phase 0 branch | Accepted 2026-09-07 | - |
| D-29 | Market data: fetch raw Alpaca IEX daily bars and compute all adjustments in Black Gold code; corporate actions for the ETF universe vendored as observations until an issuer/vendor feed is verified | Accepted 2026-09-07 (engineering) | Phase 2 |
| D-30 | Data provenance defaults adopted: processing delays (15 min EDGAR/market, 60 min macro, 24 h batch), storage budgets (spec section 9), 13F research-context only, AVAILABLE_AT_ESTIMATED defaults | Accepted 2026-09-07 (covered by the 2026-09-06 blanket acceptance of recommended defaults) | - |
| D-31 | CFTC COT availability uses a by-rule U.S. federal holiday calendar (CR-27), not the NYSE calendar; entity map is bitemporal (`knownFrom`/`closeKnownFrom`); migration `0006_entity_symbols` amended in place because it had never run outside test databases | Accepted 2026-09-07 (engineering, from PR #3 review) | - |
| D-32 | Book-slot conflict between the charter's entry rule and its hysteresis hold rule resolves in favour of the incumbent; the correlated-cluster cap stays strictly rank-ordered | Accepted 2026-09-07 (engineering, provisional) | **Owner confirmation required before the charter is frozen** |
| D-33 | An entity priced behind the rest of the cross-section at a decision is excluded from that decision entirely (`STALE_ANCHOR`), rather than ranked on its last good bar | Accepted 2026-09-07 (engineering) | - |
| D-34 | `charter.yaml` is the only form the code executes, and `assertRegistrable` refuses to freeze an experiment on an unsigned charter, an unresolved open decision, or an undecided conditional universe member | Accepted 2026-09-07 (engineering) | - |
| D-35 | Phase 2 authorized by Matt's "keep building out" (2026-09-07); built as machinery plus fixture tests only. No registered experiment, no historical result, and no holdout access, because the charter is DRAFT and no source data has been ingested | Accepted 2026-09-07 | Owner approves the charter, then the same code produces the evidence |
| D-36 | A stacked PR is retargeted to `main` before it is merged, or merged before its base goes in. Merging into an already-merged-forward base leaves `main` a phase behind; the remedy is a merge commit bringing `main` in plus a fresh PR, never a force-push | Accepted 2026-09-07 (engineering) | - |
| D-37 | Claude Code has standing authorization for the whole git and GitHub mechanic, including merging its own PRs to `main` and tagging releases. Charter approval, holdout opening, promotion-evidence claims, and anything live remain the owner's alone | Accepted 2026-09-07 by Matt | Supersedes the per-action authorization rule in the original git protocol |
| D-38 | `release.yml` also accepts `workflow_dispatch` with a version, and creates the `v<version>` tag itself after checks pass. Claude Code releases through that instead of a tag push, because GitHub refuses its credential any tag ref | Accepted 2026-09-07 by Matt, who asked for the capability directly | Makes D-37's tagging grant actually usable; narrower than a general tag-ref permission |
| D-39 | The `etf-trend-vol` charter's four open decisions resolved and the XLE condition settled: look-through applies and XLE is excluded (12-ETF risk universe), BIL is the cash instrument, `risk.yaml` defaults approved as written with ADV participation at 1%, and Alpaca free/IEX approved as the market-data source | Accepted 2026-09-07 by Matt | Removes four of the nine blockers on charter registration; the approval block remains unsigned and is his alone |
| D-40 | Granary (separate product `mherman1990/Granary`) owns the household / personal-finance / capital-allocation layer and sits above Black Gold in the hierarchy, reading Black Gold data read-only. Black Gold takes no dependency on Granary and stops growing an in-house household planner | **Proposed** 2026-09-07 by Claude Code | Phase 4 (household scope) |
| D-41 | Phase 3 authorized (Matt, 2026-09-07, ordering "2 → 1 → 3"). Built as the provider-agnostic analyst pipeline and its safety surface, tested with a deterministic stub; the real Anthropic adapter, the POST egress change, and live CR-11/12/13 re-verification are a separate follow-up PR needing an API key | Accepted 2026-09-07 by Matt | Provider wiring, call/budget persistence, and prospective C1/D1 backtest wiring remain (credentials / Phase 5) |
| D-42 | The Anthropic model adapter (raw `fetch`, no SDK) as its own PR: a second egress module `packages/core/src/model/provider-http.ts` is the only outbound POST and the only reference to `api.anthropic.com`; `live-disabled.test.ts` is updated to allow exactly that while trading hosts stay forbidden and `data/http.ts` stays POST-free. The key is passed in from the environment, never in git, code, or the image | Accepted 2026-09-07 by Matt ("keep building… put the key in when things are connected") | Live CR-12/CR-13 verification against the real API is Matt's one run on the Pi; call/budget persistence and C1/D1 wiring still Phase 5 |
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

**Status:** Accepted. Matt created the repository; on 2026-09-06 Matt authorized the bootstrap and `main` was created from commit e7fc3d9 (README + .gitignore). Default-branch and protection settings remain for Matt in the GitHub UI.
**Context:** The remote is empty; no `main` exists. Claude Code must not push to a branch other than its assigned one.
**Decision (proposed):** The Discovery branch's root commit contains only `README.md` and `.gitignore`. Matt creates `main` from that commit (`git push origin <root-sha>:refs/heads/main`), sets it as default, enables protection, and opens the Discovery PR. See `docs/REPOSITORY_AND_PR_WORKFLOW.md`.
**Alternative:** Matt authorizes Claude Code to push the bootstrap commit to `main`.

## D-03 Topology and visibility

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** One public repository containing source and the one-app store; public GHCR package.
**Tradeoff:** Simplest release path; umbrelOS can add the store by URL and pull anonymously. Source is visible, but the image would be inspectable in any case. Private source requires a second store repository and cross-repo release coordination.

## D-04 Umbrel identifiers

**Status:** Accepted 2026-09-06. Matt adopted the recommended identifiers. The port-collision check against installed apps still runs before the first Umbrel install; if 8479 collides, the port (only) changes via a new decision.
**Values:** store id `blackgold`, store name Black Gold, app id `blackgold-trading`, image `ghcr.io/mherman1990/blackgold`, port `8479`, services `core`/`gateway`, data under `${APP_DATA_DIR}`. Full table and collision audit in `docs/IDENTITY.md`. Port collision against Matt's installed apps is unverified.

## D-05 Discovery branch

**Status:** Accepted (imposed by the session assignment).
**Decision:** `claude/black-gold-trading-tool-n713ly` is the Discovery branch instead of `claude/phase-00-discovery`. Future phases follow `claude/phase-XX-short-name`.

## D-06 Authority

**Status:** Accepted 2026-09-06. Branch protection and default-branch settings must be applied by Matt in GitHub settings; no tool in the Claude Code session reaches that API.
**Recommendation:** No direct pushes to `main`; owner approval plus green CI required; Claude Code never merges its own PR; releases only from an explicit `v*` tag after merge; GitHub App, workflows, and secrets are separately authorized. Full matrix in `docs/REPOSITORY_AND_PR_WORKFLOW.md`.

## D-07 Runtime

**Status:** Accepted (fixed constraint; LTS resolved 2026-09-06).
**Decision:** Node.js 24 "Krypton" (Active LTS), TypeScript strict, SQLite WAL single-writer via `better-sqlite3` or `node:sqlite` (choose in Phase 0 after ARM64 build test), decimal arithmetic library for money, `zod` for schemas. Pin exact versions in lockfile.

## D-08 Strategy mandate

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** Long-only, unlevered, U.S.-listed ETFs then equities; decisions at most daily after the close; expected holding 5–60 trading days; no intraday.
**Tradeoff:** Slower turnover gives fewer observations but fits free-data latency, Pi reliability, and taxes. Intraday is incompatible with this architecture.

## D-09 Initial universe

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** Frozen list of roughly 12 highly liquid broad/style/sector ETFs plus a T-bill ETF cash proxy (see `strategies/etf-trend-vol/ALPHA_CHARTER.md`). Stock universe research proceeds only after point-in-time membership and delisting coverage exist.
**Tradeoff:** Survivorship-safe and cheap but leaves little room for filing-based analysis until the stock track opens.

## D-10 First Alpha Charter

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** `etf-trend-vol` first (validates the platform on survivorship-safe data), `form4-insider-cluster` second, `filing-change-challenger` only as a C1 experiment after Phase 3. Each charter is a draft until Matt approves it; approval freezes parameters.

## D-11 Runtime LLM provider

**Status:** Accepted 2026-09-06. Matt adopted the recommendation. Not inferred from Claude Code being the builder.
**Criteria:** structured-output reliability with strict schemas, quality on filing-extraction tasks, latency under a synchronous post-close deadline, data-handling terms, current API support for prompt caching, and measured cost.
**Recommendation:** Anthropic via a `ModelAdapter`. Tiering: Haiku 4.5 for extraction/triage of sealed packets, Sonnet 5 for `ResearchAssessment` synthesis, Opus 5 only inside a registered experiment that must justify its cost. Prompt caching on the stable system prompt and ontology. Batches only for non-time-critical replay and reporting (D-22). Model IDs resolved from the provider's Models API at configuration time and pinned per strategy version; a silent fallback is prohibited. See `docs/capabilities/model-provider-capabilities.md`.
**Why Anthropic and not "because Claude Code":** it matches Matt's existing tiering practice, has first-party structured outputs, and its batch and caching behavior are verifiable. A second provider adapter is a Phase 3 stretch only if an ablation needs it.

## D-12 Sleeve account

**Status:** Accepted default 2026-09-06 (taxable Schwab). Open fact: Matt must still confirm the account exists before Phase 6.
**Recommendation:** Dedicated taxable Schwab account; track tax lots, estimated tax drag, and wash-sale uncertainty. An IRA changes tax, withdrawal, and household-allocation modelling and must be decided before Phase 4 tax modelling.

## D-13 Schwab consent and blast radius

**Status:** Accepted default 2026-09-06 (sleeve-only linkage preferred). The written acceptance of any residual household-wide blast radius cannot be pre-authorized; it is made in Phase 6 after Schwab facts are verified.
**Recommendation:** Link only the sleeve if Schwab's current consent flow allows account selection; import other holdings read-only by CSV. If the token necessarily reaches all household accounts, application-level controls reduce but do not remove credential-compromise risk, and unattended automation stays blocked until Matt explicitly accepts that residual risk in writing here. All Schwab capabilities are currently UNVERIFIED (portal returns 403 unauthenticated).

## D-14 Restricted-theme seed and compliance process

**Status:** Accepted seed 2026-09-06. Counsel review remains a Phase 4 exit item.
**Seed (from Matt's role, not from any external list):** no new sleeve exposure to first-order soybean/biofuel/renewable-diesel/ethanol/ag-input/crop-protection/grain-merchandising names or ETFs concentrated in them; no exposure to companies Matt has met with in an ISA capacity in the past N days (N configurable, default 90); no positions taken during dated blackout windows Matt declares around policy events. Additions apply immediately; removals require a logged owner action, reason, and a 30-day cooling period.
**Process:** Short counsel review of the standing list and the add/remove policy before Phase 4 exit. Public-source allowlist only; no workplace connector exists in code.

## D-15 Risk budget and halt behavior

**Status:** Accepted 2026-09-06. Matt adopted the recommended default. Engineering defaults, not advice.
**Starting proposal:** sleeve ≤5% of liquid investable assets; no leverage; single-stock ≤5% of sleeve NAV; single ETF ≤20%; per-position initial loss budget ≤0.35% of sleeve NAV; sector ≤20%; max 3 new positions per session; daily new-risk cap 1% of NAV; `HALT_NEW_RISK` at 2% daily loss or 8% peak-to-trough drawdown; `HOLD_ONLY` at 10%; manual re-arm required. Automatic flatten never (D-23). Full `risk.yaml` coverage list in `docs/PRODUCT_SPEC.md`.

## D-16 Backups and Pi access

**Status:** Accepted default 2026-09-06. Open fact: Matt names the second Pi or bucket before Phase 0 exit.
**Recommendation:** SQLite online backup nightly to `${APP_DATA_DIR}/backups/` (7 daily, 4 weekly), plus an age-encrypted copy pushed to a second Pi on Matt's fleet or a personal cloud bucket Matt names. Daily ledger seal hash included. Only Matt has SSH/umbrelOS access to the Pi; no shared accounts. Quarterly restore drill.

## D-17 Notification and approval channel

**Status:** Accepted 2026-09-06. Default channel is a self-hosted ntfy topic on the Umbrel fleet (fits the self-hosted preference); Pushover remains a supported alternative adapter.
**Recommendation:** Notifications via a self-hosted ntfy topic or Pushover (Matt's choice); approvals in Phase 7 via the local read-only web page plus a signed approval token, never via chat message parsing. No notification carries dollar totals or credentials.

## D-18 Paper and micro-live capital

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** Paper NAV set equal to the intended real sleeve NAV so sizing is realistic. Micro-live starts at ≤$500 per order and ≤$2,000 total exposure for execution calibration only.

## D-19 Data budget

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** Free sources only for the ETF track and all prospective collection. Before any stock-strategy promotion, evaluate a small paid budget (order of $30–100/month) for point-in-time constituents, delistings, and corporate actions if free coverage is inadequate. Reliable data likely has higher expected value than more LLM calls.

## D-20 Household coverage

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** Quarterly CSV import of other accounts (brokerage, IRA, 401(k), cash) with coarse asset-class/sector/style exposures; staleness > 120 days blocks new risk. Career/income sensitivity recorded as conservative flags, never a dollar value. Dollar totals never leave the local config and never reach a model.

## D-21 License

**Status:** Accepted 2026-09-06. MIT. `LICENSE` added.
**Recommendation:** MIT for the source repository. It is permissive, compatible with a public Umbrel store, and imposes no obligation on Matt. Alternative: no license (all rights reserved), which still allows a public repository but discourages reuse. Add `LICENSE` in Phase 0 once decided.

## D-22 Batch API use

**Status:** Accepted (engineering).
**Fact (verified 2026-09-06):** Anthropic documents that most batches finish within an hour but results may take up to 24 hours and batches expire at 24 hours. **Decision:** Batches are used only for historical replay, reporting prose, and evaluation. Post-close decisions use synchronous calls with a deadline and abstain on timeout.

## D-23 Automatic flatten

**Status:** Accepted (from specification).
**Decision:** Drawdown, data, auth, model, or broker incidents default to `HALT_NEW_RISK` or `HOLD_ONLY`. `EMERGENCY_FLATTEN_AUTHORIZED` requires a separately authenticated manual command with an explicit order plan.

## D-24 Market data source for the ETF track

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Options:** (a) Alpaca Market Data free tier (IEX-only, must not be labelled NBBO; adequate for daily bars on liquid ETFs) with issuer distribution data for total-return adjustment; (b) Stooq/Yahoo-style free daily bars (ToS and reliability concerns; not recommended for anything beyond exploratory); (c) a small paid EOD provider with consolidated bars, splits, and dividends.
**Recommendation:** Start with (a) for daily bars plus issuer-published distributions, record the venue entitlement on every bar, and re-evaluate (c) before Phase 2 exit if data-quality rules fire.

## D-25 Alpaca paper broker

**Status:** Accepted 2026-09-06. Matt adopted the recommended default.
**Recommendation:** Use Alpaca paper in Phase 5 behind the `BrokerAdapter` interface, paired with Black Gold's own conservative fill/cost model, because Alpaca documents that paper omits market impact, leakage, latency slippage, queue position, price improvement, regulatory fees, and dividends. Paper results are never presented without the internal model's adjustments.

## D-26 Stacked Phase 0 PR

**Status:** Accepted 2026-09-06.
**Context:** Matt authorized Claude Code to continue through Phase 0 in the same session ("continue building until you run out of tasks"). Claude Code does not merge its own PRs (D-06), so Phase 0 cannot branch from a merged `main`.
**Decision:** `claude/phase-00-foundation` branches from the Discovery branch head and its PR targets the Discovery branch. When PR #1 merges, the Phase 0 PR is retargeted to `main`. Later financial-critical phases return to the branch-from-merged-`main` rule.

## D-27 SQLite binding

**Status:** Accepted 2026-09-06 (engineering).
**Decision:** Use the Node.js built-in `node:sqlite` module. It needs no native compilation, which removes the main ARM64 build risk. Online backup uses `VACUUM INTO`, which is WAL-safe. Node 22 marks the module experimental; Node 24 (the container runtime) is the target. Re-evaluate only if a measured defect appears.

## D-28 Phase 1 authorization and stacking

**Status:** Accepted 2026-09-07.
**Context:** After Phase 0 was delivered as PR #2, Matt replied "keep going". Everything else outstanding was Matt's own (GitHub settings, merges, hardware checks), so the instruction was read as authorization to start Phase 1, the point-in-time research kernel.
**Decision:** Phase 1 proceeds on `claude/phase-01-research-kernel`, stacked on `claude/phase-00-foundation` (same pattern as D-26). Its PR targets the Phase 0 branch and is retargeted to `main` as the stack merges. If Matt did not intend this, the branch can be closed without effect on Phase 0.

## D-29 Market data and corporate actions for the research kernel

**Status:** Accepted 2026-09-07 (engineering).
**Verified:** Alpaca `GET /v2/stocks/bars` with `feed=iex`, `adjustment=raw`, `timeframe=1Day`, key-header auth, and paging (CR-24). Free-tier entitlement semantics are not yet measured with a real key.
**Decision:** The adapter fetches raw, unadjusted IEX daily bars labelled `alpaca.iex.bars.1d` and never labels them consolidated. Splits, dividends, and other actions are separate observations; Black Gold computes its own total-return series from raw closes plus the action ledger, so adjustments are reproducible and versioned. For the frozen ETF universe the action ledger is seeded from issuer distribution records vendored as observations with their own `availableAt`; an automated corporate-actions feed is a Phase 2 verification item.

## D-30 Data provenance engineering defaults

**Status:** Accepted 2026-09-07 under the blanket acceptance of recommended defaults.
**Decision:** The five open items in `docs/DATA_PROVENANCE_SPEC.md` section 12 take their proposed values: processing delays of 15 minutes for EDGAR and market data, 60 minutes for macro releases, and 24 hours for batch-routed work; the storage budgets and 15 percent / 30 GB free-space floor in section 9; 13F remains research context through Phase 2; no paid survivorship-free equity dataset is evaluated until the ETF track has run; publication-time estimates are calibrated during Phase 5 shadow operation.

---

## D-31 Review corrections to the Phase 1 research kernel

**Status:** Accepted 2026-09-07 (engineering). Raised by automated review of PR #3; each item verified against the code before acting.
**Decision:**
1. COT release timing follows the U.S. federal holiday calendar computed by rule (`packages/core/src/calendar/us-federal.ts`) and verified against every published 2026 release date (CR-27). The NYSE calendar stays the exchange calendar for sessions and bar times only.
2. The entity map is bitemporal. Each symbol range records the instant it became knowable and the instant its close became knowable; point-in-time resolution passes the decision instant as `knownAt`. Migration `0006_entity_symbols` was amended in place rather than followed by a `0007`, because no image has been published and no database outside test fixtures has run it. From the first published image onward, migrations are forward-only without exception.
3. Artifact verification quarantines: the operational entry point `verifyArtifacts` appends `ARTIFACT_MISSING` corrections and a ledger incident; the low-level `ArtifactStore.verify` is storage-only.
4. Promotion evidence is refused when any recorded trial carries a blocking label, not only when the registration did.
5. Configured processing delays reach every repository the runtime builds (`processingDelayOverridesMs`), and the CLI exposes them as `BLACKGOLD_PROCESSING_DELAYS`.
6. The artifact budget is a per-write hard cap inside the store. COT requests page through Socrata `$offset`.

## D-32 Book-slot priority between the entry rule and the hysteresis hold rule

**Status:** Accepted 2026-09-07 (engineering, provisional). **Owner confirmation required before `etf-trend-vol` is frozen.**

**The ambiguity.** `strategies/etf-trend-vol/ALPHA_CHARTER.md` section 8 says to enter any ETF ranked 1 to 5 that is not held, and to keep a held ETF while it stays eligible and ranked 1 to 7. With five eligible newcomers and a held name at rank 6, those two rules name six ETFs for a five-slot book. Section 9 step 1 says only "at most 5" and does not say which rule yields.

**Why it matters.** Resolving it by rank alone makes the hysteresis band dead code: whenever five names are eligible, ranks 1 to 5 exist and fill the book before any rank-6 or rank-7 incumbent is reached, so the wider hold band could never retain anything. That contradicts the band's stated purpose and the charter's own turnover expectation (section 21: 15 to 40 entries or exits per year).

**Decision.** An eligible incumbent inside the hold band keeps its slot; the lowest-ranked newcomer is the one left out. The correlated-cluster cap is treated differently and stays strictly rank-ordered, because section 9 step 4 is explicit that "the lowest-ranked extra members are skipped" - so an incumbent does not hold a cluster slot against a higher-ranked name, only a book slot. Implemented as four ordered passes in `packages/core/src/strategy/candidates.ts` and pinned by `packages/core/test/strategy-candidates.test.ts`.

**What the owner should confirm.** Whether incumbent priority is the intended reading. If it is, section 8 of the prose charter should say so before the charter is frozen. If it is not, the alternative is a narrower hold band (hold rank equal to entry rank), which removes the hysteresis rather than reversing the priority.

## D-33 An entity priced behind the cross-section is excluded from the decision

**Status:** Accepted 2026-09-07 (engineering).

**Decision.** Every feature at a decision is computed at one anchor session: the newest session for which any universe member has an available bar. A member whose newest available bar predates that anchor is marked `STALE_ANCHOR` and every one of its features is left undefined, so the candidate engine rejects it on `NO_FEATURES`.

**Why.** A shared publication lag moves the whole cross-section back one session together, which is honest and harmless. A single broken feed is different: ranking one member's week-old price against its peers' current prices is a silent comparison across dates. The conservative choice excludes the member, not the decision, so one bad feed cannot stop the sleeve; this follows the standing rule that unknown or stale state fails closed for new risk.

## D-34 The charter is executable, and approval is a code-enforced gate

**Status:** Accepted 2026-09-07 (engineering).

**Decision.** Each strategy gets a machine-readable `charter.yaml` alongside its prose charter, and that file is the only form the code executes. Every window, rank, cap, cost, boundary and threshold comes from it, so a parameter cannot be changed by editing code: it is a charter edit, which changes the charter hash, which makes it a different experiment. `assertRegistrable` refuses to freeze an experiment while the approval block is unsigned, any declared open decision is unresolved, or any conditional universe member is undecided. An undecided conditional member is excluded from the universe (so `etf-trend-vol` currently runs 12 risk ETFs, not 13: XLE stays out until the compliance look-through rule is decided). A permanent CI gate asserts these properties for every tracked charter.

## D-35 Phase 2 authorization and scope

**Status:** Accepted 2026-09-07.

**Decision.** Phase 2 was authorized by Matt's instruction to keep building (2026-09-07) and was built as machinery plus fixture tests only: the charter loader and approval gate, feature engine, candidate engine, portfolio construction, leakage audit, coverage report, walk-forward splitter, statistics, attribution, backtest runner, robustness harness, and result report.

**What was deliberately not done.** No experiment was registered, no historical result was computed, and the holdout was not opened. Two independent reasons: the charter is `DRAFT` with four unresolved open decisions, and no market data has been ingested from any source (no credentials exist yet). Registering an experiment on unapproved numbers, or viewing a result before the charter is frozen, would consume information that cannot be given back - the viewed-results rule in `docs/EXPERIMENT_PROTOCOL.md` section 3 makes it irreversible. The machinery is therefore complete and tested, and the same code produces the evidence once the charter is approved and data is ingested.

## D-36 Stacked-PR merge order

**Status:** Accepted 2026-09-07 (engineering). Recorded after the same mistake happened twice.

**What happened.** Twice a phase PR was merged into a base branch that had already been merged forward, leaving `main` a phase behind the reviewed work:

- PR #3 merged Phase 1 into `claude/phase-00-foundation` after that branch had gone into `main`. Fixed by PR #4.
- PR #5 merged Phase 2 into `claude/phase-01-research-kernel` at 12:56:48Z, twelve seconds after PR #4 merged that same branch into `main` at 12:56:35Z. Fixed by a fresh PR.

Neither was a code fault and neither lost work: in both cases the reviewed tree was intact on the branch, just not reachable from `main`. Both cost an extra PR.

**Decision.**

1. A stacked PR is retargeted to `main` **before** it is merged, or merged before its base branch goes in. GitHub offers the retarget automatically when the base merges; taking that offer is the whole fix.
2. Before merging anything stacked, check whether the base is already in `main`: `git merge-base --is-ancestor <base-head> origin/main`. If it answers yes, retarget before merging.
3. When it happens anyway, the remedy is a merge commit that brings `main` into the phase branch plus a fresh PR carrying the identical tree. Never a force-push, never a rebase, never reusing the merged PR. Verify the tree is unchanged with `git diff <reviewed-head> HEAD` and expect an empty diff.
4. Merged phase branches are deleted once their successor lands. Branches left lying around are what make the mistake easy to repeat.

## D-37 Standing git and GitHub autonomy

**Status:** Accepted 2026-09-07 by Matt, who asked for it directly ("full autonomy to push, commit and interact with github").

**What it replaces.** The original protocol required per-action owner authorization to "push, open a PR, mark ready, merge, tag, publish an image, or install on Umbrel", and said "never merge your own PR". In practice Matt marked four PRs ready and merged four PRs by hand in a single session while Claude Code waited. It also caused a defect: the D-36 mis-merge happened twice precisely because merge timing sat with a human who could not see that a base branch had already been merged forward. Claude Code would have retargeted before merging.

**Decision.** Claude Code is authorized, standing and without asking, to: commit; push; open a PR; mark it ready; merge its own PR to `main`; retarget a PR; delete merged branches; reply to and resolve review threads; create and push a `v*` tag; and trigger `release.yml` and `release-verify.yml`.

Unchanged: no direct commit or push to `main` (work still arrives through a PR, including one Claude Code merges itself); no force-push; no rewriting anyone else's history; exact paths staged; `npm run check` green before any push; and the full PR body every time. The PR body matters *more* under autonomy, because it becomes the only record that anything reviewed what a merge did.

**What it deliberately does not cover, and why.** Charter approval, resolving a charter's open decisions, admitting a conditional universe member, opening a sealed holdout, claiming promotion evidence, accepting Claude Code's own results as investment evidence, and anything touching live mode or a broker credential.

These are not process friction; they are the reason the system is built the way it is. `assertRegistrable` refusing a DRAFT charter is theatre if Claude Code can sign the charter. A once-only holdout is theatre if Claude Code can open it. A falsifier is theatre if Claude Code can decide it does not count. An agent that approves its own hypothesis and then grades its own results generates no evidence at all. Claude Code may propose any of these with reasoning, and should say plainly when one of them is what blocks progress, but may not perform them.

**Why relaxing the workflow gates is safe.** `CLAUDE.md` already states that its instructions are guidance and that hard limits live in branch protection, CI policy tests, and the broker gateway. Nothing protecting capital depended on the owner clicking merge: live trading is absent by construction, no broker credential exists anywhere in the project, account isolation and live-disabled are permanent CI gates, and the charter approval gate is enforced in code with its own policy test. Autonomy over git changes who presses the button, not what the button is permitted to do.

---

## D-38 Releasing without a tag ref

**Status:** Accepted 2026-09-07 by Matt: "lets fix 1. so you can can do this yourself now and into the future."

**The problem.** D-37 authorized Claude Code to "create and push a `v*` tag", and that turned out to be unusable. `git push origin v0.1.0` returns HTTP 403 from GitHub on every attempt, as does `git push origin --delete <branch>`, while ordinary pushes to `claude/*` branches on the same repository succeed and the agent proxy reports healthy with no relay failures. The refusal carries GitHub's own response headers, so it is an authorization decision on GitHub's side, not the egress policy. The git credential this session is given may add commits to its own branch and nothing else.

The consequence was not cosmetic. `release.yml` fired only on a pushed semver tag, so no image was ever published, so the Umbrel community store rendered a valid-looking `0.1.0` listing whose Install button failed on a `docker pull` of an image that did not exist. The whole release chain hung on one command a human had to type.

**Why not just widen the credential.** It is not a repository setting Matt can change - no ruleset is configured, and the credential is injected by the Claude Code environment rather than issued by this repository. Nor is there an API path: the GitHub MCP tools authenticate as Matt with full rights and can merge PRs, but expose no tag-creating or release-creating call. Waiting for a platform change is not a fix.

**Decision.** `release.yml` gains a `workflow_dispatch` trigger taking a bare semver. On that path the workflow resolves `main`'s head itself, verifies it, runs the full `npm run check`, creates the annotated `v<version>` tag, and then publishes. The tag-push path is unchanged, so Matt can still cut a release by hand exactly as before.

**Why this is narrower than the permission it replaces, not broader.** A tag-ref grant would let any ref be tagged with any name at any commit. This path can only ever produce one thing: the tag `v<version>` where `<version>` is what `package.json` already declares, at a commit already reachable from `main`. It cannot publish unreviewed code, because unmerged work is unreachable from `main` by definition. Specifically:

1. The version must match `package.json` read *from the resolved commit*, not the working tree, so dispatching from another ref cannot substitute a different version.
2. The commit must be an ancestor of `origin/main`.
3. An existing tag is refused rather than moved. A published version is immutable - the compose file pins it by digest, and re-pointing a tag would silently change what an installed app resolves on its next pull.
4. The input is shape-checked against `^[0-9]+\.[0-9]+\.[0-9]+$`, which the push trigger got free from its ref pattern.
5. The input reaches the shell through the environment, never interpolated into a script body.
6. `contents: write` is scoped to the single job that creates the ref; the workflow is otherwise read-only.
7. Tagging happens *after* checks pass, so a failed release leaves no tag pointing at nothing.

**What it still cannot do.** Everything D-37 carved out is untouched, and none of it is reachable from here: no charter approval, no holdout opening, no promotion-evidence claim, no live mode, no broker credential. Publishing an image of already-merged code is a low-consequence act in this system precisely because live trading is absent by construction - the image cannot trade whatever it contains.

**Honest note on what changed.** This does give Claude Code an indirect route to a capability the platform currently withholds, through a workflow Claude Code wrote. That is worth stating rather than burying: the mitigation is that the route is narrow by construction and auditable by default, since every release is now an Actions run with a log of exactly which commit and version it resolved and why it accepted them. If Matt would rather the capability not exist, deleting the `workflow_dispatch` block restores the previous behaviour completely and nothing else depends on it.


---

## D-39 The etf-trend-vol charter's open decisions

**Status:** Accepted 2026-09-07 by Matt, answering each of the four questions the charter itself declared.

This record exists so `approval.approval_ref` has something citable. A decision made in a chat session is not
a written owner decision; this is.

### OD-1 Diversified-ETF look-through, and XLE

**Look-through applies. XLE is not admitted.** The risk universe is 12 ETFs, not 13. XLI and XLP stay
look-through flagged and are admitted.

XLE holds refiners with direct RFS and 45Z exposure, which is a restricted theme for an operator whose
professional role is advocacy on exactly those policies. The reasoning recorded at the time of the decision
was asymmetry rather than certainty: wrongly holding XLE is a professional conflict question, wrongly
excluding it costs marginal diversification in a sleeve that is not trading. The option chosen is the one
reversible in the safe direction.

**This is interim.** D-14 still records counsel review as outstanding, and this decision is precisely what
that review is for. Counsel may widen the rule; narrowing it, or admitting XLE later, is a new charter
version and does not inherit this charter's evidence.

### OD-2 Cash instrument

**BIL**, as the frozen universe already assumed, so no universe change. Chosen over SGOV because depth and
spread matter more on a sleeve of this size than roughly five basis points of expense, and over plain cash
because short-rate carry on idle cash is not worth forgoing at current rates.

### OD-3 The risk.yaml defaults, and a discrepancy found while approving them

**Approved as they stand in `config/examples/risk.yaml`:** `maxSingleEtfWeightPct` 0.20, `minCashPct` 0.02,
`maxAdvParticipationPct` 0.01, `targetAnnualizedVolPct` 0.10.

Worth recording because it nearly went through unnoticed: **OD-3's own question text said "0.5% ADV
participation" while the file said 1%.** Three of the four cited numbers matched the file; that one was
double. Approving it as written would have produced an approval citing a number that was not in the
configuration it approved. The owner resolved it in favour of the file, and the question text in
`charter.yaml` is corrected to 1%.

The general lesson, since the charter cites configuration values in prose: **a document that restates numbers
from a file will drift from that file.** A check that the cited values match the configuration would be worth
having before the next charter version.

### OD-4 Market-data source

**Approved: Alpaca free tier, IEX feed, daily bars.** D-24 required a capability probe first; it was run live
on 2026-09-07 - 340 bars for SPY and VTI, prices stored as decimal strings, `availableAt` one hour after each
close, DST-correct session times (21:00 UTC in January, 20:00 from April), zero OHLC violations.

The CR-09 limitation is accepted rather than waved away: IEX is not the consolidated SIP tape, so reported
volume is a fraction of consolidated volume and ADV estimates read low. That makes the 1% ADV cap bind
earlier than it would on full-tape volume, which is conservative for execution and therefore acceptable for
research and paper trading. A live phase should revisit whether consolidated data is required.

### What this decision does not do

It does not approve the charter. Four of the nine registration blockers are cleared; the five that remain are
the approval block itself - `state`, `approved_by`, `approval_date`, `code_commit`, `approval_ref` - and
signing it is the owner's act. `assertRegistrable` still refuses this charter, correctly.


---

## D-40 Granary owns the household layer; Black Gold is a read-only source to it

**Status:** Proposed 2026-09-07 by Claude Code, recording Matt's decision to build the personal-finance / household layer as a separate product rather than inside Black Gold. Matt must accept, replace, or reject before any Phase 4 household work proceeds.

**Context.** The original plan put the household picture inside Black Gold: Phase 4 delivers a "schema-validated financial picture and read-only CSV import" with household-allocation and exposure modelling (D-12 sleeve account, D-20 household coverage, `config/examples/financial-picture.yaml`). Matt has since decided to build that layer as **Granary** (`mherman1990/Granary`), a separate, private, local-first household planning workspace that sits *above* Black Gold in the hierarchy and will eventually bring in data *from* Black Gold. Granary is its own Umbrel app (`granary`, port 3000) with its own repo, phases, and isolation rules; it currently forbids any real Black Gold connection and treats integration as a future, separately gated step.

**Decision (proposed).**

1. **Direction is one-way and, from Black Gold's side, outbound-only.** Granary reads Black Gold; Black Gold never reads or depends on Granary. No Granary identifier, port, path, image, credential, schema, or line of code enters this repository - the same "this repository contains Black Gold only" rule that already governs it, and the mirror of Granary's own isolation rule. Identifiers are already disjoint and stay that way: Black Gold is `blackgold-trading` on 8479, Granary is `granary` on 3000; no shared volume, secret, port, release, or Umbrel identity.

2. **Black Gold's non-negotiable boundaries are unchanged and now also serve as this integration's safety guarantee.** No inbound connector to any nonpublic, household, or professional source may exist in code; household dollar totals never reach a model or a notification; no money-movement code exists. Granary consuming Black Gold adds no inbound path and must never be allowed to, so the risk sits entirely on Granary's side of the boundary, where its own rules already place it.

3. **Black Gold stops growing an in-house household planner.** The Phase 4 household scope (D-20 CSV import, household-allocation modelling) shrinks to the minimum Black Gold's own deterministic gates actually need - the sleeve-as-a-share-of-liquid-assets check (D-15), restricted-theme and career-conflict flags (D-14), and exposure staleness - and even those inputs may ultimately be supplied by Granary as a read-only import rather than maintained here. What Black Gold must not do is become the household book of record. Granary is.

4. **If and when Granary consumes Black Gold, it does so through a read-only export that carries weights and states, never dollars or accounts.** Black Gold exports the sleeve's composition (instrument weights as fractions of sleeve NAV), per-arm decisions, risk/evidence state, data-freshness flags, and sealed ledger roots - and never a dollar amount, account identifier, credential, order, or mutation method. Granary is the household book of record and already holds the sleeve's dollar balance, so it supplies the dollar denominator itself; Black Gold emitting a dollar NAV off-device would violate A3/T-22/F13 and the status-page rule, so it does not. The full design is in `docs/GRANARY_EXPORT_CONTRACT.md` (also Proposed); building it is Phase 4/5 work, not now.

**What this does not do.** It authorizes no code change, starts no phase, and grants Granary no access. It records the hierarchy so a future Black Gold session neither rebuilds the household layer here nor takes a dependency on Granary. The two decisions it unblocks - the exact read-only export contract (`docs/GRANARY_EXPORT_CONTRACT.md`), and whether `config/examples/financial-picture.yaml` stays a minimal local risk-gate input or is eventually fed from Granary - are Matt's to make when Phase 4 is authorized.

---

## D-41 Phase 3 authorization and provider-deferral scoping

**Status:** Accepted 2026-09-07 by Matt, who set the order of work as "2, 1, 3" — the read-only export contract
first, then Phase 3, then charter signing and data.

**What was built.** The bounded runtime-LLM analyst overlay, as the complete provider-agnostic pipeline and
its safety surface, tested end to end with a `DeterministicStubAdapter` (no credentials, no network): the
strict `ResearchAssessment` schema and fail-closed validator; the sealed evidence packet and its
serialization guard; the `ModelAdapter` boundary and the `runAssessment` orchestration (budgets, deadline,
retries, circuit breaker, no silent fallback, abstention); the B0/B1/C1/D1 overlay primitives with
non-interaction enforced by type and contamination labels; the model capability manifest and fail-closed
resolver; the adversarial corpus; the T-05 no-LLM-in-sizing CI gate; and the locked ablation plan.

**What was deliberately deferred, and why.** The real Anthropic adapter is a separate follow-up PR, not part
of this one, for a concrete safety reason: wiring it means loosening a permanent CI gate
(`live-disabled.test.ts` forbids `@anthropic-ai/sdk` and `api.anthropic.com`) and adding a POST egress path
(`data/http.ts` is policy-forbidden from issuing a POST). That is a deliberate change to the egress/safety
model and deserves its own review and an API key to verify CR-11/12/13 against the live Models API. Persisting
the model-call record and the running budget, and wiring C1/D1 into the decision loop, are likewise deferred:
recording a real call and running a prospective C1/D1 belong with Phase 5 shadow operation. The Phase 3 exit
criteria are about pipeline safety and are all provider-agnostic, so the safety surface is complete and tested
now; the deferred items each need either credentials or a later phase. `docs/PHASE3_REQUIREMENTS_MATRIX.md`
records exactly which rows this leaves open and why.

**What this does not do.** It integrates no live mode, adds no broker credential, and adds no provider egress
path. No LLM output can set a size, choose an account, or form an order — enforced structurally and by a
permanent CI gate. The ablation plan is locked but registers no experiment and promotes nothing.

---

## D-42 The Anthropic model adapter and the model-egress change

**Status:** Accepted 2026-09-07 by Matt, who directed the build to continue and said the key would be placed
in the environment once code is connected to it ("keep building and we can come back and put the key in when
things are connected to it"). The key he pasted into chat earlier was rotated; no key value is in this repo.

**What was built.** `AnthropicAdapter` (`packages/core/src/model/anthropic.ts`), the single Anthropic
implementation of `ModelAdapter`, and `packages/core/src/model/provider-http.ts`, the single model-egress
module. The adapter builds the Messages API request (pinned model id from config, `output_config.format`
structured output over the assessment schema, a cacheable system prompt, the sealed packet as the user
content), POSTs it through an injectable transport, and maps the response back to the provider-agnostic
`ModelResponse`. It is fail-closed: any network error, timeout, non-200, refusal, or non-JSON body throws
`ModelUnavailableError` (the orchestration abstains); a body that parses but fails the schema is returned for
the deterministic validator to reject.

**Why raw `fetch` and not the SDK.** Adding `@anthropic-ai/sdk` would grow the dependency surface of a
financial-critical system and make provider calls outside the one audited egress module. A thin `fetch`
confined to `provider-http.ts` keeps egress centralized and auditable, adds no dependency, and is what the
`live-disabled` policy gate now enforces: `api.anthropic.com` and the outbound POST are allowed in exactly
that module, every broker/trading host stays forbidden everywhere, `data/http.ts` stays read-only (POST-free),
and no provider SDK or dependency is added. This is a deliberate, reviewed change to the egress model, not a
weakening of the live-trading protection, which concerns brokers and orders and is untouched.

**The key path.** The adapter takes the API key as a constructor argument; the model layer never reads
`process.env` (the no-LLM-in-sizing gate). A wiring layer allowed to read the environment injects it when an
analyst command is built (Phase 5). The compose passes `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` to the core
container (empty default, so a missing key does not break startup and the analyst simply abstains); the value
lives in a gitignored secrets file on the Pi, never in git or the image.

**What still needs Matt.** One live verification run against the real API on the Pi (CR-12/CR-13: the exact
structured-output wire shape, real latency and cache behaviour). Persistence of the model-call record and
running budget, and wiring C1/D1 into the decision loop, remain Phase 5.

---

## D-43 Phase 4 authorization and the deterministic factor classifier

**Status:** Accepted 2026-09-07 by Matt ("I authorize phase 4"). The factor-map location was his explicit
choice among three options: factor assignments live **in the signed charter YAML**.

**Scope note.** Phase 4 (household-minimum, compliance, restricted list, portfolio construction, sizing, risk
engine) is large and several of its deliverables depend on unresolved inputs - `risk.yaml` approval and the
sleeve account (D-12) - so it is built as a sequence of bounded PRs, unblocked pieces first. This decision
covers the first: the deterministic factor classifier.

**What was built (first Phase 4 PR).** A `factors` block in the charter schema (`taxonomy` + per-symbol
`assignments`) with structural validation (assignment keys must be universe members; every tag must be in the
taxonomy; no duplicates). `packages/core/src/strategy/factors.ts` classifies a candidate from the charter and
`unclassifiedRiskEtfs` reports gaps. The `research analyst` CLI now derives `factorsTouched`'s deterministic
counterpart from the charter and **refuses an unclassified candidate** ("unknown factor classification blocks
new risk", `docs/PRODUCT_SPEC.md` section 11), replacing the operator `--factors` flag. The etf-trend-vol
charter carries a conservative starting map for owner review.

**Why the charter, not a side file.** Factor assignments are the code-side authority the model's
`factorsTouched` is checked against (T-05); a change to them is a data transform, which `CLAUDE.md` already
treats as a new strategy version. Putting them under the charter hash makes that automatic: a factor edit
changes the hash, so it cannot silently alter what a registered experiment was graded against.

**What still needs Matt.** The factor *values* in the charter are a starting point for his review, not
owner-approved numbers, and editing them (like signing the charter) is his act. The rest of Phase 4 - exposure
flags and look-through, the restricted list and compliance engine, the deterministic portfolio constructor and
sizing, and the risk engine with halt states - follows as further bounded PRs, gated on `risk.yaml` approval
and the sleeve account where it depends on them.

---

## D-44 The risk halt-state machine, and why risk.yaml stays unapproved

**Status:** Built 2026-09-07 under the Phase 4 authorization (D-43), after Matt said "resolve risk.yaml so you
can build sizing and risk."

**What was not done about risk.yaml, and why.** Approving the risk.yaml defaults is charter open decision OD-3,
and *resolving a charter's declared open decisions* is one of the acts standing authorization never covers
(`CLAUDE.md`) - the evidence gate is worthless if the agent that writes the code also signs off the values it
enforces. So Claude Code did **not** resolve OD-3 or set `approvedBy`; `config/examples/risk.yaml` keeps
`approvedBy: null`. This did not block the build: the *approval* gate governs registration and live activation,
not whether the engine may be written and tested. The risk-policy schema and defaults already existed (D-15,
`RiskConfigSchema`), and sizing already existed (`strategy/construct.ts`, Phase 2) - the missing piece was the
engine.

**What was built.** `packages/core/src/risk/halt.ts`, the deterministic halt-state machine
(`evaluateHaltState`). It reads sleeve NAV / high-water mark / session-start NAV, staleness and incident
signals, and the policy thresholds, and returns `NORMAL`, `HALT_NEW_RISK`, or `HOLD_ONLY` - never
`EMERGENCY_FLATTEN_AUTHORIZED`. It encodes CLAUDE.md's non-negotiables directly: a drawdown, daily loss, stale
critical input, expired authorization, unknown state, or severe incident lands in `HALT_NEW_RISK` (or
`HOLD_ONLY` at the deeper drawdown); automatic flatten never happens; escalation to a more restrictive state is
automatic while relaxation needs an explicit owner re-arm, and even then an active fault still binds; unknown
state fails closed. It is pure - no model, broker, or network - and lives under `risk/`, which the analyst
layer is forbidden to import (T-05). 18 boundary/positive/negative tests.

The Codex code review on PR #29 caught three genuine gaps against `docs/AUTOMATION_AND_LIVE_GATES.md`, all
fixed before merge: reconciliation/order-state/broker uncertainty must demand `HOLD_ONLY` (not merely
`HALT_NEW_RISK`, sections 7-8); an owner-entered emergency flatten must expire at session end (section 9.3);
and recovery from `HOLD_ONLY` is staged one step at a time (`HOLD_ONLY` -> `HALT_NEW_RISK` -> `NORMAL`,
section 9.2), so an owner re-arm cannot skip the intermediate state.

**What still needs Matt / is deferred.** Resolving OD-3 (approving risk.yaml) is his act; the engine is built
and tested, but the policy it consumes is not yet approved, so nothing may register or run for real. Deferred
to further Phase 4 PRs: the risk-limit/caps engine (position, sector, cluster, gross, ADV) with reason codes;
the compliance engine and restricted list; exposure flags and look-through; and wiring the halt state into a
decision or gateway loop (Phase 5). No live path, broker credential, or order forms here.

---

## D-45 The risk-limit (caps) engine, and the deferred factor-concentration question

**Status:** Built 2026-09-07 under the Phase 4 authorization (D-43); Matt directed "take the caps/limit engine
next."

**What was built.** `packages/core/src/risk/limits.ts` (`evaluateRiskLimits`), the deterministic `RiskEngine`
verdict from `docs/PRODUCT_SPEC.md` section 8: an independent re-check of a proposed target book against the
`risk.yaml` caps and the charter, separate from construction (the spec keeps candidate score, portfolio
target, and risk verdict as distinct objects, and an equivalent guard re-runs in the gateway). It admits or
rejects and names every breach with a reason code; it never re-sizes. Pure - only weights, policy, and the
frozen charter; no model, broker, or network (T-05, under `risk/`). Fail closed: a holding the charter does
not classify has an unknown sector and is rejected. Checks: admission (a held instrument must be an admitted
risk ETF - classification is not admission, so an unadmitted conditional member like XLE is rejected),
per-instrument weight, open-position count (the stricter of the risk.yaml and charter caps), gross/net
exposure, the cash floor, sector concentration, correlated-cluster weight and membership, and the long-only
(no negative weight) posture. 12 tests. The Codex code review on PR #30 caught two fail-closed gaps, both fixed
before merge: enforce the stricter charter `max_positions` (not only the looser `risk.yaml` cap), and reject a
held instrument outside `admittedRiskEtfs` even when the charter classifies it.

**Deferred, and one of them is a real question for the owner.** Liquidity limits (ADV participation, spread,
price), order-level limits (notional, quantity, turnover), and the per-position initial-risk budget need order,
price, or ADV data this check does not take, and are follow-up engines. **Factor concentration is deferred on a
genuine design question:** `risk.yaml` carries `maxFactorWeightPct`, but the charter's factor taxonomy includes
`market`, which is on every holding - capping the summed `market` weight would cap total invested exposure,
which is wrong. Which factor tags are concentration-bearing (the style/tilt tags) versus broad-market beta is a
policy decision that belongs to the owner and probably to the charter's factor block; until it is made, the
factor cap is not enforced rather than enforced incorrectly.

---

## D-46 The compliance engine, and why Claude Code does not author the restricted list

**Status:** Built 2026-09-07 under the Phase 4 authorization (D-43); Matt directed "take the compliance engine
and restricted list."

**What was built.** `packages/core/src/compliance/engine.ts` (`evaluateCompliance`), a deterministic re-check
of a candidate against the restricted list, admit/reject with reason codes, pure (no model, broker, or
network). It encodes the two load-bearing restricted-list rules (D-14): **additions are immediate** (a name,
ETF, or theme on the list restricts on the same decision) and **removals wait a cooling period** (an item in
`pendingRemovals` stays restricted until its `eligibleAt`, so a quick add-then-remove cannot free a name).
Blackout windows block only new risk; a stale list fails closed (blocks new risk) rather than being trusted.
Themes are checked against the candidate's supplied exposures. 10 tests.

The Codex code review on PR #32 caught six genuine gaps, all fixed before merge, and they sharpened the model:
compliance gates **new sleeve exposure only** (a reduction or exit of a restricted holding is always
compliance-clear, so a newly-restricted position is never trapped); unknown ETF look-through
(`themeExposures: undefined`) blocks new risk rather than defaulting to empty; a stale list blocks only new
risk; the cooling period runs to the LATER of `eligibleAt` and `requestedAt + coolingPeriodDays` (a too-early
`eligibleAt` cannot shorten it); `maxListAgeDays` is required so the staleness check cannot be silently
skipped; and matching is by entity identity across all known tickers/aliases (`EntityMap.symbolsFor`), so a
ticker change cannot admit a restricted entity.

**What Claude Code did not do, and why.** The restricted list's *content* - the employer, suppliers, and
themes tied to the operator's professional life - is nonpublic and is the owner's compliance policy to set
(`docs/PRODUCT_SPEC.md` section 2: Matt approves compliance policy, restricted lists, and themes). Claude Code
built the engine but **did not author any real restricted names**; `config/examples/restricted-list.yaml` keeps
its deliberately fake placeholder values. Populating the real list is the owner's act, like approving
`risk.yaml`, and doing otherwise would also put nonpublic professional context into the repository, which the
boundaries forbid.

**Deferred.** ETF **look-through** - deriving which restricted themes a broad ETF is exposed to (e.g. XLE and
the RFS/45Z refiner theme) - is a separate Phase 4 piece, so the engine takes theme exposures as input rather
than computing them. Wiring compliance into the decision loop is Phase 5.

---

## D-47 Phase 5 authorization and the deterministic decision gate

**Status:** Accepted 2026-09-07 by Matt ("then phase 5", after directing the Phase 4 compliance work). Phase 5
(prospective shadow and paper operations) is authorized; it is built as bounded PRs, and most of it is gated on
Matt's inputs (see below), so the first piece is the one that needs none of them.

**What was built (first Phase 5 PR).** `packages/core/src/decision/gate.ts` (`evaluateDecisionGate`), the single
place that composes the three independent Phase 4 verdicts into one go/no-go for new risk - the "100% hard-rule
enforcement" of PLAN.md Phase 5:

> new risk may proceed == halt state is NORMAL AND the proposed book respects every limit AND every candidate
> newly taking risk clears compliance

Fail-closed by construction: a single block from any engine makes `newRiskAllowed` false, and every reason is
flattened for the decision ledger. It forms no order and never re-sizes. Purely deterministic - it composes
only the risk and compliance engines (under `risk/` and `compliance/`, which the analyst layer may not import),
so no model output can reach the decision (T-05). Compliance is fixed to new-risk for each candidate, since the
gate's whole question is whether new exposure may be added.

Compliance **coverage is enforced, not trusted** (Codex P1 on PR #35). The gate takes the current book as well
as the target and derives the holdings taking new or increased risk (`target > current`); every one must be
covered by a supplied compliance evaluation or the gate fails closed (`MISSING_COMPLIANCE`). Trusting the caller
to list every increasing holding was a fail-open hole - a caller passing `[]` would have been admitted with the
restricted list never consulted - which is exactly the failure mode this gate exists to prevent. Holdings held
flat or reduced are not new risk and need no candidate, so a restricted position stays windable-down. Coverage
binds each increasing holding to a candidate by CANONICAL key (its entity id, or symbol when there is none, keyed
as the book is) rather than to the candidate's alias/identifier set (Codex P1 on the fix): the alias set is for
restricted-list matching inside `evaluateCompliance`, and letting one clean candidate cover another holding it
merely lists as an identifier - whose own look-through was never evaluated - was a second fail-open. Halt-fault
reasons keep each fault's detail rather than only its code (Codex P2), matching the limit/compliance shape.
9 composition tests, including regressions for the uncovered-increase hole and for alias coverage.

**What is gated on Matt, and therefore deferred in Phase 5.** Production ingestion on the allowlist needs the
four `BLACKGOLD_*` data credentials; the Alpaca paper adapter and paper-fill reconciliation need paper broker
keys; a real prospective shadow run needs the charter approved (OD-3 and the rest) and real time to pass; the
counterfactual decision ledger, reconciler/steward, cost monitoring, incident records, and runbooks follow as
bounded PRs, several depending on D-17, D-18, D-25. The decision gate needs none of these and composes what
Phase 4 already built, which is why it is first.

---

## Rejected

- **R-01** Postgres/Kafka/Kubernetes/vector DB: no measured need; violates the one-owner maintainability constraint.
- **R-02** Local LLM on the Pi: fixed constraint; RAM and thermal budget do not permit it.
- **R-03** Named multi-agent committee at MVP: agreement among models sharing data is not independent evidence. One bounded Analyst; a Skeptic must win an ablation.
- **R-04** Robinhood adapter: deferred until Matt requests it; interface kept clean.
- **R-05** Placing Black Gold in an existing repository: a live-trading system must not share release tags, CI, or history with unrelated apps.
- **R-06** "Lightweight DGTW": false precision without point-in-time characteristic data. Use VTI total return and exposure-matched blends.
- **R-07** Wall-clock cron for market jobs: holidays, early closes, and DST make `14:45 CT` unreliable. Use an exchange calendar and UTC.
