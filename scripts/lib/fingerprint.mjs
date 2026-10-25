#!/usr/bin/env node
// Failure fingerprint and case memory (T-108, DEC-051 level L0: deterministic rules, no LLM). Only the orchestrator
// runs it, after writing result.json (DEC-024); no agent does.
//
//   node scripts/lib/fingerprint.mjs record RUN_DIR --memory FILE.jsonl
//     a run whose status is not ok, or with a failed task, gets a fingerprint: sha256 of (role, stop_reason, first error
//     line, guard or decider question id), each normalized (paths, UUIDs, run ids, timestamps, durations, line numbers,
//     task ids and hashes masked); the task is kept apart, never hashed. Its class comes from layered rules (classify),
//     "unknown" without one. result.json gets fingerprint and failure_class, and FILE.jsonl (the repo's case memory, one
//     {fingerprint, class, count, first_seen, last_seen, task, runs} per fingerprint) counts and dates it. Both files are
//     written to a temporary file and renamed. A healthy run is left as is. Prints {fingerprint, failure_class, count}
//     (or {} for a healthy run); exit 0 whatever it finds, 2 on bad usage.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MASKS = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b\d{4}-\d{2}-\d{2}_\d{6}\b/g, '<run>'],
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '<time>'],
  [/\b\d{2}:\d{2}(?::\d{2})?\b/g, '<time>'],
  [/(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)+[\w.@+-]*|(?:~|\.{1,2})?\/[\w.@+-]+/g, '<path>'],
  [/:\d+(?::\d+)?\b/g, ':<n>'],
  [/\bline \d+\b/gi, 'line <n>'],
  [/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds?|min|mins|minutes?|h|hours?)\b/gi, '<duration>'],
  [/\b[TQS]-\d+\b/g, '<id>'],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/g, '<hash>'],
  [/\b\d+\.\d+\b/g, '<num>'],
  [/\b\d{4,}\b/g, '<num>'],
];

/** The text with what changes from one occurrence to the next masked, and whitespace collapsed. */
export function normalize(text) {
  let s = String(text ?? '');
  for (const [re, mask] of MASKS) s = s.replace(re, mask);
  return s.replace(/\s+/g, ' ').trim();
}

/** sha256 (hex) of the normalized (role, stop_reason, error, guard); the task is not part of it. */
export function fingerprint({ role = '', stop_reason = '', error = '', guard = '' } = {}) {
  const key = JSON.stringify([String(role), normalize(stop_reason), normalize(error), String(guard)]);
  return createHash('sha256').update(key).digest('hex');
}

const ROLE_RE = /\b(implementer|reviewer|test-author|test_author|planner|critic|researcher)\b/i;
// Guards the orchestrator stops on, by the stop reason it writes (English, result.json)
const GUARD_STOPS = [
  ['session_audit', /accessed the context of another agent|read outside|another agent's context/i],
  ['acceptance_guard', /touched tests\/acceptance\//i],
  ['authority_guard', /reserved status/i],
  ['dirty_tree', /dirty working tree/i],
  ['branch_guard', /changed branch/i],
  ['stray_guard', /changed files outside|wrote outside/i],
  ['evidence_guard', /evidence_mismatch/i],
  ['result_check', /result .*(missing or invalid|rejected)|absent or invalid/i],
];
const ERROR_RE = /\b(error|errors|fail(?:ed|s|ure)?|denied|could not|cannot|invalid|rejected|breach|stop:)/i;
const GUARD_LINE_RE = /access_guard \(DEC-016\): denied: (.+)$/;

/** The token a guard line names, and its kind: tool_results, commit_message, existing_path or other (layer 3). */
export function guardToken(line, root = '') {
  const m = String(line).match(GUARD_LINE_RE);
  const token = (m ? m[1] : String(line).split(': ').at(-1)).trim().split(/\s+/)[0] ?? '';
  let kind = 'other';
  if (/\/tool-results\//.test(token)) kind = 'tool_results';
  else if (/\bgit commit\b/.test(line)) kind = 'commit_message';
  else if (token && existsSync(isAbsolute(token) ? token : resolve(root || '.', token))) kind = 'existing_path';
  return { token, kind };
}

/**
 * The class of a failure, by layers (T-108): (3) the guard that stopped the run and the kind of its token; (2) the
 * environment (a clock gap of T-98 in live.log, a child spending CPU at an inactivity cut, T-106); (1) the enums of
 * result.json (status, exit_code 124/137/143, a decider escalation, a declared block); (4) repetition: a fingerprint
 * the memory already holds. Without a rule, "unknown". facts = {status, exit_code, guard, token_kind, clock_gap,
 * busy_child, decider_escalation, agent_blocked, seen}.
 */
export function classify(f = {}) {
  if (f.guard && !f.guard.startsWith('decide:')) return f.token_kind ? `${f.guard}/${f.token_kind}` : f.guard;
  const cut = ['stalled', 'sigterm', 'crashed_orphan', 'error'].includes(f.status);
  if (cut && f.clock_gap) return 'suspended';
  if (f.status === 'stalled' && f.busy_child) return 'stalled_busy_child';
  if (['timeout', 'budget_exhausted', 'usage_limited', 'api_error', 'sigterm', 'stalled', 'crashed_orphan'].includes(f.status)) return f.status;
  const code = Number(f.exit_code);
  if (code === 124) return 'killed_timeout';
  if (code === 137) return 'killed_sigkill';
  if (code === 143) return 'killed_sigterm';
  if (f.decider_escalation) return 'decider_escalation';
  if (f.agent_blocked) return 'agent_blocked';
  if (f.seen) return 'repeated';
  return 'unknown';
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const readText = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const files = (dir, re) => { try { return readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => join(dir, n)); } catch { return []; } };

/** Whether a run needs a fingerprint: status other than ok, or a failed task. */
export const failedRun = (result) => Boolean(result) && ((result.status ?? 'ok') !== 'ok' || (result.failed ?? []).length > 0);

/** The inputs of the fingerprint and the facts of classify, from a run directory (result.json, live.log, the session
 * audits and the decision records). */
export function analyzeRun(runDir, root = '') {
  const result = readJson(join(runDir, 'result.json')) ?? {};
  const reason = String(result.stop_reason ?? '');
  const live = readText(join(runDir, 'live.log')).split('\n').map((l) => l.replace(/^\d{2}:\d{2}:\d{2} autopilot: /, ''));
  const breaches = files(runDir, /-audit\.txt$/).flatMap((f) => readText(f).split('\n')).filter((l) => l && !l.startsWith('denied by the guard'));
  const escalated = files(join(runDir, 'decisions'), /\.json$/).map(readJson).find((d) => d?.action === 'escalate');
  let guard = GUARD_STOPS.find(([, re]) => re.test(reason))?.[0] ?? '';
  let token_kind = '';
  let error = live.find((l) => ERROR_RE.test(l) && !/^start at /.test(l)) ?? '';
  if (guard === 'session_audit' && breaches.length > 0) {
    error = breaches[0];
    token_kind = guardToken(breaches[0], root).kind;
  }
  if (!guard && escalated) guard = `decide:${escalated.question?.id ?? escalated.id ?? 'unknown'}`;
  const role = (reason.match(ROLE_RE) ?? breaches.join(' ').match(ROLE_RE) ?? [])[1]?.toLowerCase().replace('_', '-') ?? 'orchestrator';
  const task = (result.failed ?? [])[0] ?? reason.match(/\bT-\d+\b/)?.[0] ?? (result.agent_blocked ?? [])[0] ?? (result.review_blocked ?? [])[0] ?? null;
  return {
    result,
    input: { role, stop_reason: reason, error, guard },
    task,
    facts: {
      status: result.status, exit_code: result.exit_code, guard, token_kind,
      clock_gap: live.some((l) => /^clock gap: /.test(l)),
      busy_child: live.some((l) => /^quiet stream, agent processes active/.test(l)),
      decider_escalation: Boolean(escalated) || (result.review_blocked ?? []).length > 0 || /\bdecider\b.*\b(did not settle|confidence)/i.test(reason),
      agent_blocked: (result.agent_blocked ?? []).length > 0,
    },
  };
}

/** The case memory (JSONL, one entry per fingerprint). */
export function readMemory(file) {
  return readText(file).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Counts and dates one occurrence: a new entry, or count + 1, last_seen and the run added. → the entry. */
export function recordCase(file, { fingerprint: fp, class: cls, task = null, run, at = new Date().toISOString() }) {
  const entries = readMemory(file);
  let entry = entries.find((e) => e.fingerprint === fp);
  if (entry) {
    entry.count += 1;
    entry.last_seen = at;
    entry.class = cls;
    if (task) entry.task = task;
    if (run && !entry.runs.includes(run)) entry.runs.push(run);
  } else {
    entry = { fingerprint: fp, class: cls, count: 1, first_seen: at, last_seen: at, task, runs: run ? [run] : [] };
    entries.push(entry);
  }
  writeFileSync(`${file}.tmp`, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  renameSync(`${file}.tmp`, file);
  return entry;
}

/** Fingerprint, class and memory for one run directory; result.json gets fingerprint and failure_class. */
export function recordRun(runDir, memory, { root = '', at } = {}) {
  const { result, input, task, facts } = analyzeRun(runDir, root);
  if (!failedRun(result)) return {};
  const fp = fingerprint(input);
  const seen = readMemory(memory).some((e) => e.fingerprint === fp);
  const cls = classify({ ...facts, seen });
  const entry = recordCase(memory, { fingerprint: fp, class: cls, task, run: result.run_id, at });
  const file = join(runDir, 'result.json');
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...result, fingerprint: fp, failure_class: cls }, null, 2) + '\n');
  renameSync(`${file}.tmp`, file);
  return { fingerprint: fp, failure_class: cls, count: entry.count };
}

function main(argv) {
  const memory = argv.includes('--memory') ? argv[argv.indexOf('--memory') + 1] : '';
  const root = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : '';
  if (argv[0] !== 'record' || !argv[1] || !memory) {
    process.stderr.write('usage: fingerprint.mjs record RUN_DIR --memory FILE.jsonl [--root DIR]\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(recordRun(argv[1], memory, { root }))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
