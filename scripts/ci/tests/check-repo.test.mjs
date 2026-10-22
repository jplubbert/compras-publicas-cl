import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-repo.mjs');

function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-repo-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const r = spawnSync('node', [script, '--root', root], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CREDS = 'credentials' + '_json';
const clean = {
  'infra/main/main.tf': 'resource "google_storage_bucket" "bronze" {\n  project  = var.project_id\n  location = var.region\n}\n',
  'infra/main/variables.tf': 'variable "region" {\n  default = "us-central1"\n  validation {\n    condition = contains(["us-central1", "us-east1"], var.region)\n    error_message = "bad"\n  }\n}\n',
};

test('a clean tree passes', () => {
  const r = run(clean);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /check:repo: ok/);
});

const negatives = {
  composer: { 'infra/main/x.tf': 'resource "google_composer' + '_environment" "c" {}\n' },
  'literal-project': { 'infra/main/x.tf': 'resource "google_storage_bucket" "b" {\n  project = "mi-proyecto-123"\n}\n' },
  'literal-account': { 'infra/bootstrap/x.tf': 'locals {\n  billing = "01ABCD-23EF45-6789AB"\n}\n' },
  'literal-region': { 'infra/main/x.tf': 'resource "google_storage_bucket" "b" {\n  location = "southamerica-west1"\n}\n' },
  'credentials-json': { '.github/workflows/ci.yml': `with:\n  ${CREDS}: \${{ secrets.KEY }}\n` },
  'sa-key': { 'keys/sa.json': '{"type": "service' + '_account", "private_key": "x"}\n' },
  'secret-version-data': { 'infra/main/s.tf': 'resource "google_secret_manager' + '_secret_version" "v" {\n  secret      = "s"\n  secret_data = "x"\n}\n' },
};
for (const [rule, files] of Object.entries(negatives)) {
  test(`rule ${rule} fails and names the file`, () => {
    const r = run({ ...clean, ...files });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`${Object.keys(files)[0].replace(/[.]/g, '\\.')}:\\d+: ${rule}`));
  });
}

test('a secret version without secret_data and the credentials input named in a .md pass', () => {
  const r = run({
    ...clean,
    'infra/main/s.tf': 'resource "google_secret_manager' + '_secret_version" "v" {\n  secret = "s"\n}\n',
    'README.md': `Never use ${CREDS}.\n`,
  });
  assert.equal(r.code, 0, r.out);
});
