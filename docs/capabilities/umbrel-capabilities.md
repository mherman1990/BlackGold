# Umbrel capability register

## Verified 2026-09-06 (official template `getumbrel/umbrel-community-app-store`)

| ID | Claim |
|---|---|
| UM-01 | `umbrel-app-store.yml` at the store root has two required fields: `id` ("a unique prefix for every app within your Community App Store") and `name` (displayed in the umbrelOS UI) |
| UM-02 | App ids must be prefixed with the store id (example: store `sparkles` + app `hello world` gives `sparkles-hello-world`) |
| UM-03 | Each app directory contains `umbrel-app.yml` (listing details) and `docker-compose.yml` (services) |
| UM-04 | The store is added in umbrelOS by entering its GitHub URL |
| UM-05 | Example `umbrel-app.yml` uses `manifestVersion: 1` and fields `id, name, tagline, icon, category, version, port, description, developer, website, submitter, submission, repo, support, gallery, releaseNotes, dependencies, path, defaultUsername, defaultPassword` |
| UM-06 | Example `docker-compose.yml` uses `version: "3.7"`, an `app_proxy` service with `APP_HOST: <app-id>_<service>_1` and `APP_PORT`, and an app service with `user: "1000:1000"` and `init: true` |

## UNVERIFIED (resolve before Phase 0 writes manifests)

| ID | Question | Probe |
|---|---|---|
| UM-07 | Is `${APP_DATA_DIR}` the canonical app-data variable in current umbrelOS compose files, and are `${APP_PORT}`, `${APP_SEED}`, `${DEVICE_HOSTNAME}` also injected? | Inspect several current apps in `getumbrel/umbrel-apps` and umbrelOS source |
| UM-08 | Does `exports.sh` remain the mechanism for exporting env vars/secrets between apps, and is it needed for a single-app store? | Same |
| UM-09 | Are `manifestVersion` values above 1 accepted, and what do they enable (e.g. `1.1` for widgets, `1.2`)? | Same |
| UM-10 | Does umbrelOS honour compose `healthcheck` and `restart` policies as written? | Phase 0 install test on the Pi |
| UM-11 | Is an image reference with both tag and `@sha256:` digest accepted by the umbrelOS updater? | Inspect official apps; Phase 0 test |
| UM-12 | How does umbrelOS handle app update when the image tag changes: pull-and-recreate with data preserved under `${APP_DATA_DIR}`? | Phase 0 upgrade test with seeded data |
| UM-13 | Uninstall removes `${APP_DATA_DIR}` entirely? | Phase 0 test with a throwaway install |
| UM-14 | Does the current umbrelOS UI require `gallery` images and a reachable `icon` URL for a community app to render? | Phase 0 |
| UM-15 | Port 8479 is unused by any app installed on Matt's Pi | Matt checks installed `umbrel-app.yml` files |
| UM-16 | ARM64 Pi 5 runs `node:24` official images without QEMU issues, and `better-sqlite3` prebuilt binaries exist for `linux/arm64` | Phase 0 build and smoke test on the Pi |

## Rules

- Write manifests only after UM-07 through UM-09 are resolved.
- Never install on the Pi from a locally built image; only from a published, verified GHCR image.
- Test install, upgrade, and uninstall on a disposable path before touching the production Pi.
