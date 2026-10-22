import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// REQ-016 E4/E5: scripts/backup-state.sh against a fake gcloud, in a temporary copy (never the real local state).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fakeGcloud = '#!/usr/bin/env bash\necho "$@" >> "$FAKE_GCLOUD_LOG"\nexit "${FAKE_GCLOUD_EXIT:-0}"\n';

function withCopy({ state = true, gcloud = true } = {}, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-state-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(root, 'scripts/backup-state.sh'), join(dir, 'scripts/backup-state.sh'));
    if (state) {
      mkdirSync(join(dir, 'infra/bootstrap'), { recursive: true });
      writeFileSync(join(dir, 'infra/bootstrap/terraform.tfstate'), '{"version":4}');
    }
    if (gcloud) {
      writeFileSync(join(dir, 'bin/gcloud'), fakeGcloud);
      chmodSync(join(dir, 'bin/gcloud'), 0o755);
    }
    const log = join(dir, 'gcloud.log');
    const run = (args, env = {}) => spawnSync('bash', [join(dir, 'scripts/backup-state.sh'), ...args], {
      cwd: dir, encoding: 'utf8',
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, FAKE_GCLOUD_LOG: log, STATE_BACKUP_BUCKET: 'demo-backup-tfstate-backup', ...env },
    });
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
    fn({ run, calls });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('E4: one copy of the bootstrap state to bootstrap/<timestamp>.tfstate', () => withCopy({}, ({ run, calls }) => {
  const r = run(['bootstrap']);
  assert.equal(r.status, 0, r.stderr);
  const lines = calls();
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0],
    /^storage cp \S+\/infra\/bootstrap\/terraform\.tfstate gs:\/\/demo-backup-tfstate-backup\/bootstrap\/\d{8}T\d{6}Z\.tfstate$/);
}));

test('E5: without the local state it fails and names the path', () => withCopy({ state: false }, ({ run, calls }) => {
  const r = run(['bootstrap']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /infra\/bootstrap\/terraform\.tfstate/);
  assert.deepEqual(calls(), []);
}));

test('without an argument or with another root it prints usage and exits 2', () => withCopy({}, ({ run, calls }) => {
  for (const args of [[], ['main']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage/);
  }
  assert.deepEqual(calls(), []);
}));

test('without STATE_BACKUP_BUCKET it exits 1 and names the variable', () => withCopy({}, ({ run, calls }) => {
  const r = run(['bootstrap'], { STATE_BACKUP_BUCKET: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /STATE_BACKUP_BUCKET/);
  assert.deepEqual(calls(), []);
}));

test('a failing gcloud makes it fail', () => withCopy({}, ({ run }) => {
  const r = run(['bootstrap'], { FAKE_GCLOUD_EXIT: '1' });
  assert.notEqual(r.status, 0);
}));

test('without gcloud in PATH it exits 2', (t) => {
  if (existsSync('/usr/bin/gcloud') || existsSync('/bin/gcloud')) {
    t.skip('gcloud is installed in /usr/bin or /bin');
    return;
  }
  withCopy({ gcloud: false }, ({ run }) => {
    const r = run(['bootstrap']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /gcloud is required/);
  });
});
