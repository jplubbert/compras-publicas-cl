import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { analyzeRun, classify, fingerprint, guardToken, normalize, readMemory, recordCase, recordRun } from '../lib/fingerprint.mjs';

// Failure fingerprint and case memory (T-108, DEC-051 level L0). The fixtures are the runs of 2026-10-22 as spec/LOG.md
// tells them (the run directories themselves are not in git).
const SCRIPT = fileURLToPath(new URL('../lib/fingerprint.mjs', import.meta.url));

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fingerprint-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (name, result, { live = '', audit = {}, decisions = [] } = {}) => {
  const d = join(dir, name);
  mkdirSync(join(d, 'decisions'), { recursive: true });
  writeFileSync(join(d, 'result.json'), JSON.stringify({ run_id: name, status: 'ok', exit_code: 0, failed: [], ...result }));
  writeFileSync(join(d, 'live.log'), live);
  for (const [f, text] of Object.entries(audit)) writeFileSync(join(d, f), text);
  decisions.forEach((r, i) => writeFileSync(join(d, 'decisions', `${i}.json`), JSON.stringify(r)));
  return d;
};

// 2026-10-22_003744: the implementer of T-84 ran `ls .autopilot/<run>/`; the audit stopped the run
const breach = (runId, task, attempt, at) => ({
  result: {
    status: 'ok', exit_code: 1, failed: [task],
    stop_reason: `the implementer's session on ${task} accessed the context of another agent (.autopilot/ or the agent's private data; see .autopilot/${runId}/${task}-impl-${attempt}-audit.txt); nothing is integrated or applied`,
  },
  live: `${at} autopilot: start at cb94f4c (branch autopilot/lote); budget 7200s\n${at} autopilot: stop: the implementer's session on ${task} accessed the context of another agent (see /home/pepe/Projects/sdd-base/.autopilot/${runId}/${task}-impl-${attempt}-audit.txt)\n`,
  audit: { [`${task}-impl-${attempt}-audit.txt`]: `Bash: .autopilot/${runId}/\n` },
});

describe('T-108: normalized fingerprint', () => {
  it('T-108: masks paths, UUIDs, run ids, timestamps, durations, line numbers and task ids', () => {
    expect(normalize('T-84 at 2026-10-22T09:42:01Z in /home/pepe/x/y.mjs:120:7 run 2026-10-22_093407 took 1200s, session 0b8e6f2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b, line 42'))
      .toBe('<id> at <time> in <path>:<n> run <run> took <duration>, session <uuid>, line <n>');
  });

  it('T-108: two equal failures with different paths, ids and times give the same fingerprint', () => {
    const one = breach('2026-10-22_003744', 'T-84', 2, '00:47:12');
    const two = breach('2026-10-23_101500', 'T-97', 1, '10:31:55');
    const x = analyzeRun(run('2026-10-22_003744', one.result, one));
    const y = analyzeRun(run('2026-10-23_101500', two.result, two));
    expect(fingerprint(x.input)).toBe(fingerprint(y.input));
    expect(x.task).toBe('T-84');
    expect(y.task).toBe('T-97');
  });

  it('T-108: another stop_reason gives another fingerprint', () => {
    const base = { role: 'implementer', stop_reason: 'the implementer on T-03 hit its usage limit (DEC-024); not retried', error: '', guard: '' };
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, stop_reason: 'the implementer on T-03 ended with an API error (DEC-024); not retried' }));
    expect(fingerprint(base)).toBe(fingerprint({ ...base, stop_reason: base.stop_reason.replace('T-03', 'T-55') }));
  });
});

describe('T-108: classification by layers', () => {
  it('T-108: layer 1, enums of result.json: status, exit codes 124/137/143 and a decider escalation', () => {
    expect(classify({ status: 'usage_limited', exit_code: 1 })).toBe('usage_limited');
    expect(classify({ status: 'error', exit_code: 124 })).toBe('killed_timeout');
    expect(classify({ status: 'error', exit_code: 137 })).toBe('killed_sigkill');
    expect(classify({ status: 'error', exit_code: 143 })).toBe('killed_sigterm');
    // 2026-10-22_093407: the review of T-84 without a verdict (Jev, confidence 0.46 < 0.8), blocked by Q-06
    const d = run('2026-10-22_093407', { exit_code: 1, review_blocked: ['T-84'], stop_reason: 'task budget reached (1)' }, {
      decisions: [{ question: { id: 'review_verdict' }, action: 'escalate', confidence: 0.46, reason: 'confidence 0.46 < 0.8 (threshold)' }],
    });
    const { input, facts } = analyzeRun(d);
    expect(input.guard).toBe('decide:review_verdict');
    expect(classify(facts)).toBe('decider_escalation');
  });

  it('T-108: layer 2, environment: a clock gap (T-98) and a busy child at an inactivity cut (T-106)', () => {
    // compras-publicas-cl 2026-10-22_010033: the machine slept and the inactivity cut ended the run
    const slept = run('2026-10-22_010033', { status: 'stalled', exit_code: 143, stop_reason: 'an agent had no activity for 1200s: interrupted (DEC-024)' }, {
      live: '01:12:40 autopilot: clock gap: no heartbeat for 2410s (the machine was suspended?): the inactivity deadline restarts (T-98)\n',
    });
    expect(classify(analyzeRun(slept).facts)).toBe('suspended');
    const busy = run('2026-10-22_150000', { status: 'stalled', exit_code: 143, stop_reason: "an agent's stream was quiet for 3600s, even with its processes active: interrupted (T-106)" }, {
      live: '15:20:00 autopilot: quiet stream, agent processes active: 4242 (node): the inactivity deadline extends, up to 3600s without the stream moving (T-106)\n',
    });
    expect(classify(analyzeRun(busy).facts)).toBe('stalled_busy_child');
  });

  it('T-108: layer 3, guard messages: the guard and the kind of its token', () => {
    const one = breach('2026-10-22_003744', 'T-84', 2, '00:47:12');
    mkdirSync(join(dir, '.autopilot/2026-10-22_003744'), { recursive: true });
    const x = analyzeRun(run('2026-10-22_003744', one.result, one), dir);
    expect(x.input).toMatchObject({ role: 'implementer', guard: 'session_audit' });
    expect(classify(x.facts)).toBe('session_audit/existing_path');
    // compras-publicas-cl: the guard took the agent's own tool-results as a forbidden read (T-100)
    expect(guardToken('Read outside spec/, tests/acceptance/: /home/pepe/.claude/projects/p/3f1c/tool-results/b1.txt').kind).toBe('tool_results');
    expect(guardToken('access_guard (DEC-016): denied: .autopilot/ in git commit -m "T-97: deny .autopilot/ inside the worktree"').kind).toBe('commit_message');
    expect(guardToken('Bash: .autopilot/2026-10-22_000000/', dir).kind).toBe('other');
  });

  it('T-108: layer 4, repetition: a fingerprint the memory holds and no other rule matches; else unknown', () => {
    expect(classify({ status: 'ok', exit_code: 1 })).toBe('unknown');
    expect(classify({ status: 'ok', exit_code: 1, seen: true })).toBe('repeated');
  });
});

describe('T-108: case memory', () => {
  it('T-108: counts and dates each occurrence; the task is kept apart', () => {
    const memory = join(dir, 'fingerprints.jsonl');
    recordCase(memory, { fingerprint: 'f1', class: 'stalled', task: 'T-84', run: 'r1', at: '2026-10-22T00:47:00Z' });
    recordCase(memory, { fingerprint: 'f2', class: 'api_error', task: 'T-95', run: 'r1', at: '2026-10-22T00:48:00Z' });
    const e = recordCase(memory, { fingerprint: 'f1', class: 'stalled', task: 'T-97', run: 'r2', at: '2026-10-22T10:55:00Z' });
    expect(e).toMatchObject({ count: 2, first_seen: '2026-10-22T00:47:00Z', last_seen: '2026-10-22T10:55:00Z', task: 'T-97', runs: ['r1', 'r2'] });
    expect(readMemory(memory)).toHaveLength(2);
  });

  it('T-108: record adds fingerprint and failure_class to result.json; a healthy run is left as is', () => {
    const memory = join(dir, 'fingerprints.jsonl');
    const one = breach('2026-10-22_003744', 'T-84', 2, '00:47:12');
    const d = run('2026-10-22_003744', one.result, one);
    const r = spawnSync('node', [SCRIPT, 'record', d, '--memory', memory, '--root', dir], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ failure_class: 'session_audit/other', count: 1 });
    expect(JSON.parse(readFileSync(join(d, 'result.json'), 'utf8'))).toMatchObject({ fingerprint: out.fingerprint, failure_class: 'session_audit/other' });
    const ok = run('2026-10-22_104023', { stop_reason: 'task budget reached (1)' });
    expect(recordRun(ok, memory, { root: dir })).toEqual({});
    expect(JSON.parse(readFileSync(join(ok, 'result.json'), 'utf8')).fingerprint).toBe(undefined);
    expect(readMemory(memory)).toHaveLength(1);
  });
});
