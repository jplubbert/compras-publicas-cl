#!/usr/bin/env bash
# Real `terraform plan` of a Terraform root against GCP (verify_integration of T-03; only the user or CI runs it, with
# their own ADC or WIF credentials). Never applies.
#
#   TF_VAR_project_id=… TF_VAR_region=… TF_VAR_github_repository=owner/name scripts/it/tf-plan.sh <bootstrap|main>
#
# main reads its state from TF_STATE_BUCKET (default: <project_id>-tfstate, created by the bootstrap).
# Exit 2 on a bad argument, 1 when a TF_VAR_ is missing, otherwise terraform's code (plan changes count as success).
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

case "${1:-}" in
  bootstrap|main) target=$1 ;;
  *) echo "usage: scripts/it/tf-plan.sh <bootstrap|main>" >&2; exit 2 ;;
esac
for v in TF_VAR_project_id TF_VAR_region TF_VAR_github_repository; do
  [ -n "${!v:-}" ] || { echo "tf-plan: $v is required" >&2; exit 1; }
done
[ -n "${COMPRAS_ENV:-}" ] || exec "$ROOT/scripts/env.sh" "$ROOT/scripts/it/tf-plan.sh" "$@"

dir="$ROOT/infra/$target"
if [ "$target" = main ]; then
  terraform -chdir="$dir" init -input=false -reconfigure -plugin-dir="$TF_PLUGIN_DIR" \
    -backend-config="bucket=${TF_STATE_BUCKET:-${TF_VAR_project_id}-tfstate}"
else
  terraform -chdir="$dir" init -input=false -plugin-dir="$TF_PLUGIN_DIR"
fi
code=0
terraform -chdir="$dir" plan -input=false -lock=false -no-color -detailed-exitcode || code=$?
if [ "$code" -eq 0 ] || [ "$code" -eq 2 ]; then
  echo "tf-plan: $target ok"
  exit 0
fi
exit "$code"
