// The run record of raw.corridas (DEC-012): one row per job run, read by gold.dim_corrida. Self-contained.

const ESTADOS = ["OK", "PARCIAL", "ERROR"];

/**
 * One row per source and ingest day: the LAST run of the day by run_id (its prefix is the UTC start time), with the
 * count of runs and of partial runs of that day. The day is OK only when its last run was OK: a retry that completes
 * the day after a partial run turns it OK; a partial run after a complete one turns it PARCIAL.
 */
function ultimaCorridaSql(corridas) {
  return `SELECT
    fuente, _ingest_date, run_id, estado, exit_code, requests, fechas, presupuesto_agotado, cursor, finished_at,
    COUNT(*) OVER (PARTITION BY fuente, _ingest_date) AS n_corridas,
    COUNTIF(estado = 'PARCIAL') OVER (PARTITION BY fuente, _ingest_date) AS n_parciales
  FROM ${corridas}
  QUALIFY ROW_NUMBER() OVER (PARTITION BY fuente, _ingest_date ORDER BY run_id DESC) = 1`;
}

module.exports = { ESTADOS, ultimaCorridaSql };
