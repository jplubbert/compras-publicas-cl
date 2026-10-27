#!/usr/bin/env bash
# Merge a pull request the way this repository needs it: bring origin/main into the PR branch first (spec/LOG.md is
# append-only and merges by union, see .gitattributes), push, wait until GitHub reports MERGEABLE, then merge with a
# merge commit and delete the branch. Ends on an updated main.
#
#   scripts/merge-pr.sh <pr-number>
#
# Exit 2 on a bad argument or a missing tool, 1 when the PR is not open against main, the working tree is dirty, the
# merge has conflicts outside spec/LOG.md or GitHub never reports MERGEABLE; otherwise the exit code of gh pr merge.
set -euo pipefail

[ $# -eq 1 ] && [[ $1 =~ ^[0-9]+$ ]] || { echo "usage: scripts/merge-pr.sh <pr-number>" >&2; exit 2; }
for tool in gh git; do
  command -v "$tool" >/dev/null || { echo "merge-pr: $tool is required" >&2; exit 2; }
done
n=$1
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "merge-pr: the working tree has changes; commit or stash them first" >&2; exit 1; }

read -r state head base < <(gh pr view "$n" --json state,headRefName,baseRefName --jq '"\(.state) \(.headRefName) \(.baseRefName)"')
[ "$state" = OPEN ] || { echo "merge-pr: #$n is $state, not OPEN" >&2; exit 1; }
[ "$base" = main ] || { echo "merge-pr: #$n targets $base, not main" >&2; exit 1; }

git fetch -q origin
git checkout -q -B "$head" "origin/$head"
if ! git merge-base --is-ancestor origin/main HEAD; then
  echo "merge-pr: bringing origin/main into $head"
  if ! git merge --no-edit -m "Merge origin/main into $head

Task: none
Req: none" origin/main; then
    git merge --abort
    echo "merge-pr: conflicts outside spec/LOG.md; resolve them by hand on $head and run again" >&2
    exit 1
  fi
  git push -q origin "$head"
fi

mergeable=UNKNOWN
for _ in $(seq 1 24); do
  mergeable=$(gh pr view "$n" --json mergeable --jq .mergeable)
  [ "$mergeable" = UNKNOWN ] || break
  sleep 5
done
[ "$mergeable" = MERGEABLE ] || { echo "merge-pr: GitHub reports $mergeable for #$n" >&2; exit 1; }

gh pr merge "$n" --merge --delete-branch
git checkout -q main
git pull -q
echo "merge-pr: #$n merged; main at $(git rev-parse --short HEAD)"
