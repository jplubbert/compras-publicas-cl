#!/usr/bin/env node
// Claude Code adapter of the port access_guard (DEC-016, DEC-013): a PreToolUse hook. It only translates the hook's
// input ({tool_name, tool_input, cwd} on stdin) to the core in scripts/lib/access-policy.mjs; no policy lives here.
//
//   node scripts/agents/claude-access-hook.mjs --root WORKTREE [--allow DIR]… [--deny PATH]… [--deny-write DIR]…
//
// Exit 0 = allowed; exit 2 = denied, with the reason on stderr (Claude Code blocks the tool and shows it to the agent).
// Anything else that goes wrong (unreadable input, no --root) also exits 2: the hook fails closed. Claude Code lets the
// tool run when a hook exits with any other code or hangs, so the adapter also wraps this script in the hook's command
// as `timeout 20 node … || exit 2` (scripts/agents/claude.sh).
import { readFileSync } from 'node:fs';
import { accessGuard } from '../lib/access-policy.mjs';

try {
  const argv = process.argv.slice(2);
  const root = argv[argv.indexOf('--root') + 1];
  const allow = argv.flatMap((a, i) => (argv[i - 1] === '--allow' ? [a] : []));
  const deny = argv.flatMap((a, i) => (argv[i - 1] === '--deny' ? [a] : []));
  const denyWrite = argv.flatMap((a, i) => (argv[i - 1] === '--deny-write' ? [a] : []));   // DEC-027
  if (!argv.includes('--root') || !root) throw new Error('no --root');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const args = { ...(input.tool_input ?? {}) };
  if (input.tool_name === 'Bash' && !args.cwd && input.cwd) args.cwd = input.cwd;
  const r = accessGuard(String(input.tool_name ?? ''), args, { root, allow, deny, denyWrite, home: process.env.HOME, env: process.env });
  if (r.decision === 'allow') process.exit(0);
  process.stderr.write(`access_guard (DEC-016): denied: ${r.reason}\n`);
  process.exit(2);
} catch (e) {
  process.stderr.write(`access_guard (DEC-016): the hook failed, so the tool is blocked (fail closed): ${e.message}\n`);
  process.exit(2);
}
