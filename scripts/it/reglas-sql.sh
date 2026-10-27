#!/usr/bin/env bash
# The quarantine rules in SQL against BigQuery with the shared cases (REQ-010 E6; only the user runs it, with their own
# ADC credentials). dataform/tests/reglas-sql.mjs turns dataform/tests/casos-reglas.json into one query that evaluates
# motivosSql over each case document; the unit tests run the same cases through the JS version. No table is read.
#
#   GOOGLE_CLOUD_PROJECT=… scripts/it/reglas-sql.sh
#
# Prints the cases whose SQL reasons differ from the expected ones. Exit 2 on any argument or a missing tool, 1 on a
# missing variable, a failed query or any mismatch, 0 when every case agrees.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/reglas-sql.sh" >&2; exit 2; }
for tool in bq jq; do
  command -v "$tool" >/dev/null || { echo "reglas-sql: $tool is required" >&2; exit 2; }
done
[ -n "${GOOGLE_CLOUD_PROJECT:-}" ] || { echo "reglas-sql: GOOGLE_CLOUD_PROJECT is required" >&2; exit 1; }

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

"$ROOT/scripts/env.sh" node "$ROOT/dataform/tests/reglas-sql.mjs" > "$dir/query.sql"
total=$(jq 'length' "$ROOT/dataform/tests/casos-reglas.json")
bq query --project_id="$GOOGLE_CLOUD_PROJECT" --use_legacy_sql=false --maximum_bytes_billed=10485760 --format=json \
  --quiet < "$dir/query.sql" > "$dir/out.json" || { echo "reglas-sql: the query failed" >&2; exit 1; }
[ -s "$dir/out.json" ] || echo '[]' > "$dir/out.json"
mismatches=$(jq 'length' "$dir/out.json")
jq -r '.[] | "reglas-sql: \(.nombre): expected \(.esperado | tostring), SQL gave \(.motivos | tostring)"' "$dir/out.json" >&2
echo "reglas-sql: $total cases, $mismatches mismatches"
[ "$mismatches" -eq 0 ]
