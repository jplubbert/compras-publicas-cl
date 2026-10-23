import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');

const TAG = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';

const out = execFileSync(join(project, 'node_modules/.bin/dataform'), ['compile', '--json', `--vars=policy_tag_rut=${TAG}`], {
  cwd: project,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const graph = JSON.parse(out);
const assertions = graph.assertions ?? [];
const modelos = (graph.tables ?? []).filter((t) => ['silver', 'gold'].includes(t.target.schema));

const ROW_CONDITIONS = {
  licitaciones: [
    'monto_estimado IS NULL OR monto_estimado >= 0',
    'fecha_cierre IS NULL OR fecha_cierre >= fecha_publicacion',
    'estado IS NOT NULL',
  ],
  ordenes_compra: ['total IS NULL OR total >= 0', 'total_neto IS NULL OR total_neto >= 0', 'estado IS NOT NULL'],
  licitacion_items: [
    'cantidad IS NULL OR cantidad >= 0',
    'cantidad_adjudicada IS NULL OR cantidad_adjudicada >= 0',
    'monto_unitario IS NULL OR monto_unitario >= 0',
  ],
  compradores: [],
  proveedores: ['(rut_empresa IS NULL) != (rut_persona_natural IS NULL)'],
  indicadores_diarios: ['es_nd OR valor IS NOT NULL', 'valor IS NULL OR valor > 0'],
  dim_proveedor: ['(rut_empresa IS NULL) != (rut_persona_natural IS NULL)'],
  mart_organismo_mes: [
    'n_licitaciones > 0',
    'tasa_desiertas BETWEEN 0 AND 1',
    'tasa_revocadas BETWEEN 0 AND 1',
    'monto_adjudicado_uf IS NULL OR monto_adjudicado_uf >= 0',
  ],
};

// Gold models are plain tables, without uniqueKey in the graph.
const CLAVES_GOLD = {
  dim_comprador: ['codigo_organismo'],
  dim_proveedor: ['proveedor_key'],
  mart_organismo_mes: ['codigo_organismo', 'mes'],
};

// The facts require a partition filter, so their assertions are their own (assert_<fact>) and not the built-in ones.
const NON_NULL_HECHOS = {
  fct_licitaciones: ['codigo_licitacion', 'fecha_documento'],
  fct_ordenes_compra: ['codigo_oc', 'fecha_documento', 'proveedor_key'],
};
const esHecho = (t) => t.bigquery?.requirePartitionFilter === true;

const hija = (t, sufijo) =>
  assertions.find(
    (a) =>
      a.parentAction?.schema === t.target.schema &&
      a.parentAction?.name === t.target.name &&
      a.target.name.endsWith(sufijo),
  );

test('the project compiles without errors and has the 6 silver models', () => {
  assert.deepEqual(graph.graphErrors?.compilationErrors ?? [], []);
  assert.equal(modelos.filter((t) => t.target.schema === 'silver').length, 6);
});

for (const t of modelos.filter((m) => esHecho(m))) {
  const id = `${t.target.schema}.${t.target.name}`;
  test(`REQ-009 E1: ${id} has its own assertion with the partition filter, tagged gold`, () => {
    assert.ok(!hija(t, '_assertions_uniqueKey_0') && !hija(t, '_assertions_rowConditions'), `${id}: built-in assertions`);
    const a = assertions.find((x) => x.target.name === `assert_${t.target.name}`);
    assert.ok(a, `${id}: assert_${t.target.name}`);
    assert.ok(a.tags.includes('gold'), a.target.name);
    assert.ok(a.dependencyTargets.some((d) => d.schema === t.target.schema && d.name === t.target.name), a.target.name);
    assert.ok(a.query.includes("fecha_documento >= DATE '2000-01-01'"), a.query);
    assert.ok(a.query.includes('HAVING COUNT(*) > 1'), a.query);
    for (const c of NON_NULL_HECHOS[t.target.name]) assert.ok(a.query.includes(`${c} IS NULL`), `${id}: ${c}`);
  });
}

for (const t of modelos.filter((m) => !esHecho(m))) {
  const id = `${t.target.schema}.${t.target.name}`;
  test(`REQ-009 E1: ${id} has uniqueKey and non-null key assertions tagged ${t.target.schema}`, () => {
    const unique = hija(t, '_assertions_uniqueKey_0');
    const filas = hija(t, '_assertions_rowConditions');
    assert.ok(unique, `${id}: uniqueKey assertion`);
    assert.ok(filas, `${id}: rowConditions assertion`);
    for (const a of [unique, filas]) assert.ok(a.tags.includes(t.target.schema), a.target.name);
    for (const c of t.uniqueKey ?? CLAVES_GOLD[t.target.name]) assert.ok(filas.query.includes(`${c} IS NOT NULL`), `${id}: ${c}`);
  });

  test(`REQ-009 E1: ${id} checks its domain row conditions`, () => {
    const filas = hija(t, '_assertions_rowConditions');
    for (const c of ROW_CONDITIONS[t.target.name] ?? []) assert.ok(filas.query.includes(`WHERE NOT (${c})`), `${id}: ${c}`);
  });
}

test('REQ-009: the continuity and reconciliation assertions read silver.indicadores_diarios and are tagged silver', () => {
  const propias = Object.fromEntries(assertions.map((a) => [`${a.target.schema}.${a.target.name}`, a]));
  for (const n of ['assert_uf_continuidad', 'assert_dolar_continuidad', 'assert_reconciliacion_uf_dolar']) {
    const a = propias[`quarantine.${n}`];
    assert.ok(a, n);
    assert.ok(a.tags.includes('silver'), n);
    assert.ok(
      a.dependencyTargets.some((d) => d.schema === 'silver' && d.name === 'indicadores_diarios'),
      n,
    );
  }
  const uf = propias['quarantine.assert_uf_continuidad'].query;
  assert.ok(uf.includes('INTERVAL 29 DAY') && uf.includes('GENERATE_DATE_ARRAY'), uf);
  assert.ok(propias['quarantine.assert_dolar_continuidad'].query.includes('> 4'));
  assert.ok(propias['quarantine.assert_reconciliacion_uf_dolar'].query.includes("NUMERIC '0.01'"));
});
