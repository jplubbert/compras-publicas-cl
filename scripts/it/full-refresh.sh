#!/usr/bin/env bash
# Full refresh of silver and gold from raw (REQ-008; only the user runs it, with their own ADC credentials). Needed
# when a rule or a catalog changes: silver and the quarantine are incremental, so rows already loaded are not
# re-derived by the nightly run. It compiles dataform-main (DEC-010) with the production variables, stops on any
# compilation error, and then runs one invocation with fullyRefreshIncrementalTablesEnabled over the silver and gold
# tags. The salt of pii.sal is safe: generar_sal inserts only when the table is empty (DEC-008).
#
#   GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 \
#     POLICY_TAG_RUT=$(scripts/env.sh terraform -chdir=infra/main output -raw policy_tag_rut) \
#     scripts/it/full-refresh.sh [--dry-run]
#
# --dry-run compiles and stops (seconds, free): run it first. The refresh itself takes minutes and rebuilds every
# silver and gold table from the raw partitions still kept (400 days). Exit 2 on a bad argument or a missing tool, 1 on
# a missing variable, a compilation error or an invocation that does not end SUCCEEDED, 0 when every action succeeded.
set -euo pipefail

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) echo "usage: scripts/it/full-refresh.sh [--dry-run]" >&2; exit 2 ;;
esac
[ $# -le 1 ] || { echo "usage: scripts/it/full-refresh.sh [--dry-run]" >&2; exit 2; }
for tool in gcloud curl jq; do
  command -v "$tool" >/dev/null || { echo "full-refresh: $tool is required" >&2; exit 2; }
done
for v in GOOGLE_CLOUD_PROJECT GCP_REGION POLICY_TAG_RUT; do
  [ -n "${!v:-}" ] || { echo "full-refresh: $v is required" >&2; exit 1; }
done
project=$GOOGLE_CLOUD_PROJECT
region=$GCP_REGION
repo="projects/$project/locations/$region/repositories/${DATAFORM_REPOSITORY:-compras-publicas-cl}"
api="https://dataform.googleapis.com/v1"
sa="${DATAFORM_SERVICE_ACCOUNT:-compras-dataform@$project.iam.gserviceaccount.com}"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
token=$(gcloud auth print-access-token)
auth=(-s -H "Authorization: Bearer $token" -H "Content-Type: application/json")

# 1. Compile dataform-main with the production variables (the same the Workflow uses, orchestration/daily.yaml).
jq -n --arg db "$project" --arg loc "$region" --arg tag "$POLICY_TAG_RUT" \
  '{gitCommitish: "dataform-main", codeCompilationConfig: {defaultDatabase: $db, defaultLocation: $loc, vars: {raw_dataset: "raw", policy_tag_rut: $tag}}}' \
  > "$dir/compile.json"
curl "${auth[@]}" -X POST "$api/$repo/compilationResults" -d @"$dir/compile.json" > "$dir/compiled.json"
compilation=$(jq -r '.name // empty' "$dir/compiled.json")
[ -n "$compilation" ] || { echo "full-refresh: compilation request failed: $(jq -c '.error // .' "$dir/compiled.json")" >&2; exit 1; }
errors=$(jq '(.compilationErrors // []) | length' "$dir/compiled.json")
if [ "$errors" -ne 0 ]; then
  jq -r '.compilationErrors[] | "full-refresh: \(.fileName // "?"): \(.message)"' "$dir/compiled.json" >&2
  exit 1
fi
echo "full-refresh: compiled $(jq -r .resolvedGitCommitSha "$dir/compiled.json") of dataform-main without errors"
[ "$dry_run" -eq 0 ] || exit 0

# 2. One invocation that rebuilds every incremental table of silver (and the quarantine) and then gold.
jq -n --arg c "$compilation" --arg sa "$sa" \
  '{compilationResult: $c, invocationConfig: {includedTags: ["silver", "gold"], transitiveDependenciesIncluded: true, fullyRefreshIncrementalTablesEnabled: true, serviceAccount: $sa}}' \
  > "$dir/invoke.json"
curl "${auth[@]}" -X POST "$api/$repo/workflowInvocations" -d @"$dir/invoke.json" > "$dir/invocation.json"
invocation=$(jq -r '.name // empty' "$dir/invocation.json")
[ -n "$invocation" ] || { echo "full-refresh: invocation request failed: $(jq -c '.error // .' "$dir/invocation.json")" >&2; exit 1; }
echo "full-refresh: invocation $invocation"
state=RUNNING
while [ "$state" = RUNNING ]; do
  sleep 15
  token=$(gcloud auth print-access-token)
  auth=(-s -H "Authorization: Bearer $token" -H "Content-Type: application/json")
  state=$(curl "${auth[@]}" "$api/$invocation" | jq -r .state)
done
curl "${auth[@]}" "$api/$invocation:query?pageSize=200" | jq -r '.workflowInvocationActions[] | .state' | sort | uniq -c \
  | awk '{printf "full-refresh: %s actions %s\n", $1, $2}'
echo "full-refresh: $state"
[ "$state" = SUCCEEDED ]
