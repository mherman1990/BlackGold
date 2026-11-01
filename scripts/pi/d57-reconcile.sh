#!/usr/bin/env bash
# One command for docs/runbooks/first-ingestion.md Step 2b, "Building the file" (D-57, D-58), on the Pi.
#
#   d57-reconcile.sh vti.json vtv.json vug.json iShares-Russell-2000-ETF_fund.xls [curated.csv] [structural.json]
#
# It stages the downloads into the app's data directory (the container sees it as /data/d57), fixes ownership,
# picks the next free output number (the reconciler refuses to overwrite its outputs, and staging refuses an
# input named like one or one that would replace a different file already staged, so a signed file can never be
# clobbered), runs `reconcile corporate-actions` against the RESEARCH store through `bg`, and prints how many
# actions are still only Tiingo's (`toCurate`). Rerun with the curated CSV until that number is zero.
#
# It never ingests anything and never signs anything. Signing is `bg corporate-actions sign` (B2), the owner's act.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$#" -lt 4 ] || [ "$#" -gt 6 ]; then
  echo "usage: d57-reconcile.sh <vti.json> <vtv.json> <vug.json> <iwm.xls> [curated.csv] [structural.json]  (got $# arguments)" >&2
  exit 2
fi
APP_DATA="${BG_APP_DATA:-$HOME/umbrel/app-data/blackgold-trading/data}"
D57="$APP_DATA/d57"
CHARTER="${BG_CHARTER:-strategies/etf-trend-vol/charter.yaml}"
sudo mkdir -p "$D57"
# Two inputs with one file name would stage over each other and the reconciler would read one fund's file for
# two funds; refuse before anything is copied.
DUPES="$(for f in "$@"; do basename "$f"; done | sort | uniq -d | paste -sd, -)"
if [ -n "$DUPES" ]; then
  echo "refused: two inputs share a file name ($DUPES); rename one, e.g. vti.json, vtv.json, vug.json" >&2
  exit 3
fi
stage() { # copy a file into $D57 and echo its /data path
  local src="$1" base
  [ -f "$src" ] || { echo "missing file: $src" >&2; exit 2; }
  base="$(basename "$src")"
  case "$base" in
    reconciled-*) echo "refused: $src is named like a reconciler output; stage inputs only, outputs are never replaced" >&2; exit 3;;
  esac
  if [ -e "$D57/$base" ] && ! sudo cmp -s "$src" "$D57/$base"; then
    echo "refused: /data/d57/$base already exists with different content; rename the input instead of replacing it" >&2
    exit 3
  fi
  sudo cp "$src" "$D57/$base"
  echo "/data/d57/$base"
}
VTI="$(stage "$1")"; VTV="$(stage "$2")"; VUG="$(stage "$3")"; IWM="$(stage "$4")"
CURATED=""; STRUCTURAL=""
[ "$#" -ge 5 ] && CURATED="$(stage "$5")"
[ "$#" -ge 6 ] && STRUCTURAL="$(stage "$6")"
sudo chown -R 1000:1000 "$D57"
N=1
while [ -e "$D57/reconciled-$N.json" ] || [ -e "$D57/reconciled-$N.report.json" ]; do N=$((N + 1)); done
OUT="/data/d57/reconciled-$N.json"
REPORT="/data/d57/reconciled-$N.report.json"
ARGS=(reconcile corporate-actions --charter "$CHARTER" --out "$OUT" --report "$REPORT" --vanguard "VTI=$VTI,VTV=$VTV,VUG=$VUG" --ishares "IWM=$IWM")
[ -n "$CURATED" ] && ARGS+=(--curated "$CURATED")
[ -n "$STRUCTURAL" ] && ARGS+=(--structural "$STRUCTURAL")
echo "== bg ${ARGS[*]} =="
"$HERE/bg" "${ARGS[@]}"
echo
echo "== actions only Tiingo reports (toCurate) =="
sudo docker exec -i "${BG_CORE_CONTAINER:-blackgold-trading_core_1}" node -e '
const fs = require("node:fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const t = Array.isArray(r.toCurate) ? r.toCurate : [];
console.log(`${t.length} to curate`);
for (const a of t) console.log(`  ${a.entityId} ${a.kind} ${a.exDate} vendor=${a.vendorValue}`);
' "$REPORT"
echo
echo "unsigned file: $D57/reconciled-$N.json   report: $D57/reconciled-$N.report.json"
echo "next: curate the rows above from the issuers' documents, rerun with the curated CSV; when zero remain, audit the report and run: bg corporate-actions sign --file $OUT --signer \"\$BLACKGOLD_SIGNER\""
