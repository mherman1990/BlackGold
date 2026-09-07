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

## Rejected

- **R-01** Postgres/Kafka/Kubernetes/vector DB: no measured need; violates the one-owner maintainability constraint.
- **R-02** Local LLM on the Pi: fixed constraint; RAM and thermal budget do not permit it.
- **R-03** Named multi-agent committee at MVP: agreement among models sharing data is not independent evidence. One bounded Analyst; a Skeptic must win an ablation.
- **R-04** Robinhood adapter: deferred until Matt requests it; interface kept clean.
- **R-05** Placing Black Gold in an existing repository: a live-trading system must not share release tags, CI, or history with unrelated apps.
- **R-06** "Lightweight DGTW": false precision without point-in-time characteristic data. Use VTI total return and exposure-matched blends.
- **R-07** Wall-clock cron for market jobs: holidays, early closes, and DST make `14:45 CT` unreliable. Use an exchange calendar and UTC.
