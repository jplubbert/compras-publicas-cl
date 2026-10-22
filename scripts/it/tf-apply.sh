#!/usr/bin/env bash
# Real `terraform apply` of infra/main against GCP (REQ-002; only the deploy workflow or the user runs it, with WIF or
# their own ADC credentials).
#
#   TF_VAR_project_id=… TF_VAR_region=… TF_VAR_github_repository=owner/name scripts/it/tf-apply.sh
#
# Reads its state from TF_STATE_BUCKET (default: <project_id>-tfstate, created by the bootstrap).
# The apply that first creates the ingest Cloud Run Jobs (REQ-006) can fail while the CI actAs grant on compras-ingest,
# created earlier in the same apply, propagates (IAM takes up to ~7 min). Only that error is retried: up to
# TF_APPLY_ATTEMPTS applies (default 5) with TF_APPLY_RETRY_WAIT seconds between them (default 120); any other error
# exits at once.
# Exit 2 on any argument, 1 when a TF_VAR_ is missing, otherwise terraform's code.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/tf-apply.sh" >&2; exit 2; }
for v in TF_VAR_project_id TF_VAR_region TF_VAR_github_repository; do
  [ -n "${!v:-}" ] || { echo "tf-apply: $v is required" >&2; exit 1; }
done
[ -n "${COMPRAS_ENV:-}" ] || exec "$ROOT/scripts/env.sh" "$ROOT/scripts/it/tf-apply.sh"

attempts=${TF_APPLY_ATTEMPTS:-5}
wait_s=${TF_APPLY_RETRY_WAIT:-120}
log=$(mktemp)
trap 'rm -f "$log"' EXIT

dir="$ROOT/infra/main"
terraform -chdir="$dir" init -input=false -reconfigure -plugin-dir="$TF_PLUGIN_DIR" \
  -backend-config="bucket=${TF_STATE_BUCKET:-${TF_VAR_project_id}-tfstate}"

attempt=1
while :; do
  code=0
  terraform -chdir="$dir" apply -input=false -auto-approve -no-color 2>&1 | tee "$log" || code=$?
  [ "$code" -ne 0 ] || exit 0
  if [ "$attempt" -ge "$attempts" ] || ! grep -qi 'iam.serviceaccounts.actAs' "$log"; then
    exit "$code"
  fi
  attempt=$((attempt + 1))
  echo "tf-apply: actAs not propagated yet, retry $attempt/$attempts in ${wait_s}s" >&2
  sleep "$wait_s"
done
