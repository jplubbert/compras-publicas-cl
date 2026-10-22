#!/usr/bin/env bash
# Offline init, validate and terraform test of each Terraform root (works in a fresh worktree: providers come from
# the mirror in .tools/). Run through scripts/env.sh.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[ -n "${COMPRAS_ENV:-}" ] || exec "$ROOT/scripts/env.sh" "$ROOT/scripts/ci/tf-test.sh" "$@"
for r in infra/bootstrap infra/main; do
  terraform -chdir="$ROOT/$r" init -backend=false -input=false -plugin-dir="$TF_PLUGIN_DIR" >/dev/null
  terraform -chdir="$ROOT/$r" validate -no-color
  terraform -chdir="$ROOT/$r" test -no-color
done
