#!/usr/bin/env bash
# Online SQLite backup for Black Gold. Safe to run while the core process is writing (VACUUM INTO).
# Usage: scripts/backup.sh [DATA_DIR]   (default: $BLACKGOLD_DATA_DIR or ./data)
set -euo pipefail
DATA_DIR="${1:-${BLACKGOLD_DATA_DIR:-./data}}"
export BLACKGOLD_DATA_DIR="$DATA_DIR"
node "$(dirname "$0")/../packages/core/dist/main.js" backup
