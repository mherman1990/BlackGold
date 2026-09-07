# State

Authoritative snapshot of where Black Gold is. Update at every phase boundary and whenever the authoritative branch or approval status changes.

**Last updated:** 2026-09-07 by Claude Code (after PR #9 merged: Phase 0 completion and release prep).

## Product state

| Item | Value |
|---|---|
| Phase | Discovery, Phase 0, Phase 1 and Phase 2 all merged to `main` at `03bf580` on 2026-09-07 (PR #1, #2, #4, #6, #8, #9). Phase 2 **machinery** is complete in code and tests; **no Phase 2 result exists** and none may exist until the charter is approved and data is ingested (D-35) |
| Application code | `packages/shared`, `packages/core` (Phase 0 foundation, Phase 1 data/market/universe/research, Phase 2 strategy/research), `packages/broker-gateway` |
| Tests | 513 passing across 46 files. `npm run check` green locally and in CI on `8ce1de5` |
| Live trading | Absent by construction. Config loader and gateway both refuse `LIVE_MANUAL` and `LIVE_LIMITED`; CI asserts the image refuses them too |
| Broker credentials | None exist anywhere in this project. Only the synthetic broker adapter exists |
| Runtime LLM | Not integrated (Phase 3). The `etf-trend-vol` charter declares no LLM in the signal and only two arms |
| Data ingestion | **FRED is live-verified** as of 2026-09-07: DGS10 ingested, 16,880 observations across 5,103 vintages, 0 conflicts. That first live run found two blocking defects fixtures had missed (CR-28 vintage cap, CR-29 realtime clipping), both fixed. SEC, CFTC and Alpaca adapters remain fixture-tested only; Alpaca still needs the owner's keys |
| First Alpha Charter | `strategies/etf-trend-vol/charter.yaml` exists and is executable, but is `DRAFT`: unsigned, four open decisions unresolved, XLE undecided. `assertRegistrable` refuses it and a CI gate keeps that true |
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

Open facts still owed by Matt: whether the sleeve account exists and its type (D-12), backup destination host (D-16), Phase 6 written blast-radius acceptance (D-13), port-collision check on the Pi before first install (D-04), and the four open decisions inside the charter itself.

## Phase 2 exit criteria

See `docs/PHASE2_REQUIREMENTS_MATRIX.md`. Every criterion verifiable without owner approval and without ingested data is `tested`. One is `blocked`: "predeclared research tests complete and reported" cannot be met, because the charter is DRAFT and no market data exists. That blockage is the honest state, not an oversight - see the matrix's "Why no result exists yet".

## Phase 1 exit criteria

See `docs/PHASE1_REQUIREMENTS_MATRIX.md`. All five are tested. Not yet exercised: a live ingest against any source, and the Pi resource measurement of an ingest run.

## Phase 0 exit criteria

See `docs/PHASE0_REQUIREMENTS_MATRIX.md`. Everything verifiable in this repository is `tested`. Two criteria need Matt's hardware: containers running on the Pi and on Windows Docker, and measured Pi resource use against `docs/RESOURCE_BUDGET.md`.

**Row 9 was wrong for a day and is now corrected.** It claimed the ledger's *daily* seal was `tested` from 2026-09-06 to 2026-09-07. It was not: `sealDaily()` was reachable only from the `seal` CLI, so a deployed `serve` process registered one job (the heartbeat) and never sealed anything. Found by Codex review on PR #8, fixed in PR #9, and the matrix now records what was overstated and for how long.

The lesson generalises, which is why it is here and not only in the matrix: a row citing unit tests of a *mechanism* is weaker evidence than one citing the *deployed path*. Prefer the latter when marking anything `tested`.

## Capability register status

Verified: 17. Partial: 4. UNVERIFIED: 3 (all Schwab rows, Alpaca duplicate client-order-id semantics, Alpaca IEX entitlement). Umbrel packaging, NYSE calendar, and multi-arch CI facts were verified on 2026-09-06.

## Next authorized action

None for code. Everything through Phase 2 plus the Phase 0 seal completion is on `main` and green. The next steps are Matt's, in rough order of what unblocks the most:

1. **Make the GHCR package public** once the first image publishes: github.com/users/mherman1990/packages/container/blackgold/settings -> Change visibility -> Public. A new GHCR package is private by default and umbrelOS pulls anonymously, so the Umbrel install fails with `unauthorized` until this is done. This is now the *only* step in the release chain Claude Code cannot perform; the tag and publish go through a `release.yml` dispatch (D-38).
2. **Confirm or overrule D-32** (book-slot priority between the entry rule and the hysteresis hold rule). The code resolves it provisionally; the prose charter should state it either way before anything is frozen.
3. **Resolve the four open decisions inside `strategies/etf-trend-vol/charter.yaml`**, decide XLE, and sign the approval block. `charter show --path strategies/etf-trend-vol/charter.yaml` prints exactly what is missing and refuses until all of it is filled in.
4. **Provide the data credentials** so an ingest can run: `BLACKGOLD_SEC_USER_AGENT_CONTACT`, `BLACKGOLD_FRED_API_KEY`, `BLACKGOLD_ALPACA_KEY_ID`, `BLACKGOLD_ALPACA_SECRET_KEY`.
5. Set `main` as the default branch and apply protection; delete the three superseded branches listed above.

Steps 2 and 3 are the ones no autonomy reaches, by design — see "What standing authorization never covers" in `CLAUDE.md`. Claude Code signing the charter it wrote would make `assertRegistrable` decorative.

## Review coverage, stated plainly

PR #9 changed the ledger's integrity model and **no external review covered it**. Codex was out of usage budget for its code review on every commit of that PR, and a re-requested security review hit the same limit; the only security pass that completed ran on `d9d8054`, which predates the three commits that matter. The corruption path that PR #9 fixes was found by a local review pass, i.e. by Claude Code reviewing Claude Code.

That is a thinner evidence base than the ledger deserves. It did not block the merge (CI green, fail-closed in direction, no order/account/credential/live path touched, and no capital depends on this build), but a fresh pair of eyes on `packages/core/src/ledger/ledger.ts` and the `seal_ledger` job is worth having before any phase writes at volume.

Phase 3 requires explicit authorization and is not started. Only after 1 to 3 can a registered experiment produce a Phase 2 result; `HANDOFF.md` section 5 is the ordered procedure for that, marking which steps are reversible and which one is not.

**Merge order matters in this repository.** Twice a phase PR was merged into a base branch that had already been merged forward, leaving `main` a phase behind (PR #3 for Phase 1, PR #5 for Phase 2). A stacked PR must be retargeted to `main` *before* it is merged, or merged before its base goes in. D-36 records the rule.
