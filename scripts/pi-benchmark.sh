#!/usr/bin/env bash
# Measure Black Gold's footprint on the Raspberry Pi 5 against docs/RESOURCE_BUDGET.md.
# Run on the Pi (umbrelOS shell) after the app is installed. Writes a timestamped report to ./pi-benchmark-<stamp>.txt.
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="pi-benchmark-$STAMP.txt"
APP_ID="blackgold-trading"
{
  echo "# Black Gold Pi benchmark $STAMP"
  echo
  echo "## Host"
  uname -a
  cat /proc/device-tree/model 2>/dev/null || true
  echo
  echo "## Temperature and throttling"
  vcgencmd measure_temp 2>/dev/null || echo "vcgencmd unavailable"
  vcgencmd get_throttled 2>/dev/null || true
  echo
  echo "## Memory (host)"
  free -m
  echo
  echo "## Disk"
  df -h / "${UMBREL_ROOT:-$HOME/umbrel}" 2>/dev/null || df -h /
  du -sh "${UMBREL_ROOT:-$HOME/umbrel}/app-data/$APP_ID" 2>/dev/null || true
  echo
  echo "## Container stats (one sample)"
  docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}" 2>/dev/null | grep -E "NAME|$APP_ID" || true
  echo
  echo "## Health"
  docker exec "${APP_ID}_core_1" node packages/core/dist/main.js health 2>/dev/null || echo "core container not running"
  docker exec "${APP_ID}_gateway_1" node packages/broker-gateway/dist/main.js health 2>/dev/null || echo "gateway container not running"
  echo
  echo "## SQLite timing (1000 ledger appends via heartbeat job loop is a Phase 1 item)"
  echo "not measured in Phase 0"
} | tee "$OUT"
echo "report written to $OUT"
