#!/usr/bin/env bash
# Before/after benchmark in GCP (verify_integration of T-13, REQ-013, DEC-007; only the user runs it, with their own
# ADC credentials). benchmarks/run.py creates the three variants of 40,000,000 synthetic tenders in the bench dataset,
# runs the 13 measured jobs without cache and writes benchmarks/results/<fecha>.md; then this script checks the tables
# and the report and runs run.py --dry-run over the same tables.
# The run bills a few GiB against the daily per-user quota of 20 GiB (S-07): run.py subtracts what was already billed
# today and aborts before measuring if the estimate does not fit. Run it at most once a day.
#
#   GCP_PROJECT_ID=… GCP_REGION=us-central1 scripts/env.sh scripts/it/benchmark.sh
#
# Exit 2 on any argument or a missing tool, 1 on missing variables or any failed check, 0 when every check passes.
# It does not commit the report.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/benchmark.sh" >&2; exit 2; }
for tool in bq python3; do
  command -v "$tool" >/dev/null || { echo "benchmark: $tool is required" >&2; exit 2; }
done
for v in GCP_PROJECT_ID GCP_REGION; do
  [ -n "${!v:-}" ] || { echo "benchmark: $v is required" >&2; exit 1; }
done
project=$GCP_PROJECT_ID
region=$GCP_REGION

fail() { echo "benchmark: $*" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

uv run --frozen --directory "$ROOT" python benchmarks/run.py --project "$project" --location "$region" \
  >"$work/run" || fail "run.py failed (see stderr above)"
{ read -r informe; read -r run_id; } <"$work/run"
[ -f "$informe" ] || fail "run.py did not write $informe"

for variante in licitaciones_sin_particion licitaciones_particionada licitaciones_particionada_cluster; do
  bq --project_id="$project" --location="$region" show --format=json "$project:bench.$variante" \
    >"$work/$variante.json" || fail "bench.$variante is missing"
  python3 - "$work/$variante.json" "$variante" <<'PY' || fail "bench.$variante does not match REQ-013"
import json, sys

table = json.load(open(sys.argv[1]))
variante = sys.argv[2]
if table.get("numRows") != "40000000":
    sys.exit(f"{variante}: numRows {table.get('numRows')}, expected 40000000")
if variante == "licitaciones_particionada_cluster":
    if not table.get("requirePartitionFilter"):
        sys.exit(f"{variante}: requirePartitionFilter is not true")
    fields = (table.get("clustering") or {}).get("fields")
    if fields != ["codigo_organismo", "estado"]:
        sys.exit(f"{variante}: clustering.fields {fields}")
PY
done

python3 - "$informe" <<'PY' || fail "the report does not follow REQ-013"
import re, sys

markdown = open(sys.argv[1], encoding="utf-8").read()
for title in ("Variantes", "Reescrituras", "Excluidos"):
    if not re.search(rf"^## {title}$", markdown, re.MULTILINE):
        sys.exit(f"section {title} is missing")
bases, cluster = [], []
for line in markdown.splitlines():
    cells = [c.strip() for c in line.strip().strip("|").split("|")] if line.startswith("|") else []
    if len(cells) > 2 and cells[1] == "licitaciones_sin_particion":
        bases.append(cells[-1])
    if len(cells) > 2 and cells[1] == "licitaciones_particionada_cluster":
        cluster.append(cells[-1])
if not bases or any(cell != "0 %" for cell in bases):
    sys.exit(f"base savings are not 0 %: {bases}")
saved = [float(c.split()[0].replace(",", ".")) for c in cluster if c != "—"]
if not any(value > 0 for value in saved):
    sys.exit(f"licitaciones_particionada_cluster saves nothing: {cluster}")
PY

uv run --frozen --directory "$ROOT" python benchmarks/run.py --project "$project" --location "$region" --dry-run \
  >"$work/dry" || fail "run.py --dry-run failed (see stderr above)"
read -r estimado <"$work/dry"
grep -qF "bytes estimados (cota superior)" "$estimado" || fail "$estimado has no «bytes estimados (cota superior)»"

echo "benchmark: ok run_id=$run_id informe=${informe#"$ROOT"/}"
