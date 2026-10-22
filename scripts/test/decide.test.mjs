import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { mapAnswer, RULES, ruleAnswer, userCriteriaPath, withUserCriteria } from '../lib/decide.mjs';

// The port decide (DEC-015, DEC-013): a pure core that maps a decider's answer to an action, tested without any decider;
// the Jev adapter (scripts/agents/decider/jev.sh) tested apart against a curl double; and that the adapter is reached
// through the port.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DECIDE = join(REPO, 'scripts/lib/decide.mjs');
const JEV = join(REPO, 'scripts/agents/decider/jev.sh');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'decide-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const question = { id: 'failure_cause', state: { task: 'T-04', error: 'npm test: 2 failing' }, instructions: 'Why did the task fail?',
  options: { implementation: 'the code is wrong', environment: 'a tool or dependency is broken', design: 'the plan does not fit' } };

describe('decide core: answer → action (DEC-015)', () => {
  const q = { options: question.options, threshold: 0.8 };
  it('an answer of the enum with enough confidence proceeds', () => {
    expect(mapAnswer(q, { answer: 'implementation', confidence: 0.91 })).toMatchObject({ action: 'proceed', answer: 'implementation', confidence: 0.91 });
  });
  it('low confidence escalates to the user', () => {
    expect(mapAnswer(q, { answer: 'implementation', confidence: 0.55 })).toMatchObject({ action: 'escalate', answer: 'implementation', reason: expect.stringContaining('0.55 < 0.8') });
  });
  it('an answer outside the enum is rejected (and escalates)', () => {
    expect(mapAnswer(q, { answer: 'cosmic_rays', confidence: 0.99 })).toMatchObject({ action: 'escalate', rejected: true, reason: expect.stringContaining('outside the options') });
  });
  it('a decider error or no answer escalates; never falls back to anything else', () => {
    expect(mapAnswer(q, { error: 'HTTP 503' })).toMatchObject({ action: 'escalate', reason: expect.stringContaining('HTTP 503') });
    expect(mapAnswer(q, null)).toMatchObject({ action: 'escalate' });
    expect(mapAnswer(q, { answer: 'implementation' })).toMatchObject({ action: 'escalate' }); // no confidence
  });
});

describe('decide CLI: runs the adapter, maps its answer and records the decision', () => {
  const decider = (body) => { const f = join(dir, 'decider.sh'); writeFileSync(f, `#!/usr/bin/env bash\ncat > ${join(dir, 'seen.json')}\n${body}\n`); chmodSync(f, 0o755); return f; };
  const ask = (deciderPath, extra = []) => {
    writeFileSync(join(dir, 'q.json'), JSON.stringify(question));
    return spawnSync('node', [DECIDE, 'ask', '--decider', deciderPath, '--question', join(dir, 'q.json'), '--threshold', '0.8', '--record-dir', join(dir, 'decisions'), ...extra], { encoding: 'utf8' });
  };

  it('proceed: the adapter got the question; the record has question, answer, confidence and action', () => {
    const r = ask(decider(`echo '{"answer":"environment","confidence":0.93,"probabilities":{"implementation":0.05,"environment":0.93,"design":0.02}}'`));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'proceed', answer: 'environment' });
    expect(JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'))).toMatchObject({ id: 'failure_cause', options: question.options });
    const files = readdirSync(join(dir, 'decisions'));
    expect(files.length).toBe(1);
    expect(JSON.parse(r.stdout).record).toBe(join(dir, 'decisions', files[0])); // T-36: the caller hands it on
    expect(JSON.parse(readFileSync(join(dir, 'decisions', files[0]), 'utf8'))).toMatchObject({
      question_id: 'failure_cause', instructions: 'Why did the task fail?', answer: 'environment', confidence: 0.93, action: 'proceed', decider: expect.stringContaining('decider.sh'),
    });
  });

  it('an adapter that fails, hangs or prints garbage escalates (and is recorded)', () => {
    expect(JSON.parse(ask(decider('echo "HTTP 500" >&2; exit 1')).stdout)).toMatchObject({ action: 'escalate', reason: expect.stringContaining('HTTP 500') });
    expect(JSON.parse(ask(decider('sleep 5'), ['--timeout', '1']).stdout)).toMatchObject({ action: 'escalate' });
    expect(JSON.parse(ask(decider('echo not json')).stdout)).toMatchObject({ action: 'escalate' });
    expect(readdirSync(join(dir, 'decisions')).length).toBe(3);
  });
});

describe('T-92: the user criteria reach the decider, and the record keeps their hash (DEC-050)', () => {
  const decider = () => { const f = join(dir, 'decider.sh'); writeFileSync(f, `#!/usr/bin/env bash\ncat > ${join(dir, 'seen.json')}\necho '{"answer":"design","confidence":0.9}'\n`); chmodSync(f, 0o755); return f; };
  const ask = (env) => {
    writeFileSync(join(dir, 'q.json'), JSON.stringify(question));
    const r = spawnSync('node', [DECIDE, 'ask', '--decider', decider(), '--question', join(dir, 'q.json'), '--threshold', '0.8', '--record-dir', join(dir, 'decisions')], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { seen: JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8')), record: JSON.parse(readFileSync(JSON.parse(r.stdout).record, 'utf8')) };
  };
  const criteria = '- Informar el consumo en tokens, no en dólares. Porqué: el tope es de tokens. Origen: DEC-048.\n';

  it('DEC-050: with the file, the adapter gets the criteria in the instructions and the record has its sha256', () => {
    const file = join(dir, 'criterios-usuario.md');
    writeFileSync(file, criteria);
    const { seen, record } = ask({ AUTOPILOT_USER_CRITERIA: file });
    expect(seen.instructions.startsWith(question.instructions)).toBe(true);
    expect(seen.instructions).toContain(criteria.trim());
    expect(seen).toMatchObject({ id: question.id, state: question.state, options: question.options });
    expect(record.user_criteria_sha256).toBe(createHash('sha256').update(criteria).digest('hex'));
  });

  it('DEC-050: without the file, the question goes as today and the record has a null hash', () => {
    const { seen, record } = ask({ AUTOPILOT_USER_CRITERIA: join(dir, 'missing.md') });
    expect(seen).toEqual(question);
    expect(record.user_criteria_sha256).toBe(null);
  });

  it('DEC-050: the default path is ${XDG_CONFIG_HOME:-~/.config}/autopilot/criterios-usuario.md', () => {
    expect(userCriteriaPath({ XDG_CONFIG_HOME: '/x' })).toBe('/x/autopilot/criterios-usuario.md');
    expect(userCriteriaPath({})).toBe(join(homedir(), '.config/autopilot/criterios-usuario.md'));
    expect(userCriteriaPath({ AUTOPILOT_USER_CRITERIA: '/y.md', XDG_CONFIG_HOME: '/x' })).toBe('/y.md');
    mkdirSync(join(dir, 'autopilot'));
    writeFileSync(join(dir, 'autopilot', 'criterios-usuario.md'), criteria);
    const { seen } = ask({ XDG_CONFIG_HOME: dir, AUTOPILOT_USER_CRITERIA: '' });
    expect(seen.instructions).toContain(criteria.trim());
  });

  it('DEC-050: an empty file counts as no file', () => {
    expect(withUserCriteria(question, '  \n')).toEqual({ question, sha256: null });
  });
});

describe('T-101: deterministic rules run before the decider (DEC-051)', () => {
  const verdictOpts = { approved: 'a', rejected: 'r' };
  const planOpts = { APROBAR: 'a', REVISAR: 'r', ESCALAR: 'e' };
  const causeOpts = { implementation: 'i', environment: 'e', design: 'd' };
  const critic = (verdict, blocking = [], opinion = []) => ({ verdict, blocking, opinion_blockers: opinion });
  const gates = (...g) => ({ gates: g.map(([name, result]) => ({ name, result })) });

  for (const [qid, opts, facts, answer, rule] of [
    ['review_verdict', verdictOpts, { verdict: 'approved', findings: [] }, 'approved', 'review_approved_without_findings'],
    ['review_verdict', verdictOpts, { verdict: 'rejected', findings: ['REQ-002: no E1'] }, 'rejected', 'review_rejected_with_findings'],
    ['acceptance_verdict', verdictOpts, { verdict: 'approved', findings: [] }, 'approved', 'review_approved_without_findings'],
    ['plan_verdict', planOpts, critic('ESCALAR', ['a:b']), 'ESCALAR', 'critic_escalates'],
    ['plan_verdict', planOpts, critic('APROBAR'), 'APROBAR', 'critic_approves_without_p0_p1'],
    ['plan_verdict', planOpts, critic('REVISAR', ['req-002:sin-caso-vacio']), 'REVISAR', 'critic_revises_with_blocking'],
    ['failure_cause', causeOpts, gates(['audit', 'ok'], ['result', 'ok'], ['green', 'fail']), 'implementation', 'acceptance_tests_red'],
    ['failure_cause', causeOpts, gates(['audit', 'ok'], ['green', 'ok'], ['coverage', 'fail']), 'implementation', 'coverage_gap'],
  ]) {
    it(`T-101 DEC-051: ${qid} ← rule ${rule}`, () => {
      expect(ruleAnswer(qid, opts, facts)).toEqual({ answer, rule });
    });
  }

  for (const [qid, opts, facts, why] of [
    ['review_verdict', verdictOpts, { verdict: 'approved', findings: ['REQ-001: no prueba'] }, 'approved with findings'],
    ['review_verdict', verdictOpts, { verdict: 'rejected', findings: [] }, 'rejected without findings'],
    ['plan_verdict', planOpts, critic('APROBAR', ['a:b']), 'APROBAR with a blocking finding'],
    ['plan_verdict', planOpts, critic('APROBAR', [], ['a:b']), 'APROBAR with an opinion-only P0/P1'],
    ['plan_verdict', planOpts, critic('REVISAR'), 'REVISAR without blocking findings'],
    ['failure_cause', causeOpts, gates(['evidence', 'fail']), 'a verify that fails at the close'],
    ['failure_cause', causeOpts, gates(['result', 'retry'], ['result', 'invalid']), 'a result invalid after its rewrite (DEC-051 point 3)'],
    ['failure_cause', causeOpts, gates(), 'no gates'],
    ['block_kind', { spec: 's', implementer: 'i' }, { kind: 'open_question' }, 'block_kind has no rule'],
    ['research_action', { reintentar: 'r', escalar: 'e' }, { action: 'escalar' }, 'research_action has no rule (T-37)'],
    ['finding_severity', { blocking: 'b' }, { severity: 'P0' }, 'finding_severity has no rule'],
    ['review_verdict', verdictOpts, null, 'no facts'],
  ]) {
    it(`T-101 DEC-051: ambiguous, no rule settles it: ${qid}, ${why}`, () => {
      expect(ruleAnswer(qid, opts, facts)).toBe(null);
    });
  }

  it('T-101 DEC-051: a rule answer outside the question\'s options is ignored', () => {
    expect(ruleAnswer('review_verdict', { yes: 'y', no: 'n' }, { verdict: 'approved', findings: [] })).toBe(null);
    expect(Object.keys(RULES).sort()).toEqual(['acceptance_verdict', 'failure_cause', 'plan_verdict', 'review_verdict']);
  });

  // the decider double counts its calls: each one appends a line to calls.txt
  const decider = () => { const f = join(dir, 'decider.sh'); writeFileSync(f, `#!/usr/bin/env bash\ncat >/dev/null\necho call >> ${join(dir, 'calls.txt')}\necho '{"answer":"rejected","confidence":0.9}'\n`); chmodSync(f, 0o755); return f; };
  const calls = () => { try { return readFileSync(join(dir, 'calls.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const ask = (facts) => {
    writeFileSync(join(dir, 'q.json'), JSON.stringify({ id: 'review_verdict', instructions: 'Approve?', state: 'review text', options: verdictOpts }));
    const extra = facts === undefined ? [] : ['--facts', join(dir, 'facts.json')];
    if (facts !== undefined) writeFileSync(join(dir, 'facts.json'), JSON.stringify(facts));
    const r = spawnSync('node', [DECIDE, 'ask', '--decider', decider(), '--question', join(dir, 'q.json'), '--threshold', '0.8', '--record-dir', join(dir, 'decisions'), ...extra], { encoding: 'utf8' });
    const out = JSON.parse(r.stdout);
    return { out, record: JSON.parse(readFileSync(out.record, 'utf8')) };
  };

  it('T-101 DEC-051: with --facts a rule settles it: the decider gets 0 calls, the record says decider "rule" and the rule', () => {
    const { out, record } = ask({ verdict: 'approved', findings: [] });
    expect(calls()).toBe(0);
    expect(out).toMatchObject({ action: 'proceed', answer: 'approved', confidence: 1, rule: 'review_approved_without_findings' });
    expect(record).toMatchObject({ question_id: 'review_verdict', answer: 'approved', action: 'proceed', decider: 'rule', rule: 'review_approved_without_findings', facts: { verdict: 'approved' } });
  });

  it('T-101 DEC-051: an ambiguous case still goes to the decider (1 call), as before', () => {
    const { out, record } = ask({ verdict: 'approved', findings: ['REQ-001: sin prueba'] });
    expect(calls()).toBe(1);
    expect(out).toMatchObject({ action: 'proceed', answer: 'rejected', confidence: 0.9 });
    expect(out.rule).toBe(undefined);
    expect(record.decider).toContain('decider.sh');
  });

  it('T-101 DEC-051: without --facts, or with unreadable facts, the decider is asked', () => {
    ask();
    writeFileSync(join(dir, 'facts.json'), 'not json');
    writeFileSync(join(dir, 'q.json'), JSON.stringify({ id: 'review_verdict', instructions: 'Approve?', state: 's', options: verdictOpts }));
    spawnSync('node', [DECIDE, 'ask', '--decider', decider(), '--question', join(dir, 'q.json'), '--threshold', '0.8', '--record-dir', join(dir, 'decisions'), '--facts', join(dir, 'facts.json')], { encoding: 'utf8' });
    expect(calls()).toBe(2);
  });
});

describe('Jev adapter (scripts/agents/decider/jev.sh): translates only', () => {
  // a curl double: records its arguments and the request body, answers with $FAKE_RESPONSE and $FAKE_STATUS
  const fakeCurl = () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
for a in "$@"; do case "$a" in @/*) printf 'FILE:%s\\n' "$(cat "\${a#@}")" ;; *) printf '%s\\n' "$a" ;; esac; done > ${join(dir, 'curl-args.txt')}
prev=""; for a in "$@"; do [ "$prev" = "--data-binary" ] && [ "$a" = "@-" ] && cat > ${join(dir, 'curl-body.json')}; prev=$a; done
printf '%s\\n%s' "\${FAKE_RESPONSE:-}" "\${FAKE_STATUS:-200}"
`);
    chmodSync(join(bin, 'curl'), 0o755);
    return bin;
  };
  const run = (env) => spawnSync('bash', [JEV], { input: JSON.stringify(question), encoding: 'utf8', env: { ...process.env, PATH: `${fakeCurl()}:${process.env.PATH}`, ...env } });
  const ok = JSON.stringify({ model: 'jev-1.13.0', answers: { failure_cause: { type: 'choice', choice: 'design', confidence: 0.82, probabilities: { implementation: 0.1, environment: 0.05, design: 0.85 } } }, usage: { input_tokens: 90, output_tokens: 4 } });

  it('sends one choice question to the TypeSafe API and normalizes its answer', () => {
    const r = run({ TYPESAFE_API_KEY: 'k-test', FAKE_RESPONSE: ok });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ answer: 'design', confidence: 0.82, probabilities: { implementation: 0.1, environment: 0.05, design: 0.85 }, usage: { input_tokens: 90, output_tokens: 4 }, model: 'jev-1.13.0' });
    const args = readFileSync(join(dir, 'curl-args.txt'), 'utf8');
    expect(args).toContain('https://api.typesafe.ai/v1/systemone');
    expect(args).toContain('FILE:Authorization: Bearer k-test'); // read from a file descriptor
    expect(args.split('\n').some((l) => l.includes('k-test') && !l.startsWith('FILE:'))).toBe(false); // never in argv
    expect(JSON.parse(readFileSync(join(dir, 'curl-body.json'), 'utf8'))).toEqual({
      model: 'jev-1.13.0', state: question.state,
      questions: { failure_cause: { type: 'choice', instructions: question.instructions, criteria: question.options } },
    });
  });

  it('no API key, an HTTP error or an answer without the question → exit 1 with the reason', () => {
    expect(run({ TYPESAFE_API_KEY: '' })).toMatchObject({ status: 1, stderr: expect.stringContaining('TYPESAFE_API_KEY is not set') });
    expect(run({ TYPESAFE_API_KEY: 'k', FAKE_RESPONSE: '{"detail":[{"msg":"Field required"}]}', FAKE_STATUS: '422' })).toMatchObject({ status: 1, stderr: expect.stringContaining('HTTP 422') });
    expect(run({ TYPESAFE_API_KEY: 'k', FAKE_RESPONSE: '{"answers":{}}' })).toMatchObject({ status: 1 });
  });

  it('asks for the pinned version, never the alias, and returns the model that answered; JEV_MODEL moves it (DEC-025, T-56)', () => {
    const r = run({ TYPESAFE_API_KEY: 'k', FAKE_RESPONSE: ok.replace('jev-1.13.0', 'jev-1.14.2') });
    expect(JSON.parse(readFileSync(join(dir, 'curl-body.json'), 'utf8')).model).toBe('jev-1.13.0');
    expect(JSON.parse(r.stdout).model).toBe('jev-1.14.2'); // what the API says answered, as is
    run({ TYPESAFE_API_KEY: 'k', FAKE_RESPONSE: ok, JEV_MODEL: 'jev-1.14.2' });
    expect(JSON.parse(readFileSync(join(dir, 'curl-body.json'), 'utf8')).model).toBe('jev-1.14.2');
    expect(readFileSync(JEV, 'utf8')).not.toMatch(/JEV_MODEL:-jev-latest/);
  });

  it('every decision record keeps the model that answered (response.model), or null if the decider gives none (T-56)', () => {
    writeFileSync(join(dir, 'q.json'), JSON.stringify(question));
    const r = spawnSync('node', [DECIDE, 'ask', '--decider', JEV, '--question', join(dir, 'q.json'), '--threshold', '0.8', '--record-dir', join(dir, 'decisions')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${fakeCurl()}:${process.env.PATH}`, TYPESAFE_API_KEY: 'k', FAKE_RESPONSE: ok },
    });
    expect(JSON.parse(readFileSync(JSON.parse(r.stdout).record, 'utf8'))).toMatchObject({ model: 'jev-1.13.0', answer: 'design' });
    const other = join(dir, 'plain.sh');
    writeFileSync(other, '#!/usr/bin/env bash\ncat >/dev/null\necho \'{"answer":"design","confidence":0.9}\'\n');
    const r2 = spawnSync('node', [DECIDE, 'ask', '--decider', other, '--question', join(dir, 'q.json'), '--threshold', '0.8', '--record-dir', join(dir, 'decisions2')], { encoding: 'utf8' });
    expect(JSON.parse(readFileSync(JSON.parse(r2.stdout).record, 'utf8')).model).toBe(null);
  });

  it('is reached through the port: decide.mjs ask with the Jev adapter', () => {
    writeFileSync(join(dir, 'q.json'), JSON.stringify(question));
    const r = spawnSync('node', [DECIDE, 'ask', '--decider', JEV, '--question', join(dir, 'q.json'), '--threshold', '0.8', '--record-dir', join(dir, 'decisions')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${fakeCurl()}:${process.env.PATH}`, TYPESAFE_API_KEY: 'k', FAKE_RESPONSE: ok },
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'proceed', answer: 'design', confidence: 0.82 });
  });
});
