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

## Provide research-data credentials and run the first ingest on the Pi

The four Stage-1 credentials (`docs/ACCESS_AND_CREDENTIALS.md`) are all free and none touch a brokerage
account. They go in the app environment, never in the repo, the image, or a log.

1. **Put the keys in the app environment file** (Docker Compose reads it for `${VAR}` substitution):

   ```bash
   nano ~/umbrel/app-data/blackgold-trading/.env
   ```

   Add `KEY=VALUE` lines — no `export`, no quotes (this is a compose env file, not a shell file):

   ```
   BLACKGOLD_SEC_USER_AGENT_CONTACT=you@example.com
   BLACKGOLD_ALPACA_KEY_ID=PK...
   BLACKGOLD_ALPACA_SECRET_KEY=...
   BLACKGOLD_FRED_API_KEY=...
   ```

   `.gitignore` root-anchors `.env`; it never enters git, and `check:secrets` scans every tracked file so a key
   cannot be committed. Only the app versions that forward these vars into the `core` service pick them up — the
   compose passthrough that makes that work shipped alongside this runbook section, so an app installed from an
   earlier release must be updated first (see **Update** above).

2. **Restart Black Gold** (umbrelOS → the app → Restart) so the container starts with the new environment.

3. **Run the historical bulk pull** with `docker exec`, which inherits the container's environment. `ingest`
   needs no charter file, so it runs self-contained. Follow the symbol batches and window in
   `docs/runbooks/first-ingestion.md`:

   ```bash
   docker exec blackgold-trading_core_1 \
     node packages/core/dist/main.js ingest alpaca-bars \
     --symbols VTI,QQQ,IWM,VTV,VUG,XLK,XLF --start 2006-04-01 --end 2026-09-06
   docker exec blackgold-trading_core_1 \
     node packages/core/dist/main.js ingest alpaca-bars \
     --symbols XLV,XLI,XLP,XLU,XLY,BIL,SPY --start 2006-04-01 --end 2026-09-06
   ```

   **Single writer:** SQLite is single-writer, and `serve`'s scheduler also writes. `docker exec` runs inside the
   **running** container, so keep the app up for the commands above; a scheduler tick that overlaps a write
   retries under the 5-second busy timeout, which comfortably absorbs the occasional overlap of a bounded daily-bar
   load. If you would rather guarantee a sole writer, do **not** stop the app and then `docker exec` (exec needs a
   running container) — instead stop the app and run a one-off container against the same data volume, which needs
   no charter for the pull:

   ```bash
   IMG="ghcr.io/mherman1990/blackgold:<version>@sha256:<digest>"   # the tag+digest this app is pinned to
   docker run --rm --user 1000:1000 \
     -e BLACKGOLD_DATA_DIR=/data \
     -e BLACKGOLD_SEC_USER_AGENT_CONTACT="$BLACKGOLD_SEC_USER_AGENT_CONTACT" \
     -e BLACKGOLD_ALPACA_KEY_ID="$BLACKGOLD_ALPACA_KEY_ID" \
     -e BLACKGOLD_ALPACA_SECRET_KEY="$BLACKGOLD_ALPACA_SECRET_KEY" \
     -v ~/umbrel/app-data/blackgold-trading/data:/data "$IMG" \
     packages/core/dist/main.js ingest alpaca-bars \
     --symbols VTI,QQQ,IWM,VTV,VUG,XLK,XLF --start 2006-04-01 --end 2026-09-06
   ```

   Restart the app afterward. Either path is fine; pick one and stay on it for a given load.

4. **Confirm the bars landed** (no charter needed):

   ```bash
   docker exec blackgold-trading_core_1 node packages/core/dist/main.js pit count --source alpaca.iex.bars.1d
   docker exec blackgold-trading_core_1 node packages/core/dist/main.js pit latest --source alpaca.iex.bars.1d --entity VTI
   ```

5. **Coverage and the CR-09 depth measurement** read the charter, and the charter is not baked into the runtime
   image (it bundles `config/examples` only), so pass it in with a bind mount from a checkout of this repo on the
   Pi — or run the coverage/verify steps from a repo checkout pointed at the same `${APP_DATA_DIR}/data`:

   ```bash
   docker run --rm --user 1000:1000 \
     -v ~/umbrel/app-data/blackgold-trading/data:/data \
     -v "$PWD/strategies:/app/strategies:ro" \
     ghcr.io/mherman1990/blackgold:<version>@sha256:<digest> \
     packages/core/dist/main.js research coverage \
     --path strategies/etf-trend-vol/charter.yaml --from 2007-06-01 --to 2018-12-31
   ```

   Then continue with the coverage / CR-09 / corporate-action steps in `docs/runbooks/first-ingestion.md`.

## Remove

1. Take a verified backup and copy it off-device. umbrelOS removes `${APP_DATA_DIR}` on uninstall.
2. Uninstall Black Gold; then remove the store if desired.
3. Confirm unrelated apps and stores are untouched (list installed apps before and after).

## Rollback

Install the previous version by pinning its tag and digest in a new release of the store manifest; never edit a published tag.
