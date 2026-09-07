# State

Authoritative snapshot of where Black Gold is. Update at every phase boundary and whenever the authoritative branch or approval status changes.

**Last updated:** 2026-09-07 by Claude Code (Phase 2 implementation session).

## Product state

| Item | Value |
|---|---|
| Phase | Discovery (PR #1) and Phase 0 (PR #2) merged to `main`. Phase 1 complete on [PR #4](https://github.com/mherman1990/BlackGold/pull/4) (draft, awaiting Matt). Phase 2 **machinery** complete in code and tests; **no Phase 2 result exists** and none may exist until the charter is approved and data is ingested (D-35) |
| Application code | `packages/shared`, `packages/core` (Phase 0 foundation, Phase 1 data/market/universe/research, Phase 2 strategy/research), `packages/broker-gateway` |
| Tests | 494 passing across 45 files: unit 439, policy 29, temporal 26. `npm run check` green locally |
| Live trading | Absent by construction. Config loader and gateway both refuse `LIVE_MANUAL` and `LIVE_LIMITED`; CI asserts the image refuses them too |
| Broker credentials | None exist anywhere in this project. Only the synthetic broker adapter exists |
| Runtime LLM | Not integrated (Phase 3). The `etf-trend-vol` charter declares no LLM in the signal and only two arms |
| Data ingestion | Adapters exist and are fixture-tested; **no live ingest has run** (needs SEC contact, FRED key, Alpaca keys from Matt) |
| First Alpha Charter | `strategies/etf-trend-vol/charter.yaml` exists and is executable, but is `DRAFT`: unsigned, four open decisions unresolved, XLE undecided. `assertRegistrable` refuses it and a CI gate keeps that true |
| Registered experiments | None. No experiment has been registered, no result computed, no holdout opened |
| Umbrel manifests | Written (`umbrel-app-store.yml`, `blackgold-trading/`) and identity-checked; not yet installed anywhere |
| GHCR image | None published. CI built `linux/amd64` and `linux/arm64` successfully on PR #2 without pushing |

## Repository state

| Item | Value |
|---|---|
| Remote | `https://github.com/mherman1990/BlackGold` (public) |
| `main` | At `bbc7077`: Discovery plus Phase 0. Matt must still set `main` as the default branch and apply protection in GitHub settings |
| Phase 1 PR | [PR #4](https://github.com/mherman1990/BlackGold/pull/4), `claude/phase-01-research-kernel` into `main`. Draft, CI green, Codex findings fixed (D-31). Next owner action: mark ready and merge |
| Phase 2 branch | `claude/black-gold-continued-rxiesj`, stacked on the Phase 1 branch (Phase 1 is not yet on `main`) |
| Branch protection | Not configured (needs Matt in GitHub UI) |
| CI | `.github/workflows/ci.yml` green on PR #2, PR #3 and PR #4 (checks plus multi-arch image) |

## Decisions

All Discovery recommendations accepted by Matt on 2026-09-06 (see the header of `docs/DECISIONS.md`). Phase 2 added D-32 to D-35.

**D-32 needs the owner's confirmation before the charter is frozen.** The prose charter's entry rule and its hysteresis hold rule can name six ETFs for a five-slot book, and section 9 does not say which yields. The code resolves it in favour of the incumbent, because resolving by rank alone would make the hysteresis band dead code whenever five names are eligible. If Matt intends the opposite, section 8 of `ALPHA_CHARTER.md` needs a sentence and the code needs a one-line change; either way the prose should say so explicitly before anything is frozen.

Open facts still owed by Matt: whether the sleeve account exists and its type (D-12), backup destination host (D-16), Phase 6 written blast-radius acceptance (D-13), port-collision check on the Pi before first install (D-04), and the four open decisions inside the charter itself.

## Phase 2 exit criteria

See `docs/PHASE2_REQUIREMENTS_MATRIX.md`. Every criterion verifiable without owner approval and without ingested data is `tested`. One is `blocked`: "predeclared research tests complete and reported" cannot be met, because the charter is DRAFT and no market data exists. That blockage is the honest state, not an oversight - see the matrix's "Why no result exists yet".

## Phase 1 exit criteria

See `docs/PHASE1_REQUIREMENTS_MATRIX.md`. All five are tested. Not yet exercised: a live ingest against any source, and the Pi resource measurement of an ingest run.

## Phase 0 exit criteria

See `docs/PHASE0_REQUIREMENTS_MATRIX.md`. Everything verifiable in this repository is `tested`. Two criteria need Matt's hardware: containers running on the Pi and on Windows Docker, and measured Pi resource use against `docs/RESOURCE_BUDGET.md`.

## Capability register status

Verified: 17. Partial: 4. UNVERIFIED: 3 (all Schwab rows, Alpaca duplicate client-order-id semantics, Alpaca IEX entitlement). Umbrel packaging, NYSE calendar, and multi-arch CI facts were verified on 2026-09-06.

## Next authorized action

None beyond what this session did. The next step is Matt's, not code's: merge PR #4, then approve and freeze the charter (which resolves D-32 and the four open decisions) and provide the data credentials. Only then can a registered experiment produce a Phase 2 result. See `HANDOFF.md`.
