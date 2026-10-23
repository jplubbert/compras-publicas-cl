import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts/ci/check-descriptions.mjs');

function table(schema, name, { description = 'Modelo de prueba', columns = { codigo: 'Código', monto: 'Monto' } } = {}) {
  return {
    target: { database: 'p', schema, name },
    actionDescriptor: {
      description,
      columns: Object.entries(columns).map(([path, d]) => ({ path: [path], description: d })),
    },
  };
}

function check(graph) {
  const file = join(mkdtempSync(join(tmpdir(), 'check-descriptions-')), 'graph.json');
  writeFileSync(file, JSON.stringify({ projectConfig: {}, ...graph }));
  const r = spawnSync(process.execPath, [script, '--graph', file], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('a graph whose models and columns all have descriptions passes', () => {
  const r = check({ tables: [table('silver', 'licitaciones'), table('gold', 'fct'), table('quarantine', 'q')] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok \(3 modelos\)/);
});

test('REQ-011 E2: a column without description fails naming the model and the column', () => {
  const r = check({ tables: [table('silver', 'prueba', { columns: { codigo: 'Código', monto: '' } })] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /silver\.prueba/);
  assert.match(r.out, /monto/);
  assert.doesNotMatch(r.out, /columna codigo/);
});

test('a model without description fails naming it', () => {
  const r = check({ tables: [table('gold', 'dim', { description: '' })] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /gold\.dim: el modelo no tiene descripción/);
});

test('a model that declares no columns fails', () => {
  const r = check({ tables: [table('silver', 'vacia', { columns: {} })] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /silver\.vacia: no declara columnas/);
});

test('REQ-011 E3: a raw declaration without column descriptions is not checked', () => {
  const r = check({
    tables: [table('silver', 'licitaciones')],
    declarations: [{ target: { schema: 'raw', name: 'mercadopublico_licitaciones' }, actionDescriptor: {} }],
  });
  assert.equal(r.code, 0, r.out);
});

test('a model in silver_ci with schemaSuffix ci is checked', () => {
  const r = check({ projectConfig: { schemaSuffix: 'ci' }, tables: [table('silver_ci', 'prueba', { columns: { monto: '' } })] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /silver_ci\.prueba: la columna monto no tiene descripción/);
});

test('an operation with output in silver is checked', () => {
  const op = { ...table('silver', 'op', { columns: { monto: '' } }), hasOutput: true };
  const r = check({ operations: [op, { target: { schema: 'silver', name: 'sin_salida' } }] });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /silver\.op/);
  assert.doesNotMatch(r.out, /sin_salida/);
});

test('a model outside silver, gold and quarantine is not checked', () => {
  const r = check({ tables: [table('bench', 'x', { description: '', columns: {} })] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok \(0 modelos\)/);
});

test('a graph with compilation errors fails', () => {
  const r = check({ tables: [], graphErrors: { compilationErrors: [{ fileName: 'definitions/x.sqlx', message: 'boom' }] } });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /definitions\/x\.sqlx: boom/);
});

test('an unknown argument exits 2', () => {
  const r = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('a project without the Dataform binary exits 2 naming it', () => {
  const r = spawnSync(process.execPath, [script, '--project', mkdtempSync(join(tmpdir(), 'no-dataform-'))], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dataform/);
});

// The repository's graph needs policy_tag_rut (REQ-014 E5), so it is compiled here and checked with --graph.
test('REQ-011 E1: the repository passes check:descriptions', () => {
  const project = join(root, 'dataform');
  const TAG = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';
  const out = execFileSync(join(project, 'node_modules/.bin/dataform'), ['compile', '--json', `--vars=policy_tag_rut=${TAG}`], {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const file = join(mkdtempSync(join(tmpdir(), 'check-descriptions-')), 'graph.json');
  writeFileSync(file, out);
  const r = spawnSync(process.execPath, [script, '--graph', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /check:descriptions: ok \(\d+ modelos\)/);
});
