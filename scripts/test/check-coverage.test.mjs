import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { globToRegExp, parseLcov, ranges } from '../check-coverage.mjs';

// Fixtures: a temporary project with the fixed spec/ (REQ-001…REQ-005, DEC-001…DEC-005 accepted), a little code under
// src/ and acceptance tests under tests/acceptance/, measured with Node's native coverage (lcov).
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts/check-coverage.mjs');
const CHECK_SPEC = join(REPO, 'scripts/check-spec.mjs');
const SPEC_FIXTURE = join(REPO, 'scripts/test/fixtures/spec');
const NODE_COVERAGE = 'node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination={lcov} {files}';

let root;
const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const config = (extra = {}) => write('spec/COVERAGE.json', `${JSON.stringify({ command: NODE_COVERAGE, sources: ['src/'], tests: ['tests/'], ...extra }, null, 2)}\n`);
const coverage = (...args) => {
  const r = spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (...args) => JSON.parse(coverage(...args, '--json').out);
// src/a.mjs: f(x) returns 1 for x > 0 (line 3) and 2 otherwise (line 5); src/cli.mjs runs as a child process.
const A = 'export function f(x) {\n  if (x > 0) {\n    return 1;\n  }\n  return 2;\n}\n';
const CLI = "const x = process.argv[2];\nif (x === 'a') {\n  console.log('A');\n} else {\n  console.log('B');\n}\n";
const acceptance = (name, body, req = 'REQ-001') => write(`tests/acceptance/${name}`, [
  `// ${req}: example`, "import { test } from 'node:test';", "import { execFileSync } from 'node:child_process';",
  "import { f } from '../../src/a.mjs';", `test('${name}', () => { ${body} });`, ''].join('\n'));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-coverage-'));
  cpSync(SPEC_FIXTURE, join(root, 'spec'), { recursive: true });
  write('src/a.mjs', A);
  write('src/cli.mjs', CLI);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('check-coverage (DEC-011)', () => {
  it('without spec/COVERAGE.json the repository is out of the rule: exit 0 and it says so', () => {
    const r = coverage();
    expect(r.code).toBe(0);
    expect(r.out).toContain('out of the rule: there is no spec/COVERAGE.json (DEC-011 point 6)');
  });

  it('every line reached by acceptance tests citing a REQ (also in a child process) → ok', () => {
    config();
    acceptance('T-01.test.mjs', "f(1); f(0); execFileSync('node', ['src/cli.mjs', 'a']); execFileSync('node', ['src/cli.mjs', 'b']);");
    const r = coverage();
    expect(r.out).toContain('check:coverage: 1 acceptance test(s) citing a REQ (coverage command exit 0)');
    expect(r.out).toContain('check:coverage: ok');
    expect(r.code).toBe(0);
  });

  it('an unreached line fails with file:lines, a file no test loads counts whole, and so on', () => {
    config();
    acceptance('T-01.test.mjs', 'f(1);');
    const r = coverage();
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/a.mjs:5: 1 unreached line(s), baseline 0');
    expect(r.out).toContain('src/cli.mjs:1-6: 6 unreached line(s), baseline 0 (no acceptance test loads it)');
    expect(r.out).toContain('dead code (remove it) or a missing requirement (escalate it); it is never excluded (DEC-011)');
  });

  it('only tests under tests/acceptance/ that cite an existing REQ count', () => {
    config();
    acceptance('T-01.test.mjs', "f(1); f(0); execFileSync('node', ['src/cli.mjs', 'a']); execFileSync('node', ['src/cli.mjs', 'b']);", 'sin requisito');
    acceptance('T-02.test.mjs', 'f(1); f(0);', 'REQ-099');
    write('tests/unit/a.test.mjs', "// REQ-001\nimport { f } from '../../src/a.mjs';\nf(1); f(0);\n");
    const r = json();
    expect(r.tests).toEqual([]);
    expect(r.never_loaded).toEqual(['src/a.mjs', 'src/cli.mjs']);
    expect(r.status).toBe('violations');
  });

  it('code outside sources, tests and exceptions fails; an exception needs an accepted DEC', () => {
    config();
    acceptance('T-01.test.mjs', "f(1); f(0); execFileSync('node', ['src/cli.mjs', 'a']); execFileSync('node', ['src/cli.mjs', 'b']);");
    write('scripts/deploy.sh', 'echo deploy\n');
    write('README.md', 'not code\n');
    const r = coverage();
    expect(r.code).toBe(1);
    expect(r.out).toContain('scripts/deploy.sh: code outside "sources", "tests" and the exceptions of spec/COVERAGE.json');
    expect(r.out).not.toContain('README.md');
    config({ exceptions: [{ glob: 'scripts/*.sh', dec: 'DEC-001', why: 'bash: R-01' }] });
    expect(coverage().code).toBe(0);
    config({ exceptions: [{ glob: 'scripts/*.sh', dec: 'DEC-042', why: 'x' }] });
    expect(coverage()).toMatchObject({ code: 2, err: expect.stringContaining('exceptions[0] cites DEC-042, which does not exist in spec/DECISIONS.md') });
    writeFileSync(join(root, 'spec/DECISIONS.md'), readFileSync(join(root, 'spec/DECISIONS.md'), 'utf8').replace('## DEC-001 Decisión de prueba 1\n- Estado: accepted', '## DEC-001 Decisión de prueba 1\n- Estado: proposed'));
    config({ exceptions: [{ glob: 'scripts/*.sh', dec: 'DEC-001', why: 'x' }] });
    expect(coverage()).toMatchObject({ code: 2, err: expect.stringContaining('exceptions[0] cites DEC-001, which is proposed, not accepted') });
  });

  it('baseline: old unreached lines are tolerated up to their count; above it fails; below it can go down', () => {
    config({ baseline: { 'src/a.mjs': 1, 'src/cli.mjs': 6 } });
    acceptance('T-01.test.mjs', 'f(1);');
    expect(coverage().code).toBe(0);
    config({ baseline: { 'src/cli.mjs': 6 } });
    expect(coverage().out).toContain('src/a.mjs:5: 1 unreached line(s), baseline 0');
    config({ baseline: { 'src/a.mjs': 3, 'src/cli.mjs': 6 } });
    const r = coverage();
    expect(r.code).toBe(0);
    expect(r.out).toContain('(the baseline of src/a.mjs can go down to 1: check-coverage.mjs ratchet)');
    const ratchet = spawnSync('node', [SCRIPT, '--root', root, 'ratchet'], { encoding: 'utf8' });
    expect(ratchet.stdout).toContain('src/a.mjs: baseline 3 → 1');
    expect(JSON.parse(readFileSync(join(root, 'spec/COVERAGE.json'), 'utf8')).baseline).toEqual({ 'src/a.mjs': 1, 'src/cli.mjs': 6 });
  });

  it('adopt writes the current counts as the baseline; an empty baseline makes the rule total', () => {
    config();
    acceptance('T-01.test.mjs', 'f(1);');
    expect(coverage().code).toBe(1);
    const adopt = spawnSync('node', [SCRIPT, '--root', root, 'adopt'], { encoding: 'utf8' });
    expect(adopt.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'spec/COVERAGE.json'), 'utf8')).baseline).toEqual({ 'src/a.mjs': 1, 'src/cli.mjs': 6 });
    expect(coverage().code).toBe(0);
    acceptance('T-01.test.mjs', "f(1); f(0); execFileSync('node', ['src/cli.mjs', 'a']); execFileSync('node', ['src/cli.mjs', 'b']);");
    spawnSync('node', [SCRIPT, '--root', root, 'ratchet'], { encoding: 'utf8' });
    expect(JSON.parse(readFileSync(join(root, 'spec/COVERAGE.json'), 'utf8')).baseline).toEqual({});
    write('src/a.mjs', `${A}export function dead() {\n  return 3;\n}\n`);
    const total = coverage();
    expect(total.code).toBe(1);
    expect(total.out).toMatch(/src\/a\.mjs:8(-9)?: \d unreached line\(s\), baseline 0/);
  });

  it('--since: a new or changed line must be reached even where the baseline tolerates old ones', () => {
    config({ baseline: { 'src/a.mjs': 2, 'src/cli.mjs': 6 } });
    acceptance('T-01.test.mjs', 'f(1);');
    git('add', '-A');
    git('commit', '-q', '-m', 'adopted');
    write('src/a.mjs', A.replace('  return 2;\n', '  return 3;\n'));
    expect(coverage().code).toBe(0); // the count (1) is within the baseline (2)
    const r = coverage('--since', 'HEAD');
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/a.mjs:5: new or changed since HEAD, reached by no acceptance test citing a REQ');
    write('src/new.mjs', 'export const n = 1;\n');
    expect(json('--since', 'HEAD').changed).toMatchObject({ 'src/new.mjs': [1] });
  });

  it('a command that leaves no lcov is an error (exit 2)', () => {
    config({ command: 'true {files} {lcov}' });
    acceptance('T-01.test.mjs', 'f(1);');
    expect(coverage()).toMatchObject({ code: 2, err: expect.stringContaining('the coverage command left no lcov') });
  });

  it('check:spec accepts spec/COVERAGE.json and validates it', () => {
    git('commit', '-q', '--allow-empty', '-m', 'x\n\nTask: none\nReq: none');
    const check = () => spawnSync('node', [CHECK_SPEC, '--root', root], { encoding: 'utf8' });
    config();
    expect(check().stdout + check().stderr).not.toContain('COVERAGE.json');
    write('spec/COVERAGE.json', JSON.stringify({ command: 'npm test', sources: [], baseline: { 'src/a.mjs': 0 }, extra: 1 }));
    const out = check().stdout + check().stderr;
    for (const e of ['unknown key "extra"', '"command" must be a string with {files} and {lcov}', '"sources" must be a non-empty list of globs',
      'baseline of src/a.mjs must be a whole number > 0']) expect(out).toContain(e);
  });
});

describe('check-coverage helpers', () => {
  it('globs: "dir/" covers everything below; ** and * as usual', () => {
    expect(globToRegExp('src/').test('src/a/b.mjs')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/x.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/x.ts')).toBe(true);
    expect(globToRegExp('scripts/*.sh').test('scripts/a/b.sh')).toBe(false);
    expect(globToRegExp('*.mjs').test('a.mjs')).toBe(true);
  });

  it('lcov: absolute paths relative to the root, files outside it dropped, hits merged', () => {
    const cov = parseLcov('SF:/r/src/a.mjs\nDA:1,0\nDA:2,1\nend_of_record\nSF:/elsewhere/x.js\nDA:1,1\nend_of_record\nSF:src/a.mjs\nDA:1,3\nend_of_record\n', '/r');
    expect([...cov.keys()]).toEqual(['src/a.mjs']);
    expect(cov.get('src/a.mjs').get(1)).toBe(3);
    expect(ranges([1, 2, 3, 7, 9, 10])).toBe('1-3,7,9-10');
  });
});
