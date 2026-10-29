// Shared SQL helpers of the silver models (REQ-008): state catalogs (T-02), the incremental window and type casts.

// Codes 15 and 11 are not in the published catalog: the detail endpoint sends them with the texts "Revocada" and
// "No aceptada" (first daily run, 2026-10-26); the published 18 Revocada stays for the listing filter. Codes outside
// the catalog take the state text the detail endpoint sends next to the code (16 "Suspendida", nightly run of 2026-10-28).
const ESTADOS_LICITACION = {
  5: "Publicada",
  6: "Cerrada",
  7: "Desierta",
  8: "Adjudicada",
  15: "Revocada",
  18: "Revocada",
  19: "Suspendida",
};

const ESTADOS_OC = {
  4: "Enviada a proveedor",
  5: "En proceso",
  6: "Aceptada",
  9: "Cancelada",
  11: "No aceptada",
  12: "Recepción conforme",
  13: "Pendiente de recepcionar",
  14: "Recepcionada parcialmente",
  15: "Recepción conforme incompleta",
};

// Days re-read before the newest partition already in the target.
const LOOKBACK_DIAS = 3;

/**
 * CASE that translates a state code; codes outside the catalog take `texto` (the state text of the API), and NULL when
 * it is empty too (the domain rule belongs to T-10).
 */
function estadoSql(expr, catalogo, texto = "NULL") {
  const whens = Object.entries(catalogo).map(([codigo, nombre]) => `WHEN ${codigo} THEN '${nombre}'`);
  return `CASE ${expr} ${whens.join(" ")} ELSE ${texto} END`;
}

/**
 * Raw partitions to read in incremental mode: from LOOKBACK_DIAS before the newest one in the target. Measured from the
 * target and not from the clock, so a target that missed some runs (or the quarantine, which keeps only some rows and may
 * lag) catches up from where it stopped; duplicates are handled by the key of each target.
 */
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
