#!/usr/bin/env bash
# Real Mercado Público ingestion of one day into a test bucket (verify_integration of T-06; only the user runs it, with
# their own ADC credentials). Never writes to the production bronze bucket.
#
#   GOOGLE_CLOUD_PROJECT=… IT_BUCKET=<test bucket> scripts/it/ingest-mp.sh AAAA-MM-DD
#
# Optional: IT_BUDGET (request budget, default 25, to spare the ticket's daily limit) and MP_TICKET_SECRET (full
# secret version name; default mercadopublico-ticket/latest of the project).
# Exit 2 on a bad argument or a missing tool, 1 on missing variables or any failed check, 0 when every check passes.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

fecha=${1:-}
if ! [[ "$fecha" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "usage: scripts/it/ingest-mp.sh AAAA-MM-DD" >&2
  exit 2
fi
for tool in gcloud python3; do
  command -v "$tool" >/dev/null || { echo "ingest-mp: $tool is required" >&2; exit 2; }
done
for v in GOOGLE_CLOUD_PROJECT IT_BUCKET; do
  [ -n "${!v:-}" ] || { echo "ingest-mp: $v is required" >&2; exit 1; }
done
if [ "$IT_BUCKET" = "${GOOGLE_CLOUD_PROJECT}-bronze" ]; then
  echo "ingest-mp: IT_BUCKET is the production bronze bucket; use a test bucket" >&2
  exit 1
fi
budget=${IT_BUDGET:-25}

fail() { echo "ingest-mp: $*" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${MP_TICKET_SECRET:-}" ]; then
  ticket=$(gcloud secrets versions access "$MP_TICKET_SECRET" --project="$GOOGLE_CLOUD_PROJECT") \
    || fail "cannot read the ticket secret"
else
  ticket=$(gcloud secrets versions access latest --secret=mercadopublico-ticket --project="$GOOGLE_CLOUD_PROJECT") \
    || fail "cannot read the ticket secret"
fi
[ -n "$ticket" ] || fail "the ticket secret is empty"

cursor="gs://$IT_BUCKET/mercadopublico/_cursor.json"
gcloud storage rm --quiet "$cursor" >/dev/null 2>&1 || true

code=0
BRONZE_BUCKET="$IT_BUCKET" MP_DAILY_REQUEST_BUDGET="$budget" \
  "$ROOT/scripts/env.sh" uv run --frozen --directory "$ROOT" python -m compras_ingest mercadopublico --date "$fecha" \
  >"$work/stdout" 2>"$work/stderr" || code=$?
[ "$code" -eq 0 ] || fail "the job exited with $code (stderr in a temporary file, deleted on exit)"

python3 - "$work/stdout" >"$work/summary" <<'PY' || fail "stdout has no JSON result line"
import json, sys
lines = [line for line in open(sys.argv[1]).read().splitlines() if line.strip()]
result = json.loads(lines[-1])
print(result["run_id"], result["requests"], "1" if result["presupuesto_agotado"] else "0")
PY
read -r run_id requests exhausted <"$work/summary"

for entidad in licitaciones ordenes_compra; do
  prefix="gs://$IT_BUCKET/mercadopublico/$entidad/fecha=$fecha/run=$run_id/"
  if gcloud storage ls "$prefix" >"$work/ls-$entidad" 2>/dev/null; then
    while read -r obj; do
      [ -n "$obj" ] && gcloud storage cat "$obj" >>"$work/objects.jsonl"
    done <"$work/ls-$entidad"
  fi
done
[ -s "$work/objects.jsonl" ] || fail "no objects under run=$run_id"

if [ "$exhausted" = 1 ]; then
  gcloud storage cat "$cursor" >"$work/cursor.json" 2>/dev/null || fail "budget exhausted but no cursor at $cursor"
fi

python3 - "$work/objects.jsonl" >"$work/count" <<'PY' || fail "bronze lines do not follow REQ-004"
import json, sys
lines = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
required = {"run_id", "ingested_at", "source_url", "http_status", "fecha"}
for line in lines:
    missing = required - line.keys()
    if missing:
        sys.exit(f"line without {sorted(missing)}")
    if "ticket=***" not in line["source_url"]:
        sys.exit("source_url without ticket=***")
if not any(line.get("tipo") == "listado" and line["http_status"] == 200 for line in lines):
    sys.exit("no listing with http_status 200")
print(len(lines))
PY
read -r lineas <"$work/count"

for f in "$work/stdout" "$work/stderr" "$work/objects.jsonl" "$work/cursor.json"; do
  [ -f "$f" ] || continue
  if grep -qF -- "$ticket" "$f"; then
    fail "the ticket appears in $(basename "$f")"
  fi
done

echo "ingest-mp: ok run_id=$run_id lineas=$lineas requests=$requests"
