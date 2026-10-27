// REQ-015 E1–E4: the README guard, over a temporary repo root (no network).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-readme.mjs');

const README = `# compras-publicas-cl

Lakehouse medallion en GCP con Mercado Público y Banco Central.

## Arquitectura

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

## Qué demuestra

| requisito | pieza |
|---|---|
| ingesta | \`ingest/\` |

## Cómo reproducir

\`scripts/setup.sh\` y luego \`npm run check:repo\`.

## Costos y FinOps

Tope de USD 10.

## Benchmark

Tabla de [benchmarks/results/2026-10-26.md](benchmarks/results/2026-10-26.md).

## Calidad

Assertions y cuarentena.

## Gobierno

Descripciones y policy tags en Knowledge Catalog (ex Data Catalog).

## Nota sobre GitLab CI

Equivalente.

## Cómo se construyó

Especificación en \`spec/SPEC.md\`.

## Qué se rompió

Dos cosas.

## Fuentes

ChileCompra y Banco Central de Chile.
`;

const files = {
  'README.md': README,
  'package.json': JSON.stringify({ scripts: { 'check:repo': 'true' } }),
  'ingest/.keep': '',
  'scripts/setup.sh': '',
  'spec/SPEC.md': '',
  'benchmarks/results/2026-10-26.md': '| a |',
};

function run(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-readme-'));
  try {
    for (const [path, text] of Object.entries({ ...files, ...overrides })) {
      if (text === undefined) continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const r = spawnSync('node', [script, '--root', root], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('E1: the complete README passes', () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /check:readme: ok \(11 secciones\)/);
});

test('E2: a missing «Qué se rompió» section fails and is named', () => {
  const r = run({ 'README.md': README.replace('## Qué se rompió\n\nDos cosas.\n', '') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /falta la sección «qué se rompió»/);
});

test('E3: a link to a benchmark result that does not exist fails and names the path', () => {
  const r = run({ 'README.md': README.replace(/benchmarks\/results\/2026-10-26\.md/g, 'benchmarks/results/no-existe.md') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /benchmarks\/results\/no-existe\.md no existe/);
});

test('E4: naming Data Catalog as the current tool fails (R-07)', () => {
  const r = run({ 'README.md': README.replace('Knowledge Catalog (ex Data Catalog)', 'catalogado en Data Catalog') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Data Catalog como herramienta actual/);
});

test('sections out of order fail', () => {
  const r = run({ 'README.md': README.replace('## Calidad\n\nAssertions y cuarentena.\n\n', '').replace('## Fuentes', '## Calidad\n\nAssertions.\n\n## Fuentes') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /«calidad» está fuera de orden/);
});

test('an npm script that does not exist fails', () => {
  const r = run({ 'README.md': README.replace('npm run check:repo', 'npm run check:nada') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /«check:nada» no existe/);
});

test('exit 2 without a README', () => {
  const r = run({ 'README.md': undefined });
  assert.equal(r.code, 2);
});
