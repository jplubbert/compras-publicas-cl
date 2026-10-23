#!/usr/bin/env bash
# One-off migration of T-14 (REQ-014, DEC-008; only the user runs it, with their own ADC credentials, once after the
# merge that brings proveedor_key). silver.proveedores, ordenes_compra and licitacion_items (and their silver_ci twins)
# change their supplier column from the RUT to proveedor_key, and an incremental MERGE fails on a table without it. This
# drops each of those tables that exists without proveedor_key; the next Dataform run rebuilds it in full from raw
# (400 days, DEC-006) or raw_ci. Idempotent: a table that already has proveedor_key is left alone.
#
#   GOOGLE_CLOUD_PROJECT=… GCP_REGION=us-central1 scripts/it/migrar-proveedor-key.sh
#
# Exit 2 on any argument or a missing tool, 1 on missing variables or any failure, 0 at the end.
set -euo pipefail

[ $# -eq 0 ] || { echo "usage: scripts/it/migrar-proveedor-key.sh" >&2; exit 2; }
command -v bq >/dev/null || { echo "migrar-proveedor-key: bq is required" >&2; exit 2; }
for v in GOOGLE_CLOUD_PROJECT GCP_REGION; do
  [ -n "${!v:-}" ] || { echo "migrar-proveedor-key: $v is required" >&2; exit 1; }
done
project=$GOOGLE_CLOUD_PROJECT
region=$GCP_REGION

fail() { echo "migrar-proveedor-key: $*" >&2; exit 1; }

# Metadata query only; the bytes cap guards it (DEC-003).
q() {
  bq query --project_id="$project" --location="$region" --use_legacy_sql=false --maximum_bytes_billed=1073741824 \
    --format=csv --quiet "$1" | tail -n 1
}

dropped=""
for dataset in silver silver_ci; do
  for table in proveedores ordenes_compra licitacion_items; do
    exists=$(q "SELECT COUNT(*) FROM \`$project.$dataset.INFORMATION_SCHEMA.TABLES\` WHERE table_name = '$table'") \
      || fail "could not read $dataset.INFORMATION_SCHEMA.TABLES"
    [ "$exists" = 1 ] || continue
    has_key=$(q "SELECT COUNT(*) FROM \`$project.$dataset.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name = '$table' AND column_name IN ('proveedor_key', 'proveedor_key_adjudicado')") \
      || fail "could not read the columns of $dataset.$table"
    [ "$has_key" = 0 ] || continue
    bq rm -f -t "$project:$dataset.$table" >/dev/null || fail "could not drop $dataset.$table"
    dropped="$dropped $dataset.$table"
  done
done

echo "migrar-proveedor-key: ok dropped:${dropped:- none}"
