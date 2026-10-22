import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { classifyTest } from '../lib/instrument.mjs';

// Instrumentation per task (DEC-026, T-58): scripts/lib/instrument.mjs keeps one record per implementer attempt and per
// review, and flushes them into evidence/<ID>.json.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts/lib/instrument.mjs');
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'instrument-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'base']);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args) => spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

describe('instrument (DEC-026, T-58)', () => {
  it('classifies test commands: the verify, npm test and node --test without a pattern or file are the suite; the rest are task runs', () => {
    const verify = 'npm test && npm run check:spec';
    expect(classifyTest('npm test', verify)).toBe('suite');
    expect(classifyTest('npm test 2>&1 | tail -n 12', verify)).toBe('suite');
    expect(classifyTest('node --test "scripts/test/*.test.mjs"', verify)).toBe('suite');
    expect(classifyTest('npm test && npm run check:spec', verify)).toBe('suite');
    expect(classifyTest('node --test --test-name-pattern=T-58 scripts/test/instrument.test.mjs', verify)).toBe('task');
    expect(classifyTest('node --test scripts/test/instrument.test.mjs', verify)).toBe('task');
    expect(classifyTest('npx vitest run tests/acceptance/T-04.test.ts', verify)).toBe('task');
    expect(classifyTest('git status', verify)).toBe(null);
    expect(classifyTest('cat package.json', verify)).toBe(null);
  });

  it('record: tokens, minutes, test runs (agent, hook, orchestrator), gates, exit codes and tree_sha; flush: evidence/<ID>.json', () => {
    const stream = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node --test --test-name-pattern=T-09 x.test.mjs' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', name: 'Read', input: { file_path: 'a' } }] } },
      { type: 'result', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } },
    ];
    writeFileSync(join(dir, 's.jsonl'), stream.map((e) => JSON.stringify(e)).join('\n'));
    writeFileSync(join(dir, 'f.json'), JSON.stringify(stream[2]));
    writeFileSync(join(dir, 'g.jsonl'), '{"name":"scope","result":"ok"}\n{"name":"evidence","result":"ok"}\n');
    writeFileSync(join(dir, 'hook.json'), JSON.stringify({ exit_code: 0 }));
    const started = String(Math.floor(Date.now() / 1000) - 120);
    const r = run('record', '--out', join(dir, 'run/T-09.jsonl'), '--task', 'T-09', '--run', 'R1', '--role', 'implementer', '--attempt', '1',
      '--started', started, '--final', join(dir, 'f.json'), '--stream', join(dir, 's.jsonl'), '--gates', join(dir, 'g.jsonl'), '--exit', '0',
      '--verify', 'npm test && npm run check:spec', '--hook-report', join(dir, 'hook.json'), '--close-exit', '0', '--orchestrator-task', '2', '--orchestrator-suite', '1');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(join(dir, 'evidence/T-09.json'), JSON.stringify({ task: 'T-09', records: [{ run: 'R0', role: 'reviewer' }] }));
    expect(run('flush', '--from', join(dir, 'run'), '--to', join(dir, 'evidence')).status).toBe(0);
    const ev = JSON.parse(readFileSync(join(dir, 'evidence/T-09.json'), 'utf8'));
    expect(ev.records.length).toBe(2); // appended to what was there
    const rec = ev.records[1];
    expect(rec).toMatchObject({
      run: 'R1', role: 'implementer', attempt: 1, exit_code: 0,
      tokens: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
      test_runs: { task: 3, suite: 3, agent: { task: 1, suite: 1 }, hook: { task: 0, suite: 1 }, orchestrator: { task: 2, suite: 1 } },
      gates: [{ name: 'scope', result: 'ok' }, { name: 'evidence', result: 'ok' }],
      verify_exit_codes: { hook: 0, close: 0 },
    });
    expect(rec.minutes >= 2 && rec.minutes < 3).toBe(true);
    expect(rec.tree_sha).toBe(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim());
    expect(ev.totals).toMatchObject({ records: 2, test_runs: { task: 3, suite: 3 }, tokens: { input: 10, output: 20 } });
  });

  it('a record without a final event or stream still keeps what is known (an agent that died)', () => {
    const r = run('record', '--out', join(dir, 'run/T-09.jsonl'), '--task', 'T-09', '--run', 'R1', '--role', 'reviewer', '--attempt', '1',
      '--started', String(Math.floor(Date.now() / 1000)), '--final', join(dir, 'none.json'), '--stream', join(dir, 'none.jsonl'), '--exit', '124');
    expect(r.status).toBe(0);
    run('flush', '--from', join(dir, 'run'), '--to', join(dir, 'evidence'));
    expect(JSON.parse(readFileSync(join(dir, 'evidence/T-09.json'), 'utf8')).records[0]).toMatchObject({ role: 'reviewer', exit_code: 124, tokens: null, gates: [] });
  });
});
