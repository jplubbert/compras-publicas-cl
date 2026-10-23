#!/usr/bin/env bash
# Fallback of scripts/it/policy-tags.sh (REQ-014, DEC-008; only the user runs it, with their own ADC credentials, and only
# when a tag check of policy-tags.sh fails). It sets POLICY_TAG_RUT on rut_persona_natural of the table, leaves every
# other column as is, and checks the result. Idempotent. If it was needed, record it as a finding (Dataform did not
# apply the tag in that branch) and rerun policy-tags.sh with SKIP_RUN=1.
#
#   GOOGLE_CLOUD_PROJECT=… POLICY_TAG_RUT=… scripts/it/reaplicar-policy-tags.sh silver.proveedores|gold.dim_proveedor
#
# Exit 2 on a bad argument or a missing tool, 1 on missing variables or a failed update or check, 0 when the tag is set.
set -euo pipefail

if [ $# -ne 1 ] || { [ "$1" != silver.proveedores ] && [ "$1" != gold.dim_proveedor ]; }; then
  echo "usage: scripts/it/reaplicar-policy-tags.sh silver.proveedores|gold.dim_proveedor" >&2
  exit 2
fi
table=$1
for tool in bq jq; do
  command -v "$tool" >/dev/null || { echo "reaplicar-policy-tags: $tool is required" >&2; exit 2; }
done
for v in GOOGLE_CLOUD_PROJECT POLICY_TAG_RUT; do
  [ -n "${!v:-}" ] || { echo "reaplicar-policy-tags: $v is required" >&2; exit 1; }
done
project=$GOOGLE_CLOUD_PROJECT
tag=$POLICY_TAG_RUT

fail() { echo "reaplicar-policy-tags: $*" >&2; exit 1; }

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

bq show --project_id="$project" --schema --format=json "$project:$table" >"$dir/schema.json" \
  || fail "could not read the schema of $table"
jq -e 'any(.[]; .name == "rut_persona_natural")' "$dir/schema.json" >/dev/null || fail "$table has no rut_persona_natural"
jq --arg tag "$tag" 'map(if .name == "rut_persona_natural" then .policyTags = {names: [$tag]} else . end)' \
  "$dir/schema.json" >"$dir/new.json"
bq update --project_id="$project" --schema="$dir/new.json" "$project:$table" >/dev/null || fail "the update of $table failed"

# The same check as revisar_tags of policy-tags.sh.
bq show --project_id="$project" --schema --format=json "$project:$table" | jq -e --arg tag "$tag" '
  (map(select(.name == "rut_persona_natural"))[0].policyTags.names // []) == [$tag]
  and all(.[] | select(.name == "rut_empresa" or .name == "proveedor_key"); (.policyTags.names // []) == [])
' >/dev/null || fail "$table: the tag is still not set as expected"

echo "reaplicar-policy-tags: ok $table"
