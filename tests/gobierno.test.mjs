import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const gobierno = require(join(project, 'includes/gobierno.js'));
const reglas = require(join(project, 'includes/reglas.js'));
const dataform = join(project, 'node_modules/.bin/dataform');

const TAG = 'projects/p/locations/us-central1/taxonomies/1/policyTags/2';

function compile(...args) {
  const out = execFileSync(dataform, ['compile', '--json', ...args], { cwd: project, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const graph = JSON.parse(out);
  assert.deepEqual(graph.graphErrors?.compilationErrors ?? [], []);
  return graph;
}

const id = (t) => `${t.schema}.${t.name}`;
const byId = (g) => Object.fromEntries((g.tables ?? []).map((t) => [id(t.target), t]));
const graph = compile(`--vars=policy_tag_rut=${TAG}`);
const ci = compile('--schema-suffix=ci', `--vars=raw_dataset=raw_ci,policy_tag_rut=${TAG}`);
const ciRun = compile('--schema-suffix=ci', `--vars=raw_dataset=raw_ci,sal_dataset=pii_ci,policy_tag_rut=${TAG}`);
const tables = byId(graph);
const tablesCi = byId(ci);
const columns = (t) => t.actionDescriptor?.columns ?? [];
const tagsOf = (t) => Object.fromEntries(columns(t).filter((c) => c.bigqueryPolicyTags?.length).map((c) => [c.path.join('.'), c.bigqueryPolicyTags]));

for (const [nombre, g, silver, gold] of [
  ['default', tables, 'silver', 'gold'],
  ['ci suffix', tablesCi, 'silver_ci', 'gold_ci'],
]) {
  test(`REQ-014 E2: only rut_persona_natural of proveedores and dim_proveedor carries the tag (${nombre})`, () => {
    const conTag = Object.entries(g)
      .map(([k, t]) => [k, tagsOf(t)])
      .filter(([, tags]) => Object.keys(tags).length);
    assert.deepEqual(Object.fromEntries(conTag), {
      [`${silver}.proveedores`]: { rut_persona_natural: [TAG] },
      [`${gold}.dim_proveedor`]: { rut_persona_natural: [TAG] },
    });
    for (const k of [`${silver}.proveedores`, `${gold}.dim_proveedor`]) {
      const declarados = columns(g[k]).map((c) => c.path.join('.'));
      for (const c of ['proveedor_key', 'rut_empresa', 'rut_persona_natural']) assert.ok(declarados.includes(c), `${k}: ${c}`);
    }
  });
}

test('REQ-014 E3: silver.proveedores splits the RUT with the S-04 rule', () => {
  const t = tables['silver.proveedores'];
  for (const q of [t.query, t.incrementalQuery]) {
    assert.ok(q.includes(`IF(${reglas.esPersonaNaturalSql('rut')}, NULL, rut) AS rut_empresa`), q);
    assert.ok(q.includes(`IF(${reglas.esPersonaNaturalSql('rut')}, rut, NULL) AS rut_persona_natural`), q);
  }
});

function compileFails(...args) {
  const r = spawnSync(dataform, ['compile', '--json', ...args], { cwd: project, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let errors = [];
  try {
    errors = JSON.parse(r.stdout).graphErrors?.compilationErrors ?? [];
  } catch {
    // Not JSON: the exit code and the text decide.
  }
  assert.ok(r.status !== 0 || errors.length > 0, 'the compilation must fail');
  assert.match(r.stdout + r.stderr, /policy_tag_rut/);
}

test('REQ-014 E5: the compilation without policy_tag_rut fails naming the variable', () => {
  compileFails();
});

test('REQ-014 E5: a policy_tag_rut that is not a full policy tag name fails naming the variable', () => {
  compileFails('--vars=policy_tag_rut=no-es-una-tag');
});

test('REQ-014 E5: policyTagRut accepts only the full name of a policy tag', () => {
  assert.equal(gobierno.policyTagRut({ policy_tag_rut: TAG }), TAG);
  for (const vars of [{}, undefined, { policy_tag_rut: '' }, { policy_tag_rut: 'projects/p/locations/l/taxonomies/1' }]) {
    assert.throws(() => gobierno.policyTagRut(vars), /policy_tag_rut/);
  }
});

test('REQ-014 E6: proveedorKeySql hashes the salt of pii.sal with the RUT', () => {
  assert.equal(gobierno.proveedorKeySql('r', '`p.pii.sal`'), 'TO_HEX(SHA256(CONCAT((SELECT sal FROM `p.pii.sal`), r)))');
});

test('REQ-014 E6: silver.proveedores is keyed by proveedor_key, salted with pii.sal', () => {
  const t = tables['silver.proveedores'];
  const sal = `\`${t.target.database}.pii.sal\``;
  assert.deepEqual(t.uniqueKey, ['proveedor_key']);
  for (const q of [t.query, t.incrementalQuery]) {
    assert.ok(q.includes(`TO_HEX(SHA256(CONCAT((SELECT sal FROM ${sal})`), q);
    assert.ok(q.includes('PARTITION BY proveedor_key'), q);
  }
  assert.ok(t.incrementalQuery.includes('WHERE proveedor_key IN (SELECT proveedor_key FROM nuevas)'));
  const deps = t.dependencyTargets.map(id);
  assert.ok(deps.includes('pii.sal'), deps.join(', '));
  assert.ok(deps.some((d) => d.endsWith('.generar_sal')), deps.join(', '));
});

test('REQ-014 E6: gold.dim_proveedor and the facts use proveedor_key, never the RUT, and their checks join on it', () => {
  const dim = tables['gold.dim_proveedor'];
  assert.ok(dim.dependencyTargets.map(id).includes('silver.proveedores'));
  for (const m of ['dim_proveedor', 'fct_ordenes_compra', 'fct_licitaciones']) {
    assert.doesNotMatch(tables[`gold.${m}`].query, /rut_proveedor/, m);
  }
  const assertions = Object.fromEntries((graph.assertions ?? []).map((a) => [id(a.target), a]));
  for (const m of ['fct_ordenes_compra', 'fct_licitaciones']) {
    const a = assertions[`quarantine.assert_${m}`];
    assert.ok(a.query.includes('proveedor_key NOT IN (SELECT proveedor_key FROM'), m);
  }
  assert.ok(assertions['quarantine.gold_dim_proveedor_assertions_uniqueKey_0'].query.includes('proveedor_key'));
});

test('REQ-014: no silver or gold table keeps the unsalted supplier RUT outside the tagged column', () => {
  for (const [k, t] of Object.entries(tables).filter(([k]) => k.startsWith('silver.') || k.startsWith('gold.'))) {
    const declarados = columns(t).map((c) => c.path.join('.'));
    for (const c of ['rut_proveedor', 'rut_proveedor_adjudicado']) assert.ok(!declarados.includes(c), `${k}: ${c}`);
  }
  for (const m of ['ordenes_compra', 'licitacion_items']) {
    const t = tables[`silver.${m}`];
    assert.ok(t.query.includes('TO_HEX(SHA256(CONCAT((SELECT sal FROM'), m);
    assert.ok(t.dependencyTargets.map(id).includes('pii.sal'), m);
  }
});

test('DEC-008: pii.sal is declared in pii, also with the ci suffix, and generar_sal fills it once', () => {
  for (const g of [graph, ci]) {
    assert.ok((g.declarations ?? []).some((d) => id(d.target) === 'pii.sal'));
    const op = (g.operations ?? []).find((o) => o.target.name === 'generar_sal');
    assert.ok(op, 'generar_sal');
    assert.ok(!op.hasOutput, 'generar_sal has no output');
    assert.ok(op.tags.includes('silver'));
    const q = op.queries.join('\n');
    assert.ok(q.includes('INSERT INTO `') && q.includes('.pii.sal`'), q);
    assert.ok(q.includes('WHERE NOT EXISTS (SELECT 1 FROM'), q);
  }
});

const SQL_FIELDS = ['query', 'incrementalQuery', 'preOps', 'postOps', 'incrementalPreOps', 'incrementalPostOps'];
const sqlText = (v) => (Array.isArray(v) ? v.join('\n') : v);

function sqlDe(g) {
  const out = [];
  for (const t of g.tables ?? []) {
    for (const f of SQL_FIELDS) if (t[f]) out.push([id(t.target), sqlText(t[f])]);
  }
  for (const o of g.operations ?? []) out.push([id(o.target), (o.queries ?? []).join('\n')]);
  for (const a of g.assertions ?? []) out.push([id(a.target), a.query]);
  return out;
}

const declared = (g) => (g.declarations ?? []).map((d) => id(d.target));

test('REQ-014 E8: with sal_dataset=pii_ci no action reads or writes pii.sal', () => {
  for (const [nombre, sql] of sqlDe(ciRun)) assert.ok(!sql.includes('.pii.sal`'), nombre);
  for (const a of [...(ciRun.tables ?? []), ...(ciRun.operations ?? []), ...(ciRun.assertions ?? [])]) {
    assert.ok(!(a.dependencyTargets ?? []).map(id).includes('pii.sal'), id(a.target));
  }
  assert.ok(declared(ciRun).includes('pii_ci.sal'));
  assert.ok(!declared(ciRun).includes('pii.sal'));
});

test('REQ-014 E8: generar_sal and proveedor_key use pii_ci.sal', () => {
  const op = (ciRun.operations ?? []).find((o) => o.target.name === 'generar_sal');
  const salOp = `\`${op.target.database}.pii_ci.sal\``;
  const q = op.queries.join('\n');
  assert.ok(q.includes(`INSERT INTO ${salOp}`), q);
  assert.ok(q.includes(`SELECT 1 FROM ${salOp}`), q);
  const t = byId(ciRun);
  for (const m of ['proveedores', 'ordenes_compra', 'licitacion_items']) {
    const tabla = t[`silver_ci.${m}`];
    const sal = `\`${tabla.target.database}.pii_ci.sal\``;
    for (const sql of [tabla.query, tabla.incrementalQuery].filter(Boolean)) {
      assert.ok(sql.includes(`TO_HEX(SHA256(CONCAT((SELECT sal FROM ${sal})`), m);
    }
    assert.ok(tabla.dependencyTargets.map(id).includes('pii_ci.sal'), m);
  }
});

test('REQ-014: sal_dataset defaults to pii', () => {
  for (const [nombre, sql] of sqlDe(graph)) assert.ok(!sql.includes('.pii_ci.sal`'), nombre);
  assert.ok(declared(graph).includes('pii.sal'));
});
