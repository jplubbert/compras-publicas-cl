// Decisions as ADR (MADR) in spec/adr/ (DEC-035): the shared loader. A decision is either an ADR file
// spec/adr/NNNN-<title>.md (the costly-to-revert ones) or a reversible DEC kept in spec/DECISIONS.md, below its generated
// index. Projects that have not migrated keep every DEC in spec/DECISIONS.md and read the same.
//
//   loadDecisions(root | reader) → [{id, num, title, status, date, approver, enforcedBy, modules, kind, file, text}]
//   combinedDecisions(root | reader) → one text with a "## DEC-NNN <title>" section per decision (an ADR's own "##"
//     headings demoted to "###"), for the code that reads DECISIONS.md sections (check:spec, the reviewer's context)
//   parseAdr(text) → the fields of one ADR file
//   renderIndex(decisions) → the Markdown table of the generated index
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ADR_DIR = 'spec/adr';
export const DECISIONS_FILE = 'spec/DECISIONS.md';
export const INDEX_START = '<!-- adr-index:start -->';
export const INDEX_END = '<!-- adr-index:end -->';
export const ADR_FILE_RE = /^(\d{4})-[a-z0-9-]+\.md$/;

/** A reader over the working tree (or what check:spec gives: {text(rel), list(dir)}). */
export function reader(rootOrReader) {
  if (typeof rootOrReader !== 'string') return rootOrReader;
  const root = rootOrReader;
  return {
    text: (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : ''),
    list: (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).map((f) => `${dir}/${f}`) : []),
  };
}

const field = (text, name) => (new RegExp(`^- ${name}:\\s*(.*)$`, 'm').exec(text) ?? [])[1]?.trim() ?? null;

/** The fields of one ADR file. */
export function parseAdr(text) {
  const h = /^# (DEC-(\d+))\s+(.+)$/m.exec(text);
  const status = field(text, 'Estado');
  const modules = field(text, 'Módulos');
  return {
    id: h?.[1] ?? null, num: h ? Number(h[2]) : null, title: h?.[3]?.trim() ?? null,
    status: status ? status.split(/\s/)[0] : null, statusLine: status,
    date: field(text, 'Fecha'), approver: field(text, 'Aprobador'), enforcedBy: field(text, 'Enforced-by'),
    modules: modules ? modules.split(',').map((m) => m.trim()).filter(Boolean) : [],
  };
}

/** The "## DEC-NNN" sections of a DECISIONS.md text (outside the generated index), each with its status and text. */
function sections(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = /^## (DEC-(\d+))\s+(.*)$/.exec(line);
    if (m) { cur = { id: m[1], num: Number(m[2]), title: m[3].trim(), lines: [line] }; out.push(cur); continue; }
    if (/^## /.test(line) || /^# /.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map((s) => {
    const text = s.lines.join('\n').replace(/\n+$/, '\n');
    const status = field(text, 'Estado');
    const fecha = field(text, 'Fecha');
    return { id: s.id, num: s.num, title: s.title, status: status ? status.split(/\s/)[0] : null, statusLine: status,
      date: fecha ? fecha.split('·')[0].trim() : null, approver: null, enforcedBy: null, modules: [], kind: 'reversible',
      file: DECISIONS_FILE, text };
  });
}

/** Every decision: the ADRs of spec/adr/ and the DECs still in spec/DECISIONS.md, by number. */
export function loadDecisions(rootOrReader) {
  const r = reader(rootOrReader);
  const adrs = r.list(ADR_DIR).filter((f) => ADR_FILE_RE.test(f.split('/').pop())).sort().map((file) => {
    const text = r.text(file);
    return { ...parseAdr(text), kind: 'adr', file, text };
  }).filter((a) => a.id);
  const ids = new Set(adrs.map((a) => a.id));
  const rest = sections(r.text(DECISIONS_FILE)).filter((d) => !ids.has(d.id));
  return [...adrs, ...rest].sort((a, b) => a.num - b.num);
}

/** One text with a "## DEC-NNN" section per decision, for the code that reads DECISIONS.md sections. */
export function combinedDecisions(rootOrReader) {
  return loadDecisions(rootOrReader).map((d) => {
    if (d.kind !== 'adr') return d.text;
    const body = d.text.replace(/^# .*\n/, '').replace(/^## /gm, '### ');
    return `## ${d.id} ${d.title}\n${body}`;
  }).join('\n');
}

/** GitHub's anchor of a "## <text>" heading: lowercase, punctuation out, spaces to hyphens. */
export const anchor = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
/** DEC-036 (T-71): the options of an ADR with both their pros and their cons recorded (not "no registradas"). */
export function realOptions(text) {
  const recorded = (s) => s.trim() !== '' && !/^no registrad/i.test(s.trim()) && !/^…$/.test(s.trim());
  return [...text.matchAll(/^### \d+\. .*\n- A favor: (.*)\n- En contra: (.*)$/gm)].filter((m) => recorded(m[1]) && recorded(m[2])).length;
}
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|');
/** The generated index (DEC-035 point 3): number, title, status and where it lives. */
export function renderIndex(decisions) {
  const rows = decisions.map((d) => {
    const where = d.kind === 'adr' ? `[ADR](${d.file.replace(/^spec\//, '')})` : `[más abajo](#${anchor(`${d.id} ${d.title}`)})`;
    return `| ${d.id} | ${cell(d.title)} | ${cell(d.statusLine ?? d.status)} | ${where} |`;
  });
  return [INDEX_START, '<!-- generado por `node scripts/adr.mjs index`; no se edita a mano (DEC-035) -->', '',
    '| ID | Título | Estado | Dónde |', '|---|---|---|---|', ...rows, '', INDEX_END].join('\n');
}

const segs = (p) => p.replace(/\/$/, '').split('/');
const crosses = (a, b) => { const [x, y] = [segs(a), segs(b)]; return x.slice(0, Math.min(x.length, y.length)).every((s, i) => s === y[i]); };
/** DEC-036: the decisions in force an agent of task `id` gets: cited ∪ the `recent` most recent ∪ those of its modules. */
export function select(root, id, recent = 5) {
  const task = JSON.parse(readFileSync(join(root, 'spec/TASKS.json'), 'utf8')).tasks.find((t) => t.id === id);
  if (!task) throw new Error(`${id} does not exist in spec/TASKS.json`);
  const all = loadDecisions(root);
  const inForce = all.filter((d) => d.kind === 'adr' && d.status === 'accepted');
  const why = new Map();
  const add = (d, w) => { if (!why.has(d.id)) why.set(d.id, { d, why: [] }); if (!why.get(d.id).why.includes(w)) why.get(d.id).why.push(w); };
  for (const c of task.decisions ?? []) {
    let d = all.find((x) => x.id === c);
    // T-72: a superseded ADR leads to the one that replaces it, along the chain, up to the one in force
    const seen = new Set();
    while (d && d.kind === 'adr' && d.status === 'superseded' && !seen.has(d.id)) {
      seen.add(d.id);
      const m = /^superseded by (?:DEC-)?(\d+)$/.exec(d.statusLine ?? '');
      d = m ? all.find((x) => x.num === Number(m[1])) : null;
    }
    if (!d || (d.kind === 'adr' && d.status !== 'accepted')) continue;
    add(d, d.id === c ? 'cited' : `cited (replaces ${c})`);
  }
  const byDate = [...inForce].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.num - a.num);
  for (const d of byDate.slice(0, recent)) add(d, 'recent');
  for (const d of inForce) if (d.modules.some((m) => (task.touches ?? []).some((t) => crosses(m, t)))) add(d, 'module');
  return [...why.values()].sort((a, b) => a.d.num - b.d.num).map(({ d, why: w }) => ({ id: d.id, kind: d.kind, file: d.file, why: w }));
}


