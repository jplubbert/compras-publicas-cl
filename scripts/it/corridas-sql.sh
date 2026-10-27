#!/usr/bin/env bash
# The day-state rule of gold.dim_corrida against BigQuery (DEC-012, REQ-012 E7; only the user runs it, with their own
# ADC credentials). dataform/tests/corridas-sql.mjs turns dataform/tests/casos-corridas.json into one query that
# evaluates corridas.ultimaCorridaSql over the case runs: the last run by run_id decides the day. No table is read.
#
#   GOOGLE_CLOUD_PROJECT=… scripts/it/corridas-sql.sh
#
# Prints the days whose state differs from the expected one. Exit 2 on any argument or a missing tool, 1 on a missing
# variable, a failed query or any mismatch, 0 when every case agrees.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/corridas-sql.sh" >&2; exit 2; }
for tool in bq jq; do
  command -v "$tool" >/dev/null || { echo "corridas-sql: $tool is required" >&2; exit 2; }
done
[ -n "${GOOGLE_CLOUD_PROJECT:-}" ] || { echo "corridas-sql: GOOGLE_CLOUD_PROJECT is required" >&2; exit 1; }

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

"$ROOT/scripts/env.sh" node "$ROOT/dataform/tests/corridas-sql.mjs" > "$dir/query.sql"
total=$(jq '.esperado | length' "$ROOT/dataform/tests/casos-corridas.json")
bq query --project_id="$GOOGLE_CLOUD_PROJECT" --use_legacy_sql=false --maximum_bytes_billed=10485760 --format=json \
  --quiet < "$dir/query.sql" > "$dir/out.json" || { echo "corridas-sql: the query failed" >&2; exit 1; }
[ -s "$dir/out.json" ] || echo '[]' > "$dir/out.json"
mismatches=$(jq 'length' "$dir/out.json")
jq -r '.[] | "corridas-sql: \(.nombre): expected \(.esperado | tostring), SQL gave \(.obtenido | tostring)"' "$dir/out.json" >&2
echo "corridas-sql: $total cases, $mismatches mismatches"
[ "$mismatches" -eq 0 ]
