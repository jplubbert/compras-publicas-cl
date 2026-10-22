#!/usr/bin/env bash
# Silver in the isolated CI run (verify_integration of T-09; only the user runs it, with their own ADC credentials,
# after a green deploy.yml). It loads fixtures into raw_ci, runs Dataform with scripts/ci/dataform-ci.sh (outputs in
# silver_ci) and checks the examples marked «en `ci`»: REQ-008 E2 (one tender loaded as state 5 and then 8, twice as
# in REQ-006 E3, ends as one Adjudicada row), E3 (an older version of that tender loaded afterwards does not overwrite
# it in an incremental run), E4 (a UF day with ND has valor NULL and es_nd) and REQ-011 E4 (every column of
# silver_ci.licitaciones has a description in BigQuery). raw_ci is CI only: its tables are replaced.
#
#   GCP_PROJECT_ID=… GCP_REGION=us-central1 scripts/env.sh scripts/it/dataform-ci.sh
#
# Exit 2 on any argument or a missing tool, 1 on missing variables or any failed check, 0 when every check passes.
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

[ $# -eq 0 ] || { echo "usage: scripts/it/dataform-ci.sh" >&2; exit 2; }
command -v bq >/dev/null || { echo "dataform-ci: bq is required" >&2; exit 2; }
for v in GCP_PROJECT_ID GCP_REGION; do
  [ -n "${!v:-}" ] || { echo "dataform-ci: $v is required" >&2; exit 1; }
done
project=$GCP_PROJECT_ID
region=$GCP_REGION

fail() { echo "dataform-ci: $*" >&2; exit 1; }

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

D=$(date -u +%F)
day=${D//-/}
RUN1="${day}T000000Z-c109a1"
RUN2="${day}T000001Z-c109a2"
LIC=CI-T09-L1
OC=CI-T09-OC1

# One raw line (bronze record, REQ-006): run, ingested_at, table entity, tipo, codigo, payload.
line() {
  printf '{"run_id":"%s","_ingest_date":"%s","ingested_at":"%s","source_url":"https://ci.invalid/%s","http_status":200,"fecha":"%s","entidad":"%s","tipo":"%s","codigo":"%s","payload":%s}\n' \
    "$1" "$D" "$2" "$3" "$D" "$3" "$4" "$5" "$6"
}

licitacion() {
  local estado=$1
  cat <<EOF | tr -d '\n'
{"Cantidad":1,"Listado":[{"CodigoExterno":"$LIC","Nombre":"Licitación de CI","CodigoEstado":$estado,"Tipo":"L1",
"Moneda":"CLP","MontoEstimado":1500000,"Comprador":{"CodigoOrganismo":"7248","NombreOrganismo":"Organismo de CI"},
"Fechas":{"FechaCreacion":"${D}T09:00:00","FechaPublicacion":"${D}T10:00:00","FechaCierre":"${D}T18:00:00",
"FechaAdjudicacion":"${D}T19:00:00"},"Items":{"Cantidad":2,"Listado":[
{"Correlativo":1,"CodigoProducto":43211507,"NombreProducto":"Computador","Descripcion":"Notebook","UnidadMedida":"Unidad",
"Cantidad":2,"Adjudicacion":{"RutProveedor":"76.123.456-7","NombreProveedor":"Proveedor de CI","Cantidad":2,"MontoUnitario":500000}},
{"Correlativo":2,"CodigoProducto":44121701,"NombreProducto":"Lápiz","Descripcion":"Lápices","UnidadMedida":"Caja",
"Cantidad":10,"Adjudicacion":null}]}}]}
EOF
}

orden() {
  cat <<EOF | tr -d '\n'
{"Cantidad":1,"Listado":[{"Codigo":"$OC","Nombre":"Orden de CI","CodigoEstado":6,"CodigoLicitacion":"$LIC",
"TipoMoneda":"CLP","TotalNeto":840336,"Total":1000000,
"Comprador":{"CodigoOrganismo":"7248","NombreOrganismo":"Organismo de CI"},
"Proveedor":{"Codigo":"17793","Nombre":"Proveedor de CI","RutSucursal":"76.123.456-7"},
"Fechas":{"FechaCreacion":"${D}T11:00:00","FechaEnvio":"${D}T11:30:00","FechaAceptacion":"${D}T12:00:00",
"FechaUltimaModificacion":"${D}T12:00:00"}}]}
EOF
}

# BDE GetSeries with n daily observations ending yesterday; the observation at index nd (if any) is ND (T-02).
serie() {
  local codigo=$1 n=$2 nd=${3:--1} obs="" i f
  for ((i = 0; i < n; i++)); do
    f=$(date -u -d "$D -$((n - i)) day" +%d-%m-%Y)
    if [ "$i" -eq "$nd" ]; then
      obs+="{\"indexDateString\":\"$f\",\"value\":\"NaN\",\"statusCode\":\"ND\"},"
    else
      obs+="{\"indexDateString\":\"$f\",\"value\":\"$((39000 + i)).55\",\"statusCode\":\"OK\"},"
    fi
  done
  printf '{"Codigo":0,"Descripcion":"Success","Series":{"seriesId":"%s","Obs":[%s]},"SeriesInfos":[]}' "$codigo" "${obs%,}"
}

mindicador() {
  printf '{"version":"1.7.0","autor":"mindicador.cl","codigo":"%s","serie":[{"fecha":"%sT03:00:00.000Z","valor":%s}]}' "$1" "$D" "$2"
}

UF_ND=4
ND_FECHA=$(date -u -d "$D -$((11 - UF_ND)) day" +%F)
{
  line "$RUN1" "${D}T00:00:20Z" licitaciones detalle "$LIC" "$(licitacion 5)"
  line "$RUN1" "${D}T00:00:30Z" licitaciones detalle "$LIC" "$(licitacion 8)"
} >"$dir/mercadopublico_licitaciones.jsonl"
line "$RUN1" "${D}T00:00:40Z" ordenes_compra detalle "$OC" "$(orden)" >"$dir/mercadopublico_ordenes_compra.jsonl"
line "$RUN1" "${D}T00:01:00Z" uf GetSeries F073.UFF.PRE.Z.D "$(serie F073.UFF.PRE.Z.D 11 "$UF_ND")" >"$dir/bcentral_uf.jsonl"
line "$RUN1" "${D}T00:01:01Z" dolar GetSeries F073.TCO.PRE.Z.D "$(serie F073.TCO.PRE.Z.D 5)" >"$dir/bcentral_dolar.jsonl"
line "$RUN1" "${D}T00:01:02Z" ipc GetSeries G073.IPC.IND.2018.M "$(serie G073.IPC.IND.2018.M 2)" >"$dir/bcentral_ipc.jsonl"
line "$RUN1" "${D}T00:01:03Z" uf indicador uf "$(mindicador uf 39010.55)" >"$dir/mindicador_uf.jsonl"
line "$RUN1" "${D}T00:01:04Z" dolar indicador dolar "$(mindicador dolar 950.10)" >"$dir/mindicador_dolar.jsonl"
line "$RUN2" "${D}T00:00:10Z" licitaciones detalle "$LIC" "$(licitacion 5)" >"$dir/licitacion_vieja.jsonl"

load() {
  local table=$1 file=$2
  shift 2
  bq load --project_id="$project" --location="$region" --source_format=NEWLINE_DELIMITED_JSON "$@" \
    "$project:raw_ci.$table" "$file" "$ROOT/ingest/schemas/$table.json" >/dev/null \
    || fail "the load of $file into raw_ci.$table failed"
}

# Single-value query; the bytes cap guards it (DEC-003, DEC-009).
q() {
  bq query --project_id="$project" --location="$region" --use_legacy_sql=false --maximum_bytes_billed=1073741824 \
    --format=csv --quiet "$1" | tail -n 1
}

expect() {
  local what=$1 sql=$2 want=$3 got
  got=$(q "$sql")
  [ "$got" = "$want" ] || fail "$what: expected $want, got $got"
}

MODELS="licitaciones ordenes_compra licitacion_items compradores proveedores indicadores_diarios"
# The first run must be a full one.
for m in $MODELS; do
  if bq show --project_id="$project" "$project:silver_ci.$m" >/dev/null 2>&1; then
    bq rm -f -t "$project:silver_ci.$m" >/dev/null || fail "could not drop silver_ci.$m"
  fi
done

for t in mercadopublico_licitaciones mercadopublico_ordenes_compra bcentral_uf bcentral_dolar bcentral_ipc mindicador_uf mindicador_dolar; do
  load "$t" "$dir/$t.jsonl" --replace
done
# REQ-006 E3: the same run loaded twice.
load mercadopublico_licitaciones "$dir/mercadopublico_licitaciones.jsonl"

"$ROOT/scripts/ci/dataform-ci.sh" || fail "Dataform run 1 failed"
S="\`$project.silver_ci"
expect "REQ-008 E2" "SELECT FORMAT('%d|%s', COUNT(*), IFNULL(MAX(estado), '')) FROM $S.licitaciones\` WHERE codigo_licitacion = '$LIC'" "1|Adjudicada"

# REQ-008 E3: an older version (state 5, earlier ingested_at) arrives after the newer one.
load mercadopublico_licitaciones "$dir/licitacion_vieja.jsonl"
"$ROOT/scripts/ci/dataform-ci.sh" || fail "Dataform run 2 failed"
expect "REQ-008 E3" "SELECT FORMAT('%d|%s', COUNT(*), IFNULL(MAX(estado), '')) FROM $S.licitaciones\` WHERE codigo_licitacion = '$LIC'" "1|Adjudicada"

expect "REQ-008 E4" "SELECT COUNT(*) FROM $S.indicadores_diarios\` WHERE serie = 'bcentral_uf' AND fecha = DATE '$ND_FECHA' AND valor IS NULL AND es_nd" "1"
expect "REQ-011 E4" "SELECT FORMAT('%t|%d', COUNT(*) > 0, COUNTIF(IFNULL(description, '') = '')) FROM $S.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS\` WHERE table_name = 'licitaciones'" "true|0"
expect "ordenes_compra" "SELECT COUNT(*) FROM $S.ordenes_compra\` WHERE codigo_oc = '$OC' AND total = 1000000 AND estado = 'Aceptada'" "1"

declare -A KEYS=(
  [licitaciones]="codigo_licitacion" [ordenes_compra]="codigo_oc" [licitacion_items]="codigo_licitacion, correlativo"
  [compradores]="codigo_organismo" [proveedores]="rut_proveedor" [indicadores_diarios]="serie, fecha"
)
summary=""
for m in $MODELS; do
  got=$(q "SELECT FORMAT('%d|%d', COUNT(*), COUNT(*) - COUNT(DISTINCT TO_JSON_STRING(STRUCT(${KEYS[$m]})))) FROM $S.$m\`")
  [ "${got%|*}" -gt 0 ] || fail "silver_ci.$m has no rows"
  [ "${got#*|}" = 0 ] || fail "silver_ci.$m has ${got#*|} repeated keys"
  summary="$summary $m=${got%|*}"
done

echo "dataform-ci: ok e2 e3 e4 descriptions$summary"
