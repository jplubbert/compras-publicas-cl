import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const corridas = createRequire(import.meta.url)(join(project, 'includes/corridas.js'));
const TAG = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';
const graph = JSON.parse(
  execFileSync(join(project, 'node_modules/.bin/dataform'), ['compile', '--json', `--vars=policy_tag_rut=${TAG}`], {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const tabla = (schema, name) => graph.tables.find((t) => t.target.schema === schema && t.target.name === name);

test('DEC-012: the day takes the last run by run_id, so it is OK only if the last run was OK', () => {
  const sql = corridas.ultimaCorridaSql('`p.raw.corridas`');
  assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY fuente, _ingest_date ORDER BY run_id DESC\) = 1/);
  assert.match(sql, /COUNTIF\(estado = 'PARCIAL'\) OVER \(PARTITION BY fuente, _ingest_date\) AS n_parciales/);
  assert.deepEqual(corridas.ESTADOS, ['OK', 'PARCIAL', 'ERROR']);
  // The shared cases encode the rule; scripts/it/corridas-sql.sh runs them against BigQuery.
  const casos = JSON.parse(readFileSync(join(project, 'tests/casos-corridas.json'), 'utf8'));
  const porDia = {};
  for (const c of casos.corridas) (porDia[`${c.fuente}|${c._ingest_date}`] ??= []).push(c);
  for (const e of casos.esperado) {
    const dia = porDia[`${e.fuente}|${e._ingest_date}`].sort((a, b) => (a.run_id < b.run_id ? 1 : -1));
    assert.equal(dia[0].run_id, e.ultimo_run_id, e.nombre);
    assert.equal(dia[0].estado, e.estado, e.nombre);
    assert.equal(dia.length, e.n_corridas, e.nombre);
    assert.equal(dia.filter((c) => c.estado === 'PARCIAL').length, e.n_parciales, e.nombre);
  }
  assert.ok(casos.esperado.some((e) => e.estado === 'OK' && e.n_parciales > 0), 'a partial then complete day is OK');
  assert.ok(casos.esperado.some((e) => e.estado === 'PARCIAL' && e.n_corridas > 1), 'a complete then partial day is PARCIAL');
});

test('DEC-012: gold.dim_corrida reads raw.corridas with the rule and counts silver and quarantine rows per day', () => {
  const t = tabla('gold', 'dim_corrida');
  assert.ok(t);
  assert.match(t.query, /ORDER BY run_id DESC\) = 1/);
  assert.match(t.query, /raw\.corridas`/);
  for (const d of ['silver.licitaciones', 'silver.ordenes_compra', 'quarantine.licitaciones', 'quarantine.ordenes_compra']) {
    assert.ok(t.dependencyTargets.some((x) => `${x.schema}.${x.name}` === d), d);
  }
  assert.ok(t.dependencyTargets.some((x) => x.name === 'corridas'));
});

test('DEC-012: the monthly mart counts the tenders whose current version came on a PARCIAL day', () => {
  const t = tabla('gold', 'mart_organismo_mes');
  assert.match(t.query, /d\.estado = 'PARCIAL'/);
  assert.match(t.query, /AS n_licitaciones_dias_parciales/);
  assert.ok(t.dependencyTargets.some((x) => x.name === 'dim_corrida'));
  assert.ok(t.actionDescriptor.columns.some((c) => c.path[0] === 'n_licitaciones_dias_parciales'));
});
