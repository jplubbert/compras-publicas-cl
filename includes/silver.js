// Shared SQL helpers of the silver models (REQ-008): state catalogs (T-02), the incremental window and type casts.

const ESTADOS_LICITACION = {
  5: "Publicada",
  6: "Cerrada",
  7: "Desierta",
  8: "Adjudicada",
  18: "Revocada",
  19: "Suspendida",
};

const ESTADOS_OC = {
  4: "Enviada a proveedor",
  5: "En proceso",
  6: "Aceptada",
  9: "Cancelada",
  12: "Recepción conforme",
  13: "Pendiente de recepcionar",
  14: "Recepcionada parcialmente",
  15: "Recepción conforme incompleta",
};

// Days re-read before the newest partition already in the target.
const LOOKBACK_DIAS = 3;

/** CASE that translates a state code; codes outside the catalog give NULL (the domain rule belongs to T-10). */
function estadoSql(expr, catalogo) {
  const whens = Object.entries(catalogo).map(([codigo, texto]) => `WHEN ${codigo} THEN '${texto}'`);
  return `CASE ${expr} ${whens.join(" ")} ELSE NULL END`;
}

/** Raw partitions to read in incremental mode: from LOOKBACK_DIAS before the newest one in the target. */
function ventanaIncremental(selfRef) {
  return `_ingest_date >= IFNULL((SELECT DATE_SUB(MAX(_ingest_date), INTERVAL ${LOOKBACK_DIAS} DAY) FROM ${selfRef}), DATE '1970-01-01')`;
}

/** RUT without dots or spaces, upper-case DV (T-10 validates the DV). */
function rutSql(expr) {
  return `UPPER(REGEXP_REPLACE(${expr}, r'[^0-9kK-]', ''))`;
}

function fechaSql(expr) {
  return `DATE(SAFE_CAST(${expr} AS DATETIME))`;
}

function numericSql(expr) {
  return `SAFE_CAST(${expr} AS NUMERIC)`;
}

module.exports = {
  ESTADOS_LICITACION,
  ESTADOS_OC,
  LOOKBACK_DIAS,
  estadoSql,
  ventanaIncremental,
  rutSql,
  fechaSql,
  numericSql,
};
