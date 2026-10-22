#!/usr/bin/env bash
# Real kill switch drill (verify_integration of T-05; only the user runs it, with their own gcloud and ADC
# credentials). Applies infra/bootstrap with a USD 0.01 budget in a throwaway project, checks E2 (under budget: the
# function logs under_budget and billing stays linked) and E1 (at budget: billing is unlinked), finds which billing
# role is enough (DEC-009) and reads the unit of the BigQuery query quota (S-07). E4 is covered by the local tests.
#
#   DRILL_PROJECT_ID=… DRILL_BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX TF_VAR_alert_email=… scripts/it/killswitch-drill.sh
#
# The project must carry the label purpose=killswitch-drill and be new for each drill (the deleted WIF pool "github"
# lingers for 30 days). Optional: TF_VAR_region (us-central1), DRILL_ROLE (roles/billing.projectManager),
# DRILL_TIMEOUT in seconds (600). Cleanup relinks billing, destroys the resources and unlinks billing again; it never
# deletes the project.
# Exit 2 on arguments or a missing gcloud/curl, 1 when a variable is missing or a check fails, 0 when the drill passes.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/killswitch-drill.sh (configured through environment variables)" >&2; exit 2; }
for tool in gcloud curl; do
  command -v "$tool" >/dev/null || { echo "killswitch-drill: $tool is required" >&2; exit 2; }
done
for v in DRILL_PROJECT_ID DRILL_BILLING_ACCOUNT TF_VAR_alert_email; do
  [ -n "${!v:-}" ] || { echo "killswitch-drill: $v is required" >&2; exit 1; }
done

P=$DRILL_PROJECT_ID
ROLE=${DRILL_ROLE:-roles/billing.projectManager}
TIMEOUT=${DRILL_TIMEOUT:-600}
WORKSPACE=killswitch-drill
FUNCTION=billing-killswitch
TOPIC=billing-budget-alerts
export TF_VAR_project_id=$P TF_VAR_billing_account=$DRILL_BILLING_ACCOUNT TF_VAR_region=${TF_VAR_region:-us-central1}
export TF_VAR_github_repository=drill-owner/drill TF_VAR_budget_usd=0.01

tf() { "$ROOT/scripts/env.sh" terraform -chdir="$ROOT/infra/bootstrap" "$@"; }
billing_enabled() { gcloud billing projects describe "$P" --format='value(billingEnabled)'; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
publish() { gcloud pubsub topics publish "$TOPIC" --project="$P" --message="$1" >/dev/null; }
function_logs() { # <filter> <format>
  gcloud logging read --project="$P" --limit=20 --format="$2" \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$FUNCTION\" AND $1"
}

purpose=$(gcloud projects describe "$P" --format='value(labels.purpose)')
if [ "$purpose" != killswitch-drill ]; then
  echo "killswitch-drill: $P lacks the label purpose=killswitch-drill; refusing to touch it" >&2
  exit 1
fi

cleanup() {
  set +e
  echo "killswitch-drill: cleaning up"
  gcloud billing projects link "$P" --billing-account="$DRILL_BILLING_ACCOUNT" >/dev/null
  tf destroy -auto-approve -input=false -var="killswitch_billing_role=$ROLE"
  tf workspace select default
  tf workspace delete "$WORKSPACE"
  gcloud billing projects unlink "$P" >/dev/null
}

gcloud billing projects link "$P" --billing-account="$DRILL_BILLING_ACCOUNT" >/dev/null
trap cleanup EXIT
tf init -input=false
tf workspace select -or-create "$WORKSPACE"
tf apply -auto-approve -input=false -var="killswitch_billing_role=$ROLE"

budget=$(gcloud billing budgets list --billing-account="$DRILL_BILLING_ACCOUNT" --format=json | python3 -c '
import json, sys
name, topic = sys.argv[1], sys.argv[2]
for b in json.load(sys.stdin):
    amount = b.get("amount", {}).get("specifiedAmount", {})
    if b.get("displayName") == name and amount.get("currencyCode") == "USD" and str(amount.get("units", "0")) == "0" \
            and int(amount.get("nanos", 0)) == 10000000 \
            and b.get("notificationsRule", {}).get("pubsubTopic", "").endswith("/topics/" + topic):
        print("ok")
        break
' "$P cap" "$TOPIC")
[ "$budget" = ok ] || { echo "killswitch-drill: no USD 0.01 budget wired to $TOPIC for $P" >&2; exit 1; }

# S-07: the unit of the quota value must match infra/modules/quotas.
gcloud services enable cloudquotas.googleapis.com --project="$P"
api_unit=$(curl -fsS -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $P" \
  "https://cloudquotas.googleapis.com/v1/projects/$P/locations/global/services/bigquery.googleapis.com/quotaInfos/QueryUsagePerDay" |
  python3 -c 'import json, sys; print(json.load(sys.stdin).get("metricUnit", ""))')
tf_unit=$(sed -n 's/^ *quota_unit *= *"\([^"]*\)".*/\1/p' "$ROOT/infra/modules/quotas/main.tf")
if [ "$api_unit" != "$tf_unit" ]; then
  echo "killswitch-drill: quota unit mismatch: API metricUnit=$api_unit, infra/modules/quotas quota_unit=$tf_unit" >&2
  exit 1
fi

# E2: under budget the function runs, logs under_budget and leaves billing linked.
t2=$(now)
publish '{"costAmount":0.0,"budgetAmount":0.01}'
seen="" waited=0
while [ "$waited" -lt "$TIMEOUT" ]; do
  seen=$(function_logs "jsonPayload.decision=\"under_budget\" AND timestamp>=\"$t2\"" 'value(jsonPayload.decision)')
  [ -n "$seen" ] && break
  sleep 15
  waited=$((waited + 15))
done
if [ -z "$seen" ]; then
  echo "killswitch-drill: E2 sin registro de la función" >&2
  exit 1
fi
[ "$(billing_enabled)" = True ] || { echo "killswitch-drill: E2 unlinked billing under budget" >&2; exit 1; }
echo "killswitch-drill: E2 ok"

# E1: at budget billing gets unlinked. Afterwards only billing calls are safe: the project's services stop.
e1() {
  publish '{"costAmount":0.02,"budgetAmount":0.01}'
  local waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    [ "$(billing_enabled)" = False ] && return 0
    sleep 15
    waited=$((waited + 15))
  done
  return 1
}

t1=$(now)
if ! e1; then
  if [ "$ROLE" != roles/billing.projectManager ]; then
    echo "killswitch-drill: unlink failed" >&2
    exit 1
  fi
  echo "killswitch-drill: $ROLE did not unlink; function errors:" >&2
  function_logs "severity>=ERROR AND timestamp>=\"$t1\"" 'value(timestamp,textPayload,jsonPayload.message)' >&2
  ROLE=roles/billing.admin
  tf apply -auto-approve -input=false -var="killswitch_billing_role=$ROLE"
  if ! e1; then
    echo "killswitch-drill: unlink failed" >&2
    exit 1
  fi
fi
echo "killswitch-drill: E1 ok"
echo "killswitch-drill: ok role=$ROLE unit=$api_unit"
