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
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const r = spawnSync('bash', [decider], { input: JSON.stringify(question), encoding: 'utf8', timeout: timeout * 1000 });
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
    model: result?.model ?? null,
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
