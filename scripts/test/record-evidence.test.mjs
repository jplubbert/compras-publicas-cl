import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { accessGuard } from '../lib/access-policy.mjs';

// The port record_evidence (DEC-014, DEC-013, DEC-017): scripts/record_evidence.py writes evidence and status from the
// real output of the task's verify; no agent types a number. Tested on a temporary copy of the fixed spec/.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts/record_evidence.py');
const CHECK_SPEC = join(REPO, 'scripts/check-spec.mjs');
const SPEC_FIXTURE = join(REPO, 'scripts/test/fixtures/spec');

let root;
const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const tasks = () => JSON.parse(readFileSync(join(root, 'spec/TASKS.json'), 'utf8'));
const task = (id) => tasks().tasks.find((t) => t.id === id);
const edit = (fn) => {
  const d = tasks();
  fn(d.tasks);
  writeFileSync(join(root, 'spec/TASKS.json'), `${JSON.stringify(d, null, 2)}\n`);
};
// T-08 (in_progress in the fixture) is the active task; its verify prints a summary in node:test's format.
const summary = (pass, fail) => `printf 'ok\\n\\xe2\\x84\\xb9 tests ${pass + fail}\\n\\xe2\\x84\\xb9 pass ${pass}\\n\\xe2\\x84\\xb9 fail ${fail}\\n'${fail ? '; exit 1' : ''}`;
const activeVerify = (cmd) => edit((ts) => {
  for (const t of ts) if (t.id !== 'T-08' && t.status === 'in_progress') t.status = 'approved_for_impl';
  ts.find((t) => t.id === 'T-08').verify = cmd;
});
const record = (...args) => spawnSync('python3', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'record-evidence-'));
  cpSync(SPEC_FIXTURE, join(root, 'spec'), { recursive: true });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('record_evidence.py (DEC-014)', () => {
  it('runs the active task\'s verify, keeps the raw log and writes evidence and status from it, atomically', () => {
    activeVerify(summary(55, 0));
    const r = record();
    expect(r.status).toBe(0);
    const ev = task('T-08').evidence;
    expect(ev).toMatchObject({ command: summary(55, 0), exit_code: 0, passed: 55, failed: 0, total: 55, log_path: 'artifacts/T-08/verify.log' });
    expect(ev.log_sha256).toBe(sha(join(root, 'artifacts/T-08/verify.log')));
    expect(ev.commit).toBe(git('rev-parse', 'HEAD').trim());
    expect(ev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ev.result).toContain('55/55');
    expect(task('T-08').status).toBe('verified_auto');
    expect(readFileSync(join(root, 'artifacts/T-08/verify.log'), 'utf8')).toContain('ℹ pass 55');
    expect(readdirSync(join(root, 'spec')).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('overwrites evidence completely; the implementer\'s claims (e.g. manual_pending) stay apart and untouched (T-34)', () => {
    activeVerify(summary(2, 0));
    edit((ts) => { Object.assign(ts.find((t) => t.id === 'T-08'), { evidence: { command: 'x', result: 'y', commit: 'z', manual_pending: 'viejo' }, claims: { manual_pending: 'probar en el teléfono' } }); });
    record();
    expect(task('T-08').evidence.manual_pending).toBe(undefined);
    expect(task('T-08').claims).toEqual({ manual_pending: 'probar en el teléfono' });
    expect(task('T-08').evidence.result).toContain('2/2');
  });

  it('one failing test: status implemented, never done, exit 2', () => {
    activeVerify(summary(54, 1));
    const r = record();
    expect(r.status).toBe(2);
    expect(task('T-08')).toMatchObject({ status: 'implemented', evidence: { passed: 54, failed: 1, total: 55, exit_code: 1 } });
    expect(r.stderr).toContain('artifacts/T-08/verify.log');
  });

  it('an output it cannot count fails and writes nothing to spec/TASKS.json', () => {
    activeVerify('echo all good');
    const before = readFileSync(join(root, 'spec/TASKS.json'), 'utf8');
    const r = record();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('cannot parse');
    expect(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).toBe(before);
  });

  it('needs exactly one in_progress task (or --task) and a verify', () => {
    edit((ts) => { for (const t of ts) if (t.status === 'in_progress') t.status = 'approved_for_impl'; });
    expect(record()).toMatchObject({ status: 3, stderr: expect.stringContaining('no task is in_progress') });
    edit((ts) => { ts.find((t) => t.id === 'T-03').verify = undefined; });
    expect(record('--task', 'T-03')).toMatchObject({ status: 3, stderr: expect.stringContaining('T-03 has no verify') });
  });

  it('counts node:test, vitest and jest summaries, adding up several runs', () => {
    activeVerify("printf ' Test Files  14 passed (14)\\n      Tests  2 failed | 145 passed (147)\\nTests:       1 failed, 172 passed, 173 total\\n'");
    record();
    expect(task('T-08').evidence).toMatchObject({ passed: 317, failed: 3, total: 320 });
  });

  it('T-85: a colored vitest summary counts the same as a plain one', () => {
    activeVerify("printf '\\033[2m Test Files \\033[22m \\033[1m\\033[32m15 passed\\033[39m\\033[22m\\033[90m (15)\\033[39m\\n\\033[2m      Tests \\033[22m \\033[1m\\033[32m153 passed\\033[39m\\033[22m\\033[90m (153)\\033[39m\\nTests:       173 passed, 173 total\\n'");
    record();
    expect(task('T-08').evidence).toMatchObject({ passed: 326, failed: 0, total: 326 });
  });

  it('T-85: the verify runs with NO_COLOR=1 and without FORCE_COLOR, whatever the caller has', () => {
    activeVerify("test \"$NO_COLOR\" = 1 && test -z \"${FORCE_COLOR+x}\" && printf 'ℹ tests 1\\nℹ pass 1\\nℹ fail 0\\n'");
    const r = spawnSync('python3', [SCRIPT, '--root', root], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' } });
    expect(r.status).toBe(0);
    expect(task('T-08').evidence).toMatchObject({ passed: 1, total: 1, exit_code: 0 });
  });

  it('--report-only writes the log and the report to --log-dir and leaves spec/ and artifacts/ alone', () => {
    activeVerify(summary(3, 0));
    const dir = join(root, '..', `${root.split('/').pop()}-report`);
    mkdirSync(dir);
    const before = readFileSync(join(root, 'spec/TASKS.json'), 'utf8');
    const r = record('--task', 'T-08', '--report-only', '--log-dir', dir);
    expect(r.status).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
    expect(report).toMatchObject({ passed: 3, failed: 0, total: 3, log_path: join(dir, 'verify.log') });
    expect(report.log_sha256).toBe(sha(join(dir, 'verify.log')));
    expect(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).toBe(before);
    expect(existsSync(join(root, 'artifacts'))).toBe(false);
    // --check: a report whose log was altered by hand no longer matches
    expect(record('--check', join(dir, 'evidence.json')).status).toBe(0);
    writeFileSync(join(dir, 'verify.log'), readFileSync(join(dir, 'verify.log'), 'utf8').replace('pass 3', 'pass 57'));
    expect(record('--check', join(dir, 'evidence.json'))).toMatchObject({ status: 1, stderr: expect.stringContaining('sha256') });
    rmSync(dir, { recursive: true, force: true });
  });

  describe('--batch: one run of the full suite is the evidence of every task of the batch (T-57)', () => {
    const batchVerify = (cmd, ids) => edit((ts) => { for (const id of ids) ts.find((t) => t.id === id).verify = cmd; });

    it('runs the shared verify once and writes the same log, sha256 and commit to each task, with the batch listed', () => {
      const counter = join(root, '..', `${root.split('/').pop()}-runs`);
      batchVerify(`echo run >>${counter}; ${summary(9, 0)}`, ['T-02', 'T-08']);
      const r = record('--batch', 'T-02,T-08');
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(readFileSync(counter, 'utf8')).toBe('run\n'); // one run, not one per task
      rmSync(counter);
      const [a, b] = [task('T-02').evidence, task('T-08').evidence];
      expect(a).toMatchObject({ passed: 9, failed: 0, total: 9, log_path: 'artifacts/batch-T-02_T-08/verify.log', batch: ['T-02', 'T-08'] });
      expect(b).toEqual(a);
      expect(a.log_sha256).toBe(sha(join(root, a.log_path)));
      expect([task('T-02').status, task('T-08').status]).toEqual(['verified_auto', 'verified_auto']);
      git('add', '-A');
      git('commit', '-q', '-m', 'batch\n\nTask: T-08\nReq: N/A');
      expect(spawnSync('node', [CHECK_SPEC], { cwd: root, encoding: 'utf8' })).toMatchObject({ status: 0 });
    });

    it('refuses tasks whose verify differ, and an unknown task; writes nothing', () => {
      batchVerify(summary(1, 0), ['T-08']);
      batchVerify(summary(2, 0), ['T-02']);
      const before = readFileSync(join(root, 'spec/TASKS.json'), 'utf8');
      expect(record('--batch', 'T-02,T-08')).toMatchObject({ status: 3, stderr: expect.stringContaining('the tasks of a batch must share one verify') });
      expect(record('--batch', 'T-08,T-99')).toMatchObject({ status: 3, stderr: expect.stringContaining('T-99 does not exist') });
      expect(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).toBe(before);
    });

    it('--keep-status (the close of a batch branch, DEC-033): a pass keeps each status; a failure leaves them implemented (T-65)', () => {
      edit((ts) => { for (const id of ['T-02', 'T-08']) Object.assign(ts.find((t) => t.id === id), { status: 'reviewed' }); });
      batchVerify(summary(3, 0), ['T-02', 'T-08']);
      expect(record('--batch', 'T-02,T-08', '--keep-status').status).toBe(0);
      expect([task('T-02').status, task('T-08').status]).toEqual(['reviewed', 'reviewed']);
      expect(task('T-02').evidence).toMatchObject({ passed: 3, batch: ['T-02', 'T-08'] });
      batchVerify(summary(2, 1), ['T-02', 'T-08']);
      expect(record('--batch', 'T-02,T-08', '--keep-status').status).toBe(2);
      expect([task('T-02').status, task('T-08').status]).toEqual(['implemented', 'implemented']);
    });

    it('a failing suite leaves every task of the batch implemented, exit 2', () => {
      batchVerify(summary(8, 1), ['T-02', 'T-08']);
      expect(record('--batch', 'T-02,T-08').status).toBe(2);
      expect([task('T-02').status, task('T-08').status]).toEqual(['implemented', 'implemented']);
    });
  });

  it('imports only the standard library (DEC-017)', () => {
    const imports = [...readFileSync(SCRIPT, 'utf8').matchAll(/^(?:import|from) ([a-z_.]+)/gm)].map((m) => m[1].split('.')[0]);
    for (const m of imports) expect(['argparse', 'datetime', 'hashlib', 'json', 'os', 're', 'subprocess', 'sys', 'tempfile', 'pathlib']).toContain(m);
  });
});

describe('check:spec on done evidence (DEC-014)', () => {
  const check = () => { const r = spawnSync('node', [CHECK_SPEC, '--root', root], { encoding: 'utf8' }); return { status: r.status, stdout: r.stdout + r.stderr, stderr: '' }; };
  it('a done task needs a log that exists and matches its sha256', () => {
    activeVerify(summary(5, 0));
    record();
    edit((ts) => { ts.find((t) => t.id === 'T-08').status = 'done'; });
    git('add', '-A');
    git('commit', '-q', '-m', 'x\n\nTask: T-08\nReq: N/A');
    expect(check().status).toBe(0);
    writeFileSync(join(root, 'artifacts/T-08/verify.log'), 'ℹ tests 57\nℹ pass 57\nℹ fail 0\n');
    expect(check().stdout).toContain('T-08: is "done" but evidence.log_sha256 does not match artifacts/T-08/verify.log');
    rmSync(join(root, 'artifacts'), { recursive: true });
    expect(check().stdout).toContain('T-08: is "done" but its evidence log artifacts/T-08/verify.log does not exist');
    edit((ts) => { delete ts.find((t) => t.id === 'T-08').evidence.log_path; });
    expect(check().stdout).toContain('T-08: is "done" without evidence.log_path');
  });

  it('accepts blocked_by evidence_mismatch', () => {
    edit((ts) => Object.assign(ts.find((t) => t.id === 'T-04'), { status: 'blocked', blocked_by: 'evidence_mismatch' }));
    expect(check().stdout + check().stderr).not.toContain('T-04');
  });
});

describe('access_guard: only record_evidence.py writes spec/TASKS.json and artifacts/', () => {
  const ctx = () => ({ root, home: join(root, '..', 'no-home'), env: {} });
  const MESSAGE = 'TASKS.json y artifacts/ solo los escribe record_evidence.py';
  for (const [tool, args] of [
    ['Edit', { file_path: 'spec/TASKS.json' }], ['Write', { file_path: 'spec/TASKS.json' }], ['Write', { file_path: 'artifacts/T-08/verify.log' }],
    ['Bash', { command: "sed -i 's/implemented/done/' spec/TASKS.json" }], ['Bash', { command: 'echo {} > spec/TASKS.json' }],
    ['Bash', { command: 'rm -rf artifacts/T-08' }], ['Bash', { command: "node -e \"require('fs').writeFileSync('spec/TASKS.json','')\"" }],
  ]) {
    it(`denies ${tool} ${JSON.stringify(args)}`, () => {
      expect(accessGuard(tool, args, ctx())).toMatchObject({ decision: 'deny', reason: expect.stringContaining(MESSAGE) });
    });
  }
  it('still allows reading them', () => {
    expect(accessGuard('Read', { file_path: 'spec/TASKS.json' }, ctx()).decision).toBe('allow');
    expect(accessGuard('Bash', { command: 'cat spec/TASKS.json' }, ctx()).decision).toBe('allow');
    expect(accessGuard('Bash', { command: 'jq .tasks spec/TASKS.json' }, ctx()).decision).toBe('allow');
  });
});

describe('the Stop hook (Claude Code adapter of record_evidence)', () => {
  const stopHook = (scriptPath) => {
    const profile = join(root, 'profile.sh');
    writeFileSync(profile, [
      'PROFILE_ROLE=implementer', 'PROFILE_READ=("*")', 'PROFILE_WRITE=("*")', 'PROFILE_COMMANDS=()', 'PROFILE_DENIED_COMMANDS=()',
      'PROFILE_DENY=(.autopilot/)', 'PROFILE_AGENT_ALLOWED=()', 'PROFILE_AGENT_DENIED=()', 'PROFILE_WEB=0', 'PROFILE_SUBAGENTS=0',
      `PROFILE_RESULT_DIR=${root}/result`, 'PROFILE_MAX_USD=', 'PROFILE_MODEL=', `PROFILE_CHARTER=${root}/c.md`, `PROFILE_ROOT=${root}`,
      'PROFILE_TASK=T-08', `PROFILE_EVIDENCE_SCRIPT=${scriptPath}`, ''].join('\n'));
    const cmd = spawnSync('bash', ['-c', `. ${join(REPO, 'scripts/agents/claude.sh')}; agent_claude_command ${profile}`], { encoding: 'utf8' }).stdout;
    const words = spawnSync('bash', ['-c', `for w in ${cmd}; do printf '%s\\0' "$w"; done`], { encoding: 'utf8' }).stdout.split('\0');
    return JSON.parse(words[words.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0];
  };

  it('the implementer runs with a Stop hook that calls record_evidence.py --report-only for its task', () => {
    const hook = stopHook(SCRIPT);
    expect(hook.command).toContain('record_evidence.py');
    expect(hook.command).toContain('--task T-08 --report-only --log-dir');
    expect(hook.command).toContain('exit 2');
    expect(hook.timeout >= 1800).toBe(true);
  });

  it('blocks the close (exit 2, with the log path) when verify fails, and when the hook itself is down', () => {
    activeVerify(summary(1, 1));
    mkdirSync(join(root, 'result'));
    const run = (hook) => spawnSync('bash', ['-c', hook.command], { input: '{"hook_event_name":"Stop"}', encoding: 'utf8', cwd: root });
    const failing = run(stopHook(SCRIPT));
    expect(failing.status).toBe(2);
    expect(failing.stderr).toContain(join(root, 'result/verify.log'));
    const down = run(stopHook(join(root, 'missing/record_evidence.py')));
    expect(down.status).toBe(2);
    expect(down.stderr).toContain('the close is blocked');
    activeVerify(summary(2, 0));
    expect(run(stopHook(SCRIPT)).status).toBe(0);
  });
});

describe('verify and verify_integration (DEC-019)', () => {
  const check = () => { const r = spawnSync('node', [CHECK_SPEC, '--root', root], { encoding: 'utf8' }); return r.stdout + r.stderr; };
  it('check:spec: verify must be a local command; what counts as integration is the project\'s pattern', () => {
    edit((ts) => { ts.find((t) => t.id === 'T-04').verify = 'npm test (casos nuevos: vacío)'; });
    expect(check()).toContain('T-04: verify is not a command bash can read (prose?)');
    // sdd-base knows no provider: without the project's AUTOPILOT_INTEGRATION_PATTERN nothing counts as integration
    edit((ts) => { ts.find((t) => t.id === 'T-04').verify = 'npm test && npm run test:acceptance'; });
    expect(check()).not.toContain('T-04');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts/autopilot.config.sh'), "# the project's own\nAUTOPILOT_INTEGRATION_PATTERN='npm run test:acceptance|deploy'\n");
    expect(check()).toContain('T-04: verify matches the project\'s integration pattern (AUTOPILOT_INTEGRATION_PATTERN); move that part to verify_integration (DEC-019)');
    edit((ts) => Object.assign(ts.find((t) => t.id === 'T-04'), { verify: 'npm test', verify_integration: 'npm run test:acceptance (contra dev)' }));
    expect(check()).toContain('T-04: verify_integration is not a command bash can read');
    edit((ts) => Object.assign(ts.find((t) => t.id === 'T-04'), { verify: 'npm test', verify_integration: 'npm run deploy && npm run test:acceptance' }));
    expect(check()).not.toContain('T-04');
  });

  it('record_evidence.py runs verify_integration only with --integration --approved-by, into evidence.integration', () => {
    activeVerify(summary(3, 0));
    edit((ts) => { ts.find((t) => t.id === 'T-08').verify_integration = `touch integration-ran && ${summary(7, 0)}`; });
    record();
    expect(existsSync(join(root, 'integration-ran'))).toBe(false);
    expect(record('--task', 'T-08', '--integration')).toMatchObject({ status: 3, stderr: expect.stringContaining('--approved-by') });
    const r = record('--task', 'T-08', '--integration', '--approved-by', 'Pepe');
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'integration-ran'))).toBe(true);
    expect(task('T-08')).toMatchObject({ status: 'verified_auto', evidence: { passed: 3, integration: { passed: 7, approved_by: 'Pepe', log_path: 'artifacts/T-08/integration.log' } } });
    edit((ts) => { ts.find((t) => t.id === 'T-08').evidence.unverified = { reason: 'sin verify local' }; });
    record('--task', 'T-08', '--integration', '--approved-by', 'Pepe');
    expect(task('T-08').evidence.unverified).toBe(undefined);
  });

  it('a coincide verdict removes the unverified mark', () => {
    edit((ts) => { ts.find((t) => t.id === 'T-02').evidence = { command: 'x', result: 'y', commit: 'z', unverified: { reason: 'prosa' } }; });
    record('--mark', 'T-02', '--verdict', 'coincide', '--report', 'r.md');
    expect(task('T-02').evidence.unverified).toBe(undefined);
  });
});

describe('evidence at the first self-consistent commit (DEC-020)', () => {
  it('--at runs verify in that commit and records it in verified_at_commit; the task leaves blocked', () => {
    // T-02's own commit fails its verify; the next commit fixes it
    edit((ts) => Object.assign(ts.find((t) => t.id === 'T-02'), { verify: 'test -e fixed && ' + summary(4, 0), status: 'blocked', blocked_by: 'evidence_mismatch', evidence: { command: 'x', result: 'y', commit: 'aaaaaaa' } }));
    git('add', '-A');
    git('commit', '-q', '-m', 'task commit\n\nTask: none\nReq: none');
    writeFileSync(join(root, 'fixed'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'fix\n\nTask: none\nReq: none');
    const fixAt = git('rev-parse', 'HEAD').trim();
    rmSync(join(root, 'fixed'));   // not in the working tree: only the commit has it
    const r = record('--task', 'T-02', '--at', fixAt);
    expect(r.status).toBe(0);
    expect(task('T-02')).toMatchObject({ status: 'verified_auto', blocked_by: null, evidence: { commit: 'aaaaaaa', verified_at_commit: fixAt, passed: 4, log_path: 'artifacts/T-02/verify.log' } });
    expect(existsSync(join(root, 'artifacts/T-02/verify.log'))).toBe(true);
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('pasa_comando_nuevo is a verdict of its own and does not mark unverified', () => {
    edit((ts) => { ts.find((t) => t.id === 'T-02').evidence = { command: 'x', result: 'y', commit: 'z', unverified: { reason: 'prosa' } }; });
    expect(record('--mark', 'T-02', '--verdict', 'pasa_comando_nuevo', '--report', 'r.md').status).toBe(0);
    expect(task('T-02').evidence.reverification.verdict).toBe('pasa_comando_nuevo');
    expect(task('T-02').evidence.unverified).toBe(undefined);
  });
});
