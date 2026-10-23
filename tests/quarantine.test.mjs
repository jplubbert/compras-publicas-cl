import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const reglas = createRequire(import.meta.url)(join(project, 'includes/reglas.js'));

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

const graph = compile();
const tables = Object.fromEntries((graph.tables ?? []).map((t) => [`${t.target.schema}.${t.target.name}`, t]));

for (const entidad of ['licitaciones', 'ordenes_compra']) {
  test(`REQ-010 E1: quarantine.${entidad} is incremental, tagged silver and keeps motivos, run_id and quarantined_at`, () => {
    const t = tables[`quarantine.${entidad}`];
    assert.ok(t, Object.keys(tables).join(', '));
    assert.ok(t.type === 'incremental' || t.enumType === 'INCREMENTAL', t.type);
    assert.ok(t.tags.includes('silver'));
    const columnas = t.actionDescriptor.columns.map((c) => c.path.join('.'));
    for (const c of ['motivos', 'run_id', 'quarantined_at']) assert.ok(columnas.includes(c), c);
  });

  test(`REQ-010 E1: quarantine.${entidad} keeps the rows that fail the shared predicate with all their reasons`, () => {
    const t = tables[`quarantine.${entidad}`];
    for (const q of [t.query, t.incrementalQuery]) {
      assert.ok(q.includes(`${reglas.motivosSql(entidad)} AS motivos`), q);
      assert.ok(q.includes(`NOT (${reglas.pasaSql(entidad)})`), q);
    }
  });
}

const FILTROS = {
  licitaciones: ['licitaciones'],
  licitacion_items: ['licitaciones'],
  ordenes_compra: ['ordenes_compra'],
  compradores: ['licitaciones', 'ordenes_compra'],
  proveedores: ['licitaciones', 'ordenes_compra'],
};

for (const [modelo, entidades] of Object.entries(FILTROS)) {
  test(`REQ-010 E1: silver.${modelo} filters with the same predicate as the quarantine`, () => {
    const t = tables[`silver.${modelo}`];
    for (const q of [t.query, t.incrementalQuery]) {
      for (const e of entidades) assert.ok(q.includes(reglas.pasaSql(e)), `${modelo}: ${e}`);
    }
  });
}
