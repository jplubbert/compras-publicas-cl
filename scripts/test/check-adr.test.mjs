import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';

// check-adr (DEC-035 points 3 to 5, T-68): every accepted ADR has a valid Enforced-by, the existing violations live in
// a frozen baseline that only shrinks, an accepted ADR's body never changes (only its Estado, to superseded by NNNN)
// and the generated index is up to date. Acceptance tests on temporary repositories.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CHECK = join(REPO, 'scripts/check-adr.mjs');
const ADR = join(REPO, 'scripts/adr.mjs');
const SPEC_FIXTURE = join(REPO, 'scripts/test/fixtures/spec');
let root;
const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', ...a], { encoding: 'utf8' });
const check = (...a) => spawnSync('node', [CHECK, '--root', root, ...a], { encoding: 'utf8' });
const adrFile = (n) => join(root, 'spec/adr', readdirSync(join(root, 'spec/adr')).find((f) => f.startsWith(n)));
const setField = (n, name, value) => {
  const f = adrFile(n);
  const t = readFileSync(f, 'utf8');
  const re = new RegExp(`^- ${name}: .*\\n`, 'm');
  writeFileSync(f, value === null ? t.replace(re, '') : re.test(t) ? t.replace(re, `- ${name}: ${value}\n`) : t.replace(/^- Aprobador: .*\n/m, (m) => `${m}- ${name}: ${value}\n`));
};
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '--no-verify', '-m', `${msg}\n\nTask: none\nReq: none`); };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-adr-'));
  cpSync(SPEC_FIXTURE, join(root, 'spec'), { recursive: true });
  mkdirSync(join(root, 'scripts/test'), { recursive: true });
  writeFileSync(join(root, 'scripts/test/d.test.mjs'), "it('five holds (DEC-005)', () => {});\nit('six holds (DEC-006)', () => {});\n");
  git('init', '-q');
  commit('base');
  spawnSync('node', [ADR, '--root', root, 'migrate', '--ids', 'DEC-005,DEC-006'], { encoding: 'utf8' });
  commit('migrate');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('check-adr (DEC-035, T-68)', () => {
  it('passes with every accepted ADR enforced and the index up to date', () => {
    expect(check()).toMatchObject({ status: 0, stdout: expect.stringContaining('check-adr: ok') });
  });

  it('fails if an accepted ADR has no Enforced-by, points to a missing file, or to a test name that is not there', () => {
    setField('0005', 'Enforced-by', null);
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: accepted without Enforced-by') });
    setField('0005', 'Enforced-by', 'scripts/test/nope.test.mjs#DEC-005');
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: Enforced-by scripts/test/nope.test.mjs does not exist') });
    setField('0005', 'Enforced-by', 'scripts/test/d.test.mjs#DEC-099');
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: no test name in scripts/test/d.test.mjs cites DEC-099') });
  });

  it('cmd: runs the command and fails if it fails; manual: needs a reason', () => {
    setField('0005', 'Enforced-by', 'cmd: false');
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: its check `false` failed') });
    setField('0005', 'Enforced-by', 'cmd: true');
    expect(check().status).toBe(0);
    setField('0005', 'Enforced-by', 'manual:');
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: manual Enforced-by needs a reason') });
    setField('0005', 'Enforced-by', 'manual: se revisa en cada revisión de diseño');
    expect(check().status).toBe(0);
  });

  it('with --run it runs the referenced tests too, and fails if they fail', () => {
    writeFileSync(join(root, 'scripts/test/d.test.mjs'), "import { it } from 'node:test';\nit('five holds (DEC-005)', () => { throw new Error('no'); });\nit('six holds (DEC-006)', () => {});\n");
    expect(check().status).toBe(0); // static: npm test runs those tests
    expect(check('--run')).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: its check scripts/test/d.test.mjs#DEC-005 failed') });
  });

  it('a violation in the frozen baseline passes; the baseline may only shrink', () => {
    setField('0005', 'Enforced-by', null);
    writeFileSync(join(root, 'spec/adr/baseline.json'), `${JSON.stringify({ violations: ['DEC-005: accepted without Enforced-by'] }, null, 2)}\n`);
    commit('baseline');
    expect(check().status).toBe(0);
    setField('0006', 'Enforced-by', null);
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-006: accepted without Enforced-by') });
    writeFileSync(join(root, 'spec/adr/baseline.json'), `${JSON.stringify({ violations: ['DEC-005: accepted without Enforced-by', 'DEC-006: accepted without Enforced-by'] }, null, 2)}\n`);
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('spec/adr/baseline.json may only shrink: DEC-006: accepted without Enforced-by is new') });
  });

  it('an accepted ADR is immutable: a changed body fails, committed or not; only its Estado may become superseded by an existing NNNN', () => {
    const f = adrFile('0005');
    writeFileSync(f, `${readFileSync(f, 'utf8')}Una línea más.\n`);
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: the body of an accepted ADR changed (working tree)') });
    commit('edit');
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('the body of an accepted ADR changed (commit') });
    git('reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(f, readFileSync(f, 'utf8').replace('- Estado: accepted', '- Estado: superseded by 0006'));
    spawnSync('node', [ADR, '--root', root, 'index']);
    commit('supersede');
    expect(check().status).toBe(0);
    writeFileSync(f, readFileSync(f, 'utf8').replace('superseded by 0006', 'superseded by 0099'));
    spawnSync('node', [ADR, '--root', root, 'index']);
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-005: superseded by 0099, which is not an ADR') });
  });

  it('fails if the generated index is out of date', () => {
    const p = join(root, 'spec/DECISIONS.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('| DEC-007 |', '| DEC-007 (stale) |'));
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('the index of spec/DECISIONS.md is out of date') });
  });

  it('the Enforced-by line of an accepted ADR may change (that is how a baseline violation is fixed)', () => {
    setField('0005', 'Enforced-by', 'manual: se revisa a mano');
    commit('enforce');
    expect(check().status).toBe(0);
  });

  const newAdr = (opts) => {
    const r = spawnSync('node', [ADR, '--root', root, 'new', 'Cache compartida'], { encoding: 'utf8' });
    const f = join(root, r.stdout.trim());
    const t = readFileSync(f, 'utf8');
    const options = opts.map((o, i) => `### ${i + 1}. ${o.name}\n- A favor: ${o.pro}\n- En contra: ${o.con}`).join('\n\n');
    writeFileSync(f, t.replace(/## Opciones consideradas\n[\s\S]*?(?=\n## Decisión)/, `## Opciones consideradas\n\n${options}\n`)
      .replace(/^- Módulos: .*\n/m, '').replace(/^- Enforced-by: .*$/m, '- Enforced-by: manual: prueba'));
    spawnSync('node', [ADR, '--root', root, 'index']);
    return f;
  };
  const real = [{ name: 'A', pro: 'rápida.', con: 'cara.' }, { name: 'B', pro: 'barata.', con: 'lenta.' }];

  it('a new ADR is born proposed: one committed as accepted fails (DEC-036, T-71)', () => {
    const f = newAdr(real);
    writeFileSync(f, readFileSync(f, 'utf8').replace('- Estado: proposed', '- Estado: accepted'));
    commit('born accepted');
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-008: a new ADR is born proposed (DEC-036)') });
  });

  it('a new ADR may only be accepted with at least two options with their pros and cons; the migrated ones are exempt (DEC-036, T-71)', () => {
    const f = newAdr([{ name: 'A', pro: 'rápida.', con: 'cara.' }, { name: 'B', pro: 'no registradas.', con: 'lenta.' }]);
    commit('proposed');
    writeFileSync(f, readFileSync(f, 'utf8').replace('- Estado: proposed', '- Estado: accepted'));
    spawnSync('node', [ADR, '--root', root, 'index']);
    commit('accepted');
    expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining('DEC-008: accepted with fewer than two options with their pros and cons (DEC-036)') });
    git('reset', '-q', '--hard', 'HEAD~2');
    const g = newAdr(real);
    commit('proposed');
    writeFileSync(g, readFileSync(g, 'utf8').replace('- Estado: proposed', '- Estado: accepted'));
    spawnSync('node', [ADR, '--root', root, 'index']);
    commit('accepted');
    expect(check()).toMatchObject({ status: 0 }); // DEC-005 and DEC-006, migrated without options, stay exempt
  });

  it('adr accept refuses, without asking the decider, an ADR with fewer than two such options (DEC-036, T-71)', () => {
    newAdr([{ name: 'A', pro: 'rápida.', con: 'cara.' }]);
    commit('proposed');
    const asked = join(root, '..', `${root.split('/').pop()}-asked`);
    const decider = join(root, '..', `${root.split('/').pop()}-d.sh`);
    writeFileSync(decider, `#!/usr/bin/env bash\ntouch ${asked}\necho '{"answer":"accept","confidence":0.99}'\n`);
    const r = spawnSync('node', [ADR, '--root', root, 'accept', '0008', '--decider', decider], { encoding: 'utf8' });
    expect(r).toMatchObject({ status: 1, stderr: expect.stringContaining('0008 needs at least two options with their pros and cons before it is accepted') });
    expect(existsSync(asked)).toBe(false);
  });

  it('the Módulos line of an accepted ADR may change; each value must be an existing file, not a folder, README.md or AGENTS.md (DEC-042, T-75)', () => {
    setField('0005', 'Módulos', 'scripts/test/d.test.mjs');
    commit('narrow');
    expect(check().status).toBe(0);
    for (const bad of ['scripts/test/', 'README.md', 'AGENTS.md', 'scripts/nope.mjs']) {
      setField('0005', 'Módulos', `scripts/test/d.test.mjs, ${bad}`);
      expect(check()).toMatchObject({ status: 1, stderr: expect.stringContaining(`DEC-005: Módulos ${bad} must be an existing file (not a folder, README.md or AGENTS.md; DEC-042)`) });
    }
  });

  it('the real repository passes', () => {
    const r = spawnSync('node', [CHECK], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
