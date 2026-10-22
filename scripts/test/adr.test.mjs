import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { combinedDecisions, loadDecisions, parseAdr } from '../lib/adr.mjs';

// ADR (MADR) in spec/adr/ (DEC-035, T-67): the shared loader, the one-off migration of a DEC and the generated index.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const ADR = join(REPO, 'scripts/adr.mjs');
const CHECK_SPEC = join(REPO, 'scripts/check-spec.mjs');
const TASKS = join(REPO, 'scripts/lib/autopilot-tasks.mjs');
const SPEC_FIXTURE = join(REPO, 'scripts/test/fixtures/spec');
let root;
const git = (...a) => execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', ...a], { encoding: 'utf8' });
const adr = (...a) => spawnSync('node', [ADR, '--root', root, ...a], { encoding: 'utf8' });
const DEC = `## DEC-005 Investigador ante una tarea atascada
- Estado: accepted
- Alcance: global
- Fecha: 2026-10-18 · Aprobador: José Pedro Lübbert (Pepe), 2026-10-18 (en sesión) · Confianza: media
- Problema: una tarea que falla dos veces queda atascada.
- Impulsores: pedido del usuario; DEC-001
- Alternativas consideradas:
  1. Un investigador de solo lectura con topes — a favor: informe con fuentes; en contra: costo por invocación.
  2. Seguir como hoy — en contra: no atiende el pedido.
  3. Solo el orquestador del autopilot — descartada por el usuario (más lenta: nada se cierra sin corrida).
  4. Un umbral — a favor: simple.
- Decisión: Usaremos la alternativa 1:
  1. **Gatillo**: dos fallos seguidos.
  2. **Topes** de tiempo y costo.
- Consecuencias: buenas: menos tareas atascadas. Malas: costo.
- Dependencias: depende de DEC-001 · la implementa T-01
- Evidencia: corridas del 2026-10-18.
- Confirmación: pruebas con dobles del investigador.
- Revisar si: el investigador no ayuda.
`;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adr-'));
  cpSync(SPEC_FIXTURE, join(root, 'spec'), { recursive: true });
  writeFileSync(join(root, 'spec/DECISIONS.md'), `${readFileSync(join(root, 'spec/DECISIONS.md'), 'utf8').replace(/## DEC-005[\s\S]*?(?=## DEC-006)/, `${DEC}\n`)}`);
  mkdirSync(join(root, 'scripts/test'), { recursive: true });
  writeFileSync(join(root, 'scripts/test/r.test.mjs'), "it('researcher with caps (DEC-005)', () => {});\n");
  writeFileSync(join(root, 'package.json'), '{}\n'); // a touch that is a file: it may be a Módulos value (DEC-042)
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base\n\nTask: none\nReq: none');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ADR migration and loader (DEC-035, T-67)', () => {
  it('migrate turns a DEC into spec/adr/0005-<title>.md with the MADR sections, and takes it out of DECISIONS.md', () => {
    const r = adr('migrate', '--ids', 'DEC-005');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const files = readdirSync(join(root, 'spec/adr'));
    expect(files).toEqual(['0005-investigador-ante-una-tarea-atascada.md']);
    const text = readFileSync(join(root, 'spec/adr', files[0]), 'utf8');
    expect(text).toMatch(/^# DEC-005 Investigador ante una tarea atascada\n/);
    for (const h of ['## Contexto', '## Impulsores', '## Opciones consideradas', '## Decisión', '## Consecuencias', '## Confirmación', '## Más información']) expect(text).toContain(h);
    expect(text).toContain('- Estado: accepted');
    expect(text).toContain('- Fecha: 2026-10-18');
    expect(text).toContain('- Aprobador: José Pedro Lübbert (Pepe), 2026-10-18 (en sesión)');
    expect(text).toContain('### 1. Un investigador de solo lectura con topes\n- A favor: informe con fuentes.\n- En contra: costo por invocación.');
    expect(text).toContain('### 2. Seguir como hoy\n- A favor: no registradas.\n- En contra: no atiende el pedido.');
    // T-76: a con written without "en contra:" is not lost; pros without cons stay pros
    expect(text).toContain('### 3. Solo el orquestador del autopilot\n- A favor: no registradas.\n- En contra: descartada por el usuario (más lenta: nada se cierra sin corrida).');
    expect(text).toContain('### 4. Un umbral\n- A favor: simple.\n- En contra: no registradas.');
    expect(text).toContain('1. **Gatillo**: dos fallos seguidos.');
    expect(text).toContain('- Enforced-by: scripts/test/r.test.mjs#DEC-005');
    expect(text).toContain('- Módulos: package.json'); // of the touches of T-01, T-04 and T-05, only the files that exist (DEC-042)
    const decisions = readFileSync(join(root, 'spec/DECISIONS.md'), 'utf8');
    expect(decisions).not.toContain('## DEC-005');
    expect(decisions).toContain('| DEC-005 | Investigador ante una tarea atascada | accepted | [ADR](adr/0005-investigador-ante-una-tarea-atascada.md) |');
    expect(decisions).toContain('| DEC-006 |');
  });

  it('the loader reads ADRs and the reversible DECs alike; check-spec and the reviewer context see a migrated DEC', () => {
    adr('migrate', '--ids', 'DEC-005');
    const all = loadDecisions(root);
    expect(all.find((d) => d.id === 'DEC-005')).toMatchObject({ kind: 'adr', status: 'accepted', file: 'spec/adr/0005-investigador-ante-una-tarea-atascada.md' });
    expect(all.find((d) => d.id === 'DEC-006')).toMatchObject({ kind: 'reversible', status: 'accepted' });
    expect(combinedDecisions(root)).toMatch(/## DEC-005 Investigador[\s\S]*- Estado: accepted[\s\S]*### Contexto/);
    expect(spawnSync('node', [CHECK_SPEC, '--root', root], { encoding: 'utf8' })).toMatchObject({ status: 0 });
    const ctx = spawnSync('node', [TASKS, '--root', root, 'context', 'T-04'], { encoding: 'utf8' }).stdout; // T-04 cites DEC-005
    expect(ctx).toContain('## DEC-005 Investigador ante una tarea atascada');
    expect(ctx).toContain('una tarea que falla dos veces queda atascada');
  });

  it('index regenerates the table between its markers and nothing else; parseAdr reads the header fields', () => {
    adr('migrate', '--ids', 'DEC-005');
    const p = join(root, 'spec/DECISIONS.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('| DEC-006 |', '| DEC-006 (stale) |'));
    expect(adr('index').status).toBe(0);
    expect(readFileSync(p, 'utf8')).not.toContain('(stale)');
    expect(adr('index', '--check').status).toBe(0);
    writeFileSync(p, readFileSync(p, 'utf8').replace('| DEC-006 |', '| DEC-006 (stale) |'));
    expect(adr('index', '--check')).toMatchObject({ status: 1, stderr: expect.stringContaining('the index of spec/DECISIONS.md is out of date') });
    const a = parseAdr(readFileSync(join(root, 'spec/adr/0005-investigador-ante-una-tarea-atascada.md'), 'utf8'));
    expect(a).toMatchObject({ id: 'DEC-005', status: 'accepted', date: '2026-10-18', enforcedBy: 'scripts/test/r.test.mjs#DEC-005', modules: ['package.json'] });
  });

  it('spec/adr/ is allowed in spec/ (check-spec); existsSync helper', () => {
    adr('migrate', '--ids', 'DEC-005');
    expect(existsSync(join(root, 'spec/adr'))).toBe(true);
    expect(spawnSync('node', [CHECK_SPEC, '--root', root], { encoding: 'utf8' }).stdout).toContain('check:spec: ok');
  });
});

describe('new ADRs are born proposed and Jev accepts them; agents get only the decisions in force that matter (DEC-036, T-69)', () => {
  const decider = (answer) => { const f = join(root, '..', `${root.split('/').pop()}-decider.sh`); writeFileSync(f, `#!/usr/bin/env bash\ncat >/dev/null\necho '${answer}'\n`); return f; };
  const file = (n) => join(root, 'spec/adr', readdirSync(join(root, 'spec/adr')).find((f) => f.startsWith(n)));

  it('new creates the next number in proposed, with the MADR sections, and updates the index (DEC-036)', () => {
    const r = adr('new', 'Cache de compilación compartida');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('spec/adr/0008-cache-de-compilacion-compartida.md'); // the fixture goes up to DEC-007
    const t = readFileSync(join(root, r.stdout.trim()), 'utf8');
    expect(t).toMatch(/^# DEC-008 Cache de compilación compartida\n/);
    expect(t).toContain('- Estado: proposed');
    expect(t).toContain('- Aprobador: pendiente: lo acepta Jev (node scripts/adr.mjs accept 0008, DEC-036)');
    expect(readFileSync(join(root, 'spec/DECISIONS.md'), 'utf8')).toContain('| DEC-008 | Cache de compilación compartida | proposed |');
  });

  const withOptions = (n) => { const f = file(n); writeFileSync(f, readFileSync(f, 'utf8').replace(/## Opciones consideradas\n[\s\S]*?(?=\n## Decisión)/,
    '## Opciones consideradas\n\n### 1. A\n- A favor: rápida.\n- En contra: cara.\n\n### 2. B\n- A favor: barata.\n- En contra: lenta.\n')); };
  it('accept asks the decider: over the threshold it is accepted with its approver and record; under it, it stays proposed and exits 1 (DEC-036)', () => {
    adr('new', 'Cache de compilación compartida');
    withOptions('0008');
    const ok = adr('accept', '0008', '--decider', decider('{"answer":"accept","confidence":0.93,"model":"jev-1.13.0"}'));
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    const t = readFileSync(file('0008'), 'utf8');
    expect(t).toContain('- Estado: accepted');
    expect(t).toMatch(/- Aprobador: .*decider.* \(jev-1\.13\.0\), \d{4}-\d{2}-\d{2} \(registro artifacts\/decisions\/adr\/.*adr_accept\.json, confianza 0\.93\)/);
    expect(readdirSync(join(root, 'artifacts/decisions/adr')).length).toBe(1);
    adr('new', 'Otra decisión');
    withOptions('0009');
    const low = adr('accept', '0009', '--decider', decider('{"answer":"accept","confidence":0.4}'));
    expect(low).toMatchObject({ status: 1, stderr: expect.stringContaining('0009 stays proposed: confidence 0.4 < 0.8') });
    expect(readFileSync(file('0009'), 'utf8')).toContain('- Estado: proposed');
    expect(adr('accept', '0009', '--decider', decider('{"answer":"reject","confidence":0.9}')).status).toBe(0);
    expect(readFileSync(file('0009'), 'utf8')).toContain('- Estado: rejected');
    expect(adr('accept', '0008', '--decider', decider('{"answer":"accept","confidence":0.9}'))).toMatchObject({ status: 1, stderr: expect.stringContaining('only a proposed ADR') });
  });

  it('accept --by: the user accepts it by name without asking the decider, with the same conditions (T-91)', () => {
    const asked = join(root, '..', `${root.split('/').pop()}-asked`);
    const spy = join(root, '..', `${root.split('/').pop()}-spy.sh`);
    writeFileSync(spy, `#!/usr/bin/env bash\ntouch '${asked}'\necho '{"answer":"reject","confidence":0.99}'\n`);
    adr('new', 'Cache de compilación compartida');
    withOptions('0008');
    const ok = adr('accept', '0008', '--by', 'Pepe', '--reason', 'aceptado en sesión', '--decider', spy);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(existsSync(asked)).toBe(false);
    const t = readFileSync(file('0008'), 'utf8');
    expect(t).toContain('- Estado: accepted');
    expect(t).toMatch(/- Aprobador: Pepe, \d{4}-\d{2}-\d{2} \(aprobación nominal en sesión: «aceptado en sesión»\)\n/);
    expect(readFileSync(join(root, 'spec/DECISIONS.md'), 'utf8')).toContain('| DEC-008 | Cache de compilación compartida | accepted |');
    expect(existsSync(join(root, 'artifacts/decisions/adr'))).toBe(false);
    adr('new', 'Otra decisión');   // 0009 keeps the placeholder options: not two real ones
    const one = adr('accept', '0009', '--by', 'Pepe', '--decider', spy);
    expect(one).toMatchObject({ status: 1, stderr: expect.stringContaining('needs at least two options') });
    expect(readFileSync(file('0009'), 'utf8')).toContain('- Estado: proposed');
    expect(adr('accept', '0008', '--by', 'Pepe', '--decider', spy)).toMatchObject({ status: 1, stderr: expect.stringContaining('only a proposed ADR') });
    expect(existsSync(asked)).toBe(false);
    rmSync(spy, { force: true });
  });

  it('select: the decisions the task cites, the most recent in force and those whose Módulos cross its touches; never superseded or proposed (DEC-036)', () => {
    adr('migrate', '--ids', 'DEC-001,DEC-002,DEC-005');
    const set = (n, a, b) => writeFileSync(file(n), readFileSync(file(n), 'utf8').replace(a, b));
    set('0001', /- Módulos: .*/, '- Módulos: docs/');
    set('0001', /- Fecha: .*/, '- Fecha: 2026-12-01');
    set('0002', /- Módulos: .*/, '- Módulos: app/src/orders/x.ts');
    set('0002', /- Fecha: .*/, '- Fecha: 2026-01-01');
    set('0005', /- Módulos: .*/, '- Módulos: docs/');
    const sel = (...a) => JSON.parse(adr('select', '--task', 'T-04', ...a).stdout); // T-04: DEC-005, DEC-006; touches app/src/orders/
    expect(sel('--recent', '0').map((d) => `${d.id}:${d.why.join('+')}`)).toEqual(['DEC-002:module', 'DEC-005:cited', 'DEC-006:cited']);
    expect(sel('--recent', '1').find((d) => d.id === 'DEC-001')?.why).toEqual(['recent']);
    expect(sel('--recent', '0').find((d) => d.id === 'DEC-006')).toMatchObject({ kind: 'reversible', file: 'spec/DECISIONS.md' });
    set('0002', '- Estado: accepted', '- Estado: superseded by 0005');
    expect(sel('--recent', '0').map((d) => d.id)).toEqual(['DEC-005', 'DEC-006']);
    expect(adr('select', '--task', 'T-04', '--recent', '0', '--files').stdout.trim().split('\n')).toEqual(['spec/adr/0005-investigador-ante-una-tarea-atascada.md', 'spec/DECISIONS.md']);
  });
});

describe('supersede NNNN --by MMMM changes only the Estado line of an accepted ADR (DEC-035, T-104)', () => {
  const file = (n) => join(root, 'spec/adr', readdirSync(join(root, 'spec/adr')).find((f) => f.startsWith(n)));
  const checkAdr = () => spawnSync('node', [join(REPO, 'scripts/check-adr.mjs'), '--root', root], { encoding: 'utf8' });
  const commit = (m) => { git('add', '-A'); git('commit', '-q', '-m', `${m}\n\nTask: none\nReq: none`); };
  beforeEach(() => {
    adr('migrate', '--ids', 'DEC-005');
    commit('migrate');
    for (const t of ['Reemplazo', 'Pendiente']) adr('new', t);   // 0008, 0009 (proposed)
    for (const n of ['0008', '0009']) {
      writeFileSync(file(n), readFileSync(file(n), 'utf8')
        .replace(/- Módulos: .*\n/, '').replace(/- Enforced-by: .*/, '- Enforced-by: manual: a person reads it')
        .replace(/## Opciones consideradas\n[\s\S]*?(?=\n## Decisión)/, '## Opciones consideradas\n\n### 1. A\n- A favor: rápida.\n- En contra: cara.\n\n### 2. B\n- A favor: barata.\n- En contra: lenta.\n'));
    }
    commit('new');
    adr('accept', '0008', '--by', 'Pepe');
    commit('accept');
  });

  it('an accepted ADR becomes "superseded by MMMM", nothing else changes, the index follows and check-adr passes (T-104)', () => {
    const before = readFileSync(file('0005'), 'utf8');
    const r = adr('supersede', '0005', '--by', '0008');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(file('0005'), 'utf8')).toBe(before.replace('- Estado: accepted', '- Estado: superseded by 0008'));
    expect(readFileSync(join(root, 'spec/DECISIONS.md'), 'utf8')).toContain('| DEC-005 | Investigador ante una tarea atascada | superseded by 0008 |');
    expect(adr('index', '--check').status).toBe(0);
    commit('supersede');
    expect(checkAdr()).toMatchObject({ status: 0, stdout: expect.stringContaining('check-adr: ok') });
  });

  it('rejects a proposed or already superseded ADR, a proposed or missing replacement, itself and bad arguments (T-104)', () => {
    const untouched = () => ['0005', '0008', '0009'].map((n) => readFileSync(file(n), 'utf8')).join('\n');
    const start = untouched();
    const fails = (args, msg) => expect(adr('supersede', ...args)).toMatchObject({ status: 1, stderr: expect.stringContaining(msg) });
    fails(['0009', '--by', '0008'], '0009 is proposed: only an accepted ADR is superseded');
    fails(['0005', '--by', '0009'], '0009 is proposed: an ADR is superseded only by an accepted one');
    fails(['0005', '--by', '0005'], '0005 cannot supersede itself');
    fails(['0005', '--by', '0042'], 'no ADR 0042');
    fails(['0042', '--by', '0008'], 'no ADR 0042');
    expect(adr('supersede', '0005').status).toBe(2);
    expect(adr('supersede', '5', '--by', '0008').status).toBe(2);
    expect(untouched()).toBe(start);
    expect(adr('supersede', '0005', '--by', '0008').status).toBe(0);
    fails(['0005', '--by', '0008'], '0005 is superseded by 0008: only an accepted ADR is superseded');
    fails(['0008', '--by', '0005'], '0005 is superseded by 0008: an ADR is superseded only by an accepted one');   // it would leave a cycle
  });
});

describe('select follows the chain of replacements (DEC-036, T-72)', () => {
  // sdd-base's own spec (T-27, ADRs 0011 and 0039); a project made with bootstrap has neither, so there it is skipped
  const ownSpec = existsSync(join(REPO, 'spec/adr')) && readdirSync(join(REPO, 'spec/adr')).some((f) => f.startsWith('0039-'));
  it('T-27 cites DEC-011; with 0011 superseded by 0039 (accepted), it gets 0039 even with AUTOPILOT_ADR_RECENT=0', { skip: !ownSpec }, () => {
    cpSync(join(REPO, 'spec'), join(root, 'spec'), { recursive: true, force: true });
    const f = (n) => join(root, 'spec/adr', readdirSync(join(root, 'spec/adr')).find((x) => x.startsWith(n)));
    writeFileSync(f('0011'), readFileSync(f('0011'), 'utf8').replace('- Estado: accepted', '- Estado: superseded by 0039'));
    writeFileSync(f('0039'), readFileSync(f('0039'), 'utf8').replace('- Estado: proposed', '- Estado: accepted'));
    const sel = JSON.parse(adr('select', '--task', 'T-27', '--recent', '0').stdout);
    expect(sel.find((d) => d.id === 'DEC-039')).toMatchObject({ kind: 'adr', why: ['cited (replaces DEC-011)'] });
    expect(sel.some((d) => d.id === 'DEC-011')).toBe(false);
  });

  it('a chain of two replacements ends at the one in force; a chain that ends in a proposed ADR gives nothing for that citation', () => {
    adr('migrate', '--ids', 'DEC-005,DEC-006');
    const f = (n) => join(root, 'spec/adr', readdirSync(join(root, 'spec/adr')).find((x) => x.startsWith(n)));
    for (const t of ['Primera', 'Segunda']) adr('new', t);   // 0008, 0009
    writeFileSync(f('0005'), readFileSync(f('0005'), 'utf8').replace('- Estado: accepted', '- Estado: superseded by 0008'));
    writeFileSync(f('0008'), readFileSync(f('0008'), 'utf8').replace('- Estado: proposed', '- Estado: superseded by DEC-009'));
    const sel = () => JSON.parse(adr('select', '--task', 'T-04', '--recent', '0').stdout).map((d) => d.id); // T-04 cites DEC-005, DEC-006
    expect(sel()).toEqual(['DEC-006']); // 0009 is still proposed
    writeFileSync(f('0009'), readFileSync(f('0009'), 'utf8').replace('- Estado: proposed', '- Estado: accepted'));
    expect(sel()).toEqual(['DEC-006', 'DEC-009']);
  });
});

