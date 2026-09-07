#!/usr/bin/env bash
# Database integrity and ledger chain verification. Exit non-zero on any failure.
set -euo pipefail
DATA_DIR="${1:-${BLACKGOLD_DATA_DIR:-./data}}"
export BLACKGOLD_DATA_DIR="$DATA_DIR"
node "$(dirname "$0")/../packages/core/dist/main.js" verify-chain
node "$(dirname "$0")/../packages/core/dist/main.js" health
