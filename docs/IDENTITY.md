# Black Gold identity register

Every persistent identifier Black Gold uses across GitHub, GHCR, umbrelOS, Docker Compose, and the filesystem. Accepted by Matt on 2026-09-06 (D-04). Once the first Umbrel install happens these become migration-sensitive invariants. Change requires a decision record in `docs/DECISIONS.md` and a migration plan before any manifest edit.

## Status legend

- **Approved**: chosen by Matt (repository exists under this name; rebrand instructed 2026-09-06).
- **Derived**: mechanically follows from an approved value and the Umbrel store rule.
- **Accepted**: adopted by Matt on 2026-09-06 (decision D-04). Still subject to the port-collision check before the first Umbrel install.

## Identifiers

| Identifier | Value | Status | Where it appears |
|---|---|---|---|
| Product / display name | Black Gold | Approved | README, `umbrel-app.yml` `name`, reports |
| GitHub owner/repo | `mherman1990/BlackGold` | Approved | git remote, `umbrel-app.yml` `repo`/`support`/`submission`, CI |
| Repository visibility | Public | Approved (as created) | GitHub settings; store URL must be public to add in umbrelOS |
| Default branch | `main` (created 2026-09-06 from e7fc3d9; Matt sets it default in GitHub settings) | Accepted | branch protection, CI triggers |
| Discovery branch | `claude/black-gold-trading-tool-n713ly` | Approved (session-assigned) | this Discovery PR |
| Phase branch pattern | `claude/phase-XX-short-name` | Accepted | `docs/REPOSITORY_AND_PR_WORKFLOW.md` |
| Community App Store id | `blackgold` | Accepted | `umbrel-app-store.yml` `id` |
| Community App Store name | Black Gold | Accepted | `umbrel-app-store.yml` `name` |
| Umbrel app id / folder | `blackgold-trading` | Derived (store id + `-trading`) | `blackgold-trading/umbrel-app.yml` `id`, folder name, container names |
| Umbrel app category | `finance` (lowercase, matching official app manifests) | Accepted | `umbrel-app.yml` `category` |
| Compose service names | `app_proxy`, `core`, `gateway` | Accepted | `blackgold-trading/docker-compose.yml` |
| Umbrel container names | `blackgold-trading_core_1`, `blackgold-trading_gateway_1` | Derived (`<app-id>_<service>_1`) | `APP_HOST` in `app_proxy` |
| Internal HTTP port (core, read-only status UI) | `8479` | Accepted | `umbrel-app.yml` `port`, `APP_PORT` |
| Internal gateway port | none in Phase 0 (gateway exposes no listener; core-to-gateway transport is a Phase 5 decision) | Accepted | compose |
| GHCR image (single image, role by command) | `ghcr.io/mherman1990/blackgold` | Accepted | compose `image:`, release workflow |
| Image tags | `X.Y.Z` (matches package.json, no `v`) and `sha-<40 hex>`; compose pins `X.Y.Z@sha256:<digest>` once published | Accepted | compose, CI |
| npm workspace packages | `@blackgold/core`, `@blackgold/broker-gateway`, `@blackgold/shared` | Accepted | `package.json` |
| Process names | `blackgold-core`, `blackgold-broker-gateway` | Accepted | logs, health output |
| App data root | `${APP_DATA_DIR}` (Umbrel) / `./appdata` (Windows fallback) | Derived | compose volumes |
| SQLite database | `${APP_DATA_DIR}/data/blackgold.sqlite` | Accepted | config schema |
| Raw artifact store | `${APP_DATA_DIR}/data/artifacts/` | Accepted | config schema |
| Backups | `${APP_DATA_DIR}/backups/` (local) plus off-device encrypted copy (D-16) | Accepted | backup scripts |
| Secrets | files under `${APP_DATA_DIR}/secrets/` mounted read-only into the gateway only (Phase 6); no `exports.sh` needed for a single app | Accepted | compose, runbooks |
| Sleeve account role | `blackgold_sleeve` | Accepted | config schema, gateway allowlist |
| Config env prefix | `BLACKGOLD_` | Accepted | all services |
| Authorization artifact | `LIVE_AUTHORIZATION.yaml` (gitignored, owner-created) | Accepted | gateway, core |
| Release tag pattern | `v[0-9]+.[0-9]+.[0-9]+` | Accepted | release workflow trigger |
| Version authority | `package.json` at repo root | Accepted | version-consistency CI check |

## Cross-file consistency check (Phase 0 CI)

`scripts/check-identity.ts` (run by CI and by `test/policy/identity.test.ts`) asserts:

1. `umbrel-app-store.yml` `id` equals `blackgold`.
2. Exactly one app directory exists and its name equals `umbrel-app.yml` `id` equals `blackgold-trading`, which starts with `blackgold-`.
3. Every `image:` in `blackgold-trading/docker-compose.yml` starts with `ghcr.io/mherman1990/blackgold:` and is not `latest`.
4. `umbrel-app.yml` `version` equals root `package.json` `version` equals the image tag (less `v`) equals the top `CHANGELOG.md` heading.
5. `APP_HOST` equals `blackgold-trading_core_1` and `APP_PORT` equals `umbrel-app.yml` `port`.
6. No file in the repo contains the retired product name (case-insensitive), except `docs/CONTEXT_PROVENANCE.md` and `docs/DECISIONS.md`.
7. No compose volume references a path outside `${APP_DATA_DIR}`.

## Collision audit

| Risk | Check | Result |
|---|---|---|
| Store id collides with an existing Umbrel store | Search umbrelOS official store and known community stores for `blackgold` | Not found in official `getumbrel/umbrel-apps` app list as of 2026-09-06 (inference from app id conventions; Matt to confirm against installed stores) |
| Port 8479 collides with an installed app | Compare with `umbrel-app.yml` `port` of every installed app on Matt's Pi | UNVERIFIED. Matt runs `ls ~/umbrel/app-data` and checks each `umbrel-app.yml` port before install |
| GHCR package name collides | `ghcr.io/mherman1990/blackgold` | No package exists yet (inference; nothing has been published) |
| Container name collision | `blackgold-trading_*` unique because app id is unique | Derived |

## Migration sensitivity

| Identifier | If changed after install |
|---|---|
| App id | umbrelOS treats it as a different app: data directory, container names, and store listing all change. Requires export/import of `${APP_DATA_DIR}`. Effectively a reinstall. |
| Store id | Every app id must change (prefix rule). Same as above. |
| Image name | Compose edit and re-pull only; low risk if tags preserved. |
| Port | Compose and manifest edit; app_proxy handles routing; low risk. |
| Data paths | SQLite and artifact relocation with integrity check; medium risk. |
| Sleeve role name | Config schema migration; medium risk because it is a safety key. |
