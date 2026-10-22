#!/usr/bin/env node
// Live progress of the implementer: turns `claude -p --output-format stream-json --verbose` into readable
// lines. No dependencies.
//
//   claude -p … --output-format stream-json --verbose | node scripts/lib/autopilot-stream.mjs [--label T-NN] [--raw FILE] [--result FILE] [--tokens FILE]
//   node scripts/lib/autopilot-stream.mjs tokens-summary FILE [--lang es]
//   node scripts/lib/autopilot-stream.mjs audit FILE [--forbid DIR]… [--root DIR --reads-under PATH…]
//
//   --label   prefix of each line (the task)
//   --raw     full copy of the stream (JSONL)
//   --result  the final `result` event as JSON (what --output-format json used to give)
//   --tokens  appends to the file (JSONL) the tokens of the `result` event's `usage` field, with the label
//   tokens-summary  prints one line per label (tokens summed over its invocations) and a last one with the total;
//                   `--lang es` for the spec/LOG.md summary, which stays in Spanish (AGENTS.md §Idioma)
//   audit     checks an agent's saved stream, in the common format (DEC-008 point 5, DEC-018: an attempt whose result is
//             the guard's or the permission rules' denial is listed as denied and does not fail): lists every tool call that got a
//             path of the run's records (.autopilot/) or under a --forbid directory (the agent's private paths, from its
//             adapter: transcripts and memory of other sessions) and exits 1 if there is any; with --reads-under
//             (the test-author, DEC-006), also every read (Read, Glob, Grep) outside those paths of --root
// The readable lines go to stdout; autopilot.sh copies them to the terminal and to .autopilot/<run>/live.log.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX = 220;

/** First non-empty line, trimmed. */
export function oneLine(text, max = MAX) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Tokens of a `result` event's `usage` field; null if it has no usage. */
export function usageOf(ev) {
  const u = ev?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cache_read: n(u.cache_read_input_tokens),
    cache_write: n(u.cache_creation_input_tokens),
  };
}

// Wording of the token lines: English for the terminal and live.log, Spanish for spec/LOG.md.
const WORDS = {
  en: { sep: ',', input: 'input', output: 'output', read: 'cache read', write: 'cache write', calls: 'invocations', total: 'total for the run', none: 'no agent invocations' },
  es: { sep: '.', input: 'entrada', output: 'salida', read: 'caché leída', write: 'caché escrita', calls: 'invocaciones', total: 'total de la corrida', none: 'sin invocaciones de agentes' },
};

const group = (n, sep) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);

/** "input 44 · output 11,440 · cache read 1,266,786 · cache write 64,481" (`es`: "entrada 44 · salida 11.440 · …") */
export function formatUsage(u, lang = 'en') {
  const w = WORDS[lang];
  return `${w.input} ${group(u.input, w.sep)} · ${w.output} ${group(u.output, w.sep)} · ${w.read} ${group(u.cache_read, w.sep)} · ${w.write} ${group(u.cache_write, w.sep)}`;
}

/** Sum of a list of usages. */
export function sumUsage(list) {
  const t = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const u of list) for (const k of Object.keys(t)) t[k] += u[k] ?? 0;
  return t;
}

/** Records {label, ...usage} → lines "T-04: … (2 invocations)" and "total for the run: …". */
export function tokensSummary(records, lang = 'en') {
  const w = WORDS[lang];
  const by = new Map();
  for (const r of records) by.set(r.label, [...(by.get(r.label) ?? []), r]);
  const lines = [...by].map(([label, rs]) => `${label}: ${formatUsage(sumUsage(rs), lang)}${rs.length > 1 ? ` (${rs.length} ${w.calls})` : ''}`);
  lines.push(records.length ? `${w.total}: ${formatUsage(sumUsage(records), lang)}` : `${w.total}: ${w.none}`);
  return lines;
}

function toolSummary(name, input = {}) {
  if (name === 'TodoWrite' && Array.isArray(input.todos)) {
    const doing = input.todos.find((t) => t.status === 'in_progress');
    return `${input.todos.length} todos${doing ? ` · now: ${doing.content ?? doing.activeForm}` : ''}`;
  }
  for (const k of ['command', 'file_path', 'notebook_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k]) {
      return k === 'pattern' && input.path ? `${input[k]} in ${input.path}` : input[k];
    }
  }
  return JSON.stringify(input);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('\n');
  return '';
}

/** Readable lines (without prefix) for a stream event; [] if it adds nothing. */
export function formatEvent(ev) {
  const out = [];
  switch (ev?.type) {
    case 'system':
      if (ev.subtype === 'init') out.push(`· start (model ${ev.model ?? '?'}, session ${ev.session_id ?? '?'})`);
      else if (ev.subtype === 'compact_boundary') out.push('· context compacted');
      break;
    case 'assistant':
      for (const c of ev.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) out.push(`› ${oneLine(c.text)}`);
        else if (c.type === 'tool_use') out.push(`▸ ${c.name}  ${oneLine(toolSummary(c.name, c.input))}`);
      }
      break;
    case 'user':
      for (const c of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (c.type !== 'tool_result') continue;
        const text = resultText(c.content);
        const lines = text ? text.split('\n').length : 0;
        out.push(c.is_error ? `  ✗ ${oneLine(text) || 'error'}` : `  ✓ ${lines} line(s)${text.trim() ? `: ${oneLine(text, 120)}` : ''}`);
      }
      break;
    case 'result': {
      const u = usageOf(ev);
      const tokens = u ? `, tokens: ${formatUsage(u)}` : '';
      const mins = typeof ev.duration_ms === 'number' ? `, ${Math.round(ev.duration_ms / 60000)} min` : '';
      out.push(`■ end (${ev.is_error ? `error: ${ev.subtype ?? '?'}` : 'ok'}): ${ev.num_turns ?? '?'} turns${tokens}${mins}`);
      if (ev.result) out.push(`■ ${oneLine(ev.result)}`);
      break;
    }
  }
  return out;
}

/** Input line → readable lines; non-JSON lines pass through as is (trimmed). */
export function formatLine(line) {
  if (!line.trim()) return [];
  try {
    return formatEvent(JSON.parse(line));
  } catch {
    return [`  | ${oneLine(line)}`];
  }
}

/** Path-like fields of each tool's input; for Bash, the tokens of its command. Grep's pattern is not a path. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'pattern'];
function pathsOf(name, input) {
  if (!input || typeof input !== 'object') return [];
  if (typeof input.command === 'string') return input.command.split(/[\s'"=;|&<>()]+/).filter(Boolean);
  return PATH_FIELDS.filter((k) => !(name === 'Grep' && k === 'pattern')).map((k) => input[k]).filter((v) => typeof v === 'string');
}

/**
 * Tool calls of a stream (JSONL text, common format) that reach another agent's context (DEC-008 point 5): a path into
 * .autopilot/ (the run's records: streams, prompts and outputs of every agent) or under one of `forbid` (the agent's
 * private paths: transcripts and memory of other sessions). Literal paths only: a wildcard or a variable that expands
 * to them is not seen. → ["Tool: path", …]
 */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
/**
 * A tool result that is a denial (DEC-018): access_guard's (or its hook failing closed) or the permission rules'. An
 * attempt that got one of these was prevented: it is logged, it does not stop the run.
 */
const DENIAL_RE = /access_guard \(DEC-016\): (denied|the hook failed, so the tool is blocked)|Permission to use \S+ has been denied/;

/**
 * The session audit (DEC-008 point 5, DEC-018): every tool call with a path of .autopilot/ or under a forbidden
 * directory (or, with readsUnder, a read outside those paths) → { breaches, denied }. A call whose result is a denial
 * goes to `denied` (logged; the run goes on); any other — a result, an error that is not a denial, or no result at
 * all — is a breach that stops the run. Literal paths only.
 */
export function auditSession(text, { forbid = [], readsUnder = [], root = '' } = {}) {
  const dirs = forbid.map((d) => d.replace(/\/+$/, '')).filter(Boolean);
  const base = root.replace(/\/+$/, '');
  // A read reaches the path it names; without one (Glob's pattern aside) it searches the whole repository.
  const outsideReads = (name, input) => {
    if (readsUnder.length === 0 || !READ_TOOLS.includes(name)) return null;
    const target = String(input?.file_path ?? input?.path ?? input?.notebook_path ?? (name === 'Glob' ? input?.pattern : '') ?? '');
    const rel = (base && target.startsWith(`${base}/`) ? target.slice(base.length + 1) : target).replace(/^\.\//, '');
    const inside = readsUnder.some((p) => rel === p.replace(/\/$/, '') || rel.startsWith(p.endsWith('/') ? p : `${p}/`));
    return inside ? null : `${name} outside ${readsUnder.join(', ')}: ${target || '(the whole repository)'}`;
  };
  const bad = (p) => /(^|\/)\.autopilot(\/|$)/.test(p) || dirs.some((d) => p === d || p.startsWith(`${d}/`));
  const flagged = [];   // [{ id, line }]
  const denials = new Set();
  for (const line of text.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    for (const c of ev?.message?.content ?? []) {
      if (ev.type === 'assistant' && c?.type === 'tool_use') {
        for (const p of pathsOf(c.name, c.input)) if (bad(p)) flagged.push({ id: c.id, line: `${c.name}: ${p}` });
        const o = outsideReads(c.name, c.input);
        if (o) flagged.push({ id: c.id, line: o });
      } else if (ev.type === 'user' && c?.type === 'tool_result' && c.is_error && DENIAL_RE.test(resultText(c.content))) {
        denials.add(c.tool_use_id);
      }
    }
  }
  return {
    breaches: flagged.filter((f) => !(f.id && denials.has(f.id))).map((f) => f.line),
    denied: flagged.filter((f) => f.id && denials.has(f.id)).map((f) => f.line),
  };
}

/** The breaches of auditSession: the calls that reached another agent's context (or read outside their paths). */
export function auditStream(text, opts = {}) {
  return auditSession(text, opts).breaches;
}

async function main(argv) {
  if (argv[0] === 'audit') {
    const forbid = argv.flatMap((a, i) => (argv[i - 1] === '--forbid' ? [a] : []));
    const readsUnder = argv.flatMap((a, i) => (argv[i - 1] === '--reads-under' ? [a] : []));
    const root = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : '';
    let text = '';
    try { text = readFileSync(argv[1], 'utf8'); } catch { /* no stream: nothing to audit */ }
    const { breaches, denied } = auditSession(text, { forbid, readsUnder, root });
    for (const l of breaches) process.stdout.write(`${l}\n`);
    for (const l of denied) process.stdout.write(`denied by the guard (logged, not a breach): ${l}\n`);
    process.exitCode = breaches.length > 0 ? 1 : 0;
    return;
  }
  if (argv[0] === 'tokens-summary') {
    const lang = argv[2] === '--lang' && argv[3] === 'es' ? 'es' : 'en';
    let records = [];
    try {
      records = readFileSync(argv[1], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { /* no file: no invocations */ }
    for (const l of tokensSummary(records, lang)) process.stdout.write(`${l}\n`);
    return;
  }
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (opt.raw) writeFileSync(opt.raw, '');
  const prefix = opt.label ? `${opt.label} ` : '';
  const stamp = () => new Date().toTimeString().slice(0, 8);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (opt.raw) appendFileSync(opt.raw, `${line}\n`);
    let ev = null;
    try { ev = JSON.parse(line); } catch { /* non-JSON line */ }
    if (ev?.type === 'result') {
      if (opt.result) writeFileSync(opt.result, `${JSON.stringify(ev)}\n`);
      const u = usageOf(ev);
      if (opt.tokens && u) appendFileSync(opt.tokens, `${JSON.stringify({ label: opt.label ?? '?', ...u })}\n`);
    }
    for (const l of formatLine(line)) process.stdout.write(`${stamp()} ${prefix}${l}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
