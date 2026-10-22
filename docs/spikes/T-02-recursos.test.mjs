// Structure check of the T-02 spike report (its verify): the fixed sections, in order, with sources and no secrets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const text = readFileSync(new URL('./T-02-recursos.md', import.meta.url), 'utf8');
const SECTIONS = [
  '(a) Dataform: repositorio, release config e invocación',
  '(b) Taxonomía y policy tags de BigQuery',
  '(c) Cuota diaria de bytes de query de BigQuery',
  '(d) Presupuesto con notificaciones Pub/Sub',
  '(e) Cloud Run function de 2.ª generación con disparador Pub/Sub',
  '(f) Workload Identity Federation para GitHub Actions',
  'Mercado Público',
  'Banco Central (BDE, SieteRestWS)',
  'mindicador.cl',
  'Supuestos',
];

test('the report has exactly the ten sections, in order', () => {
  const found = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(found, SECTIONS);
});

test('every section except Supuestos cites sources', () => {
  const parts = text.split(/^## /m).slice(1);
  for (const p of parts.slice(0, -1)) assert.match(p, /\*\*Fuentes\*\*\n- https:\/\//, p.split('\n')[0]);
});

test('the Supuestos section rules on S-13, S-14 and S-08', () => {
  const sup = text.split(/^## Supuestos$/m)[1];
  for (const id of ['S-13', 'S-14', 'S-08']) assert.match(sup, new RegExp(`- ${id}: \\*\\*`), id);
});

test('no ticket, token, project number or billing account leaks into the report', () => {
  assert.doesNotMatch(text, /ticket=(?!<TICKET>)[A-Za-z0-9-]{8,}/);
  assert.doesNotMatch(text, /token=(?!<TOKEN>)[A-Za-z0-9-]{8,}/);
  assert.doesNotMatch(text, /\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/);
  assert.doesNotMatch(text, /\b\d{12}\b/);
});
