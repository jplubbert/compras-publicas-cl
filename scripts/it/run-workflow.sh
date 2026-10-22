#!/usr/bin/env bash
# Real execution of the daily Workflow and wait for its final state (verify_integration of T-11, REQ-007, DEC-002;
# only the user runs it, with their own ADC credentials, after a green deploy.yml).
#
#   GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 scripts/it/run-workflow.sh [--expect-failure]
#
# Without arguments it expects SUCCEEDED. E5 (--expect-failure): the user first disables the current version of the
# ticket with `gcloud secrets versions disable <n> --secret=mercadopublico-ticket`, runs this script with
# --expect-failure and then enables it again with `gcloud secrets versions enable <n> --secret=mercadopublico-ticket`.
# It then expects FAILED, an error that names ingesta_mercadopublico and no Dataform invocation created since the
# start. This script never changes secrets.
# Optional: WORKFLOW (default compras-diario), IT_TIMEOUT (seconds, default 27000), IT_POLL (seconds, default 30).
# Exit 2 on a bad argument or a missing tool, 1 on missing variables or any failed check, 0 when every check passes.
set -euo pipefail

expect_failure=0
if [ $# -gt 1 ] || { [ $# -eq 1 ] && [ "$1" != "--expect-failure" ]; }; then
  echo "usage: scripts/it/run-workflow.sh [--expect-failure]" >&2
  exit 2
fi
[ $# -eq 1 ] && expect_failure=1
for tool in gcloud curl; do
  command -v "$tool" >/dev/null || { echo "run-workflow: $tool is required" >&2; exit 2; }
done
for v in GOOGLE_CLOUD_PROJECT GCP_REGION; do
  [ -n "${!v:-}" ] || { echo "run-workflow: $v is required" >&2; exit 1; }
done
project=$GOOGLE_CLOUD_PROJECT
region=$GCP_REGION
workflow=${WORKFLOW:-compras-diario}
timeout=${IT_TIMEOUT:-27000}
poll=${IT_POLL:-30}

fail() { echo "run-workflow: $*" >&2; exit 1; }

inicio=$(date -u +%Y-%m-%dT%H:%M:%SZ)
nombre=$(gcloud workflows execute "$workflow" --location="$region" --project="$project" --format='value(name)')
[ -n "$nombre" ] || fail "no execution of $workflow was created"

waited=0
while :; do
  state=$(gcloud workflows executions describe "$nombre" --format='value(state)')
  [ "$state" = ACTIVE ] || break
  [ "$waited" -lt "$timeout" ] || fail "execution $nombre still ACTIVE after ${timeout}s"
  sleep "$poll"
  waited=$((waited + poll))
done

if [ "$expect_failure" -eq 0 ]; then
  [ "$state" = SUCCEEDED ] || fail "execution $nombre ended $state"
  echo "run-workflow: ok execution=$nombre"
  exit 0
fi

[ "$state" = FAILED ] || fail "execution $nombre ended $state, expected FAILED"
context=$(gcloud workflows executions describe "$nombre" --format='value(error.context)')
[[ "$context" == *ingesta_mercadopublico* ]] || fail "execution $nombre did not fail in ingesta_mercadopublico"

url="https://dataform.googleapis.com/v1/projects/$project/locations/$region/repositories/compras-publicas-cl/workflowInvocations"
invocations=$(curl -fsS -H "Authorization: Bearer $(gcloud auth print-access-token)" "$url") \
  || fail "could not list the Dataform invocations"
recent=$(printf '%s' "$invocations" | python3 -c '
import json, sys
since = sys.argv[1]
items = json.load(sys.stdin).get("workflowInvocations", [])
print(sum(1 for i in items if i.get("createTime", "")[:19] >= since[:19]))
' "$inicio") || fail "could not read the Dataform invocations"
[ "$recent" = 0 ] || fail "$recent Dataform invocation(s) created after $inicio"

echo "run-workflow: ok expected failure execution=$nombre"
echo "run-workflow: check the alert email 'Workflow compras-diario falló' and enable the ticket version again" >&2
