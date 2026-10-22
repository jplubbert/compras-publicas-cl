#!/usr/bin/env bash
# Silver in the isolated CI run (verify_integration of T-09 and T-10; only the user runs it, with their own ADC
# credentials, after a green deploy.yml). It loads fixtures into raw_ci, runs Dataform with scripts/ci/dataform-ci.sh
# (outputs in silver_ci, quarantine and assertions in quarantine_ci) and checks the examples marked «en `ci`»:
# REQ-008 E2 (one tender loaded as state 5 and then 8, twice as in REQ-006 E3, ends as one Adjudicada row), E3 (an
# older version of that tender loaded afterwards does not overwrite it in an incremental run), E4 (a UF day with ND
# has valor NULL and es_nd), REQ-011 E4 (every column of silver_ci.licitaciones has a description in BigQuery),
# REQ-009 E2 (11 consecutive UF days pass the continuity assertion), E3 (a repeated key makes the run fail and the
# uniqueKey assertion returns it), E4 (a UF that differs from mindicador by 1 CLP fails the reconciliation), E5 (a
# 4-day dollar gap passes, a 5-day one fails) and REQ-010 (a tender with a negative amount and an unknown currency and
# an order with a wrong RUT check digit land in quarantine with their reasons and not in silver). Each negative case
# undoes its change and a last run must pass, so raw_ci stays valid for deploy.yml. raw_ci is CI only: its tables are
# replaced.
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
RUN3="${day}T000002Z-c110a3"
LIC=CI-T09-L1
OC=CI-T09-OC1
LIC_Q=CI-T10-Q1
OC_Q=CI-T10-Q2
RUT=76.123.456-0

# One raw line (bronze record, REQ-006): run, ingested_at, table entity, tipo, codigo, payload.
line() {
  printf '{"run_id":"%s","_ingest_date":"%s","ingested_at":"%s","source_url":"https://ci.invalid/%s","http_status":200,"fecha":"%s","entidad":"%s","tipo":"%s","codigo":"%s","payload":%s}\n' \
    "$1" "$D" "$2" "$3" "$D" "$3" "$4" "$5" "$6"
}

# Tender: state, code, estimated amount, currency, RUT of the awarded supplier.
licitacion() {
  local estado=$1 codigo=${2:-$LIC} monto=${3:-1500000} moneda=${4:-CLP} rut=${5:-$RUT}
  cat <<EOF | tr -d '\n'
{"Cantidad":1,"Listado":[{"CodigoExterno":"$codigo","Nombre":"Licitación de CI","CodigoEstado":$estado,"Tipo":"L1",
"Moneda":"$moneda","MontoEstimado":$monto,"Comprador":{"CodigoOrganismo":"7248","NombreOrganismo":"Organismo de CI"},
"Fechas":{"FechaCreacion":"${D}T09:00:00","FechaPublicacion":"${D}T10:00:00","FechaCierre":"${D}T18:00:00",
"FechaAdjudicacion":"${D}T19:00:00"},"Items":{"Cantidad":2,"Listado":[
{"Correlativo":1,"CodigoProducto":43211507,"NombreProducto":"Computador","Descripcion":"Notebook","UnidadMedida":"Unidad",
"Cantidad":2,"Adjudicacion":{"RutProveedor":"$rut","NombreProveedor":"Proveedor de CI","Cantidad":2,"MontoUnitario":500000}},
{"Correlativo":2,"CodigoProducto":44121701,"NombreProducto":"Lápiz","Descripcion":"Lápices","UnidadMedida":"Caja",
"Cantidad":10,"Adjudicacion":null}]}}]}
EOF
}

# Purchase order: code, total, currency, RUT of the supplier branch.
orden() {
  local codigo=${1:-$OC} total=${2:-1000000} moneda=${3:-CLP} rut=${4:-$RUT}
  cat <<EOF | tr -d '\n'
{"Cantidad":1,"Listado":[{"Codigo":"$codigo","Nombre":"Orden de CI","CodigoEstado":6,"CodigoLicitacion":"$LIC",
"TipoMoneda":"$moneda","TotalNeto":840336,"Total":$total,
"Comprador":{"CodigoOrganismo":"7248","NombreOrganismo":"Organismo de CI"},
"Proveedor":{"Codigo":"17793","Nombre":"Proveedor de CI","RutSucursal":"$rut"},
"Fechas":{"FechaCreacion":"${D}T11:00:00","FechaEnvio":"${D}T11:30:00","FechaAceptacion":"${D}T12:00:00",
"FechaUltimaModificacion":"${D}T12:00:00"}}]}
EOF
}

# Date of index i of a series of n daily observations ending yesterday.
dia() { date -u -d "$D -$(($1 - $2)) day" "+${3:-%F}"; }

# BDE GetSeries with n daily observations ending yesterday, valued (base + i).55; the observation at index nd (if any)
# is ND (T-02) and the indexes in [salto_desde, salto_desde + salto_largo) have no observation.
serie() {
  local codigo=$1 n=$2 nd=$3 base=$4 desde=${5:--1} largo=${6:-0} obs="" i f
  for ((i = 0; i < n; i++)); do
    if [ "$i" -ge "$desde" ] && [ "$i" -lt $((desde + largo)) ]; then continue; fi
    f=$(dia "$n" "$i" %d-%m-%Y)
    if [ "$i" -eq "$nd" ]; then
      obs+="{\"indexDateString\":\"$f\",\"value\":\"NaN\",\"statusCode\":\"ND\"},"
    else
      obs+="{\"indexDateString\":\"$f\",\"value\":\"$((base + i)).55\",\"statusCode\":\"OK\"},"
    fi
  done
  printf '{"Codigo":0,"Descripcion":"Success","Series":{"seriesId":"%s","Obs":[%s]},"SeriesInfos":[]}' "$codigo" "${obs%,}"
}

# mindicador at noon UTC: the same date in America/Santiago with or without daylight saving time.
mindicador() {
  printf '{"version":"1.7.0","autor":"mindicador.cl","codigo":"%s","serie":[{"fecha":"%sT12:00:00.000Z","valor":%s}]}' "$1" "$3" "$2"
}

UF_ND=4
ND_FECHA=$(dia 11 "$UF_ND")
AYER=$(date -u -d "$D -1 day" +%F)
# Dollar: 12 days, indexes 4-7 without observations (a 4-day gap, REQ-009 E5); the 5-day case also drops index 8.
DOLAR_INDICE_8=$(dia 12 8)
{
  line "$RUN1" "${D}T00:00:20Z" licitaciones detalle "$LIC" "$(licitacion 5)"
  line "$RUN1" "${D}T00:00:30Z" licitaciones detalle "$LIC" "$(licitacion 8)"
  line "$RUN1" "${D}T00:00:35Z" licitaciones detalle "$LIC_Q" "$(licitacion 5 "$LIC_Q" -1 XYZ)"
} >"$dir/mercadopublico_licitaciones.jsonl"
{
  line "$RUN1" "${D}T00:00:40Z" ordenes_compra detalle "$OC" "$(orden)"
  line "$RUN1" "${D}T00:00:45Z" ordenes_compra detalle "$OC_Q" "$(orden "$OC_Q" 1000000 CLP 12.345.678-0)"
} >"$dir/mercadopublico_ordenes_compra.jsonl"
line "$RUN1" "${D}T00:01:00Z" uf GetSeries F073.UFF.PRE.Z.D "$(serie F073.UFF.PRE.Z.D 11 "$UF_ND" 39000)" >"$dir/bcentral_uf.jsonl"
line "$RUN1" "${D}T00:01:01Z" dolar GetSeries F073.TCO.PRE.Z.D "$(serie F073.TCO.PRE.Z.D 12 -1 950 4 4)" >"$dir/bcentral_dolar.jsonl"
line "$RUN1" "${D}T00:01:02Z" ipc GetSeries G073.IPC.IND.2018.M "$(serie G073.IPC.IND.2018.M 2 -1 39000)" >"$dir/bcentral_ipc.jsonl"
line "$RUN1" "${D}T00:01:03Z" uf indicador uf "$(mindicador uf 39010.55 "$AYER")" >"$dir/mindicador_uf.jsonl"
line "$RUN1" "${D}T00:01:04Z" dolar indicador dolar "$(mindicador dolar 961.55 "$AYER")" >"$dir/mindicador_dolar.jsonl"
line "$RUN2" "${D}T00:00:10Z" licitaciones detalle "$LIC" "$(licitacion 5)" >"$dir/licitacion_vieja.jsonl"
line "$RUN3" "${D}T00:02:00Z" uf indicador uf "$(mindicador uf 39011.55 "$AYER")" >"$dir/mindicador_uf_distinta.jsonl"
line "$RUN3" "${D}T00:03:00Z" uf indicador uf "$(mindicador uf 39010.55 "$AYER")" >"$dir/mindicador_uf_igual.jsonl"
line "$RUN3" "${D}T00:04:00Z" dolar GetSeries F073.TCO.PRE.Z.D "$(serie F073.TCO.PRE.Z.D 12 -1 950 4 5)" >"$dir/bcentral_dolar_hueco.jsonl"
line "$RUN3" "${D}T00:05:00Z" dolar GetSeries F073.TCO.PRE.Z.D "$(serie F073.TCO.PRE.Z.D 12 -1 950 4 4)" >"$dir/bcentral_dolar_base.jsonl"

load() {
  local table=$1 file=$2
  shift 2
  bq load --project_id="$project" --location="$region" --source_format=NEWLINE_DELIMITED_JSON "$@" \
    "$project:raw_ci.$table" "$file" "$ROOT/ingest/schemas/$table.json" >/dev/null \
    || fail "the load of $file into raw_ci.$table failed"
}

# Single-value query (or DML); the bytes cap guards it (DEC-003, DEC-009).
q() {
  bq query --project_id="$project" --location="$region" --use_legacy_sql=false --maximum_bytes_billed=1073741824 \
    --format=csv --quiet "$1" | tail -n 1
}

expect() {
  local what=$1 sql=$2 want=$3 got
  got=$(q "$sql")
  [ "$got" = "$want" ] || fail "$what: expected $want, got $got"
}

# A negative case: the Dataform run must end in error.
must_fail() {
  local caso=$1
  if "$ROOT/scripts/ci/dataform-ci.sh" >"$dir/$caso.log" 2>&1; then
    fail "$caso: la invocación debía terminar en error"
  fi
}

# The uniqueKey assertion of silver.licitaciones, read from the graph instead of guessed.
UNIQUE_LIC=$(cd "$ROOT/dataform" && node_modules/.bin/dataform compile --json --schema-suffix=ci --vars=raw_dataset=raw_ci \
  | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const a = (JSON.parse(s).assertions ?? []).find(
    (x) => x.parentAction?.name === "licitaciones" && x.target.name.endsWith("_assertions_uniqueKey_0"),
  );
  if (!a) process.exit(1);
  console.log(`${a.target.schema}.${a.target.name}`);
});') || fail "the uniqueKey assertion of licitaciones is not in the compiled graph"

MODELS="licitaciones ordenes_compra licitacion_items compradores proveedores indicadores_diarios"
# The first run must be a full one.
for t in $(for m in $MODELS; do echo "silver_ci.$m"; done) quarantine_ci.licitaciones quarantine_ci.ordenes_compra; do
  if bq show --project_id="$project" "$project:$t" >/dev/null 2>&1; then
    bq rm -f -t "$project:$t" >/dev/null || fail "could not drop $t"
  fi
done

for t in mercadopublico_licitaciones mercadopublico_ordenes_compra bcentral_uf bcentral_dolar bcentral_ipc mindicador_uf mindicador_dolar; do
  load "$t" "$dir/$t.jsonl" --replace
done
# REQ-006 E3: the same run loaded twice.
load mercadopublico_licitaciones "$dir/mercadopublico_licitaciones.jsonl"

"$ROOT/scripts/ci/dataform-ci.sh" || fail "Dataform run 1 failed"
S="\`$project.silver_ci"
Q="\`$project.quarantine_ci"
expect "REQ-008 E2" "SELECT FORMAT('%d|%s', COUNT(*), IFNULL(MAX(estado), '')) FROM $S.licitaciones\` WHERE codigo_licitacion = '$LIC'" "1|Adjudicada"

expect "REQ-009 E2" "SELECT COUNT(DISTINCT fecha) FROM $S.indicadores_diarios\` WHERE serie = 'bcentral_uf'" "11"
expect "REQ-009 E2" "SELECT COUNT(*) FROM $Q.assert_uf_continuidad\`" "0"
expect "REQ-009 E5 (4 days)" "SELECT COUNT(*) FROM $Q.assert_dolar_continuidad\`" "0"
expect "reconciliation" "SELECT COUNT(*) FROM $Q.assert_reconciliacion_uf_dolar\`" "0"

expect "REQ-010 $LIC_Q" "SELECT FORMAT('%d|%s|%t', COUNT(*), IFNULL(MAX(ARRAY_TO_STRING(motivos, ',')), ''), LOGICAL_AND(run_id IS NOT NULL AND quarantined_at IS NOT NULL)) FROM $Q.licitaciones\` WHERE codigo_licitacion = '$LIC_Q'" "1|monto_negativo,moneda_desconocida|true"
expect "REQ-010 $OC_Q" "SELECT FORMAT('%d|%s|%t', COUNT(*), IFNULL(MAX(ARRAY_TO_STRING(motivos, ',')), ''), LOGICAL_AND(run_id IS NOT NULL AND quarantined_at IS NOT NULL)) FROM $Q.ordenes_compra\` WHERE codigo_oc = '$OC_Q'" "1|rut_dv_invalido|true"
expect "REQ-010 $LIC_Q not in silver" "SELECT (SELECT COUNT(*) FROM $S.licitaciones\` WHERE codigo_licitacion = '$LIC_Q') + (SELECT COUNT(*) FROM $S.licitacion_items\` WHERE codigo_licitacion = '$LIC_Q')" "0"
expect "REQ-010 $OC_Q not in silver" "SELECT COUNT(*) FROM $S.ordenes_compra\` WHERE codigo_oc = '$OC_Q'" "0"
expect "REQ-010 wrong RUT not in silver" "SELECT COUNT(*) FROM $S.proveedores\` WHERE rut_proveedor = '12345678-0'" "0"
expect "REQ-010 valid rows not in quarantine" "SELECT (SELECT COUNT(*) FROM $Q.licitaciones\` WHERE codigo_licitacion = '$LIC') + (SELECT COUNT(*) FROM $Q.ordenes_compra\` WHERE codigo_oc = '$OC')" "0"

# REQ-008 E3: an older version (state 5, earlier ingested_at) arrives after the newer one.
load mercadopublico_licitaciones "$dir/licitacion_vieja.jsonl"
"$ROOT/scripts/ci/dataform-ci.sh" || fail "Dataform run 2 failed"
expect "REQ-008 E3" "SELECT FORMAT('%d|%s', COUNT(*), IFNULL(MAX(estado), '')) FROM $S.licitaciones\` WHERE codigo_licitacion = '$LIC'" "1|Adjudicada"
expect "REQ-010 incremental" "SELECT COUNT(*) FROM $Q.licitaciones\` WHERE codigo_licitacion = '$LIC_Q'" "1"

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

# REQ-009 E3: a repeated key in silver makes the run fail and the uniqueKey assertion returns it.
dup="INSERT INTO $S.licitaciones\` SELECT * REPLACE ('CI-T10-DUP' AS codigo_licitacion) FROM $S.licitaciones\` WHERE codigo_licitacion = '$LIC'"
for _ in 1 2; do q "$dup" >/dev/null || fail "REQ-009 E3: the duplicate insert failed"; done
must_fail req009-e3
got=$(q "SELECT COUNT(*) FROM \`$project.${UNIQUE_LIC}\`")
[ "$got" -ge 1 ] || fail "REQ-009 E3: expected rows in $UNIQUE_LIC, got $got"
q "DELETE FROM $S.licitaciones\` WHERE codigo_licitacion = 'CI-T10-DUP'" >/dev/null || fail "REQ-009 E3: the cleanup failed"

# REQ-009 E4: mindicador differs from the BDE UF by 1 CLP on D-1.
load mindicador_uf "$dir/mindicador_uf_distinta.jsonl" --replace
must_fail req009-e4
expect "REQ-009 E4" "SELECT FORMAT('%d|%s|%s|%s', COUNT(*), IFNULL(MAX(indicador), ''), IFNULL(CAST(MAX(fecha) AS STRING), ''), IFNULL(CAST(MAX(diferencia) AS STRING), '')) FROM $Q.assert_reconciliacion_uf_dolar\`" "1|uf|$AYER|1"
load mindicador_uf "$dir/mindicador_uf_igual.jsonl" --replace

# REQ-009 E5: a 5-day dollar gap (MERGE never deletes, so the dropped day leaves silver by hand).
load bcentral_dolar "$dir/bcentral_dolar_hueco.jsonl" --replace
q "DELETE FROM $S.indicadores_diarios\` WHERE serie = 'bcentral_dolar' AND fecha = DATE '$DOLAR_INDICE_8'" >/dev/null || fail "REQ-009 E5: the delete failed"
must_fail req009-e5
expect "REQ-009 E5 (5 days)" "SELECT FORMAT('%d|%d', COUNT(*), IFNULL(MAX(dias_sin_observaciones), -1)) FROM $Q.assert_dolar_continuidad\`" "1|5"
expect "REQ-009 E5 reconciliation" "SELECT COUNT(*) FROM $Q.assert_reconciliacion_uf_dolar\`" "0"

# Restore raw_ci to a state that passes, for the deploy.yml run.
load bcentral_dolar "$dir/bcentral_dolar_base.jsonl" --replace
"$ROOT/scripts/ci/dataform-ci.sh" >"$dir/restore.log" 2>&1 || { cat "$dir/restore.log" >&2; fail "the restoring Dataform run failed"; }

echo "dataform-ci: ok e2 e3 e4 descriptions req009-e2 req009-e3 req009-e4 req009-e5 cuarentena$summary"
