#!/usr/bin/env bash
# Offline init, validate and terraform test of each Terraform root (works in a fresh worktree: providers come from
# the mirror in .tools/). Run through scripts/env.sh.
# Ends with one "Tests: F failed, S skipped, P passed, T total" line summed over the roots, the format
# scripts/record_evidence.py counts (terraform's own "Success! N passed, 0 failed." is not recognized).
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[ -n "${COMPRAS_ENV:-}" ] || exec "$ROOT/scripts/env.sh" "$ROOT/scripts/ci/tf-test.sh" "$@"
passed=0 failed=0 skipped=0 code=0
summary='^(Success|Failure)! ([0-9]+) passed, ([0-9]+) failed(, ([0-9]+) skipped)?\.'
for r in infra/bootstrap infra/main; do
  terraform -chdir="$ROOT/$r" init -backend=false -input=false -plugin-dir="$TF_PLUGIN_DIR" >/dev/null
  terraform -chdir="$ROOT/$r" validate -no-color
  out=$(terraform -chdir="$ROOT/$r" test -no-color 2>&1) || code=1
  printf '%s\n' "$out"
  while IFS= read -r line; do
    if [[ $line =~ $summary ]]; then
      passed=$((passed + BASH_REMATCH[2])) failed=$((failed + BASH_REMATCH[3])) skipped=$((skipped + ${BASH_REMATCH[5]:-0}))
    fi
  done <<<"$out"
done
echo "Tests: $failed failed, $skipped skipped, $passed passed, $((passed + failed + skipped)) total"
exit "$code"
