#!/usr/bin/env bash
# The two halves of a Pi update (docs/runbooks/umbrel-install-update-remove.md, "Update").
#
#   pi-update.sh before   # backup, record health; then update Black Gold in the umbrelOS App Store
#   pi-update.sh after    # health again, show what changed, remind about release-verify
#
# The update itself is a click in umbrelOS (App Store -> community store -> refresh -> Update); this script
# does everything around it so the sitting is two pastes.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${BG_STATE_DIR:-$HOME/bg-state}"
mkdir -p "$STATE_DIR"
record_health() { # $1 = file. `bg health` exits 1 when ok is false, which is exactly the state worth recording.
  if "$HERE/bg" health > "$1"; then
    echo "health ok, recorded $1"
  else
    echo "WARNING: health reports ok=false (recorded $1). Read it before you go on:"
    cat "$1"
  fi
}
case "${1:-}" in
  before)
    echo "== backup (online, integrity-checked) =="
    "$HERE/bg" backup
    echo "== health before =="
    record_health "$STATE_DIR/health-before.json"
    echo
    echo "Now in umbrelOS: App Store -> Community App Stores -> Black Gold -> refresh -> Update."
    echo "Then run: pi-update.sh after"
    ;;
  after)
    echo "== health after =="
    record_health "$STATE_DIR/health-after.json"
    echo "== version =="
    "$HERE/bg" version
    if [ -f "$STATE_DIR/health-before.json" ]; then
      echo "== differences before -> after (none printed means identical) =="
      diff <(tr ',' '\n' < "$STATE_DIR/health-before.json") <(tr ',' '\n' < "$STATE_DIR/health-after.json") || true
    fi
    echo
    echo "If this update changed the wrappers, re-run the install line from the runbook (the image carries the new ones)."
    echo "If it changed the compose file or resource use, run pi-benchmark.sh as well (installed next to this script)."
    ;;
  *)
    echo "usage: pi-update.sh before | after" >&2
    exit 2
    ;;
esac
