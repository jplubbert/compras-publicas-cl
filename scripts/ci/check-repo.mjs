#!/usr/bin/env node
// Repository guard (DEC-001, DEC-004): fails on Composer, literal project ids, account numbers or regions in infra/,
// and on service account keys, inline GitHub credentials or secret versions with data anywhere in the tree.
//
//   node scripts/ci/check-repo.mjs [--root DIR]
//
// Prints one line per finding (<path>:<line>: <rule>) and exits 1, or "check:repo: ok" and exits 0.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Literals are built by concatenation so that this file does not match its own rules.
const CREDS = 'credentials' + '_json';
const SECRET_VERSION = 'google_secret_manager' + '_secret_version';
const COMPOSER = 'google_composer' + '_environment';
const PRIVATE_KEY = '-----BEGIN ' + 'PRIVATE KEY-----';
const SKIP_DIRS = new Set(['.git', '.tools', 'node_modules', '.venv', '.terraform']);
const REGION = /^(us|europe|asia|australia|southamerica|northamerica|me|africa)-[a-z]+\d+$/;

function listFiles(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk('');
    return files;
  }
}

/** Line numbers (1-based) that sit inside a `variable` block's default or a `validation` block. */
function exemptLines(lines) {
  const exempt = new Set();
  let depth = 0;
  let exemptUntil = -1;
  lines.forEach((line, i) => {
    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;
    if (exemptUntil < 0 && /^\s*(validation\s*{|default\s*=)/.test(line)) exemptUntil = depth;
    if (exemptUntil >= 0) exempt.add(i + 1);
    depth += opens - closes;
    if (exemptUntil >= 0 && depth <= exemptUntil && !/^\s*default\s*=\s*\[\s*$/.test(line)) exemptUntil = -1;
  });
  return exempt;
}

function checkInfra(path, text, findings) {
  const lines = text.split('\n');
  const exempt = exemptLines(lines);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.trim().startsWith('#') || line.trim().startsWith('//')) return;
    if (new RegExp(`resource\\s+"${COMPOSER}"`).test(line)) findings.push(`${path}:${n}: composer`);
    if (/^\s*(project|project_id)\s*=\s*"[^"$]/.test(line) || /projects\/[a-z][a-z0-9-]{4,}/.test(line.replace(/\$\{[^}]*\}/g, ''))) {
      findings.push(`${path}:${n}: literal-project`);
    }
    if (/\b[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}\b/.test(line) || /\b\d{12}\b/.test(line)) findings.push(`${path}:${n}: literal-account`);
    const m = line.match(/^\s*(region|location)\s*=\s*"([^"]+)"/);
    if (m && REGION.test(m[2].toLowerCase()) && !exempt.has(n)) findings.push(`${path}:${n}: literal-region`);
  });
}

function checkSecrets(path, text, findings) {
  const lines = text.split('\n');
  let inSecretVersion = -1;
  let depth = 0;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.includes(CREDS)) findings.push(`${path}:${n}: credentials-json`);
    if (line.includes(PRIVATE_KEY)) findings.push(`${path}:${n}: sa-key`);
    if (new RegExp(`resource\\s+"${SECRET_VERSION}"`).test(line)) { inSecretVersion = depth; }
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (inSecretVersion >= 0 && /^\s*secret_data\b/.test(line)) findings.push(`${path}:${n}: secret-version-data`);
    if (inSecretVersion >= 0 && depth <= inSecretVersion) inSecretVersion = -1;
  });
  if (/"type"\s*:\s*"service_account"/.test(text) && /"private_key"/.test(text)) findings.push(`${path}:1: sa-key`);
}

export function checkRepo(root) {
  const findings = [];
  for (const path of listFiles(root)) {
    let text;
    try {
      if (!statSync(join(root, path)).isFile()) continue;
      text = readFileSync(join(root, path), 'utf8');
    } catch { continue; }
    if (/^infra\/.*(\.tf|\.tfvars\.example)$/.test(path)) checkInfra(path, text, findings);
    if (/^(spec|plans|research)\//.test(path) || path.endsWith('.md')) continue;
    checkSecrets(path, text, findings);
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? process.argv[i + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const findings = checkRepo(root);
  if (findings.length) {
    for (const f of findings) console.log(f);
    process.exit(1);
  }
  console.log('check:repo: ok');
}
