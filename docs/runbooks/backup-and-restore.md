# Backup and restore

Black Gold's database is SQLite in WAL mode with a single writer. Copying the `.sqlite` file while the process runs is unsafe. Use the online backup command, which uses `VACUUM INTO` and then verifies the copy.

## Backup

```bash
scripts/backup.sh /path/to/APP_DATA_DIR/data
```

Writes `backups/blackgold-<UTC stamp>.sqlite` under the data directory, opens the copy read-only, runs `PRAGMA integrity_check`, and verifies the ledger hash chain. Exit code is non-zero if either check fails. Retention: 7 daily and 4 weekly copies are kept by `pruneBackups`; audit rows are never deleted to free space.

Off-device copy (D-16): encrypt with `age` and push to the second Pi or the named bucket. The daily ledger seal root hash travels with the copy so tampering is evident. That step is scripted in Phase 5.

## Verify a backup without restoring

```bash
node packages/core/dist/main.js verify-backup backups/blackgold-20260906T230000Z.sqlite
```

## Restore

1. Stop the core and gateway containers (umbrelOS app stop, or `docker compose stop`).
2. Confirm `blackgold.sqlite-wal` is empty or absent.
3. Run:

```bash
scripts/restore.sh backups/blackgold-<stamp>.sqlite /path/to/APP_DATA_DIR/data
```

The script verifies the backup, moves the existing database aside as `blackgold.sqlite.pre-restore-<stamp>`, copies the backup into place, and re-verifies the ledger chain.

4. Start the containers. Run `node packages/core/dist/main.js health` and confirm `dbIntegrity.ok` and `ledgerChain.ok`.

## Restore drill

Quarterly: restore the latest backup into a scratch directory on a different machine, run `health`, and record the elapsed time against the RTO in `docs/RESOURCE_BUDGET.md`.
