import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { acceptanceDiffProblems, globMatches, pathsCross } from '../lib/autopilot-tasks.mjs';

// Fixtures: a copy of a fixed spec/ (scripts/test/fixtures/spec) in a temporary directory, mutated by each case.
// The repo's spec/ is not used: its real state changes with the project.
// spec/LOG.md and spec/TASKS.json stay in Spanish; terminal, live.log, ntfy and commits are in English.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SPEC_FIXTURE = join(REPO, 'scripts/test/fixtures/spec');
const STUBS = join(REPO, 'scripts/test/fixtures/autopilot-stubs');
const SCRIPT = join(REPO, 'scripts/lib/autopilot-tasks.mjs');
const AUTOPILOT_SH = join(REPO, 'scripts/autopilot.sh');
// What the orchestrator needs from this repo to run in a temporary git (no spec/: the fixture goes there).
const AUTOPILOT_FILES = ['scripts/autopilot.sh', 'scripts/adr.mjs', 'scripts/critic-gate.sh', 'scripts/check-coverage.mjs', 'scripts/record_evidence.py', 'scripts/check-spec.mjs', 'scripts/lib', 'scripts/agents', '.githooks'];

// Without the user's local configuration (~/.config/autopilot): no test sends real notices.
process.env.AUTOPILOT_LOCAL_CONFIG = '/dev/null';
process.env.AUTOPILOT_SECRETS = '/dev/null'; // never the machine's ~/.config/autopilot/secrets.sh
// The claude double reports version 0.0.0; the adapter runs only the pinned version (T-19).
process.env.AUTOPILOT_CLAUDE_VERSION = '0.0.0';
// The monthly cost ledger (DEC-009) goes to a temporary state directory, never the user's.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'autopilot-state-'));
process.env.NTFY_TOPIC = '';
process.env.AUTOPILOT_DECIDER = 'stub'; // scripts/test/fixtures/decider-stub.sh: agrees with the LLM outputs unless told otherwise
process.env.NTFY_URL = '';
process.env.AUTOPILOT_BATCH = 'off'; // DEC-033 is on by default; its own tests (T-65) turn it on
process.env.AUTOPILOT_QUEUE_POLICY = 'off'; // DEC-023 is on by default; its own tests (T-54) turn it on

let root;

function run(...args) {
  const r = spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function readTasks() {
  return JSON.parse(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).tasks;
}
function editTasks(fn) {
  const path = join(root, 'spec/TASKS.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  fn(data.tasks, data);
  writeFileSync(path, JSON.stringify(data, null, 2));
}
const task = (tasks, id) => tasks.find((t) => t.id === id);
const copyAutopilot = () => {
  for (const f of AUTOPILOT_FILES) cpSync(join(REPO, f), join(root, f), { recursive: true });
  cpSync(join(REPO, 'scripts/test/fixtures/decider-stub.sh'), join(root, 'scripts/agents/decider/stub.sh')); // port decide (DEC-015)
};
// Agent doubles (claude) in their own directory (outside root, so the temporary git's tree stays clean).
const stubBin = () => {
  const bin = join(root, '..', `autopilot-stubs-${process.pid}-${Date.now()}`);
  cpSync(STUBS, bin, { recursive: true });
  return bin;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'autopilot-tasks-'));
  cpSync(SPEC_FIXTURE, join(root, 'spec'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('autopilot-tasks review-duration (DEC-023, T-54)', () => {
  const runLog = (name, lines) => {
    mkdirSync(join(root, '.autopilot', name), { recursive: true });
    writeFileSync(join(root, '.autopilot', name, 'live.log'), `${lines.join('\n')}\n`);
  };
  it('the median of the last reviews measured in .autopilot/*/live.log (reviewer … on <ID> → verdict on <ID>), across midnight', () => {
    runLog('2026-10-01_220000', [
      '22:00:00 autopilot: reviewer (claude) on T-01: 100 bytes of context', '22:10:00 autopilot: verdict on T-01: approved → status reviewed',
      '23:55:00 autopilot: reviewer (codex) on T-02: 100 bytes of context', '00:15:00 autopilot: verdict on T-02: rejected', // 20 min, past midnight
    ]);
    runLog('2026-10-02_220000', ['22:00:00 autopilot: reviewer (claude) on T-03: 9 bytes of context', '22:30:00 autopilot: verdict on T-03: approved → status reviewed']);
    expect(JSON.parse(run('review-duration', '--runs', join(root, '.autopilot')).out)).toEqual({ seconds: 1200, samples: 3 });
  });
  it('only the last N (--last); a review with no verdict does not count; no history → null', () => {
    expect(JSON.parse(run('review-duration', '--runs', join(root, '.autopilot')).out)).toEqual({ seconds: null, samples: 0 });
    runLog('2026-10-01_220000', ['22:00:00 autopilot: reviewer (claude) on T-01: 1 bytes of context', '22:10:00 autopilot: verdict on T-01: approved',
      '22:20:00 autopilot: reviewer (claude) on T-02: 1 bytes of context', '22:21:00 autopilot: stop: x']);
    runLog('2026-10-02_220000', ['22:00:00 autopilot: reviewer (claude) on T-03: 1 bytes of context', '22:02:00 autopilot: verdict on T-03: approved']);
    expect(JSON.parse(run('review-duration', '--runs', join(root, '.autopilot'), '--last', '1').out)).toEqual({ seconds: 120, samples: 1 });
  });
});

describe('autopilot-tasks manual-pending', () => {
  it('lists claims.manual_pending of verified_auto or reviewed tasks (the legacy evidence.manual_pending too); not accepted ones', () => {
    expect(JSON.parse(run('manual-pending').out)).toEqual([]);
    editTasks((ts) => {
      Object.assign(task(ts, 'T-04'), { status: 'verified_auto', claims: { manual_pending: ' REQ-002 E3 a mano ' } });
      Object.assign(task(ts, 'T-05'), { status: 'reviewed', evidence: { command: 'x', result: 'y', commit: 'z', manual_pending: 'REQ-003 E5' } }); // before T-34
      Object.assign(task(ts, 'T-06'), { status: 'accepted', claims: { manual_pending: 'ya hecha' } });
      Object.assign(task(ts, 'T-07'), { status: 'verified_auto', evidence: { command: 'x', result: 'y', commit: 'z' } });
    });
    expect(JSON.parse(run('manual-pending').out)).toEqual(['T-04: REQ-002 E3 a mano', 'T-05: REQ-003 E5']);
  });
});

describe('autopilot-tasks pick', () => {
  it('picks nothing if no eligible task has its dependencies closed', () => {
    // T-03..T-07 (approved_for_impl) wait for T-01 (verified_auto: open); T-08 (in_progress) waits for T-02.
    editTasks((ts) => { task(ts, 'T-01').status = 'verified_auto'; });
    expect(run('pick')).toMatchObject({ code: 0, out: 'null\n' });
  });

  it('picks an approved_for_impl task whose dependencies are closed, same as a ready one', () => {
    editTasks((ts) => { task(ts, 'T-01').status = 'accepted'; }); // T-03 approved_for_impl, depends on T-01
    expect(JSON.parse(run('pick').out)).toMatchObject({ id: 'T-03', status: 'approved_for_impl', kind: 'spec' });
    editTasks((ts) => { task(ts, 'T-03').status = 'accepted'; }); // T-04 and T-07 (approved_for_impl) become eligible: the first one
    expect(JSON.parse(run('pick').out)).toMatchObject({ id: 'T-04', status: 'approved_for_impl' });
  });

  it('resumes an in_progress task with its dependencies closed', () => {
    editTasks((ts) => { task(ts, 'T-01').status = 'accepted'; task(ts, 'T-03').status = 'in_progress'; });
    expect(JSON.parse(run('pick').out)).toMatchObject({ id: 'T-03', status: 'in_progress' });
  });

  it('--exclude skips the given tasks and picks the next eligible one', () => {
    editTasks((ts) => { task(ts, 'T-01').status = 'accepted'; task(ts, 'T-03').status = 'accepted'; });
    expect(JSON.parse(run('pick', '--exclude', 'T-04,').out)).toMatchObject({ id: 'T-07' });
    expect(run('pick', '--exclude', 'T-04,T-07')).toMatchObject({ code: 0, out: 'null\n' });
    expect(JSON.parse(run('pick', '--exclude', '').out)).toMatchObject({ id: 'T-04' });
  });

  it('does not pick tasks in other states even if their dependencies are closed', () => {
    editTasks((ts) => {
      task(ts, 'T-01').status = 'accepted';
      for (const id of ['T-03', 'T-04', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'verified_auto';
      task(ts, 'T-08').status = 'blocked'; // depends on T-02 (verified_auto: open)
      task(ts, 'T-02').status = 'accepted';
    });
    expect(run('pick').out).toBe('null\n');
  });

  it('picks the first ready task whose dependencies are done/accepted/delivered', () => {
    editTasks((ts) => {
      task(ts, 'T-01').status = 'done';
      task(ts, 'T-03').status = 'ready'; // depends on T-01
      task(ts, 'T-04').status = 'ready'; // depends on T-01 and T-03 (T-03 not closed)
    });
    expect(JSON.parse(run('pick').out)).toMatchObject({ id: 'T-03', kind: 'spec' });
    editTasks((ts) => { task(ts, 'T-03').status = 'accepted'; });
    expect(JSON.parse(run('pick').out)).toMatchObject({ id: 'T-04', kind: 'impl', reqs: ['REQ-002'] });
  });

  it('a reviewed dependency counts as closed (chains without waiting for accepted); verified_auto does not', () => {
    editTasks((ts) => { task(ts, 'T-01').status = 'reviewed'; }); // T-03 approved_for_impl, depends on T-01
    expect(JSON.parse(run('pick').out)).toMatchObject({ id: 'T-03' });
    editTasks((ts) => { task(ts, 'T-01').status = 'verified_auto'; });
    expect(run('pick').out).toBe('null\n');
  });

  it('skips a ready task whose dependency is still open', () => {
    editTasks((ts) => { task(ts, 'T-01').status = 'verified_auto'; task(ts, 'T-03').status = 'ready'; });
    expect(run('pick').out).toBe('null\n');
  });

  it('--task forces a specific task even if it is not ready', () => {
    expect(JSON.parse(run('pick', '--task', 'T-08').out)).toMatchObject({ id: 'T-08', kind: 'tooling' });
    expect(run('pick', '--task', 'T-99')).toMatchObject({ code: 1, err: expect.stringContaining('T-99 does not exist') });
  });
});

describe('touches crossing (pathsCross)', () => {
  for (const [a, b, crosses] of [
    ['app/', 'app/src/x.ts', true],
    ['app/src/x.ts', 'app/', true],
    ['app/', 'app/', true],
    ['app', 'app/', true],
    ['README.md', 'README.md', true],
    ['app/', 'apps/', false],
    ['app/', 'apps/admin/x.ts', false],
    ['app/src/a.ts', 'app/src/b.ts', false],
    ['app/src/', 'app/srcs/x.ts', false],
    ['README.md', 'README.md.bak', false],
  ]) {
    it(`${a} ${crosses ? 'crosses' : 'does not cross'} ${b}`, () => {
      expect(pathsCross(a, b)).toBe(crosses);
    });
  }
});

describe('autopilot-tasks pick-batch', () => {
  const batch = (...args) => JSON.parse(run('pick-batch', ...args).out).map((t) => t.id);
  // T-01..T-07 eligible at once: dependencies closed or removed. T-08 waits for T-02 (verified_auto).
  const allEligible = (ts) => {
    task(ts, 'T-03').status = 'ready';
    for (const id of ['T-03', 'T-04', 'T-05', 'T-06', 'T-07']) task(ts, id).depends_on = [];
  };

  it('takes eligible tasks in order, skipping those whose touches cross the batch (app/ blocks app/…, not apps/)', () => {
    editTasks((ts) => { allEligible(ts); task(ts, 'T-02').status = 'accepted'; });
    // T-01 app/ → T-03 tests/acceptance/ → T-04, T-05, T-07 under app/ are skipped → T-06 apps/ → T-08 scripts/…
    expect(batch('--max', '10')).toEqual(['T-01', 'T-03', 'T-06', 'T-08']);
  });

  it('crosses by segment prefix between files and directories (T-04 app/src/orders/ blocks T-05 …/discounts.ts)', () => {
    editTasks((ts) => { allEligible(ts); task(ts, 'T-01').status = 'accepted'; });
    expect(batch('--max', '10')).toEqual(['T-03', 'T-04', 'T-06', 'T-07']);
  });

  it('stops at --max and honors --exclude', () => {
    editTasks((ts) => { allEligible(ts); task(ts, 'T-01').status = 'accepted'; });
    expect(batch('--max', '2')).toEqual(['T-03', 'T-04']);
    expect(batch('--max', '10', '--exclude', 'T-04,T-03')).toEqual(['T-05', 'T-06', 'T-07']);
  });

  it('uses the same eligibility as pick: --max 1 is pick', () => {
    editTasks((ts) => { task(ts, 'T-01').status = 'accepted'; });
    expect(batch('--max', '1')).toEqual([JSON.parse(run('pick').out).id]);
    expect(batch('--max', '10')).toEqual(['T-03']); // T-04..T-07 wait for T-03; T-08 for T-02
    editTasks((ts) => { task(ts, 'T-01').status = 'verified_auto'; });
    expect(batch('--max', '10')).toEqual([]);
  });

  it('a task without touches runs alone', () => {
    editTasks((ts) => { allEligible(ts); task(ts, 'T-01').status = 'accepted'; delete task(ts, 'T-03').touches; });
    expect(batch('--max', '10')).toEqual(['T-03']);
    editTasks((ts) => { task(ts, 'T-03').touches = ['tests/acceptance/']; delete task(ts, 'T-06').touches; });
    expect(batch('--max', '10')).toEqual(['T-03', 'T-04', 'T-07']);
  });

  it('outputs the same fields as pick, plus touches', () => {
    editTasks((ts) => { task(ts, 'T-01').status = 'accepted'; });
    expect(JSON.parse(run('pick-batch', '--max', '1').out)).toEqual([
      { id: 'T-03', title: task(readTasks(), 'T-03').title, kind: 'spec', status: 'approved_for_impl',
        reqs: ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004'], decisions: ['DEC-007'], touches: ['tests/acceptance/'] },
    ]);
  });

  it('fails without a valid --max', () => {
    for (const args of [[], ['--max', '0'], ['--max', 'x'], ['--max', '1.5']]) {
      expect(run('pick-batch', ...args)).toMatchObject({ code: 2, err: expect.stringContaining('--max N') });
    }
  });
});

describe('autopilot-tasks pending-reviews', () => {
  it('lists the tasks in verified_auto, in order', () => {
    expect(JSON.parse(run('pending-reviews').out)).toEqual(['T-02']); // the fixture leaves T-02 in verified_auto
    editTasks((ts) => { task(ts, 'T-05').status = 'verified_auto'; task(ts, 'T-02').status = 'reviewed'; });
    expect(JSON.parse(run('pending-reviews').out)).toEqual(['T-05']);
  });
});

describe('autopilot-tasks check-authority', () => {
  it('detects reserved statuses granted by the executor', () => {
    const snap = join(root, 'before.json');
    writeFileSync(snap, run('snapshot').out);
    expect(run('check-authority', snap).code).toBe(0);
    editTasks((ts) => { task(ts, 'T-02').status = 'reviewed'; task(ts, 'T-04').status = 'in_progress'; });
    const r = run('check-authority', snap);
    expect(r.code).toBe(1);
    expect(r.err).toContain('T-02: verified_auto → reviewed');
    expect(r.err).not.toContain('T-04');
  });

  it('accepts accepted if it already was before', () => {
    editTasks((ts) => { task(ts, 'T-02').status = 'accepted'; });
    const snap = join(root, 'before.json');
    writeFileSync(snap, run('snapshot').out);
    expect(run('check-authority', snap).code).toBe(0);
  });
});

describe('autopilot-tasks context', () => {
  it('includes the task, its full REQs and its DECs', () => {
    const out = run('context', 'T-04').out;
    expect(out).toContain('# Task T-04: Funcionalidad de REQ-002');
    expect(out).toContain('### REQ-002 Requisito de prueba 2');
    expect(out).toContain('## DEC-005');
    expect(out).toContain('## DEC-006');
    expect(out).not.toContain('### REQ-003');
    expect(out).not.toContain('## DEC-004');
  });

  it('without REQs, states that the description acts as the requirement', () => {
    const out = run('context', 'T-08').out;
    expect(out).toContain('(no product REQ)');
    expect(out).toContain('Declared verification:');
  });
});

describe('autopilot-tasks parse-verdict', () => {
  const parse = (text) => {
    const f = join(root, 'out.txt');
    writeFileSync(f, text);
    return run('parse-verdict', f);
  };

  it('extracts the final json block', () => {
    const r = parse('Analysis…\n```json\n{"verdict":"rejected","findings":["REQ-002: falta E3"],"notes":"x"}\n```\n');
    expect(JSON.parse(r.out)).toEqual({ verdict: 'rejected', findings: ['REQ-002: falta E3'], notes: 'x' });
  });

  it('accepts a bare JSON object (output of --output-schema)', () => {
    expect(JSON.parse(parse('{"verdict":"Approved","findings":[]}').out)).toMatchObject({ verdict: 'approved' });
  });

  it('uses the last block when there are several', () => {
    const r = parse('```json\n{"verdict":"approved","findings":[]}\n```\nCorrection:\n```json\n{"verdict":"rejected","findings":["DEC-004: x"]}\n```');
    expect(JSON.parse(r.out).verdict).toBe('rejected');
  });

  it('keeps a research_question only with a rejection (DEC-005)', () => {
    const rejected = parse('```json\n{"verdict":"rejected","findings":["REQ-001: x"],"research_question":" ¿Cambió la API? "}\n```');
    expect(JSON.parse(rejected.out)).toEqual({ verdict: 'rejected', findings: ['REQ-001: x'], notes: '', research_question: '¿Cambió la API?' });
    const approved = parse('```json\n{"verdict":"approved","findings":[],"research_question":"¿x?"}\n```');
    expect(JSON.parse(approved.out)).toEqual({ verdict: 'approved', findings: [], notes: '' });
  });

  it('fails without a verdict or with an unknown verdict', () => {
    expect(parse('No block.').code).toBe(1);
    expect(parse('```json\n{"verdict":"maybe"}\n```').code).toBe(1);
  });
});

describe('autopilot-tasks set-review', () => {
  const verdict = (v) => {
    const f = join(root, 'verdict.json');
    writeFileSync(f, JSON.stringify(v));
    return f;
  };
  // T-36 (DEC-015): a verdict is applied only with the decide record that confirms it
  const decision = (answer, extra = {}) => {
    const f = join(root, 'decision.json');
    writeFileSync(f, JSON.stringify({ question_id: 'review_verdict', answer, confidence: 0.93, threshold: 0.8, action: 'proceed', decider: '/x/scripts/agents/decider/jev.sh', timestamp: '2026-10-21T00:00:00.000Z', ...extra }));
    return f;
  };
  const review = (id, v, d = decision(v.verdict)) => run('set-review', id, verdict(v), '--decision', d);

  it('needs the decision that confirms the verdict (DEC-015): none, another answer, an escalation or another question → exit 2, nothing written', () => {
    const before = readFileSync(join(root, 'spec/TASKS.json'), 'utf8');
    expect(run('set-review', 'T-02', verdict({ verdict: 'approved' }))).toMatchObject({ code: 2, err: expect.stringContaining('needs --decision') });
    expect(review('T-02', { verdict: 'approved' }, decision('rejected'))).toMatchObject({ code: 2, err: expect.stringContaining('the decision says rejected, the verdict approved') });
    expect(review('T-02', { verdict: 'approved' }, decision('approved', { action: 'escalate' })).code).toBe(2);
    expect(review('T-02', { verdict: 'approved' }, decision('approved', { question_id: 'plan_verdict' })).code).toBe(2);
    expect(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).toBe(before);
  });

  it('stores who decided: the decider, its confidence and when', () => {
    review('T-02', { verdict: 'approved', findings: [], notes: 'ok', reviewer: 'codex' });
    expect(task(readTasks(), 'T-02').review.decision).toEqual({ question_id: 'review_verdict', decider: 'jev', confidence: 0.93, threshold: 0.8, timestamp: '2026-10-21T00:00:00.000Z' });
  });

  it('approved on verified_auto moves to reviewed and stores review', () => {
    const r = review('T-02', { verdict: 'approved', findings: [], notes: 'ok', reviewer: 'codex' });
    expect(r).toMatchObject({ code: 0, out: 'reviewed\n' });
    const t = task(readTasks(), 'T-02');
    expect(t.status).toBe('reviewed');
    expect(t.review).toMatchObject({ reviewer: 'codex', verdict: 'approved', findings: [], notes: 'ok' });
    expect(t.review.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejected keeps the status and records the findings', () => {
    review('T-02', { verdict: 'rejected', findings: ['REQ-001: x'] });
    const t = task(readTasks(), 'T-02');
    expect(t.status).toBe('verified_auto');
    expect(t.review).toMatchObject({ verdict: 'rejected', findings: ['REQ-001: x'] });
  });

  it('approved on a task that is not verified_auto does not change the status', () => {
    expect(review('T-04', { verdict: 'approved' }).out).toBe('approved_for_impl\n');
  });

  it('rejects invalid verdicts', () => {
    expect(review('T-02', { verdict: 'ok' }).code).toBe(1);
  });

  it('stores research_question with a rejection, never with an approval; check:spec validates it', () => {
    review('T-02', { verdict: 'rejected', findings: ['REQ-001: x'], research_question: '¿Cambió la API?' });
    expect(task(readTasks(), 'T-02').review.research_question).toBe('¿Cambió la API?');
    const checkSpec = () => spawnSync('node', [join(REPO, 'scripts/check-spec.mjs'), '--root', root], { encoding: 'utf8' });
    expect(checkSpec().status).toBe(0);
    editTasks((ts) => { task(ts, 'T-02').review.verdict = 'approved'; });
    expect(checkSpec().stderr).toContain('T-02: review.research_question is only allowed with a rejected verdict, got "approved"');
    editTasks((ts) => { Object.assign(task(ts, 'T-02').review, { verdict: 'rejected', research_question: ' ' }); });
    expect(checkSpec().stderr).toContain('T-02: review.research_question must be a non-empty string');
    review('T-02', { verdict: 'approved', research_question: '¿x?' });
    expect(task(readTasks(), 'T-02').review.research_question).toBe(undefined);
  });
});

describe('autopilot-tasks reopen', () => {
  it('moves a rejected verified_auto task back to in_progress; refuses anything else', () => {
    expect(run('reopen', 'T-02')).toMatchObject({ code: 1, err: expect.stringContaining('T-02 cannot be reopened') }); // review null
    editTasks((ts) => { task(ts, 'T-02').review = { verdict: 'rejected', findings: [], notes: '' }; });
    expect(run('reopen', 'T-02')).toMatchObject({ code: 0, out: 'in_progress\n' });
    expect(task(readTasks(), 'T-02').status).toBe('in_progress');
    expect(run('reopen', 'T-04').code).toBe(1); // approved_for_impl
  });
});

describe('autopilot-tasks set-acceptance-review', () => {
  const verdict = (v) => {
    const f = join(root, 'verdict.json');
    writeFileSync(f, JSON.stringify(v));
    return f;
  };
  const decision = (answer, extra = {}) => {
    const f = join(root, 'decision.json');
    writeFileSync(f, JSON.stringify({ question_id: 'acceptance_verdict', answer, confidence: 0.9, threshold: 0.8, action: 'proceed', decider: '/x/jev.sh', timestamp: 't', ...extra }));
    return f;
  };

  it('needs the decision that confirms the verdict (DEC-015, T-36)', () => {
    const r = (d) => run('set-acceptance-review', 'T-03', verdict({ verdict: 'approved' }), '--commits', 'abc1234..def5678', ...(d ? ['--decision', d] : []));
    expect(r(null)).toMatchObject({ code: 2, err: expect.stringContaining('needs --decision') });
    expect(r(decision('rejected')).code).toBe(2);
    expect(r(decision('approved', { question_id: 'review_verdict' })).code).toBe(2);
    expect(task(readTasks(), 'T-03').acceptance_review).toBe(undefined);
    expect(r(decision('approved')).code).toBe(0);
    expect(task(readTasks(), 'T-03').acceptance_review.decision).toMatchObject({ question_id: 'acceptance_verdict', decider: 'jev', confidence: 0.9 });
  });

  it('stores the verdict and the commit range as acceptance_review of a spec task; the status does not change', () => {
    const r = run('set-acceptance-review', 'T-03', verdict({ verdict: 'approved', findings: [], notes: 'ok', reviewer: 'codex' }), '--commits', 'abc1234..def5678', '--decision', decision({ verdict: 'approved', findings: [], notes: 'ok', reviewer: 'codex' }.verdict));
    expect(r).toMatchObject({ code: 0, out: 'approved\n' });
    const t = task(readTasks(), 'T-03');
    expect(t.status).toBe('approved_for_impl');
    expect(t.review).toBeNull();
    expect(t.acceptance_review).toMatchObject({ reviewer: 'codex', verdict: 'approved', findings: [], notes: 'ok', commits: 'abc1234..def5678' });
    expect(t.acceptance_review.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses a task without acceptance tests (tooling, no REQ), an invalid verdict or an invalid range', () => {
    expect(run('set-acceptance-review', 'T-08', verdict({ verdict: 'approved' }), '--commits', 'abc1234..def5678', '--decision', decision({ verdict: 'approved' }.verdict))).toMatchObject({ code: 1, err: expect.stringContaining('neither a spec task nor a task with REQ') });
    expect(run('set-acceptance-review', 'T-04', verdict({ verdict: 'approved' }), '--commits', 'abc1234..def5678', '--decision', decision({ verdict: 'approved' }.verdict)).code).toBe(0); // DEC-006
    expect(run('set-acceptance-review', 'T-03', verdict({ verdict: 'ok' }), '--commits', 'abc1234..def5678', '--decision', decision({ verdict: 'ok' }.verdict)).code).toBe(1);
    expect(run('set-acceptance-review', 'T-03', verdict({ verdict: 'approved' }), '--commits', 'HEAD', '--decision', decision({ verdict: 'approved' }.verdict)).code).toBe(1);
    expect(task(readTasks(), 'T-03').acceptance_review).toBe(undefined);
  });
});

describe('test-author support in autopilot-tasks (DEC-006)', () => {
  const file = (name, v) => { const p = join(root, name); writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); return p; };
  const ok = { tests: [{ file: 'tests/acceptance/T-04.test.sh', req: 'REQ-002', example: 'E1' }], red: 'falla', log: '- Hecho: x.' };

  it('check-tests validates files (only <ID>*, written in the session, all listed), REQ cited, red and log', () => {
    const good = run('check-tests', 'T-04', file('r.json', ok), '--changed', 'tests/acceptance/T-04.test.sh');
    expect(good.code).toBe(0);
    expect(JSON.parse(good.out)).toMatchObject({ tests: ok.tests, red: 'falla', blocked: null });
    const bad = run('check-tests', 'T-04', file('r.json', { tests: [{ file: 'tests/acceptance/T-1.x', req: 'REQ-009', example: 'E' }], log: '- x' }),
      '--changed', 'tests/acceptance/T-1.x,tests/acceptance/T-04-extra.sh');
    expect(bad.code).toBe(1);
    for (const why of ['"red" must say how the tests failed', 'tests[0].file must be tests/acceptance/T-04.*', 'tests[0].req REQ-009 is not cited by T-04',
      'tests/acceptance/T-04-extra.sh was written but is not listed in "tests"']) expect(bad.out).toContain(why);
    expect(run('check-tests', 'T-04', file('r.json', { ...ok, log: '- Hecho: 2 tests fallan como se espera.' }), '--changed', 'tests/acceptance/T-04.test.sh').out)
      .toContain('"log" must not state test results'); // T-35: the red run is the orchestrator's
    const blocked = run('check-tests', 'T-04', file('r.json', { blocked: 'REQ-002 sin ejemplos', log: '- x' }));
    expect(JSON.parse(blocked.out)).toMatchObject({ blocked: 'REQ-002 sin ejemplos', tests: [] });
  });

  it('check-result accepts test_dispute only with blocked_by, and one of the task REQ', () => {
    mkdirSync(join(root, 'tests/acceptance'), { recursive: true });
    writeFileSync(join(root, 'tests/acceptance/T-04.test.sh'), 'exit 1\n');
    const dispute = { blocked_by: 'REQ-002', log: '- Hecho: x.', test_dispute: { file: 'tests/acceptance/T-04.test.sh', reason: 'no' } };
    expect(JSON.parse(run('check-result', 'T-04', file('d.json', dispute)).out).test_dispute).toEqual({ file: 'tests/acceptance/T-04.test.sh', reason: 'no' });
    const wrong = run('check-result', 'T-04', file('d.json', { ...dispute, blocked_by: 'Q-01' }));
    expect(wrong).toMatchObject({ code: 1, err: expect.stringContaining('"blocked_by" must be the REQ the test encodes') });
    expect(run('check-result', 'T-04', file('d.json', { ...dispute, blocked_by: undefined })).err).toContain('"test_dispute" is only allowed with "blocked_by"');
  });

  it('the disputed test is a fact to check (T-40): it must exist and be one of the task\'s own tests', () => {
    mkdirSync(join(root, 'tests/acceptance'), { recursive: true });
    writeFileSync(join(root, 'tests/acceptance/T-05.test.sh'), 'exit 1\n');
    const d = (f) => run('check-result', 'T-04', file('d.json', { blocked_by: 'REQ-002', log: '- Hecho: x.', test_dispute: { file: f, reason: 'no' } }));
    expect(d('tests/acceptance/T-04-nope.test.sh').err).toContain('"test_dispute.file" tests/acceptance/T-04-nope.test.sh does not exist');
    expect(d('tests/acceptance/T-05.test.sh').err).toContain('"test_dispute.file" must be one of T-04\'s tests (tests/acceptance/T-04*)');
  });

  it('unblock moves a blocked task back to in_progress; refuses any other status', () => {
    editTasks((ts) => { Object.assign(task(ts, 'T-04'), { status: 'blocked', blocked_by: 'REQ-002' }); });
    expect(run('unblock', 'T-04')).toMatchObject({ code: 0, out: 'in_progress\n' });
    expect(task(readTasks(), 'T-04')).toMatchObject({ status: 'in_progress', blocked_by: null });
    expect(run('unblock', 'T-05').code).toBe(1);
  });
});

describe('autopilot-tasks research-check', () => {
  const REPORT = [
    '# Investigación de T-03', '## Causa probable', 'La API cambió.', '## Evidencia', 'Error 404 en el intento 2.',
    '## Fuentes', '- https://example.com/changelog', '## Recomendación', 'Usar la API nueva.',
  ];
  const check = (lines) => {
    const file = join(root, 'report.md');
    writeFileSync(file, lines.join('\n') + '\n');
    return run('research-check', file);
  };

  it('accepts a complete report (list markers and bold tolerated) → action, confidence and no cut', () => {
    const r = check([...REPORT, '- **Acción sugerida:** reintentar', 'Confianza: Alta.']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ action: 'reintentar', confidence: 'alta', cut: null });
  });

  it('recortar needs "Recorte propuesto" with Título and Descripción (the description runs to the end of the section)', () => {
    const ok = check([...REPORT, 'Acción sugerida: recortar', 'Confianza: media', '## Recorte propuesto', 'Título: Exportación CSV', 'Descripción: exportar pedidos', 'cuando la API lo permita.']);
    expect(JSON.parse(ok.out)).toEqual({ action: 'recortar', confidence: 'media', cut: { title: 'Exportación CSV', description: 'exportar pedidos cuando la API lo permita.' } });
    const bad = check([...REPORT, 'Acción sugerida: recortar', 'Confianza: media']);
    expect(bad).toMatchObject({ code: 1, out: expect.stringContaining('"recortar" needs a "## Recorte propuesto" section') });
    const noTitle = check([...REPORT, 'Acción sugerida: recortar', 'Confianza: media', '## Recorte propuesto', 'Descripción: x']);
    expect(noTitle.out).toContain('needs a "Título:" line');
  });

  it('lists every problem: missing or empty sections, missing, repeated or unknown action and confidence', () => {
    const r = check(['## Causa probable', '', '## Evidencia', 'x', 'Acción sugerida: reintentar', 'Acción sugerida: escalar', 'Confianza: segura']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the "## Causa probable" section is empty');
    expect(r.out).toContain('missing the "## Fuentes" section');
    expect(r.out).toContain('missing the "## Recomendación" section');
    expect(r.out).toContain('more than one "Acción sugerida:" line');
    expect(r.out).toContain('"Confianza" must be one of alta, media, baja, got "segura"');
  });

  it('a missing report fails', () => {
    expect(run('research-check', join(root, 'nope.md'))).toMatchObject({ code: 1, err: expect.stringContaining('left no report') });
  });
});

describe('autopilot-tasks escalate', () => {
  const spec = () => readFileSync(join(root, 'spec/SPEC.md'), 'utf8');

  it('adds a blocking Q-NN that points to the report and blocks the task with it; check:spec passes', () => {
    const r = run('escalate', 'T-04', '--reason', 'el investigador recomienda escalar', '--report', 'research/T-04.md');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ question: 'Q-03', task: null });
    expect(spec()).toContain('| Q-03 | ¿Cómo sigue T-04? El orquestador la escaló tras investigarla: el investigador recomienda escalar (informe en research/T-04.md). | bloqueante | T-04 | usuario | — |');
    expect(spec().indexOf('| Q-03 |')).toBeGreaterThan(spec().indexOf('| Q-02 |'));
    const t = task(readTasks(), 'T-04');
    expect(t).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
    expect(t.notes).toContain('escalada por el orquestador (DEC-005): el investigador recomienda escalar; informe en research/T-04.md; bloqueada por Q-03');
    expect(spawnSync('node', [join(REPO, 'scripts/check-spec.mjs'), '--root', root], { encoding: 'utf8' }).stdout).toBe('check:spec: ok\n');
  });

  it('with a cut: the split-off work becomes a new specified task (kind, REQ, DEC and touches of the original; depends on it)', () => {
    const r = run('escalate', 'T-08', '--reason', 'recortar', '--report', 'research/T-08.md', '--cut-title', 'Exportación diferida', '--cut-description', 'exportar luego');
    expect(JSON.parse(r.out)).toEqual({ question: 'Q-03', task: 'T-09' });
    expect(task(readTasks(), 'T-09')).toMatchObject({
      kind: 'tooling', title: 'Exportación diferida', description: 'exportar luego', reqs: [], decisions: [],
      depends_on: ['T-08'], status: 'specified', touches: ['scripts/autopilot.sh', 'scripts/lib/'], blocked_by: null,
    });
    expect(spec()).toMatch(/\| Q-03 \| ¿Aprobar el recorte de T-08 propuesto por el investigador \(informe en research\/T-08\.md\)\? T-09 \(specified\) toma «Exportación diferida»; .* \| bloqueante \| T-08, T-09 \|/);
    expect(task(readTasks(), 'T-08')).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
    expect(spawnSync('node', [join(REPO, 'scripts/check-spec.mjs'), '--root', root], { encoding: 'utf8' }).stdout).toBe('check:spec: ok\n');
  });

  it('without a report it says so; without the questions table it fails and writes nothing', () => {
    run('escalate', 'T-04', '--reason', 'sin tiempo');
    expect(spec()).toContain('(sin informe)');
    writeFileSync(join(root, 'spec/SPEC.md'), '# SPEC\n');
    const r = run('escalate', 'T-05', '--reason', 'x');
    expect(r).toMatchObject({ code: 1, err: expect.stringContaining('no "## Preguntas abiertas" table') });
    expect(task(readTasks(), 'T-05').status).toBe('approved_for_impl');
  });
});

describe('autopilot-tasks set-user-review (T-103)', () => {
  const spec = () => readFileSync(join(root, 'spec/SPEC.md'), 'utf8');
  const checkSpec = () => spawnSync('node', [join(REPO, 'scripts/check-spec.mjs'), '--root', root], { encoding: 'utf8' }).stdout;
  const noVerdict = (id) => run('escalate', id, '--reason', 'revisión sin veredicto: el decisor (jev) no resolvió el veredicto de la revisión', '--after', 'porque su revisión no dio veredicto (DEC-030)');

  it('T-103: from verified_auto it goes to reviewed with the user named as reviewer and decision {decider: user, by}', () => {
    const r = run('set-user-review', 'T-02', '--by', 'José Pedro Lübbert', '--reason', 'la revisé y la apruebo');
    expect(r).toMatchObject({ code: 0, out: 'reviewed\n' });
    const t = task(readTasks(), 'T-02');
    expect(t.review).toMatchObject({ reviewer: 'José Pedro Lübbert', verdict: 'approved', findings: [], notes: 'la revisé y la apruebo',
      decision: { decider: 'user', by: 'José Pedro Lübbert' } });
    expect(t.review.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.status_log.at(-1)).toMatchObject({ from: 'verified_auto', to: 'reviewed', by: 'José Pedro Lübbert', reason: 'revisión del usuario: la revisé y la apruebo' });
    expect(checkSpec()).toBe('check:spec: ok\n');
  });

  it('T-103: from blocked by a review without a verdict (DEC-030) it goes to reviewed and its Q-NN is answered', () => {
    expect(JSON.parse(noVerdict('T-02').out)).toEqual({ question: 'Q-03', task: null });
    const r = run('set-user-review', 'T-02', '--by', 'Pepe', '--reason', '«la apruebo»');
    expect(r).toMatchObject({ code: 0, out: 'reviewed\n' });
    expect(task(readTasks(), 'T-02')).toMatchObject({ status: 'reviewed', blocked_by: null, review: { reviewer: 'Pepe', decision: { decider: 'user', by: 'Pepe' } } });
    const row = spec().split('\n').find((l) => l.startsWith('| Q-03 |'));
    expect(row).toMatch(/^\| Q-03 \| Respondida \d{4}-\d{2}-\d{2} por Pepe: aprobó la revisión de T-02 en persona \(set-user-review\): ««la apruebo»»\. \(Pregunta: ¿Cómo sigue T-02\? El orquestador la escaló porque su revisión no dio veredicto \(DEC-030\): .*\) \| bloqueante \| nada \| usuario \| — \|$/);
    expect(checkSpec()).toBe('check:spec: ok\n');
  });

  it('T-103: another block, another status, no --by, an agent or no --reason are rejected and change nothing', () => {
    run('escalate', 'T-04', '--reason', 'el investigador recomienda escalar');
    const before = readFileSync(join(root, 'spec/TASKS.json'), 'utf8');
    expect(run('set-user-review', 'T-04', '--by', 'Pepe', '--reason', 'ok')).toMatchObject({ code: 1, err: expect.stringContaining('not by a review without a verdict (DEC-030)') });
    expect(run('set-user-review', 'T-01', '--by', 'Pepe', '--reason', 'ok')).toMatchObject({ code: 1, err: expect.stringContaining('T-01 is in_progress') });
    expect(run('set-user-review', 'T-02', '--reason', 'ok')).toMatchObject({ code: 1, err: expect.stringContaining('needs --by NAME') });
    expect(run('set-user-review', 'T-02', '--by', 'autopilot', '--reason', 'ok')).toMatchObject({ code: 1, err: expect.stringContaining('only a person reviews here') });
    expect(run('set-user-review', 'T-02', '--by', 'Pepe')).toMatchObject({ code: 1, err: expect.stringContaining('needs --reason') });
    expect(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).toBe(before);
  });
});

describe('plan and critic checks (DEC-010)', () => {
  const plan = (extra = '', id = 'T-04') => `# Plan de ${id}\n## Objetivo\no\n## Pasos\n1. p\n## Archivos\n- a\n## Supuestos\n- s\n## Riesgos\n- r\n## Verificación\n- v\n${extra}`;
  const src = [1, 2, 3].map((n) => ({ assumption: `a${n}`, practice: 'p', sources: [`https://example.com/${n}`] }));
  const verdictFile = (obj) => { const f = join(root, 'critic.txt'); writeFileSync(f, `Texto.\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`); return f; };
  const f = (id, severity, evidence_type, evidence) => ({ id, severity, evidence_type, evidence, summary: 's', fix: 'f' });

  it('plan-check: the fixed sections in order and nothing else', () => {
    const file = join(root, 'plan.md');
    writeFileSync(file, plan());
    expect(run('plan-check', file, '--id', 'T-04').code).toBe(0);
    writeFileSync(file, plan('## Autoevaluación\nexcelente\n'));
    expect(run('plan-check', file, '--id', 'T-04')).toMatchObject({ code: 1, out: expect.stringContaining('sections not allowed: "## Autoevaluación"') });
    writeFileSync(file, plan().replace('## Riesgos\n- r\n', ''));
    expect(run('plan-check', file, '--id', 'T-04').out).toContain('missing the "## Riesgos" section');
    writeFileSync(file, plan().replace('## Pasos\n1. p\n', '## Pasos\n\n'));
    expect(run('plan-check', file, '--id', 'T-04').out).toContain('the "## Pasos" section is empty');
    writeFileSync(file, plan('', 'T-05'));
    expect(run('plan-check', file, '--id', 'T-04').out).toContain('the plan must start with "# Plan de T-04"');
    writeFileSync(file, plan().replace(/## Objetivo\no\n(## Pasos\n1\. p\n)/, '$1## Objetivo\no\n'));
    expect(run('plan-check', file, '--id', 'T-04').out).toContain('the sections must follow this order');
  });

  it('critic-check: effective verdict, blocking and opinion-only findings, repeated ids', () => {
    const blocking = f('req-002:vacio', 'P1', 'fuente', 'https://example.com/x');
    const opinion = f('riesgos:fragil', 'P0', 'opinion', 'me parece');
    const r = run('critic-check', verdictFile({ verdict: 'aprobar', assumptions: src, findings: [blocking, opinion, f('estilo:nombres', 'P3', 'opinión', 'x')] }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ verdict: 'APROBAR', effective: 'REVISAR', blocking: ['req-002:vacio'], opinion_blockers: ['riesgos:fragil'], repeated: [] });
    const clean = JSON.parse(run('critic-check', verdictFile({ verdict: 'APROBAR', assumptions: src, findings: [opinion] })).out);
    expect(clean).toMatchObject({ effective: 'APROBAR', opinion_blockers: ['riesgos:fragil'] });
    const again = JSON.parse(run('critic-check', verdictFile({ verdict: 'REVISAR', assumptions: src, findings: [blocking] }), '--previous', 'req-002:vacio').out);
    expect(again).toMatchObject({ effective: 'ESCALAR', repeated: ['req-002:vacio'] });
    expect(JSON.parse(run('critic-check', verdictFile({ verdict: 'ESCALAR', assumptions: src, findings: [] })).out).effective).toBe('ESCALAR');
  });

  it('critic-check: archivo evidence must be an existing line of a readable file; sources must be URLs', () => {
    const ok = run('critic-check', verdictFile({ verdict: 'REVISAR', assumptions: src, findings: [
      f('a:b', 'P1', 'archivo', 'spec/SPEC.md:2'), f('a:c', 'P1', 'archivo', '`spec/SPEC.md:1-2` dice otra cosa'), f('a:d', 'P1', 'fuente', 'https://example.com/x — la guía lo dice'),
    ] }), '--readable', 'spec/SPEC.md,plans/T-04.md');
    expect(JSON.parse(ok.out).blocking).toEqual(['a:b', 'a:c', 'a:d']);
    const bad = run('critic-check', verdictFile({
      verdict: 'REVISAR', assumptions: [...src.slice(0, 2), { assumption: 'x', practice: 'y', sources: ['un libro'] }],
      findings: [f('a:b', 'P1', 'archivo', 'spec/SPEC.md:999'), f('a:c', 'P1', 'archivo', 'spec/LOG.md:1'), f('a:d', 'P9', 'fuente', 'blog'), f('A B', 'P1', 'opinión', 'x'), f('a:b', 'P2', 'opinión', 'x')],
    }), '--readable', 'spec/SPEC.md');
    expect(bad.code).toBe(1);
    for (const e of ['assumptions[2].sources must be a list of URLs', 'spec/SPEC.md:999 does not exist', 'spec/LOG.md is not one of the files the critic may read',
      'findings[2] (a:d): severity must be one of P0, P1, P2, P3', '"fuente" evidence must start with a URL', 'id must be "<area>:<slug>"', 'findings[4] (a:b): duplicate id']) expect(bad.out).toContain(e);
    expect(run('critic-check', verdictFile({ verdict: 'APROBAR', assumptions: src.slice(0, 2), findings: [] })).out).toContain('assumptions must list the 3 to 5 riskiest assumptions');
    const unsourced = [...src.slice(0, 2), { assumption: 'x', practice: 'sin fuente', sources: [] }];
    expect(run('critic-check', verdictFile({ verdict: 'APROBAR', assumptions: unsourced, findings: [] })).out).toContain('at least 3 assumptions must cite a URL');
    expect(run('critic-check', verdictFile({ verdict: 'APROBAR', assumptions: [...src, { assumption: 'x', practice: 'sin fuente', sources: [] }], findings: [] })).code).toBe(0);
  });

  it('critic-check: research requests only in the first session, at most 2', () => {
    const asks = verdictFile({ research_requests: ['¿q1?'] });
    expect(JSON.parse(run('critic-check', asks, '--allow-requests').out)).toEqual({ research_requests: ['¿q1?'] });
    expect(run('critic-check', asks).out).toContain('research_requests are not allowed in this session: give a verdict');
    expect(run('critic-check', verdictFile({ research_requests: ['a', 'b', 'c'] }), '--allow-requests').out).toContain('research_requests must be 1 or 2 non-empty questions');
    expect(run('critic-check', join(root, 'spec/SPEC.md')).out).toContain('no JSON object with "verdict"');
  });

  it('set-plan-review stores the check; question-check validates a researcher answer', () => {
    const check = join(root, 'check.json');
    writeFileSync(check, run('critic-check', verdictFile({ verdict: 'APROBAR', assumptions: src, findings: [] })).out);
    expect(run('set-plan-review', 'T-04', check, '--plan-sha', 'b'.repeat(40), '--plan-commit', 'abc1234', '--round', '1', '--critic', 'stub')).toMatchObject({ code: 0, out: 'APROBAR\n' });
    expect(task(readTasks(), 'T-04').plan_review).toMatchObject({ critic: 'stub', effective: 'APROBAR', plan: 'plans/T-04.md', round: 1 });
    expect(run('set-plan-review', 'T-03', check, '--plan-sha', 'b'.repeat(40), '--plan-commit', 'abc1234', '--round', '1').err).toContain('spec task');
    const q = join(root, 'q.md');
    writeFileSync(q, '# I\n## Pregunta\nq\n## Respuesta\nr\n## Fuentes\n- https://example.com\n');
    expect(run('question-check', q).code).toBe(0);
    writeFileSync(q, '# I\n## Pregunta\nq\n## Respuesta\n\n## Fuentes\n- un libro\n');
    expect(run('question-check', q).out).toContain('missing or empty "## Respuesta" section');
    expect(run('question-check', q).out).toContain('"## Fuentes" cites no URL');
  });
});

describe('additive tests/acceptance/ diff (acceptanceDiffProblems)', () => {
  const Z = '0'.repeat(40);
  const S = 'a'.repeat(40);
  const raw = (...entries) => entries.map(([meta, ...paths]) => [`:${meta}`, ...paths].join('\0')).join('\0') + '\0';
  const problems = ({ entries = [], numstat = [], changed = [], runnerFiles = ['package.json', 'jest.config.*', '.github/workflows/*'] }) =>
    acceptanceDiffProblems({ raw: raw(...entries), numstat: numstat.map((n) => `${n}\0`).join(''), changed, runnerFiles });

  it('new files and added lines with no runner configuration are additive', () => {
    expect(problems({
      entries: [[`000000 100644 ${Z} ${S} A`, 'tests/acceptance/req_001.test.js'], [`100644 100644 ${S} ${S} M`, 'tests/acceptance/req_002.test.js']],
      numstat: ['12\t0\ttests/acceptance/req_001.test.js', '3\t0\ttests/acceptance/req_002.test.js'],
      changed: ['tests/acceptance/req_001.test.js', 'tests/acceptance/req_002.test.js', 'src/app.js', 'tests/acceptance/package.json'],
    })).toEqual([]);
  });

  it('lists deletions, renames, copies, mode and type changes, deleted lines and binary changes', () => {
    expect(problems({
      entries: [
        [`100644 000000 ${S} ${Z} D`, 'tests/acceptance/a.js'],
        [`100644 100644 ${S} ${S} R100`, 'tests/acceptance/b.js', 'tests/acceptance/c.js'],
        [`100644 100644 ${S} ${S} C090`, 'tests/acceptance/d.js', 'tests/acceptance/e.js'],
        [`100644 100755 ${S} ${S} M`, 'tests/acceptance/f.js'],
        [`100644 120000 ${S} ${S} T`, 'tests/acceptance/g.js'],
        [`000000 120000 ${Z} ${S} A`, 'tests/acceptance/link'],
      ],
      numstat: ['1\t2\ttests/acceptance/h.js', '-\t-\ttests/acceptance/data.bin'],
    })).toEqual([
      'tests/acceptance/a.js: deleted',
      'tests/acceptance/b.js: renamed to tests/acceptance/c.js',
      'tests/acceptance/d.js: copied to tests/acceptance/e.js',
      'tests/acceptance/f.js: mode change 100644 → 100755',
      'tests/acceptance/g.js: change of type T',
      'tests/acceptance/link: new entry is not a regular file (mode 120000)',
      'tests/acceptance/h.js: 2 line(s) deleted',
      'tests/acceptance/data.bin: binary change (lines cannot be counted)',
    ]);
  });

  it('a diff without changes under tests/acceptance/ is not an additive acceptance diff', () => {
    expect(problems({ changed: ['src/app.js'] })).toEqual(['no change under tests/acceptance/']);
  });

  it('runner configuration outside tests/acceptance/: by file name anywhere, or by path when the glob has "/"', () => {
    expect(problems({
      entries: [[`000000 100644 ${Z} ${S} A`, 'tests/acceptance/x.js']],
      numstat: ['1\t0\ttests/acceptance/x.js'],
      changed: ['tests/acceptance/x.js', 'package.json', 'apps/web/jest.config.ts', '.github/workflows/ci.yml', 'docs/.github/workflows/x.yml', 'package.json.bak'],
    })).toEqual([
      'package.json: test-runner configuration (package.json) changed outside tests/acceptance/',
      'apps/web/jest.config.ts: test-runner configuration (jest.config.*) changed outside tests/acceptance/',
      '.github/workflows/ci.yml: test-runner configuration (.github/workflows/*) changed outside tests/acceptance/',
    ]);
  });

  it('globMatches: * and ? stay within a segment', () => {
    expect(globMatches('jest.config.*', 'a/b/jest.config.js')).toBe(true);
    expect(globMatches('.github/workflows/*', '.github/workflows/sub/x.yml')).toBe(false);
    expect(globMatches('tsconfig*.json', 'tsconfig.build.json')).toBe(true);
    expect(globMatches('package.json', 'packageXjson')).toBe(false);
  });
});

describe('autopilot-tasks scope-check', () => {
  const check = (id, paths) => spawnSync('node', [SCRIPT, '--root', root, 'scope-check', id], { input: paths.join('\n') + '\n', encoding: 'utf8' });

  it('accepts paths covered by touches (a directory covers everything below it, by segments)', () => {
    expect(check('T-07', ['app/src/catalog/x.ts', 'app/src/catalog/deep/y.ts', 'README.md']).status).toBe(0);
    expect(check('T-08', ['scripts/autopilot.sh', 'scripts/lib/a.mjs']).status).toBe(0);
    expect(check('T-07', []).status).toBe(0);
  });

  it('lists spec/ and paths outside touches (apps/ is not app/, README.md.bak is not README.md)', () => {
    const r = check('T-07', ['spec/TASKS.json', 'app/src/catalogs/x.ts', 'README.md.bak', 'app/src/catalog/ok.ts', 'spec/contracts/api.yaml']);
    expect(r.status).toBe(1);
    expect(r.stdout.trim().split('\n')).toEqual([
      'spec/TASKS.json (spec/ belongs to the orchestrator)',
      'app/src/catalogs/x.ts (outside touches: app/src/catalog/, README.md)',
      'README.md.bak (outside touches: app/src/catalog/, README.md)',
      'spec/contracts/api.yaml (spec/ belongs to the orchestrator)',
    ]);
  });

  it('a file entry does not cover its siblings; a task without touches covers nothing', () => {
    expect(check('T-05', ['app/src/orders/other.ts']).status).toBe(1);
    editTasks((ts) => { delete task(ts, 'T-05').touches; });
    expect(check('T-05', ['app/src/orders/discounts.ts']).stdout).toContain('outside touches: none declared');
  });
});

describe('autopilot-tasks check-result / apply-result', () => {
  const resultFile = (r) => {
    const f = join(root, 'result.json');
    writeFileSync(f, typeof r === 'string' ? r : JSON.stringify(r));
    return f;
  };
  // DEC-014 (T-34): the result carries no status and no evidence; claims are the implementer's declarations.
  const ok = { log: '- Hecho: T-04.\n- Próxima acción autorizada: revisar.', claims: { manual_pending: 'REQ-002 E3 a mano', verified: 'npm test' } };
  const errOf = (r) => run('check-result', 'T-04', resultFile(r));

  it('normalizes a valid result: outcome finished by default, claims kept as declared', () => {
    expect(JSON.parse(errOf(ok).out)).toEqual({
      outcome: 'finished', blocked_by: null, claims: ok.claims, log: ok.log, log_discarded: [], log_trimmed: [], notes: null, assumptions: [],
      deploy: null, deploy_pending: false, test_dispute: null, block: null, missing_requirement: null,
    });
    expect(JSON.parse(errOf({ outcome: 'unfinished', log: '- Sigue.' }).out).outcome).toBe('unfinished');
  });

  it('a pending deploy is the structured "deploy" {what, then}, never a line of the log (T-39)', () => {
    const deploy = { what: 'la API (sam deploy)', then: 'npm run test:acceptance' };
    expect(JSON.parse(errOf({ ...ok, deploy }).out)).toMatchObject({ deploy, deploy_pending: true });
    expect(JSON.parse(errOf({ ...ok, deploy: { what: 'la API' } }).out).deploy).toEqual({ what: 'la API', then: null });
    for (const [r, why] of [
      [{ ...ok, log: '- Hecho: x\n- Pendiente deploy: desplegar la API' }, '"log" must not carry a "Pendiente deploy" line'],
      [{ ...ok, log: '- Pendiente deploy: ninguno' }, '"log" must not carry a "Pendiente deploy" line'],
      [{ ...ok, deploy: 'la API' }, '"deploy" must be {"what", "then"?}'],
      [{ ...ok, deploy: { what: ' ' } }, '"deploy" must be {"what", "then"?}'],
      [{ ...ok, deploy, blocked_by: 'Q-01' }, '"deploy" goes with no "blocked_by" or "outcome"'],
      [{ ...ok, deploy, outcome: 'unfinished' }, '"deploy" goes with no "blocked_by" or "outcome"'],
    ]) expect(errOf(r)).toMatchObject({ code: 1, err: expect.stringContaining(why) });
    // applied: the orchestrator writes the LOG.md line from the field
    run('apply-result', 'T-04', resultFile({ ...ok, deploy }), '--agent', 'implementador de T-04', '--status', 'in_progress');
    expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toMatch(/- Hecho: T-04\.\n- Pendiente deploy: la API \(sam deploy\); después: npm run test:acceptance\.\n- Próxima acción autorizada: revisar\.\n$/);
  });

  it('"status" and "evidence" are not the implementer\'s (DEC-014): a reserved status is an authority violation, any other one an error', () => {
    for (const status of ['reviewed', 'accepted', 'approved_for_impl', 'delivered']) {
      const r = run('check-result', 'T-02', resultFile({ status, junk: 1 }));
      expect(r).toMatchObject({ code: 3, err: expect.stringContaining(`T-02: verified_auto → ${status}`) });
    }
    expect(errOf({ ...ok, status: 'verified_auto' })).toMatchObject({ code: 1, err: expect.stringContaining('"status" is not the implementer\'s (DEC-014)') });
    expect(errOf({ ...ok, evidence: { command: 'npm test', result: '25 pasan', commit: 'abc' } }))
      .toMatchObject({ code: 1, err: expect.stringContaining('"evidence" is written only by record_evidence.py (DEC-014)') });
  });

  it('awaiting_acceptance_approval only on a spec task; blocked_by excludes an outcome', () => {
    expect(errOf({ ...ok, outcome: 'awaiting_acceptance_approval' }).err).toContain('"awaiting_acceptance_approval" is only for a spec task');
    editTasks((ts) => { task(ts, 'T-04').kind = 'spec'; });
    expect(JSON.parse(errOf({ ...ok, outcome: 'awaiting_acceptance_approval' }).out).outcome).toBe('awaiting_acceptance_approval');
    expect(errOf({ ...ok, outcome: 'unfinished', blocked_by: 'Q-01' }).err).toContain('"blocked_by" declares a block: no "outcome" with it');
    expect(JSON.parse(errOf({ blocked_by: 'Q-01', log: '- Bloqueada.' }).out)).toMatchObject({ outcome: 'blocked', blocked_by: 'Q-01' });
  });

  it('missing_requirement (DEC-011): {lines, reason}, only with blocked_by; applied as a note', () => {
    mkdirSync(join(root, 'app/src/orders'), { recursive: true });
    writeFileSync(join(root, 'app/src/orders/a.ts'), 'a\nb\nc\nd\ne\n');
    const missing = { lines: 'app/src/orders/a.ts:3-5', reason: 'valida un caso que ningún REQ pide' };
    const blocked = { blocked_by: 'REQ-002', log: '- Hecho: falta un requisito.', missing_requirement: missing };
    expect(JSON.parse(errOf(blocked).out).missing_requirement).toEqual(missing);
    expect(errOf({ ...ok, missing_requirement: missing }).err).toContain('"missing_requirement" is only allowed with "blocked_by"');
    expect(errOf({ ...blocked, missing_requirement: { lines: '' } }).err).toContain('"missing_requirement" must be {"lines", "reason"}');
    expect(run('apply-result', 'T-04', resultFile(blocked), '--agent', 'stub', '--status', 'blocked').code).toBe(0);
    expect(task(readTasks(), 'T-04').notes).toContain('falta un requisito según el implementador para app/src/orders/a.ts:3-5: valida un caso que ningún REQ pide (DEC-011).');
  });

  it('the missing lines are a fact to check (T-40): <path>:<line>[-<line>] of an existing file in the task\'s touches, within its length', () => {
    mkdirSync(join(root, 'app/src/orders'), { recursive: true });
    writeFileSync(join(root, 'app/src/orders/a.ts'), 'a\nb\nc\n');
    writeFileSync(join(root, 'README.md'), 'x\n');
    const m = (lines) => errOf({ blocked_by: 'REQ-002', log: '- Hecho: x.', missing_requirement: { lines, reason: 'r' } });
    expect(m('app/src/orders/a.ts:2').code).toBe(0);
    expect(m('app/src/orders/a.ts:2, app/src/orders/a.ts:3').code).toBe(0);
    expect(m('en algún lado').err).toContain('"missing_requirement.lines" must be <path>:<line>[-<line>]');
    expect(m('app/src/orders/b.ts:1').err).toContain('app/src/orders/b.ts does not exist');
    expect(m('README.md:1').err).toContain('README.md is outside T-04\'s touches');
    expect(m('app/src/orders/a.ts:2-9').err).toContain('app/src/orders/a.ts:2-9 is beyond its 3 lines');
  });

  it('missing or invalid results fail (exit 1) with every reason listed', () => {
    expect(run('check-result', 'T-04', join(root, 'nope.json'))).toMatchObject({ code: 1, err: expect.stringContaining('left no result in') });
    expect(errOf('{"log":')).toMatchObject({ code: 1, err: expect.stringContaining('not valid JSON') });
    expect(errOf('[1]')).toMatchObject({ code: 1, err: expect.stringContaining('must be a JSON object') });
    for (const [r, why] of [
      [{ ...ok, state: 'x' }, 'unknown key "state"'],
      [{ ...ok, outcome: 'done' }, '"outcome" must be one of finished, unfinished, awaiting_acceptance_approval'],
      [{ ...ok, claims: 'npm test ok' }, '"claims" must be an object of strings'],
      [{ ...ok, claims: { manual_pending: 3 } }, 'claims.manual_pending must be a string'],
      [{ ...ok, blocked_by: ' ' }, '"blocked_by" must be a non-empty string'],
      [{ ...ok, log: ' ' }, '"log" must be a non-empty string'],
      [{ ...ok, log: '- Hecho\n## otra entrada' }, '"log" must not contain headings'],
      [{ ...ok, notes: 3 }, '"notes" must be a string'],
      [{ ...ok, assumptions: {} }, '"assumptions" must be an array'],
      [{ ...ok, assumptions: [{ id: 'X-1', belief: 'a', default: 'b', class: 'c', trigger: 'd' }] }, 'assumptions[0].id must be S-NN'],
      [{ ...ok, assumptions: [{ id: 'S-01', belief: 'a', default: 'b', class: 'c' }] }, 'assumptions[0].trigger must be a non-empty string'],
      [{ ...ok, assumptions: [{ id: 'S-01', belief: 'a', default: 'b', class: 'c', trigger: 'd', extra: 1 }] }, 'assumptions[0]: unknown key "extra"'],
      [{ ...ok, assumptions: [1] }, 'assumptions[0] must be an object'],
    ]) {
      expect(errOf(r)).toMatchObject({ code: 1, err: expect.stringContaining(why) });
    }
  });

  it('"log" states no test results (T-35, T-117): "Verificado" lines and counts are dropped, never kept; a log left empty is rejected', () => {
    const checked = (log) => JSON.parse(errOf({ ...ok, log }).out);
    for (const log of ['- Verificado y cómo: `npm test` → ok.', '- Hecho: 3 tests passed.', '- Hecho: 12/12 en verde.', '- Hecho: 1 falla.']) {
      expect(checked(`${log}\n- Próxima acción autorizada: revisar.`)).toMatchObject({ log: '- Próxima acción autorizada: revisar.', log_discarded: [log], log_trimmed: [] });
      expect(errOf({ ...ok, log })).toMatchObject({ code: 1, err: expect.stringContaining('"log" is left empty once its test results are dropped') });
    }
    for (const log of ['- Hecho: REQ-002 E3 y T-04 (2026-10-21).', '- Hecho: dos archivos nuevos.\n- Próxima acción autorizada: revisar.']) {
      expect(checked(log)).toMatchObject({ log, log_discarded: [], log_trimmed: [] });
    }
  });

  it('T-117: a "- Verificado: … 12/12" line is discarded and listed; the rest of the result is applied', () => {
    const log = '- Hecho: parser nuevo.\n- Verificado: `npm test` → 12/12.\n- Próxima acción autorizada: revisar.';
    const r = errOf({ ...ok, log, notes: 'Interpretación: x.' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      log: '- Hecho: parser nuevo.\n- Próxima acción autorizada: revisar.', log_discarded: ['- Verificado: `npm test` → 12/12.'], log_trimmed: [], notes: 'Interpretación: x.',
    });
  });

  it('T-117: a count inside a line with other content is cut out, keeping the rest; with nothing meaningful left the line goes', () => {
    const cut = (line) => JSON.parse(errOf({ ...ok, log: `${line}\n- Próxima acción autorizada: revisar.` }).out);
    expect(cut('- Hecho: parser nuevo en lib/a.mjs; npm test → 25 pasan.')).toMatchObject({
      log: '- Hecho: parser nuevo en lib/a.mjs.\n- Próxima acción autorizada: revisar.', log_trimmed: ['- Hecho: parser nuevo en lib/a.mjs; npm test → 25 pasan.'], log_discarded: [],
    });
    expect(cut('- Hecho: parser nuevo (25 pasan), sin dependencias.').log).toBe('- Hecho: parser nuevo, sin dependencias.\n- Próxima acción autorizada: revisar.');
    expect(cut('- Hecho: 25 pasan; 0 fallan.')).toMatchObject({ log: '- Próxima acción autorizada: revisar.', log_discarded: ['- Hecho: 25 pasan; 0 fallan.'] });
  });

  it('T-117: other format errors are still rejected (invalid JSON, unknown keys, invalid outcome)', () => {
    expect(errOf('{"log": "- Verificado: 12/12"')).toMatchObject({ code: 1, err: expect.stringContaining('not valid JSON') });
    expect(errOf({ ...ok, log: '- Hecho: x; 25 pasan.', junk: 1 })).toMatchObject({ code: 1, err: expect.stringContaining('unknown key "junk"') });
    expect(errOf({ ...ok, log: '- Verificado: 12/12.\n- Hecho: x.', outcome: 'done' })).toMatchObject({ code: 1, err: expect.stringContaining('"outcome" must be one of') });
  });

  it('T-117: no dropped line reaches spec/LOG.md; the orchestrator warns in live.log and the run summary', () => {
    const log = '- Hecho: parser nuevo; npm test → 25 pasan.\n- Verificado y cómo: `npm test` → 12/12.\n- Próxima acción autorizada: revisar.';
    expect(run('apply-result', 'T-04', resultFile({ ...ok, log }), '--agent', 'implementador de T-04', '--status', 'in_progress').code).toBe(0);
    const written = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
    expect(written).toMatch(/· implementador de T-04\n- Hecho: parser nuevo\.\n- Próxima acción autorizada: revisar\.\n$/);
    for (const gone of ['25 pasan', '12/12', 'Verificado']) expect(written).not.toContain(gone);
    const sh = readFileSync(new URL('../autopilot.sh', import.meta.url), 'utf8');
    expect(sh).toContain('line(s) with test results discarded (DEC-014, T-117)');
    expect(sh).toMatch(/while IFS= read -r line; do log "\$id: \$line"; done <<<"\$dropped"/);
    expect(sh).toContain('summary "$id: del log del implementador se descartaron $nd línea(s)');
  });

  it('verified-line prints the verification line from the evidence record_evidence.py wrote; log-verified adds it to the last LOG.md entry', () => {
    editTasks((ts) => { task(ts, 'T-04').evidence = { command: 'npm test', result: '25/25 pasan, 0 fallan (código 0; registrado por record_evidence.py desde artifacts/T-04/verify.log)', commit: 'abc1234', log_sha256: 'x' }; });
    const line = '- Verificado y cómo: `npm test` → 25/25 pasan, 0 fallan (código 0; registrado por record_evidence.py desde artifacts/T-04/verify.log), commit abc1234.';
    expect(run('verified-line', 'T-04')).toMatchObject({ code: 0, out: `${line}\n` });
    run('apply-result', 'T-04', resultFile(ok), '--agent', 'implementador de T-04', '--status', 'in_progress');
    expect(run('log-verified', 'T-04').code).toBe(0);
    expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toMatch(new RegExp(`· implementador de T-04\\n- Hecho: T-04\\.\\n${line.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}\\n- Próxima acción autorizada: revisar\\.\\n$`));
    editTasks((ts) => { task(ts, 'T-05').evidence = { command: 'x', result: 'y', commit: 'z' }; }); // written by hand, before DEC-014
    expect(run('verified-line', 'T-05')).toMatchObject({ code: 1, err: expect.stringContaining('T-05 has no evidence recorded by record_evidence.py') });
  });

  it('assumption ids must be new; without a Supuestos table in SPEC.md they cannot be applied', () => {
    const a = (id) => ({ id, belief: 'a', default: 'b', class: 'c', trigger: 'd' });
    expect(errOf({ ...ok, assumptions: [a('S-01'), a('S-01')] }).err).toContain('assumptions[1].id S-01 already exists');
    const spec = join(root, 'spec/SPEC.md');
    writeFileSync(spec, readFileSync(spec, 'utf8').replace('|---|---|---|---|---|\n', '|---|---|---|---|---|\n| S-01 | x | y | z | w |\n'));
    expect(errOf({ ...ok, assumptions: [a('S-01')] }).err).toContain('assumptions[0].id S-01 already exists in spec/SPEC.md');
    writeFileSync(spec, '# SPEC\n## Requisitos\n### REQ-002 x\n');
    expect(errOf({ ...ok, assumptions: [a('S-02')] }).err).toContain('spec/SPEC.md has no "## Supuestos" table');
  });

  it('apply-result writes the status the orchestrator derived, claims, notes, a LOG.md entry and the assumption rows; never evidence', () => {
    editTasks((ts) => { task(ts, 'T-04').notes = 'Nota previa.'; });
    const before = task(readTasks(), 'T-04').evidence;
    const f = resultFile({ ...ok, notes: ' Interpretación: x. ', assumptions: [{ id: 'S-07', belief: 'dos\nlíneas | y', default: 'b', class: 'c', trigger: 'd' }] });
    expect(run('apply-result', 'T-04', f, '--agent', 'implementador de T-04', '--status', 'in_progress')).toMatchObject({ code: 0, out: 'in_progress\n' });
    expect(task(readTasks(), 'T-04')).toMatchObject({ status: 'in_progress', claims: ok.claims, blocked_by: null, notes: 'Nota previa. Interpretación: x.' });
    expect(task(readTasks(), 'T-04').evidence).toEqual(before);
    const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
    expect(log).toMatch(/\n\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · implementador de T-04\n- Hecho: T-04\.\n- Próxima acción autorizada: revisar\.\n$/);
    expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain('|---|---|---|---|---|\n| S-07 | dos líneas \\| y | b | c | d |\n');
    expect(run('check-result', 'T-04', resultFile({ ...ok, assumptions: [{ id: 'S-07', belief: 'a', default: 'b', class: 'c', trigger: 'd' }] })).code).toBe(1);
  });

  it('apply-result: --status is in_progress or blocked and must agree with blocked_by; nothing is written if invalid', () => {
    editTasks((ts) => { task(ts, 'T-02').status = 'in_progress'; });
    run('apply-result', 'T-02', resultFile({ blocked_by: 'Q-01', log: '- Bloqueada.' }), '--agent', 'x', '--status', 'blocked');
    expect(task(readTasks(), 'T-02')).toMatchObject({ status: 'blocked', blocked_by: 'Q-01', evidence: { commit: '0000000' } });
    run('apply-result', 'T-02', resultFile({ outcome: 'unfinished', log: '- Sigue.' }), '--agent', 'x', '--status', 'in_progress');
    expect(task(readTasks(), 'T-02')).toMatchObject({ status: 'in_progress', blocked_by: null });
    const before = readFileSync(join(root, 'spec/TASKS.json'), 'utf8') + readFileSync(join(root, 'spec/LOG.md'), 'utf8');
    expect(run('apply-result', 'T-02', resultFile({ status: 'accepted', log: '- x' }), '--agent', 'x', '--status', 'in_progress').code).toBe(3);
    expect(run('apply-result', 'T-02', resultFile({ log: '- x' }), '--agent', 'x', '--status', 'verified_auto').code).toBe(2); // record_evidence.py's
    expect(run('apply-result', 'T-02', resultFile({ log: '- x' }), '--agent', 'x', '--status', 'blocked').code).toBe(2); // no blocked_by
    expect(run('apply-result', 'T-02', resultFile({ blocked_by: 'Q-01', log: '- x' }), '--agent', 'x', '--status', 'in_progress').code).toBe(2);
    expect(run('apply-result', 'T-02', resultFile({ log: '- x' }), '--status', 'in_progress').code).toBe(2); // no --agent
    expect(readFileSync(join(root, 'spec/TASKS.json'), 'utf8') + readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toBe(before);
  });
});

describe('autopilot.sh', () => {
  it('is executable and --help describes the cycle', () => {
    expect(spawnSync('test', ['-x', AUTOPILOT_SH]).status).toBe(0);
    const r = spawnSync(AUTOPILOT_SH, ['--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('Never pushes unless AUTOPILOT_PUSH_REMOTE is set');
    expect(r.stdout).toContain('Do not enable it on a branch that deploys to');
  });

  const gitIn = (dir) => (...a) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });

  describe('--dry-run', () => {
    let bin;
    beforeEach(() => { bin = stubBin(); });
    afterEach(() => rmSync(bin, { recursive: true, force: true }));
    const dryRun = (env = {}) =>
      spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--dry-run'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      });
    const fixtureRepo = () => { // minimal copy: the orchestrator and the fixed spec/, in a temporary git with a clean tree
      copyAutopilot();
      const git = gitIn(root);
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
      editTasks((ts) => { task(ts, 'T-01').status = 'accepted'; task(ts, 'T-03').status = 'ready'; });
      git('commit', '-q', '-am', 'ready\n\nTask: none\nReq: none');
      return git;
    };

    it('T-83: the implementer prompt forbids "- Verificado" lines and test counts in "log" (DEC-014)', () => {
      fixtureRepo();
      const r = dryRun();
      expect(r.status).toBe(0);
      const prompt = r.stdout.match(/prompt \(stdin\): (.*)/)[1].replace(/\\(.)/g, '$1');
      expect(prompt).toContain('no test results: no "- Verificado" line and no counts such as "25 pasan" or "12/12"');
      expect(prompt).toContain('rejects a log that states test results');
      expect(prompt).not.toContain('no test counts: the orchestrator records them');
    });

    it('launches nothing and does not modify the repo (no configuration: defaults)', () => {
      const git = fixtureRepo();
      const head = git('rev-parse', 'HEAD');
      const r = dryRun();
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Configuration: no file');
      expect(r.stdout).toContain('orchestrator commits with Task: none');
      expect(r.stdout).toContain('Environment guards: AUTOPILOT=1 CI=1');
      expect(r.stdout).toContain('Pending reviews before picking a task (verified_auto, reviewer claude): T-02');
      expect(r.stdout).toContain('Chosen task: T-03');
      expect(r.stdout).toContain('prompt (stdin): Read\\ AGENTS.md\\ and\\ execute\\ T-03');
      expect(r.stdout).toContain('--disallowedTools');
      expect(r.stdout).toContain('Bash\\(git\\ push\\*\\)');
      expect(r.stdout).toContain('Bash\\(npm\\ run\\ deploy\\*\\)');
      expect(r.stdout).toContain('Bash\\(rm\\ \\*\\)');
      expect(r.stdout).toContain('--output-format stream-json --verbose');
      expect(r.stdout).toContain('no\\ \\`\\&\\&\\`\\ and\\ no\\ \\`cd\\`');
      expect(r.stdout).toContain('add\\ \\"deploy\\"\\ \\(\\{\\"what\\":'); // T-39: a field, not a line of the log
      // Result protocol: no spec/, the task's touches and the result file are in the prompt.
      expect(r.stdout).toContain('you\\ do\\ not\\ edit\\ spec/');
      expect(r.stdout).toContain("touches\\ \\(tests/acceptance/\\)");
      expect(r.stdout).toMatch(/AUTOPILOT_RESULT=\S+\/T-03-result-1\.json/);
      expect(r.stdout).toMatch(/to\\ the\\ file\\ \S+\/T-03-result-1\.json\\ \\\(also\\ in\\ \\\$AUTOPILOT_RESULT\\\)/);
      expect(r.stdout).toContain('touches [tests/acceptance/]');
      expect(r.stdout).toContain('commits that touch neither spec/ nor paths outside touches');
      expect(r.stdout).toContain('- Pendiente deploy (lo hace el usuario; el orquestador no despliega): ninguna.');
      expect(r.stdout).toContain('Entry that would be added to spec/LOG.md');
      expect(r.stdout).toContain('Push after review: off (AUTOPILOT_PUSH_REMOTE is empty)');
      expect(r.stdout).toContain('Demo deploy: off (AUTOPILOT_DEMO_DEPLOY_CMD is empty)');
      expect(r.stdout).not.toContain('- Despliegue demo');
      expect(r.stdout).toContain('Acceptance review: off (AUTOPILOT_ACCEPTANCE_REVIEW is empty; the user approves every tests/acceptance/ diff)');
      expect(r.stdout).not.toContain('- Aprobación de tests/acceptance/');
      expect(r.stdout).toContain('El orquestador no marca accepted ni hace push.');
      expect(r.stdout).not.toContain('- Push tras revisión');
      expect(git('status', '--porcelain')).toBe('');
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).not.toContain('autopilot (scripts/autopilot.sh)');
    });

    it('applies scripts/autopilot.config.sh: prompt, permissions, deploy, orchestrator task and environment hooks', () => {
      copyAutopilot();
      writeFileSync(join(root, 'scripts/autopilot.config.sh'), [
        'AUTOPILOT_TASK=T-08',
        "AUTOPILOT_IMPL_PROMPT_EXTRA='Run acceptance with make acceptance.'",
        'AUTOPILOT_IMPL_ALLOWED_EXTRA=("Bash(make acceptance*)")',
        'AUTOPILOT_IMPL_DENIED_EXTRA=("Bash(make deploy*)")',
        "AUTOPILOT_DEPLOY_CMD='make deploy'",
        'autopilot_env() { unset USER_SECRET; export AUTOPILOT_PROBE=test-value; }',
        'autopilot_env_info() { echo "probe=$AUTOPILOT_PROBE secret=${USER_SECRET:-absent}"; }',
        '',
      ].join('\n'));
      const git = gitIn(root);
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
      const r = dryRun({ USER_SECRET: 'must-not-show' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Configuration: ${join(root, 'scripts/autopilot.config.sh')}`);
      expect(r.stdout).toContain('orchestrator commits with Task: T-08');
      expect(r.stdout).toContain('Environment guards: AUTOPILOT=1 CI=1; probe=test-value secret=absent');
      expect(r.stdout).not.toContain('must-not-show');
      expect(r.stdout).toContain('Run\\ acceptance\\ with\\ make\\ acceptance.');
      expect(r.stdout).toContain('Bash\\(make\\ acceptance\\*\\)');
      expect(r.stdout).toContain('Bash\\(make\\ deploy\\*\\)');
      expect(r.stdout).toContain('- Pendiente deploy (el usuario corre `make deploy`; el orquestador no despliega): ninguna.');
    });

    it('with AUTOPILOT_PUSH_REMOTE it shows the push after review (default branch: the one the run starts on); it pushes nothing', () => {
      const git = fixtureRepo();
      const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const r = dryRun({ AUTOPILOT_PUSH_REMOTE: 'origin' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Push after review (DEC-004): the orchestrator runs \`git push origin HEAD:${branch}\` (no --force) after each approved verdict`);
      expect(r.stdout).toContain(`- Push tras revisión (DEC-004; \`git push origin HEAD:${branch}\`): tareas empujadas: ninguna.`);
      const other = dryRun({ AUTOPILOT_PUSH_REMOTE: 'origin', AUTOPILOT_PUSH_BRANCH: 'reviewed' });
      expect(other.stdout).toContain('`git push origin HEAD:reviewed`');
    });

    it('with AUTOPILOT_DEMO_DEPLOY_CMD it shows the demo deploy and warns about missing hooks and identities; it runs nothing', () => {
      fixtureRepo();
      const marker = join(root, '..', `${root.split('/').pop()}-dry-deploy`);
      const r = dryRun({ AUTOPILOT_DEMO_DEPLOY_CMD: `touch ${marker}` });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Demo deploy (DEC-004): on a Pendiente deploy result the orchestrator runs autopilot_deploy_env and autopilot_deploy_identity in a subshell, deploys with \`touch ${marker}\` only if the identity is one of the 0 in AUTOPILOT_DEMO_ACCOUNTS`);
      expect(r.stdout).toContain('warning: missing hook(s): autopilot_deploy_env, autopilot_deploy_identity');
      expect(r.stdout).toContain('warning: AUTOPILOT_DEMO_ACCOUNTS is empty');
      expect(r.stdout).toContain('el orquestador solo despliega en cuentas demo con identidad comprobada): ninguna.');
      expect(r.stdout).toContain('- Despliegue demo (DEC-004; `touch');
      expect(spawnSync('test', ['-e', marker]).status).not.toBe(0);
    });

    it('with AUTOPILOT_ACCEPTANCE_REVIEW=additive it shows the acceptance review and the runner configuration; an invalid value stops', () => {
      fixtureRepo();
      const r = dryRun({ AUTOPILOT_ACCEPTANCE_REVIEW: 'additive' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Acceptance review (DEC-004): when a spec task stays in_progress with commits, the orchestrator checks that its tests/acceptance/ diff is additive');
      expect(r.stdout).toContain('test-runner configuration: package.json jest.config.* vitest.config.*');
      expect(r.stdout).toContain('- Aprobación de tests/acceptance/ por el revisor (DEC-004; solo diffs aditivos): aprobadas y relanzadas: ninguna; quedan para el usuario (motivo en Hecho): ninguna.');
      const bad = dryRun({ AUTOPILOT_ACCEPTANCE_REVIEW: 'yes' });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('invalid AUTOPILOT_ACCEPTANCE_REVIEW: yes (additive, or empty/off)');
    });

    it('with AUTOPILOT_RESEARCH it shows the researcher, its command and its caps (higher for deep); invalid values stop', () => {
      fixtureRepo();
      const web = dryRun({ AUTOPILOT_RESEARCH: 'web' });
      expect(web.status).toBe(0);
      expect(web.stdout).toContain('Researcher (DEC-005, mode web): on the second failure of a task in the run the orchestrator launches it (never the implementer) with caps of 900 s (or what the run has left) and US$ 2 per invocation');
      // the researcher's command, through the claude adapter; "allowed" is what comes before --disallowedTools
      const researcherLine = (out) => out.split('\n').find((l) => l.includes('Write\\(./research/T-NN.md\\)'));
      const allowedOf = (line) => line.split('--disallowedTools')[0];
      expect(researcherLine(web.stdout)).toContain('claude -p --no-session-persistence');
      expect(researcherLine(web.stdout)).toContain('--allowedTools Read Glob Grep Write\\(./research/T-NN.md\\) Edit\\(./research/T-NN.md\\)');
      expect(allowedOf(researcherLine(web.stdout))).toContain(' WebSearch WebFetch ');
      expect(web.stdout).toContain('--max-budget-usd 2');
      expect(allowedOf(researcherLine(web.stdout))).not.toContain(' Agent ');
      expect(web.stdout).toContain('- Investigador (DEC-005; modo web, topes 900 s y US$ 2 por invocación): investigadas: ninguna;');
      expect(web.stdout).not.toMatch(/prompt \(stdin\): Read[^\n]*research/); // the implementer's prompt does not mention it
      const deep = dryRun({ AUTOPILOT_RESEARCH: 'deep' });
      expect(deep.stdout).toContain('caps of 2700 s (or what the run has left) and US$ 10 per invocation');
      expect(allowedOf(researcherLine(deep.stdout))).toContain(' WebSearch WebFetch Agent ');
      const custom = dryRun({ AUTOPILOT_RESEARCH: 'deep', AUTOPILOT_RESEARCH_DEEP_SECONDS: '1200', AUTOPILOT_RESEARCH_DEEP_MAX_USD: '4.5' });
      expect(custom.stdout).toContain('caps of 1200 s (or what the run has left) and US$ 4.5 per invocation');
      expect(dryRun({}).stdout).toContain('Researcher: off (AUTOPILOT_RESEARCH is empty)');
      expect(dryRun({}).stdout).not.toContain('- Investigador');
      const bad = dryRun({ AUTOPILOT_RESEARCH: 'yes' });
      expect(bad).toMatchObject({ status: 1, stderr: expect.stringContaining('invalid AUTOPILOT_RESEARCH: yes (web, deep, or empty/off)') });
      expect(dryRun({ AUTOPILOT_RESEARCH: 'web', AUTOPILOT_RESEARCH_WEB_SECONDS: '0' }).stderr).toContain('invalid time cap for the web researcher: 0');
      expect(dryRun({ AUTOPILOT_RESEARCH: 'web', AUTOPILOT_RESEARCH_WEB_MAX_USD: '0' }).stderr).toContain('invalid cost cap for the web researcher: 0');
    });

    it('with AUTOPILOT_TEST_AUTHOR=on it shows the test-author and its command; it needs AUTOPILOT_ACCEPTANCE_CMD', () => {
      fixtureRepo();
      const r = dryRun({ AUTOPILOT_TEST_AUTHOR: 'on', AUTOPILOT_ACCEPTANCE_CMD: 'npx vitest run' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('agents: test_author claude, implementer claude, reviewer claude');
      expect(r.stdout).toContain('Test-author (DEC-006): before the implementer of a task with REQ that is not spec or tooling');
      const line = r.stdout.split('\n').find((l) => l.includes('Write\\(./tests/acceptance/T-NN.\\*\\)'));
      for (const part of ['--allowedTools Read\\(./spec/\\*\\*\\) Read\\(./tests/acceptance/\\*\\*\\)', 'Write\\(./tests/acceptance/T-NN/\\*\\*\\)',
        'Bash\\(npx\\ vitest\\ run\\ tests/acceptance/T-NN\\*\\)', '--disallowedTools Glob Grep']) expect(line).toContain(part);
      // reads inside the working directory need no allow rule, so everything else is denied (smoke test, T-18)
      const denied = line.split('--disallowedTools')[1];
      for (const part of ['Read\\(./scripts/\\*\\*\\)', 'Read\\(./.git/\\*\\*\\)']) expect(denied).toContain(part);
      expect(denied).not.toContain('Read\\(./spec/');
      expect(denied).not.toContain('Read\\(./tests/acceptance/');
      expect(r.stdout).toContain('- Test-author (DEC-006; `npx vitest run`): pruebas escritas en rojo: ninguna;');
      expect(dryRun({}).stdout).toContain('Test-author: off (AUTOPILOT_TEST_AUTHOR is empty; acceptance tests come from spec tasks)');
      expect(dryRun({ AUTOPILOT_TEST_AUTHOR: 'on' }).stderr).toContain('AUTOPILOT_TEST_AUTHOR=on needs AUTOPILOT_ACCEPTANCE_CMD');
      expect(dryRun({ AUTOPILOT_TEST_AUTHOR: 'yes' }).stderr).toContain('invalid AUTOPILOT_TEST_AUTHOR: yes (on, or empty/off)');
    });

    it('plan gate (DEC-010): off by default; on, it shows the planner and critic commands and needs valid caps', () => {
      fixtureRepo();
      expect(dryRun().stdout).toContain('Plan gate: off (AUTOPILOT_PLAN_GATE is empty)');
      const r = dryRun({ AUTOPILOT_PLAN_GATE: 'on' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('agents: planner claude, critic claude, implementer claude, reviewer claude, researcher claude');
      expect(r.stdout).toContain('Plan gate (DEC-010): before the implementer of a task that is not a spec task');
      const planner = r.stdout.split('\n').find((l) => l.startsWith('  planner: '));
      expect(planner).toContain('Write\\(./plans/T-NN.md\\)');
      const criticLine = r.stdout.split('\n').find((l) => l.startsWith('  critic: '));
      for (const part of ['Read\\(./spec/SPEC.md\\)', 'Read\\(./plans/T-NN.md\\)', 'WebSearch', '--max-budget-usd 3']) expect(criticLine).toContain(part);
      expect(dryRun({ AUTOPILOT_PLAN_GATE: 'yes' }).stderr).toContain('invalid AUTOPILOT_PLAN_GATE: yes (on, or empty/off)');
      expect(dryRun({ AUTOPILOT_PLAN_GATE: 'on', AUTOPILOT_CRITIC_MAX_USD: '0' }).stderr).toContain('invalid AUTOPILOT_CRITIC_MAX_USD: 0');
      expect(dryRun({ AUTOPILOT_PLAN_GATE: 'on', AUTOPILOT_PLANNER_SECONDS: 'x' }).stderr).toContain('invalid AUTOPILOT_PLANNER_SECONDS: x');
    });

    it('every role passes every explicit flag of the claude adapter (T-19): it fails if one goes missing', () => {
      fixtureRepo();
      const required = ['env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 DISABLE_AUTOUPDATER=1 claude -p ', ' --no-session-persistence ', ' --settings ', 'autoMemoryEnabled',
        'disableAllHooks\\":false', 'PreToolUse', 'claude-access-hook.mjs', '\\|\\|\\ exit\\ 2', " --setting-sources '' ", ' --strict-mcp-config ', ' --disable-slash-commands ', ' --append-system-prompt-file ',
        ' --agents ', ' --tools ', ' --permission-mode dontAsk ', ' --output-format stream-json --verbose ', ' --allowedTools ', ' --disallowedTools '];
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AUTOPILOT_RESEARCH: 'deep', AUTOPILOT_TEST_AUTHOR: 'on', AUTOPILOT_ACCEPTANCE_CMD: 'sh', AUTOPILOT_PLAN_GATE: 'on' };
      for (const role of ['implementer', 'reviewer', 'researcher', 'test_author', 'planner', 'critic']) {
        const r = spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--print-agent-command', role, '/tmp/x', 'T-03'], { encoding: 'utf8', env });
        expect(r.status).toBe(0);
        for (const flag of required) {
          if (!r.stdout.includes(flag)) throw new Error(`the ${role} command lacks ${flag.trim()}: ${r.stdout}`);
        }
        expect(r.stdout).toContain(`scripts/agents/roles/${role}.md`);
      }
    });

    it('the claude adapter runs only the pinned Claude Code version', () => {
      fixtureRepo();
      const r = dryRun({ AUTOPILOT_CLAUDE_VERSION: '2.1.295' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('claude cannot run for the implementer role: claude 0.0.0 is not the pinned 2.1.295 (AUTOPILOT_CLAUDE_VERSION): run scripts/agents/claude-smoke.sh with it and update the pin');
    });

    it('the implementer cannot skip the commit hook: the access guard checks the options, not glob rules on the text (DEC-027, T-70, T-74)', () => {
      fixtureRepo();
      const args = spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--print-agent-command', 'implementer', '/tmp/x', 'T-04'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).stdout;
      const denied = args.slice(args.indexOf('--disallowedTools'));
      // T-74: the glob rules of T-70 also denied a message with " -n" or "--no-verify": the access guard checks the options
      for (const rule of ['commit\\*--no-verify', 'commit\\*\\ -n', 'push\\*--no-verify', 'core.hooksPath\\*']) expect(denied).not.toContain(rule);
      expect(denied).toContain('Bash\\(git\\ push\\*\\)');   // push stays denied as a whole
      expect(args).toContain('claude-access-hook.mjs');   // the guard, in every tool call
    });

    it('the implementer of a task that is not spec cannot write tests/acceptance/ (--deny-write in its guard); a spec task can (DEC-027, T-59)', () => {
      fixtureRepo();
      const cmd = (id) => spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--print-agent-command', 'implementer', '/tmp/x', id], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).stdout;
      expect(cmd('T-04')).toContain('--deny-write\\ tests/acceptance/'); // inside the --settings JSON, escaped
      expect(cmd('T-03')).not.toContain('--deny-write'); // T-03 is a spec task
    });

    it('the test-author may write its result file and nothing else outside tests/acceptance/<ID>*; the implementer is unchanged (T-99)', () => {
      fixtureRepo();
      const cmd = (role, result) => spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--print-agent-command', role, '/tmp/x', 'T-03'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AUTOPILOT_TEST_AUTHOR: 'on', AUTOPILOT_ACCEPTANCE_CMD: 'sh',
          ...(result ? { AUTOPILOT_RESULT: result } : {}) } }).stdout;
      const allowed = (s) => s.slice(s.indexOf('--allowedTools'), s.indexOf('--disallowedTools'));
      const author = allowed(cmd('test_author', '/tmp/x/T-03-tests-result.json'));
      expect(author).toContain('Write\\(//tmp/x/T-03-tests-result.json\\)');
      expect(author).toContain('Edit\\(//tmp/x/T-03-tests-result.json\\)');
      expect(author).not.toContain('Write\\(//tmp/x/\\*\\*\\)');   // the file, not the directory
      expect(author).not.toContain('Write\\(./src');
      // a result outside its result directory gets no rule
      expect(allowed(cmd('test_author', '/tmp/y/T-03-tests-result.json'))).not.toContain('//tmp/y');
      const impl = (r) => cmd('implementer', r);
      expect(impl('/tmp/x/T-03-result-1.json')).toBe(impl(''));
    });

    it('--print-agent-command prints the exact command of a role and exits, without a run', () => {
      fixtureRepo();
      const r = spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--print-agent-command', 'reviewer', '', 'T-03'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 DISABLE_AUTOUPDATER=1 claude -p .*--disallowedTools Edit Write MultiEdit NotebookEdit/);
      expect(r.stdout.trim().split('\n')).toHaveLength(1);
      expect(existsSync(join(root, '.autopilot'))).toBe(false);
    });

    describe('agents per role (DEC-008)', () => {
      // An adapter that prevents nothing (it lacks deny-paths) and only takes two roles.
      const weakAdapter = () => writeFileSync(join(root, 'scripts/agents/weak.sh'), [
        'agent_weak_capabilities() { echo "ephemeral no-memory stdin-prompt command-allowlist no-network write-scoping stream"; }',
        'agent_weak_contract() { echo "it only detects reads of other agents records afterwards"; }',
        'agent_weak_supports() { case "$1" in implementer|reviewer) return 0 ;; esac; echo "only implementer and reviewer"; return 1; }',
        'agent_weak_available() { :; }', 'agent_weak_version() { echo weak 1; }', 'agent_weak_private_paths() { :; }',
        'agent_weak_command() { echo true; }', 'agent_weak_normalize() { cat; }', '',
      ].join('\n'));

      it('claude by default for every role, through scripts/agents/claude.sh, with its contract and an isolated command', () => {
        fixtureRepo();
        const r = dryRun();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('agents: implementer claude, reviewer claude');
        expect(r.stdout).toContain('Agent claude (DEC-008; scripts/agents/claude.sh) for: implementer reviewer; meets the contract of those roles:');
        expect(r.stdout).toContain('  ephemeral: every invocation is a new `claude -p` with --no-session-persistence');
        const impl = r.stdout.split('\n').find((l) => l.includes('--add-dir'));
        for (const part of ['env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 DISABLE_AUTOUPDATER=1 claude -p --no-session-persistence',
          '--settings \\{\\"autoMemoryEnabled\\":false\\,\\"disableAllHooks\\":false\\,\\"hooks\\":\\{\\"PreToolUse\\"', '--permission-mode dontAsk --output-format stream-json --verbose',
          'Read\\(./.autopilot/\\*\\*\\)', 'Edit\\(./.autopilot/\\*\\*\\)', 'Read\\(~/.claude/\\*\\*\\)']) {
          expect(impl).toContain(part);
        }
        expect(impl).not.toContain('AGENTS.md'); // the prompt goes on stdin, not as an argument
        expect(r.stdout).toContain('Isolation (DEC-008): every agent session is new and ephemeral');
        const withResearch = dryRun({ AUTOPILOT_RESEARCH: 'web' });
        expect(withResearch.stdout).toContain('agents: implementer claude, reviewer claude, researcher claude');
      });

      it('AUTOPILOT_REVIEWER is deprecated: claude and auto mean claude, with a warning; codex does not start', () => {
        fixtureRepo();
        for (const value of ['claude', 'auto']) {
          const r = dryRun({ AUTOPILOT_REVIEWER: value });
          expect(r.status).toBe(0);
          expect(r.stderr).toContain('autopilot: warning: AUTOPILOT_REVIEWER is deprecated (DEC-008): taken as AUTOPILOT_REVIEWER_AGENT=claude');
          expect(r.stdout).toContain('reviewer claude');
        }
        const codex = dryRun({ AUTOPILOT_REVIEWER: 'codex' });
        expect(codex.status).toBe(1);
        expect(codex.stderr).toContain('AUTOPILOT_REVIEWER=codex: there is no codex adapter that meets the agent contract (DEC-008)');
      });

      it('an agent without an adapter, without the role or missing a contract point of the role does not start (nor --check)', () => {
        fixtureRepo();
        weakAdapter();
        const cases = [
          [{ AUTOPILOT_REVIEWER_AGENT: 'weak' }, 'weak does not meet the agent contract for the reviewer role (DEC-008): missing deny-paths'],
          [{ AUTOPILOT_RESEARCH: 'web', AUTOPILOT_RESEARCHER_AGENT: 'weak' }, 'weak does not take the researcher role: only implementer and reviewer'],
          [{ AUTOPILOT_IMPLEMENTER_AGENT: 'nope' }, 'there is no adapter scripts/agents/nope.sh'],
          [{ AUTOPILOT_IMPLEMENTER_AGENT: '../x' }, 'invalid agent name: ../x'],
        ];
        for (const [env, why] of cases) {
          const r = dryRun(env);
          expect(r.status).toBe(1);
          expect(r.stderr).toContain(why);
        }
        const check = spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--check'], {
          encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AUTOPILOT_IMPLEMENTER_AGENT: 'nope' },
        });
        expect(check.status).toBe(2);
        expect(check.stdout).toBe('autopilot --check: cannot run: there is no adapter scripts/agents/nope.sh\n');
      });
    });

    it('with a TASKS.json without tasks it ends without error', () => {
      copyAutopilot();
      writeFileSync(join(root, 'spec/TASKS.json'), '{"corte": 1, "tasks": []}\n');
      const git = gitIn(root);
      git('init', '-q');
      git('add', '-A');
      git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
      const r = dryRun();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Pending reviews before picking a task (verified_auto, reviewer claude): none');
      expect(r.stdout).toContain('stop: no in_progress/ready/approved_for_impl tasks with closed dependencies');
    });
  });

  describe('full cycle with agent doubles (claude adapter)', () => {
    let git;
    let bin;
    // Every role uses the claude double through scripts/agents/claude.sh; its reviewer rejects by default.
    const autopilot = (env, ...args) =>
      spawnSync('bash', [join(root, 'scripts/autopilot.sh'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_CURL_LOG: curlLog(), ...env },
      });
    const t03 = () => task(readTasks(), 'T-03');
    const curlLog = () => join(root, '..', `${root.split('/').pop()}-curl.log`);
    // Calls to the curl double: each one is the list of its arguments.
    const curlCalls = () => {
      let raw;
      try { raw = readFileSync(curlLog(), 'utf8'); } catch { return []; }
      return raw.split('\x1e').filter(Boolean).map((c) => c.split('\x1f').slice(0, -1));
    };
    const header = (call, name) => call.find((a, i) => call[i - 1] === '-H' && a.startsWith(`${name}: `))?.slice(name.length + 2);
    const body = (call) => call[call.indexOf('--data-binary') + 1];

    beforeEach(() => {
      copyAutopilot();
      git = gitIn(root);
      git('init', '-q');
      git('config', 'core.hooksPath', '.githooks');
      editTasks((ts, d) => {
        for (const id of ['T-01', 'T-02', 'T-08']) { task(ts, id).status = 'accepted'; task(ts, id).evidence = { command: 'x', result: 'y', commit: 'z' }; }
        task(ts, 'T-03').status = 'ready';
        d.evidence_legacy = ['T-01', 'T-02', 'T-08']; // accepted before DEC-014 (T-41)
      });
      git('add', '-A');
      git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
      bin = stubBin();
    });
    afterEach(() => { rmSync(bin, { recursive: true, force: true }); rmSync(curlLog(), { force: true }); });

    it('implements, reviews (approved → reviewed), writes LOG and commits; never pushes', () => {
      const r = autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
      expect(r.stderr.replace(/check:spec: ok\n/g, '')).toBe(''); // the commit-msg hook prints its ok
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('verdict on T-03: approved → status reviewed');
      expect(r.stdout).toContain('stop: task budget reached (1)');
      expect(t03()).toMatchObject({ status: 'reviewed', review: { verdict: 'approved', reviewer: expect.stringContaining('claude -p 0.0.0') } });
      const log = git('log', '--format=%s%n%b');
      expect(log).toContain('T-03: independent review (approved)');
      expect(log).toContain('Autopilot: summary');
      expect(log).toContain('Autopilot: summary of run 20');
      expect(git('log', '-1', '--format=%b')).toContain('Task: none\nReq: none'); // no configuration
      expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('Motivo de parada: presupuesto de tareas alcanzado (1)');
      expect(git('status', '--porcelain')).toBe('');
      const prompt = readFileSync(join(root, '.autopilot/stub-review-prompt-1.txt'), 'utf8');
      expect(prompt).toContain('### REQ-001');
      expect(prompt).toContain('## DEC-007');
      expect(prompt).toContain('stub change for T-03');
      expect(prompt).not.toContain('## DEC-001');
    });

    describe('the reviewer reviews the task\'s commits with read-only git and does not re-run the full suite (T-52)', () => {
      const args = () => readFileSync(join(root, '.autopilot/stub-args-review.txt'), 'utf8').split('\n');
      const allowed = () => { const a = args(); return a.slice(a.indexOf('--allowedTools') + 1, a.indexOf('--disallowedTools')); };

      it('the prompt names the task\'s commits, how to read them (git show/diff/log, one command per call, never HEAD) and the evidence log with its sha256', () => {
        autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
        const prompt = readFileSync(join(root, '.autopilot/stub-review-prompt-1.txt'), 'utf8');
        const sha = git('log', '-1', '--format=%h', '--grep=^T-03: stub').trim();
        expect(prompt).toContain(`git show ${sha}`);
        expect(prompt).toContain('Review these commits, not HEAD');
        expect(prompt).toContain('One command per call: no pipes (|), no ;, no && and no node -e');
        expect(prompt).toContain('Do not run the full suite');
        const ev = t03().evidence;
        expect(prompt).toContain(`artifacts/T-03/verify.log (sha256 ${ev.log_sha256})`);
        expect(prompt).toContain('sha256sum artifacts/T-03/verify.log');
        expect(allowed()).toContain('Bash(sha256sum artifacts/T-03/verify.log)');
        for (const c of ['Bash(git show*)', 'Bash(git diff*)', 'Bash(git log*)']) expect(allowed()).toContain(c);
        expect(allowed()).not.toContain('Bash(npm test*)');
      });

      it('it may run only the test files the task\'s commits changed; without evidence of record_evidence.py the prompt says so', () => {
        mkdirSync(join(root, 'scripts/test'), { recursive: true });
        writeFileSync(join(root, 'scripts/test/t02.test.mjs'), 'import "node:test";\n');
        editTasks((ts) => { task(ts, 'T-02').status = 'verified_auto'; });
        git('add', '-A');
        git('commit', '-q', '-m', 'T-02: done by hand\n\nTask: T-02\nReq: none');
        autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
        const prompt = readFileSync(join(root, '.autopilot/stub-review-prompt-1.txt'), 'utf8');
        expect(prompt).toContain('node --test --test-name-pattern=T-02 scripts/test/t02.test.mjs'); // only the task's tests, not the file
        expect(prompt).toContain('T-02 has no evidence log recorded by record_evidence.py');
        expect(readFileSync(join(root, '.autopilot/stub-args-review-1.txt'), 'utf8').split('\n')).toContain('Bash(node --test --test-name-pattern=T-02 scripts/test/t02.test.mjs*)');
      });
    });

    it('a task with no commit of its own is not reviewed: no diff, no reviewer; it goes to the user (T-52)', () => {
      editTasks((ts) => { task(ts, 'T-02').status = 'verified_auto'; });
      git('commit', '-q', '-am', 'T-02 by hand\n\nTask: none\nReq: none');
      const r = autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
      expect(r.stdout).toContain('stop: T-02 has no commit with Task: T-02: there is no diff to review; it waits for the user');
      expect(existsSync(join(root, '.autopilot/stub-review-prompt-1.txt'))).toBe(false);
      expect(task(readTasks(), 'T-02').status).toBe('verified_auto');
    });

    const pendingT02 = () => { // T-02 implemented outside the orchestrator, awaiting review
      editTasks((ts) => { task(ts, 'T-02').status = 'verified_auto'; });
      git('commit', '-q', '-am', 'T-02: done by hand\n\nTask: T-02\nReq: none');
    };
    const count = (s, sub) => s.split(sub).length - 1;

    it('before picking a task it reviews pending verified_auto tasks (approved → reviewed) without counting them as tasks', () => {
      pendingT02();
      const r = autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
      expect(r.status).toBe(0);
      const reviewed = r.stdout.indexOf('verdict on T-02: approved → status reviewed');
      expect(reviewed).toBeGreaterThan(-1);
      expect(reviewed).toBeLessThan(r.stdout.indexOf('T-03 › Starting the task'));
      expect(r.stdout).toContain('verdict on T-03: approved → status reviewed');
      expect(r.stdout).toContain('stop: task budget reached (1)');
      expect(task(readTasks(), 'T-02')).toMatchObject({ status: 'reviewed', review: { verdict: 'approved', reviewer: expect.stringContaining('claude -p 0.0.0') } });
      expect(git('log', '--format=%s')).toContain('T-02: independent review (approved)');
      expect(git('log', '-1', '--format=%b', '--grep=^T-02: independent review')).toContain('Task: T-02\nReq: none');
      expect(git('status', '--porcelain')).toBe('');
    });

    it('a rejected pending task stays verified_auto and is not reviewed again in the same run', () => {
      pendingT02();
      const r = autopilot({}); // the reviewer double rejects by default
      expect(r.status).toBe(0);
      expect(count(r.stdout, 'verdict on T-02: rejected')).toBe(1);
      expect(count(r.stdout, 'verdict on T-03: rejected')).toBe(1);
      expect(task(readTasks(), 'T-02')).toMatchObject({ status: 'verified_auto', review: { verdict: 'rejected' } });
      expect(r.stdout).toContain('stop: no in_progress/ready/approved_for_impl tasks with closed dependencies');
    });

    it('the implementer inherits the autopilot_env hook environment; progress is readable in the terminal and in live.log', () => {
      writeFileSync(join(root, 'scripts/autopilot.config.sh'), [
        'AUTOPILOT_TASK=T-08',
        'autopilot_env() { unset USER_SECRET; export AUTOPILOT_PROBE=test-value; }',
        '',
      ].join('\n'));
      git('add', '-A');
      git('commit', '-q', '-m', 'config\n\nTask: T-08\nReq: N/A');
      const r = autopilot({ USER_SECRET: 'must-not-show', STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
      expect(r.status).toBe(0);
      const runDir = join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
      const seen = readFileSync(join(root, '.autopilot/stub-env-T-03.txt'), 'utf8');
      expect(seen).toContain('AUTOPILOT=1\nCI=1\nAUTOPILOT_PROBE=test-value\nUSER_SECRET=\n');
      expect(git('log', '-1', '--format=%b')).toContain('Task: T-08\nReq: N/A'); // AUTOPILOT_TASK tooling
      const live = readFileSync(join(runDir, 'live.log'), 'utf8');
      for (const out of [r.stdout, live]) {
        expect(out).toMatch(/T-03 › Starting the task/);
        expect(out).toMatch(/T-03 ▸ Bash {2}npm test/);
        expect(out).toMatch(/T-03 {3}✓ 1 line\(s\): Tests 25 passed/);
        expect(out).toContain('T-03 ■ end (ok): 5 turns, tokens: input 44 · output 11,440 · cache read 1,266,786 · cache write 64,481');
        expect(out).toContain('tokens for T-03 in the run: input 44 · output 11,440');
        expect(out).toContain('tokens (all agents): T-03: input 44 · output 11,440 · cache read 1,266,786 · cache write 64,481; total for the run: input 44');
        expect(out).not.toMatch(/cost|US\$/);
      }
      expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain(
        '- Tokens (todos los agentes, campo usage del evento result): T-03: entrada 44 · salida 11.440 · caché leída 1.266.786 · caché escrita 64.481; total de la corrida: entrada 44 · salida 11.440 · caché leída 1.266.786 · caché escrita 64.481.',
      );
      expect(live).toContain('verdict on T-03: approved → status reviewed');
      expect(readFileSync(join(runDir, 'T-03-impl-1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
      expect(JSON.parse(readFileSync(join(runDir, 'T-03-impl-1.json'), 'utf8'))).toMatchObject({ type: 'result', num_turns: 5 });
    });

    it('chains: with T-03 reviewed it takes T-04 (depends on T-01 and T-03) in the same run', () => {
      const r = autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '2');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('verdict on T-04: approved → status reviewed');
      expect(task(readTasks(), 'T-04').status).toBe('reviewed');
    });

    it('rejected keeps verified_auto and goes on; with no more ready tasks it ends with exit 0', () => {
      const r = autopilot({});
      expect(r.status).toBe(0);
      expect(t03()).toMatchObject({ status: 'verified_auto', review: { verdict: 'rejected', findings: [expect.stringContaining('REQ-001')] } });
      expect(r.stdout).toContain('stop: no in_progress/ready/approved_for_impl tasks with closed dependencies');
    });

    it('stops with exit 1 if the implementer grants accepted', () => {
      const r = autopilot({ STUB_MODE: 'accepted' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('T-03: ready → accepted');
      expect(r.stdout).toContain('authority violation');
      expect(t03().review).toBeNull();
    });

    it('stops with exit 1 and commits nothing if the implementer leaves the tree dirty', () => {
      const head = git('rev-parse', 'HEAD');
      const r = autopilot({ STUB_MODE: 'dirty' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('WITHOUT commit');
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('status', '--porcelain')).toContain('spec/LOG.md');
    });

    it('a task that ends unchanged is not a failure: it is skipped and the next independent one is taken', () => {
      editTasks((ts) => { task(ts, 'T-08').status = 'ready'; }); // depends only on T-02 (done): independent of T-03
      git('commit', '-q', '-am', 'T-08 ready\n\nTask: T-08\nReq: N/A');
      const r = autopilot({ STUB_NOOP: 'T-03', STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('T-03 ended unchanged: not counted as a failure');
      expect(r.stdout).not.toContain('failure 1/');
      expect(r.stdout).not.toContain('attempt 2');
      expect(r.stdout).toContain('verdict on T-08: approved → status reviewed');
      expect(r.stdout).toContain('stop: no in_progress/ready/approved_for_impl tasks with closed dependencies');
      expect(t03().status).toBe('ready');
      const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      expect(log).toContain('T-03: el implementador la dejó sin cambios (estado ready); se salta en esta corrida');
      expect(log).toContain('0 fallo(s)');
    });

    const t08Ready = () => { // task independent of T-03 (depends only on T-02, done)
      editTasks((ts) => { task(ts, 'T-08').status = 'ready'; });
      git('commit', '-q', '-am', 'T-08 ready\n\nTask: T-08\nReq: N/A');
    };

    it('failures are counted per task: two on T-03 abandon it and the run goes on with T-08', () => {
      t08Ready();
      const r = autopilot({ STUB_FAIL: 'T-03', STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' });
      expect(r.status).toBe(1); // an abandoned task needs intervention
      expect(r.stdout).toContain('failure 1/2 on T-03');
      expect(r.stdout).toContain('failure 2/2 on T-03');
      expect(r.stdout).toContain('implementer on T-08 (attempt 1');
      expect(r.stdout).toContain('verdict on T-08: approved → status reviewed');
      expect(t03().status).toBe('ready');
      const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      expect(log).toContain('T-03 abandonada en esta corrida tras 2 fallos (tope por tarea 2)');
      expect(log).toContain('1 tarea(s) completada(s), 2 fallo(s)');
    });

    it('a task whose result has "deploy" stays in_progress with Pendiente deploy: not a failure, the next one follows', () => {
      t08Ready();
      const r = autopilot({ STUB_DEPLOY: 'T-03', STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('T-03 waits for a deploy (Pendiente deploy): not counted as a failure');
      expect(r.stdout).not.toContain('failure 1/');
      expect(r.stdout).toContain('verdict on T-08: approved → status reviewed');
      expect(t03().status).toBe('in_progress');
      const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      expect(log).toContain('- Pendiente deploy (lo hace el usuario; el orquestador no despliega): T-03.');
      expect(log).toContain('- Pendiente deploy: desplegar; después: correr la aceptación.'); // T-39: written from the field
      expect(log).toContain('0 fallo(s)');
    });

    it('a spec task that asks for awaiting_acceptance_approval with commits waits for the user and is not a failure', () => {
      t08Ready();
      const r = autopilot({ STUB_WAIT: 'T-03', STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' });
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('T-03 waits for a deploy');
      expect(r.stdout).toContain('T-03 waits for the user to approve the tests/acceptance/ diff (spec task): not counted as a failure');
      expect(r.stdout).not.toContain('failure 1/');
      expect(r.stdout).toContain('verdict on T-08: approved → status reviewed');
      expect(t03().status).toBe('in_progress');
      const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      expect(log).toContain('- Pendiente deploy (lo hace el usuario; el orquestador no despliega): ninguna.');
      expect(log).toContain('T-03: tarea de spec in_progress; espera que el usuario apruebe el diff de tests/acceptance/');
      expect(log).toContain('0 fallo(s)');
    });

    it('awaiting_acceptance_approval on a non-spec task is an invalid result: a failure', () => {
      editTasks((ts) => { task(ts, 'T-08').status = 'ready'; task(ts, 'T-03').status = 'reviewed'; });
      git('commit', '-q', '-am', 'T-08 ready\n\nTask: T-08\nReq: N/A');
      const r = autopilot({ STUB_WAIT: 'T-08' }, '--task', 'T-08');
      expect(r.stdout).not.toContain('T-08 waits for a deploy');
      expect(r.stdout).toContain('failure 1/2 on T-08');
    });

    it('the summary lists the pending manual checks', () => {
      const r = autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
      expect(r.status).toBe(0);
      expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('- Pendiente manual (el usuario la hace al aceptar en lote): ninguna.');
    });

    describe('closed decisions through the port decide (DEC-015)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const decisions = () => readdirSync(root, { recursive: true }).filter((f) => /^artifacts\/decisions\/.+\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')));

      it('the review verdict is the decider\'s: each decision is recorded in artifacts/decisions/ with the summary', () => {
        const r = autopilot(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('decide review_verdict (stub): proceed approved (confidence 0.95)');
        expect(t03().status).toBe('reviewed');
        const d = decisions();
        expect(d.length).toBe(1);
        expect(d[0]).toMatchObject({ question_id: 'review_verdict', answer: 'approved', confidence: 0.95, action: 'proceed' });
        expect(t03().review.decision).toMatchObject({ question_id: 'review_verdict', decider: 'stub', confidence: 0.95 }); // T-36
      });

      it('low confidence on the verdict escalates to the user: the task is not reviewed, it is blocked by a new question (T-62)', () => {
        const r = autopilot({ ...approved, STUB_DECIDE_review_verdict: 'approved:0.5' });
        expect(r.stdout).toContain('the decider (stub) did not settle the review verdict on T-03 (confidence 0.5 < 0.8 (threshold)');
        expect(t03().status).toBe('blocked');
        expect(t03().blocked_by).toMatch(/^Q-\d+$/);
        const d = decisions();
        expect(d.length).toBe(1);
        expect(d[0]).toMatchObject({ question_id: 'review_verdict', action: 'escalate' });
      });

      it('a decider error escalates; it never falls back to the reviewer\'s own verdict', () => {
        const r = autopilot({ ...approved, STUB_DECIDE_review_verdict: 'error' });
        expect(r.stdout).toContain('decider error: stub decider: forced error');
        expect(t03().status).toBe('blocked'); // T-62
      });

      it('a decider that disagrees with the review escalates too', () => {
        autopilot({ ...approved, STUB_DECIDE_review_verdict: 'rejected:0.97' });
        expect(t03().status).toBe('blocked'); // T-62
      });

      it('a failure whose cause is not the implementation goes to the user, not to a retry', () => {
        const r = autopilot({ STUB_MODE: 'fail', STUB_DECIDE_failure_cause: 'environment:0.93' });
        expect(r.stdout).toContain('decide failure_cause (stub): proceed environment (confidence 0.93)');
        expect(r.stdout).not.toContain('attempt 2');
        expect(t03()).toMatchObject({ status: 'blocked' });
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('clasifica la causa del fallo como environment');
      });

      it('an answer outside the enum is rejected and escalates', () => {
        const r = autopilot({ STUB_MODE: 'fail', STUB_DECIDE_failure_cause: 'cosmic_rays:0.99' });
        expect(r.stdout).toContain('is outside the options');
        expect(t03().status).toBe('blocked');
      });
    });

    describe('T-84: a result rejected for its format is rewritten once, without asking the decider', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      // Wraps the claude double: the implementer's first result carries an unknown key (with WRAP_VERIFIED, a
      // "- Verificado" line instead, T-117); the relaunch whose prompt says "Result rejected (T-84)" only rewrites the
      // result (fixed, or still invalid with WRAP_RETRY_BAD).
      beforeEach(() => {
        cpSync(join(bin, 'claude'), join(bin, 'claude-real'));
        writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash
real="$(dirname "$0")/claude-real"
[ "$1" = -p ] || exec "$real" "$@"
input=$(cat)
case "$input" in
  "Read AGENTS.md and execute "*"Result rejected (T-84)"*)
    n=$(( $(cat .autopilot/wrap-retry-count 2>/dev/null || echo 0) + 1 )); echo "$n" >.autopilot/wrap-retry-count
    printf '%s' "$input" >".autopilot/wrap-retry-prompt-$n.txt"
    echo '{"type":"system","subtype":"init","model":"stub","session_id":"w1"}'
    WRAP_BAD=\${WRAP_RETRY_BAD:-} node -e 'require("fs").writeFileSync(process.env.AUTOPILOT_RESULT,
      JSON.stringify({ log: "- Hecho: resultado reescrito.", ...(process.env.WRAP_BAD ? { state: "done" } : {}) }))'
    echo '{"type":"result","subtype":"success","result":"rewrote the result","num_turns":1,"is_error":false}'
    exit 0 ;;
  "Read AGENTS.md and execute "*)
    rc=0; printf '%s' "$input" | "$real" "$@" || rc=$?
    node -e 'const fs=require("fs");const f=process.env.AUTOPILOT_RESULT;const r=JSON.parse(fs.readFileSync(f,"utf8"));
      if(process.env.WRAP_VERIFIED)r.log+="\\n- Verificado y cómo: npm test → 25 pasan.";else r.state="done";fs.writeFileSync(f,JSON.stringify(r))'
    exit $rc ;;
esac
printf '%s' "$input" | exec "$real" "$@"
`);
      });
      const retries = () => (existsSync(join(root, '.autopilot/wrap-retry-count')) ? Number(readFileSync(join(root, '.autopilot/wrap-retry-count'), 'utf8')) : 0);

      it('T-117: a result with a "- Verificado" line is applied without it and without a relaunch; the run warns', () => {
        const r = autopilot({ ...approved, WRAP_VERIFIED: '1' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(retries()).toBe(0);
        expect(r.stdout).toContain('T-03: log: 1 line(s) with test results discarded (DEC-014, T-117): "- Verificado y cómo: npm test → 25 pasan."');
        expect(t03().status).toBe('reviewed');
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('T-03: del log del implementador se descartaron 1 línea(s) y se recortaron 0 con resultados de pruebas (DEC-014, T-117');
        expect(log).not.toContain('npm test → 25 pasan');
        const live = readdirSync(join(root, '.autopilot'), { recursive: true }).find((f) => f.endsWith('live.log'));
        expect(readFileSync(join(root, '.autopilot', live), 'utf8')).toContain('line(s) with test results discarded (DEC-014, T-117)');
      });

      it('T-84: a result with an unknown key is relaunched once with the validation error and, fixed, is applied', () => {
        const r = autopilot(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('unknown key "state"');
        expect(r.stdout).toContain('T-03: result rejected for its format; relaunching the implementer once to rewrite only the result (T-84)');
        expect(r.stdout).toContain('T-03: the rewritten result is valid (T-84)');
        expect(r.stdout).not.toContain('decide failure_cause');
        expect(r.stdout).not.toContain('failure 1/');
        expect(retries()).toBe(1);
        const prompt = readFileSync(join(root, '.autopilot/wrap-retry-prompt-1.txt'), 'utf8');
        expect(prompt).toContain('Result rejected (T-84)');
        expect(prompt).toContain('unknown key "state"');
        expect(prompt).toContain('do not change files and do not commit');
        expect(prompt).toContain('"state":"done"'); // the rejected result
        expect(t03().status).toBe('reviewed');
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('- Hecho: resultado reescrito.');
        expect(git('log', '--format=%s').split('\n').filter((s) => s === 'T-03: stub')).toHaveLength(1); // its commits, kept
        expect(git('status', '--porcelain')).toBe('');
      });

      it('T-84: a second rejection fails as before: the decider classifies it and, under its threshold, it escalates', () => {
        const r = autopilot({ ...approved, WRAP_RETRY_BAD: '1', STUB_DECIDE_failure_cause: 'reviewer_error:0.47' });
        expect(retries()).toBe(1);
        expect(r.stdout).toContain('decide failure_cause (stub)');
        expect(r.stdout).not.toContain('attempt 2');
        expect(t03().status).toBe('blocked');
        expect(t03().blocked_by).toMatch(/^Q-\d+$/);
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('T-03: resultado del implementador inválido también tras reescribirlo una vez (T-84');
        const ctx = readdirSync(join(root, '.autopilot'), { recursive: true }).find((f) => f.endsWith('T-03-cause-context.md'));
        expect(readFileSync(join(root, '.autopilot', ctx), 'utf8')).toContain('### Validation of the rewritten result');
      });

      it('T-84: a missing result is not relaunched (only a format rejection is)', () => {
        const r = autopilot({ STUB_MODE: 'noresult' }, '--max-failures', '1');
        expect(retries()).toBe(0);
        expect(r.stdout).not.toContain('relaunching the implementer once');
        expect(r.stdout).toContain('left no result in');
      });
    });

    describe('the status comes from facts, not from the implementer (DEC-014, T-34)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };

      it('a finished result is closed by record_evidence.py: verified_auto with its evidence; the claims are kept apart', () => {
        const r = autopilot({ ...approved, STUB_CLAIM: 'probar en el teléfono' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(t03()).toMatchObject({ status: 'reviewed', claims: { manual_pending: 'probar en el teléfono' } });
        expect(t03().evidence.result).toContain('registrado por record_evidence.py');
        expect(t03().evidence.manual_pending).toBe(undefined);
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('- Verificado y cómo: `printf'); // T-35: from the evidence
      });

      it('a result that proposes a status and its own evidence is invalid: nothing is applied', () => {
        const before = t03().status;
        const r = autopilot({ STUB_MODE: 'legacy' });
        expect(r.stdout).toContain('"status" is not the implementer\'s (DEC-014)');
        expect(t03().status).toBe(before);
      });

      it('a finished result whose verify fails is not applied (a failure)', () => {
        editTasks((ts) => { task(ts, 'T-03').verify = "printf '\\xe2\\x84\\xb9 tests 25\\n\\xe2\\x84\\xb9 pass 24\\n\\xe2\\x84\\xb9 fail 1\\n'; exit 1"; });
        git('commit', '-q', '-am', 'T-03 verify fails\n\nTask: none\nReq: none');
        const before = t03().status;
        const r = autopilot({}, '--max-tasks', '1');
        expect(r.stdout).toContain('failure 1/2 on T-03');
        expect(t03().status).toBe(before);
        expect(git('log', '--format=%s')).not.toContain('apply implementer result');
      });

      it('outcome unfinished leaves it in_progress (applied) and counts as a failure', () => {
        const before = t03().status;
        const r = autopilot({ STUB_MODE: 'unfinished' }, '--max-tasks', '1');
        expect(r.stdout).toContain('failure 1/2 on T-03');
        expect(r.stdout).toContain(`status ${before} → in_progress`);
      });
    });

    it('with two implementer failures it abandons the task (exit 1) after retrying the same one', () => {
      const r = autopilot({ STUB_MODE: 'fail' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('attempt 2');
      expect(r.stdout).toContain('T-03 reached the cap of 2 failures: abandoned in this run');
      expect(r.stdout).toContain('stop: no in_progress/ready/approved_for_impl tasks with closed dependencies (skipped in this run: T-03)');
      expect(r.stdout).toContain('tokens for T-03 in the run: input 6 · output 200 · cache read 4,000 · cache write 1,000 (2 invocations)');
      expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('total de la corrida: entrada 6 · salida 200 · caché leída 4.000 · caché escrita 1.000.');
      expect(t03().status).toBe('ready');
    });

    describe('single writer of spec/ (implementer result)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const filesOf = (sha) => git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).trim().split('\n');

      it('the implementer commits only code; the orchestrator applies status, evidence, notes, LOG and assumptions in its own spec/ commit', () => {
        const head = git('rev-parse', 'HEAD').trim();
        const r = autopilot({ ...approved, STUB_MODE: 'assume' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('result of T-03 applied to spec/: status ready → verified_auto');
        const [impl, applied] = git('log', '--reverse', '--format=%h %s', `${head}..HEAD`).trim().split('\n');
        expect(impl).toMatch(/ T-03: stub$/);
        expect(filesOf(impl.split(' ')[0])).toEqual(['tests/acceptance/stub-T-03.txt']);
        expect(applied).toMatch(/ T-03: apply implementer result \(verified_auto\)$/);
        expect(filesOf(applied.split(' ')[0])).toEqual(['artifacts/T-03/verify.log', 'spec/LOG.md', 'spec/SPEC.md', 'spec/TASKS.json']);
        expect(git('log', '-1', '--format=%b', applied.split(' ')[0])).toContain('Task: T-03\nReq: REQ-001, REQ-002, REQ-003, REQ-004');
        expect(t03()).toMatchObject({
          status: 'reviewed', // approved by the reviewer afterwards
          // evidence written by record_evidence.py from a new run of the task's verify, not the implementer's (DEC-014)
          evidence: { passed: 25, failed: 0, total: 25, log_path: 'artifacts/T-03/verify.log' },
          notes: 'Interpretación de T-03: supuesto S-01.',
        });
        expect(t03().evidence.commit.startsWith(impl.split(' ')[0])).toBe(true);
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toMatch(/\n## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · implementador de T-03 vía autopilot \(claude\)\n- Hecho: T-03 implementada por el stub\.\n/);
        expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain(
          '|---|---|---|---|---|\n| S-01 | el stub \\| no falla | sí | reversible | si falla |\n\n## Preguntas abiertas');
        expect(readFileSync(join(root, '.autopilot/stub-env-T-03.txt'), 'utf8')).toMatch(/AUTOPILOT_RESULT=.*\/T-03-result-1\.json\n/);
        expect(git('status', '--porcelain')).toBe('');
      });

      for (const [mode, what] of [['spec', 'spec/LOG.md (spec/ belongs to the orchestrator)'], ['outside', 'outside-T-03.txt (outside touches: tests/acceptance/)']]) {
        it(`commits that touch ${mode === 'spec' ? 'spec/' : 'paths outside touches'}: the task fails without applying anything and is not retried`, () => {
          const head = git('rev-parse', 'HEAD').trim();
          const base = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
          const r = autopilot({ ...approved, STUB_MODE: mode });
          expect(r.status).toBe(1);
          expect(r.stdout).toContain(`T-03: commits outside its scope (spec/ or not in touches): ${what}`);
          expect(r.stdout).toContain('failure 1/2 on T-03');
          expect(r.stdout).not.toContain('attempt 2');
          expect(r.stdout).toContain('abandoned in this run without retrying');
          expect(t03().status).toBe('ready');
          expect(git('log', `${head}..HEAD`, '--format=%s')).not.toContain('apply implementer result');
          const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
          expect(log).toContain('T-03: los commits del implementador salen de su alcance');
          expect(log).toContain('T-03 abandonada en esta corrida: sus commits salen de spec/ o de touches');
          expect(log).not.toContain('implementador de T-03 vía autopilot');
          // Not integrated: the base branch never gets the implementer's commit; it stays on the task branch.
          expect(git('log', '--format=%s', `${head}..HEAD`)).not.toContain('T-03: stub');
          const branch = git('branch', '--list', 'autopilot/*/T-03-1', '--format=%(refname:short)').trim();
          expect(branch).toMatch(/^autopilot\/\d{4}-\d{2}-\d{2}_\d{6}\/T-03-1$/);
          expect(git('log', '--format=%s', `${head}..${branch}`)).toContain('T-03: stub');
          expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(base); // back on the base branch
          expect(r.stdout).toContain(`T-03: not integrated; its commits stay on branch ${branch}`);
        });
      }

      it('a task whose commit overwrites scripts/autopilot.sh does not alter the running orchestrator (it runs from a copy)', () => {
        const r = autopilot({ ...approved, STUB_MODE: 'selfedit' });
        expect(r.stdout).not.toContain('SELF-EDITED');
        expect(r.status).toBe(1); // outside touches: abandoned, and the run still ends with its summary
        expect(r.stdout).toContain('T-03: commits outside its scope (spec/ or not in touches): scripts/autopilot.sh');
        expect(git('log', '-1', '--format=%s')).toContain('Autopilot: summary of run');
        expect(readFileSync(join(root, 'scripts/autopilot.sh'), 'utf8')).not.toContain('SELF-EDITED');
      });

      // badresult: the double commits again when relaunched to rewrite its result, which T-84 does not apply
      for (const [mode, err, why] of [['noresult', 'left no result in', 'T-03: resultado del implementador ausente o inválido'],
        ['badresult', 'not valid JSON', 'T-03: al reescribir su resultado el implementador hizo commits']]) {
        it(`a ${mode === 'noresult' ? 'missing' : 'invalid'} result counts as a failure: retried, then abandoned; nothing applied`, () => {
          const r = autopilot({ ...approved, STUB_MODE: mode });
          expect(r.status).toBe(1);
          expect(r.stdout).toContain(err);
          expect(r.stdout).toContain('failure 2/2 on T-03');
          expect(git('log', '--format=%s', 'HEAD')).not.toContain('T-03: stub'); // never integrated
          expect(t03().status).toBe('ready');
          expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain(why);
          expect(git('status', '--porcelain')).toBe('');
        });
      }
    });

    describe('ntfy notice on stop', () => {
      const ntfy = { NTFY_TOPIC: 'test-topic', NTFY_URL: 'https://ntfy.example' };
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };

      it('without NTFY_TOPIC it does not call curl', () => {
        const r = autopilot(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(curlCalls()).toEqual([]);
      });

      it('if it finished fine: one normal-priority notice to the topic, with reason, done/failed and next action', () => {
        // Only T-03 is eligible: it is implemented, reviewed and the run ends with no tasks left (no limit, no failures).
        editTasks((ts) => { for (const id of ['T-04', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
        git('commit', '-q', '-am', 'only T-03\n\nTask: none\nReq: none');
        const r = autopilot({ ...approved, ...ntfy });
        expect(r.status).toBe(0);
        const calls = curlCalls();
        expect(calls).toHaveLength(1);
        const c = calls[0];
        expect(c.at(-1)).toBe('https://ntfy.example/test-topic');
        expect(header(c, 'Priority')).toBe('default');
        expect(header(c, 'Tags')).toBe('white_check_mark');
        expect(header(c, 'Title')).toMatch(/^autopilot .*: finished fine$/);
        expect(body(c)).toContain('Stop reason: no in_progress/ready/approved_for_impl');
        expect(body(c)).toContain('Done: 1 task(s) · Failed: 0 failure(s)');
        expect(body(c)).toContain('Detail: T-03 implemented');
        expect(body(c)).toContain('Next action: review the summary in spec/LOG.md');
        expect(r.stdout).toContain('ntfy notice sent (priority default)');
      });

      it('a budget limit (tasks) asks for intervention: high priority', () => {
        const r = autopilot({ ...approved, ...ntfy }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(header(c, 'Tags')).toBe('warning,rotating_light');
        expect(body(c)).toContain('Stop reason: task budget reached (1)');
        expect(body(c)).toContain('Next action: relaunch the autopilot to continue (limit reached)');
      });

      it('if it needs intervention (failures): high priority and alert tag, with the abandoned tasks', () => {
        const r = autopilot({ ...ntfy, STUB_MODE: 'fail' });
        expect(r.status).toBe(1);
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(header(c, 'Tags')).toBe('warning,rotating_light');
        expect(header(c, 'Title')).toMatch(/needs your intervention$/);
        expect(body(c)).toContain('Failed: 2 failure(s); abandoned: T-03');
        expect(body(c)).toContain('Next action: review the failures of T-03 in .autopilot/');
      });

      it('a pending deploy also asks for intervention', () => {
        const r = autopilot({ ...ntfy, ...approved, STUB_DEPLOY: 'T-03' });
        expect(r.status).toBe(0);
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(body(c)).toContain('Next action: deploy');
      });

      it('a reviewer rejection asks for intervention: high priority, with the rejected task', () => {
        const r = autopilot({ ...ntfy, STUB_VERDICT: '{"verdict":"rejected","findings":["REQ-002: falta un borde"],"notes":"n"}' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(body(c)).toContain('rejected by the reviewer: T-03');
        expect(body(c)).toContain("Next action: address the reviewer's findings (review of T-03");
      });

      it('an AUTOPILOT_NTFY_MAX below 1000 is taken as 1000: the fixed fields are complete', () => {
        const r = autopilot({ ...ntfy, STUB_MODE: 'fail', AUTOPILOT_NTFY_MAX: '110' });
        expect(r.status).toBe(1);
        const b = body(curlCalls()[0]);
        expect(b.length <= 1000).toBe(true);
        const lines = b.split('\n');
        expect(lines[0]).toBe('Stop reason: no in_progress/ready/approved_for_impl tasks with closed dependencies (skipped in this run: T-03)');
        expect(lines[1]).toBe('Done: 0 task(s) · Failed: 2 failure(s); abandoned: T-03');
        expect(lines[2]).toMatch(/^Next action: review the failures of T-03 in \.autopilot\/[0-9_-]+\/ and relaunch$/);
        expect(lines[3]).toMatch(/^Run [0-9_-]+ \(logs in \.autopilot\/[0-9_-]+\/\)$/);
        expect(lines[4]).toMatch(/^Tokens: run [0-9,]+ counted \(input [0-9,]+ · output [0-9,]+ · cache write [0-9,]+\) \+ cache read [0-9,]+; month \d{4}-\d{2}: [0-9,]+ counted, cache read [0-9,]+$/); // DEC-048
        expect(lines[5]).toMatch(/^Detail: /);
      });

      it('with many tasks: lists are shortened (5 and "(+N more)") and only the detail is trimmed to the limit', () => {
        // 7 from the fixture + 20 new ones in verified_auto: the reviewer rejects them all before picking a new task.
        editTasks((ts, d) => {
          for (const id of ['T-02', 'T-03', 'T-04', 'T-05', 'T-06', 'T-07', 'T-08']) { task(ts, id).status = 'verified_auto'; task(ts, id).evidence = { command: 'x', result: 'y', commit: 'z' }; }
          for (let i = 9; i <= 28; i++) ts.push({ ...task(ts, 'T-08'), id: `T-${String(i).padStart(2, '0')}`, depends_on: [] });
          d.evidence_legacy = ts.filter((t) => t.evidence?.command).map((t) => t.id); // T-41
        });
        git('commit', '-q', '-am', 'twenty-seven to review\n\nTask: none\nReq: none');
        // T-52: a task is reviewed only with a commit of its own (Task: <ID>), so each one gets one
        for (const t of readTasks().filter((x) => x.status === 'verified_auto')) {
          const req = t.reqs?.length ? t.reqs.join(', ') : t.kind === 'tooling' ? 'N/A' : 'none';
          git('commit', '-q', '--allow-empty', '-m', `${t.id}: work\n\nTask: ${t.id}\nReq: ${req}`);
        }
        const r = autopilot({ ...ntfy, AUTOPILOT_NTFY_MAX: '1000', STUB_VERDICT: '{"verdict":"rejected","findings":["REQ-002: x"],"notes":"n"}' });
        expect(r.stdout).toContain('verdict on T-28: rejected');
        const b = body(curlCalls()[0]);
        expect(b.length <= 1000).toBe(true);
        const lines = b.split('\n');
        expect(lines[1]).toBe('Done: 0 task(s) · Failed: 0 failure(s); rejected by the reviewer: T-02 T-03 T-04 T-05 T-06 … (+22 more)');
        expect(lines[2]).toBe("Next action: address the reviewer's findings (review of T-02 T-03 T-04 T-05 T-06 … (+22 more) in spec/TASKS.json)");
        expect(lines[3]).toMatch(/^Run /);
        expect(lines[5]).toMatch(/^Detail: T-02 reviewed by /);
        expect(lines[5].endsWith('…')).toBe(true);
      });

      it('a blocked task: the orchestrator applies blocked_by, stops and asks to resolve the block', () => {
        const r = autopilot({ ...ntfy, STUB_MODE: 'blocked' });
        expect(r.status).toBe(1);
        expect(t03()).toMatchObject({ status: 'blocked', blocked_by: 'Q-01' });
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        const lines = body(c).split('\n');
        expect(lines[0]).toBe('Stop reason: T-03 ended blocked (Q-01)');
        expect(lines[2]).toBe('Next action: resolve the block (T-03 ended blocked (Q-01)) and relaunch the autopilot');
      });

      it('a long free-text blocked_by fails check:spec: nothing is applied and it counts as a failure, not a block', () => {
        const head = git('rev-parse', 'HEAD').trim();
        const r = autopilot({ ...ntfy, STUB_MODE: 'blocked', STUB_BLOCKED_BY: 'x'.repeat(5000) });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('failure 2/2 on T-03');
        expect(t03()).toMatchObject({ status: 'ready', blocked_by: null });
        expect(git('log', `${head}..HEAD`, '--format=%s')).not.toContain('apply implementer result');
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('T-03: el resultado (blocked) no pasa check:spec; no se aplicó');
        const b = body(curlCalls()[0]);
        expect(b.length <= 3000).toBe(true);
        expect(b).toContain('Failed: 2 failure(s); abandoned: T-03');
      });

      it('if ntfy fails, the run keeps its result and the summary is committed anyway', () => {
        const r = autopilot({ ...approved, ...ntfy, STUB_CURL_RC: '7' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('warning: ntfy failed (code 7); the run keeps its result');
        expect(git('log', '-1', '--format=%s')).toContain('Autopilot: summary of run');
        expect(git('status', '--porcelain')).toBe('');
      });

      it('if it crashes before the summary, it notifies with high priority', () => {
        const r = autopilot(ntfy, '--task', 'T-99');
        expect(r.status).not.toBe(0);
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(header(c, 'Title')).toMatch(/stopped unexpectedly$/);
        expect(body(c)).toContain(`exited with code ${r.status}`);
        expect(body(c)).toContain('Done: 0 task(s) · Failed: 0 failure(s)');
        expect(body(c)).toContain('Next action: check the terminal');
      });

      it('reads the topic from AUTOPILOT_LOCAL_CONFIG and does not pass it to the implementer', () => {
        const cfg = join(root, '..', `${root.split('/').pop()}-config.sh`); // local configuration (outside the repo)
        writeFileSync(cfg, 'NTFY_TOPIC=from-config\nNTFY_URL=https://ntfy.example\n');
        const r = autopilot({ ...approved, AUTOPILOT_LOCAL_CONFIG: cfg }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(curlCalls()[0].at(-1)).toBe('https://ntfy.example/from-config');
        expect(readFileSync(join(root, '.autopilot/stub-env-T-03.txt'), 'utf8')).toContain('NTFY_TOPIC=\n');
        rmSync(cfg, { force: true });
      });

      it('loads AUTOPILOT_SECRETS: its key reaches the decider, never the implementer or the reviewer', () => {
        const secrets = join(root, '..', `${root.split('/').pop()}-secrets.sh`); // outside the repo
        writeFileSync(secrets, 'export TYPESAFE_API_KEY=k-from-secrets\nexport OTHER_SECRET=s-from-secrets\n');
        const r = autopilot({ ...approved, AUTOPILOT_SECRETS: secrets }, '--max-tasks', '1');
        rmSync(secrets, { force: true });
        expect(r.status).toBe(0);
        expect(readFileSync(join(root, '.autopilot/stub-decide-env.txt'), 'utf8')).toBe('TYPESAFE_API_KEY=k-from-secrets\n');
        for (const f of ['stub-env-T-03.txt', 'stub-env-review.txt']) {
          const env = readFileSync(join(root, '.autopilot', f), 'utf8');
          expect(env).toContain('TYPESAFE_API_KEY=\n');
          expect(env).toContain('OTHER_SECRET=\n');
        }
        expect(r.stdout).not.toContain('k-from-secrets');
      });

      it('without a secrets file the run goes on (the decider has no key and its decisions escalate)', () => {
        const r = autopilot({ ...approved, AUTOPILOT_SECRETS: join(root, 'no-such-secrets.sh') }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(readFileSync(join(root, '.autopilot/stub-decide-env.txt'), 'utf8')).toBe('TYPESAFE_API_KEY=\n');
      });

      it('--dry-run shows the notice without sending it', () => {
        const r = autopilot(ntfy, '--dry-run');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('ntfy notice that would be sent (not sent: --dry-run');
        expect(r.stdout).not.toContain('test-topic');
        expect(curlCalls()).toEqual([]);
      });

      it('--no-notify does not call curl, also when it needs intervention; the LOG.md summary is the same', () => {
        const r = autopilot({ ...ntfy, STUB_MODE: 'fail' }, '--no-notify');
        expect(r.status).toBe(1);
        expect(curlCalls()).toEqual([]);
        expect(r.stdout).toContain('ntfy notice not sent (--no-notify)');
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('T-03 abandonada en esta corrida tras 2 fallos (tope por tarea 2)');
        expect(log).toContain('- Próxima acción autorizada: el usuario revisa este resumen');
        expect(git('log', '-1', '--format=%s')).toContain('Autopilot: summary of run');
      });

      it('--no-notify also silences the notice of a crash', () => {
        const r = autopilot(ntfy, '--no-notify', '--task', 'T-99');
        expect(r.status).not.toBe(0);
        expect(curlCalls()).toEqual([]);
      });
    });

    describe('push after review (DEC-004 point 1)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const push = { AUTOPILOT_PUSH_REMOTE: 'origin' };
      const bare = () => join(root, '..', `${root.split('/').pop()}-remote.git`);
      const remoteRefs = () => execFileSync('git', ['-C', bare(), 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' });
      const reviewSha = (id) => git('log', '-1', '--format=%H', `--grep=^${id}: independent review (approved)`).trim();
      const result = () => {
        const [d] = readdirSync(join(root, '.autopilot')).filter((x) => x.startsWith('20'));
        return JSON.parse(readFileSync(join(root, '.autopilot', d, 'result.json'), 'utf8'));
      };
      let branch;
      beforeEach(() => { // a temporary bare remote, configured as origin (in .git/config: the tree stays clean)
        execFileSync('git', ['init', '--bare', '-q', bare()]);
        git('remote', 'add', 'origin', bare());
        branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      });
      afterEach(() => rmSync(bare(), { recursive: true, force: true }));

      it('after an approved verdict (reviewed) it pushes HEAD to the base branch, without --force', () => {
        const r = autopilot({ ...approved, ...push }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`pushed after T-03: origin HEAD:${branch}`);
        expect(t03().status).toBe('reviewed');
        expect(remoteRefs()).toBe(`refs/heads/${branch} ${reviewSha('T-03')}\n`); // the verdict commit; not the later summary
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain(`- Push tras revisión (DEC-004; \`git push origin HEAD:${branch}\`): tareas empujadas: T-03.`);
        expect(log).toContain(`push tras T-03 a origin/${branch}`);
        expect(log).toContain('El orquestador no marca accepted; el push solo lleva lo revisado.');
        expect(result()).toMatchObject({ pushed: ['T-03'], push_rejected: [] });
        expect(readFileSync(join(root, '.autopilot/stub-env-T-03.txt'), 'utf8')).toContain('AUTOPILOT_PUSH_REMOTE=\n');
      });

      it('AUTOPILOT_PUSH_BRANCH chooses the remote branch', () => {
        const r = autopilot({ ...approved, ...push, AUTOPILOT_PUSH_BRANCH: 'reviewed' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(remoteRefs()).toBe(`refs/heads/reviewed ${reviewSha('T-03')}\n`);
      });

      it('nothing is pushed with a rejected verdict', () => {
        const r = autopilot(push, '--max-tasks', '1'); // the reviewer double rejects by default
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('verdict on T-03: rejected');
        expect(r.stdout).not.toContain('pushed after');
        expect(remoteRefs()).toBe('');
        expect(result()).toMatchObject({ pushed: [], push_rejected: [] });
      });

      it('off by default: with a remote but without AUTOPILOT_PUSH_REMOTE it pushes nothing', () => {
        const r = autopilot(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(t03().status).toBe('reviewed');
        expect(remoteRefs()).toBe('');
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).not.toContain('- Push tras revisión');
        expect(result()).toMatchObject({ pushed: [], push_rejected: [] });
      });

      it('a rejected push (not a fast-forward) undoes nothing, is not retried, stops pushing and asks for intervention', () => {
        editTasks((ts) => { for (const id of ['T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; }); // only T-03 and T-04
        git('commit', '-q', '-am', 'only T-03 and T-04\n\nTask: none\nReq: none');
        const diverged = git('commit-tree', 'HEAD^{tree}', '-m', 'diverged').trim(); // not an ancestor of the local branch
        // Straight into the bare remote (the tests may run under an autopilot whose GIT_CONFIG_* disable pushurl).
        execFileSync('git', ['-C', root, 'push', '-q', bare(), `${diverged}:refs/heads/${branch}`],
          { env: { ...process.env, GIT_CONFIG_COUNT: '0' } });
        const ntfy = { NTFY_TOPIC: 'test-topic', NTFY_URL: 'https://ntfy.example' };
        const r = autopilot({ ...approved, ...push, ...ntfy });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`warning: push after T-03 to origin HEAD:${branch} rejected`);
        expect(r.stdout).toContain('push after T-04 skipped: the push after T-03 was rejected in this run');
        expect(r.stdout).not.toContain('pushed after');
        expect(remoteRefs()).toBe(`refs/heads/${branch} ${diverged}\n`);
        // Nothing undone: both tasks stay reviewed, with their commits on the local branch.
        expect(task(readTasks(), 'T-03').status).toBe('reviewed');
        expect(task(readTasks(), 'T-04').status).toBe('reviewed');
        expect(reviewSha('T-03')).not.toBe('');
        expect(git('status', '--porcelain')).toBe('');
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('rechazado tras T-03 (no se deshizo nada ni se reintentó; el usuario concilia con el remoto)');
        expect(result()).toMatchObject({
          pushed: [], push_rejected: ['T-03'], intervention: true, done: ['T-03', 'T-04'],
          next_action: expect.stringContaining(`the push after T-03 was rejected (see .autopilot/`),
        });
        expect(result().next_action).toContain(`git push origin ${branch}:${branch}`);
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(body(c)).toContain('push rejected after: T-03');
        const [d] = readdirSync(join(root, '.autopilot')).filter((x) => x.startsWith('20'));
        expect(readFileSync(join(root, '.autopilot', d, 'push.err'), 'utf8')).not.toBe('');
      });

      it('the implementer and the reviewer still cannot push (their pushurl is disabled), also with the push on', () => {
        const r = autopilot({ ...approved, ...push, STUB_PUSH: 'origin' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(readFileSync(join(root, '.autopilot/stub-push-T-03.txt'), 'utf8').trim()).not.toBe('0');
        expect(readFileSync(join(root, '.autopilot/stub-push-review.txt'), 'utf8').trim()).not.toBe('0');
        expect(remoteRefs()).toBe(`refs/heads/${branch} ${reviewSha('T-03')}\n`); // only the orchestrator's push
      });
    });

    describe('demo deploy (DEC-004 point 2)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const base = () => root.split('/').pop();
      const deployLog = () => join(root, '..', `${base()}-deploy.log`); // what the deploy doubles saw
      const localConfig = () => join(root, '..', `${base()}-local.config.sh`);
      const result = () => {
        const [d] = readdirSync(join(root, '.autopilot')).filter((x) => x.startsWith('20'));
        return JSON.parse(readFileSync(join(root, '.autopilot', d, 'result.json'), 'utf8'));
      };
      const deploys = () => { try { return readFileSync(deployLog(), 'utf8'); } catch { return ''; } };
      const prompts = () => readFileSync(join(root, '.autopilot/stub-prompt-T-03.txt'), 'utf8').split('\x1e\n').filter((p) => p.trim());
      const ENV_HOOK = 'autopilot_deploy_env() { export DEMO_SECRET=demo-role-key; }';
      const IDENTITY_HOOK = 'autopilot_deploy_identity() { printf "%s\\n" "${STUB_IDENTITY-arn:demo}"; }';
      // Project configuration (in git) and local configuration (outside git, with the demo identities).
      const configure = ({ cmd = 'echo "deploy DEMO_SECRET=$DEMO_SECRET" >>"$STUB_DEPLOY_LOG"; exit ${STUB_DEPLOY_RC:-0}',
        post = 'echo post >>"$STUB_DEPLOY_LOG"; echo "acceptance: 3 passed"', hooks = [ENV_HOOK, IDENTITY_HOOK],
        accounts = '("arn:other" "arn:demo")' } = {}) => {
        writeFileSync(join(root, 'scripts/autopilot.config.sh'), [
          cmd === null ? '' : `AUTOPILOT_DEMO_DEPLOY_CMD='${cmd}'`,
          post === null ? '' : `AUTOPILOT_DEMO_POSTDEPLOY_CMD='${post}'`,
          ...hooks, '',
        ].join('\n'));
        writeFileSync(localConfig(), accounts === null ? '' : `AUTOPILOT_DEMO_ACCOUNTS=${accounts}\n`);
        git('add', '-A');
        git('commit', '-q', '-m', 'demo deploy config\n\nTask: none\nReq: none');
      };
      const deployRun = (env = {}, ...args) => autopilot({
        ...approved, STUB_DEPLOY: 'T-03', STUB_DEPLOY_LOG: deployLog(), AUTOPILOT_LOCAL_CONFIG: localConfig(), ...env,
      }, ...args);
      afterEach(() => { rmSync(deployLog(), { force: true }); rmSync(localConfig(), { force: true }); });

      it('identity in the list: deploys with the hook credentials, runs the post-deploy and relaunches the implementer', () => {
        configure();
        const r = deployRun({}, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(deploys()).toBe('deploy DEMO_SECRET=demo-role-key\npost\n');
        expect(r.stdout).toContain('demo deploy of T-03 done as arn:demo; then `echo post');
        expect(r.stdout).toContain('implementer on T-03 (attempt 2');
        expect(r.stdout).toContain('verdict on T-03: approved → status reviewed');
        expect(r.stdout).not.toContain('failure 1/');
        const [first, second] = prompts();
        expect(first).not.toContain('Deploy result');
        expect(second).toContain('the orchestrator deployed this task to a demo account whose identity it checked');
        expect(second).toContain('(exit 0; full output in');
        expect(second).toContain('<<<acceptance: 3 passed>>>');
        expect(second).not.toContain('demo-role-key');
        // Neither the hook credentials nor the deploy configuration reach the implementer.
        const seen = readFileSync(join(root, '.autopilot/stub-env-T-03.txt'), 'utf8');
        expect(seen).toContain('DEMO_SECRET=\n');
        expect(seen).toContain('AUTOPILOT_DEMO_DEPLOY_CMD=\n');
        expect(readFileSync(join(root, '.autopilot/stub-env-review.txt'), 'utf8')).toContain('DEMO_SECRET=\n'); // nor the reviewer
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('T-03 desplegada en la cuenta demo por el orquestador; después `echo post');
        expect(log).toContain('el orquestador solo despliega en cuentas demo con identidad comprobada): ninguna.');
        expect(log).toContain('desplegadas y relanzadas: T-03; no desplegadas (quedan en Pendiente deploy; motivo en Hecho): ninguna.');
        expect(result()).toMatchObject({ done: ['T-03'], deploy_pending: [], demo_deployed: ['T-03'], demo_refused: [] });
        expect(git('status', '--porcelain')).toBe('');
      });

      const refused = (r, reasonEn) => {
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(`warning: demo deploy of T-03 not done: ${reasonEn}`);
        expect(r.stdout).toContain('T-03 waits for a deploy (Pendiente deploy): not counted as a failure');
        expect(r.stdout).not.toContain('attempt 2');
        expect(t03().status).toBe('in_progress');
        expect(result()).toMatchObject({ deploy_pending: ['T-03'], demo_deployed: [], demo_refused: ['T-03'], intervention: true });
        expect(result().next_action).toContain('demo deploy not done for T-03');
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('T-03: despliegue demo no hecho (');
        expect(log).toContain('desplegadas y relanzadas: ninguna; no desplegadas (quedan en Pendiente deploy; motivo en Hecho): T-03.');
        expect(log).toContain('el orquestador solo despliega en cuentas demo con identidad comprobada): T-03.');
        return log;
      };

      it('identity outside the list: no deploy, Pendiente deploy for the user, flagged in the notice; the identity stays out of LOG.md', () => {
        configure();
        const r = deployRun({ STUB_IDENTITY: 'arn:production', NTFY_TOPIC: 'test-topic', NTFY_URL: 'https://ntfy.example' });
        const log = refused(r, 'identity arn:production is not in AUTOPILOT_DEMO_ACCOUNTS');
        expect(deploys()).toBe('');
        expect(log).not.toContain('arn:production');
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(body(c)).toContain('demo deploy not done: T-03');
      });

      it('empty identity: no deploy', () => {
        configure();
        refused(deployRun({ STUB_IDENTITY: '' }), 'autopilot_deploy_identity gave no identity');
        expect(deploys()).toBe('');
      });

      it('a failing identity hook: no deploy', () => {
        configure({ hooks: [ENV_HOOK, 'autopilot_deploy_identity() { echo arn:demo; return 1; }'] });
        refused(deployRun(), 'autopilot_deploy_identity gave no identity');
        expect(deploys()).toBe('');
      });

      it('a missing hook: no deploy', () => {
        configure({ hooks: [ENV_HOOK] });
        refused(deployRun(), 'the autopilot_deploy_env or autopilot_deploy_identity hook is missing');
        expect(deploys()).toBe('');
      });

      it('no demo identities in the local configuration: no deploy', () => {
        configure({ accounts: null });
        refused(deployRun(), 'AUTOPILOT_DEMO_ACCOUNTS is empty in the local configuration');
        expect(deploys()).toBe('');
      });

      it('a failed deploy: Pendiente deploy for the user, no post-deploy, no relaunch', () => {
        configure();
        refused(deployRun({ STUB_DEPLOY_RC: '7' }), 'the demo deploy failed (code 7');
        expect(deploys()).toBe('deploy DEMO_SECRET=demo-role-key\n');
      });

      it('at most one demo deploy per task and run: a second Pendiente deploy goes to the user', () => {
        configure();
        const r = deployRun({ STUB_DEPLOY_AGAIN: '1' });
        expect(r.stdout).toContain('implementer on T-03 (attempt 2');
        expect(r.stdout).toContain('warning: demo deploy of T-03 not done: already deployed once in this run');
        expect(deploys()).toBe('deploy DEMO_SECRET=demo-role-key\npost\n');
        expect(result()).toMatchObject({ deploy_pending: ['T-03'], demo_deployed: ['T-03'], demo_refused: ['T-03'] });
      });

      it('off by default: hooks and identities without AUTOPILOT_DEMO_DEPLOY_CMD deploy nothing (as today)', () => {
        configure({ cmd: null });
        const r = deployRun();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('T-03 waits for a deploy (Pendiente deploy): not counted as a failure');
        expect(r.stdout).not.toContain('demo deploy');
        expect(deploys()).toBe('');
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('- Pendiente deploy (lo hace el usuario; el orquestador no despliega): T-03.');
        expect(log).not.toContain('Despliegue demo');
        expect(result()).toMatchObject({ deploy_pending: ['T-03'], demo_deployed: [], demo_refused: [] });
      });
    });

    describe('reviewer approval of additive acceptance diffs (DEC-004 point 3)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const rejected = { STUB_VERDICT: '{"verdict":"rejected","findings":["REQ-001: la prueba no corresponde a ningún ejemplo"],"notes":"n"}' };
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
      const result = () => JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'));
      const prompts = () => readFileSync(join(root, '.autopilot/stub-prompt-T-03.txt'), 'utf8').split('\x1e\n').filter((p) => p.trim());
      const reviewerLaunched = () => readdirSync(runDir()).includes('T-03-acceptance-review-prompt.md');
      const waitRun = (env = {}, ...args) =>
        autopilot({ AUTOPILOT_ACCEPTANCE_REVIEW: 'additive', STUB_WAIT: 'T-03', ...env }, ...args);
      beforeEach(() => { // an existing acceptance test the spec task may only add to
        mkdirSync(join(root, 'tests/acceptance'), { recursive: true });
        writeFileSync(join(root, 'tests/acceptance/existing.txt'), 'example one\nexample two\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'existing acceptance test\n\nTask: T-03\nReq: REQ-001');
      });

      it('additive diff approved: acceptance_review recorded, the implementer is relaunched and the task follows its cycle', () => {
        const r = waitRun(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('reviewer (claude) on the tests/acceptance/ diff of T-03');
        expect(r.stdout).toContain('verdict on the tests/acceptance/ diff of T-03: approved');
        expect(r.stdout).toContain('implementer on T-03 (attempt 2');
        expect(r.stdout).toContain('verdict on T-03: approved → status reviewed');
        expect(r.stdout).not.toContain('waits for the user to approve');
        expect(r.stdout).not.toContain('failure 1/');
        expect(t03()).toMatchObject({ status: 'reviewed', acceptance_review: { verdict: 'approved', reviewer: expect.stringContaining('claude -p 0.0.0') } });
        expect(t03().acceptance_review.commits).toMatch(/^[0-9a-f]{7,}\.\.[0-9a-f]{7,}$/);
        const prompt = readFileSync(join(runDir(), 'T-03-acceptance-review-prompt.md'), 'utf8');
        expect(prompt).toContain('every new test correspond to an example of a REQ cited by the task');
        expect(prompt).toContain('skip, only');
        expect(prompt).toContain('### REQ-001');
        expect(prompt).toContain('+stub change for T-03');
        expect(prompt).not.toContain('example two'); // only the diff, not the existing tests
        const [first, second] = prompts();
        expect(first).not.toContain('Acceptance diff approved');
        expect(second).toContain('Acceptance diff approved (DEC-004 point 3)');
        expect(second).toContain('Continue the task as if the user had approved it.');
        expect(git('log', '--format=%s')).toContain('T-03: acceptance tests review (approved)');
        expect(git('log', '-1', '--format=%b', '--grep=^T-03: acceptance tests review')).toContain('Task: T-03\nReq: REQ-001, REQ-002, REQ-003, REQ-004');
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain('Hecho: revisión del diff aditivo de tests/acceptance/ de T-03');
        expect(log).toContain('T-03: el revisor aprobó el diff aditivo de tests/acceptance/');
        expect(log).toContain('- Aprobación de tests/acceptance/ por el revisor (DEC-004; solo diffs aditivos): aprobadas y relanzadas: T-03; quedan para el usuario (motivo en Hecho): ninguna.');
        expect(result()).toMatchObject({ done: ['T-03'], user_wait: [], acceptance_approved: ['T-03'], acceptance_refused: [] });
        expect(git('status', '--porcelain')).toBe('');
      });

      it('additive diff rejected: the verdict is recorded and the task waits for the user', () => {
        const r = waitRun({ ...rejected, NTFY_TOPIC: 'test-topic', NTFY_URL: 'https://ntfy.example' });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('verdict on the tests/acceptance/ diff of T-03: rejected');
        expect(r.stdout).toContain('T-03 waits for the user to approve the tests/acceptance/ diff (spec task)');
        expect(r.stdout).not.toContain('attempt 2');
        expect(t03()).toMatchObject({ status: 'in_progress', review: null, acceptance_review: { verdict: 'rejected', findings: ['REQ-001: la prueba no corresponde a ningún ejemplo'] } });
        expect(git('log', '--format=%s')).toContain('T-03: acceptance tests review (rejected)');
        expect(result()).toMatchObject({ user_wait: ['T-03'], acceptance_approved: [], acceptance_refused: ['T-03'], intervention: true });
        expect(result().next_action).toContain('approve the tests/acceptance/ diff of T-03 (not approved by the reviewer for T-03');
        const [c] = curlCalls();
        expect(header(c, 'Priority')).toBe('high');
        expect(body(c)).toContain('acceptance diff not approved by the reviewer: T-03');
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('quedan para el usuario (motivo en Hecho): T-03.');
      });

      for (const [mode, reason] of [
        ['delete', 'tests/acceptance/existing.txt: deleted'],
        ['modify', 'tests/acceptance/existing.txt: 1 line(s) deleted'],
        ['rename', 'tests/acceptance/existing.txt: renamed to tests/acceptance/renamed.txt'],
        ['chmod', 'tests/acceptance/existing.txt: mode change 100644 → 100755'],
        ['runner', 'package.json: test-runner configuration (package.json) changed outside tests/acceptance/'],
      ]) {
        it(`not additive (${mode}): no reviewer, it waits for the user`, () => {
          if (mode === 'runner') {
            editTasks((ts) => { task(ts, 'T-03').touches.push('package.json'); });
            git('commit', '-q', '-am', 'T-03 touches package.json\n\nTask: T-03\nReq: REQ-001');
          }
          const r = waitRun({ ...approved, STUB_ACCEPTANCE: mode });
          expect(r.status).toBe(0);
          expect(r.stdout).toContain(`T-03: tests/acceptance/ diff not approved by the reviewer: not additive: ${reason}`);
          expect(r.stdout).toContain('T-03 waits for the user to approve the tests/acceptance/ diff (spec task)');
          expect(reviewerLaunched()).toBe(false);
          expect(t03()).toMatchObject({ status: 'in_progress' });
          expect(t03().acceptance_review).toBe(undefined);
          expect(readFileSync(join(runDir(), 'T-03-acceptance-check.txt'), 'utf8')).toContain(reason);
          expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('T-03: diff de tests/acceptance/ sin aprobación del revisor (no es aditivo: ');
          expect(result()).toMatchObject({ user_wait: ['T-03'], acceptance_refused: ['T-03'] });
        });
      }

      it('at most one approval per task and run: a second acceptance diff goes to the user', () => {
        const r = waitRun({ ...approved, STUB_ACCEPTANCE_AGAIN: '1' });
        expect(r.stdout).toContain('implementer on T-03 (attempt 2');
        expect(r.stdout).toContain('T-03: tests/acceptance/ diff not approved by the reviewer: a diff of it was already approved in this run');
        expect(t03()).toMatchObject({ status: 'in_progress', acceptance_review: { verdict: 'approved' } });
        expect(result()).toMatchObject({ user_wait: ['T-03'], acceptance_approved: ['T-03'], acceptance_refused: ['T-03'] });
      });

      it('off by default: an additive diff waits for the user, as today, without a reviewer', () => {
        const r = autopilot({ ...approved, STUB_WAIT: 'T-03' });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('T-03 waits for the user to approve the tests/acceptance/ diff (spec task)');
        expect(r.stdout).not.toContain('tests/acceptance/ diff of T-03');
        expect(reviewerLaunched()).toBe(false);
        expect(t03().acceptance_review).toBe(undefined);
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).not.toContain('Aprobación de tests/acceptance/');
        expect(result()).toMatchObject({ user_wait: ['T-03'], acceptance_approved: [], acceptance_refused: [] });
      });
    });

    describe('researcher (DEC-005)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      // only T-03 fails; --max-tasks 1 stops once it is done (otherwise its dependents follow)
      const on = (env = {}) => autopilot({ ...approved, STUB_FAIL: 'T-03', AUTOPILOT_RESEARCH: 'web', ...env }, '--max-tasks', '1');
      const prompts = () => readFileSync(join(root, '.autopilot/stub-prompt-T-03.txt'), 'utf8').split('\x1e\n').filter((p) => p.trim());
      const researchArgs = () => readFileSync(join(root, '.autopilot/stub-research-args-T-03.txt'), 'utf8').split('\n');
      const researchPrompt = () => readFileSync(join(root, '.autopilot/stub-research-prompt-T-03.txt'), 'utf8');
      const log = () => readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      const spec = () => readFileSync(join(root, 'spec/SPEC.md'), 'utf8');
      const result = () => {
        const d = readdirSync(join(root, '.autopilot')).find((x) => x.startsWith('20'));
        return JSON.parse(readFileSync(join(root, '.autopilot', d, 'result.json'), 'utf8'));
      };
      const researcherLaunched = () => { try { readFileSync(join(root, '.autopilot/stub-research-args-T-03.txt')); return true; } catch { return false; } };

      it('two failures in a row: researches, commits the report and retries once with its path in the prompt', () => {
        const r = on();
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('failure 2/2 on T-03');
        expect(r.stdout).toMatch(/researcher \(web\) on T-03: \d+ bytes of context; caps 900s and US\$ 2/);
        expect(r.stdout).toContain('implementer on T-03 (attempt 3');
        expect(r.stdout).not.toContain('reached the cap');
        expect(t03()).toMatchObject({ status: 'reviewed' });
        // what the researcher got: the question, the task, the attempts and its tools and caps
        const p = researchPrompt();
        expect(p).toMatch(/^You are a researcher/);
        expect(p).toContain('Task under investigation: T-03.');
        expect(p).toContain('Question: Why does task T-03 keep failing');
        expect(p).toContain('### REQ-001');
        expect(p).toContain('## Attempt 1');
        expect(p).toContain('## Attempt 2');
        expect(p).not.toContain('could not do it'); // the implementer's final message is not passed (DEC-007)
        expect(p).not.toContain('live.log');
        expect(p).not.toContain('.jsonl');
        expect(p).toContain('### The result it delivered (JSON)');
        expect(p).toContain('Limits: 900 seconds and US$ 2 for this invocation');
        const args = researchArgs();
        for (const a of ['-p', '--output-format', 'stream-json', '--no-session-persistence', 'WebSearch', 'WebFetch', 'Write(./research/T-03.md)', '--max-budget-usd', '2']) expect(args).toContain(a);
        expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('2');
        expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--disallowedTools'))).not.toContain('Agent');
        // the implementer never hears of research until the relaunch, which gets the report as advice
        const ps = prompts();
        expect(ps).toHaveLength(3);
        expect(ps[0]).not.toContain('research');
        expect(ps[1]).not.toContain('research');
        expect(ps[2]).toContain('Research note (DEC-005): this task failed twice in a row in this run');
        expect(ps[2]).toContain('research/T-03.md (suggested action: reintentar, confidence: media');
        expect(ps[2]).toContain('It is advice, not authority');
        // report committed by the orchestrator, with the task's trailers; both steps in LOG.md
        expect(git('log', '--format=%s')).toContain('T-03: research report, retry with its recommendation');
        expect(git('log', '-1', '--format=%b', '--grep=^T-03: research report')).toContain('Task: T-03\nReq: REQ-001, REQ-002, REQ-003, REQ-004');
        expect(git('ls-files', 'research')).toBe('research/T-03.md\n');
        expect(log()).toContain('investigador (claude, modo web) vía autopilot');
        expect(log()).toContain('- Hecho: investigación de T-03 tras dos fallos seguidos en esta corrida (DEC-005). Pregunta: «¿Por qué falla T-03');
        expect(log()).toContain('Resultado: acción sugerida: reintentar; confianza: media.');
        expect(log()).toMatch(/- Límites: \d+ s de 900 s; costo informado por el agente: US\$ 0\.37 de US\$ 2\./);
        expect(log()).toContain('- Decisión: reintentar T-03 una vez: la decide el decisor (stub, confianza 0.85; DEC-015); el investigador sugería reintentar con confianza media. Recomendación en `research/T-03.md`.');
        expect(log()).toContain('- Investigador (DEC-005; modo web, topes 900 s y US$ 2 por invocación): investigadas: T-03; reintentadas con la recomendación: T-03; escaladas al usuario (blocked con su Q-NN): ninguna.');
        expect(result()).toMatchObject({ researched: ['T-03'], research_retried: ['T-03'], research_escalated: [], abandoned: [] });
        expect(git('status', '--porcelain')).toBe('');
      });

      it('a researched retry that fails again is escalated: blocked by a new Q-NN pointing to the report', () => {
        const r = on({ STUB_RESEARCH_AGAIN: '1' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('failure 3/2 on T-03');
        expect(r.stdout).not.toContain('attempt 4');
        expect(t03()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
        expect(spec()).toContain('| Q-03 | ¿Cómo sigue T-03? El orquestador la escaló tras investigarla: volvió a fallar tras reintentar con la recomendación del investigador (informe en research/T-03.md). | bloqueante | T-03 | usuario | — |');
        expect(log()).toContain('- Decisión: escalar T-03 al usuario (DEC-005): volvió a fallar tras reintentar con la recomendación del investigador. Queda `blocked` por Q-03');
        expect(git('log', '--format=%s')).toContain('T-03: escalated to the user after research');
        expect(result()).toMatchObject({ researched: ['T-03'], research_retried: ['T-03'], research_escalated: ['T-03'], intervention: true });
        expect(git('status', '--porcelain')).toBe('');
      });

      for (const [mode, reason, extra] of [
        ['escalate', 'el decisor concluye del informe que hay que escalar', {}],
        ['low', 'el decisor (stub) no resolvió qué hacer con el informe (confidence 0.5 < 0.8 (threshold))', {}], // DEC-015: the decider's threshold
        ['invalid', 'investigación sin resultado utilizable: informe inválido: missing the "## Evidencia" section', {}],
        ['none', 'investigación sin resultado utilizable: no dejó informe en research/T-03.md', {}],
        ['budget', 'investigación sin resultado utilizable: cortado por el tope de costo (US$ 2)', {}],
        ['slow', 'investigación sin resultado utilizable: cortado por el tope de tiempo (1 s)', { AUTOPILOT_RESEARCH_WEB_SECONDS: '1' }],
      ]) {
        it(`STUB_RESEARCH=${mode}: no retry, the task is escalated (blocked by Q-03)`, () => {
          const r = on({ STUB_RESEARCH: mode, ...extra });
          expect(r.status).toBe(1);
          expect(r.stdout).not.toContain('attempt 3');
          expect(t03()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
          expect(log()).toContain(`- Decisión: escalar T-03 al usuario (DEC-005): ${reason}`);
          expect(result()).toMatchObject({ researched: ['T-03'], research_retried: [], research_escalated: ['T-03'] });
          expect(git('status', '--porcelain')).toBe('');
        });
      }

      it('the researcher\'s confidence no longer routes (T-37): a "baja" report the decider settles as reintentar is retried', () => {
        const r = on({ STUB_RESEARCH: 'low', STUB_DECIDE_research_action: 'reintentar:0.95' });
        expect(r.stdout).toContain('decide research_action (stub): proceed reintentar (confidence 0.95)');
        expect(prompts()).toHaveLength(3);
        expect(log()).toContain('- Decisión: reintentar T-03 una vez: la decide el decisor (stub, confianza 0.95; DEC-015); el investigador sugería reintentar con confianza baja.');
      });

      it('the decider, not the report, settles the action (T-37): a report that suggests escalar is retried if the decider says reintentar', () => {
        on({ STUB_RESEARCH: 'escalate', STUB_DECIDE_research_action: 'reintentar:0.9' });
        expect(prompts()).toHaveLength(3);
        expect(log()).toContain('el investigador sugería escalar con confianza media.');
      });

      it('recortar: the split-off work becomes a new specified task, not taken in the run, and the task is escalated', () => {
        const r = on({ STUB_RESEARCH: 'cut' });
        expect(r.status).toBe(1);
        expect(t03()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
        expect(task(readTasks(), 'T-09')).toMatchObject({ title: 'Exportación diferida', status: 'specified', kind: 'spec', depends_on: ['T-03'], touches: ['tests/acceptance/'] });
        expect(spec()).toContain('| Q-03 | ¿Aprobar el recorte de T-03 propuesto por el investigador (informe en research/T-03.md)? T-09 (specified) toma «Exportación diferida»');
        expect(log()).toContain('el recorte propuesto queda como T-09 en `specified`, no elegible hasta que el usuario lo apruebe');
        expect(r.stdout).not.toContain('implementer on T-09');
        expect(git('status', '--porcelain')).toBe('');
      });

      it('a researcher that changes another file stops the run; nothing is discarded or committed', () => {
        const r = on({ STUB_RESEARCH: 'outside' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('stop: the researcher changed files outside research/T-03.md on T-03');
        expect(git('status', '--porcelain', '--untracked-files=all')).toContain('?? stray-T-03.txt');
        expect(git('log', '--format=%s')).not.toContain('research report');
        expect(t03().status).toBe('ready');
      });

      it('scope violations are not researched (they go to the user as today)', () => {
        const r = autopilot({ AUTOPILOT_RESEARCH: 'web', STUB_MODE: 'outside' });
        expect(r.stdout).toContain('commits outside its scope');
        expect(researcherLaunched()).toBe(false);
      });

      describe('reviewer trigger (research_question)', () => {
        const blocker = '{"verdict":"rejected","findings":["REQ-001: falla contra la API (no confirmado: sin red)"],"notes":"n","research_question":"¿La API v2 sigue aceptando el campo legacy?"}';
        const reviewTrigger = (env = {}) => autopilot({ AUTOPILOT_RESEARCH: 'web', STUB_VERDICT: blocker, ...env }, '--max-tasks', '2');
        const reviewPrompt = (n) => {
          return readFileSync(join(root, '.autopilot', `stub-review-prompt-${n}.txt`), 'utf8');
        };

        it('a rejection with research_question is researched; on reintentar the task goes back to in_progress, is relaunched and reviewed again', () => {
          const r = reviewTrigger({ STUB_VERDICT_NEXT: '{"verdict":"approved","findings":[],"notes":"ok"}' });
          expect(r.status).toBe(0);
          expect(reviewPrompt(1)).toContain('also add "research_question" to the JSON');
          expect(r.stdout).toContain('verdict on T-03: rejected → status verified_auto');
          expect(r.stdout).toContain('researcher (web) on T-03');
          expect(r.stdout).toContain('implementer on T-03 (attempt 2');
          expect(r.stdout).toContain('verdict on T-03: approved → status reviewed');
          expect(t03()).toMatchObject({ status: 'reviewed', review: { verdict: 'approved' } });
          const p = researchPrompt();
          expect(p).toContain('Question: ¿La API v2 sigue aceptando el campo legacy?');
          expect(p).toContain('Blocker it could not resolve: ¿La API v2 sigue aceptando el campo legacy?');
          expect(p).toContain('- REQ-001: falla contra la API');
          expect(p).toContain('stub change for T-03'); // the task's diff
          const ps = prompts();
          expect(ps).toHaveLength(2);
          expect(ps[1]).toContain('Research note (DEC-005): the independent reviewer rejected it with a blocker it could not resolve');
          expect(log()).toContain('- Hecho: investigación de T-03 tras un rechazo del revisor con un bloqueo que no sabe resolver (DEC-005). Pregunta: «¿La API v2 sigue aceptando el campo legacy?»');
          expect(log()).toContain('Vuelve de `verified_auto` a `in_progress` (rechazada por el revisor) para relanzarla con sus hallazgos.');
          expect(result()).toMatchObject({ researched: ['T-03'], research_retried: ['T-03'], research_escalated: [] });
          expect(git('status', '--porcelain')).toBe('');
        });

        it('a rejection after the researched retry is escalated (blocked by Q-03)', () => {
          const r = reviewTrigger();
          expect(r.status).toBe(1);
          expect(r.stdout).not.toContain('implementer on T-03 (attempt 3');
          expect(t03()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
          expect(log()).toContain('- Decisión: escalar T-03 al usuario (DEC-005): el revisor la rechazó tras el reintento con la recomendación del investigador.');
          expect(result()).toMatchObject({ researched: ['T-03'], research_retried: ['T-03'], research_escalated: ['T-03'] });
          expect(git('status', '--porcelain')).toBe('');
        });

        it('escalar on a review trigger blocks the task from verified_auto', () => {
          const r = reviewTrigger({ STUB_RESEARCH: 'escalate' });
          expect(r.status).toBe(1);
          expect(t03()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03', review: { verdict: 'rejected', research_question: '¿La API v2 sigue aceptando el campo legacy?' } });
          expect(r.stdout).not.toContain('attempt 2');
        });

        it('a rejection without research_question stays as today (verified_auto, no researcher)', () => {
          const r = autopilot({ AUTOPILOT_RESEARCH: 'web' }, '--max-tasks', '1'); // the reviewer double rejects with no question
          expect(r.stdout).toContain('verdict on T-03: rejected → status verified_auto');
          expect(researcherLaunched()).toBe(false);
          expect(t03().status).toBe('verified_auto');
        });

        it('off: the reviewer prompt does not mention research_question and nothing is researched', () => {
          const r = autopilot({ STUB_VERDICT: blocker }, '--max-tasks', '1');
          expect(reviewPrompt(1)).not.toContain('research_question');
          expect(r.stdout).not.toContain('researcher');
          expect(researcherLaunched()).toBe(false);
          expect(t03().status).toBe('verified_auto');
        });
      });

      it('off by default: two failures abandon the task as today, without a researcher', () => {
        const r = autopilot({ STUB_MODE: 'fail' });
        expect(r.stdout).toContain('T-03 reached the cap of 2 failures: abandoned in this run');
        expect(r.stdout).not.toContain('researcher');
        expect(researcherLaunched()).toBe(false);
        expect(log()).not.toContain('- Investigador');
        expect(result()).toMatchObject({ researched: [], research_retried: [], research_escalated: [] });
      });
    });

    describe('isolated agents (DEC-008)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const args = (who) => readFileSync(join(root, `.autopilot/stub-args-${who}.txt`), 'utf8').split('\n');

      it('each role gets only its prompt on stdin in a new, ephemeral session; the result is written outside the repository', () => {
        const r = autopilot(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        const seen = readFileSync(join(root, '.autopilot/stub-env-T-03.txt'), 'utf8');
        expect(seen).toContain('CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
        const resultPath = /AUTOPILOT_RESULT=(.*)/.exec(seen)[1];
        expect(resultPath.startsWith(root)).toBe(false);
        expect(resultPath).toMatch(/autopilot-agent\.\w+\/T-03-result-1\.json$/);
        expect(existsSync(dirname(resultPath))).toBe(false); // removed once the result was moved
        const runDir = join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
        expect(JSON.parse(readFileSync(join(runDir, 'T-03-result-1.json'), 'utf8')).log).toContain('- Hecho: T-03 implementada por el stub.'); // no status (T-34)
        const impl = args('T-03');
        for (const a of ['-p', '--no-session-persistence', '--add-dir', dirname(resultPath)]) expect(impl).toContain(a);
        expect(impl.some((a) => a.includes('AGENTS.md'))).toBe(false);
        expect(args('review')).toContain('--no-session-persistence');
        expect(readFileSync(join(root, '.autopilot/stub-prompt-T-03.txt'), 'utf8')).not.toContain('.autopilot');
        expect(readFileSync(join(root, '.autopilot/stub-review-prompt-1.txt'), 'utf8')).not.toContain('.autopilot/');
        expect(t03().review.reviewer).toBe('claude -p 0.0.0 (Claude Code stub) (contexto limpio, autopilot)');
      });

      it('the tokens of every agent count in the summary and result.json, the reviewer too (T-18)', () => {
        const r = autopilot({ ...approved, STUB_REVIEW_USAGE: '1' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('T-03 review: input 7 · output 300 · cache read 9,000 · cache write 100');
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('T-03 review: entrada 7 · salida 300 · caché leída 9.000 · caché escrita 100');
        const runDir = join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
        expect(JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8')).tokens).toMatchObject({ input: 51, output: 11740, invocations: 2 });
      });

      it('an attempt the access guard denied is logged and the run goes on (DEC-018)', () => {
        const r = autopilot({ ...approved, STUB_PEEK: 'impl', STUB_PEEK_DENIED: '1' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('audit of the implementer session: 1 attempt(s) denied by the guard');
        expect(t03().status).toBe('reviewed');
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('1 intento(s) que la guarda negó');
      });

      it('an implementer session that reads .autopilot/ stops the run; nothing is integrated or applied', () => {
        const r = autopilot({ ...approved, STUB_PEEK: 'impl' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("stop: the implementer's session on T-03 reached another agent's context");
        expect(git('log', '--format=%s')).not.toContain('apply implementer result');
        expect(t03().status).toBe('ready');
      });

      it("a session that reads the agent's private paths (~/.claude) stops the run too", () => {
        const r = autopilot({ ...approved, STUB_PEEK: 'impl', STUB_PEEK_PATH: '~/.claude/projects/x/memory/MEMORY.md' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("stop: the implementer's session on T-03 reached another agent's context");
      });

      it('a reviewer session that reads .autopilot/ stops the run; its verdict is not recorded', () => {
        const r = autopilot({ ...approved, STUB_PEEK: 'review' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("stop: the reviewer's session on T-03 reached another agent's context");
        expect(t03()).toMatchObject({ status: 'verified_auto', review: null });
      });

      it('a researcher session that reads .autopilot/ stops the run; nothing is applied', () => {
        const r = autopilot({ ...approved, STUB_FAIL: 'T-03', AUTOPILOT_RESEARCH: 'web', STUB_PEEK: 'research' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("stop: the researcher's session on T-03 reached another agent's context");
        expect(git('log', '--format=%s')).not.toContain('research report');
      });
    });

    describe('test-author (DEC-006)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const on = { ...approved, AUTOPILOT_TEST_AUTHOR: 'on', AUTOPILOT_ACCEPTANCE_CMD: 'sh', AUTOPILOT_ACCEPTANCE_REVIEW: 'additive' };
      const t04 = () => task(readTasks(), 'T-04');
      const log = () => readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
      const result = () => JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'));
      const implLaunched = () => existsSync(join(root, '.autopilot/stub-prompt-T-04.txt'));
      beforeEach(() => { // only T-04 (REQ-002, app/src/orders/) is left to do: T-03 (spec) accepted, its dependents closed
        editTasks((ts) => { for (const id of ['T-03', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
        git('commit', '-q', '-am', 'only T-04\n\nTask: none\nReq: none');
      });

      it('red tests from the spec, approved by the reviewer, before the implementer; green before applying its result', () => {
        const r = autopilot(on);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('test-author (claude) on T-04');
        const sha = git('log', '-1', '--format=%h', '--grep=^T-04: acceptance tests by the test-author (red)').trim();
        expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).trim()).toBe('tests/acceptance/T-04.test.sh');
        expect(git('log', '-1', '--format=%b', sha)).toContain('Task: T-04\nReq: REQ-002\nTest-Author: autopilot');
        expect(readFileSync(join(runDir(), 'T-04-red.txt'), 'utf8')).toMatch(/== sh tests\/acceptance\/T-04\.test\.sh\n(.*\n)*== exit [1-9]\d*\n/);
        expect(t04().acceptance_review).toMatchObject({ verdict: 'approved', reviewer: expect.stringContaining('claude') });
        const prompt = readFileSync(join(root, '.autopilot/stub-prompt-T-04.txt'), 'utf8');
        expect(prompt).toContain('Acceptance tests (DEC-006): tests/acceptance/T-04.test.sh were written from the spec by the test-author');
        expect(readFileSync(join(runDir(), 'T-04-green-1.txt'), 'utf8')).toContain('== exit 0');
        expect(t04()).toMatchObject({ status: 'reviewed', review: { verdict: 'approved' } });
        // what the test-author got and could do
        const tp = readFileSync(join(root, '.autopilot/stub-tests-prompt-T-04.txt'), 'utf8');
        expect(tp).toMatch(/^You are the test-author/);
        expect(tp).toContain('### REQ-002');
        expect(tp).toContain('- spec/SPEC.md');
        expect(tp).not.toMatch(/^- app\//m);
        const targs = readFileSync(join(root, '.autopilot/stub-args-tests-T-04.txt'), 'utf8').split('\n');
        for (const a of ['Read(./spec/**)', 'Read(./tests/acceptance/**)', 'Write(./tests/acceptance/T-04.*)', 'Bash(sh tests/acceptance/T-04*)', 'Glob', '--no-session-persistence']) expect(targs).toContain(a);
        expect(log()).toContain('test-author (claude) vía autopilot');
        expect(log()).toContain('tests/acceptance/T-04.test.sh (REQ-002: E1 de REQ-002)');
        expect(log()).toContain('pruebas de aceptación de T-04 en verde tras implementar');
        expect(result()).toMatchObject({ tests_authored: ['T-04'], test_disputes: [], tests_not_red: [] });
        expect(git('status', '--porcelain')).toBe('');
      });

      for (const [mode, reason, extra] of [
        ['green', 'sus pruebas pasan antes de implementar (tests/acceptance/T-04.test.sh)', { tests_not_red: ['T-04'] }],
        ['blocked', 'el test-author no puede escribir sus pruebas: REQ-002 no tiene ejemplos', {}],
        ['invalid', 'el test-author no entregó pruebas válidas: "red" must say how the tests failed', {}],
      ]) {
        it(`STUB_TESTS=${mode}: no tests are committed and the task is escalated (blocked by Q-03)`, () => {
          const r = autopilot({ ...on, STUB_TESTS: mode });
          expect(r.status).toBe(1);
          expect(implLaunched()).toBe(false);
          expect(existsSync(join(root, 'tests/acceptance/T-04.test.sh'))).toBe(false);
          expect(t04()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
          expect(log()).toContain(`- Decisión: escalar T-04 al usuario (DEC-006): ${reason}`);
          expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain('El orquestador la escaló con sus pruebas de aceptación (DEC-006)');
          expect(result()).toMatchObject({ tests_authored: [], ...extra });
          expect(git('status', '--porcelain')).toBe('');
        });
      }

      it('a test-author that writes outside tests/acceptance/<ID>* stops the run; nothing is discarded', () => {
        const r = autopilot({ ...on, STUB_TESTS: 'outside' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('stop: the test-author wrote outside tests/acceptance/T-04* on T-04');
        expect(git('status', '--porcelain', '--untracked-files=all')).toContain('?? stray-T-04.txt');
        expect(implLaunched()).toBe(false);
      });

      it('a test-author that reads outside spec/ and tests/acceptance/ stops the run', () => {
        const r = autopilot({ ...on, STUB_TESTS: 'readsrc' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain("stop: the test-author's session on T-04 read outside spec/ and tests/acceptance/");
        expect(readFileSync(join(runDir(), 'T-04-tests-audit.txt'), 'utf8')).toContain('Read outside spec/, tests/acceptance/: app/src/orders/x.ts');
      });

      it('without the reviewer gate the tests wait for the user; approve-tests opens the gate for the next run', () => {
        const { AUTOPILOT_ACCEPTANCE_REVIEW: _, ...noGate } = on;
        const first = autopilot(noGate);
        expect(first.status).toBe(0);
        expect(implLaunched()).toBe(false);
        expect(first.stdout).toContain('T-04: its acceptance tests wait for the user\'s approval (the review of additive diffs is off)');
        expect(result()).toMatchObject({ tests_authored: ['T-04'], user_wait: ['T-04'] });
        expect(run('approve-tests', 'T-04', '--by', 'Pepe')).toMatchObject({ code: 0, out: 'approved\n' });
        expect(t04().acceptance_review).toMatchObject({ reviewer: 'usuario: Pepe', verdict: 'approved' });
        git('commit', '-q', '-am', 'T-04: the user approves its acceptance tests\n\nTask: T-04\nReq: REQ-002');
        rmSync(join(root, '.autopilot'), { recursive: true, force: true });
        const second = autopilot(noGate);
        expect(second.stdout).not.toContain('test-author (claude) on T-04');
        expect(implLaunched()).toBe(true);
        expect(t04().status).toBe('reviewed');
      });

      it('tests rejected by the reviewer wait for the user', () => {
        const r = autopilot({ ...on, STUB_VERDICT: '{"verdict":"rejected","findings":["REQ-002: no codifica E1"],"notes":"n"}' });
        expect(r.stdout).toContain('T-04: its acceptance tests wait for the user\'s approval (the reviewer rejected them)');
        expect(t04().acceptance_review).toMatchObject({ verdict: 'rejected' });
        expect(implLaunched()).toBe(false);
      });

      it('an implementer whose commits touch tests/acceptance/ stops the run; nothing is integrated', () => {
        const r = autopilot({ ...on, STUB_MODE: 'touchtests' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('stop: the implementer touched tests/acceptance/ on T-04 (DEC-006: it may only read it; nothing integrated');
        expect(git('log', '--format=%s')).not.toContain('T-04: apply implementer result');
        expect(readFileSync(join(root, 'tests/acceptance/T-04.test.sh'), 'utf8')).not.toContain('edited by the implementer');
      });

      it('green that fails after implementing is a failure: the result is not applied', () => {
        const r = autopilot({ ...on, STUB_TESTS: 'strict' });
        expect(r.stdout).toContain('T-04: its acceptance tests do not pass after implementing (tests/acceptance/T-04.test.sh;');
        expect(r.stdout).toContain('failure 1/2 on T-04');
        expect(git('log', '--format=%s')).not.toContain('T-04: apply implementer result');
      });

      it('a disputed test without the researcher: the test is not changed and the task is escalated', () => {
        const r = autopilot({ ...on, STUB_MODE: 'dispute' });
        expect(r.status).toBe(1);
        expect(t04()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
        expect(t04().notes).toContain('el implementador disputa tests/acceptance/T-04.test.sh: la prueba exige algo que REQ no pide');
        expect(log()).toContain('- Decisión: escalar T-04 al usuario (DEC-006): el implementador disputa la prueba tests/acceptance/T-04.test.sh (REQ-002)');
        expect(result()).toMatchObject({ test_disputes: ['T-04'] });
        expect(git('log', '--format=%s', '--', 'tests/acceptance/')).toBe('T-04: acceptance tests by the test-author (red)\n');
      });

      it('a disputed test with the researcher: upheld → back to in_progress and relaunched with the report', () => {
        const r = autopilot({ ...on, STUB_MODE: 'dispute', AUTOPILOT_RESEARCH: 'web' });
        expect(r.status).toBe(0);
        expect(readFileSync(join(root, '.autopilot/stub-research-prompt-T-04.txt'), 'utf8')).toContain('Question: Does the acceptance test tests/acceptance/T-04.test.sh encode REQ-002');
        expect(log()).toContain('El investigador sostiene la prueba disputada: vuelve de `blocked` a `in_progress` (DEC-006)');
        const prompts = readFileSync(join(root, '.autopilot/stub-prompt-T-04.txt'), 'utf8').split('\x1e\n').filter((p) => p.trim());
        expect(prompts[1]).toContain('Research note (DEC-005): the implementer disputed the acceptance test');
        expect(t04().status).toBe('reviewed');
        expect(result()).toMatchObject({ test_disputes: ['T-04'], research_retried: ['T-04'] });
      });

      it('off by default: a task with REQ goes straight to the implementer, as today', () => {
        const r = autopilot(approved);
        expect(r.stdout).not.toContain('test-author');
        expect(implLaunched()).toBe(true);
        expect(result()).toMatchObject({ tests_authored: [], test_disputes: [], tests_not_red: [] });
      });
    });

    describe('plan critique gate (DEC-010)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const on = { ...approved, AUTOPILOT_PLAN_GATE: 'on' };
      const t04 = () => task(readTasks(), 'T-04');
      const log = () => readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
      const result = () => JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'));
      const implLaunched = () => existsSync(join(root, '.autopilot/stub-prompt-T-04.txt'));
      const stubFile = (name) => readFileSync(join(root, '.autopilot', name), 'utf8');
      const sources = [1, 2, 3].map((n) => ({ assumption: `supuesto ${n}`, practice: 'así se hace', sources: [`https://example.com/${n}`] }));
      const critic = (verdict, findings = [], extra = {}) => JSON.stringify({ verdict, assumptions: sources, findings, summary: 's', ...extra });
      const finding = (id, severity, evidence_type, evidence) => ({ id, severity, evidence_type, evidence, summary: `problema ${id}`, fix: `arreglo de ${id}` });
      const blocking = finding('req-002:sin-caso-vacio', 'P1', 'fuente', 'https://example.com/empty');
      beforeEach(() => { // only T-04 (REQ-002, app/src/orders/) is left to do
        editTasks((ts) => { for (const id of ['T-03', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
        git('commit', '-q', '-am', 'only T-04\n\nTask: none\nReq: none');
      });

      it('off: no planner and no critic; the implementer gets no plan', () => {
        const r = autopilot(approved);
        expect(r.status).toBe(0);
        expect(existsSync(join(root, '.autopilot/stub-critic-count'))).toBe(false);
        expect(readdirSync(join(root, '.autopilot')).some((f) => f.startsWith('stub-plan-prompt'))).toBe(false);
        expect(stubFile('stub-prompt-T-04.txt')).not.toContain('Approved plan (DEC-010)');
        expect(t04().plan_review === undefined).toBe(true);
      });

      it('planner → critic APROBAR → implementer with the approved plan; the critic gets no narrative of the planner', () => {
        const r = autopilot(on);
        expect(r.status).toBe(0);
        const subjects = git('log', '--reverse', '--format=%s').split('\n');
        const planAt = subjects.indexOf('T-04: plan by the planner (round 1)');
        expect(planAt).toBeGreaterThan(-1);
        expect(subjects.indexOf('T-04: plan critique, round 1 (APROBAR)')).toBeGreaterThan(planAt);
        expect(subjects.indexOf('T-04: stub')).toBeGreaterThan(subjects.indexOf('T-04: plan critique, round 1 (APROBAR)'));
        expect(git('log', '-1', '--format=%b', '--grep=^T-04: plan by the planner')).toContain('Task: T-04\nReq: REQ-002');
        const pr = t04().plan_review;
        expect(pr).toMatchObject({ verdict: 'APROBAR', effective: 'APROBAR', round: 1, plan: 'plans/T-04.md', findings: [], opinion_blockers: [] });
        expect(pr.plan_sha).toBe(git('rev-parse', 'HEAD:plans/T-04.md').trim());
        expect(pr.critic).toContain('claude -p 0.0.0');
        expect(stubFile('stub-prompt-T-04.txt')).toContain('Approved plan (DEC-010): plans/T-04.md was reviewed by a critic and approved');
        expect(t04()).toMatchObject({ status: 'reviewed' });
        const cp = stubFile('stub-critic-prompt-1.txt');
        expect(cp).toMatch(/^You are the critic/);
        expect(cp).toContain('# Plan de T-04');
        expect(cp).toContain('### REQ-002');
        expect(cp).toContain('{"research_requests"');
        expect(cp).not.toContain('I am confident'); // the planner's final message never reaches the critic
        const args = stubFile('stub-args-critic-1.txt').split('\n');
        for (const a of ['Read(./spec/SPEC.md)', 'Read(./spec/DECISIONS.md)', 'Read(./plans/T-04.md)', 'WebSearch', 'WebFetch', '--max-budget-usd']) expect(args).toContain(a);
        const denied = args.slice(args.indexOf('--disallowedTools'));
        for (const a of ['Read(./spec/LOG.md)', 'Read(./spec/TASKS.json)', 'Read(./scripts/**)', 'Edit', 'Write']) expect(denied).toContain(a);
        expect(stubFile('stub-plan-prompt-T-04-1.txt')).toMatch(/^You are the planner/);
        expect(stubFile('stub-args-plan-T-04.txt').split('\n')).toContain('Write(./plans/T-04.md)');
        expect(log()).toContain('crítico (claude) vía autopilot: plan de T-04, ronda 1');
        expect(log()).toContain('Veredicto del crítico: **APROBAR**; efectivo: **APROBAR**');
        expect(log()).toContain('grep existe (https://example.com/grep)');
        expect(log()).toContain('- Crítica de planes (DEC-010; crítico claude, topes 1200 s y US$ 3): planes aprobados: T-04;');
        expect(result()).toMatchObject({ plans_approved: ['T-04'], plans_escalated: [] });
        expect(git('status', '--porcelain')).toBe('');
      });

      it('REVISAR → the planner gets the findings; round 2 the critic gets only their ids → APROBAR', () => {
        const r = autopilot({ ...on, STUB_CRITIC: critic('REVISAR', [blocking]), STUB_CRITIC_NEXT: critic('APROBAR') });
        expect(r.status).toBe(0);
        expect(stubFile('stub-plan-prompt-T-04-2.txt')).toContain('[req-002:sin-caso-vacio] P1 (fuente: https://example.com/empty): problema req-002:sin-caso-vacio Corrección: arreglo de req-002:sin-caso-vacio');
        const second = stubFile('stub-critic-prompt-2.txt');
        expect(second).toContain('This is round 2. The blocking findings of round 1 were: req-002:sin-caso-vacio.');
        expect(second).not.toContain('problema req-002');
        expect(second).toContain('versión 2'); // it critiques the rewritten plan
        expect(t04().plan_review).toMatchObject({ round: 2, effective: 'APROBAR' });
        expect(git('log', '--format=%s')).toContain('T-04: plan critique, round 1 (REVISAR)');
        expect(implLaunched()).toBe(true);
      });

      it('each blocking finding is confirmed by the decider (T-38): one it reads as not blocking escalates the plan', () => {
        const r = autopilot({ ...on, STUB_CRITIC: critic('REVISAR', [blocking]), STUB_DECIDE_finding_severity: 'not_blocking:0.9' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('decide finding_severity (stub): proceed not_blocking (confidence 0.9)');
        expect(implLaunched()).toBe(false);
        expect(t04()).toMatchObject({ status: 'blocked' });
        expect(log()).toContain('el decisor (stub) no confirma como bloqueante el hallazgo req-002:sin-caso-vacio del crítico, ronda 1');
        expect(JSON.parse(stubFile('stub-decide-finding_severity.json')).state).toMatchObject({ id: 'req-002:sin-caso-vacio', severity: 'P1' });
      });

      it('a blocking finding the decider cannot settle escalates too (T-38)', () => {
        autopilot({ ...on, STUB_CRITIC: critic('REVISAR', [blocking]), STUB_DECIDE_finding_severity: 'blocking:0.4' });
        expect(implLaunched()).toBe(false);
        expect(log()).toContain('confidence 0.4 < 0.8');
      });

      it('a blocking id repeated in round 2 → ESCALAR: blocked by a new Q-NN; the implementer never starts', () => {
        const r = autopilot({ ...on, STUB_CRITIC: critic('REVISAR', [blocking]), STUB_CRITIC_NEXT: critic('REVISAR', [blocking]) });
        expect(r.status).toBe(1);
        expect(implLaunched()).toBe(false);
        expect(t04()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03', plan_review: { round: 2, effective: 'ESCALAR' } });
        expect(log()).toContain('- Decisión: escalar T-04 al usuario (DEC-010): los hallazgos bloqueantes req-002:sin-caso-vacio se repitieron en la ronda 2');
        expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain('El orquestador la escaló por la crítica de su plan (DEC-010)');
        expect(result()).toMatchObject({ plans_approved: [], plans_escalated: ['T-04'] });
        expect(git('status', '--porcelain')).toBe('');
      });

      it('REVISAR again in round 2 with other findings → escalated after 2 rounds', () => {
        const other = finding('pasos:sin-rollback', 'P0', 'archivo', 'spec/SPEC.md:3');
        const r = autopilot({ ...on, STUB_CRITIC: critic('REVISAR', [blocking]), STUB_CRITIC_NEXT: critic('REVISAR', [other]) });
        expect(r.status).toBe(1);
        expect(log()).toContain('el plan sigue en REVISAR tras 2 rondas de crítica');
        expect(implLaunched()).toBe(false);
      });

      it('the critic may escalate on its own', () => {
        const r = autopilot({ ...on, STUB_CRITIC: critic('ESCALAR') });
        expect(r.status).toBe(1);
        expect(log()).toContain('el crítico escaló el plan en la ronda 1');
        expect(t04()).toMatchObject({ status: 'blocked' });
      });

      it('APROBAR with a P0 backed by a source is REVISAR; a P0 that is only an opinion does not block but is shown', () => {
        const opinion = finding('riesgos:me-parece-fragil', 'P0', 'opinión', 'creo que es frágil');
        const r = autopilot({ ...on, STUB_CRITIC: critic('APROBAR', [blocking]), STUB_CRITIC_NEXT: critic('APROBAR', [opinion]) });
        expect(r.status).toBe(0);
        expect(log()).toContain('Veredicto del crítico: **APROBAR**; efectivo: **REVISAR**');
        expect(t04().plan_review).toMatchObject({ round: 2, effective: 'APROBAR', opinion_blockers: ['riesgos:me-parece-fragil'] });
        expect(log()).toContain('- Objeciones P0/P1 de pura opinión (no bloquean; para el usuario): riesgos:me-parece-fragil.');
        expect(log()).toContain('objeciones P0/P1 de pura opinión, para el usuario: T-04: riesgos:me-parece-fragil');
        expect(implLaunched()).toBe(true);
      });

      for (const [name, findings, why] of [
        ['a file line that does not exist', [finding('a:b', 'P1', 'archivo', 'spec/SPEC.md:9999')], 'spec/SPEC.md:9999 does not exist'],
        ['a file the critic may not read', [finding('a:b', 'P1', 'archivo', 'spec/LOG.md:1')], 'spec/LOG.md is not one of the files the critic may read'],
        ['a source that is not a URL', [finding('a:b', 'P2', 'fuente', 'un blog')], '"fuente" evidence must start with a URL'],
      ]) {
        it(`a verdict with ${name} is invalid: escalated`, () => {
          const r = autopilot({ ...on, STUB_CRITIC: critic('REVISAR', findings) });
          expect(r.status).toBe(1);
          expect(log()).toContain('el crítico no entregó un veredicto válido (ronda 1)');
          expect(log()).toContain(why);
          expect(implLaunched()).toBe(false);
        });
      }

      it('research_requests → the deep researcher answers, then a new critic session decides with the reports', () => {
        const r = autopilot({ ...on, STUB_CRITIC: '{"research_requests":["¿Cómo se valida el caso vacío en la práctica?"]}', STUB_CRITIC_NEXT: critic('APROBAR') });
        expect(r.status).toBe(0);
        expect(git('log', '--format=%s')).toContain('T-04: research for the plan critic (research/T-04-plan-1.md)');
        expect(readFileSync(join(root, 'research/T-04-plan-1.md'), 'utf8')).toContain('## Respuesta');
        const rargs = stubFile('stub-research-args-T-04-plan-1.txt').split('\n');
        for (const a of ['Agent', 'Write(./research/T-04-plan-1.md)']) expect(rargs).toContain(a);
        expect(rargs[rargs.indexOf('--max-budget-usd') + 1]).toBe('10');
        expect(stubFile('stub-research-prompt-T-04-plan-1.txt')).toContain('Question from the plan\'s critic: ¿Cómo se valida el caso vacío en la práctica?');
        const second = stubFile('stub-critic-prompt-2.txt');
        expect(second).toContain('Research reports on your questions: research/T-04-plan-1.md');
        expect(second).not.toContain('{"research_requests"');
        expect(stubFile('stub-args-critic-2.txt').split('\n')).toContain('Read(./research/T-04-plan-1.md)');
        expect(t04().plan_review).toMatchObject({ round: 1, effective: 'APROBAR' });
        expect(git('status', '--porcelain')).toBe('');
      });

      it('a plan with sections of its own is invalid: not committed, kept as a draft, escalated', () => {
        const r = autopilot({ ...on, STUB_PLAN: 'invalid' });
        expect(r.status).toBe(1);
        expect(existsSync(join(root, 'plans/T-04.md'))).toBe(false);
        expect(readFileSync(join(runDir(), 'T-04-plan-1-draft.md'), 'utf8')).toContain('## Autoevaluación');
        expect(log()).toContain('el planificador no entregó un plan válido (ronda 1): sections not allowed: "## Autoevaluación"');
        expect(existsSync(join(root, '.autopilot/stub-critic-count'))).toBe(false);
        expect(git('status', '--porcelain')).toBe('');
      });

      it('a planner that writes outside plans/<ID>.md stops the run; nothing is discarded', () => {
        const r = autopilot({ ...on, STUB_PLAN: 'outside' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('stop: the planner changed files outside plans/T-04.md on T-04');
        expect(git('status', '--porcelain', '--untracked-files=all')).toContain('?? stray-T-04.txt');
        expect(implLaunched()).toBe(false);
      });

      it('a critic that reads another agent\'s records stops the run', () => {
        const peek = autopilot({ ...on, STUB_PEEK: 'critic' });
        expect(peek.status).toBe(1);
        expect(peek.stdout).toContain("stop: the critic's session on T-04 read outside its paths or another agent's context");
        expect(implLaunched()).toBe(false);
      });

      describe('scripts/critic-gate.sh (DEC-010 point 8: the cuts of /analista)', () => {
        const cut = (extra = '') => {
          mkdirSync(join(root, 'plans'), { recursive: true });
          writeFileSync(join(root, 'plans/corte-2.md'), `# Plan de corte-2\n## Objetivo\no\n## Pasos\n1. REQ-006\n## Archivos\n- spec/SPEC.md\n## Supuestos\n- s\n## Riesgos\n- r\n## Verificación\n- check:spec\n${extra}`);
        };
        const gate = (env, ...args) => spawnSync('bash', [join(root, 'scripts/critic-gate.sh'), ...args], {
          encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
        });

        it('APROBAR → exit 0 with the checked verdict on stdout; it commits nothing and works on a dirty tree', () => {
          cut();
          writeFileSync(join(root, 'spec/SPEC.md'), readFileSync(join(root, 'spec/SPEC.md'), 'utf8') + '\n### REQ-006 nuevo del corte\n');
          const head = git('rev-parse', 'HEAD');
          const before = git('status', '--porcelain', '--untracked-files=all');
          const r = gate({}, 'plans/corte-2.md');
          expect(r.status).toBe(0);
          expect(JSON.parse(r.stdout)).toMatchObject({ verdict: 'APROBAR', effective: 'APROBAR' });
          expect(r.stderr).toContain('critic-gate: plans/corte-2.md, round 1: the critic says APROBAR; effective APROBAR');
          expect(git('rev-parse', 'HEAD')).toBe(head);
          expect(git('status', '--porcelain', '--untracked-files=all')).toBe(before);
          const prompt = stubFile('stub-critic-prompt-1.txt');
          expect(prompt).toContain('plans/corte-2.md (below) is the plan of a spec cut that the analyst (/analista) proposes');
          expect(prompt).toContain('No researcher is available here: do all the web research yourself.');
          const args = stubFile('stub-args-critic-1.txt').split('\n');
          expect(args).toContain('Read(./plans/corte-2.md)');
          expect(args.slice(args.indexOf('--disallowedTools'))).toContain('Read(./spec/LOG.md)');
          expect(existsSync(join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('critique-')), 'corte-2-critic-1.json'))).toBe(true);
        });

        it('REVISAR → 1; round 2 with --previous: a repeated id or REVISAR again → 3', () => {
          cut();
          const revisar = critic('REVISAR', [blocking]);
          expect(gate({ STUB_CRITIC: revisar }, 'plans/corte-2.md').status).toBe(1);
          const again = gate({ STUB_CRITIC: revisar }, 'plans/corte-2.md', '--previous', 'req-002:sin-caso-vacio');
          expect(again.status).toBe(3);
          expect(JSON.parse(again.stdout)).toMatchObject({ effective: 'ESCALAR', repeated: ['req-002:sin-caso-vacio'] });
          expect(stubFile('stub-critic-prompt-2.txt')).toContain('This is round 2. The blocking findings of round 1 were: req-002:sin-caso-vacio.');
          const other = gate({ STUB_CRITIC: critic('REVISAR', [finding('pasos:x', 'P1', 'fuente', 'https://example.com/x')]) }, 'plans/corte-2.md', '--previous', 'req-002:sin-caso-vacio');
          expect(other.status).toBe(3);
          expect(other.stderr).toContain('effective ESCALAR');
          expect(gate({ STUB_CRITIC: critic('APROBAR') }, 'plans/corte-2.md', '--previous', 'req-002:sin-caso-vacio').status).toBe(0);
        });

        it('an invalid plan, an invalid verdict or a plan outside plans/ → 2', () => {
          cut('## Notas\nmías\n');
          const bad = gate({}, 'plans/corte-2.md');
          expect(bad.status).toBe(2);
          expect(bad.stderr).toContain('sections not allowed: "## Notas"');
          cut();
          const invalid = gate({ STUB_CRITIC: '{"verdict":"APROBAR","assumptions":[],"findings":[]}' }, 'plans/corte-2.md');
          expect(invalid.status).toBe(2);
          expect(invalid.stderr).toContain('assumptions must list the 3 to 5 riskiest assumptions');
          expect(gate({}, 'spec/SPEC.md').stderr).toContain('the plan must be an existing plans/<name>.md');
        });
      });

      it('an approved plan opens the gate only while unchanged: an edited plan goes back to the critic (no new planner)', () => {
        const first = autopilot({ ...on, STUB_NOOP: 'T-04' }); // approved, but the implementer changes nothing
        expect(first.status).toBe(0);
        expect(t04().plan_review).toMatchObject({ effective: 'APROBAR' });
        writeFileSync(join(root, 'plans/T-04.md'), readFileSync(join(root, 'plans/T-04.md'), 'utf8') + '- un paso más\n');
        git('commit', '-q', '-am', 'T-04: plan edited by hand\n\nTask: T-04\nReq: REQ-002');
        const second = autopilot(on);
        expect(second.status).toBe(0);
        expect(stubFile('stub-critic-count').trim()).toBe('2');
        expect(existsSync(join(root, '.autopilot/stub-plan-prompt-T-04-2.txt'))).toBe(false);
        expect(second.stdout).toContain('T-04: plans/T-04.md is already committed and valid: it goes to the critic as is');
        expect(t04().plan_review.plan_sha).toBe(git('rev-parse', 'HEAD:plans/T-04.md').trim());
      });
    });

    describe('queue policy and --review-only (DEC-023, T-54)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}', AUTOPILOT_QUEUE_POLICY: 'on' };
      const reviews = () => Number(existsSync(join(root, '.autopilot/stub-review-count')) ? readFileSync(join(root, '.autopilot/stub-review-count'), 'utf8') : 0);
      const implemented = (id) => existsSync(join(root, `.autopilot/stub-prompt-${id}.txt`));
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
      const result = () => JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'));
      const queue = (ids) => { // ids in verified_auto, each with its own commit (T-52), oldest first
        editTasks((ts, d) => {
          for (const id of ids) Object.assign(task(ts, id), { status: 'verified_auto', depends_on: [], evidence: { command: 'x', result: 'y', commit: 'z' } });
          d.evidence_legacy = [...new Set([...(d.evidence_legacy ?? []), ...ids])];
        });
        git('commit', '-q', '-am', 'queue\n\nTask: none\nReq: none');
        for (const id of ids) git('commit', '-q', '--allow-empty', '-m', `${id}: work\n\nTask: ${id}\nReq: none`);
      };

      it('more than 4 in verified_auto: the run only reviews; nothing is implemented', () => {
        queue(['T-02', 'T-04', 'T-05', 'T-06', 'T-07']);
        const r = autopilot(approved);
        expect(r.stdout).toContain('queue policy (DEC-023): 5 in verified_auto (> 4): this run only reviews');
        expect(reviews()).toBe(5);
        expect(implemented('T-03')).toBe(false);
        expect(task(readTasks(), 'T-03').status).toBe('ready');
        expect(result()).toMatchObject({ mode: 'review_only', queue: 5, done: [] });
      });

      it('AUTOPILOT_REVIEW_SKIP takes its tasks out of the queue: not reviewed, not counted, not in --check (T-93)', () => {
        queue(['T-02', 'T-04', 'T-05', 'T-06', 'T-07']);
        const skip = { AUTOPILOT_REVIEW_SKIP: 'T-02, T-04 T-05,T-06' };
        const check = autopilot({ ...approved, ...skip }, '--check');
        expect(check.stdout).toContain('pending reviews: T-07');
        expect(check.stdout).not.toContain('T-02');
        const r = autopilot({ ...approved, ...skip });
        expect(r.stdout).toContain('queue policy (DEC-023): 1 in verified_auto (≤ 4): one review and one implementation');
        expect(reviews()).toBe(1);
        expect(task(readTasks(), 'T-07').status).toBe('reviewed');
        for (const id of ['T-02', 'T-04', 'T-05', 'T-06']) expect(task(readTasks(), id).status).toBe('verified_auto');
        expect(result()).toMatchObject({ mode: 'implement_and_review', queue: 1, done: ['T-03'] });
      });

      it('4 or fewer: reviews the oldest, implements one and leaves it in the queue', () => {
        queue(['T-02', 'T-06']);
        const r = autopilot(approved);
        expect(r.stdout).toContain('queue policy (DEC-023): 2 in verified_auto (≤ 4): one review and one implementation');
        expect(reviews()).toBe(1);
        expect(task(readTasks(), 'T-02').status).toBe('reviewed');
        expect(task(readTasks(), 'T-06').status).toBe('verified_auto');
        expect(task(readTasks(), 'T-03').status).toBe('verified_auto'); // implemented, waits for the next run
        expect(r.stdout).toContain('T-03 stays in verified_auto for the next run (queue policy: one review per run)');
        expect(result()).toMatchObject({ mode: 'implement_and_review', queue: 2, done: ['T-03'] });
      });

      it('an empty queue: implements one and reviews it; never a second task', () => {
        const r = autopilot(approved);
        expect(r.status).toBe(0);
        expect(reviews()).toBe(1);
        expect(task(readTasks(), 'T-03').status).toBe('reviewed');
        expect(implemented('T-04')).toBe(false);
        expect(r.stdout).toContain('stop: task budget reached (1)');
      });

      it('no review starts if the time left is under its expected duration (median of past reviews, or the default)', () => {
        queue(['T-02']);
        mkdirSync(join(root, '.autopilot/2026-01-01_000000'), { recursive: true });
        writeFileSync(join(root, '.autopilot/.gitignore'), '*\n'); // as the orchestrator leaves it
        writeFileSync(join(root, '.autopilot/2026-01-01_000000/live.log'), '01:00:00 autopilot: reviewer (claude) on T-09: 1 bytes of context\n01:50:00 autopilot: verdict on T-09: approved\n');
        const r = autopilot({ ...approved }, '--budget-seconds', '2000');
        expect(r.stdout).toMatch(/not enough time to review T-02: \d+s left, and a review takes ~3000s \(median of the last 1\)/);
        expect(reviews()).toBe(0);
      });

      it('--review-only: its own budget, reviews the whole queue and never implements; --dry-run estimates how long it takes', () => {
        queue(['T-02', 'T-06']);
        const d = autopilot({ ...approved, AUTOPILOT_REVIEW_EXPECTED_SECONDS: '600' }, '--dry-run', '--review-only');
        expect(d.stdout).toContain('Queue (DEC-023): 2 in verified_auto (T-02, T-06); a review takes ~600s (default, no history); emptying it takes ~1200s (20 min)');
        expect(d.stdout).toContain('Review only (DEC-023): budget 28800s');
        const r = autopilot({ ...approved, AUTOPILOT_REVIEW_ONLY_BUDGET_SECONDS: '7200' }, '--review-only');
        expect(r.stdout).toContain('budget 7200s');
        expect(reviews()).toBe(2);
        expect(implemented('T-03')).toBe(false);
        expect(r.stdout).toContain('stop: review only (DEC-023): the queue is empty');
        expect(result()).toMatchObject({ mode: 'review_only', done: [] });
      });

      it('policy off: as before (reviews the queue, then implements while it can)', () => {
        queue(['T-02', 'T-04', 'T-05', 'T-06', 'T-07']);
        autopilot({ ...approved, AUTOPILOT_QUEUE_POLICY: 'off' }, '--max-tasks', '1');
        expect(reviews()).toBe(6);
        expect(implemented('T-03')).toBe(true);
      });
    });

    describe('every run leaves a trace (DEC-024, T-55)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const runDirs = () => readdirSync(join(root, '.autopilot')).filter((d) => /^20\d\d-\d\d-\d\d_\d{6}$/.test(d)).sort();
      const current = () => join(root, '.autopilot', runDirs().at(-1));
      const result = (dir = current()) => JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
      const asyncRun = (env, ...args) => spawn('bash', [join(root, 'scripts/autopilot.sh'), ...args], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = (child) => new Promise((res) => { let out = ''; child.stdout.on('data', (d) => { out += d; }); child.on('exit', (code) => res({ code, out })); });

      it('a normal stop: status ok, written through a temporary file; the heartbeat names the orchestrator', () => {
        expect(autopilot(approved, '--max-tasks', '1').status).toBe(0);
        expect(result()).toMatchObject({ status: 'ok' });
        expect(existsSync(join(current(), 'result.json.tmp'))).toBe(false);
        const hb = JSON.parse(readFileSync(join(current(), 'heartbeat'), 'utf8'));
        expect(Number.isInteger(hb.pid)).toBe(true);
        expect(hb.at).toMatch(/^\d{4}-/);
        expect(existsSync(join(current(), 'partial.patch'))).toBe(false);
      });

      it('time budget exhausted: timeout, with partial.patch', () => {
        autopilot(approved, '--budget-seconds', '500');
        expect(result()).toMatchObject({ status: 'timeout' });
        expect(existsSync(join(current(), 'partial.patch'))).toBe(true);
      });

      it('monthly token cap: budget_exhausted', () => {
        const state = mkdtempSync(join(tmpdir(), 'autopilot-tokens-'));
        mkdirSync(join(state, 'autopilot'));
        writeFileSync(join(state, 'autopilot/tokens.test-doubles.jsonl'), JSON.stringify({ month: new Date().toISOString().slice(0, 7), repo: 'o', run: 'x', role: 'implementer', task: 'T-99', input: 0, output: 1000, cache_write: 0, cache_read: 0 }) + '\n'); // the doubles' ledger (T-73)
        autopilot({ ...approved, XDG_STATE_HOME: state, AUTOPILOT_MONTHLY_BUDGET_TOKENS: '1000' });
        rmSync(state, { recursive: true, force: true });
        expect(result()).toMatchObject({ status: 'budget_exhausted' });
      });

      it('the agent reports its usage limit: usage_limited; the run stops without retrying', () => {
        const r = autopilot({ ...approved, STUB_MODE: 'usage' });
        expect(r.stdout).toContain('stop: the implementer on T-03 hit its usage limit');
        expect(result()).toMatchObject({ status: 'usage_limited', intervention: true });
        expect(readFileSync(join(root, '.autopilot/stub-prompt-T-03.txt'), 'utf8').split('\x1e').length - 1).toBe(1);
        expect(existsSync(join(current(), 'partial.patch'))).toBe(true);
      });

      it('the agent ends with an API error: api_error; the run stops', () => {
        autopilot({ ...approved, STUB_MODE: 'apierror' });
        expect(result()).toMatchObject({ status: 'api_error' });
      });

      it('an unexpected exit: error; a dirty tree at the start also leaves result.json, with the diff in partial.patch', () => {
        autopilot({}, '--task', 'T-99');
        expect(result()).toMatchObject({ status: 'error' });
        writeFileSync(join(root, 'README.md'), 'uncommitted\n');
        const r = autopilot(approved);
        expect(r.status).not.toBe(0);
        expect(result()).toMatchObject({ status: 'error', stop_reason: expect.stringContaining('dirty working tree') });
        expect(readFileSync(join(current(), 'partial.patch'), 'utf8')).toContain('+uncommitted');
      });

      it('SIGTERM during the run: sigterm, partial.patch with the uncommitted work and the branch it was left on', async () => {
        const child = asyncRun({ ...approved, STUB_MODE: 'hang', STUB_HANG_SECONDS: '3' });
        const done = exited(child);
        await new Promise((res) => { const t = setInterval(() => { if (existsSync(join(root, '.autopilot/stub-hang-T-03'))) { clearInterval(t); res(); } }, 100); });
        child.kill('SIGTERM');
        await done;
        const res = result();
        expect(res.status).toBe('sigterm');
        expect(res.branch).toMatch(/^autopilot\/.+\/T-03-1$/);
        expect(readFileSync(join(current(), 'partial.patch'), 'utf8')).toContain('half-done T-03');
      });

      it('T-98: a signal on its task branch: back on the batch branch, uncommitted work in a named stash, partial.patch kept', async () => {
        const child = asyncRun({ ...approved, AUTOPILOT_BATCH: 'on', STUB_MODE: 'hang', STUB_HANG_SECONDS: '3' });
        const done = exited(child);
        await new Promise((res) => { const t = setInterval(() => { if (existsSync(join(root, '.autopilot/stub-hang-T-03'))) { clearInterval(t); res(); } }, 100); });
        child.kill('SIGTERM');
        await done;
        const res = result();
        expect(res.status).toBe('sigterm');
        expect(res.branch).toMatch(/^autopilot\/.+\/T-03-1$/);   // where its commits are
        expect(res.recovered).toMatchObject({ checkout: 'autopilot/lote', stash: expect.stringContaining('uncommitted work on autopilot/') });
        expect(res.stop_reason).toContain('back on autopilot/lote');
        expect(git('symbolic-ref', '--short', 'HEAD').trim()).toBe('autopilot/lote');
        expect(git('status', '--porcelain')).toBe('');
        expect(git('stash', 'list')).toContain('(T-98)');
        expect(readFileSync(join(current(), 'partial.patch'), 'utf8')).toContain('half-done T-03');
      });

      it('T-98: a run started on a task branch never takes an autopilot/* branch as the batch target nor records merged', () => {
        const target = git('symbolic-ref', '--short', 'HEAD').trim();
        expect(autopilot({ ...approved, AUTOPILOT_BATCH: 'on' }, '--max-tasks', '1').status).toBe(0);   // T-03 into the open batch
        // what the interrupted run of 2026-10-22 left: HEAD on a task branch, and a target pointing at it
        git('checkout', '-q', '-b', 'autopilot/2026-10-22_010033/T-03-1');
        git('config', 'autopilot.batchtarget', 'autopilot/2026-10-22_010033/T-03-1');
        const r = autopilot({ ...approved, AUTOPILOT_BATCH: 'on' }, '--max-tasks', '1');
        expect(r.stdout).toContain('the run started on autopilot/2026-10-22_010033/T-03-1, not a target');
        expect(r.stdout).toContain(`continuing on autopilot/lote`);
        expect(t03().merged).toBe(undefined);
        expect(git('config', '--get', 'autopilot.batchtarget').trim()).toBe(target);
        expect(result().batch).toMatchObject({ branch: 'autopilot/lote', target });
      });

      it('T-98: set-merged refuses an autopilot/* target', () => {
        const r = spawnSync('node', [SCRIPT, 'set-merged', 'T-03', '--into', 'autopilot/lote', '--commit', 'HEAD', '--root', root], { encoding: 'utf8' });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('an autopilot/* branch is not a merge target (T-98)');
        expect(t03().merged).toBe(undefined);
      });

      it('T-98: a wall-clock gap without heartbeats (the machine asleep) does not cut the agent as inactive', async () => {
        const child = asyncRun({ ...approved, STUB_MODE: 'hang', STUB_HANG_SECONDS: '7', AUTOPILOT_STALL_SECONDS: '3', AUTOPILOT_HEARTBEAT_SECONDS: '1' });
        const done = exited(child);
        await new Promise((res) => { const t = setInterval(() => { if (existsSync(join(root, '.autopilot/stub-hang-T-03'))) { clearInterval(t); res(); } }, 100); });
        const hb = JSON.parse(readFileSync(join(current(), 'heartbeat'), 'utf8')).heartbeat_pid;
        process.kill(hb, 'SIGSTOP');   // as a suspend: no heartbeat for 5 s, live.log unchanged
        await new Promise((res) => setTimeout(res, 5000));
        process.kill(hb, 'SIGCONT');
        const { out } = await done;
        expect(out).not.toContain('no activity from the agent');
        expect(result().status).not.toBe('stalled');
        expect(readFileSync(join(current(), 'live.log'), 'utf8')).toMatch(/clock gap: no heartbeat for \d+s .*the inactivity deadline restarts \(T-98\)/);
      });

      it('an agent with no activity for AUTOPILOT_STALL_SECONDS: INT to the agent and the run ends stalled', async () => {
        const started = Date.now();
        const { out } = await exited(asyncRun({ ...approved, STUB_MODE: 'hang', STUB_HANG_SECONDS: '60', AUTOPILOT_STALL_SECONDS: '2', AUTOPILOT_HEARTBEAT_SECONDS: '1' }));
        expect(Date.now() - started).toBeLessThan(30000);
        expect(result()).toMatchObject({ status: 'stalled' });
        expect(out).toContain('no activity from the agent for 2s');
        expect(existsSync(join(current(), 'partial.patch'))).toBe(true);
      });

      it('at the start, a run directory without result.json nor a stop line is marked crashed_orphan', () => {
        const orphan = join(root, '.autopilot/2026-10-18_211043');
        const legacy = join(root, '.autopilot/2026-10-18_181100');
        mkdirSync(orphan, { recursive: true });
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(root, '.autopilot/.gitignore'), '*\n');
        writeFileSync(join(orphan, 'live.log'), '21:10:43 autopilot: start at 98edc54\n21:26:47 T-06 ▸ Write  .autopilot/2026-10-18_211043/T-06-result-1.json\n');
        writeFileSync(join(orphan, 'heartbeat'), JSON.stringify({ pid: 999999, at: '2026-10-18T21:26:30-03:00' }));
        writeFileSync(join(legacy, 'live.log'), '18:11:00 autopilot: start\n19:00:00 autopilot: stop: no tasks\n');
        const r = autopilot(approved, '--max-tasks', '1');
        const o = result(orphan);
        expect(o).toMatchObject({ status: 'crashed_orphan', run_id: '2026-10-18_211043', last_heartbeat: '2026-10-18T21:26:30-03:00',
          last_log_line: expect.stringContaining('T-06-result-1.json'), reaped_by: runDirs().at(-1), intervention: true });
        expect(existsSync(join(legacy, 'result.json'))).toBe(false); // finished before result.json existed: not an orphan
        expect(r.stdout).toContain('run 2026-10-18_211043 ended without result.json: marked crashed_orphan');
        expect(result()).toMatchObject({ status: 'ok', orphans_reaped: ['2026-10-18_211043'] });
      });

      it('a run directory already taken (another run in the same second) is never reused; --dry-run ends 0 (T-55)', () => {
        mkdirSync(join(root, '.autopilot'), { recursive: true });
        writeFileSync(join(root, '.autopilot/.gitignore'), '*\n');
        const stamp = (ms) => { const d = new Date(Date.now() + ms); const p = (n) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
        const taken = [0, 1000, 2000].map(stamp);
        for (const t of taken) { mkdirSync(join(root, '.autopilot', t)); writeFileSync(join(root, '.autopilot', t, 'result.json'), '{"status":"error"}'); }
        expect(autopilot(approved, '--dry-run').status).toBe(0);
        autopilot(approved, '--max-tasks', '1');
        for (const t of taken) expect(readFileSync(join(root, '.autopilot', t, 'result.json'), 'utf8')).toBe('{"status":"error"}');
        expect(result()).toMatchObject({ status: 'ok' });
      });

      it('every agent runs under timeout -s INT -k (INT first, KILL after)', () => {
        const lines = readFileSync(AUTOPILOT_SH, 'utf8').split('\n').filter((l) => /eval timeout /.test(l));
        expect(lines.length).toBeGreaterThan(4);
        for (const l of lines) expect(l).toMatch(/eval timeout -s INT -k 30 /);
      });
    });

    it('every status change of a run is in status_log with its script, and merged records the integration (DEC-028, T-60)', () => {
      autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--max-tasks', '1');
      const t = t03();
      expect(t.status_log.map((e) => `${e.from}→${e.to}:${e.by}`)).toEqual([
        'ready→in_progress:apply-result', 'in_progress→verified_auto:record_evidence.py', 'verified_auto→reviewed:set-review']);
      const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      expect(t.merged).toMatchObject({ into: branch });
      expect(git('cat-file', '-t', t.merged.commit).trim()).toBe('commit');
      expect(git('merge-base', '--is-ancestor', t.merged.commit, 'HEAD') === '').toBe(true);
    });

    describe('instrumentation per task in evidence/<ID>.json (DEC-026, T-58)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const ev = (id) => JSON.parse(git('show', `HEAD:evidence/${id}.json`));

      it('an attempt and its review leave their records, committed with the summary', () => {
        autopilot(approved, '--max-tasks', '1');
        const { records } = ev('T-03');
        expect(records.map((r) => r.role)).toEqual(['implementer', 'reviewer']);
        const [impl, rev] = records;
        expect(impl).toMatchObject({ attempt: 1, exit_code: 0, tokens: { input: 44, output: 11440 },
          test_runs: { agent: { suite: 1, task: 0 }, hook: { suite: 1 }, orchestrator: { suite: 1 } }, verify_exit_codes: { hook: 0, close: 0 } });
        expect(impl.gates.map((g) => `${g.name}:${g.result}`)).toEqual(['audit:ok', 'acceptance_guard:ok', 'authority:ok', 'scope:ok', 'result:ok', 'evidence:ok', 'check_spec:ok']);
        expect(impl.tree_sha).toMatch(/^[0-9a-f]{40}$/);
        expect(rev).toMatchObject({ role: 'reviewer', exit_code: 0, gates: [{ name: 'review', result: 'approved' }] });
        expect(git('status', '--porcelain')).toBe('');
      });

      it('failed attempts are recorded too, with the gate that failed', () => {
        autopilot({ STUB_MODE: 'badresult' }, '--max-tasks', '1');
        const { records } = ev('T-03');
        expect(records.length).toBe(2);
        expect(records[0].gates.at(-1)).toEqual({ name: 'result', result: 'invalid' });
      });
    });

    it('without the test-author, a diff of the implementer that touches tests/acceptance/ is not integrated and stops the run (DEC-027, T-59)', () => {
      mkdirSync(join(root, 'tests/acceptance'), { recursive: true });
      writeFileSync(join(root, 'tests/acceptance/T-04.test.sh'), 'true\n');
      editTasks((ts) => { for (const id of ['T-03', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
      git('add', '-A');
      git('commit', '-q', '-m', 'only T-04, with an acceptance test\n\nTask: T-03\nReq: REQ-001');
      const r = autopilot({ STUB_MODE: 'touchtests' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('stop: the implementer touched tests/acceptance/ on T-04');
      expect(git('show', 'HEAD:tests/acceptance/T-04.test.sh')).not.toContain('edited by the implementer');
    });

    describe('a block declared by the implementer: Q-NN, Jev\'s classification, never retried (DEC-029, T-61)', () => {
      const prompts = () => readFileSync(join(root, '.autopilot/stub-prompt-T-03.txt'), 'utf8').split('\x1e').length - 1;
      it('spec_test_conflict: blocked by a new Q-NN with the detail; the decider classifies it; not integrated, not retried', () => {
        const r = autopilot({ STUB_MODE: 'block', STUB_DECIDE_block_kind: 'spec:0.92' });
        const t = t03();
        expect(t.status).toBe('blocked');
        expect(t.blocked_by).toMatch(/^Q-\d+$/);
        expect(t.block).toMatchObject({ kind: 'spec_test_conflict', detail: 'REQ-001 E2 pide 3 y la prueba espera 4', refs: ['REQ-001'], classification: 'spec', confidence: 0.92 });
        expect(t.block.branch).toMatch(/^autopilot\/.+\/T-03-1$/);
        expect(existsSync(t.block.decision)).toBe(true);
        expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain('REQ-001 E2 pide 3 y la prueba espera 4');
        expect(git('log', '--format=%s')).not.toContain('T-03: stub');   // its commits stay on its branch
        expect(prompts()).toBe(1);
        expect(r.stdout).toContain('T-03: the implementer declares a block (spec_test_conflict)');
        expect(JSON.parse(readFileSync(join(root, '.autopilot/stub-decide-block_kind.json'), 'utf8')).options).toMatchObject({ spec: expect.stringContaining('spec') });
      });

      it('open_question with the decider under its threshold: still blocked by a Q-NN, unclassified', () => {
        autopilot({ STUB_MODE: 'block', STUB_BLOCK_KIND: 'open_question', STUB_DECIDE_block_kind: 'user_answer:0.4' });
        expect(t03()).toMatchObject({ status: 'blocked', block: { kind: 'open_question', classification: null } });
        expect(prompts()).toBe(1);
      });

      it('implementer with high confidence: relaunched once with the reason; a second block escalates (DEC-031, T-63)', () => {
        const r = autopilot({ STUB_MODE: 'block', STUB_DECIDE_block_kind: 'implementer:0.9' });
        expect(prompts()).toBe(2);
        const second = readFileSync(join(root, '.autopilot/stub-prompt-T-03.txt'), 'utf8').split('\x1e')[1];
        expect(second).toContain('Block returned (DEC-031)');
        expect(second).toContain('REQ-001 E2 pide 3 y la prueba espera 4');
        expect(r.stdout).toContain('T-03: the decider reads the block as the implementer\'s (confidence 0.9): relaunched once (DEC-031)');
        const t = t03();
        expect(t.status).toBe('blocked');
        expect(t.blocked_by).toMatch(/^Q-\d+$/);
        expect(typeof t.block.returned).toBe('string');
      });

      it('test, spec or user_answer with high confidence, or implementer with low confidence: escalated, never relaunched (DEC-031, T-63)', () => {
        for (const d of ['test:0.95', 'implementer:0.4']) {
          rmSync(join(root, '.autopilot'), { recursive: true, force: true });
          git('reset', '-q', '--hard', 'HEAD');
          autopilot({ STUB_MODE: 'block', STUB_DECIDE_block_kind: d });
          expect(prompts()).toBe(1);
          expect(t03().status).toBe('blocked');
          git('reset', '-q', '--hard', git('rev-list', '--max-parents=0', 'HEAD').trim());
        }
      });

      it('an unknown kind makes the result invalid (a failure, as any invalid result)', () => {
        const r = autopilot({ STUB_MODE: 'block', STUB_BLOCK_KIND: 'bored' }, '--max-failures', '1');
        expect(r.stdout).toContain('"block.kind" must be spec_test_conflict or open_question');
        expect(t03().status).toBe('ready');
      });
    });

    it('the implementer and the critic get only the selected decisions in force, not all of spec/adr/ (DEC-036, T-69)', () => {
      editTasks((ts) => { for (const id of ['T-03', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
      git('commit', '-q', '-am', 'only T-04\n\nTask: none\nReq: none');
      execFileSync('node', [join(root, 'scripts/adr.mjs'), '--root', root, 'migrate', '--ids', 'DEC-002,DEC-005']);
      const f2 = join(root, 'spec/adr', readdirSync(join(root, 'spec/adr')).find((f) => f.startsWith('0002')));
      writeFileSync(f2, readFileSync(f2, 'utf8').replace(/- Módulos: .*/, '- Módulos: docs/'));
      execFileSync('node', [join(root, 'scripts/adr.mjs'), '--root', root, 'index']);
      git('add', '-A');
      git('commit', '-q', '-m', 'ADRs\n\nTask: none\nReq: none');
      autopilot({ STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}', AUTOPILOT_PLAN_GATE: 'on', AUTOPILOT_ADR_RECENT: '0' });
      const impl = readFileSync(join(root, '.autopilot/stub-prompt-T-04.txt'), 'utf8');
      expect(impl).toContain('Decisions in force for this task (DEC-036): read only these: spec/adr/0005-');
      expect(impl).not.toContain('spec/adr/0002-');
      const all = readFileSync(join(root, '.autopilot/stub-args-critic-1.txt'), 'utf8').split('\n');
      const allowed = all.slice(0, all.indexOf('--disallowedTools')).join('\n');
      const denied = all.slice(all.indexOf('--disallowedTools')).join('\n');
      expect(allowed).toMatch(/Read\(\.\/spec\/adr\/0005-/);
      expect(allowed).not.toMatch(/Read\(\.\/spec\/adr\/0002-/);
      expect(allowed).not.toContain('Read(./spec/adr/)');
      expect(denied).toMatch(/Read\(\.\/spec\/adr\/0002-/); // the ADRs it does not get are denied to it
      expect(readFileSync(join(root, '.autopilot/stub-plan-prompt-T-04-1.txt'), 'utf8')).toContain('Decisions in force for this task (DEC-036)');
    });

    describe('batch branch: runs integrate into autopilot/lote; master moves only by the user (DEC-033, T-65)', () => {
      const on = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}', AUTOPILOT_BATCH: 'on' };
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).filter((d) => d.startsWith('20')).sort().at(-1));
      const result = () => JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'));
      const main = () => git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      const onlyT03 = () => {
        editTasks((ts) => { for (const id of ['T-04', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
        git('commit', '-q', '-am', 'only T-03\n\nTask: none\nReq: none');
      };

      it('the run works on the batch branch: master does not move; the reviewed batch is closed with one --batch suite and a merge command for the user', () => {
        onlyT03();
        const master = main();
        const before = git('rev-parse', master).trim();
        const r = autopilot(on);
        expect(r.status).toBe(0);
        expect(git('rev-parse', master).trim()).toBe(before);
        expect(main()).toBe('autopilot/lote');
        expect(git('log', '--format=%s', `${master}..autopilot/lote`)).toContain('T-03: stub');
        expect(t03()).toMatchObject({ status: 'reviewed', evidence: { batch: ['T-03'] } });
        expect(r.stdout).toContain(`batch autopilot/lote ready (DEC-033): merge it yourself: git checkout ${master} && git merge --ff-only autopilot/lote`);
        expect(result()).toMatchObject({ batch: { branch: 'autopilot/lote', tasks: ['T-03'], ready: true }, intervention: true });
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('git merge --ff-only autopilot/lote');
      });

      it('T-86: a failed batch suite asks for intervention: not ready, intervention true and a next action that says what to do', () => {
        onlyT03();
        // passes when the task closes; fails in the batch suite, once the orchestrator has written artifacts/T-03/
        editTasks((ts) => { const t = task(ts, 'T-03'); t.verify = `test ! -e artifacts/T-03/verify.log && ${t.verify}`; });
        git('commit', '-q', '-am', 'T-03 verify fails in the batch suite\n\nTask: none\nReq: none');
        autopilot(on);
        expect(result()).toMatchObject({
          batch: { ready: false, reason: expect.stringContaining('the batch suite failed') },
          intervention: true,
          next_action: expect.stringContaining('the batch suite of autopilot/lote failed'),
        });
        expect(result().next_action).toContain('record_evidence.py --task');
      });

      it('a task left in verified_auto (a rejection) keeps the batch open: no batch suite, not ready', () => {
        onlyT03();
        autopilot({ ...on, STUB_VERDICT: '{"verdict":"rejected","findings":["REQ-001: x"],"notes":"n"}' });
        expect(result().batch).toMatchObject({ ready: false, reason: expect.stringContaining('T-03') });
        expect(t03().evidence.batch === undefined).toBe(true);
      });

      it('the push goes to the batch branch, only when the batch is ready; never to master', () => {
        onlyT03();
        const remote = join(root, '..', `${root.split('/').pop()}-remote.git`);
        execFileSync('git', ['init', '-q', '--bare', remote]);
        git('remote', 'add', 'origin', remote);
        const master = main();
        try {
          autopilot({ ...on, AUTOPILOT_PUSH_REMOTE: 'origin' });
          const refs = execFileSync('git', ['-C', remote, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
          expect(refs).toContain('refs/heads/autopilot/lote');
          expect(refs).not.toContain(`refs/heads/${master}`);
        } finally { rmSync(remote, { recursive: true, force: true }); }
      });

      it('after the user merges it, the next run records merged and starts a new batch from master', () => {
        onlyT03();
        autopilot(on);
        const master = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').find((b) => b && b !== 'autopilot/lote');
        const tip = git('rev-parse', 'autopilot/lote').trim();
        git('checkout', '-q', master);
        git('merge', '-q', '--ff-only', 'autopilot/lote');
        autopilot(on);
        expect(t03().merged).toMatchObject({ into: master, commit: tip });
        expect(git('merge-base', '--is-ancestor', master, 'autopilot/lote') === '').toBe(true);
        expect(git('rev-parse', master).trim()).toBe(tip); // the orchestrator never moved it
      });
    });

    describe('a review without a verdict blocks its task and the run goes on (DEC-030, T-62)', () => {
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).filter((d) => d.startsWith('20')).sort().at(-1));
      const queue = (ids) => {
        editTasks((ts, d) => {
          for (const id of ids) Object.assign(task(ts, id), { status: 'verified_auto', depends_on: [], evidence: { command: 'x', result: 'y', commit: 'z' } });
          d.evidence_legacy = [...new Set([...(d.evidence_legacy ?? []), ...ids])];
        });
        git('commit', '-q', '-am', 'queue\n\nTask: none\nReq: none');
        for (const id of ids) git('commit', '-q', '--allow-empty', '-m', `${id}: work\n\nTask: ${id}\nReq: none`);
      };

      it('a reviewer with no valid JSON verdict: blocked by a new Q-NN with the reason; the next task of the queue is reviewed', () => {
        queue(['T-02', 'T-06']);
        const r = autopilot({ STUB_VERDICT: 'not a verdict', STUB_VERDICT_NEXT: '{"verdict":"approved","findings":[],"notes":"ok"}' }, '--review-only');
        const t02 = task(readTasks(), 'T-02');
        expect(t02.status).toBe('blocked');
        expect(t02.blocked_by).toMatch(/^Q-\d+$/);
        expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain(`| ${t02.blocked_by} |`);
        expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain('no entregó un veredicto JSON válido');
        expect(task(readTasks(), 'T-06').status).toBe('reviewed');
        expect(r.stdout).toContain('T-02: review without a verdict');
        expect(r.stdout).toContain('stop: review only (DEC-023): the queue is empty');
        expect(JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'))).toMatchObject({ review_blocked: ['T-02'], status: 'ok' });
      });
    });

    describe('no start gate: the orchestrator grants approved_for_impl after the critique, outside sensitive zones (DEC-022, T-53)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const on = { ...approved, AUTOPILOT_PLAN_GATE: 'on' };
      const t04 = () => task(readTasks(), 'T-04');
      const log = () => readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')));
      const result = () => JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'));
      const criticRan = () => existsSync(join(root, '.autopilot/stub-critic-count'));
      const specified = (edit = () => {}) => { // only T-04 (app/src/orders/) is left, waiting in specified
        editTasks((ts) => {
          for (const id of ['T-03', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted';
          task(ts, 'T-04').status = 'specified';
          edit(ts);
        });
        git('add', '-A');
        git('commit', '-q', '-m', 'T-04 specified\n\nTask: none\nReq: none');
      };

      it('plan gate off: a specified task is not taken (no critic, no grant)', () => {
        specified();
        const r = autopilot(approved);
        expect(r.stdout).toContain('stop: no in_progress/ready/approved_for_impl tasks');
        expect(criticRan()).toBe(false);
        expect(t04().status).toBe('specified');
      });

      it('not sensitive and APROBAR: approved_for_impl with impl_approval, a LOG entry and its commit; then implemented', () => {
        specified();
        const r = autopilot(on);
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('T-04: approved_for_impl granted by the orchestrator (DEC-022; commit ');
        const subjects = git('log', '--reverse', '--format=%s').split('\n');
        const grantAt = subjects.indexOf('T-04: approved_for_impl granted by the orchestrator (DEC-022)');
        expect(grantAt).toBeGreaterThan(subjects.indexOf('T-04: plan critique, round 1 (APROBAR)'));
        expect(subjects.indexOf('T-04: stub')).toBeGreaterThan(grantAt);
        const t = t04();
        expect(t.impl_approval).toMatchObject({ by: 'autopilot (DEC-022)', plan_sha: git('rev-parse', 'HEAD:plans/T-04.md').trim() });
        expect(t.status).toBe('reviewed');
        expect(log()).toContain('el orquestador otorga `approved_for_impl` a T-04 (DEC-022)');
        expect(result()).toMatchObject({ approved_for_impl: ['T-04'], sensitive_wait: [] });
      });

      it('a sensitive touch: no critic, it stays specified for the user and is listed in sensitive_wait with the zone', () => {
        specified((ts) => { task(ts, 'T-04').touches = ['app/src/orders/', 'package.json']; });
        const r = autopilot(on);
        expect(r.stdout).toContain('T-04 touches a sensitive zone (package.json');
        expect(criticRan()).toBe(false);
        expect(t04().status).toBe('specified');
        expect(t04().impl_approval === undefined).toBe(true);
        expect(result()).toMatchObject({ sensitive_wait: ['T-04'], approved_for_impl: [] });
        expect(log()).toContain('T-04 espera al usuario: toca una zona sensible (package.json');
      });

      it('a sensitive file under a touched directory counts too', () => {
        mkdirSync(join(root, 'app/src/orders/auth'), { recursive: true });
        writeFileSync(join(root, 'app/src/orders/auth/login.ts'), 'export {};\n');
        specified();
        const r = autopilot(on);
        expect(r.stdout).toContain('T-04 touches a sensitive zone (app/src/orders/auth/login.ts');
        expect(criticRan()).toBe(false);
        expect(t04().status).toBe('specified');
      });

      it('the critic escalates: nothing is granted', () => {
        specified();
        autopilot({ ...on, STUB_CRITIC: JSON.stringify({ verdict: 'ESCALAR', assumptions: [1, 2, 3].map((n) => ({ assumption: `s${n}`, practice: 'p', sources: [`https://example.com/${n}`] })), findings: [], summary: 's' }) });
        expect(t04().status).toBe('blocked');
        expect(t04().impl_approval === undefined).toBe(true);
      });

      it('a decision of the task not accepted: not taken', () => {
        writeFileSync(join(root, 'spec/DECISIONS.md'), readFileSync(join(root, 'spec/DECISIONS.md'), 'utf8').replace(/(## DEC-005[^\n]*\n- Estado: )accepted/, '$1proposed'));
        specified();
        autopilot(on);
        expect(criticRan()).toBe(false);
        expect(t04().status).toBe('specified');
      });

      it('an auto-approved task that changes one assertion of an existing test is escalated; a new test file is not (DEC-034, T-66)', () => {
        mkdirSync(join(root, 'app/src/orders'), { recursive: true });
        writeFileSync(join(root, 'app/src/orders/orders.test.ts'), "it('keeps the order', () => { expect(1).toBe(1); });\n");
        specified();
        const r = autopilot({ ...on, STUB_MODE: 'edittest' });
        expect(r.stdout).toContain('T-04: the diff deletes or weakens tests (modified: app/src/orders/orders.test.ts');
        expect(t04().status).toBe('blocked');
        expect(git('show', 'HEAD:app/src/orders/orders.test.ts')).toContain('toBe(1)');
      });

      it('an auto-approved task that only adds a test file goes on (DEC-034, T-66)', () => {
        specified();
        autopilot({ ...on, STUB_MODE: 'newtest' });
        expect(t04().status).toBe('reviewed');
      });

      it('an auto-approved task whose diff deletes a test: the result is not applied and it is escalated', () => {
        mkdirSync(join(root, 'app/src/orders'), { recursive: true });
        writeFileSync(join(root, 'app/src/orders/orders.test.ts'), "it('keeps the order', () => { expect(1).toBe(1); });\n");
        specified();
        const r = autopilot({ ...on, STUB_MODE: 'deltest' });
        expect(r.stdout).toContain('T-04: the diff deletes or weakens tests');
        expect(t04().status).toBe('blocked');
        expect(git('show', 'HEAD:app/src/orders/orders.test.ts')).toContain('keeps the order'); // not integrated
        expect(log()).toContain('borra o debilita pruebas');
      });
    });

    describe('coverage from acceptance (DEC-011)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const t04 = () => task(readTasks(), 'T-04');
      const log = () => readFileSync(join(root, 'spec/LOG.md'), 'utf8');
      const runDir = () => join(root, '.autopilot', readdirSync(join(root, '.autopilot')).filter((d) => d.startsWith('20')).sort().pop());
      const result = () => JSON.parse(readFileSync(join(runDir(), 'result.json'), 'utf8'));
      const coverageCfg = (extra = {}) => writeFileSync(join(root, 'spec/COVERAGE.json'), `${JSON.stringify({
        command: 'sh tests/coverage-stub.sh {lcov} {files}', sources: ['app/'], tests: ['tests/'], code_extensions: ['txt'], ...extra,
      }, null, 2)}\n`);
      beforeEach(() => { // only T-04 (REQ-002, app/src/orders/) is left; an acceptance test cites REQ-002
        editTasks((ts) => { for (const id of ['T-03', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
        mkdirSync(join(root, 'tests/acceptance'), { recursive: true });
        cpSync(join(STUBS, '..', 'coverage-stub.sh'), join(root, 'tests/coverage-stub.sh'));
        writeFileSync(join(root, 'tests/acceptance/orders.test.sh'), '# REQ-002: E1\ntrue\n');
        git('add', '-A');
        git('commit', '-q', '-m', 'only T-04, with its acceptance test\n\nTask: T-03\nReq: REQ-002');
      });
      const inRule = (extra) => { coverageCfg(extra); git('add', '-A'); git('commit', '-q', '-m', 'coverage rule\n\nTask: none\nReq: none'); };

      it('out of the rule: the summary keeps one specified task to enable it, created once, in the summary commit', () => {
        const r = autopilot(approved);
        expect(r.status).toBe(0);
        const enable = readTasks().filter((t) => t.title === 'Habilitar la cobertura desde aceptación (DEC-011 de sdd-base)');
        expect(enable).toHaveLength(1);
        expect(enable[0]).toMatchObject({ status: 'specified', kind: 'tooling', reqs: [] });
        expect(log()).toContain(`fuera de la regla (sin spec/COVERAGE.json; la aceptación no corre en local con cobertura); tarea para habilitarla: ${enable[0].id} (Habilitar la cobertura desde aceptación (DEC-011 de sdd-base)), creada en esta corrida.`);
        expect(git('show', '--name-only', '--format=%s', 'HEAD')).toContain('Autopilot: summary');
        expect(git('show', '--name-only', '--format=', 'HEAD')).toContain('spec/TASKS.json');
        expect(result().coverage_tasks_created).toEqual([enable[0].id]);
        expect(readFileSync(join(root, '.autopilot/stub-prompt-T-04.txt'), 'utf8')).not.toContain('Coverage (DEC-011)');
        autopilot(approved);
        expect(readTasks().filter((t) => t.title === enable[0].title)).toHaveLength(1);
        expect(log()).toContain(`tarea para habilitarla: ${enable[0].id}.`);
        expect(git('status', '--porcelain')).toBe('');
      });

      it('in the rule: every line the task added is reached → applied; the prompt explains the rule', () => {
        inRule();
        const r = autopilot(approved);
        expect(r.status).toBe(0);
        expect(t04()).toMatchObject({ status: 'reviewed' });
        expect(readFileSync(join(root, '.autopilot/stub-prompt-T-04.txt'), 'utf8')).toContain('Coverage (DEC-011): every line you add or change must be executed by an acceptance test');
        expect(log()).toContain('cobertura desde aceptación de T-04: toda línea nueva o cambiada la alcanza una prueba con REQ');
        expect(log()).toContain('- Cobertura desde aceptación (DEC-011 de sdd-base; spec/COVERAGE.json): resultados no aplicados por líneas sin alcanzar: ninguna; requisitos faltantes escalados: ninguna;');
        expect(readTasks().some((t) => t.title.startsWith('Habilitar la cobertura'))).toBe(false);
        expect(JSON.parse(readFileSync(join(runDir(), 'T-04-coverage-1.json'), 'utf8')).tests).toEqual(['tests/acceptance/orders.test.sh']);
      });

      it('a line the task added that no acceptance test reaches: not applied, retried with those lines', () => {
        inRule();
        const r = autopilot({ ...approved, COVERAGE_MISS_ONCE: '1' });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('T-04: lines no acceptance test citing a REQ reaches');
        const prompts = readFileSync(join(root, '.autopilot/stub-prompt-T-04.txt'), 'utf8').split('\x1e');
        expect(prompts[1]).toContain('Coverage (DEC-011): your previous attempt was not applied because no acceptance test that cites a REQ reaches these lines: app/src/orders/stub-T-04.txt:1 (nuevas o cambiadas, sin alcanzar)');
        expect(t04()).toMatchObject({ status: 'reviewed' }); // the second attempt is reached
        expect(log()).toContain('T-04: líneas que ninguna prueba de aceptación con REQ alcanza (app/src/orders/stub-T-04.txt:1 (nuevas o cambiadas, sin alcanzar)); no se aplica el resultado');
        expect(result()).toMatchObject({ coverage_failed: ['T-04'], failures: 1 });
      });

      it('the implementer reports a missing requirement → escalated with a Q-NN', () => {
        inRule();
        const r = autopilot({ ...approved, STUB_MODE: 'missing' });
        expect(r.status).toBe(1);
        expect(t04()).toMatchObject({ status: 'blocked', blocked_by: 'Q-03' });
        expect(log()).toContain('- Decisión: escalar T-04 al usuario (DEC-011 de sdd-base): falta un requisito: app/src/orders/stub-T-04.txt:1: valida un caso que ningún REQ pide.');
        expect(readFileSync(join(root, 'spec/SPEC.md'), 'utf8')).toContain('El orquestador la escaló porque falta un requisito (DEC-011 de sdd-base)');
        expect(t04().notes).toContain('falta un requisito según el implementador para app/src/orders/stub-T-04.txt:1');
        expect(result()).toMatchObject({ missing_requirement: ['T-04'] });
        expect(git('status', '--porcelain')).toBe('');
      });

      it('baseline: it goes down with the task\'s result and each file in it gets one cleanup task', () => {
        mkdirSync(join(root, 'app/src'), { recursive: true });
        writeFileSync(join(root, 'app/src/legacy.txt'), 'a\nb\nc\n');
        inRule({ baseline: { 'app/src/legacy.txt': 3 } });
        const r = autopilot({ ...approved, COVERAGE_LEGACY_MISS: '1' });
        expect(r.status).toBe(0);
        const cfg = () => JSON.parse(readFileSync(join(root, 'spec/COVERAGE.json'), 'utf8'));
        expect(cfg().baseline).toEqual({ 'app/src/legacy.txt': 1 });
        expect(git('show', '--name-only', '--format=', ':/T-04: apply implementer result')).toContain('spec/COVERAGE.json');
        expect(log()).toContain('T-04: baja la línea base de cobertura de spec/COVERAGE.json (app/src/legacy.txt → 1)');
        const cleanup = readTasks().filter((t) => t.title === 'Código no alcanzado en app/src/legacy.txt (DEC-011 de sdd-base)');
        expect(cleanup).toHaveLength(1);
        expect(cleanup[0]).toMatchObject({ status: 'specified', touches: ['app/src/legacy.txt'], reqs: [] });
        expect(result().coverage_tasks_created).toEqual([cleanup[0].id]);
      });

      it('a coverage command that cannot run stops the run without applying anything', () => {
        inRule({ command: 'true {files} {lcov}' });
        const r = autopilot(approved);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('stop: check-coverage could not run on T-04');
        expect(t04().status).toBe('approved_for_impl');
      });

      it('--dry-run says how the rule applies and creates nothing', () => {
        const before = readFileSync(join(root, 'spec/TASKS.json'), 'utf8');
        const r = autopilot(approved, '--dry-run');
        expect(r.stdout).toContain('Coverage (DEC-011): out of the rule (no spec/COVERAGE.json); the summary keeps a specified task to enable it');
        expect(r.stdout).toContain('creada en esta corrida (ensayo: se crearían).');
        expect(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).toBe(before);
      });
    });

    describe('deterministic evidence at the close (DEC-014)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const log = () => readFileSync(join(root, 'spec/LOG.md'), 'utf8');

      it('the Stop hook records a report; the orchestrator re-runs verify and record_evidence.py writes evidence and status', () => {
        const r = autopilot(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(readFileSync(join(root, '.autopilot/stub-stop-T-03.txt'), 'utf8').trim()).toBe('0');
        const ev = t03().evidence;
        expect(ev).toMatchObject({ passed: 25, failed: 0, total: 25, exit_code: 0, log_path: 'artifacts/T-03/verify.log' });
        expect(ev.result).toContain('registrado por record_evidence.py');
        expect(t03().status).toBe('reviewed');
        expect(git('show', '--name-only', '--format=', ':/T-03: apply implementer result')).toContain('artifacts/T-03/verify.log');
        expect(git('status', '--porcelain')).toBe('');
      });

      it('a hook that is down (no report) blocks the close: nothing applied', () => {
        const r = autopilot({ ...approved, STUB_HOOK: 'skip' }, '--max-tasks', '1');
        expect(r.status).toBe(1);
        expect(t03().status).toBe('ready');
        expect(log()).toContain('T-03: sin el informe de evidencia del hook Stop (hook caído o cierre forzado): el cierre se bloquea; no se aplica el resultado (DEC-014)');
        expect(existsSync(join(root, 'artifacts/T-03'))).toBe(false); // no evidence (artifacts/decisions/ holds the decider's records)
      });

      it('a report altered by hand: blocked by evidence_mismatch, the run stops', () => {
        const r = autopilot({ ...approved, STUB_EVIDENCE: 'forge' }, '--max-tasks', '1');
        expect(r.status).toBe(1);
        expect(t03()).toMatchObject({ status: 'blocked', blocked_by: 'evidence_mismatch', evidence: { passed: 25, total: 25 } });
        expect(r.stdout).toContain('stop: T-03 ended blocked by evidence_mismatch (DEC-014)');
        expect(log()).toContain('el log del hook no coincide con su informe');
        expect(git('status', '--porcelain')).toBe('');
      });

      it('a verify that fails when the orchestrator re-runs it: not applied', () => {
        editTasks((ts) => { task(ts, 'T-03').verify = 'echo "ℹ tests 2"; echo "ℹ pass 1"; echo "ℹ fail 1"; exit 1'; });
        git('commit', '-q', '-am', 'failing verify\n\nTask: none\nReq: none');
        const r = autopilot(approved, '--max-tasks', '1');
        expect(readFileSync(join(root, '.autopilot/stub-stop-T-03.txt'), 'utf8').trim().split('\n')[0]).toBe('2'); // the hook blocked the close
        expect(r.status).toBe(1);
        expect(t03().status).toBe('ready');
        expect(log()).toContain('record_evidence.py salió con 2 al volver a correr su verify');
      });
    });

    describe('tokens of the run and monthly cap (DEC-048, T-88)', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      let state;
      beforeEach(() => { state = mkdtempSync(join(tmpdir(), 'autopilot-tokens-')); });
      afterEach(() => rmSync(state, { recursive: true, force: true }));
      const ledger = () => join(state, 'autopilot/tokens.test-doubles.jsonl'); // with agent doubles, never the real tokens.jsonl (T-73)
      const month = new Date().toISOString().slice(0, 7);
      const seed = (u) => { mkdirSync(join(state, 'autopilot'), { recursive: true }); writeFileSync(ledger(), JSON.stringify({ month, repo: 'other', run: 'x', role: 'implementer', task: 'T-99', input: 0, output: 0, cache_write: 0, cache_read: 0, ...u }) + '\n'); };
      const result = () => JSON.parse(readFileSync(join(root, '.autopilot', readdirSync(join(root, '.autopilot')).find((d) => d.startsWith('20')), 'result.json'), 'utf8'));

      it('T-88: a run whose agents are test doubles never writes the real ledger: tokens.test-doubles.jsonl, and no costs.jsonl at all (DEC-048, T-73)', () => {
        autopilot({ ...approved, XDG_STATE_HOME: state }, '--max-tasks', '1');
        expect(existsSync(join(state, 'autopilot/tokens.jsonl'))).toBe(false);
        expect(existsSync(join(state, 'autopilot/costs.jsonl'))).toBe(false);
        expect(existsSync(join(state, 'autopilot/costs.test-doubles.jsonl'))).toBe(false);
        expect(readFileSync(ledger(), 'utf8').trim().split('\n').map((l) => JSON.parse(l).role)).toEqual(['implementer']); // the reviewer double reports no usage here
      });

      it('T-88: every invocation adds its four token kinds to the ledger; summary, notice and result.json give the counted tokens and cache read apart, no dollars', () => {
        const r = autopilot({ ...approved, STUB_REVIEW_USAGE: '1', XDG_STATE_HOME: state, NTFY_TOPIC: 't', NTFY_URL: 'https://ntfy.example' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        const lines = readFileSync(ledger(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        expect(lines.map((l) => [l.role, l.task, l.input, l.output, l.cache_write, l.cache_read])).toEqual([
          ['implementer', 'T-03', 44, 11440, 64481, 1266786], ['reviewer', 'T-03', 7, 300, 100, 9000]]);
        expect(lines[0]).toMatchObject({ month, repo: root.split('/').pop() });
        expect(lines[0].usd).toBe(undefined);
        const log = readFileSync(join(root, 'spec/LOG.md'), 'utf8');
        expect(log).toContain(`- Tokens para el tope (DEC-048; cuentan entrada, salida y caché escrita): en esta corrida 76.372 cuentan para el tope (entrada 51 · salida 11.740 · caché escrita 64.581) y 1.275.786 de caché leída aparte; en ${month}, 76.372 (sin tope mensual) y 1.275.786 de caché leída.`);
        expect(log).not.toMatch(/US\$ [0-9]/);
        const res = result();
        expect(res).toMatchObject({ tokens: { input: 51, output: 11740, cache_write: 64581, cache_read: 1275786, counted: 76372 },
          month_tokens: { input: 51, output: 11740, cache_write: 64581, cache_read: 1275786, counted: 76372 }, monthly_budget_tokens: null });
        expect('cost_usd' in res || 'month_cost_usd' in res || 'monthly_budget_usd' in res).toBe(false);
        expect(body(curlCalls().at(-1))).toContain(`Tokens: run 76,372 counted (input 51 · output 11,740 · cache write 64,581) + cache read 1,275,786; month ${month}: 76,372 counted, cache read 1,275,786`);
      });

      it('T-88: with the monthly cap reached no agent is launched: the run stops and asks for intervention (high priority)', () => {
        seed({ input: 100, output: 400, cache_write: 500 });
        const r = autopilot({ ...approved, XDG_STATE_HOME: state, AUTOPILOT_MONTHLY_BUDGET_TOKENS: '1000', NTFY_TOPIC: 't', NTFY_URL: 'https://ntfy.example' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain(`stop: monthly token cap reached: 1000 of 1000 (input + output + cache write) in ${month} (DEC-048); implementer on T-03 not launched`);
        expect(existsSync(join(root, '.autopilot/stub-prompt-T-03.txt'))).toBe(false);
        expect(result()).toMatchObject({ status: 'budget_exhausted', intervention: true, monthly_budget_tokens: 1000, month_tokens: { counted: 1000 },
          next_action: expect.stringContaining('raise AUTOPILOT_MONTHLY_BUDGET_TOKENS') });
        expect(header(curlCalls().at(-1), 'Priority')).toBe('high');
        expect(readFileSync(join(root, 'spec/LOG.md'), 'utf8')).toContain('de un tope de 1.000');
      });

      it('T-88: cache read does not count for the cap: a huge cache read below it runs as usual; an invalid cap stops at the start', () => {
        seed({ output: 10, cache_read: 900000000 });
        const r = autopilot({ ...approved, XDG_STATE_HOME: state, AUTOPILOT_MONTHLY_BUDGET_TOKENS: '1000000' }, '--max-tasks', '1');
        expect(r.status).toBe(0);
        expect(result()).toMatchObject({ tokens: { counted: 75965 }, month_tokens: { counted: 75975, cache_read: 901266786 }, monthly_budget_tokens: 1000000 });
        expect(autopilot({ XDG_STATE_HOME: state, AUTOPILOT_MONTHLY_BUDGET_TOKENS: 'mucho' }).stderr).toContain('invalid AUTOPILOT_MONTHLY_BUDGET_TOKENS: mucho');
      });

      it('T-88: only the obsolete AUTOPILOT_MONTHLY_BUDGET_USD set: no agent is launched and it asks to set the cap in tokens', () => {
        const r = autopilot({ ...approved, XDG_STATE_HOME: state, AUTOPILOT_MONTHLY_BUDGET_USD: '60' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('AUTOPILOT_MONTHLY_BUDGET_USD is no longer used (DEC-048): set AUTOPILOT_MONTHLY_BUDGET_TOKENS');
        expect(existsSync(join(root, '.autopilot/stub-prompt-T-03.txt'))).toBe(false);
        expect(result()).toMatchObject({ status: 'budget_exhausted', intervention: true, next_action: expect.stringContaining('set AUTOPILOT_MONTHLY_BUDGET_TOKENS') });
      });
    });

    describe('result.json of the run', () => {
      const approved = { STUB_VERDICT: '{"verdict":"approved","findings":[],"notes":"ok"}' };
      const runDirs = () => readdirSync(join(root, '.autopilot')).filter((d) => d.startsWith('20'));
      const result = () => {
        const [d] = runDirs();
        return JSON.parse(readFileSync(join(root, '.autopilot', d, 'result.json'), 'utf8'));
      };

      it('normal run: done tasks, stop reason, tokens and duration; its path is the last line of the output', () => {
        const r = autopilot(approved, '--max-tasks', '1');
        expect(r.status).toBe(0);
        const res = result();
        expect(res).toMatchObject({
          run_id: runDirs()[0], repo: root.split('/').pop(), exit_code: 0,
          stop_reason: 'task budget reached (1)', done: ['T-03'], failed: [], failures: 0, abandoned: [],
          rejected: [], deploy_pending: [], user_wait: [], intervention: true,
          next_action: 'relaunch the autopilot to continue (limit reached)',
          tokens: { input: 44, output: 11440, cache_read: 1266786, cache_write: 64481, invocations: 1 },
        });
        expect(Number.isInteger(res.duration_seconds) && res.duration_seconds >= 0).toBe(true);
        expect(r.stdout.trim().split('\n').at(-1)).toBe(`result: ${join(root, '.autopilot', runDirs()[0], 'result.json')}`);
        expect(git('status', '--porcelain')).toBe(''); // .autopilot/ stays outside git
      });

      it('finished fine: no intervention', () => {
        editTasks((ts) => { for (const id of ['T-04', 'T-05', 'T-06', 'T-07']) task(ts, id).status = 'accepted'; });
        git('commit', '-q', '-am', 'only T-03\n\nTask: none\nReq: none');
        expect(autopilot(approved).status).toBe(0);
        expect(result()).toMatchObject({
          exit_code: 0, done: ['T-03'], intervention: false,
          stop_reason: expect.stringContaining('no in_progress/ready/approved_for_impl tasks'),
          next_action: 'review the summary in spec/LOG.md and the verdicts in TASKS.json; decide accepted',
        });
      });

      it('with failures: failed, abandoned, exit code 1 and intervention', () => {
        expect(autopilot({ STUB_MODE: 'fail' }).status).toBe(1);
        expect(result()).toMatchObject({
          exit_code: 1, done: [], failed: ['T-03'], failures: 2, abandoned: ['T-03'], intervention: true,
          next_action: expect.stringContaining('review the failures of T-03'),
          tokens: { invocations: 2 },
        });
      });

      it('waiting for a deploy: listed, with intervention', () => {
        expect(autopilot({ ...approved, STUB_DEPLOY: 'T-03' }).status).toBe(0);
        expect(result()).toMatchObject({ exit_code: 0, deploy_pending: ['T-03'], intervention: true });
      });

      it('rejected by the reviewer: listed, with intervention', () => {
        autopilot({ STUB_VERDICT: '{"verdict":"rejected","findings":["REQ-002: x"],"notes":"n"}' }, '--max-tasks', '1');
        expect(result()).toMatchObject({ done: ['T-03'], rejected: ['T-03'], intervention: true });
      });

      it('if it crashes after creating the run directory, it still leaves result.json with intervention', () => {
        const r = autopilot({}, '--task', 'T-99');
        expect(r.status).not.toBe(0);
        expect(result()).toMatchObject({
          exit_code: r.status, intervention: true,
          stop_reason: expect.stringContaining(`exited with code ${r.status} before writing its summary`),
          next_action: expect.stringContaining('check the terminal'),
        });
      });

      it('--dry-run writes no result.json', () => {
        expect(autopilot({}, '--dry-run').status).toBe(0);
        expect(runDirs()).toEqual([]);
      });
    });
  });

  describe('--check', () => {
    let bin;
    beforeEach(() => { bin = stubBin(); });
    afterEach(() => { rmSync(bin, { recursive: true, force: true }); rmSync(curlLog(), { force: true }); });
    const curlLog = () => join(root, '..', `${root.split('/').pop()}-curl.log`);
    const env = () => ({
      ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_CURL_LOG: curlLog(),
      NTFY_TOPIC: 'test-topic', NTFY_URL: 'https://ntfy.example',
    });
    const check = (cmd = 'bash', pre = []) =>
      spawnSync(cmd, [...pre, join(root, 'scripts/autopilot.sh'), '--check'], { encoding: 'utf8', env: env() });
    let git;
    const repo = (fn) => { // fixture with T-02 in verified_auto; fn adjusts the tasks before the commit
      copyAutopilot();
      git = gitIn(root);
      git('init', '-q');
      editTasks(fn);
      git('add', '-A');
      git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
    };
    const allAccepted = (ts) => { for (const t of ts) t.status = 'accepted'; };
    const untouched = () => {
      expect(git('status', '--porcelain', '--ignored')).toBe('');
      expect(git('log', '--format=%s')).toBe('base\n');
      let notified = true;
      try { readFileSync(curlLog()); } catch { notified = false; }
      expect(notified).toBe(false);
    };

    it('an eligible task: exit 0 with the task and the pending reviews; launches and writes nothing', () => {
      repo((ts) => { task(ts, 'T-01').status = 'accepted'; task(ts, 'T-03').status = 'ready'; });
      const r = check();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('autopilot --check: work: task T-03 is eligible; pending reviews: T-02\n');
      expect(r.stderr).toBe('');
      untouched();
    });

    it('only pending reviews (verified_auto): exit 0', () => {
      repo((ts) => { allAccepted(ts); task(ts, 'T-02').status = 'verified_auto'; });
      const r = check();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('autopilot --check: work: pending reviews: T-02\n');
      untouched();
    });

    it('nothing to do: exit 3, without notice or result.json', () => {
      repo(allAccepted);
      const r = check();
      expect(r.status).toBe(3);
      expect(r.stdout).toBe('autopilot --check: nothing to do: no eligible tasks and no pending reviews\n');
      untouched();
    });

    it('dirty tree: exit 2 with the reason', () => {
      repo((ts) => { task(ts, 'T-03').status = 'ready'; });
      writeFileSync(join(root, 'stray.txt'), 'x\n');
      const r = check();
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('autopilot --check: cannot run: dirty working tree\n');
    });

    it('lock busy (a run in progress): exit 2; with the lock free it does not keep it', () => {
      repo((ts) => { task(ts, 'T-01').status = 'accepted'; task(ts, 'T-03').status = 'ready'; });
      mkdirSync(join(root, '.autopilot'));
      writeFileSync(join(root, '.autopilot/.gitignore'), '*\n');
      const lock = join(root, '.autopilot/lock');
      writeFileSync(lock, '');
      const busy = check('flock', [lock, 'bash']); // flock holds the lock while the check runs
      expect(busy.status).toBe(2);
      expect(busy.stdout).toBe('autopilot --check: cannot run: another run is in progress (.autopilot/lock)\n');
      expect(check().status).toBe(0);
      expect(spawnSync('flock', ['-n', lock, 'true']).status).toBe(0); // not kept after the check
    });
  });

  it('refuses to run with a dirty tree (in a dry run it only warns)', () => {
    copyAutopilot();
    gitIn(root)('init', '-q');
    const bin = stubBin();
    try {
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      const r = spawnSync('bash', [join(root, 'scripts/autopilot.sh')], { encoding: 'utf8', env });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('dirty working tree');
      const d = spawnSync('bash', [join(root, 'scripts/autopilot.sh'), '--dry-run'], { encoding: 'utf8', env });
      expect(d.status).toBe(0);
      expect(d.stderr).toContain('warning: dirty working tree');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('T-87: with the lock held by another run, --dry-run warns and exits 0; a real run still stops', () => {
    copyAutopilot();
    const git = gitIn(root);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
    mkdirSync(join(root, '.autopilot/2026-01-01_000000'), { recursive: true });
    writeFileSync(join(root, '.autopilot/.gitignore'), '*\n');
    writeFileSync(join(root, '.autopilot/2026-01-01_000000/live.log'), 'the run holding the lock, still going\n');
    const lock = join(root, '.autopilot/lock');
    writeFileSync(lock, '');
    const bin = stubBin();
    try {
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      const run = (...args) => // flock holds the lock while the autopilot runs, as the orchestrator does during a verify
        spawnSync('flock', [lock, 'bash', join(root, 'scripts/autopilot.sh'), ...args], { encoding: 'utf8', env });
      const d = run('--dry-run');
      expect(d.status).toBe(0);
      expect(d.stderr).toContain('warning: another autopilot run is in progress (.autopilot/lock); the dry run goes on');
      expect(d.stdout).toContain('== Dry run (--dry-run)');
      expect(d.stdout).not.toContain('crashed_orphan'); // the other run is not an orphan
      expect(git('status', '--porcelain')).toBe('');
      expect(git('log', '--format=%s')).toBe('base\n');
      expect(readdirSync(join(root, '.autopilot')).flatMap((n) => {
        try { return readdirSync(join(root, '.autopilot', n)); } catch { return []; }
      })).not.toContain('result.json');
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('another autopilot run is in progress (.autopilot/lock)');
      expect(r.stderr).not.toContain('warning:');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
