#!/usr/bin/env bash
# Checks with `gh` that the latest ci.yml run on a pull request passed (verify_integration of T-04; only the user runs
# it, with their own gh login). Not run through scripts/env.sh, whose PATH has no gh. Honours GH_REPO.
#
#   scripts/it/last-ci-run.sh
#
# Exit 2 without gh, 1 when there is no run or the latest one did not succeed, gh's code if gh fails, otherwise 0.
set -euo pipefail

command -v gh >/dev/null 2>&1 || { echo "last-ci-run: gh is required" >&2; exit 2; }

out=$(gh run list --workflow ci.yml --event pull_request --limit 1 --json status,conclusion,url,headBranch \
  --jq '.[0] // empty | [.status, .conclusion, .url, .headBranch] | @tsv')
[ -n "$out" ] || { echo "last-ci-run: no ci.yml run on a pull request" >&2; exit 1; }

# cut, not read: a tab is IFS whitespace and read would merge the empty conclusion of a run in progress.
status=$(cut -f1 <<<"$out")
conclusion=$(cut -f2 <<<"$out")
url=$(cut -f3 <<<"$out")
branch=$(cut -f4 <<<"$out")
if [ "$status" != completed ] || [ "$conclusion" != success ]; then
  echo "last-ci-run: $status/$conclusion $url"
  exit 1
fi
echo "last-ci-run: success $branch $url"
