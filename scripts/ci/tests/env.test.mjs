import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('env.sh resolves node, terraform, uv and python inside .tools/ with a bare PATH', () => {
  const r = spawnSync(join(root, 'scripts/env.sh'), ['bash', '-c', 'command -v node terraform uv python'], {
    cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
  });
  assert.equal(r.status, 0, r.stderr);
  const paths = r.stdout.trim().split('\n');
  assert.equal(paths.length, 4, r.stdout);
  for (const p of paths) assert.match(p, /\/\.tools\//, p);
});

test('env.sh without a .tools/ asks for scripts/setup.sh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-sh-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(join(root, 'scripts/env.sh'), join(dir, 'scripts/env.sh'));
    const r = spawnSync('bash', [join(dir, 'scripts/env.sh'), 'true'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /scripts\/setup\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
