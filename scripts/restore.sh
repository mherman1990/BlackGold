#!/usr/bin/env bash
# Restore a verified backup into DATA_DIR. Stops if the running database is open (stop the containers first).
# Usage: scripts/restore.sh BACKUP_FILE [DATA_DIR]
set -euo pipefail
BACKUP="${1:?backup file required}"
DATA_DIR="${2:-${BLACKGOLD_DATA_DIR:-./data}}"
# Honour a configured database path; otherwise use the default under DATA_DIR. Export it so every
# core command below (verify-backup, verify-chain) operates on the same file that is being restored.
DB="${BLACKGOLD_DB_PATH:-$DATA_DIR/blackgold.sqlite}"
export BLACKGOLD_DATA_DIR="$DATA_DIR"
export BLACKGOLD_DB_PATH="$DB"

echo "verifying $BACKUP"
node "$(dirname "$0")/../packages/core/dist/main.js" verify-backup "$BACKUP"

if [ -f "$DB-wal" ] && [ -s "$DB-wal" ]; then
  echo "refusing: $DB-wal is non-empty; stop the core and gateway containers first" >&2
  exit 2
fi

if [ -f "$DB" ]; then
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  mv "$DB" "$DB.pre-restore-$STAMP"
  echo "moved existing database to $DB.pre-restore-$STAMP"
fi
cp "$BACKUP" "$DB"
chmod 600 "$DB"
node "$(dirname "$0")/../packages/core/dist/main.js" verify-chain
echo "restore complete"
