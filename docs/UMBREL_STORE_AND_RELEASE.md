# Umbrel Community App Store and release design

Design only. Nothing here is executed until Matt authorizes a release. Verified against the official template on 2026-09-06 (`https://github.com/getumbrel/umbrel-community-app-store`).

## Verified store schema

`umbrel-app-store.yml` at the repository root requires two fields:

```yaml
id: blackgold
name: Black Gold
```

The store `id` must prefix every app id in the store. The app directory `blackgold-trading/` must contain `umbrel-app.yml` and `docker-compose.yml`. The example manifest uses `manifestVersion: 1` and these fields: `id`, `name`, `tagline`, `icon`, `category`, `version`, `port`, `description`, `developer`, `website`, `submitter`, `submission`, `repo`, `support`, `gallery`, `releaseNotes`, `dependencies`, `path`, `defaultUsername`, `defaultPassword`. The example compose file defines an `app_proxy` service with `APP_HOST: <app-id>_<service>_1` and `APP_PORT`. The store is added in umbrelOS by entering the repository's GitHub URL.

Verified later the same day from the official `getumbrel/umbrel-apps` packaging guidance and a current official app (uptime-kuma): `${APP_DATA_DIR}/data/...` is the bind-mount root for app-owned state; images are pinned as `repo:version@sha256:<manifest-list digest>` covering both `linux/amd64` and `linux/arm64`; `manifestVersion: 1` is the default; `exports.sh` is required only for computed values or generated secrets, so a single-app package needs none; manifest `port` shares the host port space with other apps and umbrelOS ports 80/443/2000; services run as `user: "1000:1000"`; never mount the Docker socket. Injected variables include `APP_ID`, `APP_VERSION`, `APP_DATA_DIR`, `APP_SEED`, `APP_PASSWORD`, `DEVICE_HOSTNAME`, `DEVICE_DOMAIN_NAME`, `UMBREL_ROOT`, `NETWORK_IP`, `TOR_*`.

## Proposed layout

```
BlackGold/
├── umbrel-app-store.yml          # id: blackgold, name: Black Gold
├── blackgold-trading/
│   ├── umbrel-app.yml            # id: blackgold-trading, version pinned
│   ├── docker-compose.yml        # app_proxy + core + gateway, image pinned by tag+digest
│   ├── icon.svg
│   └── data/.gitkeep             # bind-mount source; umbrelOS removes .gitkeep at runtime
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
    command: ["packages/core/dist/main.js", "serve"]   # ENTRYPOINT is node
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
    command: ["packages/broker-gateway/dist/main.js", "serve"]
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

Single authority: root `package.json` `version`. CI `identity-check` fails unless `umbrel-app.yml` `version`, both compose image tags, and the top `CHANGELOG.md` heading agree with it. Release tags are `v<version>`; image tags are `<version>` and `sha-<commit>`; compose pins `<version>@sha256:<digest>`.

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
4. Trigger `release.yml`, either way round (D-38):
   - **Dispatch** with the bare version, e.g. `0.1.0`. The workflow resolves `main`'s head, verifies the version against `package.json` at that commit, runs `npm run check`, creates the `v<version>` tag, then publishes. This is the path Claude Code uses, because GitHub refuses its credential a tag ref.
   - **Or push the tag by hand**: `git tag v<version> <commit-on-main> && git push origin v<version>`. Unchanged behaviour.
5. `release.yml` green; digest recorded in the run summary.
6. **Confirm the package is anonymously pullable**, because umbrelOS pulls with no credentials:

   ```
   T=$(curl -sS "https://ghcr.io/token?scope=repository%3Amherman1990%2Fblackgold%3Apull&service=ghcr.io" | jq -r .token)
   curl -sSI -H "Authorization: Bearer $T" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     https://ghcr.io/v2/mherman1990/blackgold/manifests/<version>
   ```

   Expect HTTP 200 and a `docker-content-digest` header. Verified anonymous on 0.1.0: a package first published by Actions from a **public** repository inherits public visibility, so no manual visibility flip was needed. Do not assume that holds if the repository ever goes private - re-run this check, and if it returns 401 set the package back to public at github.com/users/mherman1990/packages/container/blackgold/settings. A private package fails the Umbrel install with `unauthorized`, which looks like a different fault from the missing-image `manifest unknown` but is the same step not done.
7. `release-verify.yml` confirms `linux/arm64` and `linux/amd64` present and Pi can pull (`docker pull` on Pi).
8. Compose in the store directory pinned to tag and digest in a follow-up PR if the digest was not known in advance; identity check green.
9. Disposable-environment clean install, upgrade from previous version with existing data, health check, and rollback to previous tag all pass.
10. Only then: Matt refreshes the store in umbrelOS and updates the app.

## Install and removal isolation

Adding, refreshing, or removing the Black Gold store affects only `blackgold-trading`. It shares no volume, network, secret, port, or release trigger with any other app. The runbook includes a check that unrelated stores and apps are unchanged after each operation.
