// Prints the BigQuery query that runs the cases of casos-corridas.json through corridas.ultimaCorridaSql (DEC-012,
// REQ-012 E7): one row per day whose result differs from the expected one (an empty result means the rule holds).
// No table is read. Run by scripts/it/corridas-sql.sh; `node dataform/tests/corridas-sql.mjs` just prints the query.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const corridas = createRequire(import.meta.url)(join(project, 'includes/corridas.js'));
const casos = JSON.parse(readFileSync(join(project, 'tests/casos-corridas.json'), 'utf8'));

const literal = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function consulta() {
  const filas = casos.corridas.map(
    (c) =>
      `STRUCT(${literal(c.run_id)} AS run_id, ${literal(c.fuente)} AS fuente, DATE ${literal(c._ingest_date)} AS _ingest_date, ` +
      `${literal(c.estado)} AS estado, 0 AS exit_code, 0 AS requests, ARRAY<DATE>[] AS fechas, FALSE AS presupuesto_agotado, ` +
      `CAST(NULL AS STRING) AS cursor, TIMESTAMP '2026-10-27 00:00:00' AS finished_at)`,
  );
  const esperado = casos.esperado.map(
    (e) =>
      `STRUCT(${literal(e.nombre)} AS nombre, ${literal(e.fuente)} AS fuente, DATE ${literal(e._ingest_date)} AS _ingest_date, ` +
      `${literal(e.ultimo_run_id)} AS ultimo_run_id, ${literal(e.estado)} AS estado, ${e.n_corridas} AS n_corridas, ${e.n_parciales} AS n_parciales)`,
  );
  return `WITH corridas AS (SELECT * FROM UNNEST([\n  ${filas.join(',\n  ')}\n])),
esperado AS (SELECT * FROM UNNEST([\n  ${esperado.join(',\n  ')}\n])),
ultima AS (${corridas.ultimaCorridaSql('corridas')})
SELECT e.nombre, e.fuente, e._ingest_date,
  STRUCT(e.ultimo_run_id, e.estado, e.n_corridas, e.n_parciales) AS esperado,
  STRUCT(u.run_id AS ultimo_run_id, u.estado, u.n_corridas, u.n_parciales) AS obtenido
FROM esperado e
LEFT JOIN ultima u ON u.fuente = e.fuente AND u._ingest_date = e._ingest_date
WHERE u.run_id IS NULL OR u.run_id != e.ultimo_run_id OR u.estado != e.estado OR u.n_corridas != e.n_corridas OR u.n_parciales != e.n_parciales
ORDER BY e.nombre`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(`${consulta()}\n`);
