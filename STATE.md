# State

Authoritative snapshot of where Black Gold is. Update at every phase boundary and whenever the authoritative branch or approval status changes.

**Last updated:** 2026-09-07 by Claude Code (Phase 0 implementation session).

## Product state

| Item | Value |
|---|---|
| Phase | Discovery complete (PR #1 open). Phase 0 implementation complete in code and tests; awaiting owner review and the two hardware-dependent exit criteria |
| Application code | `packages/shared`, `packages/core`, `packages/broker-gateway` (Phase 0 scope only) |
| Tests | 122 passing across 15 files: unit (shared, core, gateway) and policy projects; `npm run check` green |
| Live trading | Absent by construction. Config loader and gateway both refuse `LIVE_MANUAL` and `LIVE_LIMITED`; CI asserts the image refuses them too |
| Broker credentials | None exist anywhere in this project. Only the synthetic broker adapter exists |
| Runtime LLM | Not integrated (Phase 3). Provider decision D-11 accepted |
| Umbrel manifests | Written (`umbrel-app-store.yml`, `blackgold-trading/`) and identity-checked; not yet installed anywhere |
| GHCR image | None published. CI builds `linux/amd64` and `linux/arm64` on every PR without pushing |

## Repository state

| Item | Value |
|---|---|
| Remote | `https://github.com/mherman1990/BlackGold` (public) |
| `main` | Exists (bootstrap commit e7fc3d9). Matt must still set it as default branch and apply protection in GitHub settings |
| PR #1 | Discovery Pack: `claude/black-gold-trading-tool-n713ly` into `main`. Open, awaiting Matt |
| Phase 0 branch | `claude/phase-00-foundation`, stacked on the Discovery branch (D-26) |
| Phase 0 PR | Opened by this session against the Discovery branch; retarget to `main` after PR #1 merges |
| Branch protection | Not configured (needs Matt in GitHub UI) |
| CI | `.github/workflows/ci.yml` runs on PRs; first run happens on the Phase 0 PR |

## Decisions

All Discovery recommendations accepted by Matt on 2026-09-06 (see the header of `docs/DECISIONS.md`). Open facts still owed by Matt: whether the sleeve account exists and its type (D-12), backup destination host (D-16), Phase 6 written blast-radius acceptance (D-13), port-collision check on the Pi before first install (D-04).

## Phase 0 exit criteria

See `docs/PHASE0_REQUIREMENTS_MATRIX.md`. Everything verifiable in this repository is `tested`. Two criteria need Matt's hardware: containers running on the Pi and on Windows Docker, and measured Pi resource use against `docs/RESOURCE_BUDGET.md`.

## Capability register status

Verified: 16. Partial: 4. UNVERIFIED: 3 (all Schwab rows, Alpaca duplicate client-order-id semantics, Alpaca IEX entitlement). Umbrel packaging, NYSE calendar, and multi-arch CI facts were verified on 2026-09-06.

## Next authorized action

None beyond what this session did. Phase 1 requires explicit authorization after the Phase 0 PR is reviewed. See `HANDOFF.md`.
