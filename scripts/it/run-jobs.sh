#!/usr/bin/env bash
# Real execution of both ingest Cloud Run Jobs for one day and check of the raw load (verify_integration of T-08,
# REQ-006; only the user runs it, with their own ADC credentials, after a green deploy.yml).
#
#   GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 scripts/it/run-jobs.sh AAAA-MM-DD
#
# For the newest run R of each source on that day it compares the lines of every bronze file of R (any fecha=…: a
# Mercado Público run that catches up on cursor days writes several) with the rows of raw.<fuente>_<entidad> with
# run_id = R in R's partition. Then E3: it loads R's tenders twice into raw_ci with the `load` subcommand and expects
# twice the rows. mindicador is a secondary source without SLA: a day without its files is skipped.
# Optional: IT_BUDGET (Mercado Público request budget, default 25, to spare the ticket's daily limit).
# Exit 2 on a bad argument or a missing tool, 1 on missing variables or any failed check, 0 when every check passes.
set -euo pipefail

fecha=${1:-}
if [ $# -ne 1 ] || ! [[ "$fecha" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "usage: scripts/it/run-jobs.sh AAAA-MM-DD" >&2
  exit 2
fi
for tool in gcloud bq; do
  command -v "$tool" >/dev/null || { echo "run-jobs: $tool is required" >&2; exit 2; }
done
for v in GOOGLE_CLOUD_PROJECT GCP_REGION; do
  [ -n "${!v:-}" ] || { echo "run-jobs: $v is required" >&2; exit 1; }
done
project=$GOOGLE_CLOUD_PROJECT
region=$GCP_REGION
bucket="gs://${project}-bronze"
budget=${IT_BUDGET:-25}

fail() { echo "run-jobs: $*" >&2; exit 1; }

execute() {
  local job=$1
  shift
  gcloud run jobs execute "$job" --region="$region" --project="$project" --wait "$@" >/dev/null \
    || fail "the execution of $job failed"
}

# Newest run id of a source on that day (run ids sort by start date and time).
latest_run() {
  { gcloud storage ls "$bucket/$1/*/fecha=$fecha/" 2>/dev/null || true; } \
    | sed -n 's#.*/run=\([^/]*\)/.*#\1#p' | sort | tail -n 1
}

entities_of() {
  { gcloud storage ls "$bucket/$1/*/fecha=*/run=$2/*.jsonl" 2>/dev/null || true; } \
    | sed -n "s#^$bucket/$1/\\([^/]*\\)/.*#\\1#p" | sort -u
}

lines_of() {
  gcloud storage cat "$bucket/$1/$2/fecha=*/run=$3/*.jsonl" | wc -l | tr -d ' '
}

# Rows of one run in its partition; the bytes cap guards the query (DEC-003).
rows_of() {
  local dataset=$1 table=$2 run=$3
  local day="${run:0:4}-${run:4:2}-${run:6:2}"
  bq query --project_id="$project" --use_legacy_sql=false --maximum_bytes_billed=1073741824 --format=csv --quiet \
    "SELECT COUNT(*) FROM \`$project.$dataset.$table\` WHERE run_id = '$run' AND _ingest_date = DATE '$day'" \
    | tail -n 1
}

execute compras-mercadopublico --args="mercadopublico,--date=$fecha" --update-env-vars="MP_DAILY_REQUEST_BUDGET=$budget"
execute compras-indicadores --args="indicadores,--date=$fecha"

summary=""
mp_run=""
for fuente in mercadopublico bcentral mindicador; do
  run=$(latest_run "$fuente")
  if [ -z "$run" ]; then
    [ "$fuente" = mindicador ] && { echo "run-jobs: no mindicador files on $fecha; skipped" >&2; continue; }
    fail "no $fuente run under $bucket/$fuente/*/fecha=$fecha/"
  fi
  [ "$fuente" = mercadopublico ] && mp_run=$run
  entities=$(entities_of "$fuente" "$run")
  [ -n "$entities" ] || fail "run $run of $fuente has no JSONL files"
  for entidad in $entities; do
    lines=$(lines_of "$fuente" "$entidad" "$run")
    rows=$(rows_of raw "${fuente}_${entidad}" "$run")
    [ "$rows" = "$lines" ] || fail "raw.${fuente}_${entidad} has $rows rows of run $run, bronze has $lines lines"
    summary="$summary ${fuente}_${entidad}=$rows"
  done
done

# E3: the same run loaded twice into raw_ci keeps both copies with the same run_id.
n=$(lines_of mercadopublico licitaciones "$mp_run")
[ "$n" -gt 0 ] || fail "run $mp_run has no tender lines"
for _ in 1 2; do
  execute compras-mercadopublico --args="load,--fuente=mercadopublico,--run-id=$mp_run" \
    --update-env-vars="RAW_DATASET=raw_ci"
done
rows=$(rows_of raw_ci mercadopublico_licitaciones "$mp_run")
[ "$rows" = "$((2 * n))" ] || fail "raw_ci.mercadopublico_licitaciones has $rows rows of run $mp_run, expected $((2 * n))"

echo "run-jobs: ok fecha=$fecha$summary e3=$rows/$n"
