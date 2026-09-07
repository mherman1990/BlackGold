# Black Gold phase plan

One bounded phase per pull request. Each phase branches from a fresh `origin/main` after the prior PR merges, on `claude/phase-XX-short-name`. A phase ends when its exit criteria are verified with evidence, not when the code is written. Passing an engineering phase never means an investment hypothesis passed.

Owner approval is required to start each phase. Claude Code never begins a later phase because an earlier one finished in the same session.

## Phase 0 (Discovery) - this branch

**Branch:** `claude/black-gold-trading-tool-n713ly` (D-05). **Deliverable:** the Discovery Pack (`docs/DISCOVERY_PACK.md` indexes it). **Stop point:** Matt reviews, records decisions in `docs/DECISIONS.md`, bootstraps `main`, and approves Phase 0 implementation.

Exit: Discovery PR merged; D-02, D-03, D-04, D-06, D-16, D-21 resolved.

## Phase 0 (Implementation) - repository foundation and safe simulations

**Branch:** `claude/phase-00-foundation`. **Depends on:** Discovery approval; UM-07 to UM-09, CR-14, CR-20, CR-21 verified.

Deliver: npm workspaces (`shared`, `core`, `broker-gateway`); TypeScript strict config; lint with dependency-boundary rules; `Dockerfile` (multi-stage, one image, role by command); `umbrel-app-store.yml` and `blackgold-trading/` manifests using approved identifiers; `scripts/check-identity.ts`; config schemas (app, `risk.yaml`, financial picture, restricted list, `LIVE_AUTHORIZATION`) with fake-value examples; SQLite WAL with migrations, online backup, integrity check, restore script; append-only hash-chained ledger with daily seal; exchange calendar with 2026–2027 NYSE schedule fixtures; deterministic scheduler with idempotency keys and missed-run detection; `health` command; synthetic broker adapter with fault injection; notification stub; order state machine skeleton with the full legal-transition table; policy tests (account isolation, live disabled, no secrets, identity); PR template; `ci.yml` with multi-arch build (no push); `release.yml` designed but publishing gated on `v*` tags; `pi-benchmark.sh`.

Exit only when: containers run on the Pi and on Windows Docker; repo contains no unrelated code or copied identifiers; store id prefixes app id and all manifests agree (CI green); no shared volume/secret/port/trigger with another app; CI validates manifests, identity, secrets, and both architectures without production credentials; scheduler survives duplicate execution and reboot; backup/restore and integrity tests pass; synthetic order fault suite passes every transition; no live credential or live order path exists; measured Pi resource use is within `docs/RESOURCE_BUDGET.md`.

Tests: unit, property (ledger chain, idempotency), policy, container smoke on both architectures.

## Phase 1 - Point-in-time research kernel

**Branch:** `claude/phase-01-research-kernel`, stacked on the Phase 0 branch under D-28 (authorized 2026-09-07). **Depends on:** D-09, D-24, D-29, D-30; CR-01, CR-02, CR-04, CR-05 verified 2026-09-06; CR-09 and CR-24 verified 2026-09-07 (entitlement depth measured with a key in Phase 5).

Deliver: `PointInTimeObservation` contract and repository with the `asOf` rule; artifact store (content-addressed, zstd, outside git); adapters for market data (D-24), FRED/ALFRED, SEC submissions (read-only, rate-limited, User-Agent), CFTC COT; raw and adjusted price series with corporate-action events; date-effective universe snapshots and the survivorship label; data-quality rules and reason codes; experiment registry with freeze/viewed/holdout-opened semantics; total-return NAV accounting with decimal arithmetic; conservative fill/cost simulator; benchmark engine (VTI TR, VTI/T-bill blend, SPY); all 16 temporal fixtures from `docs/DATA_PROVENANCE_SPEC.md`.

Exit only when: a future-dated or revised observation cannot enter a past decision (property test); raw versus adjusted usage is enforced by types; split, dividend, delisting, stale-bar, revision, release-lag, early-close, and DST fixtures pass; experiment results reproduce from snapshot ids and hashes; holdout access is controlled and logged.

## Phase 2 - First approved deterministic Alpha Charter

**Branch:** `claude/phase-02-etf-trend-vol` (if D-10 approves it). **Depends on:** Phase 1; charter approved and frozen (`charter.yaml` hash recorded).

Deliver: candidate engine for the approved charter only; leakage audit; coverage report; walk-forward results; holdout protocol (unopened); robustness, cost, delay, and parameter tests; benchmark attribution; a written "reasons it may not work" section.

Exit: predeclared research tests complete and reported. Then stop. Matt accepts, rejects, or revises via a new strategy version. Engineering completion is not investment evidence.

## Phase 3 - Bounded runtime-LLM overlay

**Branch:** `claude/phase-03-analyst`. **Depends on:** Phase 2; D-11; CR-11 to CR-13 re-verified.

Deliver: sealed evidence packet builder from `asOf` reads only; public-source allowlist; `ModelAdapter` (Anthropic first) with pinned model ids from config, structured output, local schema validation, citation verification against packet hashes, bounded retries, deadline, circuit breaker, abstention; prompt-injection defenses and adversarial fixture suite; per-call/day/month budgets; prompt caching measurement; synchronized B0/B1/C1/D1 recording; contamination labels on any historical replay; a locked prospective ablation plan.

Exit only when: adversarial content cannot cause tool calls, secret disclosure, config change, or an executable order (the model has none of those capabilities to begin with, and tests prove the packet path adds none); invalid, late, or uncited responses abstain safely; every input/output/version/cost is archived and redacted; historical results carry contamination labels; the ablation plan is registered. No claim that the LLM is useful is made from memo quality.

## Phase 4 - Household, compliance, portfolio, and risk

**Branch:** `claude/phase-04-risk-compliance`. **Depends on:** Phase 3 (or Phase 2 if Matt defers the LLM); D-12, D-14, D-15, D-20; `risk.yaml` approved.

Deliver: schema-validated financial picture and read-only CSV import; exposure flags and ETF look-through with coverage/staleness; restricted list with immediate additions and cooling-period removals; compliance engine; deterministic portfolio constructor and sizing; risk engine with halt states; table and property tests for every rule boundary.

Exit only when: every hard rule has positive, negative, and boundary tests; unknown and stale states fail closed; factor mismatches reject; sizing is provably invariant to LLM uncertainty; no code path can form or route a non-sleeve mutation.

## Phase 5 - Prospective shadow and paper operations

**Branch:** `claude/phase-05-shadow-paper`. **Depends on:** Phase 4; D-17, D-18, D-25; CR-06 to CR-08 re-verified and ALP-11 to ALP-16 probed.

Deliver: production ingestion on the allowlist; scheduler wired to the exchange calendar; counterfactual decision ledger for all arms; Alpaca paper adapter inside the gateway package; independent fill/cost model; reconciler/steward; reports (CLI, then read-only status page on 8479); cost monitoring; incident records; runbooks for startup, missed jobs, outages, token expiry, disk-full, restore.

Exit: the charter's prospective observation count plus 100% hard-rule enforcement, zero unresolved high-severity incidents, no missing decision records, every paper fill reconciled, paper-versus-simulator differences measured and explained, restarts/missed jobs/rate limits/outages handled within RPO/RTO, and both scorecards reviewed by Matt.

## Phase 6 - Schwab capability spike and gateway

**Branch:** `claude/phase-06-schwab-gateway`. **Depends on:** Phase 5; D-13 resolved in writing; SCH-01 to SCH-14 verified with Matt present.

Deliver: dated Schwab capability document; OAuth, read, account-hash mapping; non-live preview if available; gateway account allowlist and second risk check; full order-state and fault suite on sanitized recorded fixtures; auth-expiry, `UNKNOWN`, partial-fill, child-order, cancel/replace, restart, and recovery drills; runbooks. No live submission.

Exit: capability blockers resolved; blast radius explicitly accepted or automation blocked; drills pass; runbooks complete.

## Phase 7 - Human-approved micro-live

**Branch:** `claude/phase-07-micro-live`. **Depends on:** Phase 6; `LIVE_PROMOTION.md` approved; valid `LIVE_AUTHORIZATION.yaml`.

Deliver: `LIVE_MANUAL` mode at trivial size (D-18). Every approval, submission, fill, protection state, reconciliation, notification, execution-shortfall calculation, halt, and recovery verified against the broker application.

Exit: approved observation count, no unresolved severe incidents, acceptable execution calibration, explicit review. No alpha inference from this sample.

## Phase 8 - Strategy-specific limited automation (optional)

Requires a new written decision showing operational readiness and investment evidence for one immutable strategy/model/prompt/data/risk version. Capital-capped, expiring authorization. Any material change returns to shadow or manual.

## Deferred until separately requested

Options; shorting, margin, leverage, futures, crypto, extended hours; Robinhood; autonomous self-modification of strategy/prompt/risk; broad paid-data integrations; a large agent committee; state-changing web UI; mobile app; multi-user features.

## Cross-phase rules

- Update `STATE.md`, `HANDOFF.md`, and `docs/DECISIONS.md` at every phase boundary.
- Provide a requirements-to-implementation matrix (`implemented` / `tested` / `deferred` / `blocked` / `not applicable`) with evidence in every PR.
- Record exact commands, environment, fixture provenance, and pass/fail output. Never mark a safety requirement complete from code inspection alone.
- Re-verify capability register rows older than 90 days before the phase that depends on them.
