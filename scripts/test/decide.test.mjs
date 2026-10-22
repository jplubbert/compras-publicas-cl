import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { mapAnswer } from '../lib/decide.mjs';

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
