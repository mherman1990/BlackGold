# State

Authoritative snapshot of where Black Gold is. Update at every phase boundary and whenever the authoritative branch or approval status changes.

**Last updated:** 2026-09-07 by Claude Code (Phase 1 implementation session).

## Product state

| Item | Value |
|---|---|
| Phase | Discovery (PR #1), Phase 0 (PR #2), and Phase 1 (PR #3) open and green, awaiting Matt. Phase 1 research kernel complete in code and tests on `claude/phase-01-research-kernel`, stacked on Phase 0 (D-28); Codex review findings fixed (D-31) |
| Application code | `packages/shared`, `packages/core` (Phase 0 foundation plus Phase 1 data, market, universe, research modules), `packages/broker-gateway` |
| Tests | 248 passing across 32 files: unit (shared, core, gateway), policy, and temporal projects; `npm run check` green locally |
| Live trading | Absent by construction. Config loader and gateway both refuse `LIVE_MANUAL` and `LIVE_LIMITED`; CI asserts the image refuses them too |
| Broker credentials | None exist anywhere in this project. Only the synthetic broker adapter exists |
| Runtime LLM | Not integrated (Phase 3). Provider decision D-11 accepted |
| Data ingestion | Adapters exist and are fixture-tested; no live ingest has run (needs SEC contact, FRED key, Alpaca keys from Matt) |
| Umbrel manifests | Written (`umbrel-app-store.yml`, `blackgold-trading/`) and identity-checked; not yet installed anywhere |
| GHCR image | None published. CI built `linux/amd64` and `linux/arm64` successfully on PR #2 without pushing |

## Repository state

| Item | Value |
|---|---|
| Remote | `https://github.com/mherman1990/BlackGold` (public) |
| `main` | Exists (bootstrap commit e7fc3d9). Matt must still set it as default branch and apply protection in GitHub settings |
| PR #1 | Discovery Pack: `claude/black-gold-trading-tool-n713ly` into `main`. Open, awaiting Matt |
| Phase 0 branch | `claude/phase-00-foundation`, stacked on the Discovery branch (D-26) |
| Phase 0 PR | PR #2 against the Discovery branch: CI green, Codex findings fixed and resolved, mergeable. Retarget to `main` after PR #1 merges |
| Phase 1 branch / PR | `claude/phase-01-research-kernel`, [PR #3](https://github.com/mherman1990/BlackGold/pull/3) against the Phase 0 branch: CI green at `e5c6a70`, seven Codex findings fixed and resolved, mergeable once PR #2 merges; retarget as the stack merges |
| Branch protection | Not configured (needs Matt in GitHub UI) |
| CI | `.github/workflows/ci.yml` green on PR #2 and PR #3 (checks + multi-arch image) |

## Decisions

All Discovery recommendations accepted by Matt on 2026-09-06 (see the header of `docs/DECISIONS.md`). Open facts still owed by Matt: whether the sleeve account exists and its type (D-12), backup destination host (D-16), Phase 6 written blast-radius acceptance (D-13), port-collision check on the Pi before first install (D-04).

## Phase 1 exit criteria

See `docs/PHASE1_REQUIREMENTS_MATRIX.md`. All five exit criteria are tested in the repository. Not yet exercised: a live ingest against any source (credentials needed), and the Pi resource measurement of an ingest run.

## Phase 0 exit criteria

See `docs/PHASE0_REQUIREMENTS_MATRIX.md`. Everything verifiable in this repository is `tested`. Two criteria need Matt's hardware: containers running on the Pi and on Windows Docker, and measured Pi resource use against `docs/RESOURCE_BUDGET.md`.

## Capability register status

Verified: 17 (CR-27 added: CFTC COT release schedule follows the federal holiday calendar; 2026 dates reproduced by rule). Partial: 4. UNVERIFIED: 3 (all Schwab rows, Alpaca duplicate client-order-id semantics, Alpaca IEX entitlement). Umbrel packaging, NYSE calendar, and multi-arch CI facts were verified on 2026-09-06.

## Next authorized action

None beyond what this session did. Phase 2 (the first approved Alpha Charter) requires Matt to approve and freeze `strategies/etf-trend-vol/ALPHA_CHARTER.md` and to authorize the phase explicitly. See `HANDOFF.md`.
