import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';

// Fixtures: a copy of a fixed spec/ (scripts/test/fixtures/spec) in a temporary git repo, mutated by each case.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts/check-spec.mjs');
const HOOK = join(REPO, '.githooks/commit-msg');
const SPEC_FIXTURE = join(REPO, 'scripts/test/fixtures/spec');

let root;

const git = (...args) =>
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
  });

function check(...extra) {
  const r = spawnSync('node', [SCRIPT, '--root', root, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

function editTasks(fn) {
  const path = join(root, 'spec/TASKS.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  fn(data.tasks, data);
  writeFileSync(path, JSON.stringify(data, null, 2));
}
const task = (tasks, id) => tasks.find((t) => t.id === id);

function write(rel, content = 'x\n') {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function commit(message) {
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-spec-'));
  cpSync(SPEC_FIXTURE, join(root, 'spec'), { recursive: true });
  git('init', '-q');
  commit('Spec\n\nTask: none\nReq: none');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('state changes only through the scripts (DEC-028, T-60)', () => {
  const TASKS = join(REPO, 'scripts/lib/autopilot-tasks.mjs');
  const tasksCmd = (...args) => spawnSync('node', [TASKS, '--root', root, ...args], { encoding: 'utf8' });
  const since = () => { editTasks((ts, d) => { d.status_log_since = git('rev-parse', 'HEAD').trim(); }); commit('status_log_since\n\nTask: none\nReq: none'); };

  it('a commit that changes a status by hand fails; the same change through tasks set-status passes, with its entry', () => {
    since();
    editTasks((ts) => { task(ts, 'T-04').status = 'in_progress'; });
    commit('by hand\n\nTask: none\nReq: none');
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-04: status approved_for_impl → in_progress without a status_log entry (DEC-028') });
    git('reset', '-q', '--hard', 'HEAD~1');
    const r = tasksCmd('set-status', 'T-04', 'in_progress', '--by', 'Claude (sesión)', '--reason', 'empieza la tarea');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const t = JSON.parse(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).tasks.find((x) => x.id === 'T-04');
    expect(t.status_log.at(-1)).toMatchObject({ from: 'approved_for_impl', to: 'in_progress', by: 'Claude (sesión)', reason: 'empieza la tarea' });
    commit('via the script\n\nTask: none\nReq: none');
    expect(check()).toMatchObject({ code: 0 });
  });

  it('T-103: accepts the user review of set-user-review; rejects it in a commit with an autopilot trailer', () => {
    since();
    expect(tasksCmd('set-user-review', 'T-02', '--by', 'Pepe', '--reason', 'la apruebo').status).toBe(0);
    commit('T-02: user review\n\nTask: none\nReq: none');
    expect(check()).toMatchObject({ code: 0 });
    git('reset', '-q', '--hard', 'HEAD~1');
    expect(tasksCmd('set-user-review', 'T-02', '--by', 'Pepe', '--reason', 'la apruebo').status).toBe(0);
    commit('T-02: review\n\nTask: none\nReq: none\nCo-Authored-By: autopilot <noreply@local>');
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-02: a user review (decider "user") in a commit with an autopilot trailer') });
  });

  it('T-103: a user review must name a person as reviewer and decision.by, approved', () => {
    expect(tasksCmd('set-user-review', 'T-02', '--by', 'Pepe', '--reason', 'ok').status).toBe(0);
    editTasks((ts) => { task(ts, 'T-02').review.decision.by = 'autopilot'; });
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-02: review.decision.by must name the person who reviewed it') });
    editTasks((ts) => { Object.assign(task(ts, 'T-02').review, { decision: { decider: 'user', by: 'Pepe' }, reviewer: 'Otro', verdict: 'rejected' }); });
    const r = check();
    expect(r.out).toContain('review.reviewer must be the user who reviewed it (Pepe)');
    expect(r.out).toContain('a user review (set-user-review) is approved');
  });

  it('the commit-msg hook checks the staged change too', () => {
    since();
    editTasks((ts) => { task(ts, 'T-04').status = 'blocked'; task(ts, 'T-04').blocked_by = 'Q-01'; });
    git('add', '-A');
    const c = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=' + join(REPO, '.githooks'), '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'x\n\nTask: none\nReq: none'], { encoding: 'utf8' });
    expect(c.status).not.toBe(0);
    expect(c.stderr).toContain('without a status_log entry');
  });

  it('set-status never writes verified_auto, implemented, reviewed or done; accepted, approved_for_impl and delivered only by a person', () => {
    for (const st of ['verified_auto', 'implemented', 'reviewed', 'done']) {
      expect(tasksCmd('set-status', 'T-04', st, '--by', 'Pepe', '--reason', 'x')).toMatchObject({ status: 1, stderr: expect.stringContaining('comes from the evidence or the review') });
    }
    expect(tasksCmd('set-status', 'T-02', 'accepted', '--by', 'autopilot', '--reason', 'x')).toMatchObject({ status: 1, stderr: expect.stringContaining('only a person') });
    expect(tasksCmd('set-status', 'T-02', 'accepted', '--by', 'José Pedro Lübbert (Pepe)', '--reason', 'aceptación en lote').status).toBe(0);
    expect(tasksCmd('set-status', 'T-04', 'blocked', '--by', 'Claude (sesión)', '--reason', 'x')).toMatchObject({ status: 1, stderr: expect.stringContaining('--blocked-by') });
    expect(tasksCmd('set-status', 'T-04', 'in_progress', '--reason', 'x')).toMatchObject({ status: 1, stderr: expect.stringContaining('--by') });
  });

  it('without status_log_since the rule does not run (projects that have not adopted it); status_log must be well formed', () => {
    editTasks((ts) => { task(ts, 'T-04').status = 'in_progress'; });
    commit('by hand\n\nTask: none\nReq: none');
    expect(check()).toMatchObject({ code: 0 });
    editTasks((ts) => { task(ts, 'T-04').status_log = [{ to: 'x' }]; });
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('status_log must be a list of {from, to, by, at}') });
  });
});

describe('an agent sets only in_progress and blocked; the user keeps the rest of DEC-028 (DEC-032, T-64)', () => {
  const TASKS = join(REPO, 'scripts/lib/autopilot-tasks.mjs');
  const tasksCmd = (...args) => spawnSync('node', [TASKS, '--root', root, ...args], { encoding: 'utf8' });
  it('set-status with an agent in --by accepts only in_progress and blocked; a person keeps specified, ready, superseded…', () => {
    for (const st of ['specified', 'ready', 'superseded', 'proposed']) {
      expect(tasksCmd('set-status', 'T-04', st, '--by', 'Claude (sesión)', '--reason', 'x')).toMatchObject({ status: 1, stderr: expect.stringContaining('an agent may only set in_progress or blocked (DEC-032)') });
    }
    expect(tasksCmd('set-status', 'T-04', 'in_progress', '--by', 'Claude (sesión)', '--reason', 'x').status).toBe(0);
    expect(tasksCmd('set-status', 'T-04', 'superseded', '--by', 'José Pedro Lübbert (Pepe)', '--reason', 'reemplazada').status).toBe(0);
  });
  it('check:spec rejects a status_log entry of an agent (not one of the scripts) towards another status', () => {
    editTasks((ts) => { task(ts, 'T-04').status_log = [{ from: 'approved_for_impl', to: 'ready', by: 'Claude (sesión)', at: '2026-10-21T00:00:00Z' }]; });
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('an agent may only set in_progress or blocked (DEC-032)') });
    editTasks((ts) => { task(ts, 'T-04').status_log = [
      { from: 'approved_for_impl', to: 'in_progress', by: 'Claude (sesión)', at: '2026-10-21T00:00:00Z' },
      { from: 'in_progress', to: 'verified_auto', by: 'record_evidence.py', at: '2026-10-21T00:00:00Z' },
      { from: 'verified_auto', to: 'reviewed', by: 'set-review', at: '2026-10-21T00:00:00Z' },
      { from: 'specified', to: 'approved_for_impl', by: 'autopilot (DEC-022)', at: '2026-10-21T00:00:00Z' },
      { from: 'reviewed', to: 'accepted', by: 'José Pedro Lübbert (Pepe)', at: '2026-10-21T00:00:00Z' }]; });
    expect(check()).toMatchObject({ code: 0 });
  });
});

describe('check:spec', () => {
  it('passes with the test spec', () => {
    expect(check()).toMatchObject({ code: 0 });
  });

  it('passes on the real repository (including its history)', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toContain('check:spec: ok');
  });

  it('fails if TASKS.json is not valid JSON', () => {
    write('spec/TASKS.json', '{ "tasks": [');
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('not valid JSON') });
  });

  it('fails with done without complete evidence', () => {
    editTasks((ts) => Object.assign(task(ts, 'T-02'), { status: 'done', evidence: { command: 'npm test' } }));
    const r = check();
    expect(r.code).toBe(1);
    expect(r.out).toContain('T-02: is "done" without evidence.result');
    expect(r.out).toContain('T-02: is "done" without evidence.commit');
    expect(r.out).not.toContain('without evidence.command');
  });

  // A done task's evidence points to the raw log record_evidence.py keeps, with its sha256 (DEC-014).
  const doneEvidence = (id) => {
    mkdirSync(join(root, 'artifacts', id), { recursive: true });
    writeFileSync(join(root, 'artifacts', id, 'verify.log'), 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n');
    return { command: 'npm test', result: 'ok', commit: 'abc1234', log_path: `artifacts/${id}/verify.log`,
      log_sha256: createHash('sha256').update(readFileSync(join(root, 'artifacts', id, 'verify.log'))).digest('hex') };
  };

  it('passes with done and complete evidence', () => {
    editTasks((ts) => Object.assign(task(ts, 'T-02'), { status: 'done', evidence: doneEvidence('T-02') }));
    expect(check()).toMatchObject({ code: 0 });
  });

  describe('every evidence points to its log with the sha256, in any status (T-41, DEC-014)', () => {
    const legacy = (ids) => { const f = join(root, 'spec/TASKS.json'); const d = JSON.parse(readFileSync(f, 'utf8')); d.evidence_legacy = ids; writeFileSync(f, JSON.stringify(d, null, 2)); };

    it('hand-written evidence fails in verified_auto, reviewed or accepted too', () => {
      for (const status of ['verified_auto', 'reviewed', 'accepted', 'implemented']) {
        editTasks((ts) => Object.assign(task(ts, 'T-04'), { status, evidence: { command: 'npm test', result: '25 pasan', commit: 'abc1234' } }));
        expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-04: evidence without log_path') });
      }
      editTasks((ts) => Object.assign(task(ts, 'T-04'), { status: 'verified_auto', evidence: doneEvidence('T-04') }));
      expect(check()).toMatchObject({ code: 0 });
      writeFileSync(join(root, 'artifacts/T-04/verify.log'), 'ℹ tests 57\nℹ pass 57\nℹ fail 0\n'); // altered after the fact
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-04: evidence.log_sha256 does not match artifacts/T-04/verify.log') });
    });

    it('the explicit "evidence_legacy" list exempts tasks recorded before DEC-014; it must name existing tasks', () => {
      expect(check()).toMatchObject({ code: 0 }); // the fixture's T-02 is listed
      legacy([]);
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-02: evidence without log_path') });
      legacy(['T-02', 'T-99']);
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('evidence_legacy names T-99, which is not a task') });
      legacy('T-02');
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('evidence_legacy must be an array of task ids') });
      legacy(['T-02']);
      editTasks((ts) => Object.assign(task(ts, 'T-02'), { status: 'done' })); // done still needs its log
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-02: is "done" without evidence.log_path') });
    });

    it('evidence.integration needs its log and sha256 as well; an evidence with only a reverification mark is not checked', () => {
      const ev = doneEvidence('T-04');
      editTasks((ts) => Object.assign(task(ts, 'T-04'), { status: 'verified_auto', evidence: { ...ev, integration: { command: 'x', result: 'ok', commit: 'abc1234' } } }));
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-04: evidence.integration without log_path') });
      editTasks((ts) => Object.assign(task(ts, 'T-04'), { evidence: { reverification: { verdict: 'skipped_cost' } } }));
      expect(check()).toMatchObject({ code: 0 });
    });
  });

  it('fails with blocked without blocked_by', () => {
    editTasks((ts) => Object.assign(task(ts, 'T-04'), { status: 'blocked', blocked_by: null }));
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-04: is "blocked" without blocked_by') });
  });

  it('fails with blocked whose reference is not in reqs/decisions/depends_on', () => {
    editTasks((ts) => Object.assign(task(ts, 'T-04'), { status: 'blocked', blocked_by: 'DEC-004' }));
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('blocked_by DEC-004 is not in') });
  });

  it('fails with blocked by a missing Q-', () => {
    editTasks((ts) => Object.assign(task(ts, 'T-04'), { status: 'blocked', blocked_by: 'Q-99' }));
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('Q-99 does not exist') });
  });

  for (const ref of ['DEC-005', 'T-03', 'REQ-002', 'Q-02']) {
    it(`passes with blocked referencing ${ref}`, () => {
      editTasks((ts) => Object.assign(task(ts, 'T-04'), { status: 'blocked', blocked_by: ref }));
      expect(check()).toMatchObject({ code: 0 });
    });
  }

  it('fails with an extra file in spec/; spec/contracts/ accepts any contract', () => {
    write('spec/research.md');
    write('spec/notes/idea.md');
    write('spec/contracts/schema.graphql');
    write('spec/contracts/openapi.yaml');
    const r = check();
    expect(r.code).toBe(1);
    expect(r.out).toContain('spec/research.md: file not allowed');
    expect(r.out).toContain('spec/notes/idea.md: file not allowed');
    expect(r.out).not.toContain('spec/contracts/');
  });

  it('fails with references to missing REQs, DECs or tasks', () => {
    editTasks((ts) => Object.assign(task(ts, 'T-04'), { reqs: ['REQ-999'], decisions: ['DEC-999'], depends_on: ['T-99'] }));
    const r = check();
    expect(r.out).toContain('REQ-999 does not exist');
    expect(r.out).toContain('DEC-999 does not exist');
    expect(r.out).toContain('depends on T-99');
  });

  it('rejects an unknown kind', () => {
    editTasks((ts) => Object.assign(task(ts, 'T-08'), { kind: 'ops' }));
    expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-08: unknown kind "ops"') });
  });

  describe('external_repos (DEC-021)', () => {
    it('accepts an approved external repository and rejects an entry without approval or with a relative path', () => {
      editTasks((ts) => { task(ts, 'T-04').external_repos = [{ path: '/home/x/other', approved_by: 'Pepe', date: '2026-10-20' }]; });
      expect(check()).toMatchObject({ code: 0 });
      editTasks((ts) => { task(ts, 'T-04').external_repos = [{ path: '../other', approved_by: '', date: 'hoy' }]; });
      const out = check().out;
      for (const e of ['external_repos[0].path must be an absolute path', 'external_repos[0].approved_by must name who approved it', 'external_repos[0].date must be YYYY-MM-DD']) {
        expect(out).toContain(`T-04: ${e}`);
      }
    });
  });

  describe('plan_review (DEC-010 point 7)', () => {
    const valid = (id = 'T-04') => ({
      critic: 'claude -p 2.1.295 (contexto limpio, autopilot)', verdict: 'APROBAR', effective: 'APROBAR', round: 1,
      plan: `plans/${id}.md`, plan_sha: 'a'.repeat(40), plan_commit: 'abc1234',
      findings: [{ id: 'riesgos:fragil', severity: 'P0', evidence_type: 'opinión', evidence: 'creo', summary: 's' }],
      opinion_blockers: ['riesgos:fragil'], date: '2026-10-20',
    });

    it('accepts a well-formed plan_review, and null; rejects it on a spec task', () => {
      editTasks((ts) => { task(ts, 'T-04').plan_review = valid(); task(ts, 'T-05').plan_review = null; });
      expect(check()).toMatchObject({ code: 0 });
      editTasks((ts) => { task(ts, 'T-03').plan_review = valid('T-03'); });
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-03: plan_review is not allowed on spec tasks') });
    });

    it('lists every malformed field', () => {
      editTasks((ts) => {
        task(ts, 'T-04').plan_review = { critic: '', verdict: 'OK', effective: 'si', round: 3, plan: 'plan.md', plan_sha: 'x', plan_commit: 'HEAD', findings: [{}], opinion_blockers: [1], date: 'hoy' };
      });
      const r = check();
      expect(r.code).toBe(1);
      for (const e of ['critic must be a non-empty string', 'verdict must be one of APROBAR, REVISAR, ESCALAR', 'effective must be one of',
        'round must be 1 or 2', 'plan must be plans/T-04.md', 'plan_sha must be the blob sha of the plan', 'plan_commit must be a commit sha',
        'findings must be an array of {id, severity, evidence_type, evidence, summary}', 'opinion_blockers must be an array of finding ids',
        'date must be YYYY-MM-DD']) expect(r.out).toContain(`T-04: plan_review.${e}`);
    });

    it('APROBAR is impossible with a P0/P1 backed by a source or a file line', () => {
      editTasks((ts) => {
        task(ts, 'T-04').plan_review = { ...valid(), findings: [{ id: 'a:b', severity: 'P1', evidence_type: 'fuente', evidence: 'https://x.org', summary: 's' }] };
      });
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-04: plan_review.effective cannot be APROBAR with a P0/P1 finding backed by a source or a file line') });
    });
  });

  describe('acceptance_review (DEC-004 point 3)', () => {
    const valid = () => ({
      reviewer: 'codex exec 1.0 (contexto limpio, autopilot)', verdict: 'approved', findings: [], notes: 'ok',
      commits: 'abc1234..def5678', date: '2026-10-18',
    });

    it('accepts a well-formed acceptance_review on a spec task, and null', () => {
      editTasks((ts) => { task(ts, 'T-03').acceptance_review = valid(); task(ts, 'T-04').acceptance_review = null; });
      expect(check()).toMatchObject({ code: 0 });
    });

    it('accepts it on a task with REQ (its tests come from the test-author, DEC-006); rejects it on a tooling task', () => {
      editTasks((ts) => { task(ts, 'T-04').acceptance_review = valid(); });
      expect(check()).toMatchObject({ code: 0 });
      editTasks((ts) => { task(ts, 'T-08').acceptance_review = valid(); });
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-08: acceptance_review is only allowed on spec tasks or on tasks with REQ (test-author, DEC-006)') });
    });

    it('lists every malformed field', () => {
      editTasks((ts) => {
        task(ts, 'T-03').acceptance_review = { reviewer: '', verdict: 'ok', findings: [1], notes: null, commits: 'HEAD', date: '18/10/2026' };
      });
      const r = check();
      expect(r.code).toBe(1);
      for (const e of ['reviewer must be a non-empty string', 'verdict must be approved or rejected, got "ok"',
        'findings must be an array of strings', 'notes must be a string', 'commits must be a range <sha>..<sha>',
        'date must be YYYY-MM-DD']) expect(r.out).toContain(`T-03: acceptance_review.${e}`);
    });

    it('rejects a value that is not an object', () => {
      editTasks((ts) => { task(ts, 'T-03').acceptance_review = 'approved'; });
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-03: acceptance_review must be an object or null') });
    });
  });

  describe('touches', () => {
    it('fails if an open task has no touches, or an empty list', () => {
      editTasks((ts) => {
        delete task(ts, 'T-04').touches;
        task(ts, 'T-05').touches = [];
      });
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('T-04: missing "touches"');
      expect(r.out).toContain('T-05: missing "touches"');
    });

    it('fails if touches is not an array', () => {
      editTasks((ts) => { task(ts, 'T-04').touches = 'app/'; });
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('T-04: "touches" must be an array') });
    });

    for (const [entry, why] of [
      ['../other/x.ts', 'must not contain ".."'],
      ['app/../spec/TASKS.json', 'must not contain ".."'],
      ['app/*.ts', 'must not contain wildcards'],
      ['app/**/', 'must not contain wildcards'],
      ['src/x?.ts', 'must not contain wildcards'],
      ['spec/', 'must not include spec/'],
      ['spec/TASKS.json', 'must not include spec/'],
      ['/abs/path', 'must be relative to the root'],
      ['', 'must be a non-empty string'],
      ['app//x.ts', 'must not contain empty or "." segments'],
      ['./app/', 'must not contain empty or "." segments'],
    ]) {
      it(`rejects touches entry ${JSON.stringify(entry)} (${why})`, () => {
        editTasks((ts) => { task(ts, 'T-04').touches = ['app/src/orders/', entry]; });
        const r = check();
        expect(r.code).toBe(1);
        expect(r.out).toContain(`T-04: touches ${JSON.stringify(entry)} ${why}`);
      });
    }

    it('does not validate the touches of a closed task: it is history (R-02)', () => {
      editTasks((ts) => { Object.assign(task(ts, 'T-02'), { status: 'accepted', touches: ['spec/contracts/schema.graphql'] }); });
      expect(check()).toMatchObject({ code: 0 });
      editTasks((ts) => { Object.assign(task(ts, 'T-02'), { status: 'in_progress' }); });
      expect(check().out).toContain('T-02: touches "spec/contracts/schema.graphql" must not include spec/');
    });

    it('accepts files, directories ending in / and names that only start with spec', () => {
      editTasks((ts) => { task(ts, 'T-04').touches = ['package.json', 'app/src/', 'specs/x.md', 'docs/spec/a.md']; });
      expect(check()).toMatchObject({ code: 0 });
    });

    for (const status of ['accepted', 'done', 'delivered', 'superseded']) {
      it(`does not require touches on a closed task (${status})`, () => {
        editTasks((ts) => {
          Object.assign(task(ts, 'T-02'), { status }, status === 'done' ? { evidence: doneEvidence('T-02') } : {});
          delete task(ts, 'T-02').touches;
        });
        expect(check()).toMatchObject({ code: 0 });
      });
    }
  });

  describe('history', () => {
    it('fails if an implementation task edits tests/acceptance/', () => {
      write('tests/acceptance/req_002.test.mjs');
      commit('Feature\n\nTask: T-04\nReq: REQ-002');
      expect(check()).toMatchObject({
        code: 1,
        out: expect.stringContaining('modifies tests/acceptance/ (tests/acceptance/req_002.test.mjs) with Task T-04'),
      });
    });

    it('fails if a commit with Task: none edits tests/acceptance/', () => {
      write('tests/acceptance/req_002.test.mjs');
      commit('Fix\n\nTask: none\nReq: none');
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('with Task none') });
    });

    it('passes if the spec task (T-03) edits tests/acceptance/', () => {
      write('tests/acceptance/req_002.test.mjs');
      commit('Acceptance\n\nTask: T-03\nReq: REQ-001, REQ-002, REQ-003, REQ-004');
      expect(check()).toMatchObject({ code: 0 });
    });

    it('passes if the test-author (Test-Author: autopilot) writes tests/acceptance/<ID>* of a task that is not a spec task', () => {
      write('tests/acceptance/T-04.test.mjs');
      write('tests/acceptance/T-04/helpers.mjs');
      commit('T-04: acceptance tests by the test-author (red)\n\nTask: T-04\nReq: REQ-002\nTest-Author: autopilot');
      expect(check()).toMatchObject({ code: 0 });
    });

    it('fails if a Test-Author commit touches anything but tests/acceptance/<ID>* (T-1 does not cover T-14)', () => {
      write('tests/acceptance/T-05.test.mjs');
      write('app/x.ts');
      commit('Tests\n\nTask: T-04\nReq: REQ-002\nTest-Author: autopilot');
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('a Test-Author commit may only touch tests/acceptance/T-04* (app/x.ts, tests/acceptance/T-05.test.mjs)') });
    });

    it('fails with commits without trailers or with missing Task/Req', () => {
      write('a.txt');
      commit('No trailers');
      write('b.txt');
      commit('Made up\n\nTask: T-99\nReq: REQ-999');
      const r = check();
      expect(r.out).toMatch(/missing the "Task:" trailer/);
      expect(r.out).toMatch(/missing the "Req:" trailer/);
      expect(r.out).toContain('Task T-99 does not exist');
      expect(r.out).toContain('Req REQ-999 does not exist');
    });

    it('accepts "Req: N/A" only in commits of tooling tasks (T-08)', () => {
      write('a.txt');
      commit('Orchestrator\n\nTask: T-08\nReq: N/A');
      expect(check()).toMatchObject({ code: 0 });
      write('b.txt');
      commit('Feature\n\nTask: T-04\nReq: N/A');
      write('c.txt');
      commit('Loose\n\nTask: none\nReq: n/a');
      const r = check();
      expect(r.code).toBe(1);
      expect(r.out.match(/"Req: N\/A" is only allowed for tasks with kind "tooling"/g)).toHaveLength(2);
    });

    describe('several tasks in Task: (T-90, DEC-049)', () => {
      it('accepts a list "Task: T-01, T-02" and several Task: lines (T-90, DEC-049)', () => {
        write('a.txt');
        commit('Shared\n\nTask: T-01, T-02\nReq: none');
        write('b.txt');
        commit('Shared\n\nTask: T-01\nTask: T-02\nReq: none');
        expect(check()).toMatchObject({ code: 0 });
      });

      it('rejects none inside a list (T-90, DEC-049)', () => {
        write('a.txt');
        commit('Mixed\n\nTask: T-01, none\nReq: none');
        expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('"Task: none" goes alone, not in a list (T-01, none)') });
      });

      it('rejects a task of the list that does not exist (T-90, DEC-049)', () => {
        write('a.txt');
        commit('Made up\n\nTask: T-01, T-99\nReq: none');
        const r = check();
        expect(r.code).toBe(1);
        expect(r.out).toContain('Task T-99 does not exist');
        expect(r.out).not.toContain('Task T-01 does not exist');
      });

      it('accepts "Req: N/A" only if every task of the list is tooling (T-90, DEC-049)', () => {
        editTasks((ts) => { task(ts, 'T-07').kind = 'tooling'; });
        commit('T-07 tooling\n\nTask: none\nReq: none');
        write('a.txt');
        commit('Orchestrator\n\nTask: T-07, T-08\nReq: N/A');
        expect(check()).toMatchObject({ code: 0 });
        write('b.txt');
        commit('Mixed\n\nTask: T-08, T-04\nReq: N/A');
        expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('"Req: N/A" is only allowed for tasks with kind "tooling"') });
      });

      it('tests/acceptance/ with a list needs every task to be a spec task (T-90, DEC-049)', () => {
        write('tests/acceptance/req_002.test.mjs');
        commit('Acceptance\n\nTask: T-03, T-04\nReq: REQ-002');
        expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('with Task T-04, which is not a spec task') });
      });

      it('the commit-msg hook accepts a list and rejects none inside it (T-90, DEC-049)', () => {
        git('config', 'core.hooksPath', join(REPO, '.githooks'));
        const tryCommit = (message) => {
          git('add', '-A');
          return spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message], { encoding: 'utf8' });
        };
        write('a.txt');
        expect(tryCommit('Shared\n\nTask: T-01, T-02\nReq: none').status).toBe(0);
        write('b.txt');
        const r = tryCommit('Mixed\n\nTask: T-01, none\nReq: none');
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('pending commit: "Task: none" goes alone');
      });
    });

    it('accepts Task/Req in a paragraph before Co-Authored-By', () => {
      write('a.txt');
      commit('Something\n\nTask: T-02\nReq: none\n\nCo-Authored-By: X <x@example.com>');
      expect(check()).toMatchObject({ code: 0 });
    });

    it('history_since excludes the commits before the protocol adoption, but not the later ones', () => {
      write('old.txt');
      commit('Previous history without trailers');
      const since = git('rev-parse', 'HEAD').trim();
      expect(check()).toMatchObject({ code: 1 });
      editTasks((_ts, data) => { data.history_since = since; });
      commit('Adoption\n\nTask: none\nReq: none');
      expect(check()).toMatchObject({ code: 0 });
      write('new.txt');
      commit('New without trailers');
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('missing the "Task:" trailer') });
    });

    it('an invalid or missing history_since is an error', () => {
      editTasks((_ts, data) => { data.history_since = 'HEAD~1'; });
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('history_since must be a git sha') });
      editTasks((_ts, data) => { data.history_since = 'deadbeef'; });
      expect(check()).toMatchObject({ code: 1, out: expect.stringContaining('history_since deadbeef is not a commit') });
    });
  });

  describe('commit-msg hook', () => {
    beforeEach(() => {
      git('config', 'core.hooksPath', join(REPO, '.githooks'));
    });

    const tryCommit = (message) => {
      git('add', '-A');
      return spawnSync(
        'git',
        ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message],
        { encoding: 'utf8' },
      );
    };

    it('is executable', () => {
      expect(spawnSync('test', ['-x', HOOK]).status).toBe(0);
    });

    it('rejects a commit without trailers', () => {
      write('a.txt');
      const r = tryCommit('No trailers');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('pending commit: missing the "Task:" trailer');
    });

    it('rejects an implementation task that edits tests/acceptance/', () => {
      write('tests/acceptance/req_003.test.mjs');
      const r = tryCommit('Feature\n\nTask: T-05\nReq: REQ-003');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('modifies tests/acceptance/');
    });

    it('accepts a commit with valid trailers', () => {
      write('a.txt');
      const r = tryCommit('Something\n\nTask: T-02\nReq: none');
      expect(r.status).toBe(0);
    });

    // T-45: the hook validates what the commit contains (the index), not the working tree.
    const commitOnly = (paths, message) => {
      git('add', '--', ...paths);
      return spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message], { encoding: 'utf8' });
    };
    const addTask = () => editTasks((ts) => ts.push({ ...task(ts, 'T-08'), id: 'T-09', title: 'nueva', status: 'approved_for_impl', depends_on: [] }));

    it('rejects a Task trailer whose task exists only in the working tree, not in the commit', () => {
      addTask();               // spec/TASKS.json changed but not staged
      write('a.txt');
      const r = commitOnly(['a.txt'], 'Code\n\nTask: T-09\nReq: N/A');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Task T-09 does not exist in spec/TASKS.json');
    });

    it('accepts it once spec/TASKS.json is in the same commit', () => {
      addTask();
      write('a.txt');
      expect(commitOnly(['a.txt', 'spec/TASKS.json'], 'Code\n\nTask: T-09\nReq: N/A').status).toBe(0);
    });

    it('does not reject a commit for a problem that exists only in the working tree', () => {
      write('a.txt');
      write('spec/stray.md');   // not allowed in spec/, but not staged
      expect(commitOnly(['a.txt'], 'Code\n\nTask: T-02\nReq: none').status).toBe(0);
    });
  });
});
