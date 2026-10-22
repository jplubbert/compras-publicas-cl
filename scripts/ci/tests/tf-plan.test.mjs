import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Only the checks that run before scripts/env.sh and terraform: no network, no credentials.
const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'it', 'tf-plan.sh');

function run(args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TF_VAR_')));
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...clean, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('without an argument it prints usage and exits 2', () => {
  const r = run([]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /usage: scripts\/it\/tf-plan\.sh <bootstrap\|main>/);
});

test('an unknown root prints usage and exits 2', () => {
  const r = run(['foo']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /usage/);
});

test('a missing TF_VAR_project_id is named and exits 1', () => {
  const r = run(['main'], { TF_VAR_region: 'us-central1', TF_VAR_github_repository: 'owner/repo' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /TF_VAR_project_id/);
});
