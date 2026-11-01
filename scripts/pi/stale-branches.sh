#!/usr/bin/env bash
# Run on the owner's machine, inside a BlackGold checkout. Lists the `claude/*` branches that are strict
# ancestors of origin/main (fully merged, safe to delete) and prints ONE line that deletes them all.
# Claude Code's credential is refused ref deletion (HTTP 403), so this is the owner's paste.
#
#   scripts/pi/stale-branches.sh            # list and print the delete line
#   scripts/pi/stale-branches.sh --delete   # actually run it
set -euo pipefail
git fetch --prune origin >/dev/null 2>&1
mapfile -t MERGED < <(git branch -r --merged origin/main | sed 's/^ *//' | grep -E '^origin/claude/' | sed 's|^origin/||' || true)
mapfile -t OPEN < <(git branch -r --no-merged origin/main | sed 's/^ *//' | grep -E '^origin/claude/' | sed 's|^origin/||' || true)
echo "# ${#MERGED[@]} claude/* branch(es) are strict ancestors of origin/main (safe to delete)"
echo "# ${#OPEN[@]} claude/* branch(es) carry commits not on origin/main (review each before deleting):"
for b in "${OPEN[@]}"; do echo "#   $b"; done
if [ "${#MERGED[@]}" -eq 0 ]; then
  echo "# nothing to delete"
  exit 0
fi
if [ "${1:-}" = "--delete" ]; then
  git push origin --delete "${MERGED[@]}"
else
  echo "git push origin --delete ${MERGED[*]}"
fi
