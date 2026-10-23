import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const gold = createRequire(import.meta.url)(join(project, 'includes/gold.js'));

const MODELS = ['fct_licitaciones', 'fct_ordenes_compra', 'dim_comprador', 'dim_proveedor', 'mart_organismo_mes'];
const FACTS = ['fct_licitaciones', 'fct_ordenes_compra'];

const TAG = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';

// One --vars flag: the test's variables plus policy_tag_rut, which every compilation needs (REQ-014 E5).
function compile(...args) {
  const vars = args.filter((a) => a.startsWith('--vars=')).map((a) => a.slice('--vars='.length));
  const rest = args.filter((a) => !a.startsWith('--vars='));
  const flags = [...rest, `--vars=${[...vars, `policy_tag_rut=${TAG}`].join(',')}`];
  const out = execFileSync(join(project, 'node_modules/.bin/dataform'), ['compile', '--json', ...flags], {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const graph = JSON.parse(out);
  assert.deepEqual(graph.graphErrors?.compilationErrors ?? [], []);
  return graph;
}

const id = (t) => `${t.schema}.${t.name}`;
const graph = compile();
const ci = compile('--schema-suffix=ci', '--vars=raw_dataset=raw_ci');
const byId = (g) => Object.fromEntries((g.tables ?? []).map((t) => [id(t.target), t]));
const tables = byId(graph);
const tablesCi = byId(ci);
const assertions = Object.fromEntries((graph.assertions ?? []).map((a) => [id(a.target), a]));
const declaredColumns = (t) => t.actionDescriptor.columns.map((c) => c.path.join('.'));

test('the 5 gold models are tables tagged gold, in gold by default and in gold_ci with the ci suffix', () => {
  for (const m of MODELS) {
    const t = tables[`gold.${m}`];
    assert.ok(t, m);
    assert.ok(t.type === 'table' || t.enumType === 'TABLE', `${m}: ${t.type}`);
    assert.ok(t.tags.includes('gold'), m);
    assert.ok(tablesCi[`gold_ci.${m}`], `gold_ci.${m}`);
  }
});

for (const m of FACTS) {
  test(`REQ-012 E1: gold.${m} is partitioned by month of fecha_documento, clustered and requires a partition filter`, () => {
    const t = tables[`gold.${m}`];
    assert.equal(t.bigquery.partitionBy, 'DATE_TRUNC(fecha_documento, MONTH)');
    assert.equal(t.bigquery.partitionBy, gold.PARTICION);
    assert.deepEqual(t.bigquery.clusterBy, ['codigo_organismo', 'proveedor_key']);
    assert.deepEqual(t.bigquery.clusterBy, gold.CLUSTER);
    assert.equal(t.bigquery.requirePartitionFilter, true);
    for (const c of ['fecha_documento', 'codigo_organismo', 'proveedor_key']) assert.ok(declaredColumns(t).includes(c), c);
  });

  test(`REQ-012: gold.${m} converts with the BDE UF and dollar and keeps rows without a rate`, () => {
    const q = tables[`gold.${m}`].query;
    for (const s of ['LEFT JOIN tasas', 'IGNORE NULLS', "serie = 'bcentral_dolar'", "serie = 'bcentral_uf'"]) {
      assert.ok(q.includes(s), `${m}: ${s}`);
    }
  });
}

test('REQ-012 E5: every gold SQLX file declares dependOnDependencyAssertions: true', () => {
  const dir = join(project, 'definitions/outputs');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlx'));
  assert.deepEqual(files.map((f) => f.replace('.sqlx', '')).sort(), [...MODELS].sort());
  for (const f of files) assert.match(readFileSync(join(dir, f), 'utf8'), /dependOnDependencyAssertions: true/, f);
});

test('REQ-012 E5: each gold model depends on every assertion of the tables it reads', () => {
  const allAssertions = graph.assertions ?? [];
  for (const m of MODELS) {
    const t = tables[`gold.${m}`];
    const deps = new Set(t.dependencyTargets.map(id));
    for (const d of t.dependencyTargets.filter((x) => tables[id(x)])) {
      for (const a of allAssertions) {
        const of = (a.parentAction && id(a.parentAction) === id(d)) || a.dependencyTargets.some((x) => id(x) === id(d));
        if (of) assert.ok(deps.has(id(a.target)), `gold.${m} does not depend on ${id(a.target)} of ${id(d)}`);
      }
    }
  }
  const lic = new Set(tables['gold.fct_licitaciones'].dependencyTargets.map(id));
  assert.ok(lic.has('quarantine.silver_licitaciones_assertions_uniqueKey_0'));
  assert.ok(lic.has('quarantine.assert_reconciliacion_uf_dolar'));
  assert.ok(tables['gold.mart_organismo_mes'].dependencyTargets.map(id).includes('quarantine.assert_fct_licitaciones'));
});

test('the facts read silver and not the quarantine, also with the ci suffix', () => {
  const deps = (g, m) => g[m].dependencyTargets.map(id);
  assert.ok(deps(tables, 'gold.fct_licitaciones').includes('silver.licitaciones'));
  assert.ok(!deps(tables, 'gold.fct_licitaciones').includes('quarantine.licitaciones'));
  assert.ok(deps(tables, 'gold.fct_ordenes_compra').includes('silver.ordenes_compra'));
  assert.ok(!deps(tables, 'gold.fct_ordenes_compra').includes('quarantine.ordenes_compra'));
  assert.ok(deps(tablesCi, 'gold_ci.fct_licitaciones').includes('silver_ci.licitaciones'));
  assert.ok(deps(tablesCi, 'gold_ci.fct_ordenes_compra').includes('silver_ci.ordenes_compra'));
});

test('everything that reads a fact filters its partition', () => {
  const filtro = "fecha_documento >= DATE '2000-01-01'";
  assert.equal(gold.filtroParticionSql('2000-01-01'), filtro);
  assert.ok(tables['gold.mart_organismo_mes'].query.includes(filtro));
  for (const m of FACTS) {
    const a = assertions[`quarantine.assert_${m}`];
    assert.ok(a, m);
    assert.ok(a.query.includes(filtro), m);
  }
});

test('gold.js builds the daily rates, the three amounts and fx_imputado', () => {
  const tasas = gold.tasasSql('`x`', '2000-01-01');
  assert.ok(tasas.includes("GENERATE_DATE_ARRAY(DATE '2000-01-01'"), tasas);
  assert.ok(tasas.includes('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW'), tasas);
  const montos = gold.montosSql({ monto: 'm', moneda: 'c', uf: 'u', dolar: 'd', prefijo: 'p' });
  for (const s of ["WHEN 'CLP' THEN m", "WHEN 'CLF' THEN m * u", "WHEN 'USD' THEN m * d", 'SAFE_DIVIDE', 'AS p_clp', 'AS p_uf', 'AS p_usd']) {
    assert.ok(montos.includes(s), s);
  }
  assert.equal(gold.fxImputadoSql('a', 'b'), 'IFNULL(a < b, FALSE)');
});

test('dim_proveedor takes the key and the split RUT from silver.proveedores', () => {
  const t = tables['gold.dim_proveedor'];
  for (const c of ['proveedor_key', 'rut_empresa', 'rut_persona_natural']) assert.ok(declaredColumns(t).includes(c), c);
  assert.ok(t.dependencyTargets.map(id).includes('silver.proveedores'));
});

for (const m of MODELS) {
  test(`REQ-011: every declared column of gold.${m} is in its query`, () => {
    const t = tables[`gold.${m}`];
    for (const c of declaredColumns(t)) assert.match(t.query, new RegExp(`\\b${c}\\b`), c);
  });
}
