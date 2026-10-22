#!/usr/bin/env bash
# State backup check (verify_integration of T-17, REQ-016 E6; only the user runs it, with their own gcloud and ADC
# credentials as owner of the backup project). Finds the infra/main backup of a commit and the bootstrap backup in the
# backup bucket, and restores the former with `terraform state push` into a local-backend copy of infra/main. It never
# touches the real remote state nor the state bucket.
#
#   STATE_BACKUP_BUCKET=… [STATE_BACKUP_SHA=<sha>] scripts/it/state-backup.sh
#
# STATE_BACKUP_SHA defaults to origin/main.
# Exit 2 on arguments or a missing gcloud, 1 when a variable or a backup is missing or a check fails, 0 when it passes.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/state-backup.sh (configured through environment variables)" >&2; exit 2; }
command -v gcloud >/dev/null || { echo "state-backup: gcloud is required" >&2; exit 2; }
[ -n "${STATE_BACKUP_BUCKET:-}" ] || { echo "state-backup: STATE_BACKUP_BUCKET is required" >&2; exit 1; }

B=$STATE_BACKUP_BUCKET
SHA=${STATE_BACKUP_SHA:-$(git -C "$ROOT" rev-parse origin/main)}

listing=$(gcloud storage ls "gs://$B/infra-main/")
object=$(printf '%s\n' "$listing" | grep -- "-$SHA\.tfstate\$" | sort | tail -n 1 || true)
if [ -z "$object" ]; then
  echo "state-backup: no infra-main backup for $SHA in gs://$B/infra-main/:" >&2
  printf '%s\n' "$listing" >&2
  exit 1
fi

if [ -z "$(gcloud storage ls "gs://$B/bootstrap/" 2>/dev/null || true)" ]; then
  echo "state-backup: no bootstrap backup in gs://$B/bootstrap/; run scripts/backup-state.sh bootstrap" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/infra"
cp -r "$ROOT/infra/modules" "$tmp/infra/modules"
mkdir "$tmp/infra/main"
find "$ROOT/infra/main" -mindepth 1 -maxdepth 1 ! -name .terraform -exec cp -r {} "$tmp/infra/main/" \;
printf 'terraform {\n  backend "local" {}\n}\n' >"$tmp/infra/main/backend_override.tf"

gcloud storage cp "$object" "$tmp/restore.tfstate"

"$ROOT/scripts/env.sh" bash -c '
  set -euo pipefail
  dir=$1/infra/main
  terraform -chdir="$dir" init -input=false -plugin-dir="$TF_PLUGIN_DIR" >/dev/null
  terraform -chdir="$dir" state push "$1/restore.tfstate"
  terraform -chdir="$dir" state pull >"$1/pulled.tfstate"
  terraform -chdir="$dir" state list >"$1/resources.txt"
' _ "$tmp"

python3 - "$tmp/restore.tfstate" "$tmp/pulled.tfstate" <<'EOF'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
if (a["lineage"], a["serial"]) != (b["lineage"], b["serial"]):
    sys.exit(f"state-backup: restored state differs: {a['lineage']}/{a['serial']} vs {b['lineage']}/{b['serial']}")
EOF
[ -s "$tmp/resources.txt" ] || { echo "state-backup: the restored state has no resources" >&2; exit 1; }
echo "state-backup: ok $object"
