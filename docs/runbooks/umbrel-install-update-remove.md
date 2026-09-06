# Umbrel install, update, and removal (draft until the first published image)

The store is added by URL. Nothing below may be done until `docs/UMBREL_STORE_AND_RELEASE.md` release checklist steps 1–8 pass for a version and the compose file pins that version's digest.

## Pre-install checks

1. Port collision: on the Pi, run `grep -h '^port:' ~/umbrel/app-data/*/umbrel-app.yml` and confirm `8479` is absent.
2. Confirm `blackgold-trading/docker-compose.yml` on `main` pins `ghcr.io/mherman1990/blackgold:<version>@sha256:<digest>` and `release-verify` passed for that version.

## Add the store and install

1. umbrelOS → App Store → Community App Stores → add `https://github.com/mherman1990/BlackGold`.
2. Open the Black Gold store, install Black Gold.
3. Open the app; the status page shows mode, `liveCapable: false`, database integrity, ledger chain, and next session.
4. Run `scripts/pi-benchmark.sh` on the Pi and compare with `docs/RESOURCE_BUDGET.md`.

## Update

1. Take a backup (`docs/runbooks/backup-and-restore.md`).
2. Refresh the community store in umbrelOS; update Black Gold.
3. Verify health. Data under `${APP_DATA_DIR}/data` must be unchanged; the migration log in the health output lists applied migrations.

## Remove

1. Take a verified backup and copy it off-device. umbrelOS removes `${APP_DATA_DIR}` on uninstall.
2. Uninstall Black Gold; then remove the store if desired.
3. Confirm unrelated apps and stores are untouched (list installed apps before and after).

## Rollback

Install the previous version by pinning its tag and digest in a new release of the store manifest; never edit a published tag.
