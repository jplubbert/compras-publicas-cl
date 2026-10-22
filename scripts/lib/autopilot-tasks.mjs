#!/usr/bin/env node
// Operations on spec/ used by scripts/autopilot.sh. No dependencies.
//
//   node scripts/lib/autopilot-tasks.mjs [--root DIR] <command> [args]
//
//   pick [--task T-NN] [--exclude T-NN,…]
//                           first eligible task (in_progress/ready/approved_for_impl) with all its dependencies closed
//                           (done/reviewed/accepted/delivered) and not in --exclude, or the forced one → JSON | null
//   pick-batch --max N [--exclude T-NN,…]
//                           up to N eligible tasks (same criterion as pick) whose touches don't cross pairwise → JSON [..]
//   review-duration [--runs DIR] [--last N]
//                           DEC-023: median duration of the last N (10) reviews in DIR/<run>/live.log (default
//                           .autopilot/) → JSON {seconds | null, samples}
//   pick-specified [--exclude T-NN,…]
//                           DEC-022: the first specified task (not spec) with closed dependencies and accepted
//                           decisions, which the orchestrator may take to the critic and approve → JSON | null
//   set-status T-NN STATUS --by NAME [--reason TEXT] [--blocked-by ID]
//                           DEC-028: the only hand-made status change (sessions, the user), with its status_log entry;
//                           never verified_auto, implemented, reviewed or done; approved_for_impl, accepted, delivered
//                           only by a person
//   set-block T-NN --file BLOCK.json [--classification C] [--confidence N] [--decision RECORD] [--branch B] [--returned]
//                           DEC-029: stores the block the implementer declared with the decider's classification
//   set-merged T-NN --into BRANCH --commit SHA
//                           DEC-028: records the integration as merged {into, commit, at} (a fact, not a status)
//   merged-check            T-110: the merged records that do not match git (into is autopilot/* or does not exist, the
//                           commit does not exist or is not an ancestor of into) → JSON [{id, into, commit, reason}]
//   grant-impl T-NN --by LABEL
//                           DEC-022: specified → approved_for_impl with impl_approval, only after APROBAR on its plan
//   pending-reviews         ids of the tasks in verified_auto (awaiting independent review) → JSON
//   manual-pending          manual checks deferred to the batch acceptance → JSON ["T-NN: …"]
//   snapshot                map id → status of every task → JSON
//   check-authority FILE    compares with snapshot FILE; fails if the executor granted a reserved status
//   status T-NN             prints the task's status
//   kind T-NN               prints the task's kind (impl if absent)
//   touches T-NN            prints the task's touches, comma-separated
//   context T-NN            Markdown with the task, its REQs (SPEC.md) and its DECs (DECISIONS.md) for the reviewer
//   parse-verdict FILE      extracts the JSON verdict from the reviewer output → normalized JSON (exit 1 if none)
//   set-review T-NN FILE    stores the verdict (FILE, normalized JSON) in TASKS.json; approved → reviewed
//   set-user-review T-NN --by NAME --reason TEXT
//                           T-103: the user's own review: verified_auto, or blocked by a review without a verdict
//                           (DEC-030, its Q-NN marked answered) → reviewed, with decision {decider: user, by}. Sessions only,
//                           at the user's request; never the orchestrator
//   reopen T-NN             verified_auto with a rejected review → in_progress (a retry after research, DEC-005)
//   unblock T-NN            blocked by a disputed acceptance test → in_progress (the researcher upheld the test, DEC-006)
//   check-tests T-NN FILE   validates the test-author's result (DEC-006 point 4) → normalized JSON; exit 1 if invalid
//   approve-tests T-NN --by NAME
//                           records the user's approval of the test-author's commits of the task as its
//                           acceptance_review (the gate before implementing, DEC-006 point 6)
//   acceptance-check FROM TO [--runner GLOB]…
//                           is the diff FROM..TO an additive tests/acceptance/ diff (DEC-004 point 3)? Lists why not
//                           (one reason per line) and exits 1; exit 0 if it only adds files or lines there and touches
//                           no test-runner configuration (--runner globs) outside it
//   set-acceptance-review T-NN FILE --commits FROM..TO
//                           stores the reviewer's verdict on that diff (FILE, normalized JSON) as the task's
//                           acceptance_review; the status does not change
//   scope-check T-NN        paths changed by the implementer on stdin (one per line); lists those under spec/ or
//                           outside the task's touches and exits 1 if there is any
//   check-result T-NN FILE  validates the implementer's result (DEC-001 point 4) → normalized JSON; exit 1 if it is
//                           missing or invalid, exit 3 if it proposes a reserved status. It carries no status and no
//                           evidence (DEC-014, T-34): only what the implementer asks for (outcome, blocked_by) and
//                           declares (claims). Log lines stating test results are dropped and listed in
//                           log_discarded / log_trimmed (T-117)
//   apply-result T-NN FILE --agent LABEL --status in_progress|blocked
//                           validates and applies the result to spec/: the status the orchestrator derived, blocked_by,
//                           claims and notes in TASKS.json, an entry in LOG.md, assumptions in SPEC.md → prints the new
//                           status. verified_auto is only record_evidence.py's
//   verified-line T-NN      the "- Verificado y cómo" line of LOG.md, from the evidence record_evidence.py wrote (T-35);
//                           exit 1 if the task has none (an interactive session copies it, never types counts)
//   log-verified T-NN       adds that line to the last LOG.md entry (the orchestrator, after a close)
//   research-check FILE     validates a researcher's report (DEC-005 point 5) → JSON {action, confidence, cut}; lists
//                           the problems (one per line) and exits 1 if it is invalid
//   escalate T-NN --reason TEXT [--report PATH] [--after TEXT] [--cut-title TEXT --cut-description TEXT]
//                           escalates the task to the user (DEC-005 point 7): a new Q-NN in the "Preguntas abiertas"
//                           table of SPEC.md and the task blocked by it; with a cut, the split-off work as a new
//                           specified task → JSON {question, task}
//   plan-check FILE --id T-NN
//                           validates plans/<ID>.md (DEC-010 point 2: "# Plan de <ID>" and exactly the fixed sections);
//                           lists the problems and exits 1 if it is invalid
//   critic-check FILE [--readable P,…] [--previous ID,…] [--allow-requests]
//                           validates the critic's final text (DEC-010 points 4 to 6) → JSON with the effective verdict,
//                           or {research_requests}; lists the problems and exits 1 if it is invalid
//   set-plan-review T-NN FILE --plan-sha BLOB --plan-commit SHA --round N --critic LABEL
//                           stores that check (FILE) as the task's plan_review → prints the effective verdict
//   ensure-coverage-tasks [--dry-run]
//                           DEC-011: without spec/COVERAGE.json, the task to enable it; with a baseline, a cleanup task
//                           per file; each created once, specified → JSON {out_of_rule, created, existing}
//   question-check FILE     validates a researcher's answer to a critic's question (Pregunta, Respuesta, Fuentes)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combinedDecisions, select as selectDecisions } from './adr.mjs';

/** States from which the orchestrator may take a task; `in_progress` to resume a half-done one. */
export const ELIGIBLE_STATES = ['in_progress', 'ready', 'approved_for_impl'];
/** States that close a dependency. `reviewed` included to chain tasks without waiting for the user's acceptance. */
export const DONE_STATES = ['done', 'reviewed', 'accepted', 'delivered'];
/** States only the reviewer or the user grant (AGENTS.md §Autoridad, sdd.md §7.2). The executor never writes them. */
export const RESERVED_STATES = ['reviewed', 'accepted', 'approved_for_impl', 'delivered'];
export const VERDICTS = ['approved', 'rejected'];

const tasksPath = (root) => join(root, 'spec/TASKS.json');

export function readTasks(root) {
  return JSON.parse(readFileSync(tasksPath(root), 'utf8'));
}

function writeTasks(root, data) {
  writeFileSync(tasksPath(root), JSON.stringify(data, null, 2) + '\n');
}

function findTask(data, id) {
  const t = data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`${id} does not exist in spec/TASKS.json`);
  return t;
}

/** Tasks the orchestrator may take today, in TASKS.json order. */
function eligible(data, exclude) {
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  return data.tasks.filter(
    (t) =>
      ELIGIBLE_STATES.includes(t.status) &&
      !exclude.includes(t.id) &&
      // a dependency whose evidence is marked unverified (reverification, DEC-014) does not close
      (t.depends_on ?? []).every((d) => DONE_STATES.includes(byId.get(d)?.status) && !byId.get(d)?.evidence?.unverified),
  );
}

export function pick(data, forced, exclude = []) {
  if (forced) return findTask(data, forced);
  return eligible(data, exclude)[0] ?? null;
}

const segments = (p) => (p.endsWith('/') ? p.slice(0, -1) : p).split('/');

/** Two paths cross if one is a prefix of the other by segments (`app/` crosses `app/src/x.ts`, not `apps/`). */
export function pathsCross(a, b) {
  const [sa, sb] = [segments(a), segments(b)];
  const n = Math.min(sa.length, sb.length);
  return sa.slice(0, n).every((s, i) => s === sb[i]);
}

/** Two tasks cross if any of their touches cross. A task without touches crosses every other one (runs alone). */
export function touchesCross(a, b) {
  const [ta, tb] = [a.touches ?? [], b.touches ?? []];
  if (ta.length === 0 || tb.length === 0) return true;
  return ta.some((p) => tb.some((q) => pathsCross(p, q)));
}

/**
 * Batch for parallel runs (DEC-001 point 2): eligible tasks, in order, skipping those whose touches cross a task
 * already in the batch, up to `max`. None depends on another of the batch: their dependencies are already closed.
 */
export function pickBatch(data, max, exclude = []) {
  const batch = [];
  for (const t of eligible(data, exclude)) {
    if (batch.length >= max) break;
    if (batch.every((b) => !touchesCross(b, t))) batch.push(t);
  }
  return batch;
}

/**
 * DEC-023 point 2: how long a review takes in this repository, from the run logs: in each .autopilot/<run>/live.log, from
 * "reviewer (…) on <ID>" to "verdict on <ID>" (HH:MM:SS, across midnight). → {seconds: median of the last `last`
 * reviews (rounded) or null, samples}
 */
export function reviewDuration(runsDir, last = 10) {
  const toS = (t) => { const [h, m, x] = t.split(':').map(Number); return h * 3600 + m * 60 + x; };
  const durations = [];
  const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(d)).sort() : [];
  for (const run of runs) {
    const f = join(runsDir, run, 'live.log');
    if (!existsSync(f)) continue;
    const open = new Map();
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const start = line.match(/^(\d\d:\d\d:\d\d) autopilot: reviewer \([^)]*\) on (T-\d+):/);
      if (start) { open.set(start[2], toS(start[1])); continue; }
      const end = line.match(/^(\d\d:\d\d:\d\d) autopilot: verdict on (T-\d+):/);
      if (end && open.has(end[2])) {
        let d = toS(end[1]) - open.get(end[2]);
        if (d < 0) d += 86400;
        durations.push(d);
        open.delete(end[2]);
      }
    }
  }
  const xs = durations.slice(-last).sort((a, b) => a - b);
  if (xs.length === 0) return { seconds: null, samples: 0 };
  const mid = Math.floor(xs.length / 2);
  return { seconds: Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2), samples: xs.length };
}

/** id → status of every DEC-NNN of spec/DECISIONS.md ("- Estado: …" under its heading). */
export function decisionStatuses(root) {
  const out = {};
  let cur = null;
  for (const line of combinedDecisions(root).split('\n')) {   // ADRs and DECISIONS.md alike (DEC-035)
    const h = line.match(/^## (DEC-\d+)\b/);
    if (h) { cur = h[1]; continue; }
    const st = cur && line.match(/^- Estado: (\S+)/);
    if (st && !(cur in out)) out[cur] = st[1];
  }
  return out;
}

/**
 * DEC-022 point 1: the first specified task the orchestrator may take to the critic and approve itself: not a spec
 * task, its dependencies closed and every decision it cites accepted, and not in `exclude`. → task | null
 */
export function pickSpecified(root, data, exclude = []) {
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const decs = decisionStatuses(root);
  return data.tasks.find((t) => t.status === 'specified' && (t.kind ?? 'impl') !== 'spec' && !exclude.includes(t.id)
    && (t.depends_on ?? []).every((d) => DONE_STATES.includes(byId.get(d)?.status) && !byId.get(d)?.evidence?.unverified)
    && (t.decisions ?? []).every((d) => decs[d] === 'accepted')) ?? null;
}

/** DEC-028: every status change goes through here: the new status and its status_log entry {from, to, by, at, reason}. */
export function setStatus(t, to, by, reason = '', date = new Date()) {
  if (t.status === to) return;
  t.status_log = [...(t.status_log ?? []), { from: t.status ?? null, to, by, at: date.toISOString(), ...(reason ? { reason } : {}) }];
  t.status = to;
}
/** DEC-028 point 2: statuses that come only from evidence or a review, and those only a person grants. */
export const DERIVED_STATES = ['verified_auto', 'implemented', 'reviewed', 'done'];
export const PERSON_STATES = ['approved_for_impl', 'accepted', 'delivered'];
const SETTABLE_STATES = ['proposed', 'analyzed', 'specified', 'ready', 'in_progress', 'blocked', 'superseded', ...PERSON_STATES];
/** DEC-032: the only statuses an agent may set by hand (set-status); the rest of DEC-028 stays the user's. */
export const AGENT_STATES = ['in_progress', 'blocked'];
export const NOT_A_PERSON = /autopilot|orquestador|orchestrator|claude|codex|agent|agente|revisor|reviewer|implementador|implementer/i;
/** DEC-028 point 2: the only way an interactive session or the user changes a status by hand. */
export function setStatusCmd(root, id, to, { by, reason = '', blockedBy = null } = {}) {
  if (!nonEmpty(by)) throw new Error('set-status needs --by NAME (who changes it)');
  if (DERIVED_STATES.includes(to)) throw new Error(`${to} comes from the evidence or the review (record_evidence.py, set-review), never from set-status (DEC-028)`);
  if (!SETTABLE_STATES.includes(to)) throw new Error(`set-status: unknown status ${to}`);
  if (PERSON_STATES.includes(to) && NOT_A_PERSON.test(by)) throw new Error(`${to}: only a person grants it (--by NAME), not ${by} (DEC-028)`);
  if (NOT_A_PERSON.test(by) && !AGENT_STATES.includes(to)) throw new Error(`an agent may only set in_progress or blocked (DEC-032), not ${to} (--by ${by})`);
  if (to === 'blocked' && !nonEmpty(blockedBy)) throw new Error('blocked needs --blocked-by (Q-NN, REQ, DEC or a dependency)');
  const data = readTasks(root);
  const t = findTask(data, id);
  setStatus(t, to, by.trim(), reason);
  t.blocked_by = to === 'blocked' ? blockedBy : null;
  writeTasks(root, data);
}
/** DEC-029: the block the implementer declared, with the decider's classification (null if it did not settle it). */
export function setBlock(root, id, block, { classification = null, confidence = null, decision = null, branch = null, returned = false } = {}, date = new Date()) {
  if (classification !== null && !BLOCK_CLASSES.includes(classification)) throw new Error(`block classification must be one of ${BLOCK_CLASSES.join(', ')}`);
  const data = readTasks(root);
  const t = findTask(data, id);
  // DEC-031: the date it went back to the implementer is kept across later blocks (it goes back only once)
  const back = returned ? date.toISOString() : t.block?.returned ?? null;
  t.block = { ...block, classification, confidence, decision, branch, at: date.toISOString(), ...(back ? { returned: back } : {}) };
  writeTasks(root, data);
}
/** DEC-028 point 3: the integration as a fact (not a status): the branch it went into and the implementer's commit. */
export function setMerged(root, id, into, commit, date = new Date()) {
  // T-98: never into the batch or a task branch (an interrupted run left HEAD on one and the next took it as the target)
  if (/^autopilot\//.test(into ?? '')) throw new Error(`${id}: refusing merged into ${into}: an autopilot/* branch is not a merge target (T-98)`);
  const data = readTasks(root);
  findTask(data, id).merged = { into, commit, at: date.toISOString() };
  writeTasks(root, data);
}
/** T-110: the merged records that do not match git (into is autopilot/* or missing, the commit is not in into); never
 *  deleted, only listed → [{id, into, commit, reason}]. */
export function mergedMismatches(root, data) {
  const ok = (...args) => spawnSync('git', ['-C', root, ...args], { stdio: 'ignore' }).status === 0;
  const out = [];
  for (const t of data.tasks ?? []) {
    if (!t.merged) continue;
    const { into = null, commit = null } = t.merged;
    let reason = null;
    if (!into || !commit) reason = 'the record has no into or no commit';
    else if (/^autopilot\//.test(into)) reason = `into ${into}: an autopilot/* branch is not a merge target`;
    else if (!ok('rev-parse', '-q', '--verify', `refs/heads/${into}`)) reason = `the branch ${into} does not exist`;
    else if (!ok('cat-file', '-e', `${commit}^{commit}`)) reason = `the commit ${commit} does not exist`;
    else if (!ok('merge-base', '--is-ancestor', commit, `refs/heads/${into}`)) reason = `the commit ${commit} is not in ${into}`;
    if (reason) out.push({ id: t.id, into, commit, reason });
  }
  return out;
}

/** DEC-022 point 3: specified → approved_for_impl by the orchestrator, only with APROBAR on the plan in plan_review. */
export function grantImpl(root, id, by, date = new Date()) {
  const data = readTasks(root);
  const t = findTask(data, id);
  if (t.status !== 'specified') throw new Error(`${id} is ${t.status}, not specified`);
  if (t.plan_review?.effective !== 'APROBAR') throw new Error(`${id} has no plan_review with effective APROBAR`);
  setStatus(t, 'approved_for_impl', by, 'crítica APROBAR fuera de zonas sensibles (DEC-022)', date);
  t.impl_approval = { by, at: date.toISOString(), plan_sha: t.plan_review.plan_sha, plan_commit: t.plan_review.plan_commit };
  writeTasks(root, data);
}

/** Tasks awaiting independent review: the orchestrator reviews them before picking a new task. */
export function pendingReviews(data) {
  return data.tasks.filter((t) => t.status === 'verified_auto').map((t) => t.id);
}

/** States in which a manual check is still pending: the user hasn't accepted the task yet. */
export const MANUAL_PENDING_STATES = ['verified_auto', 'reviewed'];

/**
 * Manual checks deferred to the batch acceptance of the tasks not yet accepted: the implementer's `claims.manual_pending`
 * (a declaration, T-34), or `evidence.manual_pending` of a task recorded before T-34.
 */
export function manualPending(data) {
  const pending = (t) => [t.claims?.manual_pending, t.evidence?.manual_pending].find((v) => typeof v === 'string' && v.trim());
  return data.tasks
    .filter((t) => MANUAL_PENDING_STATES.includes(t.status) && pending(t))
    .map((t) => `${t.id}: ${pending(t).trim().replace(/\.$/, '')}`);
}

export function snapshot(data) {
  return Object.fromEntries(data.tasks.map((t) => [t.id, t.status]));
}

/** Tasks whose status moved to a reserved one since the snapshot (or that appeared already in one). */
export function authorityViolations(before, data) {
  return data.tasks
    .filter((t) => RESERVED_STATES.includes(t.status) && before[t.id] !== t.status)
    .map((t) => `${t.id}: ${before[t.id] ?? '(new)'} → ${t.status}`);
}

/** Markdown section from the id's heading (level 2–4) to the next heading of the same or higher level. */
function section(text, id) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{2,4} ${id}\\b`).test(l));
  if (start < 0) return null;
  const level = /^(#+)/.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6}) /.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

export function context(root, id) {
  const t = findTask(readTasks(root), id);
  const spec = existsSync(join(root, 'spec/SPEC.md')) ? readFileSync(join(root, 'spec/SPEC.md'), 'utf8') : '';
  const decs = combinedDecisions(root);   // ADRs of spec/adr/ and DECISIONS.md alike (DEC-035)
  const out = [];
  out.push(`# Task ${t.id}: ${t.title}`, '');
  if (t.kind) out.push(`- Kind: ${t.kind}`);
  if (t.description) out.push(`- Description: ${t.description}`);
  if (t.verify) out.push(`- Declared verification: ${t.verify}`);
  out.push(`- Cited requirements: ${(t.reqs ?? []).join(', ') || 'none (the description and the declared verification act as the requirement)'}`);
  out.push(`- Cited decisions: ${(t.decisions ?? []).join(', ') || 'none'}`);
  out.push('', '# Requirements (spec/SPEC.md)', '');
  for (const r of t.reqs ?? []) out.push(section(spec, r) ?? `(${r} not found in spec/SPEC.md)`, '');
  if ((t.reqs ?? []).length === 0) out.push('(no product REQ)', '');
  out.push('# Cited accepted decisions (spec/DECISIONS.md)', '');
  for (const d of t.decisions ?? []) out.push(section(decs, d) ?? `(${d} not found in spec/DECISIONS.md)`, '');
  if ((t.decisions ?? []).length === 0) out.push('(none)', '');
  // DEC-036: the other decisions in force the task's agents get (the most recent ADRs and those of its modules)
  let more = [];
  try { more = selectDecisions(root, id, Number(process.env.AUTOPILOT_ADR_RECENT ?? 5)).filter((d) => !(t.decisions ?? []).includes(d.id)); } catch { /* no TASKS.json */ }
  if (more.length) {
    out.push('# Other decisions in force (DEC-036: the most recent ADRs and those of the modules it touches)', '');
    for (const d of more) out.push(section(decs, d.id) ?? `(${d.id})`, '');
  }
  return out.join('\n');
}

/** The reviewer's verdict: the last ```json … ``` block; failing that, the last `{"verdict"…}` in the text; failing that, the whole text. */
export function parseVerdict(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [];
  if (fenced.length > 0) candidates.push(fenced[fenced.length - 1]);
  const raw = text.lastIndexOf('{"verdict"');
  if (raw >= 0) candidates.push(text.slice(raw));
  candidates.push(text.trim());
  for (const c of candidates) {
    const obj = tryParseObject(c);
    if (!obj || typeof obj.verdict !== 'string') continue;
    const verdict = obj.verdict.trim().toLowerCase();
    if (!VERDICTS.includes(verdict)) return null;
    const findings = Array.isArray(obj.findings) ? obj.findings.map(String) : [];
    const v = { verdict, findings, notes: typeof obj.notes === 'string' ? obj.notes : '' };
    // A blocker the reviewer cannot resolve (DEC-005 point 3b): only with a rejection; otherwise it is dropped.
    if (verdict === 'rejected' && typeof obj.research_question === 'string' && obj.research_question.trim()) {
      v.research_question = obj.research_question.trim();
    }
    return v;
  }
  return null;
}

/** Lenient JSON.parse: cuts at the brace that closes the first object. */
function tryParseObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The decide record that confirms a verdict (DEC-015, T-36): question `questionId`, action proceed, the same answer.
 * Returns `{ decision }` (what the task stores) or `{ error }`.
 */
export function confirmingDecision(record, questionId, verdict) {
  if (!record || typeof record !== 'object') return { error: 'the decision record is not a JSON object' };
  if (record.question_id !== questionId) return { error: `the decision answers ${record.question_id}, not ${questionId}` };
  if (record.action !== 'proceed') return { error: `the decision escalated (${record.reason || 'no reason'}): the verdict goes to the user` };
  if (record.answer !== verdict) return { error: `the decision says ${record.answer}, the verdict ${verdict}` };
  return {
    decision: { question_id: questionId, decider: String(record.decider ?? '').split('/').pop().replace(/\.sh$/, ''),
      confidence: record.confidence, threshold: record.threshold, timestamp: record.timestamp,
      ...(record.rule ? { rule: record.rule } : {}) }, // DEC-051: a deterministic rule, not the decider, settled it
  };
}

export function setReview(root, id, review, decision) {
  if (!VERDICTS.includes(review.verdict)) throw new Error(`invalid verdict: ${review.verdict}`);
  const data = readTasks(root);
  const t = findTask(data, id);
  t.review = {
    reviewer: review.reviewer ?? 'desconocido', // value stored in spec/, which stays in Spanish
    verdict: review.verdict,
    findings: review.findings ?? [],
    notes: review.notes ?? '',
    date: review.date ?? new Date().toISOString().slice(0, 10),
    decision, // who decided the verdict (DEC-015): never the reviewer's LLM alone
  };
  if (review.verdict === 'rejected' && nonEmpty(review.research_question)) t.review.research_question = review.research_question.trim();
  // verified_auto → reviewed only with approval (sdd.md §8.2). Rejection: keeps the status and records the verdict.
  if (review.verdict === 'approved' && t.status === 'verified_auto') setStatus(t, 'reviewed', 'set-review', 'veredicto approved confirmado por el decisor');
  writeTasks(root, data);
  return t.status;
}

/** The question the orchestrator opens when a review gives no verdict (DEC-030; its text comes from autopilot.sh). */
export const NO_VERDICT_QUESTION = /revisión no dio veredicto \(DEC-030\)/;
/**
 * T-103: the user's own review (DEC-028, DEC-015): verified_auto → reviewed, or blocked → reviewed when the block is a
 * review without a verdict (DEC-030), whose Q-NN is marked answered. The decision is the user's, so it carries no
 * decide record. Only a session at the user's request calls it; the orchestrator never does.
 */
export function setUserReview(root, id, { by, reason } = {}, date = new Date()) {
  if (!nonEmpty(by)) throw new Error('set-user-review needs --by NAME (the person who reviewed it)');
  if (NOT_A_PERSON.test(by)) throw new Error(`set-user-review: only a person reviews here, not ${by} (DEC-028)`);
  if (!nonEmpty(reason)) throw new Error('set-user-review needs --reason TEXT (the user\'s words approving it)');
  const data = readTasks(root);
  const t = findTask(data, id);
  let lines = null;
  let row = -1;
  if (t.status === 'blocked') {
    lines = readFileSync(specPath(root), 'utf8').split('\n');
    row = /^Q-\d+$/.test(t.blocked_by ?? '') ? lines.findIndex((l) => l.startsWith(`| ${t.blocked_by} |`)) : -1;
    if (row < 0 || !NO_VERDICT_QUESTION.test(lines[row])) {
      throw new Error(`${id} is blocked by ${t.blocked_by}, not by a review without a verdict (DEC-030): set-user-review does not answer it`);
    }
  } else if (t.status !== 'verified_auto') {
    throw new Error(`${id} is ${t.status}: set-user-review takes only verified_auto or blocked by a review without a verdict`);
  }
  const name = by.trim();
  const day = date.toISOString().slice(0, 10);
  t.review = { reviewer: name, verdict: 'approved', findings: [], notes: reason.trim(), date: day, decision: { decider: 'user', by: name } };
  setStatus(t, 'reviewed', name, `revisión del usuario: ${reason.trim()}`, date);
  t.blocked_by = null;
  if (row >= 0) {
    const cells = lines[row].split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    // the original question is already escaped: only the new text goes through cell()
    cells[1] = `${cell(`Respondida ${day} por ${name}: aprobó la revisión de ${id} en persona (set-user-review): «${reason.trim()}».`)} (Pregunta: ${cells[1]})`;
    cells[3] = 'nada';
    lines[row] = `| ${cells.join(' | ')} |`;
    writeFileSync(specPath(root), lines.join('\n'));
  }
  writeTasks(root, data);
  return t.status;
}

/**
 * A retry after research (DEC-005 point 6): a task the reviewer rejected goes back from verified_auto to in_progress so
 * the orchestrator can relaunch the implementer on it. Nothing else is reopened.
 */
export function reopen(root, id) {
  const data = readTasks(root);
  const t = findTask(data, id);
  if (t.status !== 'verified_auto' || t.review?.verdict !== 'rejected') {
    throw new Error(`${id} cannot be reopened: only a verified_auto task with a rejected review (it is ${t.status}${t.review ? `, review ${t.review.verdict}` : ''})`);
  }
  setStatus(t, 'in_progress', 'reopen', 'reintento tras investigar un rechazo (DEC-005)');
  writeTasks(root, data);
  return t.status;
}

/** DEC-006 point 8: the researcher upheld a disputed test; the task goes back to in_progress. */
export function unblock(root, id) {
  const data = readTasks(root);
  const t = findTask(data, id);
  if (t.status !== 'blocked') throw new Error(`${id} cannot be unblocked: it is ${t.status}`);
  setStatus(t, 'in_progress', 'unblock', 'el investigador sostuvo la prueba disputada (DEC-006)');
  t.blocked_by = null;
  writeTasks(root, data);
  return t.status;
}

/** Is `path` one of the acceptance tests of task `id` (tests/acceptance/<ID>.*, <ID>-*, <ID>_* or <ID>/…)? */
export function isTaskAcceptanceFile(path, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^tests/acceptance/${esc}(?:[._-][^/]*|/.+)$`).test(path);
}

/**
 * Validates the test-author's result (DEC-006 point 4) for task `id`: either {"tests": [{"file", "req", "example"}],
 * "red", "log"} or {"blocked", "log"}. `changed` are the files its session left (git status). → { result } | { errors }
 */
export function checkTests(root, id, text, changed) {
  const t = findTask(readTasks(root), id);
  let r;
  try { r = JSON.parse(text); } catch (e) { return { errors: [`not valid JSON (${e.message})`] }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { errors: ['must be a JSON object'] };
  const errors = [];
  for (const k of Object.keys(r)) if (!['tests', 'red', 'log', 'blocked'].includes(k)) errors.push(`unknown key "${k}" (allowed: tests, red, log, blocked)`);
  if (!nonEmpty(r.log)) errors.push('"log" must be a non-empty string (the lines of the spec/LOG.md entry)');
  else if (r.log.split('\n').some((l) => l.startsWith('#'))) errors.push('"log" must not contain headings');
  else if (statesTestResults(r.log)) errors.push(TEST_RESULTS_ERROR);
  if (r.blocked !== undefined) {
    if (!nonEmpty(r.blocked)) errors.push('"blocked" must say why (a REQ without examples, an ambiguity…)');
    if (r.tests !== undefined) errors.push('"blocked" and "tests" are exclusive');
    return errors.length ? { errors } : { result: { blocked: r.blocked.trim(), log: r.log.trim(), tests: [] } };
  }
  if (!Array.isArray(r.tests) || r.tests.length === 0) errors.push('"tests" must be a non-empty array');
  if (!nonEmpty(r.red)) errors.push('"red" must say how the tests failed when run');
  const files = new Set();
  (Array.isArray(r.tests) ? r.tests : []).forEach((x, i) => {
    const where = `tests[${i}]`;
    if (!x || typeof x !== 'object') return errors.push(`${where} must be an object`);
    for (const k of ['file', 'req', 'example']) if (!nonEmpty(x[k])) errors.push(`${where}.${k} must be a non-empty string`);
    if (nonEmpty(x.file) && !isTaskAcceptanceFile(x.file, id)) errors.push(`${where}.file must be tests/acceptance/${id}.*, ${id}-*, ${id}_* or ${id}/…`);
    if (nonEmpty(x.file) && !changed.includes(x.file)) errors.push(`${where}.file ${x.file} was not written in this session`);
    if (nonEmpty(x.req) && !(t.reqs ?? []).includes(x.req)) errors.push(`${where}.req ${x.req} is not cited by ${id}`);
    if (nonEmpty(x.file)) files.add(x.file);
  });
  for (const c of changed) if (!files.has(c)) errors.push(`${c} was written but is not listed in "tests"`);
  if (errors.length) return { errors };
  return { result: { tests: r.tests.map((x) => ({ file: x.file, req: x.req, example: x.example })), red: r.red.trim(), log: r.log.trim(), blocked: null } };
}

/** The user's approval of the test-author's commits (FROM..TO) as the task's acceptance_review (DEC-006 point 6). */
export function approveTests(root, id, by, commits) {
  if (!nonEmpty(by)) throw new Error('approve-tests needs --by NAME (the user who approves)');
  return setAcceptanceReview(root, id, { reviewer: `usuario: ${by.trim()}`, verdict: 'approved', findings: [], notes: 'aprobación del usuario de las pruebas del test-author' }, commits);
}

export const ACCEPTANCE_DIR = 'tests/acceptance/';
const REGULAR_MODES = ['100644', '100755'];

/** A test-runner configuration glob: without "/" it matches the basename, with "/" the whole path; * and ? stay within a segment. */
export function globMatches(glob, path) {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
  return re.test(glob.includes('/') ? path : path.split('/').pop());
}

/**
 * Why a diff is not an additive tests/acceptance/ diff (DEC-004 point 3); [] if it is. `raw` and `numstat` are the
 * NUL-separated (-z) outputs of `git diff --raw -M --no-abbrev` and `git diff --numstat --no-renames` limited to
 * tests/acceptance/; `changed` lists every path the diff changes; `runnerFiles` are globs of test-runner configuration.
 * Additive: only new regular files or added lines there (0 deleted lines, no deletion, rename, copy, type or mode change),
 * at least one of them, and no runner configuration changed outside tests/acceptance/.
 */
export function acceptanceDiffProblems({ raw, numstat, changed, runnerFiles }) {
  const problems = [];
  const tokens = raw.split('\0');
  let entries = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith(':')) continue;
    const [oldMode, newMode, , , status] = tokens[i].slice(1).split(' ');
    const path = tokens[++i];
    entries++;
    if (/^[RC]/.test(status)) problems.push(`${path}: ${status[0] === 'R' ? 'renamed' : 'copied'} to ${tokens[++i]}`);
    else if (status === 'D') problems.push(`${path}: deleted`);
    else if (status === 'A') {
      if (!REGULAR_MODES.includes(newMode)) problems.push(`${path}: new entry is not a regular file (mode ${newMode})`);
    } else if (status === 'M') {
      if (oldMode !== newMode) problems.push(`${path}: mode change ${oldMode} → ${newMode}`);
      else if (!REGULAR_MODES.includes(newMode)) problems.push(`${path}: not a regular file (mode ${newMode})`);
    } else problems.push(`${path}: change of type ${status}`);
  }
  if (entries === 0) problems.push(`no change under ${ACCEPTANCE_DIR}`);
  for (const record of numstat.split('\0').filter(Boolean)) {
    const [added, deleted, path] = record.split('\t');
    if (added === '-' || deleted === '-') problems.push(`${path}: binary change (lines cannot be counted)`);
    else if (deleted !== '0') problems.push(`${path}: ${deleted} line(s) deleted`);
  }
  for (const path of changed) {
    if (path.startsWith(ACCEPTANCE_DIR)) continue;
    const glob = runnerFiles.find((g) => globMatches(g, path));
    if (glob) problems.push(`${path}: test-runner configuration (${glob}) changed outside ${ACCEPTANCE_DIR}`);
  }
  return [...new Set(problems)];
}

/** acceptanceDiffProblems over the git diff from..to of the repository at `root`. */
export function acceptanceCheck(root, from, to, runnerFiles) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return acceptanceDiffProblems({
    raw: git('diff', '--raw', '-z', '-M', '--no-abbrev', from, to, '--', ACCEPTANCE_DIR),
    numstat: git('diff', '--numstat', '-z', '--no-renames', from, to, '--', ACCEPTANCE_DIR),
    changed: git('diff', '--name-only', '-z', '--no-renames', from, to).split('\0').filter(Boolean),
    runnerFiles,
  });
}

/** Stores the reviewer's verdict on the task's tests/acceptance/ diff (DEC-004 point 3). The status does not change. */
export function setAcceptanceReview(root, id, review, commits, decision) {
  if (!VERDICTS.includes(review.verdict)) throw new Error(`invalid verdict: ${review.verdict}`);
  if (!/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(commits ?? '')) throw new Error(`invalid commit range: ${commits}`);
  const data = readTasks(root);
  const t = findTask(data, id);
  if (!(t.kind === 'spec' || (t.kind !== 'tooling' && (t.reqs ?? []).length > 0))) {
    throw new Error(`${id} is neither a spec task nor a task with REQ: it has no acceptance tests to review`);
  }
  t.acceptance_review = {
    reviewer: review.reviewer ?? 'desconocido', // value stored in spec/, which stays in Spanish
    verdict: review.verdict,
    findings: review.findings ?? [],
    notes: review.notes ?? '',
    commits,
    decision,
    date: review.date ?? new Date().toISOString().slice(0, 10),
  };
  writeTasks(root, data);
  return t.acceptance_review.verdict;
}

/**
 * Paths the implementer may not change (DEC-001 point 4): anything under spec/ (written only by the orchestrator) and
 * anything not covered by an entry of `touches` (an entry covers itself and, by segments, everything below it).
 */
export function scopeViolations(task, paths) {
  const touches = task.touches ?? [];
  const covered = (p) => touches.some((e) => {
    const [se, sp] = [segments(e), segments(p)];
    return se.length <= sp.length && se.every((s, i) => s === sp[i]);
  });
  return paths.flatMap((p) => {
    if (segments(p)[0] === 'spec') return [`${p} (spec/ belongs to the orchestrator)`];
    if (!covered(p)) return [`${p} (outside touches: ${touches.join(', ') || 'none declared'})`];
    return [];
  });
}

/**
 * What an implementer may ask for in its result (DEC-014, T-34): it never sets a status. "finished" asks the orchestrator
 * to run the task's verify (record_evidence.py decides verified_auto); "unfinished" and "awaiting_acceptance_approval"
 * (a spec task whose tests/acceptance/ diff waits for the user) only hold the task back; a block is "blocked_by".
 */
export const RESULT_OUTCOMES = ['finished', 'unfinished', 'awaiting_acceptance_approval'];
/** Statuses the orchestrator may apply from a result (verified_auto comes only from record_evidence.py). */
export const APPLY_STATES = ['in_progress', 'blocked'];
const RESULT_KEYS = ['outcome', 'blocked_by', 'claims', 'deploy', 'log', 'notes', 'assumptions', 'test_dispute', 'missing_requirement', 'block'];
/** DEC-029: what an implementer may declare as a block; the decider classifies it into one of BLOCK_CLASSES. */
export const BLOCK_KINDS = ['spec_test_conflict', 'open_question'];
export const BLOCK_CLASSES = ['spec', 'test', 'user_answer', 'implementer'];
const ASSUMPTION_KEYS = ['id', 'belief', 'default', 'class', 'trigger'];
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Does an agent's LOG.md text state test results (T-35, DEC-014)? A "- Verificado…" line or a count such as "25 pasan",
 * "3 tests passed", "1 falla" or "12/12": those lines come from the evidence record_evidence.py wrote, never from an agent.
 */
export function statesTestResults(log) {
  return /^\s*-\s*Verificado/im.test(log) || TEST_COUNT.test(log);
}
const TEST_COUNT = /\b\d+\s*\/\s*\d+\b|\b\d+\s+(?:(?:tests?|pruebas?)\s+)?(?:pasan|pasa|passed|pass(?:ing)?|fallan|falla|fail(?:ed|ing|s)?)\b/i;

/**
 * T-117 (DEC-014, DEC-051): instead of rejecting an implementer's log that states test results, drop them. A
 * "- Verificado…" line is discarded; a line with a test count keeps its clauses (split at ";" and ",", parentheses
 * apart) that state none, if some text with meaning is left, and is discarded otherwise.
 * → { log, discarded: [original lines dropped], trimmed: [original lines cut down] }
 */
export function stripTestResults(log) {
  const kept = [], discarded = [], trimmed = [];
  for (const line of log.split('\n')) {
    if (/^\s*-\s*Verificado/i.test(line)) discarded.push(line);
    else if (!TEST_COUNT.test(line)) kept.push(line);
    else {
      const cut = withoutTestCounts(line);
      if (cut === null) discarded.push(line);
      else { kept.push(cut); trimmed.push(line); }
    }
  }
  return { log: kept.join('\n'), discarded, trimmed };
}

/** `line` without the clauses that state a test count, or null if nothing with meaning is left. */
function withoutTestCounts(line) {
  const [, prefix, rest] = /^(\s*-\s*(?:[^:\d]{1,40}:\s*)?)(.*)$/.exec(line) ?? [null, '', line];
  const end = /[.]\s*$/.test(rest) ? '.' : '';
  const body = rest.replace(/[.\s]+$/, '').replace(/\s*\([^()]*\)/g, (m) => (TEST_COUNT.test(m) ? '' : m));
  const parts = body.split(/\s*([;,])\s*/);
  let out = '';
  for (let i = 0; i < parts.length; i += 2) {
    if (TEST_COUNT.test(parts[i]) || parts[i].trim() === '') continue;
    out += (out ? `${parts[i - 1]} ` : '') + parts[i];
  }
  out = out.replace(/\s*(?:→|->|:)\s*$/, '');
  if (!/\p{L}{3,}/u.test(out)) return null;
  const cut = `${prefix}${out}${end}`;
  return statesTestResults(cut) ? null : cut;
}
const TEST_RESULTS_ERROR = '"log" must not state test results ("- Verificado…" lines or counts like "25 pasan"): the orchestrator writes them from record_evidence.py (DEC-014)';

/** The verification line of LOG.md, from the evidence record_evidence.py wrote (it keeps a log hash); null if none. */
export function verifiedLine(t) {
  const e = t.evidence;
  if (!e || typeof e !== 'object' || !nonEmpty(e.log_sha256) || !nonEmpty(e.command) || !nonEmpty(e.result)) return null;
  return `- Verificado y cómo: \`${e.command}\` → ${e.result.replace(/\.$/, '')}, commit ${String(e.commit ?? '').slice(0, 7)}.`;
}

/** Adds the verification line to the last LOG.md entry, before its "- Próxima acción autorizada" line (or at its end). */
export function logVerified(root, id) {
  const line = verifiedLine(findTask(readTasks(root), id));
  if (!line) return null;
  const logPath = join(root, 'spec/LOG.md');
  const lines = readFileSync(logPath, 'utf8').replace(/\n*$/, '').split('\n');
  const start = lines.findLastIndex((l) => l.startsWith('## '));
  const next = lines.findIndex((l, i) => i > start && l.startsWith('- Próxima acción autorizada'));
  lines.splice(next > start ? next : lines.length, 0, line);
  writeFileSync(logPath, `${lines.join('\n')}\n`);
  return line;
}

/** The LOG.md line of a pending deploy, written by the orchestrator from the result's "deploy" field (T-39). */
export function deployLine(deploy) {
  return `- Pendiente deploy: ${deploy.what.replace(/\.$/, '')}${deploy.then ? `; después: ${deploy.then.replace(/\.$/, '')}` : ''}.`;
}

const specPath = (root) => join(root, 'spec/SPEC.md');

/** Index of the last row of the "## Supuestos" table of SPEC.md (lines), or -1 if there is no such table. */
function assumptionsTableEnd(lines) {
  return tableEnd(lines, /^## Supuestos\b/);
}

/** Index of the last row of the first table under the heading matching `heading` (lines), or -1 if there is none. */
function tableEnd(lines, heading) {
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return -1;
  let i = start + 1;
  while (i < lines.length && !lines[i].startsWith('|') && !/^#{1,2} /.test(lines[i])) i++;
  if (i >= lines.length || !lines[i].startsWith('|')) return -1;
  while (i + 1 < lines.length && lines[i + 1].startsWith('|')) i++;
  return i;
}

/**
 * Validates the implementer's result (JSON text) for task `id`. Returns `{ result }` (normalized), `{ errors }` or
 * `{ authority }` (it proposes a reserved status). Nothing is written.
 */
export function checkResult(root, id, text) {
  const t = findTask(readTasks(root), id);
  let r;
  try {
    r = JSON.parse(text);
  } catch (e) {
    return { errors: [`not valid JSON (${e.message})`] };
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { errors: ['must be a JSON object'] };
  // A reserved status is still an authority violation, though no status belongs in the result any more.
  if (RESERVED_STATES.includes(r.status) && r.status !== t.status) return { authority: [`${id}: ${t.status} → ${r.status}`] };

  const errors = [];
  for (const k of Object.keys(r)) {
    if (k === 'status') errors.push('"status" is not the implementer\'s (DEC-014): the orchestrator derives it from the commits, "blocked_by" and the task\'s verify');
    else if (k === 'evidence') errors.push('"evidence" is written only by record_evidence.py (DEC-014): declarations go in "claims"');
    else if (!RESULT_KEYS.includes(k)) errors.push(`unknown key "${k}" (allowed: ${RESULT_KEYS.join(', ')})`);
  }
  const blockedBy = r.blocked_by ?? null;
  if (blockedBy !== null && !nonEmpty(blockedBy)) errors.push('"blocked_by" must be a non-empty string (a Q-NN, or one of the task\'s REQ, DEC or dependencies)');
  let outcome = r.outcome ?? null;
  if (outcome !== null && !RESULT_OUTCOMES.includes(outcome)) errors.push(`"outcome" must be one of ${RESULT_OUTCOMES.join(', ')}, got ${JSON.stringify(outcome)}`);
  if (blockedBy !== null && outcome !== null) errors.push('"blocked_by" declares a block: no "outcome" with it');
  if (outcome === 'awaiting_acceptance_approval' && t.kind !== 'spec') errors.push('"awaiting_acceptance_approval" is only for a spec task (its tests/acceptance/ diff waits for the user)');
  outcome = blockedBy !== null ? 'blocked' : outcome ?? 'finished';
  // T-39: a pending deploy is a validated field, never a line of free text the orchestrator would have to parse
  const deploy = r.deploy ?? null;
  if (deploy !== null) {
    if (typeof deploy !== 'object' || Array.isArray(deploy) || !nonEmpty(deploy.what) || (deploy.then != null && !nonEmpty(deploy.then))
      || Object.keys(deploy).some((k) => !['what', 'then'].includes(k))) {
      errors.push('"deploy" must be {"what", "then"?}: what to deploy and, optionally, what to run afterwards (non-empty strings)');
    }
    if (blockedBy !== null || r.outcome != null) errors.push('"deploy" goes with no "blocked_by" or "outcome": the task waits for the deploy');
  }
  const block = r.block ?? null; // DEC-029: the orchestrator escalates it with a Q-NN and never retries it
  if (block !== null) {
    if (typeof block !== 'object' || Array.isArray(block)) errors.push('"block" must be {"kind", "detail", "refs"?}');
    else {
      if (!BLOCK_KINDS.includes(block.kind)) errors.push(`"block.kind" must be ${BLOCK_KINDS.join(' or ')}, got ${JSON.stringify(block.kind)}`);
      if (!nonEmpty(block.detail)) errors.push('"block.detail" must be a non-empty string (what contradicts what, or the question)');
      if (block.refs != null && (!Array.isArray(block.refs) || block.refs.some((x) => !nonEmpty(x)))) errors.push('"block.refs" must be a list of ids (REQ, DEC, test files)');
      if (Object.keys(block).some((k) => !['kind', 'detail', 'refs'].includes(k))) errors.push('"block" takes only kind, detail and refs');
    }
    if (blockedBy !== null || r.outcome != null || deploy !== null) errors.push('"block" goes alone: no "blocked_by", "outcome" or "deploy" with it');
  }
  const claims = r.claims ?? null; // declarations, never facts: stored as given, record_evidence.py never touches them
  if (claims !== null) {
    if (typeof claims !== 'object' || Array.isArray(claims)) errors.push('"claims" must be an object of strings (e.g. {"manual_pending": "…"})');
    else for (const [k, v] of Object.entries(claims)) if (typeof v !== 'string') errors.push(`claims.${k} must be a string`);
  }
  // T-117: lines stating test results are dropped (the orchestrator warns about them), not a reason to reject
  const stripped = typeof r.log === 'string' ? stripTestResults(r.log) : { log: r.log, discarded: [], trimmed: [] };
  if (!nonEmpty(r.log)) errors.push('"log" must be a non-empty string (the lines of the spec/LOG.md entry)');
  else if (r.log.split('\n').some((l) => l.startsWith('#'))) {
    errors.push('"log" must not contain headings (lines starting with #): the orchestrator writes the entry heading');
  } else if (!nonEmpty(stripped.log)) errors.push(`"log" is left empty once its test results are dropped: ${TEST_RESULTS_ERROR}`);
  else if (/^\s*-\s*Pendiente deploy/im.test(r.log)) errors.push('"log" must not carry a "Pendiente deploy" line: a deploy goes in "deploy" {what, then} and the orchestrator writes the line (T-39)');
  if (r.notes != null && typeof r.notes !== 'string') errors.push('"notes" must be a string');
  const dispute = r.test_dispute ?? null; // DEC-006 point 8: a test the implementer believes wrong, never edited
  if (dispute !== null) {
    if (typeof dispute !== 'object' || Array.isArray(dispute) || !nonEmpty(dispute.file) || !nonEmpty(dispute.reason)) {
      errors.push('"test_dispute" must be {"file", "reason"} (non-empty strings)');
    } else if (!dispute.file.startsWith('tests/acceptance/')) errors.push('"test_dispute.file" must be under tests/acceptance/');
    // T-40: the disputed test is a fact: it exists and it is one of the task's own tests
    else if (!existsSync(join(root, dispute.file.trim()))) errors.push(`"test_dispute.file" ${dispute.file.trim()} does not exist`);
    else if (!dispute.file.trim().slice('tests/acceptance/'.length).startsWith(id)) errors.push(`"test_dispute.file" must be one of ${id}'s tests (tests/acceptance/${id}*)`);
    if (blockedBy === null) errors.push('"test_dispute" is only allowed with "blocked_by"');
    else if (!(t.reqs ?? []).includes(blockedBy)) errors.push('with "test_dispute", "blocked_by" must be the REQ the test encodes (one of the task\'s reqs)');
  }
  // DEC-011 point 3: lines no acceptance test citing a REQ reaches that the implementer believes are needed.
  const missing = r.missing_requirement ?? null;
  if (missing !== null) {
    if (typeof missing !== 'object' || Array.isArray(missing) || !nonEmpty(missing.lines) || !nonEmpty(missing.reason)) {
      errors.push('"missing_requirement" must be {"lines", "reason"} (non-empty strings: the file:lines and why they are needed)');
    } else {
      // T-40: the lines are a fact: each <path>:<line>[-<line>] names an existing file of the task's touches, within it
      for (const ref of missing.lines.split(',').map((x) => x.trim()).filter(Boolean)) {
        const m = /^([^\s:]+):(\d+)(?:-(\d+))?$/.exec(ref);
        if (!m) { errors.push(`"missing_requirement.lines" must be <path>:<line>[-<line>] (comma-separated), got ${JSON.stringify(ref)}`); continue; }
        const [, rel, a, b] = m;
        if (!existsSync(join(root, rel))) errors.push(`"missing_requirement.lines": ${rel} does not exist`);
        else if (scopeViolations(t, [rel]).length) errors.push(`"missing_requirement.lines": ${rel} is outside ${id}'s touches`);
        else {
          const n = readFileSync(join(root, rel), 'utf8').replace(/\n$/, '').split('\n').length;
          if (Number(a) < 1 || Number(b ?? a) < Number(a) || Number(b ?? a) > n) errors.push(`"missing_requirement.lines": ${ref} is beyond its ${n} lines`);
        }
      }
    }
    if (blockedBy === null) errors.push('"missing_requirement" is only allowed with "blocked_by"');
  }

  const assumptions = r.assumptions ?? [];
  if (!Array.isArray(assumptions)) errors.push('"assumptions" must be an array');
  else if (assumptions.length > 0) {
    const spec = existsSync(specPath(root)) ? readFileSync(specPath(root), 'utf8') : '';
    if (assumptionsTableEnd(spec.split('\n')) < 0) errors.push('spec/SPEC.md has no "## Supuestos" table to add the assumptions to');
    const seen = new Set([...spec.matchAll(/^\| (S-\d+)\b/gm)].map((m) => m[1]));
    assumptions.forEach((a, i) => {
      const where = `assumptions[${i}]`;
      if (!a || typeof a !== 'object' || Array.isArray(a)) return errors.push(`${where} must be an object`);
      for (const k of Object.keys(a)) if (!ASSUMPTION_KEYS.includes(k)) errors.push(`${where}: unknown key "${k}" (allowed: ${ASSUMPTION_KEYS.join(', ')})`);
      for (const k of ASSUMPTION_KEYS) if (!nonEmpty(a[k])) errors.push(`${where}.${k} must be a non-empty string`);
      if (!nonEmpty(a.id)) return;
      if (!/^S-\d+$/.test(a.id)) errors.push(`${where}.id must be S-NN, got ${JSON.stringify(a.id)}`);
      else if (seen.has(a.id)) errors.push(`${where}.id ${a.id} already exists in spec/SPEC.md or the result`);
      seen.add(a.id);
    });
  }
  if (errors.length > 0) return { errors };
  return {
    result: {
      outcome, blocked_by: blockedBy ? blockedBy.trim() : null, claims, log: stripped.log.trim(),
      log_discarded: stripped.discarded, log_trimmed: stripped.trimmed, notes: nonEmpty(r.notes) ? r.notes.trim() : null,
      assumptions, deploy: deploy && { what: deploy.what.trim(), then: nonEmpty(deploy.then) ? deploy.then.trim() : null },
      deploy_pending: deploy !== null,
      test_dispute: dispute ? { file: dispute.file.trim(), reason: dispute.reason.trim() } : null,
      block: block ? { kind: block.kind, detail: block.detail.trim(), refs: (block.refs ?? []).map((x) => x.trim()) } : null,
      missing_requirement: missing ? { lines: missing.lines.trim(), reason: missing.reason.trim() } : null,
    },
  };
}

const cell = (s) => s.trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Applies a result validated by checkResult with the status the orchestrator derived (`status`: in_progress or
 * blocked, agreeing with blocked_by): the orchestrator is the only writer of spec/ (DEC-001 point 4). Never evidence.
 */
export function applyResult(root, id, result, agent, status, date = new Date()) {
  const data = readTasks(root);
  const t = findTask(data, id);
  setStatus(t, status, 'apply-result', `resultado del ${agent}`, date);
  t.blocked_by = result.blocked_by;
  if (result.claims) t.claims = result.claims;
  if (result.notes) t.notes = t.notes ? `${t.notes} ${result.notes}` : result.notes;
  if (result.test_dispute) {
    const d = `${stamp(date).slice(0, 10)}: el implementador disputa ${result.test_dispute.file}: ${result.test_dispute.reason} (DEC-006; no la edita).`;
    t.notes = t.notes ? `${t.notes} ${d}` : d;
  }
  if (result.missing_requirement) {
    const m = `${stamp(date).slice(0, 10)}: falta un requisito según el implementador para ${result.missing_requirement.lines}: ${result.missing_requirement.reason} (DEC-011).`;
    t.notes = t.notes ? `${t.notes} ${m}` : m;
  }
  if (result.assumptions.length > 0) {
    const lines = readFileSync(specPath(root), 'utf8').split('\n');
    const rows = result.assumptions.map((a) => `| ${ASSUMPTION_KEYS.map((k) => cell(a[k])).join(' | ')} |`);
    lines.splice(assumptionsTableEnd(lines) + 1, 0, ...rows);
    writeFileSync(specPath(root), lines.join('\n'));
  }
  writeTasks(root, data);
  const logPath = join(root, 'spec/LOG.md');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  let text = result.log;
  if (result.deploy) { // before the "Próxima acción autorizada" line, if any
    const lines = text.split('\n');
    const next = lines.findIndex((l) => l.startsWith('- Próxima acción autorizada'));
    lines.splice(next >= 0 ? next : lines.length, 0, deployLine(result.deploy));
    text = lines.join('\n');
  }
  writeFileSync(logPath, `${log.replace(/\n*$/, '\n')}\n## ${stamp(date)} · ${agent}\n${text}\n`);
  return t.status;
}

/** Sections of a researcher's report (DEC-005 point 5), in Spanish like the rest of the project's records. */
export const RESEARCH_SECTIONS = ['Causa probable', 'Evidencia', 'Fuentes', 'Recomendación'];
export const RESEARCH_ACTIONS = ['reintentar', 'recortar', 'escalar'];
export const RESEARCH_CONFIDENCE = ['alta', 'media', 'baja'];

/**
 * Validates a researcher's report (Markdown). Returns `{ report: { action, confidence, cut } }` or `{ errors }`.
 * Required: the RESEARCH_SECTIONS as `## ` headings with content, and the lines `Acción sugerida: …` and
 * `Confianza: …` (list markers and bold are tolerated); with `recortar`, a `## Recorte propuesto` section with
 * `Título:` and `Descripción:` (the description runs to the end of the section).
 */
export function researchCheck(text) {
  const lines = text.split('\n');
  const plain = (l) => l.replace(/\*\*/g, '').replace(/^\s*[-*]\s+/, '').trim();
  const sections = new Map();
  let current = null;
  for (const l of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    if (m) { current = m[1].replace(/\*\*/g, '').trim(); sections.set(current, []); continue; }
    if (/^#\s/.test(l)) { current = null; continue; }
    if (current) sections.get(current).push(l);
  }
  const body = (name) => (sections.get(name) ?? []).join('\n').trim();
  const errors = [];
  for (const name of RESEARCH_SECTIONS) {
    if (!sections.has(name)) errors.push(`missing the "## ${name}" section`);
    else if (!body(name)) errors.push(`the "## ${name}" section is empty`);
  }
  const field = (key, allowed) => {
    const values = lines.map(plain).flatMap((l) => {
      const m = new RegExp(`^${key}\\s*:\\s*(.*?)\\.?\\s*$`, 'i').exec(l);
      return m ? [m[1].trim().toLowerCase()] : [];
    });
    if (values.length === 0) { errors.push(`missing the "${key}: ${allowed.join(' | ')}" line`); return null; }
    if (values.length > 1) { errors.push(`more than one "${key}:" line`); return null; }
    if (!allowed.includes(values[0])) { errors.push(`"${key}" must be one of ${allowed.join(', ')}, got ${JSON.stringify(values[0])}`); return null; }
    return values[0];
  };
  const action = field('Acción sugerida', RESEARCH_ACTIONS);
  const confidence = field('Confianza', RESEARCH_CONFIDENCE);
  let cut = null;
  if (action === 'recortar') {
    if (!sections.has('Recorte propuesto')) errors.push('"recortar" needs a "## Recorte propuesto" section');
    else {
      const cutLines = sections.get('Recorte propuesto').map(plain);
      const title = cutLines.flatMap((l) => /^Título\s*:\s*(.+)$/i.exec(l)?.[1].trim() ?? [])[0];
      const at = cutLines.findIndex((l) => /^Descripción\s*:/i.test(l));
      const description = at < 0 ? '' : [cutLines[at].replace(/^Descripción\s*:\s*/i, ''), ...cutLines.slice(at + 1)].join(' ').replace(/\s+/g, ' ').trim();
      if (!nonEmpty(title)) errors.push('the "## Recorte propuesto" section needs a "Título:" line');
      if (!nonEmpty(description)) errors.push('the "## Recorte propuesto" section needs a "Descripción:"');
      if (nonEmpty(title) && nonEmpty(description)) cut = { title, description };
    }
  }
  return errors.length > 0 ? { errors } : { report: { action, confidence, cut } };
}

const nextId = (ids, prefix) => `${prefix}-${pad(Math.max(0, ...ids.map((x) => Number(x.slice(prefix.length + 1)))) + 1)}`;

/**
 * Escalates task `id` to the user (DEC-005 point 7): a new blocking Q-NN in the "## Preguntas abiertas" table of
 * SPEC.md that points to the report, and the task blocked by it. With `cut` ({title, description}), the split-off work
 * becomes a new task in `specified` (not eligible: nothing moves without the user's approval) and the question asks to
 * approve the cut. Texts in Spanish (spec/ stays in Spanish). Returns { question, task }.
 */
export function escalate(root, id, { reason, report = null, cut = null, after = 'tras investigarla' }) {
  if (!nonEmpty(reason)) throw new Error('escalate needs --reason');
  const data = readTasks(root);
  const t = findTask(data, id);
  const lines = readFileSync(specPath(root), 'utf8').split('\n');
  const end = tableEnd(lines, /^## Preguntas abiertas\b/);
  if (end < 0) throw new Error('spec/SPEC.md has no "## Preguntas abiertas" table to add the question to');
  const q = nextId([...lines.join('\n').matchAll(/^\| (Q-\d+)\b/gm)].map((m) => m[1]), 'Q');
  const where = report ? `informe en ${report}` : 'sin informe';
  let newTask = null;
  let question;
  if (cut) {
    newTask = {
      id: nextId(data.tasks.map((x) => x.id).filter((x) => /^T-\d+$/.test(x)), 'T'),
      ...(t.kind ? { kind: t.kind } : {}),
      title: cut.title,
      description: cut.description,
      reqs: t.reqs ?? [], decisions: t.decisions ?? [], depends_on: [id],
      status: 'specified', touches: t.touches ?? [],
      evidence: null, review: null, blocked_by: null,
      notes: `${stamp(new Date()).slice(0, 10)}: creada por el orquestador (DEC-005) con el recorte de ${id} propuesto por el investigador (${where}); queda specified hasta que el usuario apruebe el recorte (${q}).`,
    };
    question = `¿Aprobar el recorte de ${id} propuesto por el investigador (${where})? ${newTask.id} (specified) toma «${cut.title}»; al aprobarlo, ${id} se reduce a lo demás. Motivo: ${reason}.`;
  } else {
    question = `¿Cómo sigue ${id}? El orquestador la escaló ${after}: ${reason} (${where}).`;
  }
  lines.splice(end + 1, 0, `| ${q} | ${cell(question)} | bloqueante | ${[id, newTask?.id].filter(Boolean).join(', ')} | usuario | — |`);
  writeFileSync(specPath(root), lines.join('\n'));
  setStatus(t, 'blocked', 'escalate', `escalada al usuario por ${q}`);
  t.blocked_by = q;
  const note = `${stamp(new Date()).slice(0, 10)}: escalada por el orquestador (DEC-005): ${reason}; ${where}; bloqueada por ${q}${newTask ? `; recorte propuesto en ${newTask.id}` : ''}.`;
  t.notes = t.notes ? `${t.notes} ${note}` : note;
  if (newTask) data.tasks.push(newTask);
  writeTasks(root, data);
  return { question: q, task: newTask?.id ?? null };
}

/** Sections of a plan (DEC-010 point 2), in this order and no other; plans/ stays in Spanish like research/. */
export const PLAN_SECTIONS = ['Objetivo', 'Pasos', 'Archivos', 'Supuestos', 'Riesgos', 'Verificación'];
export const CRITIC_VERDICTS = ['APROBAR', 'REVISAR', 'ESCALAR'];
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const EVIDENCE_TYPES = ['fuente', 'archivo', 'opinión'];
const URL_RE = /^https?:\/\/[^\s<>"']+\.[^\s<>"']+$/;
const FINDING_ID_RE = /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

/** Problems of plans/<ID>.md (DEC-010 point 2): "# Plan de <ID>" and exactly the fixed sections, none empty. */
export function planErrors(text, id) {
  const errors = [];
  const lines = text.split('\n');
  const first = lines.find((l) => l.trim() !== '');
  if (first?.trim() !== `# Plan de ${id}`) errors.push(`the plan must start with "# Plan de ${id}"`);
  if (lines.filter((l) => /^#\s/.test(l)).length > 1) errors.push('the plan has more than one "# " heading');
  const found = [];
  const bodies = new Map();
  for (const l of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    if (m) { found.push(m[1]); bodies.set(m[1], []); continue; }
    if (found.length && !/^#\s/.test(l)) bodies.get(found[found.length - 1]).push(l);
  }
  const extra = found.filter((s) => !PLAN_SECTIONS.includes(s));
  if (extra.length) errors.push(`sections not allowed: ${extra.map((s) => `"## ${s}"`).join(', ')} (only ${PLAN_SECTIONS.join(', ')})`);
  for (const s of PLAN_SECTIONS) {
    const n = found.filter((x) => x === s).length;
    if (n === 0) errors.push(`missing the "## ${s}" section`);
    else if (n > 1) errors.push(`the "## ${s}" section appears ${n} times`);
    else if (!bodies.get(s).join('\n').trim()) errors.push(`the "## ${s}" section is empty`);
  }
  const order = found.filter((s) => PLAN_SECTIONS.includes(s));
  if (!extra.length && order.length === PLAN_SECTIONS.length && order.some((s, i) => s !== PLAN_SECTIONS[i])) {
    errors.push(`the sections must follow this order: ${PLAN_SECTIONS.join(', ')}`);
  }
  return errors;
}

/** The critic's answer: the last ```json … ``` block of its final text, or the whole text. */
export function parseCritic(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const c of [...fenced.reverse(), text.trim()]) {
    const obj = tryParseObject(c);
    if (obj && (obj.verdict !== undefined || obj.research_requests !== undefined)) return obj;
  }
  return null;
}

/**
 * Validates the critic's answer (DEC-010 points 4 to 6) → { verdict, effective, assumptions, findings, blocking,
 * opinion_blockers, repeated, summary } or { research_requests } or { errors }. `readable`: the paths the critic may
 * read (a directory ends in "/"); `archivo` evidence must name an existing line of one of them. `previous`: blocking
 * finding ids of the earlier round; one repeated means ESCALAR. Research requests only when `allowRequests`.
 */
export function criticCheck(root, obj, { readable = [], previous = [], allowRequests = false } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { errors: ['no JSON object with "verdict" in the critic\'s answer'] };
  const errors = [];
  const asks = !(Array.isArray(obj.research_requests) && obj.research_requests.length === 0) && obj.research_requests !== undefined;
  if (asks && (obj.verdict === undefined || allowRequests)) {
    const rq = obj.research_requests;
    if (!allowRequests) return { errors: ['research_requests are not allowed in this session: give a verdict'] };
    if (!Array.isArray(rq) || rq.length < 1 || rq.length > 2 || !rq.every(nonEmpty)) {
      return { errors: ['research_requests must be 1 or 2 non-empty questions'] };
    }
    if (obj.verdict === undefined) return { research_requests: rq.map((q) => q.trim()) };
  }
  const verdict = typeof obj.verdict === 'string' ? obj.verdict.trim().toUpperCase() : obj.verdict;
  if (!CRITIC_VERDICTS.includes(verdict)) errors.push(`verdict must be one of ${CRITIC_VERDICTS.join(', ')}, got ${JSON.stringify(obj.verdict)}`);
  const assumptions = Array.isArray(obj.assumptions) ? obj.assumptions : null;
  if (!assumptions || assumptions.length < 3 || assumptions.length > 5) {
    errors.push('assumptions must list the 3 to 5 riskiest assumptions of the plan');
  } else {
    assumptions.forEach((a, i) => {
      if (!nonEmpty(a?.assumption)) errors.push(`assumptions[${i}].assumption must be a non-empty string`);
      if (!nonEmpty(a?.practice)) errors.push(`assumptions[${i}].practice must say how it is solved in practice`);
      // An assumption the critic found no source for may say so (empty sources); every source given is a URL.
      if (!Array.isArray(a?.sources) || !a.sources.every((u) => URL_RE.test(String(u)))) {
        errors.push(`assumptions[${i}].sources must be a list of URLs (http/https)`);
      }
    });
    if (assumptions.filter((a) => Array.isArray(a?.sources) && a.sources.length > 0).length < 3) {
      errors.push('at least 3 assumptions must cite a URL of how it is solved in practice');
    }
  }
  const findings = Array.isArray(obj.findings) ? obj.findings : null;
  if (!findings) errors.push('findings must be an array');
  const fileLines = (rel) => {
    const path = join(root, rel);
    try { return readFileSync(path, 'utf8').split('\n').length; } catch { return 0; }
  };
  const isReadable = (rel) => readable.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
  const seen = new Set();
  for (const [i, f] of (findings ?? []).entries()) {
    const where = `findings[${i}]${nonEmpty(f?.id) ? ` (${f.id})` : ''}`;
    if (!FINDING_ID_RE.test(f?.id ?? '')) errors.push(`${where}: id must be "<area>:<slug>" in lowercase (e.g. "req-002:sin-caso-vacio")`);
    else if (seen.has(f.id)) errors.push(`${where}: duplicate id`);
    else seen.add(f.id);
    if (!SEVERITIES.includes(f?.severity)) errors.push(`${where}: severity must be one of ${SEVERITIES.join(', ')}`);
    const type = f?.evidence_type === 'opinion' ? 'opinión' : f?.evidence_type;
    if (!EVIDENCE_TYPES.includes(type)) errors.push(`${where}: evidence_type must be one of ${EVIDENCE_TYPES.join(', ')}`);
    if (!nonEmpty(f?.evidence)) errors.push(`${where}: evidence must be a non-empty string`);
    // The evidence starts with its URL or its <path>:<line>; a short comment may follow (real critics add one).
    else if (type === 'fuente' && !URL_RE.test(f.evidence.trim().split(/\s/)[0].replace(/[),.;]+$/, ''))) {
      errors.push(`${where}: "fuente" evidence must start with a URL (http/https)`);
    } else if (type === 'archivo') {
      const m = /^`?([^\s`]+?):(\d+)(?:-(\d+))?(?:`|\s|$)/.exec(f.evidence.trim());
      if (!m) errors.push(`${where}: "archivo" evidence must start with <path>:<line>`);
      else {
        const rel = m[1].replace(/^\.\//, '');
        const last = Number(m[3] ?? m[2]);
        if (!isReadable(rel)) errors.push(`${where}: ${rel} is not one of the files the critic may read`);
        else if (Number(m[2]) < 1 || last < Number(m[2]) || last > fileLines(rel)) errors.push(`${where}: ${f.evidence.trim()} does not exist`);
      }
    }
    if (!nonEmpty(f?.summary)) errors.push(`${where}: summary must be a non-empty string`);
    if (!nonEmpty(f?.fix)) errors.push(`${where}: fix must say what to change`);
    if (f) f.evidence_type = type;
  }
  if (errors.length) return { errors };
  const blocks = (f) => ['P0', 'P1'].includes(f.severity);
  const blocking = findings.filter((f) => blocks(f) && f.evidence_type !== 'opinión').map((f) => f.id);
  const opinionBlockers = findings.filter((f) => blocks(f) && f.evidence_type === 'opinión').map((f) => f.id);
  const repeated = blocking.filter((id) => previous.includes(id));
  // DEC-010 point 5: the critic may escalate; otherwise a blocking finding (P0/P1 with a source or a file line) means
  // REVISAR whatever it said, and one repeated from the earlier round means ESCALAR.
  let effective = 'APROBAR';
  if (verdict === 'ESCALAR' || repeated.length) effective = 'ESCALAR';
  else if (blocking.length) effective = 'REVISAR';
  return {
    verdict, effective,
    assumptions: assumptions.map((a) => ({ assumption: a.assumption.trim(), practice: a.practice.trim(), sources: a.sources.map(String) })),
    findings: findings.map((f) => ({ id: f.id, severity: f.severity, evidence_type: f.evidence_type, evidence: f.evidence.trim(), summary: f.summary.trim(), fix: f.fix.trim() })),
    blocking, opinion_blockers: opinionBlockers, repeated,
    summary: nonEmpty(obj.summary) ? obj.summary.trim() : '',
  };
}

/** Stores the critique of the task's plan (DEC-010 point 7) as its plan_review; the gate opens only with APROBAR. */
export function setPlanReview(root, id, check, { planSha, planCommit, round, critic, date = new Date().toISOString().slice(0, 10) }) {
  if (!/^[0-9a-f]{40}$/.test(planSha ?? '')) throw new Error(`invalid plan blob sha: ${planSha}`);
  if (!/^[0-9a-f]{7,40}$/.test(planCommit ?? '')) throw new Error(`invalid plan commit: ${planCommit}`);
  if (![1, 2].includes(Number(round))) throw new Error(`invalid round: ${round}`);
  const data = readTasks(root);
  const t = findTask(data, id);
  if (t.kind === 'spec') throw new Error(`${id} is a spec task: it has no plan gate`);
  t.plan_review = {
    critic: critic ?? 'desconocido', verdict: check.verdict, effective: check.effective, round: Number(round),
    plan: `plans/${id}.md`, plan_sha: planSha, plan_commit: planCommit,
    findings: check.findings.map(({ id: fid, severity, evidence_type, evidence, summary }) => ({ id: fid, severity, evidence_type, evidence, summary })),
    opinion_blockers: check.opinion_blockers, date,
  };
  writeTasks(root, data);
  return t.plan_review.effective;
}

/** A researcher's answer to a question of the plan's critic (DEC-010 point 4): "## Respuesta" and "## Fuentes" with a URL. */
export function questionReportErrors(text) {
  const errors = [];
  const sections = new Map();
  let current = null;
  for (const l of text.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(l);
    if (m) { current = m[1].trim(); sections.set(current, []); continue; }
    if (current) sections.get(current).push(l);
  }
  for (const s of ['Pregunta', 'Respuesta', 'Fuentes']) {
    if (!sections.has(s) || !sections.get(s).join('\n').trim()) errors.push(`missing or empty "## ${s}" section`);
  }
  if (sections.has('Fuentes') && !/https?:\/\/\S+/.test(sections.get('Fuentes').join('\n'))) errors.push('"## Fuentes" cites no URL');
  return errors;
}

/** Titles of the tasks the orchestrator keeps for DEC-011 (it creates each one once; the title is its key). */
export const COVERAGE_ENABLE_TITLE = 'Habilitar la cobertura desde aceptación (DEC-011 de sdd-base)';
export const coverageCleanupTitle = (file) => `Código no alcanzado en ${file} (DEC-011 de sdd-base)`;

/**
 * DEC-011 points 4 and 6: without spec/COVERAGE.json, a specified task to run acceptance locally with coverage; with a
 * baseline, a specified cleanup-or-specification task per file that still has old unreached lines. Each is created
 * once (a task with its title already exists → nothing). → { out_of_rule, created: [{id, title}], existing: [ids] }.
 */
export function ensureCoverageTasks(root, { dryRun = false, date = new Date() } = {}) {
  const data = readTasks(root);
  const cfgPath = join(root, 'spec/COVERAGE.json');
  const outOfRule = !existsSync(cfgPath);
  const wanted = [];
  if (outOfRule) {
    wanted.push({
      title: COVERAGE_ENABLE_TITLE, kind: 'tooling', touches: ['package.json'],
      description: 'DEC-011 de sdd-base: toda línea de código debe ejecutarla una prueba de tests/acceptance/ que cite un REQ, medido en local. Este repo está fuera de la regla porque no tiene spec/COVERAGE.json. Hacer que la aceptación corra también en local con cobertura (lcov), aunque hoy corra contra un entorno desplegado (esa corrida queda como humo), y proponer en notes el spec/COVERAGE.json (command con {files} y {lcov}, sources, tests, excepciones con DEC) para que el usuario lo agregue y adopte la línea base con node scripts/check-coverage.mjs adopt. Al aprobarla, el usuario ajusta touches a lo que haga falta.',
      verify: 'npm run check:coverage && npm test',
    });
  } else {
    let baseline = {};
    try { baseline = JSON.parse(readFileSync(cfgPath, 'utf8')).baseline ?? {}; } catch { /* check:spec reports it */ }
    for (const [file, n] of Object.entries(baseline)) {
      wanted.push({
        title: coverageCleanupTitle(file), touches: [file],
        description: `DEC-011 de sdd-base: la línea base de spec/COVERAGE.json tolera ${n} línea(s) de ${file} que ninguna prueba de tests/acceptance/ que cite un REQ ejecuta (node scripts/check-coverage.mjs las lista). Borrar las que sean código muerto, con las pruebas en verde; si alguna es necesaria, no inventar pruebas ni REQ: proponer blocked con missing_requirement (falta un requisito). El orquestador baja la línea base al terminar.`,
        verify: 'npm run check:coverage && npm test',
      });
    }
  }
  const created = [];
  const existing = [];
  for (const w of wanted) {
    const found = data.tasks.find((t) => t.title === w.title);
    if (found) { existing.push(found.id); continue; }
    const id = nextId(data.tasks.map((x) => x.id).filter((x) => /^T-\d+$/.test(x)), 'T');
    data.tasks.push({
      id, ...(w.kind ? { kind: w.kind } : {}), title: w.title, description: w.description, reqs: [], decisions: [],
      depends_on: [], status: 'specified', touches: w.touches, verify: w.verify, evidence: null, review: null, blocked_by: null,
      notes: `${stamp(date).slice(0, 10)}: creada por el orquestador (DEC-011 de sdd-base); queda specified hasta que el usuario la apruebe.`,
    });
    created.push({ id, title: w.title });
  }
  if (created.length && !dryRun) writeTasks(root, data);
  return { out_of_rule: outOfRule, created, existing };
}

function main(argv) {
  let root = fileURLToPath(new URL('../..', import.meta.url));
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else rest.push(argv[i]);
  }
  const [cmd, ...args] = rest;
  const out = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const exclude = () => (opt('--exclude') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const brief = (t) => ({
    id: t.id, title: t.title, kind: t.kind ?? 'impl', status: t.status,
    reqs: t.reqs ?? [], decisions: t.decisions ?? [], touches: t.touches ?? [],
  });

  switch (cmd) {
    case 'pick': {
      const t = pick(readTasks(root), opt('--task'), exclude());
      out(t ? brief(t) : null);
      return 0;
    }
    case 'pick-batch': {
      const max = Number(opt('--max'));
      if (!Number.isInteger(max) || max < 1) {
        console.error(`autopilot-tasks: pick-batch needs --max N (integer ≥ 1), got ${JSON.stringify(opt('--max'))}`);
        return 2;
      }
      out(pickBatch(readTasks(root), max, exclude()).map(brief));
      return 0;
    }
    case 'review-duration':
      out(reviewDuration(opt('--runs') ?? join(root, '.autopilot'), Number(opt('--last') ?? 10)));
      return 0;
    case 'pick-specified': {
      const data = readTasks(root);
      const t = pickSpecified(root, data, exclude());
      out(t ? brief(t) : null);
      return 0;
    }
    case 'set-status':
      setStatusCmd(root, args[0], args[1], { by: opt('--by'), reason: opt('--reason') ?? '', blockedBy: opt('--blocked-by') ?? null });
      return 0;
    case 'set-block': {
      const b = JSON.parse(readFileSync(opt('--file'), 'utf8'));
      const num = opt('--confidence');
      setBlock(root, args[0], b, { classification: opt('--classification') || null, confidence: num ? Number(num) : null,
        decision: opt('--decision') || null, branch: opt('--branch') || null, returned: args.includes('--returned') });
      return 0;
    }
    case 'set-merged':
      setMerged(root, args[0], opt('--into'), opt('--commit'));
      return 0;
    case 'merged-check':
      out(mergedMismatches(root, readTasks(root)));
      return 0;
    case 'grant-impl':
      grantImpl(root, args[0], opt('--by') ?? 'autopilot');
      return 0;
    case 'pending-reviews':
      out(pendingReviews(readTasks(root)));
      return 0;
    case 'manual-pending':
      out(manualPending(readTasks(root)));
      return 0;
    case 'snapshot':
      out(snapshot(readTasks(root)));
      return 0;
    case 'check-authority': {
      const before = JSON.parse(readFileSync(args[0], 'utf8'));
      const v = authorityViolations(before, readTasks(root));
      if (v.length > 0) {
        console.error(`autopilot: the executor granted reserved statuses (${RESERVED_STATES.join(', ')}):`);
        for (const line of v) console.error(`  ✗ ${line}`);
        return 1;
      }
      return 0;
    }
    case 'status':
      out(findTask(readTasks(root), args[0]).status);
      return 0;
    case 'kind':
      out(findTask(readTasks(root), args[0]).kind ?? 'impl');
      return 0;
    case 'touches':
      out((findTask(readTasks(root), args[0]).touches ?? []).join(', ') || '(none declared)');
      return 0;
    case 'context':
      out(context(root, args[0]));
      return 0;
    case 'parse-verdict': {
      const v = parseVerdict(readFileSync(args[0], 'utf8'));
      if (!v) {
        console.error('autopilot: the reviewer output contains no valid JSON verdict');
        return 1;
      }
      out(v);
      return 0;
    }
    case 'set-review':
    case 'set-acceptance-review': {
      const review = JSON.parse(readFileSync(args[1], 'utf8'));
      if (!VERDICTS.includes(review.verdict)) throw new Error(`invalid verdict: ${review.verdict}`);
      const file = opt('--decision');
      const questionId = cmd === 'set-review' ? 'review_verdict' : 'acceptance_verdict';
      if (!file || !existsSync(file)) {
        console.error(`autopilot-tasks: ${cmd} needs --decision FILE: the decide record (${questionId}) that confirms the verdict (DEC-015)`);
        return 2;
      }
      let record;
      try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { record = null; }
      const c = confirmingDecision(record, questionId, review.verdict);
      if (c.error) { console.error(`autopilot-tasks: ${cmd}: ${c.error}`); return 2; }
      out(cmd === 'set-review' ? setReview(root, args[0], review, c.decision) : setAcceptanceReview(root, args[0], review, opt('--commits'), c.decision));
      return 0;
    }
    case 'set-user-review':
      out(setUserReview(root, args[0], { by: opt('--by'), reason: opt('--reason') }));
      return 0;
    case 'reopen':
      out(reopen(root, args[0]));
      return 0;
    case 'unblock':
      out(unblock(root, args[0]));
      return 0;
    case 'check-tests': {
      const changed = (opt('--changed') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!args[1] || !existsSync(args[1])) {
        console.error(`autopilot: the test-author left no result in ${args[1] ?? '(no file given)'}`);
        return 1;
      }
      const c = checkTests(root, args[0], readFileSync(args[1], 'utf8'), changed);
      if (c.errors) {
        for (const line of c.errors) out(line);
        return 1;
      }
      out(c.result);
      return 0;
    }
    case 'approve-tests': {
      const id = args[0];
      const shas = execFileSync('git', ['-C', root, 'log', '--reverse', '--format=%h', '--grep=^Test-Author: autopilot', `--grep=^Task: ${id}$`, '--all-match'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      if (shas.length === 0) {
        console.error(`autopilot: ${id} has no commits of the test-author to approve`);
        return 1;
      }
      const from = execFileSync('git', ['-C', root, 'rev-parse', '--short', `${shas[0]}^`], { encoding: 'utf8' }).trim();
      out(approveTests(root, id, opt('--by'), `${from}..${shas.at(-1)}`));
      return 0;
    }
    case 'acceptance-check': {
      const [from, to] = args;
      const runner = args.flatMap((a, i) => (args[i - 1] === '--runner' ? [a] : []));
      const problems = acceptanceCheck(root, from, to, runner);
      for (const line of problems) out(line);
      return problems.length > 0 ? 1 : 0;
    }
    case 'scope-check': {
      const paths = readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      const v = scopeViolations(findTask(readTasks(root), args[0]), paths);
      for (const line of v) out(line);
      return v.length > 0 ? 1 : 0;
    }
    case 'check-result':
    case 'apply-result': {
      const [id, file] = args;
      if (!file || !existsSync(file)) {
        console.error(`autopilot: the implementer left no result in ${file ?? '(no file given)'}`);
        return 1;
      }
      const c = checkResult(root, id, readFileSync(file, 'utf8'));
      if (c.authority) {
        console.error(`autopilot: the implementer proposed a reserved status (${RESERVED_STATES.join(', ')}):`);
        for (const line of c.authority) console.error(`  ✗ ${line}`);
        return 3;
      }
      if (c.errors) {
        console.error(`autopilot: invalid implementer result (${file}):`);
        for (const line of c.errors) console.error(`  ✗ ${line}`);
        return 1;
      }
      if (cmd === 'check-result') out(c.result);
      else {
        const agent = opt('--agent');
        if (!nonEmpty(agent)) {
          console.error('autopilot-tasks: apply-result needs --agent LABEL (heading of the LOG.md entry)');
          return 2;
        }
        const status = opt('--status');
        if (!APPLY_STATES.includes(status) || (status === 'blocked') !== (c.result.blocked_by !== null)) {
          console.error(`autopilot-tasks: apply-result needs --status ${APPLY_STATES.join('|')}, blocked exactly when the result has "blocked_by" (got ${status ?? 'none'}; verified_auto is record_evidence.py's)`);
          return 2;
        }
        out(applyResult(root, id, c.result, agent, status));
      }
      return 0;
    }
    case 'verified-line': {
      const line = verifiedLine(findTask(readTasks(root), args[0]));
      if (!line) { console.error(`autopilot-tasks: ${args[0]} has no evidence recorded by record_evidence.py`); return 1; }
      console.log(line);
      return 0;
    }
    case 'log-verified': {
      const line = logVerified(root, args[0]);
      if (!line) { console.error(`autopilot-tasks: ${args[0]} has no evidence recorded by record_evidence.py`); return 1; }
      return 0;
    }
    case 'research-check': {
      if (!args[0] || !existsSync(args[0])) {
        console.error(`autopilot: the researcher left no report in ${args[0] ?? '(no file given)'}`);
        return 1;
      }
      const c = researchCheck(readFileSync(args[0], 'utf8'));
      if (c.errors) {
        for (const line of c.errors) out(line);
        return 1;
      }
      out(c.report);
      return 0;
    }
    case 'escalate': {
      const [cutTitle, cutDescription] = [opt('--cut-title'), opt('--cut-description')];
      const cut = nonEmpty(cutTitle) && nonEmpty(cutDescription) ? { title: cutTitle, description: cutDescription } : null;
      out(escalate(root, args[0], { reason: opt('--reason'), report: opt('--report') ?? null, cut, ...(nonEmpty(opt('--after')) ? { after: opt('--after') } : {}) }));
      return 0;
    }
    case 'plan-check': {
      const errors = planErrors(readFileSync(args[0], 'utf8'), opt('--id'));
      for (const line of errors) out(line);
      return errors.length ? 1 : 0;
    }
    case 'critic-check': {
      const list = (k) => (opt(k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const c = criticCheck(root, parseCritic(readFileSync(args[0], 'utf8')), {
        readable: list('--readable'), previous: list('--previous'), allowRequests: args.includes('--allow-requests'),
      });
      if (c.errors) {
        for (const line of c.errors) out(line);
        return 1;
      }
      out(c);
      return 0;
    }
    case 'set-plan-review': {
      out(setPlanReview(root, args[0], JSON.parse(readFileSync(args[1], 'utf8')), {
        planSha: opt('--plan-sha'), planCommit: opt('--plan-commit'), round: opt('--round'), critic: opt('--critic'),
      }));
      return 0;
    }
    case 'ensure-coverage-tasks':
      out(ensureCoverageTasks(root, { dryRun: args.includes('--dry-run') }));
      return 0;
    case 'question-check': {
      const errors = questionReportErrors(readFileSync(args[0], 'utf8'));
      for (const line of errors) out(line);
      return errors.length ? 1 : 0;
    }
    default:
      console.error(`unknown command: ${cmd ?? '(none)'}`);
      return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`autopilot-tasks: ${e.message}`);
    process.exit(1);
  }
}
