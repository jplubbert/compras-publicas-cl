#!/usr/bin/env bash
# Dataform run in the isolated CI run (REQ-006 E5, «En `ci`» of the Glossary): every action and its assertions, with
# outputs in the *_ci datasets (--schema-suffix=ci) reading raw_ci (--vars=raw_dataset=raw_ci). The deploy workflow
# runs it after publishing the image, authenticated with WIF: the credentials file carries no key, so the CLI uses
# Application Default Credentials (DEC-004). The salt of the run is its own, in pii_ci.sal (--vars=sal_dataset=pii_ci,
# REQ-014 E8), never pii.sal.
#
# POLICY_TAG_RUT is the compilation variable policy_tag_rut (REQ-014), the Terraform output that the apply job exports.
#
#   GCP_PROJECT_ID=… GCP_REGION=… POLICY_TAG_RUT=… scripts/env.sh scripts/ci/dataform-ci.sh
#
# Exit 2 on any argument, 1 when a variable is missing, otherwise dataform's code.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/ci/dataform-ci.sh" >&2; exit 2; }
for v in GCP_PROJECT_ID GCP_REGION POLICY_TAG_RUT; do
  [ -n "${!v:-}" ] || { echo "dataform-ci: $v is required" >&2; exit 1; }
done

creds=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/df-credentials.XXXXXX")
trap 'rm -f "$creds"' EXIT
printf '{"projectId": "%s", "location": "%s"}\n' "$GCP_PROJECT_ID" "$GCP_REGION" >"$creds"

cd "$ROOT/dataform"
node_modules/.bin/dataform run . --credentials="$creds" --default-database="$GCP_PROJECT_ID" \
  --default-location="$GCP_REGION" --schema-suffix=ci "--vars=raw_dataset=raw_ci,sal_dataset=pii_ci,policy_tag_rut=$POLICY_TAG_RUT,umbral_cuarentena=1"
