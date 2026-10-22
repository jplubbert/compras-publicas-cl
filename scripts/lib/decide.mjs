#!/usr/bin/env node
// Port decide (DEC-015, DEC-013): every closed decision of the loop goes to a decider adapter, never to a generative
// LLM. The core maps the adapter's answer to an action; it names no provider and decides nothing itself.
//
//   mapAnswer({ options, threshold }, result) → { action: "proceed" | "escalate", answer, confidence, reason, rejected? }
//     result = { answer, confidence, probabilities? } from the adapter, or { error }. An answer outside the options is
//     rejected; a confidence under the threshold, an error or no answer escalates to the user.
//
//   node scripts/lib/decide.mjs ask --decider ADAPTER --question FILE --threshold N --record-dir DIR [--timeout SECONDS]
//     runs the adapter with the question on stdin, maps its answer, writes the decision record (question, state, options,
//     answer, confidence, probabilities, model (the version that answered, as the adapter reports it, DEC-025),
//     action, reason, decider, timestamp) to DIR/<timestamp>-<question id>.json and
//     prints the result as JSON, with "record": the path of that file. Exit 0 whatever the action; 2 on bad usage.
//
// The adapter (scripts/agents/decider/<name>.sh) reads {id, state, instructions, options: {name: description}} on stdin
// and prints {answer, confidence, probabilities?} or exits non-zero with the reason on stderr. It only translates.
//
// User criteria (DEC-050): if ${AUTOPILOT_USER_CRITERIA:-${XDG_CONFIG_HOME:-~/.config}/autopilot/criterios-usuario.md}
// exists and is not empty, its content is appended to the instructions of every question before the adapter runs, and
// the record keeps its sha256 (user_criteria_sha256, null without the file). Without the file the question goes as is.
// Only the decider uses this file; no agent launched by the orchestrator writes it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function userCriteriaPath(env = process.env) {
  if (env.AUTOPILOT_USER_CRITERIA) return env.AUTOPILOT_USER_CRITERIA;
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autopilot', 'criterios-usuario.md');
}

// → { question, sha256 }: the question with the criteria appended to its instructions, or unchanged (sha256 null).
export function withUserCriteria(question, criteria) {
  if (typeof criteria !== 'string' || !criteria.trim()) return { question, sha256: null };
  const sha256 = createHash('sha256').update(criteria).digest('hex');
  const instructions = `${question.instructions ?? ''}\n\nThe user's decision criteria (decide as the user would):\n${criteria.trim()}`;
  return { question: { ...question, instructions }, sha256 };
}

export function mapAnswer({ options, threshold }, result) {
  const names = Object.keys(options ?? {});
  if (!result || typeof result !== 'object') return { action: 'escalate', reason: 'the decider gave no answer' };
  if (result.error) return { action: 'escalate', reason: `decider error: ${result.error}` };
  const { answer, confidence } = result;
  if (!names.includes(answer)) {
    return { action: 'escalate', rejected: true, answer, confidence, reason: `answer ${JSON.stringify(answer)} is outside the options (${names.join(', ')}): rejected` };
  }
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return { action: 'escalate', answer, reason: 'the decider gave no confidence' };
  if (confidence < threshold) return { action: 'escalate', answer, confidence, reason: `confidence ${confidence} < ${threshold} (threshold)` };
  return { action: 'proceed', answer, confidence, reason: '' };
}

function ask(args) {
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const decider = opt('--decider');
  const questionFile = opt('--question');
  const threshold = Number(opt('--threshold'));
  const recordDir = opt('--record-dir');
  const timeout = Number(opt('--timeout') ?? 120);
  if (!decider || !questionFile || !recordDir || !Number.isFinite(threshold)) {
    console.error('usage: decide.mjs ask --decider ADAPTER --question FILE --threshold N --record-dir DIR [--timeout S]');
    return 2;
  }
  const question = JSON.parse(readFileSync(questionFile, 'utf8'));
  const criteriaFile = userCriteriaPath();
  const criteria = existsSync(criteriaFile) ? readFileSync(criteriaFile, 'utf8') : null;
  const { question: sent, sha256: criteriaSha } = withUserCriteria(question, criteria);
  const r = spawnSync('bash', [decider], { input: JSON.stringify(sent), encoding: 'utf8', timeout: timeout * 1000 });
  let result;
  if (r.error) result = { error: r.error.code === 'ETIMEDOUT' ? `no answer within ${timeout} s` : r.error.message };
  else if (r.status !== 0) result = { error: (r.stderr || `exit ${r.status}`).trim().slice(0, 500) };
  else {
    try { result = JSON.parse(r.stdout); } catch { result = { error: `unreadable answer: ${r.stdout.trim().slice(0, 200)}` }; }
  }
  const mapped = mapAnswer({ options: question.options, threshold }, result);
  const timestamp = new Date().toISOString();
  const record = {
    question_id: question.id, instructions: question.instructions, state: question.state, options: question.options,
    answer: result?.answer ?? null, confidence: result?.confidence ?? null, probabilities: result?.probabilities ?? null,
    model: result?.model ?? null, user_criteria_sha256: criteriaSha,
    threshold, action: mapped.action, reason: mapped.reason, ...(mapped.rejected ? { rejected: true } : {}),
    decider: resolve(decider), timestamp,
  };
  mkdirSync(recordDir, { recursive: true });
  const recordFile = join(recordDir, `${timestamp.replace(/[:.]/g, '-')}-${question.id}.json`);
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...mapped, record: recordFile })}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, ...args] = process.argv.slice(2);
  process.exit(cmd === 'ask' ? ask(args) : (console.error(`unknown command: ${cmd}`), 2));
}
