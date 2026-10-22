#!/usr/bin/env node
// Instrumentation per task (DEC-026): what each implementer attempt and each review cost and went through. Only the
// orchestrator writes it; no agent does (DEC-014).
//
//   node scripts/lib/instrument.mjs record --out FILE.jsonl --task T-NN --run RUN --role ROLE --attempt N --started EPOCH
//        --final EVENT.json --stream STREAM.jsonl [--gates GATES.jsonl] [--exit N] [--verify CMD] [--hook-report FILE]
//        [--close-exit N] [--orchestrator-task N] [--orchestrator-suite N]
//     appends one record to FILE.jsonl: run, role, attempt, started, minutes, tokens (from the final event), exit_code,
//     test_runs {task, suite, agent, hook, orchestrator} (the agent's test commands from its stream, the Stop hook's
//     verify and the orchestrator's own runs), gates [{name, result}], verify_exit_codes {hook, close} and tree_sha
//     (HEAD's tree now). A missing final event or stream leaves those fields empty, never fails.
//   node scripts/lib/instrument.mjs flush --from DIR --to EVIDENCE_DIR
//     appends the records of every DIR/<ID>.jsonl to EVIDENCE_DIR/<ID>.json ({task, records, totals}), written to a
//     temporary file and renamed.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sumUsage, usageOf } from './autopilot-stream.mjs';

const TEST_CMD = /(^|[\s;&|(])(npm (run )?test(:\S+)?|node --test|npx (vitest|jest|playwright)|vitest|jest|pytest|python3? -m pytest|go test|cargo test)\b/;

/** 'suite' (the task's verify, npm test, or node --test with no name pattern and no single test file), 'task' (any
 * other test command) or null (not a test command). */
export function classifyTest(cmd, verify = '') {
  const c = String(cmd ?? '').trim();
  if (verify && c.includes(verify.trim())) return 'suite';
  if (!TEST_CMD.test(c)) return null;
  if (/--test-name-pattern|--grep\b|-t\s/.test(c)) return 'task';
  if (/\bnpm (run )?test\b(?!:)/.test(c) && !/\.(test|spec)\.[a-z]+\b/.test(c)) return 'suite';
  if (/\bnode --test\b/.test(c) && !/\S+\.(test|spec)\.[cm]?[jt]s\b(?!["'])/.test(c.replace(/"[^"]*\*[^"]*"/g, ''))) return 'suite';
  return 'task';
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const readLines = (f) => {
  try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
};

function agentTestRuns(streamFile, verify) {
  const n = { task: 0, suite: 0 };
  for (const ev of readLines(streamFile)) {
    if (ev.type !== 'assistant') continue;
    for (const c of ev.message?.content ?? []) {
      if (c?.type !== 'tool_use' || c.name !== 'Bash') continue;
      const k = classifyTest(c.input?.command, verify);
      if (k) n[k] += 1;
    }
  }
  return n;
}

function record(o) {
  const final = readJson(o.final);
  const hook = o['hook-report'] ? readJson(o['hook-report']) : null;
  const agent = agentTestRuns(o.stream, o.verify ?? '');
  const hookRuns = { task: 0, suite: hook ? 1 : 0 };
  const orch = { task: Number(o['orchestrator-task'] ?? 0), suite: Number(o['orchestrator-suite'] ?? 0) };
  let tree = null;
  try { tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no repository */ }
  const started = Number(o.started);
  const rec = {
    task: o.task, run: o.run, role: o.role, attempt: Number(o.attempt),
    started: new Date(started * 1000).toISOString(),
    minutes: Math.round(((Date.now() / 1000 - started) / 60) * 10) / 10,
    tokens: usageOf(final),
    exit_code: o.exit === undefined ? null : Number(o.exit),
    test_runs: {
      task: agent.task + hookRuns.task + orch.task, suite: agent.suite + hookRuns.suite + orch.suite,
      agent, hook: hookRuns, orchestrator: orch,
    },
    gates: o.gates ? readLines(o.gates) : [],
    verify_exit_codes: {
      hook: hook && Number.isFinite(hook.exit_code) ? hook.exit_code : null,
      close: o['close-exit'] === undefined || o['close-exit'] === '' ? null : Number(o['close-exit']),
    },
    tree_sha: tree,
  };
  mkdirSync(dirname(o.out), { recursive: true });
  appendFileSync(o.out, `${JSON.stringify(rec)}\n`);
}

function flush(from, to) {
  if (!existsSync(from)) return;
  for (const f of readdirSync(from).filter((x) => x.endsWith('.jsonl'))) {
    const id = f.replace(/\.jsonl$/, '');
    const out = join(to, `${id}.json`);
    const prev = readJson(out) ?? { task: id, records: [] };
    const records = [...(prev.records ?? []), ...readLines(join(from, f))];
    const sum = (k) => records.reduce((a, r) => a + (r.test_runs?.[k] ?? 0), 0);
    const totals = {
      records: records.length,
      minutes: Math.round(records.reduce((a, r) => a + (r.minutes ?? 0), 0) * 10) / 10,
      tokens: sumUsage(records.map((r) => r.tokens ?? {})),
      test_runs: { task: sum('task'), suite: sum('suite') },
    };
    mkdirSync(to, { recursive: true });
    writeFileSync(`${out}.tmp`, `${JSON.stringify({ task: id, records, totals }, null, 2)}\n`);
    renameSync(`${out}.tmp`, out);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [cmd, ...args] = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < args.length; i += 2) o[args[i].replace(/^--/, '')] = args[i + 1];
  if (cmd === 'record') record(o);
  else if (cmd === 'flush') flush(o.from, o.to);
  else { console.error(`instrument: unknown command ${cmd}`); process.exit(2); }
}
