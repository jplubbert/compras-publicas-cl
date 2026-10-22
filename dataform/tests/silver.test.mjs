import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const silver = createRequire(import.meta.url)(join(project, 'includes/silver.js'));

const MODELS = {
  licitaciones: ['codigo_licitacion'],
  ordenes_compra: ['codigo_oc'],
  licitacion_items: ['codigo_licitacion', 'correlativo'],
  compradores: ['codigo_organismo'],
  proveedores: ['rut_proveedor'],
  indicadores_diarios: ['serie', 'fecha'],
};
const RAW = [
  'mercadopublico_licitaciones',
  'mercadopublico_ordenes_compra',
  'bcentral_uf',
  'bcentral_dolar',
  'bcentral_ipc',
  'mindicador_uf',
  'mindicador_dolar',
];

function compile(...args) {
  const out = execFileSync(join(project, 'node_modules/.bin/dataform'), ['compile', '--json', ...args], {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const graph = JSON.parse(out);
  assert.deepEqual(graph.graphErrors?.compilationErrors ?? [], []);
  return graph;
}

const graph = compile();
const tables = Object.fromEntries((graph.tables ?? []).map((t) => [`${t.target.schema}.${t.target.name}`, t]));
const declared = (g) => (g.declarations ?? []).map((d) => `${d.target.schema}.${d.target.name}`).sort();

for (const [name, key] of Object.entries(MODELS)) {
  test(`REQ-008 E1: silver.${name} is incremental by ${key.join(' + ')} and merges with its own rows before QUALIFY`, () => {
    const t = tables[`silver.${name}`];
    assert.ok(t, Object.keys(tables).join(', '));
    assert.ok(t.type === 'incremental' || t.enumType === 'INCREMENTAL', t.type);
    assert.deepEqual(t.uniqueKey, key);
    assert.ok(t.tags.includes('silver'));
    const target = `\`${t.target.database}.${t.target.schema}.${t.target.name}\``;
    const inc = t.incrementalQuery;
    const qualify = inc.indexOf('QUALIFY ROW_NUMBER() OVER (PARTITION BY');
    assert.ok(qualify > 0, inc);
    assert.ok(inc.includes(target) && inc.indexOf(target) < qualify, 'reads its own target before QUALIFY');
    assert.ok(inc.includes('UNION ALL') && inc.lastIndexOf('UNION ALL') < qualify, 'UNION ALL before QUALIFY');
    assert.ok(inc.includes(`PARTITION BY ${key.join(', ')} ORDER BY fecha_cambio DESC, ingested_at DESC) = 1`));
    assert.ok(!t.query.includes(target), 'the full query does not read its own target');
  });

  test(`REQ-011: every column of the final SELECT of silver.${name} is a declared column`, () => {
    const t = tables[`silver.${name}`];
    const select = t.query.slice(t.query.lastIndexOf('SELECT') + 'SELECT'.length, t.query.indexOf('FROM candidatas'));
    const selected = select.split(',').map((c) => c.trim());
    const declaredColumns = t.actionDescriptor.columns.map((c) => c.path.join('.'));
    assert.deepEqual(selected, declaredColumns);
    for (const c of ['run_id', '_ingest_date', 'ingested_at', 'fecha_cambio']) assert.ok(selected.includes(c), c);
  });
}

test('the 7 raw tables are declared in raw by default', () => {
  assert.deepEqual(declared(graph), RAW.map((n) => `raw.${n}`).sort());
});

test('the raw_dataset variable moves the declarations to raw_ci', () => {
  assert.deepEqual(declared(compile('--vars=raw_dataset=raw_ci')), RAW.map((n) => `raw_ci.${n}`).sort());
});

test('the ci schema suffix moves the models to silver_ci and keeps the declarations in raw', () => {
  const g = compile('--schema-suffix=ci');
  const schemas = new Set(g.tables.map((t) => t.target.schema));
  assert.deepEqual([...schemas], ['silver_ci']);
  assert.deepEqual(declared(g), RAW.map((n) => `raw.${n}`).sort());
  const lic = g.tables.find((t) => t.target.name === 'licitaciones');
  assert.ok(lic.incrementalQuery.includes(`.silver_ci.licitaciones\``));
});

test('REQ-008: the tender state catalog translates the 6 codes of T-02', () => {
  assert.deepEqual(silver.ESTADOS_LICITACION, {
    5: 'Publicada', 6: 'Cerrada', 7: 'Desierta', 8: 'Adjudicada', 18: 'Revocada', 19: 'Suspendida',
  });
  const sql = silver.estadoSql('x', silver.ESTADOS_LICITACION);
  assert.ok(sql.includes("WHEN 8 THEN 'Adjudicada'"), sql);
  for (const [codigo, texto] of Object.entries(silver.ESTADOS_LICITACION)) assert.ok(sql.includes(`WHEN ${codigo} THEN '${texto}'`));
  assert.ok(sql.startsWith('CASE x ') && sql.endsWith(' ELSE NULL END'), sql);
});

test('REQ-008: the purchase order state catalog translates the 8 codes of T-02', () => {
  assert.deepEqual(silver.ESTADOS_OC, {
    4: 'Enviada a proveedor',
    5: 'En proceso',
    6: 'Aceptada',
    9: 'Cancelada',
    12: 'Recepción conforme',
    13: 'Pendiente de recepcionar',
    14: 'Recepcionada parcialmente',
    15: 'Recepción conforme incompleta',
  });
  const sql = silver.estadoSql('x', silver.ESTADOS_OC);
  for (const [codigo, texto] of Object.entries(silver.ESTADOS_OC)) assert.ok(sql.includes(`WHEN ${codigo} THEN '${texto}'`));
});

test('REQ-008: tender and purchase order models translate the state with their catalog', () => {
  assert.ok(tables['silver.licitaciones'].query.includes("WHEN 8 THEN 'Adjudicada'"));
  assert.ok(tables['silver.ordenes_compra'].query.includes("WHEN 6 THEN 'Aceptada'"));
});

test('REQ-008: indicadores_diarios turns ND into a NULL valor with es_nd', () => {
  const q = tables['silver.indicadores_diarios'].query;
  assert.ok(q.includes("JSON_VALUE(obs, '$.statusCode') = 'ND'"));
  assert.match(q, /IF\(IFNULL\(.*'ND'.*\), NULL, SAFE_CAST\(JSON_VALUE\(obs, '\$\.value'\) AS NUMERIC\)\) AS valor/);
  for (const n of RAW.filter((r) => !r.startsWith('mercadopublico'))) assert.ok(q.includes(`'${n}' AS serie`), n);
});

test('the incremental window reads raw partitions from 3 days before the newest one in the target', () => {
  assert.equal(silver.LOOKBACK_DIAS, 3);
  assert.equal(
    silver.ventanaIncremental('`p.silver.t`'),
    "_ingest_date >= IFNULL((SELECT DATE_SUB(MAX(_ingest_date), INTERVAL 3 DAY) FROM `p.silver.t`), DATE '1970-01-01')",
  );
});
