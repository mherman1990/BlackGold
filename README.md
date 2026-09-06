# Black Gold

Black Gold is a self-hosted, evidence-first research and controlled-execution platform for a small, ring-fenced investment sleeve. It runs as an Umbrel app on a Raspberry Pi 5 and is built to answer one question honestly: does a versioned systematic strategy, and separately a bounded runtime-LLM research layer, add after-cost, risk-adjusted value versus simple investable alternatives?

The name is a play on Iowa's black soil and on oil. The product is not an LLM that trades. Deterministic code owns every number and every hard boundary. The runtime LLM produces research, never orders and never position sizes. A valid outcome is discovering that a strategy, or the LLM layer, does not work.

## Status

Discovery. No application code exists yet. The Discovery Pack is complete and awaits owner approval before Phase 0 begins. Start with `docs/DISCOVERY_PACK.md`, then `STATE.md` and `HANDOFF.md`.

## Fixed constraints

- Host: Raspberry Pi 5, 8 GB, NVMe, umbrelOS. Windows Docker fallback with no source changes.
- Runtime: Node.js 24 LTS, TypeScript, SQLite WAL, ARM64 and AMD64 containers.
- Live trading is disabled by construction through the early phases and can never be enabled by a single environment variable.
- Exactly one account carries the role `blackgold_sleeve`. Every other account is read-only.
- Only allowlisted public data sources. No workplace connectors exist in the application.
- Long-only, unlevered, cash-funded U.S.-listed ETFs and equities during regular hours. No options, shorting, margin, crypto, or extended hours.

## Layout

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Stable instructions for Claude Code sessions working in this repository |
| `PLAN.md`, `STATE.md`, `HANDOFF.md` | Phase plan, current authoritative state, and resume instructions |
| `docs/` | Product specification, decisions, protocols, threat model, capability registers |
| `strategies/` | Draft Alpha Charters, one directory per strategy |
| `.claude/rules/` | Path-scoped review rules for financial-critical code |

## Not investment advice

Every number in this repository is an engineering default or a proposal for the owner to approve or replace. Nothing here is personalized investment, tax, or legal advice.
