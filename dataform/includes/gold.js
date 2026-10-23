// Shared SQL helpers of the gold models (REQ-012): partitioning of the facts, the daily UF and dollar rates and the
// amounts in CLP, UF and USD. Self-contained: references and rule constants come in as arguments.

// The facts are partitioned by month of the document date (under the 4,000 partitions per query write).
const PARTICION = "DATE_TRUNC(fecha_documento, MONTH)";

const CLUSTER = ["codigo_organismo", "proveedor_key"];

/** Partition filter required to read a fact (requirePartitionFilter). */
function filtroParticionSql(desde) {
  return `fecha_documento >= DATE '${desde}'`;
}

/**
 * One row per calendar day from desde to D+1: the exact UF of the day (NULL without observation or ND) and the last
 * observed dollar up to that day with its date.
 */
function tasasSql(indicadores, desde) {
  return `SELECT dia AS fecha,
    uf.valor AS valor_uf,
    LAST_VALUE(dolar.valor IGNORE NULLS) OVER w AS dolar_observado,
    LAST_VALUE(IF(dolar.valor IS NULL, NULL, dia) IGNORE NULLS) OVER w AS fecha_dolar
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE '${desde}', DATE_ADD(CURRENT_DATE('America/Santiago'), INTERVAL 1 DAY))) AS dia
  LEFT JOIN (SELECT fecha, valor FROM ${indicadores} WHERE serie = 'bcentral_uf') uf ON uf.fecha = dia
  LEFT JOIN (SELECT fecha, valor FROM ${indicadores} WHERE serie = 'bcentral_dolar') dolar ON dolar.fecha = dia
  WINDOW w AS (ORDER BY dia ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
}

/** The dollar was imputed when its date is before the document date. */
function fxImputadoSql(fechaDolar, fecha) {
  return `IFNULL(${fechaDolar} < ${fecha}, FALSE)`;
}

/** Three columns <prefijo>_clp, <prefijo>_uf and <prefijo>_usd; currencies without a rate (UTM, EUR) give NULL. */
function montosSql({ monto, moneda, uf, dolar, prefijo }) {
  const clp = `CASE ${moneda} WHEN 'CLP' THEN ${monto} WHEN 'CLF' THEN ${monto} * ${uf} WHEN 'USD' THEN ${monto} * ${dolar} ELSE NULL END`;
  return [
    `${clp} AS ${prefijo}_clp`,
    `CASE ${moneda} WHEN 'CLF' THEN ${monto} ELSE SAFE_DIVIDE(${clp}, ${uf}) END AS ${prefijo}_uf`,
    `CASE ${moneda} WHEN 'USD' THEN ${monto} ELSE SAFE_DIVIDE(${clp}, ${dolar}) END AS ${prefijo}_usd`,
  ].join(",\n    ");
}

module.exports = {
  PARTICION,
  CLUSTER,
  filtroParticionSql,
  tasasSql,
  fxImputadoSql,
  montosSql,
};
