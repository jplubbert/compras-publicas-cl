import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from '../../test/expect.mjs';

// Live check of the Jev adapter against the TypeSafe API (verify_integration of T-33). Run it through jev-smoke.sh,
// which loads the key; it is outside scripts/test/ so `npm test` never calls the API.
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'jev-smoke-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const options = { network: 'the machine could not reach the network', code: "the program's code has a bug" };
const question = { id: 'smoke', instructions: 'Why did this command fail?', options,
  state: { error: 'npm ERR! code ENOTFOUND registry.npmjs.org: getaddrinfo failed (no network)' } };

describe('Jev adapter, live (TypeSafe API)', () => {
  it('answers within the options with a confidence and probabilities (the API contract the adapter relies on)', () => {
    const r = spawnSync('bash', [join(REPO, 'scripts/agents/decider/jev.sh')], { input: JSON.stringify(question), encoding: 'utf8' });
    expect(r.status).toBe(0);
    const a = JSON.parse(r.stdout);
    expect(Object.keys(options)).toContain(a.answer);
    expect(typeof a.confidence).toBe('number');
    expect(Object.keys(a.probabilities).sort()).toEqual(Object.keys(options).sort());
    // DEC-025: the version that answers is the pinned one (moving it is a deliberate change, after this test)
    const pinned = process.env.JEV_MODEL ?? readFileSync(join(REPO, 'scripts/agents/decider/jev.sh'), 'utf8').match(/JEV_MODEL:-([^}]+)\}/)[1];
    expect(a.model).toBe(pinned);
  });

  it('through the port decide, an obvious question proceeds with the expected answer', () => {
    writeFileSync(join(dir, 'q.json'), JSON.stringify(question));
    const r = spawnSync('node', [join(REPO, 'scripts/lib/decide.mjs'), 'ask', '--decider', join(REPO, 'scripts/agents/decider/jev.sh'),
      '--question', join(dir, 'q.json'), '--threshold', '0.5', '--record-dir', join(dir, 'decisions')], { encoding: 'utf8' });
    console.log(`jev-smoke: ${r.stdout.trim()}`);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'proceed', answer: 'network' });
  });
});
