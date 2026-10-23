#!/usr/bin/env bash
# Policy tags in BigQuery (verify_integration of T-14, REQ-014, DEC-008; only the user runs it, with their own ADC
# credentials, after a green deploy.yml and scripts/it/migrar-proveedor-key.sh).
#
#   GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 \
#     POLICY_TAG_RUT=$(scripts/env.sh terraform -chdir=infra/main output -raw policy_tag_rut) scripts/it/policy-tags.sh
#
# 1. E7: a daily run (scripts/it/run-workflow.sh) ends SUCCEEDED and rut_persona_natural of silver.proveedores and
#    gold.dim_proveedor carries exactly POLICY_TAG_RUT, while rut_empresa and proveedor_key carry none. SKIP_RUN=1 skips
#    only this first run, when one already ran after the deploy and the migration.
# 2. A second run takes the incremental branch of silver.proveedores (same creationTime, newer lastModifiedTime) and the
#    tags are still there.
# 3. pii.sal has one row and the pii dataset grants no reader beyond compras-dataform and the owners.
# 4. E4: compras-lector (no fine-grained reader role; the user must be in lector_impersonators) is denied
#    rut_persona_natural and may read rut_empresa, in gold.dim_proveedor and in silver.proveedores.
# If a tag check fails, scripts/it/reaplicar-policy-tags.sh <dataset.table> sets the tag again; then rerun with SKIP_RUN=1.
# The access token is masked and never printed. Exit 2 on any argument or a missing tool, 1 on missing variables or any
# failed check, 0 when every check passes.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/policy-tags.sh" >&2; exit 2; }
for tool in gcloud bq curl jq; do
  command -v "$tool" >/dev/null || { echo "policy-tags: $tool is required" >&2; exit 2; }
done
for v in GOOGLE_CLOUD_PROJECT GCP_REGION POLICY_TAG_RUT; do
  [ -n "${!v:-}" ] || { echo "policy-tags: $v is required" >&2; exit 1; }
done
project=$GOOGLE_CLOUD_PROJECT
region=$GCP_REGION
tag=$POLICY_TAG_RUT
api="https://bigquery.googleapis.com/bigquery/v2/projects/$project"

fail() { echo "policy-tags: $*" >&2; exit 1; }

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

# rut_persona_natural carries exactly the tag; rut_empresa and proveedor_key carry none.
revisar_tags() {
  local table=$1 schema
  schema=$(bq show --project_id="$project" --schema --format=json "$project:$table") || fail "could not read the schema of $table"
  jq -e --arg tag "$tag" '
    (map(select(.name == "rut_persona_natural"))[0].policyTags.names // []) == [$tag]
    and all(.[] | select(.name == "rut_empresa" or .name == "proveedor_key"); (.policyTags.names // []) == [])
  ' <<<"$schema" >/dev/null \
    || fail "$table: rut_persona_natural must carry only $tag and rut_empresa and proveedor_key no tag; fallback: scripts/it/reaplicar-policy-tags.sh $table"
}

meta() { bq show --project_id="$project" --format=json "$project:$1" | jq -r ".$2"; }

# 1. E7: the daily run with the tag applied.
if [ "${SKIP_RUN:-0}" != 1 ]; then
  "$ROOT/scripts/it/run-workflow.sh" || fail "E7: the daily run did not end SUCCEEDED"
fi
revisar_tags silver.proveedores
revisar_tags gold.dim_proveedor
creada=$(meta silver.proveedores creationTime) || fail "could not read silver.proveedores"

# 2. The incremental branch (MERGE) keeps the tag.
inicio_ms=$(($(date -u +%s) * 1000))
"$ROOT/scripts/it/run-workflow.sh" || fail "the incremental daily run did not end SUCCEEDED"
[ "$(meta silver.proveedores creationTime)" = "$creada" ] \
  || fail "silver.proveedores was recreated instead of merged; the incremental branch was not checked"
modificada=$(meta silver.proveedores lastModifiedTime)
[ "$modificada" -ge "$inicio_ms" ] || fail "silver.proveedores was not modified by the incremental run ($modificada < $inicio_ms)"
revisar_tags silver.proveedores
revisar_tags gold.dim_proveedor

# 3. The salt: one row, and pii readable only by the pipeline and the owners.
sal=$(bq query --project_id="$project" --location="$region" --use_legacy_sql=false --maximum_bytes_billed=1073741824 \
  --format=csv --quiet "SELECT COUNT(*) FROM \`$project.pii.sal\`" | tail -n 1) || fail "could not count pii.sal"
[ "$sal" = 1 ] || fail "pii.sal must have exactly one row, got $sal"
bq show --project_id="$project" --format=json "$project:pii" | jq -e --arg df "compras-dataform@$project.iam.gserviceaccount.com" '
  all(.access[]; .specialGroup == "projectOwners" or .userByEmail == $df)
' >/dev/null || fail "the pii dataset grants a reader beyond compras-dataform and the project owners"

# 4. E4: a reader without the fine-grained role.
token=$(gcloud auth print-access-token --impersonate-service-account="compras-lector@$project.iam.gserviceaccount.com" 2>/dev/null) \
  || fail "E4: could not impersonate compras-lector (is the user in lector_impersonators?)"
[ -n "$token" ] || fail "E4: empty token for compras-lector"
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$token"

# Runs sql as compras-lector; prints the HTTP code and leaves the response body (or the finished job) in $dir/body.json.
consulta() {
  local sql=$1 code job state body
  body=$(jq -nc --arg q "$sql" --arg loc "$region" '{query: $q, useLegacySql: false, location: $loc, maximumBytesBilled: "1073741824"}')
  code=$(curl -sS -o "$dir/body.json" -w '%{http_code}' -X POST -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' --data "$body" "$api/queries") || fail "E4: the query request failed"
  if [ "$code" = 200 ] && [ "$(jq -r '.jobComplete' "$dir/body.json")" != true ]; then
    job=$(jq -r '.jobReference.jobId' "$dir/body.json")
    for _ in $(seq 1 60); do
      code=$(curl -sS -o "$dir/body.json" -w '%{http_code}' -H "Authorization: Bearer $token" \
        "$api/jobs/$job?location=$region") || fail "E4: could not read job $job"
      state=$(jq -r '.status.state' "$dir/body.json")
      [ "$state" != DONE ] || break
      sleep 2
    done
    [ "$state" = DONE ] || fail "E4: job $job did not finish"
  fi
  echo "$code"
}

denegado() {
  local table=$1 code reason
  code=$(consulta "SELECT rut_persona_natural FROM \`$project.$table\` LIMIT 1")
  if [[ "$code" == 4* ]]; then
    jq -e '(.error.errors // [] | any(.reason == "accessDenied")) or .error.status == "PERMISSION_DENIED"' "$dir/body.json" >/dev/null \
      || fail "E4 $table: rut_persona_natural failed for another reason: $(jq -c '.error.errors // .error' "$dir/body.json")"
  elif [ "$code" = 200 ]; then
    reason=$(jq -r '.status.errorResult.reason // empty' "$dir/body.json")
    [ "$reason" = accessDenied ] || fail "E4 $table: rut_persona_natural was not denied to compras-lector (${reason:-no error})"
  else
    fail "E4 $table: unexpected HTTP $code"
  fi
  if grep -qiE 'policy tag|fineGrainedGet' "$dir/body.json"; then
    echo "policy-tags: $table denial names the policy tag" >&2
  fi
}

permitido() {
  local table=$1 code
  code=$(consulta "SELECT rut_empresa FROM \`$project.$table\` LIMIT 1")
  [ "$code" = 200 ] || fail "E4 $table: rut_empresa returned HTTP $code: $(jq -c '.error // .' "$dir/body.json")"
  jq -e '(.jobComplete // (.status.state == "DONE")) and (.status.errorResult == null)' "$dir/body.json" >/dev/null \
    || fail "E4 $table: rut_empresa failed for compras-lector: $(jq -c '.status.errorResult // .' "$dir/body.json")"
}

for table in gold.dim_proveedor silver.proveedores; do
  denegado "$table"
  permitido "$table"
done

echo "policy-tags: ok e2-bq e2-bq-incremental e4 e7 sal"
