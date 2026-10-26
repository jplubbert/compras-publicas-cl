#!/usr/bin/env bash
# Real Banco Central and mindicador.cl ingestion of one day into a test bucket (verify_integration of T-07; only the
# user runs it, with their own ADC credentials). Confirms the S-08 series codes with SearchSeries first. Never writes to
# the production bronze bucket and never prints the token.
#
#   GOOGLE_CLOUD_PROJECT=… IT_BUCKET=<test bucket> scripts/it/ingest-indicadores.sh AAAA-MM-DD
#
# Optional: BCENTRAL_TOKEN_SECRET (full secret version name; default bcentral-token/latest of the project).
# Exit 2 on a bad argument or a missing tool, 1 on missing variables or any failed check, 0 when every check passes.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

fecha=${1:-}
if ! [[ "$fecha" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "usage: scripts/it/ingest-indicadores.sh AAAA-MM-DD" >&2
  exit 2
fi
for tool in gcloud python3; do
  command -v "$tool" >/dev/null || { echo "ingest-indicadores: $tool is required" >&2; exit 2; }
done
for v in GOOGLE_CLOUD_PROJECT IT_BUCKET; do
  [ -n "${!v:-}" ] || { echo "ingest-indicadores: $v is required" >&2; exit 1; }
done
if [ "$IT_BUCKET" = "${GOOGLE_CLOUD_PROJECT}-bronze" ]; then
  echo "ingest-indicadores: IT_BUCKET is the production bronze bucket; use a test bucket" >&2
  exit 1
fi

fail() { echo "ingest-indicadores: $*" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${BCENTRAL_TOKEN_SECRET:-}" ]; then
  token=$(gcloud secrets versions access "$BCENTRAL_TOKEN_SECRET" --project="$GOOGLE_CLOUD_PROJECT") \
    || fail "cannot read the token secret"
else
  token=$(gcloud secrets versions access latest --secret=bcentral-token --project="$GOOGLE_CLOUD_PROJECT") \
    || fail "cannot read the token secret"
fi
[ -n "$token" ] || fail "the token secret is empty"

# S-08: the series codes exist in the BDE catalog. The token goes only to this process, by environment.
BDE_TOKEN="$token" python3 - >"$work/s08" <<'PY' || fail "S-08: $(tail -n 1 "$work/s08" 2>/dev/null)"
import json, os, sys, urllib.parse, urllib.request

BASE = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx"
EXPECTED = {"DAILY": ["F073.UFF.PRE.Z.D", "F073.TCO.PRE.Z.D"], "MONTHLY": ["F074.IPC.VAR.Z.Z.C.M"]}
token = os.environ["BDE_TOKEN"]
for frequency, codes in EXPECTED.items():
    query = urllib.parse.urlencode({"token": token, "function": "SearchSeries", "frequency": frequency})
    try:
        with urllib.request.urlopen(f"{BASE}?{query}", timeout=60) as response:
            # The BDE answers "application/json; charset=ISO-8859-1": json.load() would assume UTF-8 and fail.
            body = json.loads(response.read().decode(response.headers.get_content_charset() or "utf-8"))
    except Exception as exc:  # the message may carry the URL, token included
        print(f"SearchSeries {frequency} failed: {type(exc).__name__}")
        sys.exit(1)
    ids = {info.get("seriesId") for info in body.get("SeriesInfos") or []}
    for code in codes:
        if code not in ids:
            print(f"{code} no está en SearchSeries")
            sys.exit(1)
        print(f"S-08 {code}: encontrada")
PY
cat "$work/s08"

code=0
BRONZE_BUCKET="$IT_BUCKET" \
  "$ROOT/scripts/env.sh" uv run --frozen --directory "$ROOT" python -m compras_ingest indicadores --date "$fecha" \
  >"$work/stdout" 2>"$work/stderr" || code=$?
[ "$code" -eq 0 ] || fail "the job exited with $code (stderr in a temporary file, deleted on exit)"

python3 - "$work/stdout" >"$work/summary" <<'PY' || fail "stdout has no JSON result line"
import json, sys
lines = [line for line in open(sys.argv[1]).read().splitlines() if line.strip()]
result = json.loads(lines[-1])
print(result["run_id"], result["requests"], ",".join(result["ausentes"]) or "-")
PY
read -r run_id requests ausentes <"$work/summary"

download() {
  local fuente=$1 nombre=$2 out=$3
  local prefix="gs://$IT_BUCKET/$fuente/$nombre/fecha=$fecha/run=$run_id/"
  : >"$out"
  if gcloud storage ls "$prefix" >"$work/ls" 2>/dev/null; then
    while read -r obj; do
      [ -n "$obj" ] && gcloud storage cat "$obj" >>"$out"
    done <"$work/ls"
  fi
}

for serie in uf dolar ipc; do
  download bcentral "$serie" "$work/bcentral-$serie.jsonl"
done
for indicador in uf dolar; do
  download mindicador "$indicador" "$work/mindicador-$indicador.jsonl"
done

python3 - "$work" "$ausentes" >"$work/count" <<'PY' || fail "bronze lines do not follow REQ-004/REQ-005"
import json, os, sys

work, ausentes = sys.argv[1], [] if sys.argv[2] == "-" else sys.argv[2].split(",")
required = {"run_id", "ingested_at", "source_url", "http_status", "fecha"}


def load(name):
    path = os.path.join(work, name)
    return [json.loads(line) for line in open(path) if line.strip()]


def check(line, what):
    missing = required - line.keys()
    if missing:
        sys.exit(f"{what}: line without {sorted(missing)}")
    if line["http_status"] != 200:
        sys.exit(f"{what}: http_status {line['http_status']}")


for serie in ("uf", "dolar", "ipc"):
    lines = load(f"bcentral-{serie}.jsonl")
    if len(lines) != 1:
        sys.exit(f"bcentral/{serie}: {len(lines)} lines, expected 1")
    check(lines[0], f"bcentral/{serie}")
    if (lines[0].get("payload") or {}).get("Codigo") != 0:
        sys.exit(f"bcentral/{serie}: payload.Codigo is not 0")
    if "token=***" not in lines[0]["source_url"]:
        sys.exit(f"bcentral/{serie}: source_url without token=***")
n = 0
for indicador in ("uf", "dolar"):
    lines = load(f"mindicador-{indicador}.jsonl")
    if indicador in ausentes:
        print(f"ingest-indicadores: warning: mindicador {indicador} absent", file=sys.stderr)
        continue
    if len(lines) != 1:
        sys.exit(f"mindicador/{indicador}: {len(lines)} lines, expected 1")
    check(lines[0], f"mindicador/{indicador}")
    n += 1
print(n)
PY
read -r mindicador <"$work/count"

for f in "$work/stdout" "$work/stderr" "$work"/bcentral-*.jsonl "$work"/mindicador-*.jsonl; do
  [ -f "$f" ] || continue
  if grep -qF -- "$token" "$f"; then
    fail "the token appears in $(basename "$f")"
  fi
done

echo "ingest-indicadores: ok run_id=$run_id series=3 mindicador=$mindicador requests=$requests"
