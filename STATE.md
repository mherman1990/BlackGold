# State

Authoritative snapshot of where Black Gold is. Update at every phase boundary and whenever the authoritative branch or approval status changes.

**Last updated:** 2026-09-08 by Claude Code (Phase 5 decision gate merged as PR #35; owner signed the charter + `risk.yaml`, recorded as D-48).

## Product state

| Item | Value |
|---|---|
| Phase | Discovery, Phase 0, Phase 1 and Phase 2 all merged to `main` at `03bf580` on 2026-09-07 (PR #1, #2, #4, #6, #8, #9). **Phase 3 machinery** (runtime-LLM analyst overlay) merged 2026-09-07 (PR #22, #23, #25; `main` at `9238e94`). Phase 2 and Phase 3 are both **machinery** complete in code and tests; **no Phase 2 result and no LLM/live call exists**, and no result may exist until data is ingested AND the owner confirms D-32 (book-slot priority, an outstanding confirmation `assertRegistrable` does not check) — the charter is otherwise approved (D-48); both gate a registered result (D-35). Phase 4 engines and the Phase 5 decision gate (PR #35) are also merged |
| Application code | `packages/shared`, `packages/core` (Phase 0 foundation, Phase 1 data/market/universe/research, Phase 2 strategy/research), `packages/broker-gateway` |
| Tests | 692 passing. `npm run check` green locally on the Phase 5 decision-gate branch |
| Live trading | Absent by construction. Config loader and gateway both refuse `LIVE_MANUAL` and `LIVE_LIMITED`; CI asserts the image refuses them too |
| Broker credentials | None exist anywhere in this project. Only the synthetic broker adapter exists |
| Runtime LLM | **Phase 3 machinery merged to `main`** (PR #22, #23, #25): provider-agnostic analyst pipeline + safety surface, the Anthropic adapter behind the single egress module, call archiving/budget persistence, the `research analyst` CLI, and status-page visibility. **No live call has been made** — no key is on the Pi and the one CR-12/CR-13 verification run is still pending. The `etf-trend-vol` charter declares no LLM in the signal and only two arms, so nothing wires the analyst into a decision |
| Data ingestion | **All four adapters live-verified 2026-09-07.** FRED (16,880 obs / 5,103 vintages), SEC EDGAR (1,590 obs), CFTC COT (34 obs), Alpaca IEX bars (340 obs / 170 sessions). **Two of the four failed on their first real request** - FRED on CR-28 and CR-29, SEC on CR-30 - all fixed and tested. CFTC and Alpaca passed first time. No production ingest schedule is wired yet (Phase 5) |
| First Alpha Charter | `strategies/etf-trend-vol/charter.yaml` is **APPROVED** — owner-signed 2026-09-08 (state `APPROVED`, `charter_version 0.1.0`, `approved_by "Matt Herman"`, `code_commit 474d0dc`, `approval_ref docs/DECISIONS.md#D-39`); all four open decisions resolved (D-39), XLE excluded (12-ETF universe). `assertRegistrable` now passes, and the tripwire test asserts the signed state (PR #36). Registrable, but **nothing may be registered until market data is ingested AND the owner confirms D-32** (book-slot priority — `assertRegistrable` does not check it; see D-48 and HANDOFF §5 step 4) |
| Registered experiments | None. No experiment has been registered, no result computed, no holdout opened |
| Umbrel manifests | Written (`umbrel-app-store.yml`, `blackgold-trading/`) and identity-checked; not yet installed anywhere |
| GHCR image | **None published yet.** Unblocked as of D-38: dispatching `release.yml` with a version now tags and publishes without needing a tag push. One manual step remains on the first publish - a new GHCR package is private by default and umbrelOS pulls anonymously, so Matt must flip it to public. CI has built `linux/amd64` and `linux/arm64` successfully many times without pushing |

## Repository state

| Item | Value |
|---|---|
| Remote | `https://github.com/mherman1990/BlackGold` (public) |
| `main` | At `03bf580`. Matt must still set `main` as the default branch and apply protection in GitHub settings |
| Phase 1 PR | [PR #4](https://github.com/mherman1990/BlackGold/pull/4) merged to `main` 2026-09-07 12:56:35Z |
| Phase 2 PRs | [PR #5](https://github.com/mherman1990/BlackGold/pull/5) merged 12:56:48Z into `claude/phase-01-research-kernel`, which PR #4 had already merged forward, so it never reached `main` (D-36). [PR #6](https://github.com/mherman1990/BlackGold/pull/6) carried the same tree to `main` and merged 13:24Z |
| Phase 0 completion PR | [PR #8](https://github.com/mherman1990/BlackGold/pull/8) (release prep) merged 2026-09-07. [PR #9](https://github.com/mherman1990/BlackGold/pull/9) merged 2026-09-07 as `03bf580`: the scheduled daily ledger seal, the three guards that make automatic sealing safe, the ingest event-stamp fix, and the suite-wide test timeout |
| Working branch | `claude/black-gold-continued-rxiesj`, merged and reset to `origin/main`. Restart it from `origin/main` for any follow-up work |
| Stale branches | `claude/phase-00-foundation`, `claude/black-gold-trading-tool-n713ly` and `claude/phase-01-research-kernel`. **Verified safe to delete:** each carries zero non-merge commits absent from `main`, and their only commits beyond it are orphan merge commits left by the D-36 incident. Claude Code cannot delete them (see below); Matt or wider permissions must. Leaving them is what made the D-36 mis-merge easy to repeat |
| Branch protection | Not configured (needs Matt in GitHub UI) |
| **Claude Code git permissions** | This session may commit, push to its own `claude/*` branch, open, update and merge PRs. It **cannot create tag refs or delete refs**: `git push origin v0.1.0` and `git push origin --delete <branch>` both return HTTP 403 from GitHub on every attempt, while ordinary branch pushes to the same repo succeed and the agent proxy reports healthy with no relay failures. Not a transient error and not worth retrying. **Worked around for releases** by D-38: `release.yml` accepts a `workflow_dispatch` version and creates the tag itself after checks pass, so the release chain no longer needs Matt. Ref *deletion* has no workaround, so merged branches still do |
| CI | `.github/workflows/ci.yml` green on every PR through #9 (checks plus multi-arch image build). `testTimeout` is 30 s suite-wide after two runs disagreed on identical commits; see `HANDOFF.md` §7 |

## Decisions

All Discovery recommendations accepted by Matt on 2026-09-06 (see the header of `docs/DECISIONS.md`). Phase 2 added D-32 to D-36; D-37 grants Claude Code standing git and GitHub authority, with the carve-outs in `CLAUDE.md` that no autonomy reaches.

**D-32 needs the owner's confirmation before the charter is frozen.** The prose charter's entry rule and its hysteresis hold rule can name six ETFs for a five-slot book, and section 9 does not say which yields. The code resolves it in favour of the incumbent, because resolving by rank alone would make the hysteresis band dead code whenever five names are eligible. If Matt intends the opposite, section 8 of `ALPHA_CHARTER.md` needs a sentence and the code needs a one-line change; either way the prose should say so explicitly before anything is frozen.

Open facts still owed by Matt: whether the sleeve account exists and its type (D-12), backup destination host (D-16), Phase 6 written blast-radius acceptance (D-13), and the port-collision check on the Pi before first install (D-04). The charter's four open decisions are resolved (D-39) and its approval block is signed (D-48).

## External context: Granary (separate product, added 2026-09-07)

Matt is building the household / personal-finance / capital-allocation layer as a **separate** product, **Granary** (`mherman1990/Granary`, Umbrel app `granary`, port 3000), which sits *above* Black Gold and will eventually read Black Gold data. This changes Black Gold's Phase 4 scope: Black Gold does **not** become the household book of record and does **not** take any dependency on Granary. Integration is one-way (Granary reads Black Gold, never the reverse) and Black Gold's existing boundaries (no inbound nonpublic/household connector, no household dollars to a model, no money movement) are the safety guarantee. Recorded as **D-40 (Proposed)**; it blocks no current work and awaits Matt's acceptance before any Phase 4 household work. Do not rebuild the household layer inside this repository. The read-only export Granary would consume is designed (dollar-free by construction) in `docs/GRANARY_EXPORT_CONTRACT.md` (Proposed): Black Gold exports weights and states, never dollars or accounts, and Granary supplies the dollar denominator. Building it is a Phase 4/5 PR, authorized on its own.

## Phase 3 status (2026-09-07)

Phase 3 (bounded runtime-LLM analyst overlay) was authorized by Matt (D-41) and is **merged to `main`** ([PR #22](https://github.com/mherman1990/BlackGold/pull/22)). The **provider-agnostic pipeline and its full safety surface are built and tested** with a deterministic stub adapter (no credentials, no network): `ResearchAssessment` schema + validator, sealed evidence packet + serialization guard, `ModelAdapter` + `runAssessment` orchestration (budgets, deadline, retries, circuit breaker, no silent fallback, abstention), B0/B1/C1/D1 overlay primitives with contamination labels, the model capability manifest + fail-closed resolver, the adversarial corpus, the T-05 no-LLM-in-sizing CI gate, and the locked ablation plan (`docs/PHASE3_ABLATION_PLAN.md`). ~55 new tests; `npm run check` green.

The **real Anthropic adapter is now built** in a follow-up PR (D-42, branch `claude/phase-03-provider-adapter`): `AnthropicAdapter` over the single model-egress module `packages/core/src/model/provider-http.ts` (raw `fetch`, no SDK), with `live-disabled.test.ts` updated to allow `api.anthropic.com` + the POST in exactly that module while trading hosts stay forbidden and `data/http.ts` stays POST-free; the compose passes `ANTHROPIC_API_KEY` through (empty default). Request/response mapping is tested against a mock transport; no key is in the repo (Matt rotated the one pasted in chat).

**Still deferred, by design — see `docs/PHASE3_REQUIREMENTS_MATRIX.md`:** one live verification run against the real API on the Pi (CR-12/CR-13 — exact wire shape, latency, cache); persistence of the model-call record and running budget; and wiring C1/D1 into the decision loop (prospective, Phase 5). No live trading mode, broker credential, or trading-host egress is added. No LLM output can set a size, choose an account, or form an order.

**Phase 3 completion (merged to `main` at `9238e94`, [PR #25](https://github.com/mherman1990/BlackGold/pull/25), 2026-09-07):** call archiving + budget persistence (migration `0007` `model_calls`, `research/model-call-log.ts`), the analyst wiring (`analyst/run-analyst.ts` + a `research analyst` CLI command reading `ANTHROPIC_API_KEY` in `config/load.ts` only), and operator visibility of the archived-call count on the read-only status page (`EvidenceStatus.modelCalls`, count-only within the page's A3/T-22 constraints) are built and tested with a stub adapter. This closes the "archive everything" criterion. Unlike PR #9, this PR got an independent pass: the Codex security review completed on `ce4c41c` with no findings. **Still open:** the live CR-12/CR-13 run (needs a key on the Pi) and C1/D1 backtest wiring (Phase 5, review-gated). The `research analyst` command fails closed without a key and makes no call.

## Phase 4 status (2026-09-07)

Phase 4 (household-minimum, compliance, restricted list, portfolio construction, sizing, risk engine) was authorized by Matt (D-43) and is being built as a sequence of bounded PRs, unblocked pieces first, because several deliverables depend on `risk.yaml` approval and the sleeve account (D-12).

**First Phase 4 PR — the deterministic factor classifier (branch `claude/phase-04-factor-classifier`):** a `factors` block in the charter schema (`taxonomy` + per-symbol `assignments`, hash-covered) is the code-side authority the Analyst's `factorsTouched` is checked against; `packages/core/src/strategy/factors.ts` classifies a candidate and the `research analyst` CLI now derives the factor set from the charter and refuses an unclassified candidate (unknown classification blocks new risk), replacing the `--factors` flag. The etf-trend-vol charter carries a **conservative starting map that is Matt's to review/edit before signing** — the factor values are not owner-approved, and editing them is his act, like signing.

**Second Phase 4 PR — the risk halt-state machine (D-44, branch `claude/phase-04-risk-halt-engine`):** `packages/core/src/risk/halt.ts` (`evaluateHaltState`) is the deterministic risk safety core. It returns `NORMAL`, `HALT_NEW_RISK`, or `HOLD_ONLY` — never `EMERGENCY_FLATTEN_AUTHORIZED` — from sleeve NAV/HWM/session-start NAV, staleness/incident signals, and the `risk.yaml` thresholds: drawdown, daily loss, stale input, expired auth, unknown state, and severe incident all fail closed to `HALT_NEW_RISK` (or `HOLD_ONLY` at the deeper drawdown); automatic flatten never happens; escalation is automatic and relaxation needs an owner re-arm that an active fault still overrides. Sizing (`strategy/construct.ts`) and the risk-policy schema/defaults (`RiskConfigSchema`, `config/examples/risk.yaml`, D-15) already existed, so this closes the "risk engine with halt states" gap. **`risk.yaml` is now owner-approved:** Matt signed the approval block himself on 2026-09-08 (`approvedBy "Matt Herman"`), resolving OD-3 (D-48). Claude Code did not perform the signature — approving the defaults is one of the acts no autonomy reaches. The engine consumes an approved policy now, but still forms no order and runs nothing for real: that path additionally needs ingested data, the registry call, and a `LIVE_AUTHORIZATION`.

**Third Phase 4 PR — the risk-limit/caps engine (D-45, branch `claude/phase-04-risk-limits`):** `packages/core/src/risk/limits.ts` (`evaluateRiskLimits`) is the deterministic `RiskEngine` verdict — an independent re-check of a proposed target book against the `risk.yaml` caps and the charter, separate from construction, that admits or rejects with reason codes and never re-sizes. Checks: per-instrument weight, open-position count, gross/net exposure, cash floor, sector concentration, correlated-cluster weight and membership, and the long-only posture; fail-closed on an unclassified holding. Pure (T-05, under `risk/`). 11 tests. **Factor concentration is deferred on a real owner question** (the taxonomy's `market` tag is on every holding, so capping summed `market` weight would cap total exposure — which factor tags are cap-bearing is a policy decision); liquidity, order-level, and per-position-risk-budget limits need order/price/ADV data and are follow-ups.

**Fourth Phase 4 PR — the compliance engine (D-46, branch `claude/phase-04-compliance-restricted`):** `packages/core/src/compliance/engine.ts` (`evaluateCompliance`) is the deterministic compliance verdict — admit/reject a candidate against the restricted list with reason codes, pure. It encodes the D-14 rules: additions immediate, removals wait a cooling period (`pendingRemovals` until `eligibleAt`); blackout windows block only new risk; a stale list fails closed. Themes are checked against supplied exposures. 6 tests. **The restricted-list *content* is Matt's**, not Claude Code's: it encodes his nonpublic professional restrictions (employer, suppliers, themes), so `config/examples/restricted-list.yaml` keeps fake placeholders and populating the real list is the owner's act (like approving `risk.yaml`). ETF **look-through** (deriving an ETF's restricted-theme exposures) is a deferred Phase 4 piece — the engine takes exposures as input.

**Still to come in Phase 4:** ETF look-through + exposure flags, the deferred limit engines (factor concentration once the cap-bearing tags are decided; liquidity/order-level/per-position-risk), and wiring the research/compliance/risk/limit verdicts + construction into the decision loop (Phase 5) — each a further bounded PR. `risk.yaml` (OD-3) is now approved, so the remaining gates are the real restricted list, ingested data, and the sleeve account (D-12) where they depend on them.

## Phase 5 status (2026-09-08)

Phase 5 (composing the deterministic verdicts into one go/no-go and, downstream, the prospective decision loop) was authorized by Matt (D-47) and is being built as bounded PRs, deterministic composition first.

**First Phase 5 PR — the deterministic decision gate (D-47, merged to `main` as PR #35):** `packages/core/src/decision/gate.ts` (`evaluateDecisionGate`) is the single place that composes the three independent Phase 4 verdicts into one go/no-go for **new risk**: new risk may proceed iff the halt state is `NORMAL` **and** the proposed target book respects every risk limit **and** every candidate newly taking risk clears compliance. Fail-closed by construction — any single block makes `newRiskAllowed` false, and the blocking reasons are flattened into `blockedBy` for the decision record. It forms no order and never re-sizes; it decides only whether the deterministically-constructed target may be acted on. Compliance is always evaluated as **new risk** for each candidate (the gate fixes `isNewRisk: true`), because the gate's whole question is whether new exposure may be added. **Compliance coverage is enforced, not trusted** (Codex P1): the gate takes the current book too and derives the holdings taking new/increased risk (`target > current`); an increase with no supplied compliance evaluation fails closed (`MISSING_COMPLIANCE`), while a held-flat or reduced position needs no candidate. Coverage binds each increasing holding to its candidate by canonical key, not by the candidate's alias set (a second Codex P1 on the fix), so one clean candidate can't cover another holding it merely lists as an identifier. Pure and under `decision/`, composing only `risk/` and `compliance/`, so no model output can reach it (T-05). 9 composition tests. The equivalent guards run again in the broker gateway; this is the core-side gate.

**Still to come in Phase 5:** wiring construction + the analyst overlay (C1/D1) into the gate to produce a persisted counterfactual decision ledger; the prospective paper/shadow run (needs paper keys); production ingestion scheduling; the reconciler/steward and incident records; and cost monitoring — each a further bounded PR. `risk.yaml` (OD-3) and the charter signature are both done now, so the remaining gates are the real restricted list, credentials/ingested data, and the sleeve account (D-12) where they depend on them.

## Phase 2 exit criteria

See `docs/PHASE2_REQUIREMENTS_MATRIX.md`. Every criterion verifiable without owner approval and without ingested data is `tested`. One is `blocked`: "predeclared research tests complete and reported" cannot be met — the charter is now signed and registrable, but no market data has been ingested, so no result may be computed yet. That blockage is the honest state, not an oversight - see the matrix's "Why no result exists yet".

## Phase 1 exit criteria

See `docs/PHASE1_REQUIREMENTS_MATRIX.md`. All five are tested. Not yet exercised: a live ingest against any source, and the Pi resource measurement of an ingest run.

## Phase 0 exit criteria

See `docs/PHASE0_REQUIREMENTS_MATRIX.md`. Everything verifiable in this repository is `tested`. Two criteria need Matt's hardware: containers running on the Pi and on Windows Docker, and measured Pi resource use against `docs/RESOURCE_BUDGET.md`.

**Row 9 was wrong for a day and is now corrected.** It claimed the ledger's *daily* seal was `tested` from 2026-09-06 to 2026-09-07. It was not: `sealDaily()` was reachable only from the `seal` CLI, so a deployed `serve` process registered one job (the heartbeat) and never sealed anything. Found by Codex review on PR #8, fixed in PR #9, and the matrix now records what was overstated and for how long.

The lesson generalises, which is why it is here and not only in the matrix: a row citing unit tests of a *mechanism* is weaker evidence than one citing the *deployed path*. Prefer the latter when marking anything `tested`.

## Capability register status

Verified: 17. Partial: 4. UNVERIFIED: 3 (all Schwab rows, Alpaca duplicate client-order-id semantics, Alpaca IEX entitlement). Umbrel packaging, NYSE calendar, and multi-arch CI facts were verified on 2026-09-06.

## Next authorized action

The four Phase 4 deterministic engines (factor classifier, halt-state machine, risk-limit engine, compliance engine) and the first Phase 5 slice (the deterministic decision gate, PR #35) are on `main` and green; the owner has signed the charter and `risk.yaml`. **Phase 4 still has deferred work** — ETF look-through + exposure flags, and the factor/liquidity/order-level/per-position limit engines (see the Phase 4 section above); "the four engines are built" is not "all of Phase 4 is done". The remaining Phase 4 and Phase 5 pieces are gated on Matt's inputs (data credentials, the real restricted list, paper broker keys) and are not started autonomously without them. The one live CR-12/CR-13 analyst run still needs a key on the Pi. The next steps are Matt's, in rough order of what unblocks the most:

1. **Make the GHCR package public** once the first image publishes: github.com/users/mherman1990/packages/container/blackgold/settings -> Change visibility -> Public. A new GHCR package is private by default and umbrelOS pulls anonymously, so the Umbrel install fails with `unauthorized` until this is done. This is now the *only* step in the release chain Claude Code cannot perform; the tag and publish go through a `release.yml` dispatch (D-38).
2. **Confirm or overrule D-32** (book-slot priority between the entry rule and the hysteresis hold rule). The code resolves it provisionally; the prose charter should state it either way before anything is frozen.
3. ~~Resolve the charter's open decisions, decide XLE, and sign the approval block.~~ **Done 2026-09-08** (D-39 resolutions, D-48 signature). `charter show --path strategies/etf-trend-vol/charter.yaml` now reports `registrable: true`. Registering an experiment still needs ingested data first (step 4).
4. **Provide the data credentials** so an ingest can run: `BLACKGOLD_SEC_USER_AGENT_CONTACT`, `BLACKGOLD_FRED_API_KEY`, `BLACKGOLD_ALPACA_KEY_ID`, `BLACKGOLD_ALPACA_SECRET_KEY`.
5. Set `main` as the default branch and apply protection; delete the three superseded branches listed above.

Step 2 is one no autonomy reaches, by design — see "What standing authorization never covers" in `CLAUDE.md`. Step 3 was such an act too, and Matt performed it himself on 2026-09-08; Claude Code signing the charter it wrote would have made `assertRegistrable` decorative.

## Review coverage, stated plainly

PR #9 changed the ledger's integrity model and **no external review covered it**. Codex was out of usage budget for its code review on every commit of that PR, and a re-requested security review hit the same limit; the only security pass that completed ran on `d9d8054`, which predates the three commits that matter. The corruption path that PR #9 fixes was found by a local review pass, i.e. by Claude Code reviewing Claude Code.

That is a thinner evidence base than the ledger deserves. It did not block the merge (CI green, fail-closed in direction, no order/account/credential/live path touched, and no capital depends on this build), but a fresh pair of eyes on `packages/core/src/ledger/ledger.ts` and the `seal_ledger` job is worth having before any phase writes at volume.

Phase 3 requires explicit authorization and is not started. Only after 1 to 3 can a registered experiment produce a Phase 2 result; `HANDOFF.md` section 5 is the ordered procedure for that, marking which steps are reversible and which one is not.

**Merge order matters in this repository.** Twice a phase PR was merged into a base branch that had already been merged forward, leaving `main` a phase behind (PR #3 for Phase 1, PR #5 for Phase 2). A stacked PR must be retargeted to `main` *before* it is merged, or merged before its base goes in. D-36 records the rule.
