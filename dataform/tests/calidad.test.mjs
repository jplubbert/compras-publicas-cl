import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';

function compile(vars = '') {
  const out = execFileSync(join(project, 'node_modules/.bin/dataform'), ['compile', '--json', `--vars=policy_tag_rut=${TAG}${vars}`], {
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}
const graph = compile();
assert.deepEqual(graph.graphErrors?.compilationErrors ?? [], []);
const GATE = ['assert_cuarentena_proporcion', 'assert_silver_frescura'];

test('DEC-011: the two gate assertions exist, carry the silver tag and read silver and the quarantine', () => {
  const byName = Object.fromEntries((graph.assertions ?? []).map((a) => [a.target.name, a]));
  for (const name of GATE) {
    const a = byName[name];
    assert.ok(a, name);
    assert.ok(a.tags.includes('silver'), `${name} runs with silver`);
    const deps = (a.dependencyTargets ?? []).map((t) => `${t.schema}.${t.name}`);
    for (const e of ['licitaciones', 'ordenes_compra']) {
      assert.ok(deps.includes(`silver.${e}`) && deps.includes(`quarantine.${e}`), `${name}: ${deps}`);
    }
  }
  assert.ok(byName.assert_silver_frescura.dependencyTargets.some((t) => t.name === 'mercadopublico_licitaciones'));
});

test('DEC-011: every gold model depends on both gate assertions (fail-closed)', () => {
  const dir = join(project, 'definitions/outputs');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sqlx'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const name of GATE) assert.ok(src.includes(`"${name}"`), `${f} must depend on ${name}`);
  }
  for (const t of graph.tables.filter((t) => t.target.schema === 'gold')) {
    const deps = t.dependencyTargets.map((d) => d.name);
    for (const name of GATE) assert.ok(deps.includes(name), `${t.target.name}: ${deps}`);
  }
});

test('DEC-011: the quarantine threshold is a compilation variable between 0 and 1, applied in the SQL', () => {
  const a = (graph.assertions ?? []).find((x) => x.target.name === 'assert_cuarentena_proporcion');
  assert.match(a.query, /SAFE_DIVIDE\(en_cuarentena, en_silver \+ en_cuarentena\) > 0\.2\b/);
  assert.match(a.query, /QUALIFY _ingest_date = MAX\(_ingest_date\) OVER \(\)/);
  const settings = readFileSync(join(project, 'workflow_settings.yaml'), 'utf8');
  assert.match(settings, /umbral_cuarentena: "0\.2"/);
  const estricto = compile(',umbral_cuarentena=0').assertions.find((x) => x.target.name === 'assert_cuarentena_proporcion');
  assert.match(estricto.query, /> 0\s*$/m);
  assert.throws(() => compile(',umbral_cuarentena=2'), (e) => /umbral_cuarentena debe ser un número entre 0 y 1/.test(e.stderr));
});
