#!/usr/bin/env bash
# Backs up the local state of infra/bootstrap to the state backup bucket (REQ-016). Only the user runs it, after
# applying infra/bootstrap, with their own gcloud (not through scripts/env.sh, whose PATH leaves gcloud out).
#
#   STATE_BACKUP_BUCKET=… scripts/backup-state.sh bootstrap
#
# STATE_BACKUP_BUCKET comes from `terraform -chdir=infra/bootstrap output -raw state_backup_bucket`.
# Exit 2 on a wrong argument or a missing gcloud, 1 when the state file or STATE_BACKUP_BUCKET is missing, otherwise
# the code of gcloud.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

[ $# -eq 1 ] && [ "$1" = bootstrap ] || { echo "usage: scripts/backup-state.sh bootstrap" >&2; exit 2; }
state="$ROOT/infra/bootstrap/terraform.tfstate"
[ -f "$state" ] || { echo "backup-state: infra/bootstrap/terraform.tfstate not found (apply infra/bootstrap first)" >&2; exit 1; }
if [ -z "${STATE_BACKUP_BUCKET:-}" ]; then
  echo "backup-state: STATE_BACKUP_BUCKET is required (terraform -chdir=infra/bootstrap output -raw state_backup_bucket)" >&2
  exit 1
fi
command -v gcloud >/dev/null || { echo "backup-state: gcloud is required" >&2; exit 2; }

dest="gs://$STATE_BACKUP_BUCKET/bootstrap/$(date -u +%Y%m%dT%H%M%SZ).tfstate"
gcloud storage cp "$state" "$dest"
echo "backup-state: ok $dest"
