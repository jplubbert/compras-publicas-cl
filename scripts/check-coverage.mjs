#!/usr/bin/env node
// Coverage from acceptance (DEC-011 of sdd-base): every line of code of the repository must be executed by some test of
// tests/acceptance/ that cites an existing REQ. What no such test reaches is dead code (removed, never excluded) or a
// missing requirement (escalated). No dependencies: it runs the project's coverage command and reads lcov.
//
//   node scripts/check-coverage.mjs [--root DIR] [--since REF] [--json] [--timeout SECONDS]
//                                   the check (npm run check:coverage); --since REF also requires every line added or
//                                   changed since REF (committed or not, and untracked source files) to be reached
//   node scripts/check-coverage.mjs adopt [--root DIR]
//                                   writes the baseline of spec/COVERAGE.json: the current count of unreached lines of
//                                   each source file (adoption in a repository with history, DEC-011 point 4)
//   node scripts/check-coverage.mjs ratchet [--root DIR]
//                                   lowers the baseline to the current counts (it never raises it); prints the changes
//
// spec/COVERAGE.json (validated by check:spec):
//   "command"     the coverage command, run with bash from the root: {files} = the acceptance tests that cite a REQ
//                 (quoted), {lcov} = the lcov file it must write, {dir} = an empty directory it may use (a *.info there
//                 also counts). E.g. "node --test --experimental-test-coverage --test-reporter=lcov
//                 --test-reporter-destination={lcov} {files}" or "npx c8 --reporter=lcovonly --report-dir={dir} npx
//                 vitest run {files}". Its exit code is reported, not judged: green is DEC-006's job.
//   "sources"     globs of the measured code (a directory ends in "/"; "*", "**" and "?" as usual)
//   "tests"       globs of the test files (the instrument; not measured)
//   "exceptions"  [{"glob", "dec", "why"}]: code left out by an accepted DEC, nothing else
//   "baseline"    {"<file>": <unreached lines>} of the files adopted with old unreached lines; it only goes down. Empty
//                 or absent: every line must be reached (the rule is total)
//   "code_extensions"  optional: the extensions that make a file "code" (default: CODE_EXTENSIONS)
// Every versioned file with a code extension must be in sources, in tests or in an exception: nothing is left out
// silently. Without spec/COVERAGE.json the repository is out of the rule (DEC-011 point 6): exit 0 and it says so.
//
// Exit: 0 ok (or out of the rule), 1 violations, 2 configuration or run error.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configErrors, COVERAGE_FILE } from './check-spec.mjs';

export const ACCEPTANCE_DIR = 'tests/acceptance/';
export const CODE_EXTENSIONS = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'kts', 'scala', 'php', 'cs', 'fs', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'dart', 'ex',
  'exs', 'erl', 'clj', 'lua', 'pl', 'sh', 'bash', 'zsh', 'ps1'];

/** A glob as a RegExp over a path relative to the root: "dir/" covers everything below it; "**", "*" and "?". */
export function globToRegExp(glob) {
  if (glob.endsWith('/')) glob += '**';
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}
/** Files of the working tree that git does not ignore (versioned, or new and not ignored). */
function repoFiles(root) {
  return [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean))]
    .filter((f) => existsSync(join(root, f)));
}
const readText = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');
const declaredReqs = (spec) => new Set([...spec.matchAll(/^(?:#{2,4} |\| )(REQ-\d+)\b/gm)].map((m) => m[1]));

/** Line numbers → "3-5,9". */
export function ranges(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return out.join(',');
}

/** lcov text → Map(file relative to root → Map(line → hits)); records of files outside the root are dropped. */
export function parseLcov(text, root) {
  const cov = new Map();
  let file = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('SF:')) {
      const p = l.slice(3);
      const rel = (isAbsolute(p) ? relative(root, p) : p).split(sep).join('/').replace(/^\.\//, '');
      file = rel.startsWith('../') || isAbsolute(rel) ? null : rel;
      if (file && !cov.has(file)) cov.set(file, new Map());
    } else if (l.startsWith('DA:') && file) {
      const [line, hits] = l.slice(3).split(',').map(Number);
      const lines = cov.get(file);
      lines.set(line, Math.max(lines.get(line) ?? 0, hits || 0));
    } else if (l === 'end_of_record') file = null;
  }
  return cov;
}

/** Lines added or changed since `since` (to the working tree), per file; untracked files count whole. */
export function changedLines(root, since, files) {
  const out = new Map();
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', since, '--', ...files]);
  let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l === '+++ /dev/null' ? null : l.slice(6); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m && file) {
      const start = Number(m[1]);
      const n = m[2] === undefined ? 1 : Number(m[2]);
      if (!out.has(file)) out.set(file, new Set());
      for (let k = 0; k < n; k++) out.get(file).add(start + k);
    }
  }
  const untracked = new Set(git(root, ['ls-files', '--others', '--exclude-standard', '--', ...files]).split('\n').filter(Boolean));
  for (const f of untracked) out.set(f, new Set(readText(root, f).split('\n').map((_, i) => i + 1)));
  return out;
}

/** Runs the coverage command on `tests`; → { lcov (text), code, output } or throws if it leaves no lcov. */
function runCoverage(root, command, tests, timeoutSec) {
  const dir = mkdtempSync(join(tmpdir(), 'check-coverage-'));
  const lcovFile = join(dir, 'lcov.info');
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = command.replaceAll('{files}', tests.map(q).join(' ')).replaceAll('{lcov}', q(lcovFile)).replaceAll('{dir}', q(dir));
  try {
    // A node --test run inherits NODE_TEST_CONTEXT from a test runner that launched this check and would report to it.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const r = spawnSync('bash', ['-c', cmd], { cwd: root, env, encoding: 'utf8', timeout: timeoutSec * 1000, maxBuffer: 256 * 1024 * 1024 });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.error) throw new Error(`the coverage command failed to run (${r.error.code ?? r.error.message}): ${cmd}`);
    const infos = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.info'));
    if (infos.length === 0) throw new Error(`the coverage command left no lcov ({lcov} or a *.info in {dir}); exit ${r.status}: ${cmd}\n${output.slice(-2000)}`);
    return { lcov: infos.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n'), code: r.status, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The check (DEC-011). → { status: "out-of-rule" } or { status: "ok" | "violations", tests, command_exit, unlisted,
 * changed: {file: [lines]}, over_baseline: [{file, count, baseline}], counts: {file: n}, uncovered: {file: [lines]},
 * never_loaded: [files], lower: {file: n} }. Throws on a configuration or run error.
 */
export function check(root, { since = null, timeout = 1800 } = {}) {
  const text = readText(root, COVERAGE_FILE);
  if (!text) return { status: 'out-of-rule' };
  let cfg;
  try { cfg = JSON.parse(text); } catch (e) { throw new Error(`${COVERAGE_FILE}: not valid JSON (${e.message})`, { cause: e }); }
  const errors = configErrors(cfg, readText(root, 'spec/DECISIONS.md'));
  if (errors.length) throw new Error(errors.join('\n'));
  const exts = cfg.code_extensions ?? CODE_EXTENSIONS;
  const files = repoFiles(root);
  const isCode = (f) => exts.includes(f.split('/').pop().split('.').slice(1).pop()?.toLowerCase());
  const tests = cfg.tests ?? [];
  const exceptions = (cfg.exceptions ?? []).map((e) => e.glob);
  const code = files.filter(isCode);
  const sources = code.filter((f) => !matchesAny(f, tests) && !matchesAny(f, exceptions) && matchesAny(f, cfg.sources)).sort();
  const unlisted = code.filter((f) => !matchesAny(f, tests) && !matchesAny(f, exceptions) && !matchesAny(f, cfg.sources)).sort();
  // The acceptance tests that count: under tests/acceptance/ and citing a REQ that exists in SPEC.md.
  const reqs = declaredReqs(readText(root, 'spec/SPEC.md'));
  const acceptance = files.filter((f) => f.startsWith(ACCEPTANCE_DIR))
    .filter((f) => [...readText(root, f).matchAll(/\bREQ-\d+\b/g)].some((m) => reqs.has(m[0]))).sort();
  let cov = new Map();
  let commandExit = null;
  if (acceptance.length > 0) {
    const run = runCoverage(root, cfg.command, acceptance, timeout);
    cov = parseLcov(run.lcov, root);
    commandExit = run.code;
  }
  const uncovered = {};
  const counts = {};
  const neverLoaded = [];
  for (const f of sources) {
    const lines = readText(root, f).split('\n');
    const blank = (n) => !lines[n - 1]?.trim();
    let miss;
    if (cov.has(f)) miss = [...cov.get(f)].filter(([n, hits]) => hits === 0 && !blank(n)).map(([n]) => n);
    else { miss = lines.map((_, i) => i + 1).filter((n) => !blank(n)); if (miss.length) neverLoaded.push(f); }
    miss.sort((a, b) => a - b);
    if (miss.length) { uncovered[f] = miss; counts[f] = miss.length; }
  }
  const baseline = cfg.baseline ?? {};
  const overBaseline = Object.entries(counts).filter(([f, n]) => n > (baseline[f] ?? 0)).map(([f, n]) => ({ file: f, count: n, baseline: baseline[f] ?? 0 }));
  const lower = {};
  for (const [f, n] of Object.entries(baseline)) if ((counts[f] ?? 0) < n) lower[f] = counts[f] ?? 0;
  const changed = {};
  if (since) {
    for (const [f, lines] of changedLines(root, since, sources)) {
      const miss = (uncovered[f] ?? []).filter((n) => lines.has(n));
      if (miss.length) changed[f] = miss;
    }
  }
  const bad = unlisted.length || overBaseline.length || Object.keys(changed).length;
  return {
    status: bad ? 'violations' : 'ok', tests: acceptance, command_exit: commandExit, unlisted, changed,
    over_baseline: overBaseline, counts, uncovered, never_loaded: neverLoaded, lower, since,
  };
}

/** Writes the baseline of spec/COVERAGE.json: `counts` (adopt) or the lower of both (ratchet). → the new baseline. */
export function writeBaseline(root, counts, { onlyLower = false } = {}) {
  const cfg = JSON.parse(readText(root, COVERAGE_FILE));
  const old = cfg.baseline ?? {};
  const next = {};
  for (const [f, n] of Object.entries(onlyLower ? old : counts)) {
    const v = onlyLower ? Math.min(n, counts[f] ?? 0) : n;
    if (v > 0) next[f] = v;
  }
  cfg.baseline = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(root, COVERAGE_FILE), `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg.baseline;
}

function report(r) {
  if (r.status === 'out-of-rule') {
    return [`check:coverage: out of the rule: there is no ${COVERAGE_FILE} (DEC-011 point 6); acceptance does not run locally with coverage yet`];
  }
  const out = [];
  out.push(`check:coverage: ${r.tests.length} acceptance test(s) citing a REQ${r.command_exit === null ? '' : ` (coverage command exit ${r.command_exit})`}`);
  for (const f of r.unlisted) out.push(`${f}: code outside "sources", "tests" and the exceptions of ${COVERAGE_FILE} (declare it; nothing is left out silently)`);
  for (const [f, lines] of Object.entries(r.changed)) out.push(`${f}:${ranges(lines)}: new or changed since ${r.since}, reached by no acceptance test citing a REQ`);
  for (const o of r.over_baseline) {
    const never = r.never_loaded.includes(o.file) ? ' (no acceptance test loads it)' : '';
    out.push(`${o.file}:${ranges(r.uncovered[o.file])}: ${o.count} unreached line(s), baseline ${o.baseline}${never}`);
  }
  for (const [f, n] of Object.entries(r.lower)) out.push(`(the baseline of ${f} can go down to ${n}: check-coverage.mjs ratchet)`);
  if (r.status === 'ok') out.push('check:coverage: ok');
  else out.push('check:coverage: what no acceptance test citing a REQ reaches is dead code (remove it) or a missing requirement (escalate it); it is never excluded (DEC-011)');
  return out;
}

function main(argv) {
  let root = fileURLToPath(new URL('..', import.meta.url));
  const args = [];
  let since = null;
  let json = false;
  let timeout = 1800;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--since') since = argv[++i];
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '--timeout') timeout = Number(argv[++i]);
    else args.push(argv[i]);
  }
  const [cmd] = args;
  if (cmd !== undefined && cmd !== 'adopt' && cmd !== 'ratchet') throw new Error(`unknown command: ${cmd}`);
  const r = check(root, { since, timeout });
  if (cmd === 'adopt' || cmd === 'ratchet') {
    if (r.status === 'out-of-rule') throw new Error(`there is no ${COVERAGE_FILE} to write the baseline to`);
    if (cmd === 'adopt' && r.unlisted.length) throw new Error(`declare these files first (sources, tests or an exception): ${r.unlisted.join(', ')}`);
    const before = JSON.parse(readText(root, COVERAGE_FILE)).baseline ?? {};
    const b = writeBaseline(root, r.counts, { onlyLower: cmd === 'ratchet' });
    const changes = [...new Set([...Object.keys(before), ...Object.keys(b)])].sort()
      .filter((f) => before[f] !== b[f]).map((f) => ({ file: f, from: before[f] ?? 0, to: b[f] ?? 0 }));
    if (json) process.stdout.write(`${JSON.stringify({ baseline: b, changes }, null, 2)}\n`);
    else for (const c of changes) console.log(`${c.file}: baseline ${c.from} → ${c.to}`);
    return 0;
  }
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else for (const l of report(r)) console.log(l);
  return r.status === 'violations' ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`check-coverage: ${e.message}`);
    process.exit(2);
  }
}
