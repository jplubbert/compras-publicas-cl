#!/usr/bin/env node
// Mechanical guards of the PCR protocol (sdd-base; see sdd.md §6 and §8.2).
//
//   node scripts/check-spec.mjs                    validates spec/ and the git history (npm run check:spec)
//   node scripts/check-spec.mjs --commit-msg FILE  also validates the message and the staged diff (commit-msg hook)
//   --root DIR                                     root of the repo to validate (default: this script's)
//
// History: every non-merge commit of HEAD is validated, except those reachable from `history_since`
// (optional sha in spec/TASKS.json): that way a repo with previous history adopts the protocol from that point.
//
// Exits with code 1 and lists the errors if any rule fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { combinedDecisions } from './lib/adr.mjs';

/** The only files allowed inside spec/ (paths relative to spec/), besides those in ALLOWED_SPEC_DIRS. */
export const ALLOWED_SPEC_FILES = ['SPEC.md', 'DECISIONS.md', 'TASKS.json', 'LOG.md', 'COVERAGE.json'];
/** spec/ directories with free content: API contracts (OpenAPI, GraphQL, JSON Schema…). */
export const ALLOWED_SPEC_DIRS = ['contracts/', 'adr/'];   // adr/: the ADRs of DEC-035 (and their baseline)

const TASK_STATUSES = [
  'proposed', 'analyzed', 'specified', 'approved_for_impl', 'ready', 'in_progress', 'implemented',
  'verified_auto', 'reviewed', 'accepted', 'delivered', 'done', 'blocked', 'superseded',
];
/**
 * `spec`: the only task kind that may edit tests/acceptance/. `tooling`: protocol tooling with no product REQ;
 * its commits may carry `Req: N/A`. Without `kind`, the task is an implementation task.
 */
const TASK_KINDS = ['spec', 'impl', 'tooling'];
const PROTECTED_DIR = 'tests/acceptance/';
/** Trailer of the test-author's commits (DEC-006): they may write tests/acceptance/<ID>* of a task that is not a spec task. */
export const TEST_AUTHOR_TRAILER = /^Test-Author:[ \t]*autopilot[ \t]*$/m;
/** Is `path` one of the acceptance tests of task `id` (tests/acceptance/<ID>.*, <ID>-*, <ID>_* or <ID>/…)? */
export function isTaskAcceptanceFile(path, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^tests/acceptance/${esc}(?:[._-][^/]*|/.+)$`).test(path);
}
/** Tasks that may carry an acceptance_review: spec tasks, and tasks with REQ whose tests the test-author writes. */
const reviewsAcceptance = (t) => t.kind === 'spec' || (t.kind !== 'tooling' && (t.reqs ?? []).length > 0);
/** Closed tasks: they don't need `touches` (DEC-001), so an existing project only adds it to its open tasks. */
export const CLOSED_STATUSES = ['accepted', 'done', 'delivered', 'superseded'];

/**
 * Why a `touches` entry is invalid, or null if it is valid: a path relative to the root (a file, or a directory
 * ending in `/`), without `..`, wildcards or `spec/` (which belongs to the orchestrator).
 */
export function touchesEntryError(p) {
  if (!nonEmpty(p)) return 'must be a non-empty string';
  if (p !== p.trim()) return 'has surrounding whitespace';
  if (p.startsWith('/')) return 'must be relative to the root';
  if (p.includes('\\')) return 'must use "/" as separator';
  if (/[*?[\]{}]/.test(p)) return 'must not contain wildcards';
  const segments = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  if (segments.some((s) => s === '..')) return 'must not contain ".."';
  if (segments.some((s) => s === '' || s === '.')) return 'must not contain empty or "." segments';
  if (segments[0] === 'spec') return 'must not include spec/ (it belongs to the orchestrator)';
  return null;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Problems of a task's `acceptance_review` (DEC-004 point 3: the reviewer's verdict on an additive tests/acceptance/
 * diff, written by the orchestrator); [] if it is absent, null or well formed. Only spec tasks have one.
 */
export function acceptanceReviewErrors(t) {
  const r = t.acceptance_review;
  if (r === undefined || r === null) return [];
  if (typeof r !== 'object' || Array.isArray(r)) return ['acceptance_review must be an object or null'];
  const errors = [];
  if (!reviewsAcceptance(t)) errors.push('acceptance_review is only allowed on spec tasks or on tasks with REQ (test-author, DEC-006)');
  if (!nonEmpty(r.reviewer)) errors.push('acceptance_review.reviewer must be a non-empty string');
  if (!['approved', 'rejected'].includes(r.verdict)) errors.push(`acceptance_review.verdict must be approved or rejected, got ${JSON.stringify(r.verdict)}`);
  if (!Array.isArray(r.findings) || r.findings.some((f) => typeof f !== 'string')) errors.push('acceptance_review.findings must be an array of strings');
  if (typeof r.notes !== 'string') errors.push('acceptance_review.notes must be a string');
  if (!/^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(r.commits ?? '')) errors.push('acceptance_review.commits must be a range <sha>..<sha>');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '')) errors.push('acceptance_review.date must be YYYY-MM-DD');
  return errors;
}

/**
 * Problems of a task's `review` research_question (DEC-005 point 3b: a blocker the reviewer could not resolve, which
 * sends the task to the researcher); [] if it is absent or well formed. Only a rejected review has one.
 */
export function reviewErrors(t) {
  const r = t.review;
  if (r === undefined || r === null || typeof r !== 'object' || r.research_question === undefined) return [];
  const errors = [];
  if (!nonEmpty(r.research_question)) errors.push('review.research_question must be a non-empty string');
  if (r.verdict !== 'rejected') errors.push(`review.research_question is only allowed with a rejected verdict, got ${JSON.stringify(r.verdict)}`);
  return errors;
}

/**
 * T-103: problems of a review the user recorded in person (set-user-review: decision {decider: "user", by}); [] if the
 * review is not the user's or is well formed. A person approves it, named both as reviewer and in decision.by.
 */
export function userReviewErrors(t) {
  const r = t.review;
  if (r?.decision?.decider !== 'user') return [];
  const by = r.decision.by;
  const errors = [];
  if (!nonEmpty(by) || AGENT_BY.test(by)) errors.push(`review.decision.by must name the person who reviewed it, got ${JSON.stringify(by)} (T-103)`);
  else if (r.reviewer !== by) errors.push(`review.reviewer must be the user who reviewed it (${by}), got ${JSON.stringify(r.reviewer)}`);
  if (r.verdict !== 'approved') errors.push(`a user review (set-user-review) is approved, got ${JSON.stringify(r.verdict)}`);
  return errors;
}

/** Trailers of the orchestrator's commits (its own and the test-author's). */
export const AUTOPILOT_TRAILER = /^(Co-Authored-By:[ \t]*autopilot\b|Test-Author:[ \t]*autopilot[ \t]*$)/im;
/**
 * T-103: a user review (decider "user") that a commit with an autopilot trailer introduces or changes between two
 * versions of spec/TASKS.json: the orchestrator never records the user's review. → error lines
 */
export function autopilotUserReviewErrors(before, after, message) {
  if (!AUTOPILOT_TRAILER.test(message ?? '')) return [];
  const prev = new Map((before?.tasks ?? []).map((t) => [t.id, t]));
  return (after?.tasks ?? [])
    .filter((t) => t.review?.decision?.decider === 'user' && JSON.stringify(prev.get(t.id)?.review) !== JSON.stringify(t.review))
    .map((t) => `${t.id}: a user review (decider "user") in a commit with an autopilot trailer: only a session at the user's request records it (T-103)`);
}

/**
 * Problems of a task's `plan_review` (DEC-010 point 7: the critic's verdict on plans/<ID>.md, written by the
 * orchestrator; the implementer starts only with effective APROBAR on an unchanged plan); [] if absent, null or well formed.
 */
export function planReviewErrors(t) {
  const r = t.plan_review;
  if (r === undefined || r === null) return [];
  if (typeof r !== 'object' || Array.isArray(r)) return ['plan_review must be an object or null'];
  const errors = [];
  const verdicts = ['APROBAR', 'REVISAR', 'ESCALAR'];
  if (t.kind === 'spec') errors.push('plan_review is not allowed on spec tasks (they have no plan gate)');
  if (!nonEmpty(r.critic)) errors.push('plan_review.critic must be a non-empty string');
  if (!verdicts.includes(r.verdict)) errors.push(`plan_review.verdict must be one of ${verdicts.join(', ')}`);
  if (!verdicts.includes(r.effective)) errors.push(`plan_review.effective must be one of ${verdicts.join(', ')}`);
  if (![1, 2].includes(r.round)) errors.push('plan_review.round must be 1 or 2');
  if (r.plan !== `plans/${t.id}.md`) errors.push(`plan_review.plan must be plans/${t.id}.md`);
  if (!/^[0-9a-f]{40}$/.test(r.plan_sha ?? '')) errors.push('plan_review.plan_sha must be the blob sha of the plan');
  if (!/^[0-9a-f]{7,40}$/.test(r.plan_commit ?? '')) errors.push('plan_review.plan_commit must be a commit sha');
  const findingOk = (f) => f && /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(f.id ?? '') && ['P0', 'P1', 'P2', 'P3'].includes(f.severity)
    && ['fuente', 'archivo', 'opinión'].includes(f.evidence_type) && nonEmpty(f.evidence) && nonEmpty(f.summary);
  if (!Array.isArray(r.findings) || !r.findings.every(findingOk)) {
    errors.push('plan_review.findings must be an array of {id, severity, evidence_type, evidence, summary}');
  } else if (r.effective === 'APROBAR' && r.findings.some((f) => ['P0', 'P1'].includes(f.severity) && f.evidence_type !== 'opinión')) {
    errors.push('plan_review.effective cannot be APROBAR with a P0/P1 finding backed by a source or a file line');
  }
  if (!Array.isArray(r.opinion_blockers) || r.opinion_blockers.some((x) => typeof x !== 'string')) errors.push('plan_review.opinion_blockers must be an array of finding ids');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '')) errors.push('plan_review.date must be YYYY-MM-DD');
  return errors;
}

/** Problems of a task's `block` (DEC-029: an implementer's declared block, classified by the decider); [] if absent. */
export function blockErrors(t) {
  const b = t.block;
  if (b === undefined || b === null) return [];
  const errors = [];
  if (!['spec_test_conflict', 'open_question'].includes(b.kind)) errors.push('block.kind must be spec_test_conflict or open_question');
  if (!nonEmpty(b.detail)) errors.push('block.detail must be a non-empty string');
  if (b.classification !== null && !['spec', 'test', 'user_answer', 'implementer'].includes(b.classification)) {
    errors.push('block.classification must be spec, test, user_answer, implementer or null (the decider did not settle it)');
  }
  return errors;
}

const AGENT_BY = /autopilot|orquestador|orchestrator|claude|codex|agent|agente|revisor|reviewer|implementador|implementer/i;
const SCRIPT_BY = /^(record_evidence\.py|apply-result|set-review|reopen|unblock|escalate|autopilot \(.+\))$/;
/** Problems of a task's `status_log` (DEC-028): a list of {from, to, by, at[, reason]}; [] if absent or well formed. */
export function statusLogErrors(t) {
  const l = t.status_log;
  if (l === undefined) return [];
  const ok = Array.isArray(l) && l.every((e) => e && typeof e === 'object' && (e.from === null || typeof e.from === 'string')
    && nonEmpty(e.to) && nonEmpty(e.by) && /^\d{4}-\d{2}-\d{2}T/.test(e.at ?? ''));
  if (!ok) return ['status_log must be a list of {from, to, by, at} (DEC-028)'];
  // DEC-032: an entry of an agent that is not one of the scripts may only move the task to in_progress or blocked
  return l.filter((e) => AGENT_BY.test(e.by) && !SCRIPT_BY.test(e.by) && !['in_progress', 'blocked'].includes(e.to))
    .map((e) => `status_log: ${e.by} → ${e.to}: an agent may only set in_progress or blocked (DEC-032); the rest comes from the scripts or the user`);
}

/**
 * DEC-028 point 4: the status changes between two versions of spec/TASKS.json that no new status_log entry explains
 * (a change made by hand, not by a script). Tasks that appear or disappear are not changes. → error lines
 */
export function statusChangeErrors(before, after) {
  const prev = new Map((before?.tasks ?? []).map((t) => [t.id, t]));
  const errors = [];
  for (const t of after?.tasks ?? []) {
    const b = prev.get(t.id);
    if (!b || b.status === t.status) continue;
    const old = Array.isArray(b.status_log) ? b.status_log.length : 0;
    const added = Array.isArray(t.status_log) ? t.status_log.slice(old) : [];
    if (!added.some((e) => e?.to === t.status)) {
      errors.push(`${t.id}: status ${b.status} → ${t.status} without a status_log entry (DEC-028: change it with a script, e.g. autopilot-tasks set-status)`);
    }
  }
  return errors;
}

/**
 * Problems of a task's `impl_approval` (DEC-022 point 3: the orchestrator's grant of approved_for_impl after a critic's
 * APROBAR on an unchanged plan); [] if absent or well formed.
 */
export function implApprovalErrors(t) {
  const a = t.impl_approval;
  if (a === undefined || a === null) return [];
  if (typeof a !== 'object' || Array.isArray(a)) return ['impl_approval must be an object or null'];
  const errors = [];
  if (!nonEmpty(a.by)) errors.push('impl_approval.by must name who granted it');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(a.at ?? '')) errors.push('impl_approval.at must be an ISO timestamp');
  if (!/^[0-9a-f]{40}$/.test(a.plan_sha ?? '')) errors.push('impl_approval.plan_sha must be the blob sha of the approved plan');
  if (t.plan_review?.effective !== 'APROBAR' || t.plan_review?.plan_sha !== a.plan_sha) {
    errors.push('impl_approval needs a plan_review with effective APROBAR on the same plan_sha (DEC-022)');
  }
  return errors;
}

/**
 * What counts as integration is the project's (DEC-019): AUTOPILOT_INTEGRATION_PATTERN in its scripts/autopilot.config.sh,
 * an extended regular expression on one single-quoted line (read, never run). sdd-base names no provider: without it,
 * nothing counts as integration. → RegExp or null.
 */
export function integrationPattern(text) {
  const m = /^\s*AUTOPILOT_INTEGRATION_PATTERN='([^']*)'\s*(#.*)?$/m.exec(text ?? '');
  if (!m || !m[1]) return null;
  try { return new RegExp(m[1]); } catch { return null; }
}
/** Can bash read this command? (a verify written as prose cannot) */
export function bashReads(command) {
  return spawnSync('bash', ['-n', '-c', command], { stdio: 'ignore' }).status === 0;
}

/** Problems of a task's external_repos (DEC-021): the only repositories besides its own it may touch, each approved. */
export function externalReposErrors(t) {
  if (t.external_repos === undefined) return [];
  if (!Array.isArray(t.external_repos)) return ['external_repos must be a list of {path, approved_by, date}'];
  return t.external_repos.flatMap((e, i) => [
    ...(typeof e?.path === 'string' && e.path.startsWith('/') ? [] : [`external_repos[${i}].path must be an absolute path`]),
    ...(nonEmpty(e?.approved_by) ? [] : [`external_repos[${i}].approved_by must name who approved it (DEC-021)`]),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(e?.date ?? '') ? [] : [`external_repos[${i}].date must be YYYY-MM-DD`]),
  ]);
}

/** Draft states: a task there may still describe its verification in words; from approval on it is a command. */
const DRAFT_STATES = ['proposed', 'analyzed', 'specified'];
/** Problems of a task's verify and verify_integration (DEC-019). */
export function verifyErrors(t, integration = null) {
  const errors = [];
  if (DRAFT_STATES.includes(t.status)) return errors;
  if (t.verify !== undefined && t.verify !== null) {
    if (!nonEmpty(t.verify)) errors.push('verify must be a non-empty command');
    else if (!bashReads(t.verify)) errors.push('verify is not a command bash can read (prose?): write the local command that prints test counts (DEC-019)');
    else if (integration?.test(t.verify)) errors.push("verify matches the project's integration pattern (AUTOPILOT_INTEGRATION_PATTERN); move that part to verify_integration (DEC-019)");
  }
  if (t.verify_integration !== undefined && t.verify_integration !== null) {
    if (!nonEmpty(t.verify_integration) || !bashReads(t.verify_integration)) errors.push('verify_integration is not a command bash can read');
  }
  return errors;
}

/** Coverage from acceptance (DEC-011): its configuration, read by scripts/check-coverage.mjs and validated here. */
export const COVERAGE_FILE = 'spec/COVERAGE.json';
const CONFIG_KEYS = ['command', 'sources', 'tests', 'exceptions', 'baseline', 'code_extensions'];

/** Status of a DEC in DECISIONS.md text ("accepted", "proposed", …), or null if it does not exist. */
export function decStatus(text, id) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## ${id}\\b`).test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const m = /^- Estado:\s*(.+?)\s*$/.exec(lines[i]);
    if (m) return m[1].split(/\s/)[0];
  }
  return null;
}

/** Problems of a spec/COVERAGE.json object (DEC-011); `decisions` = the text of spec/DECISIONS.md. */
export function configErrors(cfg, decisions) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return ['spec/COVERAGE.json must be a JSON object'];
  const errors = [];
  const where = 'spec/COVERAGE.json';
  for (const k of Object.keys(cfg)) if (!CONFIG_KEYS.includes(k)) errors.push(`${where}: unknown key "${k}"`);
  if (typeof cfg.command !== 'string' || !cfg.command.includes('{files}') || !/\{(lcov|dir)\}/.test(cfg.command)) {
    errors.push(`${where}: "command" must be a string with {files} and {lcov} (or {dir})`);
  }
  const globs = (k, required) => {
    const v = cfg[k];
    if (v === undefined && !required) return;
    if (!Array.isArray(v) || (required && v.length === 0) || !v.every((g) => typeof g === 'string' && g.trim() && !g.startsWith('/') && !g.includes('..'))) {
      errors.push(`${where}: "${k}" must be a ${required ? 'non-empty ' : ''}list of globs relative to the root`);
    }
  };
  globs('sources', true);
  globs('tests', false);
  if (cfg.exceptions !== undefined) {
    if (!Array.isArray(cfg.exceptions)) errors.push(`${where}: "exceptions" must be a list`);
    else {
      cfg.exceptions.forEach((e, i) => {
        if (typeof e?.glob !== 'string' || !e.glob.trim()) errors.push(`${where}: exceptions[${i}].glob must be a glob`);
        if (typeof e?.why !== 'string' || !e.why.trim()) errors.push(`${where}: exceptions[${i}].why must say why`);
        if (!/^DEC-\d+$/.test(e?.dec ?? '')) errors.push(`${where}: exceptions[${i}].dec must cite a DEC (only a DEC may leave code out)`);
        else {
          const status = decStatus(decisions, e.dec);
          if (status === null) errors.push(`${where}: exceptions[${i}] cites ${e.dec}, which does not exist in spec/DECISIONS.md`);
          else if (status !== 'accepted') errors.push(`${where}: exceptions[${i}] cites ${e.dec}, which is ${status}, not accepted`);
        }
      });
    }
  }
  if (cfg.baseline !== undefined) {
    if (!cfg.baseline || typeof cfg.baseline !== 'object' || Array.isArray(cfg.baseline)) errors.push(`${where}: "baseline" must be an object {file: count}`);
    else {
      for (const [f, n] of Object.entries(cfg.baseline)) {
        if (!Number.isInteger(n) || n < 1) errors.push(`${where}: baseline of ${f} must be a whole number > 0 (remove the file once it is 0)`);
      }
    }
  }
  if (cfg.code_extensions !== undefined && (!Array.isArray(cfg.code_extensions) || !cfg.code_extensions.every((x) => /^[a-z0-9]+$/i.test(x)))) {
    errors.push(`${where}: "code_extensions" must be a list of extensions without the dot`);
  }
  return errors;
}

function parseArgs(argv) {
  const args = { root: fileURLToPath(new URL('..', import.meta.url)), commitMsg: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--commit-msg') args.commitMsg = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

/**
 * Where spec/ and the evidence logs are read from: the working tree, or — for the commit-msg hook — the index, i.e. what
 * the commit being made contains (T-45: a task that exists only in the working tree must not let a commit pass).
 * git honors GIT_INDEX_FILE, so `git commit -a` (a temporary index) is validated as committed.
 */
let source = null;
function treeSource(root) {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    bytes: (rel) => readFileSync(join(root, rel)),
    list: (dir) => listFiles(join(root, dir)).map((f) => relative(root, f).split(sep).join('/')),
  };
}
function indexSource(root) {
  const files = new Set(git(root, ['ls-files', '-z']).split('\0').filter(Boolean));
  return {
    exists: (rel) => files.has(rel),
    bytes: (rel) => execFileSync('git', ['-C', root, 'show', `:${rel}`], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }),
    list: (dir) => [...files].filter((f) => f.startsWith(`${dir}/`)),
  };
}
function readText(root, rel) {
  const src = source ?? treeSource(root);
  return src.exists(rel) ? src.bytes(rel).toString('utf8') : '';
}

/** Every decision as "## DEC-NNN" sections: the ADRs of spec/adr/ and the DECs of spec/DECISIONS.md (DEC-035). */
function decisionsText(root) {
  const src = source ?? treeSource(root);
  return combinedDecisions({ text: (rel) => readText(root, rel), list: (dir) => src.list(dir) });
}

/** IDs declared as a heading or table row, e.g. `### REQ-001 …`, `## DEC-004 …`, `| Q-01 | …`. */
function declaredIds(text, prefix) {
  const re = new RegExp(`^(?:#{2,4} |\\| )(${prefix}-\\d+)\\b`, 'gm');
  return new Set([...text.matchAll(re)].map((m) => m[1]));
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isGitRepo(root) {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/** Values of `Task:` and `Req:` on any line of the message (doesn't require them in the last paragraph). */
export function parseTrailers(message) {
  const values = (key) =>
    [...message.matchAll(new RegExp(`^${key}:[ \\t]*(.*)$`, 'gmi'))].flatMap((m) =>
      m[1].split(',').map((s) => s.trim()).filter(Boolean),
    );
  return { task: values('Task'), req: values('Req') };
}

function checkSpecFiles(root, errors) {
  for (const file of (source ?? treeSource(root)).list('spec')) {
    const rel = file.slice('spec/'.length);
    if (!ALLOWED_SPEC_FILES.includes(rel) && !ALLOWED_SPEC_DIRS.some((d) => rel.startsWith(d))) {
      const allowed = [...ALLOWED_SPEC_FILES, ...ALLOWED_SPEC_DIRS.map((d) => `${d}…`)].join(', ');
      errors.push(`spec/${rel}: file not allowed in spec/ (allowed: ${allowed})`);
    }
  }
}

function checkTasks(root, ids, errors) {
  const integration = integrationPattern(readText(root, 'scripts/autopilot.config.sh'));
  let data;
  try {
    data = JSON.parse(readText(root, 'spec/TASKS.json'));
  } catch (e) {
    errors.push(`spec/TASKS.json: not valid JSON (${e.message})`);
    return null;
  }
  if (!Array.isArray(data?.tasks)) {
    errors.push('spec/TASKS.json: missing the "tasks" array');
    return null;
  }
  if (data.history_since !== undefined && !/^[0-9a-f]{7,40}$/.test(data.history_since ?? '')) {
    errors.push(`spec/TASKS.json: history_since must be a git sha (${JSON.stringify(data.history_since)})`);
  }

  const tasks = new Map();
  for (const t of data.tasks) {
    if (!/^T-\d+$/.test(t?.id ?? '')) errors.push(`spec/TASKS.json: task with invalid id: ${JSON.stringify(t?.id)}`);
    else if (tasks.has(t.id)) errors.push(`${t.id}: duplicate id`);
    else tasks.set(t.id, t);
  }
  // T-41 (DEC-014): the tasks whose evidence was recorded before record_evidence.py, listed explicitly by the project
  const legacy = new Set();
  if (data.evidence_legacy !== undefined) {
    if (!Array.isArray(data.evidence_legacy) || data.evidence_legacy.some((x) => typeof x !== 'string')) {
      errors.push('spec/TASKS.json: evidence_legacy must be an array of task ids (the tasks whose evidence predates DEC-014)');
    } else {
      for (const id of data.evidence_legacy) {
        if (!tasks.has(id)) errors.push(`spec/TASKS.json: evidence_legacy names ${id}, which is not a task`);
        legacy.add(id);
      }
    }
  }

  for (const t of tasks.values()) {
    const where = t.id;
    if (!TASK_STATUSES.includes(t.status)) errors.push(`${where}: unknown status "${t.status}"`);
    if (t.kind !== undefined && !TASK_KINDS.includes(t.kind)) errors.push(`${where}: unknown kind "${t.kind}"`);
    for (const field of ['reqs', 'decisions', 'depends_on']) {
      if (t[field] !== undefined && !Array.isArray(t[field])) errors.push(`${where}: "${field}" must be an array`);
    }
    for (const r of t.reqs ?? []) if (!ids.req.has(r)) errors.push(`${where}: ${r} does not exist in spec/SPEC.md`);
    for (const d of t.decisions ?? []) if (!ids.dec.has(d)) errors.push(`${where}: ${d} does not exist in spec/DECISIONS.md`);
    for (const d of t.depends_on ?? []) if (!tasks.has(d)) errors.push(`${where}: depends on ${d}, which does not exist`);

    if (t.touches !== undefined && !Array.isArray(t.touches)) {
      errors.push(`${where}: "touches" must be an array`);
    } else if (!CLOSED_STATUSES.includes(t.status) && (t.touches ?? []).length === 0) {
      errors.push(`${where}: missing "touches" (non-empty list of paths it may modify; required while the task is open)`);
    } else {
      // Closed tasks are history: a project that adopted sdd-base earlier does not rewrite them (R-02).
      for (const p of CLOSED_STATUSES.includes(t.status) ? [] : t.touches ?? []) {
        const why = touchesEntryError(p);
        if (why) errors.push(`${where}: touches ${JSON.stringify(p)} ${why}`);
      }
    }

    for (const e of acceptanceReviewErrors(t)) errors.push(`${where}: ${e}`);
    for (const e of reviewErrors(t)) errors.push(`${where}: ${e}`);
    for (const e of userReviewErrors(t)) errors.push(`${where}: ${e}`);
    for (const e of planReviewErrors(t)) errors.push(`${where}: ${e}`);
    for (const e of implApprovalErrors(t)) errors.push(`${where}: ${e}`);
    for (const e of statusLogErrors(t)) errors.push(`${where}: ${e}`);
    for (const e of blockErrors(t)) errors.push(`${where}: ${e}`);
    for (const e of verifyErrors(t, integration)) errors.push(`${where}: ${e}`);
    for (const e of externalReposErrors(t)) errors.push(`${where}: ${e}`);

    // T-41 (DEC-014): any evidence, in any status, points to the raw log record_evidence.py kept, with its sha256; a
    // done task gets its own messages below.
    if (t.status !== 'done' && t.evidence && typeof t.evidence === 'object') {
      const logError = (ev, name) => {
        if (!nonEmpty(ev.log_path)) return `${name} without log_path: written by hand? record_evidence.py writes it (DEC-014); a task recorded before DEC-014 goes in spec/TASKS.json "evidence_legacy"`;
        const src = source ?? treeSource(root);
        if (!src.exists(ev.log_path)) return `${name} log ${ev.log_path} does not exist`;
        if (createHash('sha256').update(src.bytes(ev.log_path)).digest('hex') !== ev.log_sha256) return `${name}.log_sha256 does not match ${ev.log_path}`;
        return null;
      };
      const local = t.evidence.command !== undefined || t.evidence.result !== undefined;
      const e1 = local && !legacy.has(t.id) ? logError(t.evidence, 'evidence') : null;
      if (e1) errors.push(`${where}: ${e1}`);
      const e2 = t.evidence.integration && typeof t.evidence.integration === 'object' ? logError(t.evidence.integration, 'evidence.integration') : null;
      if (e2) errors.push(`${where}: ${e2}`);
    }

    if (t.status === 'done') {
      for (const key of ['command', 'result', 'commit']) {
        if (!nonEmpty(t.evidence?.[key])) errors.push(`${where}: is "done" without evidence.${key}`);
      }
      if (t.evidence?.unverified) errors.push(`${where}: is "done" but its evidence is marked unverified (reverification, DEC-014)`);
      // DEC-014: the evidence of a done task points to the raw log record_evidence.py kept, with its sha256.
      const log = t.evidence?.log_path;
      if (!nonEmpty(log)) errors.push(`${where}: is "done" without evidence.log_path (record_evidence.py writes it, DEC-014)`);
      else if (!(source ?? treeSource(root)).exists(log)) errors.push(`${where}: is "done" but its evidence log ${log} does not exist`);
      else if (createHash('sha256').update((source ?? treeSource(root)).bytes(log)).digest('hex') !== t.evidence.log_sha256) {
        errors.push(`${where}: is "done" but evidence.log_sha256 does not match ${log}`);
      }
    }

    if (t.status === 'blocked') {
      const ref = t.blocked_by;
      if (!nonEmpty(ref)) {
        errors.push(`${where}: is "blocked" without blocked_by`);
      } else if (ref === 'evidence_mismatch') {
        // DEC-014: the orchestrator's re-run of verify did not match the recorded evidence; the user decides
      } else if (/^Q-\d+$/.test(ref)) {
        if (!ids.q.has(ref)) errors.push(`${where}: blocked_by ${ref} does not exist among the questions in spec/SPEC.md`);
      } else if (![...(t.reqs ?? []), ...(t.decisions ?? []), ...(t.depends_on ?? [])].includes(ref)) {
        errors.push(`${where}: blocked_by ${ref} is not in its reqs, decisions or depends_on, nor an existing Q-`);
      }
    } else if (nonEmpty(t.blocked_by)) {
      errors.push(`${where}: has blocked_by but its status is "${t.status}"`);
    }
  }
  return tasks;
}

/** Validates the trailers and files of a commit (from history or being prepared). */
function checkCommit(label, message, files, tasks, ids, errors) {
  const parsed = parseTrailers(message);
  const req = parsed.req;
  // DEC-049: "Task:" takes one or more T-NN separated by commas (several "Task:" lines count as one list); none goes alone.
  const task = [...new Set(parsed.task)];
  const cited = task.filter((id) => id !== 'none');
  if (task.length === 0) {
    errors.push(`${label}: missing the "Task:" trailer (T-NN, … or none)`);
  } else if (task.includes('none') && task.length > 1) {
    errors.push(`${label}: "Task: none" goes alone, not in a list (${task.join(', ')})`);
  } else if (tasks) {
    for (const id of cited) if (!tasks.has(id)) errors.push(`${label}: Task ${id} does not exist in spec/TASKS.json`);
  }
  const allTooling = cited.length > 0 && cited.length === task.length && cited.every((id) => tasks?.get(id)?.kind === 'tooling');
  if (req.length === 0) {
    errors.push(`${label}: missing the "Req:" trailer (REQ-NNN, … or none)`);
  } else if (req.length === 1 && req[0].toUpperCase() === 'N/A') {
    if (!allTooling) errors.push(`${label}: "Req: N/A" is only allowed for tasks with kind "tooling"`);
  } else if (!(req.length === 1 && req[0] === 'none')) {
    for (const r of req) if (!ids.req.has(r)) errors.push(`${label}: Req ${r} does not exist in spec/SPEC.md`);
  }

  const touched = files.filter((f) => f.startsWith(PROTECTED_DIR));
  if (touched.length > 0) {
    const t = task.length === 1 ? tasks?.get(task[0]) : undefined;
    // The test-author's commit (DEC-006): only that task's acceptance files, with its trailer.
    const byTestAuthor = TEST_AUTHOR_TRAILER.test(message) && t && files.every((f) => isTaskAcceptanceFile(f, t.id));
    if (TEST_AUTHOR_TRAILER.test(message) && t && !byTestAuthor) {
      errors.push(`${label}: a Test-Author commit may only touch tests/acceptance/${t.id}* (${files.filter((f) => !isTaskAcceptanceFile(f, t.id)).join(', ')})`);
    } else if (!byTestAuthor) {
      // With a list, every cited task has to be a spec task.
      const notSpec = task.length === 0 ? ['?'] : task.filter((id) => tasks?.get(id)?.kind !== 'spec');
      if (notSpec.length > 0) {
        errors.push(
          `${label}: modifies ${PROTECTED_DIR} (${touched.join(', ')}) with Task ${notSpec.join(', ')}, which is not a spec task`,
        );
      }
    }
  }
}

function historySince(root) {
  try {
    return JSON.parse(readText(root, 'spec/TASKS.json')).history_since;
  } catch {
    return undefined;
  }
}

function checkHistory(root, tasks, ids, errors) {
  try {
    git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  } catch {
    return; // repo without commits
  }
  const since = historySince(root);
  const range = ['HEAD'];
  if (typeof since === 'string' && /^[0-9a-f]{7,40}$/.test(since)) {
    try {
      git(root, ['rev-parse', '--verify', '-q', `${since}^{commit}`]);
      range.push(`^${since}`);
    } catch {
      errors.push(`spec/TASKS.json: history_since ${since} is not a commit of this repository`);
      return;
    }
  }
  const shas = git(root, ['rev-list', '--no-merges', ...range]).split('\n').filter(Boolean);
  checkStatusChanges(root, errors);
  for (const sha of shas) {
    const message = git(root, ['show', '-s', '--format=%B', sha]);
    const files = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).split('\n').filter(Boolean);
    checkCommit(`commit ${sha.slice(0, 7)}`, message, files, tasks, ids, errors);
    if (files.includes('spec/TASKS.json') && AUTOPILOT_TRAILER.test(message)) {
      for (const e of autopilotUserReviewErrors(tasksAt(root, `${sha}^`), tasksAt(root, sha), message)) errors.push(`commit ${sha.slice(0, 7)}: ${e}`);
    }
  }
}

/** status_log_since (DEC-028): the commit after which every status change must come with its status_log entry. */
function statusLogSince(root) {
  try {
    const s = JSON.parse(readText(root, 'spec/TASKS.json')).status_log_since;
    return typeof s === 'string' && /^[0-9a-f]{7,40}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}
const tasksAt = (root, rev) => {
  try { return JSON.parse(git(root, ['show', `${rev}:spec/TASKS.json`])); } catch { return null; }
};
function checkStatusChanges(root, errors) {
  const since = statusLogSince(root);
  if (!since) return;
  let shas;
  try { shas = git(root, ['rev-list', '--no-merges', `${since}..HEAD`, '--', 'spec/TASKS.json']).split('\n').filter(Boolean); } catch {
    errors.push(`spec/TASKS.json: status_log_since ${since} is not a commit of this repository`);
    return;
  }
  for (const sha of shas) {
    for (const e of statusChangeErrors(tasksAt(root, `${sha}^`), tasksAt(root, sha))) errors.push(`commit ${sha.slice(0, 7)}: ${e}`);
  }
}

function checkPendingCommit(root, msgFile, tasks, ids, errors) {
  if (statusLogSince(root)) {
    let staged = null;
    try { staged = JSON.parse(readText(root, 'spec/TASKS.json')); } catch { /* reported by checkTasks */ }
    for (const e of statusChangeErrors(tasksAt(root, 'HEAD'), staged)) errors.push(`pending commit: ${e}`);
  }
  const message = readFileSync(msgFile, 'utf8')
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
  const files = git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  checkCommit('pending commit', message, files, tasks, ids, errors);
  if (files.includes('spec/TASKS.json') && AUTOPILOT_TRAILER.test(message)) {
    let staged = null;
    try { staged = JSON.parse(readText(root, 'spec/TASKS.json')); } catch { /* reported by checkTasks */ }
    for (const e of autopilotUserReviewErrors(tasksAt(root, 'HEAD'), staged, message)) errors.push(`pending commit: ${e}`);
  }
}

export function run({ root, commitMsg }) {
  const errors = [];
  // the commit-msg hook validates what is being committed (the index); otherwise the working tree (T-45)
  source = commitMsg && isGitRepo(root) ? indexSource(root) : treeSource(root);
  const ids = {
    req: declaredIds(readText(root, 'spec/SPEC.md'), 'REQ'),
    q: declaredIds(readText(root, 'spec/SPEC.md'), 'Q'),
    dec: declaredIds(decisionsText(root), 'DEC'),
  };
  checkSpecFiles(root, errors);
  const coverage = readText(root, COVERAGE_FILE);
  if (coverage) {
    try {
      errors.push(...configErrors(JSON.parse(coverage), decisionsText(root)));
    } catch (e) {
      errors.push(`${COVERAGE_FILE}: not valid JSON (${e.message})`);
    }
  }
  const tasks = checkTasks(root, ids, errors);
  if (isGitRepo(root)) {
    checkHistory(root, tasks, ids, errors);
    if (commitMsg) checkPendingCommit(root, commitMsg, tasks, ids, errors);
  } else if (commitMsg) {
    errors.push('--commit-msg requires a git repository');
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const errors = run(parseArgs(process.argv.slice(2)));
  if (errors.length > 0) {
    console.error(`check:spec: ${errors.length} error(s)`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log('check:spec: ok');
}
