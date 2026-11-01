#!/usr/bin/env bash
# Build the separate EVALUATION store (D-57(b)) in one sitting, on the Pi, and stop before registration.
#
#   export BLACKGOLD_TIINGO_API_KEY=...            # the owner's own shell, never a file under the app
#   export BLACKGOLD_SEC_USER_AGENT_CONTACT=you@example.com
#   eval-store.sh ~/umbrel/app-data/blackgold-trading/data-eval /path/to/reconciled-N.signed.json [--dry-run]
#
# Refusals that protect the evidence (HANDOFF.md section 5; D-57(b)):
#   1. the target directory may not be, sit inside, or CONTAIN the research data directory (a target such as the
#      app-data directory would be chowned and mounted whole); the research directory must exist so this can be
#      checked, or BG_RESEARCH_DIR names it;
#   2. no argument may name a secrets file or mount, and no argument other than the two paths and --dry-run is
#      accepted (nothing is passed through to docker); the one-off container gets credentials from the owner's
#      shell environment only, and only the two the bars pull needs, by name (value-less -e under sudo -E), so no
#      key appears on a command line or in the sudo log;
#   3. this script never runs `ingest tiingo-actions`: the evaluation store takes exactly one signed reconciled
#      file, ingested BEFORE the snapshot so the registered experiment can read it;
#   4. the target must be new or empty: a directory that already holds a store may carry observations from an
#      earlier attempt (Tiingo actions included), and nothing in it would be citable. Point a rerun at a fresh
#      directory.
#
# Order: migrate -> ingest universe (bars only) -> ingest corporate-actions (the signed file) -> snapshot ->
# coverage -> charter show. It prints the `experiment register` line last and does not run it: registration is
# the owner's act (D-61).
set -euo pipefail
usage() { echo "usage: eval-store.sh <eval-data-dir> <signed-reconciled.json> [--dry-run]" >&2; exit 2; }
for a in "$@"; do
  case "$a" in *secrets*) echo "refused: argument names a secrets file or mount ($a); the evaluation store never sees one" >&2; exit 3;; esac
done
DRY=""
POS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1;;
    -*) echo "refused: unknown option $a; only --dry-run is accepted, nothing is passed through to docker" >&2; exit 2;;
    *) POS+=("$a");;
  esac
done
[ "${#POS[@]}" -eq 2 ] || usage
EVAL_DIR_RAW="${POS[0]}"
SIGNED="${POS[1]}"
UMBREL="${UMBREL_ROOT:-$HOME/umbrel}"
RESEARCH_DIR="$(realpath -m "${BG_RESEARCH_DIR:-$UMBREL/app-data/blackgold-trading/data}")"
if [ ! -d "$RESEARCH_DIR" ]; then
  echo "refused: research data directory not found at $RESEARCH_DIR; set BG_RESEARCH_DIR to the app's data directory so the separation can be checked" >&2
  exit 3
fi
EVAL_DIR="$(realpath -m "$EVAL_DIR_RAW")"
case "$EVAL_DIR/" in
  "$RESEARCH_DIR/"*) echo "refused: $EVAL_DIR is the research data directory or inside it; the evaluation store must be a separate directory" >&2; exit 3;;
esac
case "$RESEARCH_DIR/" in
  "$EVAL_DIR/"*) echo "refused: $EVAL_DIR contains the research data directory $RESEARCH_DIR and would be chowned and mounted whole; use a sibling such as $(dirname "$RESEARCH_DIR")/data-eval" >&2; exit 3;;
esac
if [ -e "$EVAL_DIR" ] && { [ ! -d "$EVAL_DIR" ] || [ -n "$(sudo ls -A "$EVAL_DIR" 2>/dev/null || ls -A "$EVAL_DIR")" ]; }; then
  echo "refused: $EVAL_DIR exists and is not empty; the evaluation store must be built into a new or empty directory (D-57(b)), so an earlier attempt cannot leave observations behind. Use a fresh directory." >&2
  exit 3
fi
[ -f "$SIGNED" ] || { echo "missing signed file: $SIGNED" >&2; exit 2; }
if [ -z "$DRY" ]; then
  [ -n "${BLACKGOLD_TIINGO_API_KEY:-}" ] || { echo "export BLACKGOLD_TIINGO_API_KEY in this shell first (never into a file under the app)" >&2; exit 2; }
  [ -n "${BLACKGOLD_SEC_USER_AGENT_CONTACT:-}" ] || { echo "export BLACKGOLD_SEC_USER_AGENT_CONTACT in this shell first" >&2; exit 2; }
fi
CHARTER="${BG_CHARTER:-strategies/etf-trend-vol/charter.yaml}"
IMG="${BG_IMAGE:-}"
if [ -z "$IMG" ] && [ -z "$DRY" ]; then
  IMG="$(sudo docker inspect "${BG_CORE_CONTAINER:-blackgold-trading_core_1}" --format '{{.Config.Image}}')"
fi
[ -n "$IMG" ] || IMG="<image of the running core container>"
SIGNED_BASE="$(basename "$SIGNED")"
TODAY="$(date -u +%Y-%m-%d)"
run() {
  echo "== $* =="
  if [ -n "$DRY" ]; then return 0; fi
  # Value-less -e: docker reads the two variables from the environment that sudo -E preserves, so neither value
  # is on a command line, in `ps`, or in the sudo log.
  sudo -E docker run --rm --user 1000:1000 \
    -e BLACKGOLD_DATA_DIR=/data \
    -e BLACKGOLD_SEC_USER_AGENT_CONTACT \
    -e BLACKGOLD_TIINGO_API_KEY \
    -v "$EVAL_DIR:/data" "$IMG" packages/core/dist/main.js "$@"
}
if [ -z "$DRY" ]; then
  sudo mkdir -p "$EVAL_DIR"
  sudo cp "$SIGNED" "$EVAL_DIR/$SIGNED_BASE"
  sudo chown -R 1000:1000 "$EVAL_DIR"
fi
echo "evaluation store: $EVAL_DIR (research store: $RESEARCH_DIR)"
run migrate
run ingest universe --charter "$CHARTER" --actions none --source tiingo
run ingest corporate-actions --file "/data/$SIGNED_BASE"
run snapshot create --dataset prices_daily --description "evaluation store, reconciled actions $SIGNED_BASE, $TODAY"
GAPS=""
run research coverage --path "$CHARTER" --from 2007-06-01 --to "$TODAY" || {
  GAPS=1
  echo "coverage reported uncovered members (exit $?). The store is built; read the report above and HANDOFF.md section 5 before going on."
}
run charter show --path "$CHARTER"
echo
if [ -n "$GAPS" ]; then
  echo "STOP. Coverage has gaps; do not register until they are understood."
else
  echo "STOP. Registration is yours. If charter show printed registrable: true, the next line (B1) is:"
fi
echo "  sudo docker run --rm --user 1000:1000 -e BLACKGOLD_DATA_DIR=/data -v \"$EVAL_DIR:/data\" \"$IMG\" packages/core/dist/main.js \\"
echo "    experiment register --charter $CHARTER --snapshot prices_daily=<id from snapshot create> --registered-by \"\$BLACKGOLD_SIGNER\" --require-citable --no-shadow-clock \"clock anchored at the research-store registration\""
