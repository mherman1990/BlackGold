# Umbrel Community App Store and release design

Design only. Nothing here is executed until Matt authorizes a release. Verified against the official template on 2026-09-06 (`https://github.com/getumbrel/umbrel-community-app-store`).

## Verified store schema

`umbrel-app-store.yml` at the repository root requires two fields:

```yaml
id: blackgold
name: Black Gold
```

The store `id` must prefix every app id in the store. The app directory `blackgold-trading/` must contain `umbrel-app.yml` and `docker-compose.yml`. The example manifest uses `manifestVersion: 1` and these fields: `id`, `name`, `tagline`, `icon`, `category`, `version`, `port`, `description`, `developer`, `website`, `submitter`, `submission`, `repo`, `support`, `gallery`, `releaseNotes`, `dependencies`, `path`, `defaultUsername`, `defaultPassword`. The example compose file defines an `app_proxy` service with `APP_HOST: <app-id>_<service>_1` and `APP_PORT`. The store is added in umbrelOS by entering the repository's GitHub URL.

Unverified from the README alone and to be confirmed against the template repository files and umbrelOS source before Phase 0 writes manifests: whether newer `manifestVersion` values are accepted, the exact semantics of `exports.sh`, and whether `${APP_DATA_DIR}` is the canonical data variable in current umbrelOS. These are listed in `docs/capabilities/umbrel-capabilities.md`.

## Proposed layout

```
BlackGold/
├── umbrel-app-store.yml          # id: blackgold, name: Black Gold
├── blackgold-trading/
│   ├── umbrel-app.yml            # id: blackgold-trading, version pinned
│   ├── docker-compose.yml        # app_proxy + core + gateway, image pinned by tag+digest
│   └── exports.sh                # only if verified as the current secret/env mechanism
└── ... (source, docs, CI)
```

## Proposed `umbrel-app.yml` (draft, not final)

```yaml
manifestVersion: 1
id: blackgold-trading
name: Black Gold
tagline: Evidence-first research and controlled execution for one ring-fenced sleeve
icon: https://raw.githubusercontent.com/mherman1990/BlackGold/main/blackgold-trading/icon.svg
category: Finance
version: "0.1.0"
port: 8479
description: >-
  Black Gold researches, shadows, paper trades, and (only after explicit
  owner authorization) executes a narrowly approved systematic strategy for a
  single ring-fenced account. Live trading is disabled by default.
developer: Matt Herman
website: https://github.com/mherman1990/BlackGold
submitter: Matt Herman
submission: https://github.com/mherman1990/BlackGold
repo: https://github.com/mherman1990/BlackGold
support: https://github.com/mherman1990/BlackGold/issues
gallery: []
releaseNotes: ""
dependencies: []
path: ""
defaultUsername: ""
defaultPassword: ""
```

## Proposed `docker-compose.yml` shape (draft)

```yaml
version: "3.7"
services:
  app_proxy:
    environment:
      APP_HOST: blackgold-trading_core_1
      APP_PORT: 8479
  core:
    image: ghcr.io/mherman1990/blackgold:0.1.0@sha256:<digest>
    command: ["node", "dist/core/main.js"]
    user: "1000:1000"
    init: true
    restart: on-failure
    environment:
      BLACKGOLD_ROLE: core
      BLACKGOLD_DATA_DIR: /data
      TZ: UTC
    volumes:
      - ${APP_DATA_DIR}/data:/data
    healthcheck: { test: ["CMD", "node", "dist/core/health.js"], interval: 60s }
  gateway:
    image: ghcr.io/mherman1990/blackgold:0.1.0@sha256:<digest>
    command: ["node", "dist/gateway/main.js"]
    user: "1000:1000"
    init: true
    restart: on-failure
    environment:
      BLACKGOLD_ROLE: gateway
      BLACKGOLD_DATA_DIR: /data
      TZ: UTC
    volumes:
      - ${APP_DATA_DIR}/data:/data
      - ${APP_DATA_DIR}/secrets:/run/blackgold-secrets:ro
    # No ports exposed. Core reaches gateway on the app-private network only.
```

The gateway is not reachable through `app_proxy`. In Phases 0–5 the gateway image role runs with a synthetic broker only and holds no credential.

## Version synchronization

Single authority: root `package.json` `version`. CI `identity-check` fails unless `umbrel-app.yml` `version`, both compose image tags, and the top `CHANGELOG.md` heading agree with it. Release tags are `v<version>`.

## CI workflows (Phase 0 deliverable, not yet created)

| Workflow | Trigger | Does | Publishes |
|---|---|---|---|
| `ci.yml` | PR and push to `claude/**` | lint, typecheck, unit + policy tests, identity check, secret scan, manifest YAML schema check, `docker buildx build --platform linux/amd64,linux/arm64` with `--output type=cacheonly` or load-only | Nothing |
| `release.yml` | Push of tag `v*` on a commit reachable from `main` | Re-run all CI checks, build multi-arch image, push `ghcr.io/mherman1990/blackgold:<version>` and `:sha-<12hex>`, generate SBOM, scan image, write digest to job summary | GHCR image |
| `release-verify.yml` | Manual `workflow_dispatch` after release | `docker buildx imagetools inspect` to confirm both architectures, compare manifest digest to compose, run a disposable install smoke test on amd64 | Nothing |

`release.yml` must not run on PRs, on non-`v*` tags, or on tags not reachable from `main`. A test in CI asserts the trigger filter.

## GHCR visibility

Public package. Rationale: umbrelOS pulls anonymously; a private package would need a pull token on the Pi, which widens the credential surface. A public image is inspectable, so nothing sensitive may be baked in. Confirm in D-03.

## Persistent data boundary

Everything mutable lives under `${APP_DATA_DIR}`: `data/blackgold.sqlite` (+WAL), `data/artifacts/`, `backups/`, `secrets/`. Update must preserve all of it. Uninstall in umbrelOS removes `${APP_DATA_DIR}`; the runbook instructs Matt to take a verified backup first. Restore = install same version, stop containers, copy data back, start, run integrity check.

## Release checklist (owner-executed, per release)

1. PR merged to `main`, CI green.
2. `CHANGELOG.md` entry written for the operator: what changed, why it matters, required actions, risk impact, migration, rollback.
3. Version bumped in `package.json` and propagated; identity check green.
4. Matt creates and pushes `v<version>` tag (or explicitly authorizes Claude Code to).
5. `release.yml` green; digest recorded.
6. `release-verify.yml` confirms `linux/arm64` and `linux/amd64` present and Pi can pull (`docker pull` on Pi).
7. Compose in the store directory pinned to tag and digest in a follow-up PR if the digest was not known in advance; identity check green.
8. Disposable-environment clean install, upgrade from previous version with existing data, health check, and rollback to previous tag all pass.
9. Only then: Matt refreshes the store in umbrelOS and updates the app.

## Install and removal isolation

Adding, refreshing, or removing the Black Gold store affects only `blackgold-trading`. It shares no volume, network, secret, port, or release trigger with any other app. The runbook includes a check that unrelated stores and apps are unchanged after each operation.
