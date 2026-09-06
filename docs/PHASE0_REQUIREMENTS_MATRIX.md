# Phase 0 requirements-to-implementation matrix

Status values: `implemented`, `tested`, `deferred`, `blocked`, `not applicable`. Evidence names the file or command that proves the row. A row is not `tested` from inspection alone.

| # | Requirement (PLAN.md Phase 0) | Status | Evidence |
|---|---|---|---|
| 1 | npm workspaces `shared`, `core`, `broker-gateway` | tested | `package.json`, `npm run build` |
| 2 | Strict TypeScript, erasable syntax only | tested | `tsconfig.base.json`; `npm run typecheck` |
| 3 | Lint with dependency-boundary rules (core never imports gateway; gateway never imports core; analyst isolated; `process.env` only in config) | tested | `eslint.config.js`; `npm run lint` |
| 4 | `Dockerfile` multi-stage, one image, role by command, non-root, node 24 | implemented; build blocked locally (no Docker daemon in the build sandbox); built by CI `image` job on the PR | `Dockerfile`, `.github/workflows/ci.yml` |
| 5 | `umbrel-app-store.yml` and `blackgold-trading/` manifests with approved identifiers | tested | `scripts/check-identity.ts`; `test/policy/identity.test.ts` |
| 6 | `scripts/check-identity.ts` cross-file consistency | tested | `npm run check:identity` |
| 7 | Config schemas (app, `risk.yaml`, financial picture, restricted list, `LIVE_AUTHORIZATION`) with fake examples | tested | `packages/core/src/config/`, `config/examples/`, core config tests |
| 8 | SQLite WAL, migrations, online backup, integrity check, restore script | tested | `packages/shared/src/db.ts`, `packages/core/src/db/`, `scripts/{backup,restore,integrity-check}.sh`, tests |
| 9 | Append-only hash-chained ledger with daily seal | tested | `packages/core/src/ledger/`, ledger tests (trigger blocks UPDATE/DELETE; chain detects tampering) |
| 10 | Exchange calendar with 2026–2027 NYSE fixtures | tested | `packages/core/src/calendar/`, calendar tests against nyse.com schedule accessed 2026-09-06 |
| 11 | Deterministic scheduler with idempotency keys and missed-run detection | tested | `packages/core/src/scheduler/`, scheduler tests (duplicate tick, reboot replay, missed, deadline) |
| 12 | `health` command | tested | core and gateway `main.ts health`; CI smoke test |
| 13 | Synthetic broker adapter with fault injection | tested | `packages/broker-gateway/src/adapters/synthetic/`, gateway fault suite |
| 14 | Notification stub | tested | `packages/core/src/notify/`, redaction test |
| 15 | Order state machine skeleton with full legal-transition table | tested | `packages/broker-gateway/src/state-machine/`, exhaustive table test |
| 16 | Policy tests: account isolation, live disabled, no secrets, identity | tested | `test/policy/*.test.ts`, gateway read-only reflection test |
| 17 | PR template and CODEOWNERS | implemented | `.github/pull_request_template.md`, `.github/CODEOWNERS` |
| 18 | `ci.yml` multi-arch build without push | implemented; verified on first CI run of the Phase 0 PR | `.github/workflows/ci.yml` |
| 19 | `release.yml` gated on `v*` tags reachable from `main` | tested (trigger filter) | `test/policy/identity.test.ts` |
| 20 | `pi-benchmark.sh` | implemented; not run (no Pi in the build sandbox) | `scripts/pi-benchmark.sh` |
| 21 | Secret scanning | tested | `scripts/check-secrets.ts`, gitleaks step in CI |
| 22 | Release-consistency checker | tested | identity check rows 3–4 |

## Exit criteria

| Exit criterion | Status | Notes |
|---|---|---|
| Containers run on the Pi and on Windows Docker | blocked | Requires Matt: pull the CI-built image once published, or build locally from the PR. No Docker daemon or Pi in the build sandbox. |
| No unrelated code or copied identifiers | tested | identity check rule 6; `docs/CONTEXT_PROVENANCE.md` |
| Store id prefixes app id; manifests agree | tested | identity check |
| No shared volume/secret/port/trigger with another app | tested | compose policy tests; `release.yml` trigger test |
| CI validates manifests, identity, secrets, both architectures without credentials | implemented; observed on the PR's CI run | `ci.yml` |
| Jobs survive duplicate execution and reboot | tested | scheduler tests |
| Backup/restore and integrity tests pass | tested | shared db tests; core backup tests |
| Synthetic order-state fault suite passes | tested | gateway tests |
| No live credential or live order path | tested | `test/policy/live-disabled.test.ts`; config loader and gateway reject live modes; CI asserts the image refuses `BLACKGOLD_MODE=LIVE_MANUAL` |
| Measured Pi resource use within budget | blocked | Requires `scripts/pi-benchmark.sh` on the Pi after the first install. |

The two blocked criteria are the only Phase 0 items that need Matt's hardware. Everything else is verified in this repository's test suite and CI.
