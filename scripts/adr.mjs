#!/usr/bin/env node
// ADR (MADR) in spec/adr/ (DEC-035): migration of DECs and the generated index of spec/DECISIONS.md.
//
//   node scripts/adr.mjs [--root DIR] migrate --ids DEC-001,DEC-004,…
//       turns each DEC of spec/DECISIONS.md into spec/adr/NNNN-<title>.md (MADR: Contexto, Impulsores, Opciones
//       consideradas with the pros and cons of each, or "no registradas", Decisión, Consecuencias, Confirmación, Más
//       información), takes it out of DECISIONS.md and regenerates the index. Enforced-by: the test file whose test
//       names cite the DEC the most (`<file>#DEC-NNN`), if any. Módulos: the touches of the tasks that cite it.
//   node scripts/adr.mjs [--root DIR] new "<title>"
//       DEC-036: a new ADR (the next number) in proposed, with the MADR sections to fill in; prints its path.
//   node scripts/adr.mjs [--root DIR] accept NNNN [--decider ADAPTER] [--threshold N]
//       DEC-036: asks the decider (port decide, adr_accept: accept | reject) about a proposed ADR. Over the threshold
//       (AUTOPILOT_DECIDE_THRESHOLD_ADR_ACCEPT, 0.8) it becomes accepted or rejected, with the decider and its record
//       (artifacts/decisions/adr/) as Aprobador; under it, or on an error, it stays proposed and exits 1 (the user).
//   node scripts/adr.mjs [--root DIR] accept NNNN --by <name> [--reason "<quote>"]
//       T-91: the user accepted it by name in session: the decider is not asked; same conditions (proposed, at least
//       two options with pros and cons); Aprobador "<name>, <date> (aprobación nominal en sesión[: «<quote>»])".
//       An agent uses --by only with the name of the user who approved it in session (DEC-032), never its own.
//   node scripts/adr.mjs [--root DIR] select --task T-NN [--recent N] [--files]
//       DEC-036: the decisions in force an agent of the task gets: the ones it cites, the N (AUTOPILOT_ADR_RECENT, 5)
//       most recent accepted ADRs and the accepted ADRs whose Módulos cross its touches; JSON [{id, kind, file, why}],
//       or with --files the distinct files, one per line.
//   node scripts/adr.mjs [--root DIR] index [--check]
//       rewrites the generated index of spec/DECISIONS.md (between its markers; they are added if missing);
//       --check only compares and exits 1 if it is out of date.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADR_DIR, DECISIONS_FILE, INDEX_END, INDEX_START, loadDecisions, realOptions, renderIndex, select } from './lib/adr.mjs';

const today = () => new Date().toISOString().slice(0, 10);

/** "Investigador ante una tarea atascada" → "investigador-ante-una-tarea-atascada" (ASCII, at most ~60 characters). */
export function slug(title) {
  const s = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= 60) return s;
  const cut = s.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf('-') > 20 ? cut.lastIndexOf('-') : 60);
}

/** The fields of a DEC section: top-level "- Name: value" bullets, with their indented continuation lines. */
function decFields(text) {
  const fields = [];
  for (const line of text.split('\n').slice(1)) {
    const m = /^- ([^:]+):\s?(.*)$/.exec(line);
    if (m) { fields.push({ name: m[1].trim(), value: m[2] }); continue; }
    if (fields.length && /^\s{2,}\S/.test(line)) fields.at(-1).value += `\n${line.replace(/^ {2}/, '')}`;
    else if (fields.length && line.trim() === '') fields.at(-1).value += '\n';
  }
  for (const f of fields) f.value = f.value.replace(/\n+$/, '');
  return fields;
}
const sentence = (s) => { const t = s.trim().replace(/[;.]+$/, ''); return t ? `${t}.` : 'no registradas.'; };

/** The options of "Alternativas consideradas": name, pros and cons (or "no registradas"). */
function options(value) {
  const items = [];
  for (const line of value.split('\n')) {
    const m = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (m) items.push({ n: m[1], text: m[2] });
    else if (items.length && line.trim()) items.at(-1).text += ` ${line.trim()}`;
  }
  return items.map(({ n, text }) => {
    const i = text.indexOf(' — ');
    const name = (i < 0 ? text : text.slice(0, i)).trim();
    const rest = i < 0 ? '' : text.slice(i + 3);
    const pros = (/a favor:\s*(.*?)(?:;\s*en contra:|$)/i.exec(rest) ?? [])[1] ?? '';
    let cons = (/en contra:\s*(.*)$/i.exec(rest) ?? [])[1] ?? '';
    // T-76: text after " — " with neither "a favor:" nor "en contra:" (e.g. "descartada por el usuario (…)") is its con
    if (!cons && rest.trim() && !/a favor:/i.test(rest)) cons = rest;
    return `### ${n}. ${name}\n- A favor: ${pros.trim() ? sentence(pros) : 'no registradas.'}\n- En contra: ${cons.trim() ? sentence(cons) : 'no registradas.'}`;
  });
}

function listTests(root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (f === 'node_modules' || f === 'fixtures') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.test\.(mjs|cjs|js|ts)$/.test(f)) out.push(p);
    }
  };
  walk(join(root, 'scripts'));
  walk(join(root, 'tests'));
  return out;
}
/** The test file whose test names cite `id` the most → "<file>#<id>", or null. */
export function enforcedBy(root, id) {
  const re = new RegExp(`(?:it|describe)\\(\\s*(['"\`])(?:(?!\\1).)*\\b${id}\\b`, 'g');
  let best = null;
  for (const f of listTests(root)) {
    const n = (readFileSync(f, 'utf8').match(re) ?? []).length;
    if (n > 0 && (!best || n > best.n)) best = { f, n };
  }
  return best ? `${relative(root, best.f)}#${id}` : null;
}
const segs = (p) => p.replace(/\/$/, '').split('/');
/** The touches of the tasks that cite `id`, without those another one covers. */
export function modules(root, id) {
  let tasks = [];
  try { tasks = JSON.parse(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).tasks; } catch { /* no tasks */ }
  const all = [...new Set(tasks.filter((t) => (t.decisions ?? []).includes(id)).flatMap((t) => t.touches ?? []))];
  const covered = (p, q) => p !== q && q.endsWith('/') && segs(q).every((s, i) => segs(p)[i] === s);
  // DEC-042: only touches that are existing files (no folders, README.md or AGENTS.md)
  const file = (p) => !p.endsWith('/') && !['README.md', 'AGENTS.md'].includes(p.split('/').pop()) && existsSync(join(root, p)) && statSync(join(root, p)).isFile();
  return all.filter((p) => !all.some((q) => covered(p, q))).filter(file).sort();
}

function toMadr(root, dec) {
  const f = Object.fromEntries(decFields(dec.text).map((x) => [x.name, x.value]));
  const [fecha, ...meta] = (f.Fecha ?? '').split('·').map((s) => s.trim());
  const approver = (meta.find((m) => m.startsWith('Aprobador:')) ?? '').replace(/^Aprobador:\s*/, '');
  const confidence = (meta.find((m) => m.startsWith('Confianza:')) ?? '').replace(/^Confianza:\s*/, '');
  const known = ['Estado', 'Alcance', 'Fecha', 'Problema', 'Impulsores', 'Alternativas consideradas', 'Decisión', 'Consecuencias',
    'Dependencias', 'Evidencia', 'Confirmación', 'Revisar si'];
  const extra = Object.entries(f).filter(([k]) => !known.includes(k)).map(([k, v]) => `- ${k}: ${v}`);
  const enforced = enforcedBy(root, dec.id);
  const mods = modules(root, dec.id);
  const opts = f['Alternativas consideradas'] ? options(f['Alternativas consideradas']) : [];
  return [
    `# ${dec.id} ${dec.title}`, '',
    `- Estado: ${f.Estado ?? 'proposed'}`,
    `- Fecha: ${fecha || 'no registrada'}`,
    `- Aprobador: ${approver || 'no registrado'}`,
    ...(mods.length ? [`- Módulos: ${mods.join(', ')}`] : []),
    ...(enforced ? [`- Enforced-by: ${enforced}`] : []),
    '', '## Contexto', '', f.Problema ?? 'no registrado.',
    '', '## Impulsores', '', f.Impulsores ?? 'no registrados.',
    '', '## Opciones consideradas', '', ...(opts.length ? opts.join('\n\n').split('\n') : ['no registradas.']),
    '', '## Decisión', '', f['Decisión'] ?? 'no registrada.',
    '', '## Consecuencias', '', f.Consecuencias ?? 'no registradas.',
    '', '## Confirmación', '', f['Confirmación'] ?? 'no registrada.',
    '', '## Más información', '',
    `- Alcance: ${f.Alcance ?? 'no registrado'}`,
    ...(confidence ? [`- Confianza: ${confidence}`] : []),
    `- Dependencias: ${f.Dependencias ?? 'no registradas'}`,
    `- Evidencia: ${f.Evidencia ?? 'no registrada'}`,
    `- Revisar si: ${f['Revisar si'] ?? 'no registrado'}`,
    ...extra,
    `- Migrado de spec/DECISIONS.md el ${today()} (DEC-035).`, '',
  ].join('\n');
}

const REVERSIBLE_HEADING = '## Decisiones reversibles (no migradas a ADR, DEC-035)';
/** DECISIONS.md with its generated index up to date (markers added after the preamble if missing). */
export function withIndex(root, text) {
  const index = renderIndex(loadDecisions(root));
  if (text.includes(INDEX_START) && text.includes(INDEX_END)) {
    return text.slice(0, text.indexOf(INDEX_START)) + index + text.slice(text.indexOf(INDEX_END) + INDEX_END.length);
  }
  const first = text.search(/^## DEC-/m);
  const head = first < 0 ? text.replace(/\n*$/, '\n\n') : text.slice(0, first);
  const rest = first < 0 ? '' : text.slice(first);
  return `${head}${index}\n\n${rest ? `${REVERSIBLE_HEADING}\n\n${rest}` : ''}`;
}

function migrate(root, ids) {
  const path = join(root, DECISIONS_FILE);
  let text = readFileSync(path, 'utf8');
  const decs = loadDecisions(root).filter((d) => d.kind === 'reversible');
  mkdirSync(join(root, ADR_DIR), { recursive: true });
  for (const id of ids) {
    const dec = decs.find((d) => d.id === id);
    if (!dec) throw new Error(`${id} is not a DEC of ${DECISIONS_FILE}`);
    const file = `${ADR_DIR}/${String(dec.num).padStart(4, '0')}-${slug(dec.title)}.md`;
    writeFileSync(join(root, file), toMadr(root, dec));
    const start = text.indexOf(dec.text.split('\n')[0]);
    const next = text.slice(start + 1).search(/^## /m);
    text = next < 0 ? text.slice(0, start) : text.slice(0, start) + text.slice(start + 1 + next);
    writeFileSync(path, text);
  }
  writeFileSync(path, withIndex(root, text).replace(/\n{3,}/g, '\n\n'));
}

function newAdr(root, title) {
  const num = Math.max(0, ...loadDecisions(root).map((d) => d.num)) + 1;
  const nnnn = String(num).padStart(4, '0');
  const file = `${ADR_DIR}/${nnnn}-${slug(title)}.md`;
  mkdirSync(join(root, ADR_DIR), { recursive: true });
  writeFileSync(join(root, file), [`# DEC-${String(num).padStart(3, '0')} ${title}`, '',
    '- Estado: proposed', `- Fecha: ${today()}`, `- Aprobador: pendiente: lo acepta Jev (node scripts/adr.mjs accept ${nnnn}, DEC-036)`,
    '- Módulos: <rutas que toca, separadas por comas>', '- Enforced-by: <scripts/test/x.test.mjs#DEC-NNN | cmd: <comando> | manual: <motivo>>',
    '', '## Contexto', '', '<el problema y sus fuerzas, neutral>', '', '## Impulsores', '', '<REQ, DEC, pedidos>', '',
    '## Opciones consideradas', '', '### 1. <opción>', '- A favor: …', '- En contra: …', '', '### 2. <opción>', '- A favor: …', '- En contra: …', '',
    '## Decisión', '', 'Usaremos la opción <N> …', '', '## Consecuencias', '', 'Buenas: … Malas: … Neutrales: …', '',
    '## Confirmación', '', '<la prueba o el chequeo que la verifica>', '', '## Más información', '', '- Revisar si: …', ''].join('\n'));
  const path = join(root, DECISIONS_FILE);
  if (existsSync(path)) writeFileSync(path, withIndex(root, readFileSync(path, 'utf8')));
  return file;
}

/** Writes the new Estado and Aprobador of an ADR and regenerates the index of DECISIONS.md. */
function decide(root, d, status, who) {
  const text = readFileSync(join(root, d.file), 'utf8')
    .replace(/^- Estado:.*$/m, `- Estado: ${status}`)
    .replace(/^- Aprobador:.*$/m, `- Aprobador: ${who}`);
  writeFileSync(join(root, d.file), text);
  const path = join(root, DECISIONS_FILE);
  if (existsSync(path)) writeFileSync(path, withIndex(root, readFileSync(path, 'utf8')));
}

function accept(root, nnnn, { decider, threshold, by, reason }) {
  const d = loadDecisions(root).find((x) => x.kind === 'adr' && x.file.split('/').pop().startsWith(`${nnnn}-`));
  if (!d) throw new Error(`no ADR ${nnnn} in ${ADR_DIR}`);
  if (d.status !== 'proposed') throw new Error(`${nnnn} is ${d.status}: only a proposed ADR is accepted (an accepted one is superseded, DEC-035)`);
  if (realOptions(d.text) < 2) {   // T-71: not even asked; check-adr would reject it as accepted
    console.error(`adr: ${nnnn} needs at least two options with their pros and cons before it is accepted (DEC-036); it stays proposed`);
    return 1;
  }
  if (by !== undefined) {   // T-91: the user accepted it by name in session; the decider is not asked
    decide(root, d, 'accepted', `${by}, ${today()} (aprobación nominal en sesión${reason ? `: «${reason}»` : ''})`);
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), 'adr-accept-'));
  const q = join(dir, 'q.json');
  writeFileSync(q, JSON.stringify({ id: 'adr_accept', state: d.text,
    instructions: 'Should this proposed architecture decision record be accepted? Accept it only if it states a real problem, at least two options with their pros and cons, a decision that follows from them and how the decision is confirmed (a test, a check or a manual reason).',
    options: { accept: 'the record is complete and its decision follows from its options: accept it', reject: 'the record lacks a real problem, real options, a reasoned decision or its confirmation: reject it' } }));
  const records = join(root, 'artifacts/decisions/adr');
  const env = { ...process.env };
  if (!env.TYPESAFE_API_KEY) {   // like the orchestrator: the key from the local secrets file, never exported to agents
    const secrets = env.AUTOPILOT_SECRETS ?? join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? '', '.config'), 'autopilot/secrets.sh');
    const k = existsSync(secrets) ? spawnSync('bash', ['-c', `. "${secrets}" >/dev/null 2>&1; printf %s "\${TYPESAFE_API_KEY:-}"`], { encoding: 'utf8' }).stdout : '';
    if (k) env.TYPESAFE_API_KEY = k;
  }
  const r = spawnSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'lib/decide.mjs'), 'ask', '--decider', decider, '--question', q,
    '--threshold', String(threshold), '--record-dir', records], { encoding: 'utf8', env });
  rmSync(dir, { recursive: true, force: true });
  let out;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(`the decider gave no result (${r.stderr.trim().slice(0, 200)})`); }
  if (out.action !== 'proceed') {
    console.error(`adr: ${nnnn} stays proposed: ${out.reason}; the user decides (DEC-036)`);
    return 1;
  }
  const record = relative(root, out.record);
  const model = JSON.parse(readFileSync(out.record, 'utf8')).model;
  const name = decider.split('/').pop().replace(/\.sh$/, '');
  const who = `${name === 'jev' ? 'Jev' : `decisor ${name}`}${model ? ` (${model})` : ''}, ${today()} (registro ${record}, confianza ${out.confidence})`;
  decide(root, d, out.answer === 'accept' ? 'accepted' : 'rejected', who);
  return 0;
}

function main(argv) {
  const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const root = resolve(opt('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const VALUED = ['--root', '--ids', '--decider', '--threshold', '--task', '--recent', '--by', '--reason'];
  const cmd = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
  const args = argv.filter((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1])).slice(1);
  if (cmd === 'new') {
    if (!args[0]) { console.error('adr: new needs a title'); return 2; }
    console.log(newAdr(root, args.join(' ')));
    return 0;
  }
  if (cmd === 'accept') {
    if (!/^\d{4}$/.test(args[0] ?? '')) { console.error('adr: accept needs the ADR number (NNNN)'); return 2; }
    const by = argv.includes('--by') ? (opt('--by') ?? '').trim() : undefined;
    if (by === '' || by?.startsWith('--')) { console.error('adr: --by needs the name of the user who approved it'); return 2; }
    const decider = opt('--decider') ?? join(root, `scripts/agents/decider/${process.env.AUTOPILOT_DECIDER ?? 'jev'}.sh`);
    return accept(root, args[0], { decider, by, reason: opt('--reason'),
      threshold: Number(opt('--threshold') ?? process.env.AUTOPILOT_DECIDE_THRESHOLD_ADR_ACCEPT ?? 0.8) });
  }
  if (cmd === 'select') {
    const sel = select(root, opt('--task'), Number(opt('--recent') ?? process.env.AUTOPILOT_ADR_RECENT ?? 5));
    if (argv.includes('--files')) console.log([...new Set(sel.map((d) => d.file))].join('\n'));
    else console.log(JSON.stringify(sel));
    return 0;
  }
  if (cmd === 'migrate') {
    const ids = (opt('--ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length) { console.error('adr: migrate needs --ids DEC-NNN,…'); return 2; }
    migrate(root, ids);
    return 0;
  }
  if (cmd === 'index') {
    const path = join(root, DECISIONS_FILE);
    const text = readFileSync(path, 'utf8');
    const fresh = withIndex(root, text);
    if (argv.includes('--check')) {
      if (fresh !== text) { console.error(`adr: the index of ${DECISIONS_FILE} is out of date: run node scripts/adr.mjs index`); return 1; }
      return 0;
    }
    writeFileSync(path, fresh);
    return 0;
  }
  console.error('usage: adr.mjs [--root DIR] migrate --ids DEC-NNN,… | index [--check] | new "<title>" | accept NNNN [--by <user> [--reason "<quote>"]] | select --task T-NN');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(`adr: ${e.message}`); process.exit(1); }
}
