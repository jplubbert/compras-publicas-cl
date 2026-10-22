#!/usr/bin/env node
// check-adr (DEC-035 points 3 to 5): the ADRs of spec/adr/ keep their promises.
//
//   node scripts/check-adr.mjs [--root DIR] [--run]       (npm run check:adr; also in npm test)
//
// - Every accepted ADR has `Enforced-by:` in one of three forms: `<test file>#<pattern>` (the file exists and a test
//   name in it contains the pattern; npm test runs it, and --run runs it here too), `cmd: <command>` (run here, in the
//   root) or `manual: <reason>`.
// - Violations that existed at the migration live in spec/adr/baseline.json ({"violations": [...]}): they pass, the
//   new ones fail, and the baseline may only shrink with respect to the version that first added it.
// - An accepted ADR is immutable: no commit (and no uncommitted change) may alter its body; the only allowed changes are
//   its Estado, to `superseded by NNNN` of an ADR that exists, its Enforced-by (how a baseline violation is fixed) and its
//   Módulos (DEC-042), whose values must be existing files.
// - The generated index of spec/DECISIONS.md is up to date (node scripts/adr.mjs index).
// Exit 1 with one line per problem.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADR_DIR, DECISIONS_FILE, loadDecisions, parseAdr, realOptions } from './lib/adr.mjs';
import { withIndex } from './adr.mjs';

export const BASELINE = `${ADR_DIR}/baseline.json`;
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const tryGit = (root, args) => { try { return git(root, args); } catch { return null; } };
// everything but the Estado, Enforced-by and Módulos lines (fixing a baseline violation is adding Enforced-by; Módulos is
// routing, not the decision: DEC-042)
const body = (text) => text.replace(/^- Estado:.*$/m, '').replace(/^- Enforced-by:.*\n?/m, '').replace(/^- Módulos:.*\n?/m, '');

/** The violations of the Enforced-by rule (point 4), one string per ADR, e.g. "DEC-005: accepted without Enforced-by". */
export function enforcementViolations(root, { run = false } = {}) {
  const out = [];
  for (const d of loadDecisions(root).filter((x) => x.kind === 'adr' && x.status === 'accepted')) {
    const e = d.enforcedBy;
    if (!e) { out.push(`${d.id}: accepted without Enforced-by`); continue; }
    if (/^manual:/.test(e)) { if (!e.replace(/^manual:/, '').trim()) out.push(`${d.id}: manual Enforced-by needs a reason`); continue; }
    if (/^cmd:/.test(e)) {
      const cmd = e.replace(/^cmd:/, '').trim();
      const r = spawnSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (r.status !== 0) out.push(`${d.id}: its check \`${cmd}\` failed (exit ${r.status})`);
      continue;
    }
    const [file, pattern] = e.split('#');
    if (!existsSync(join(root, file))) { out.push(`${d.id}: Enforced-by ${file} does not exist`); continue; }
    if (!pattern) { out.push(`${d.id}: Enforced-by ${file} needs #<pattern> (a test name that cites the decision)`); continue; }
    const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = new RegExp(`(?:it|describe|test)\\(\\s*(['"\`])(?:(?!\\1).)*${esc}`);
    if (!names.test(readFileSync(join(root, file), 'utf8'))) { out.push(`${d.id}: no test name in ${file} cites ${pattern}`); continue; }
    if (run) {
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      const r = spawnSync('node', ['--test', `--test-name-pattern=${pattern}`, file], { cwd: root, encoding: 'utf8', env });
      if (r.status !== 0) out.push(`${d.id}: its check ${e} failed`);
    }
  }
  return out;
}

/** Point 5: changes to the body of an accepted ADR, in the history and in the working tree. */
export function immutabilityErrors(root) {
  const errors = [];
  const adrs = loadDecisions(root).filter((d) => d.kind === 'adr');
  const nums = new Set(adrs.map((d) => d.num));
  for (const d of adrs.filter((x) => x.status === 'superseded')) {   // the current state: its successor exists
    const m = /^superseded by (?:DEC-)?(\d+)$/.exec(d.statusLine ?? '');
    if (!m) errors.push(`${d.id}: Estado "${d.statusLine}" must be "superseded by NNNN"`);
    else if (!nums.has(Number(m[1]))) errors.push(`${d.id}: superseded by ${m[1]}, which is not an ADR`);
  }
  const checkPair = (id, before, after, where) => {
    if (before && parseAdr(before).status === 'superseded' && body(before) + parseAdr(before).statusLine !== body(after) + parseAdr(after).statusLine) {
      errors.push(`${id}: a superseded ADR does not change (${where})`);
      return;
    }
    if (!before || parseAdr(before).status !== 'accepted') return;
    if (body(before) !== body(after)) errors.push(`${id}: the body of an accepted ADR changed (${where}); supersede it with a new ADR`);
    const st = parseAdr(after).statusLine ?? '';
    if (st !== 'accepted') {
      const m = /^superseded by (?:DEC-)?(\d+)$/.exec(st);
      if (!m) errors.push(`${id}: an accepted ADR may only become "superseded by NNNN", not "${st}" (${where})`);

    }
  };
  const isRepo = tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']) !== null;
  for (const d of adrs) {
    const now = readFileSync(join(root, d.file), 'utf8');
    if (!isRepo) continue;
    const head = tryGit(root, ['show', `HEAD:${d.file}`]);
    if (head !== null && head !== now) checkPair(d.id, head, now, 'working tree');
    const shas = (tryGit(root, ['log', '--format=%H', '--', d.file]) ?? '').split('\n').filter(Boolean);
    for (const sha of shas) {
      const after = tryGit(root, ['show', `${sha}:${d.file}`]);
      const before = tryGit(root, ['show', `${sha}^:${d.file}`]);
      if (after !== null && before !== null && after !== before) checkPair(d.id, before, after, `commit ${sha.slice(0, 7)}`);
    }
  }
  return errors;
}

/** DEC-036 (T-71): an ADR added after the migration (the first commit with ADRs) is born proposed, and it is accepted
 * only with at least two options with their pros and cons recorded. The migrated ADRs are exempt (their debt is in
 * research/adr-auditoria.md). One born accepted is no longer flagged once it is superseded by an ADR born proposed and
 * accepted, or superseded in turn by one that meets the same (T-102): history is not rewritten. */
export function newAdrErrors(root) {
  const errors = [];
  if (tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']) === null) return errors;
  const first = (tryGit(root, ['log', '--diff-filter=A', '--format=%H', '--', ADR_DIR]) ?? '').split('\n').filter(Boolean).at(-1);
  const adrs = loadDecisions(root).filter((x) => x.kind === 'adr');
  const byNum = new Map(adrs.map((d) => [d.num, d]));
  const birth = (d) => {
    const born = (tryGit(root, ['log', '--diff-filter=A', '--format=%H', '--', d.file]) ?? '').split('\n').filter(Boolean).at(-1);
    return { born, text: born ? tryGit(root, ['show', `${born}:${d.file}`]) : d.text };
  };
  const bornProposed = (d) => { const { born, text } = birth(d); return born !== first && !!text && parseAdr(text).status === 'proposed'; };
  const replacedProperly = (d, seen = new Set([d.num])) => {
    const m = /^superseded by (?:DEC-)?(\d+)$/.exec(d.statusLine ?? '');
    const s = m && byNum.get(Number(m[1]));
    if (!s || seen.has(s.num) || !bornProposed(s)) return false;
    return s.status === 'accepted' || (s.status === 'superseded' && replacedProperly(s, seen.add(s.num)));
  };
  for (const d of adrs) {
    const { born, text: bornText } = birth(d);
    if (born && born === first) continue;   // migrated (DEC-035)
    if (bornText && parseAdr(bornText).status === 'accepted' && !(d.status === 'superseded' && replacedProperly(d))) errors.push(`${d.id}: a new ADR is born proposed (DEC-036); it was ${born ? `committed in ${born.slice(0, 7)}` : 'created'} as accepted`);
    if (d.status === 'accepted' && realOptions(d.text) < 2) errors.push(`${d.id}: accepted with fewer than two options with their pros and cons (DEC-036)`);
  }
  return errors;
}

/** DEC-042: every Módulos value of an accepted ADR is an existing file: no folder, README.md or AGENTS.md. */
export function modulesErrors(root) {
  const errors = [];
  for (const d of loadDecisions(root).filter((x) => x.kind === 'adr' && x.status === 'accepted')) {
    for (const m of d.modules) {
      const bad = m.endsWith('/') || ['README.md', 'AGENTS.md'].includes(m.split('/').pop()) || !existsSync(join(root, m)) || statSync(join(root, m)).isDirectory();
      if (bad) errors.push(`${d.id}: Módulos ${m} must be an existing file (not a folder, README.md or AGENTS.md; DEC-042)`);
    }
  }
  return errors;
}

/** Point 4: the frozen baseline (violations allowed because they existed at the migration); it may only shrink. */
function baseline(root, errors) {
  const path = join(root, BASELINE);
  if (!existsSync(path)) return [];
  let cur;
  try { cur = JSON.parse(readFileSync(path, 'utf8')).violations; } catch (e) { errors.push(`${BASELINE}: not valid JSON (${e.message})`); return []; }
  if (!Array.isArray(cur) || cur.some((v) => typeof v !== 'string')) { errors.push(`${BASELINE}: "violations" must be a list of strings`); return []; }
  const first = (tryGit(root, ['log', '--diff-filter=A', '--format=%H', '--', BASELINE]) ?? '').split('\n').filter(Boolean).at(-1);
  if (first) {
    let frozen = [];
    try { frozen = JSON.parse(git(root, ['show', `${first}:${BASELINE}`])).violations ?? []; } catch { /* unreadable: nothing frozen */ }
    for (const v of cur) if (!frozen.includes(v)) errors.push(`${BASELINE} may only shrink: ${v} is new (frozen at ${first.slice(0, 7)})`);
  }
  return cur;
}

export function checkAdr(root, { run = false } = {}) {
  const errors = [];
  const allowed = baseline(root, errors);
  for (const v of enforcementViolations(root, { run })) if (!allowed.includes(v)) errors.push(v);
  errors.push(...immutabilityErrors(root));
  errors.push(...newAdrErrors(root));
  errors.push(...modulesErrors(root));
  const decisions = existsSync(join(root, DECISIONS_FILE)) ? readFileSync(join(root, DECISIONS_FILE), 'utf8') : null;
  const anyAdr = loadDecisions(root).some((d) => d.kind === 'adr');
  if (decisions !== null && (anyAdr || decisions.includes('<!-- adr-index:start -->')) && withIndex(root, decisions) !== decisions) {
    errors.push(`the index of ${DECISIONS_FILE} is out of date: run node scripts/adr.mjs index`);
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const root = resolve(argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : join(fileURLToPath(new URL('.', import.meta.url)), '..'));
  const errors = checkAdr(root, { run: argv.includes('--run') });
  if (errors.length) {
    process.stderr.write(`check-adr: ${errors.length} problem(s)\n${errors.map((e) => `  ✗ ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  console.log('check-adr: ok');
}
