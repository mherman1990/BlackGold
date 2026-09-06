# State

Authoritative snapshot of where Black Gold is. Update at every phase boundary and whenever the authoritative branch or approval status changes.

**Last updated:** 2026-09-06 by Claude Code (Discovery session).

## Product state

| Item | Value |
|---|---|
| Phase | 0 (Discovery) complete; Phase 0 implementation NOT started |
| Application code | None exists |
| Live trading | Absent (no code path) |
| Broker credentials | None exist anywhere in this project |
| Runtime LLM | Not selected (D-11 proposed) |
| Umbrel install | None |
| GHCR image | None published |

## Repository state

| Item | Value |
|---|---|
| Remote | `https://github.com/mherman1990/BlackGold` (public) |
| `main` | Does not exist yet. Bootstrap per `docs/REPOSITORY_AND_PR_WORKFLOW.md` (D-02) |
| Authoritative branch | `claude/black-gold-trading-tool-n713ly` |
| Branch contents | Commit 1: `README.md`, `.gitignore` (bootstrap). Commit 2+: Discovery Pack |
| Open PR | None (Matt opens after creating `main`) |
| Branch protection | Not configured |
| CI | None |

## Decisions awaiting Matt

See `docs/DECISIONS.md`. Blocking Phase 0 implementation: D-02 (bootstrap method), D-03, D-04, D-06, D-16, D-21. Blocking later phases: D-08 to D-15, D-17 to D-20, D-24, D-25.

## Capability register status

23 rows. Verified: 12. Partial: 5. UNVERIFIED: 6, of which all Schwab rows (CR-10) and Umbrel data-dir/exports semantics (CR-17) must be resolved before the phases that depend on them. See `docs/CAPABILITY_REGISTER.md`.

## Known gaps

See `docs/ASSUMPTIONS_AND_GAPS.md`. Highest impact: Schwab capabilities unverified; port 8479 collision unchecked on Matt's Pi; market data source for the ETF track undecided; whether the sleeve account exists and its tax type.

## Next authorized action

None beyond pushing this Discovery branch. Everything else waits for Matt's review.
