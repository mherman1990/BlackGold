# Changelog

Written for the operator. Each entry states what changed, why it matters, required actions, risk impact, migration, and rollback. The top heading's version must match `package.json`, `blackgold-trading/umbrel-app.yml`, and the compose image tag (CI enforces this).

## 0.1.0

Phase 0 foundation. Not yet released to GHCR or installed on any Umbrel device.

**What changed**

- Workspace with three packages: `shared`, `core`, `broker-gateway`.
- Configuration schemas for app, `risk.yaml`, financial picture, restricted list, and `LIVE_AUTHORIZATION`, with fake-value examples.
- SQLite (WAL) with forward-only migrations, integrity check, online backup, and restore verification.
- Append-only, hash-chained ledger with database triggers that block updates and deletes, and daily seals.
- NYSE exchange calendar computed by rule and verified against the published 2026–2027 schedule.
- Deterministic scheduler with idempotency keys, duplicate and reboot protection, deadlines, and missed-run detection.
- Order state machine with an exhaustive legal-transition table, persisted intents before any side effect, `UNKNOWN` handling, and a synthetic broker with fault injection.
- Sleeve account allowlist and second-layer hard caps in the gateway; live modes rejected by construction.
- Health commands for both roles reporting `liveCapable: false`.
- Umbrel one-app Community App Store manifests, multi-arch Dockerfile, PR CI, tag-gated release workflow, identity and secret checks.

**Why it matters**

Everything later phases rely on for safety is testable now, before any market data, model, or broker exists.

**Required actions**

None. Nothing to install.

**Risk impact**

None to capital. No broker connectivity, no credentials, no live path.

**Migration**

Initial schema.

**Rollback**

Not applicable.
