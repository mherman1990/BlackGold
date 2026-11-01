#!/usr/bin/env bash
# Run on the owner's machine, inside a BlackGold checkout. Lists the `claude/*` branches that are strict
# ancestors of origin/main (fully merged, safe to delete) and prints ONE line that deletes them all.
# Claude Code's credential is refused ref deletion (HTTP 403), so this is the owner's paste.
#
# A branch whose tip IS origin/main is kept: that is a session branch freshly reset after a merge (DN-0),
# about to carry the next PR.
#
#   scripts/pi/stale-branches.sh            # list and print the delete line
#   scripts/pi/stale-branches.sh --delete   # actually run it
set -euo pipefail
git fetch --prune origin >/dev/null 2>&1
MAIN="$(git rev-parse origin/main)"
MERGED=()
OPEN=()
RESET=()
while read -r ref sha; do
  [ -n "$ref" ] || continue
  b="${ref#origin/}"
  if [ "$sha" = "$MAIN" ]; then
    RESET+=("$b")
  elif git merge-base --is-ancestor "$sha" "$MAIN"; then
    MERGED+=("$b")
  else
    OPEN+=("$b")
  fi
done < <(git for-each-ref --format='%(refname:short) %(objectname)' 'refs/remotes/origin/claude/')
echo "# ${#MERGED[@]} claude/* branch(es) are strict ancestors of origin/main (safe to delete)"
echo "# ${#RESET[@]} sit exactly at origin/main (a reset session branch; kept):"
for b in "${RESET[@]}"; do echo "#   $b"; done
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
