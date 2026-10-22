// Port access_guard (DEC-016, DEC-013): may an agent's tool call touch these paths? A pure core that names no agent or
// provider; the adapters (scripts/agents/claude-access-hook.mjs for Claude Code) only translate their tool calls to it.
//
//   accessGuard(tool, args, ctx) → { decision: "allow" | "deny", reason, paths }
//   ctx = { root (the task's worktree), home, allow (extra directories, e.g. the role's result directory),
//           deny (paths no agent may touch: the agents' private data, given by the adapters and the project's
//           configuration; the core names no agent), denyWrite (directories of the worktree, relative to it, the
//           agent may read and run but never write: tests/acceptance/ for an implementer, DEC-027), verify (an
//           implementer's task verify: with it, the tests rule of T-107 applies; else env.AUTOPILOT_GUARD_VERIFY, which
//           the orchestrator exports only around an implementer), env (to resolve $VARIABLES), realpath (optional) }
//
// Denied: anything under a deny path, anything under the worktree's .autopilot/ (the run's records, T-97), and anything
// outside the worktree and the
// allowed directories (/dev/null and the standard streams aside). Paths come from the tool's arguments (file_path, path,
// notebook_path, cwd; Glob's pattern, but not Grep's, which is a regular expression) and, for Bash, from every word of
// the command that looks like a path (also inside $(…), after "=" of an option, and after redirections). ~, $HOME,
// ${HOME} and the other variables are expanded from ctx.env (an unknown one denies), relative paths are resolved against
// the call's cwd (or the worktree), and symlinks are followed with realpath (for a path that does not exist yet, of
// its deepest existing parent).
import { realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

const DEVICES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty'];
const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'cwd'];
// DEC-014: the facts only record_evidence.py writes. Agents may read them, never write them.
export const PROTECTED_MESSAGE = 'TASKS.json y artifacts/ solo los escribe record_evidence.py';
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const PROTECTED_TEXT = /(^|[^\w.-])(spec\/TASKS\.json|artifacts\/)/;
// Commands that only read; with one of these and no redirection or in-place flag, naming a protected path is fine.
const READ_ONLY = ['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'jq', 'wc', 'ls', 'stat', 'file', 'diff',
  'cmp', 'sha256sum', 'md5sum'];
const READ_ONLY_GIT = ['diff', 'show', 'log', 'status', 'blame', 'ls-files'];

/** Does a Bash command write spec/TASKS.json or artifacts/? (each simple command that names one must only read) */
function writesProtected(command) {
  if (!PROTECTED_TEXT.test(command)) return false;
  return command.split(/;|&&|\|\||\||\n/).some((part) => {
    if (!PROTECTED_TEXT.test(part)) return false;
    const w = shellWords(part.replace(/^\s*[\w]+=\S*\s+/, ''));
    if (/>/.test(part) || w.some((x) => /^(-i|--in-place|-delete|-exec)/.test(x))) return true;
    if (w[0] === 'git') return !READ_ONLY_GIT.includes(w[1]);
    if (w[0] === 'node') return !['scripts/check-spec.mjs', 'scripts/check-coverage.mjs'].includes(w[1]);
    return !READ_ONLY.includes(w[0]);
  });
}

const WRITERS = ['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'truncate', 'ln', 'chmod', 'chown', 'install', 'dd', 'unlink', 'shred'];
const GIT_WRITERS = ['rm', 'mv', 'checkout', 'restore', 'apply', 'reset', 'clean', 'stash'];
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does a Bash command write under one of the read-only directories `rels` (DEC-027)? Redirections into them, a
 * writing command (rm, mv, touch, tee…, sed -i, git rm/mv/checkout/…) naming them, or cp/rsync whose target is there. */
function writesUnder(command, rels) {
  if (rels.length === 0) return null;
  const re = new RegExp(`(^|[^\\w.-])(${rels.map(escRe).join('|')})`);
  if (!re.test(command)) return null;
  const names = (x) => re.test(` ${x}`);
  for (const part of command.split(/;|&&|\|\||\||\n/)) {
    if (!re.test(part)) continue;
    for (const m of part.matchAll(/>>?\s*([^\s;&|]+)/g)) if (names(m[1])) return rels.find((r) => names(m[1]).valueOf() && m[1].includes(r.replace(/\/$/, ''))) ?? rels[0];
    const w = shellWords(part.replace(/^\s*[\w]+=\S*\s+/, ''));
    const hit = w.slice(1).some(names);
    if (WRITERS.includes(w[0]) && hit) return rels[0];
    if (['cp', 'rsync'].includes(w[0]) && names(w.at(-1))) return rels[0];
    if (w[0] === 'sed' && w.some((x) => /^(-i|--in-place)/.test(x)) && hit) return rels[0];
    if (w[0] === 'git' && GIT_WRITERS.includes(w[1]) && hit) return rels[0];
  }
  return null;
}
const COMMIT_ARG_SHORT = 'mFCct';   // short options of git commit that take a value (the rest of the cluster, or the next word)
const COMMIT_ARG_LONG = ['--message', '--file', '--author', '--date', '--cleanup', '--fixup', '--squash', '--reuse-message',
  '--reedit-message', '--template', '--trailer', '--pathspec-from-file'];
/** Does a Bash command skip the commit hook (DEC-027, T-74)? git commit with -n/--no-verify as an option, git push
 * --no-verify, or git -c core.hooksPath=…; by the parsed options, never by the text of a message. */
export function skipsHooks(command) {
  for (const part of command.split(/;|&&|\|\||\||\n/)) {
    const w = shellWords(part.replace(/^\s*[\w]+=\S*\s+/, ''));
    if (w[0] !== 'git') continue;
    let i = 1;
    for (; i < w.length && w[i].startsWith('-'); i++) {   // git's own options, before the subcommand
      if (w[i] === '-c' && /^core\.hookspath=/i.test(w[i + 1] ?? '')) return true;
      if (/^-c/.test(w[i]) && /core\.hookspath=/i.test(w[i])) return true;
      if (['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(w[i])) i++;
    }
    const sub = w[i], rest = w.slice(i + 1);
    if (sub === 'push' && rest.includes('--no-verify')) return true;
    if (sub !== 'commit') continue;
    for (let j = 0; j < rest.length; j++) {
      const x = rest[j];
      if (x === '--') break;
      if (x === '--no-verify') return true;
      if (COMMIT_ARG_LONG.includes(x)) { j++; continue; }
      if (/^-[^-]/.test(x)) {
        for (let k = 1; k < x.length; k++) {
          if (x[k] === 'n') return true;
          if (COMMIT_ARG_SHORT.includes(x[k])) { if (k === x.length - 1) j++; break; }
        }
      }
    }
  }
  return false;
}

const SIMPLE = /;|&&|\|\||\||\n/;
const WRAPPERS = ['env', 'time', 'nice', 'nohup', 'command', 'exec', 'timeout'];
/** The words of a simple command without its leading assignments and wrappers (env, time, timeout -k 30 60…). */
function commandWords(part) {
  let w = shellWords(part);
  while (w.length > 0) {
    if (/^[A-Za-z_]\w*=/.test(w[0])) { w = w.slice(1); continue; }
    if (!WRAPPERS.includes(w[0])) break;
    const timeout = w[0] === 'timeout';
    w = w.slice(1);
    while (/^-/.test(w[0] ?? '')) w = w.slice(['-s', '-k', '-n', '--signal', '--kill-after'].includes(w[0]) ? 2 : 1);
    if (timeout) w = w.slice(1);   // the duration
  }
  return w;
}
/** Does a simple command run a whole test file or the suite (T-107)? npm test (t, tst), npm run test*, and node --test
 * (or node on a *.test.* file) without --test-name-pattern. */
function runsWholeTests(w) {
  if (w[0] === 'npm') {
    const [sub, script] = w.slice(1).filter((x) => !x.startsWith('-'));
    return ['test', 't', 'tst'].includes(sub) || (['run', 'run-script'].includes(sub) && /^test/.test(script ?? ''));
  }
  if (w[0] !== 'node' || w.includes('--check') || w.includes('-c')) return false;
  const testing = w.includes('--test') || w.slice(1).some((x) => /\.test\.[cm]?[jt]s$/.test(x));
  return testing && !w.some((x) => x === '--test-name-pattern' || x.startsWith('--test-name-pattern='));
}
/** Does a command end a simple command with a lone "&" (in the background)? Quoted text, &&, >&, &> and |& aside. */
const backgrounds = (command) => /(^|[^&>|])&(?![&>])/.test(command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ''));
/** The implementer's tests rule (T-107, DEC-045): it runs its task's verify (whole, or one of its simple commands) or
 * node --test --test-name-pattern=… on what it touches; never a whole test file, npm test or npm run test*, and nothing
 * in the background. → the reason to deny, or null. */
export function testsRule(tool, args = {}, verify = '') {
  if (tool !== 'Bash') return null;
  const command = String(args.command ?? '');
  if (args.run_in_background || backgrounds(command)) {
    return 'no command runs in the background for this agent (T-107, DEC-045): run it in the foreground';
  }
  const norm = (x) => x.trim().replace(/\s+/g, ' ');
  if (verify && norm(command) === norm(verify)) return null;
  const verifyParts = verify ? verify.split(SIMPLE).map(norm) : [];
  for (const part of command.split(SIMPLE)) {
    if (verifyParts.includes(norm(part)) || !runsWholeTests(commandWords(part))) continue;
    return `only the task's tests (T-107, DEC-045): run its verify${verify ? ` (${verify})` : ''} or node --test --test-name-pattern=<pattern> on the test files it touches; never a whole test file, npm test or npm run test*`;
  }
  return null;
}
/** Shell words of a command: quotes respected; operators, redirections and $( ) ` split words (no execution). */
export function shellWords(command) {
  const words = [];
  let cur = '';
  let quoted = false;
  const flush = () => { if (cur !== '' || quoted) words.push(cur); cur = ''; quoted = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      cur += command.slice(i + 1, end < 0 ? command.length : end); quoted = true; i = end < 0 ? command.length : end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < command.length) j++;
        cur += command[j];
      }
      quoted = true; i = j;
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i];
    } else if (/\s/.test(c) || ';&|<>()`'.includes(c)) {
      flush();
    } else if (c === '$' && command[i + 1] === '(') {
      flush(); i++;
    } else cur += c;
  }
  flush();
  return words;
}

/** Does a Bash word look like a path? (an absolute or home path, a variable, ./ ../, or any word with a "/") */
function pathLike(word) {
  if (!word || /\s/.test(word) || word.includes('://')) return null;
  if (/^-[^=]*=/.test(word)) return pathLike(word.slice(word.indexOf('=') + 1)); // --file=/x
  if (/^\d*$/.test(word)) return null;
  if (/^[~/$.]/.test(word) || word.includes('/')) return word;
  return null;
}

/** Expands a leading ~ and $VAR / ${VAR}; → { path } or { unknown: name }. */
function expand(raw, env) {
  let p = raw;
  if (p === '~' || p.startsWith('~/')) p = `${env.HOME ?? ''}${p.slice(1)}`;
  let unknown = null;
  p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => {
    const name = a ?? b;
    if (env[name] === undefined) { unknown ??= name; return ''; }
    return env[name];
  });
  return unknown ? { unknown } : { path: p };
}

/** The literal directory part of a glob ("src/**\/x" → "src"). */
const globBase = (p) => {
  const i = p.search(/[*?[]|(?<!\$)\{/); // ${VAR} is a variable, not a brace pattern
  if (i < 0) return p;
  const head = p.slice(0, i);
  return head.includes('/') ? head.slice(0, head.lastIndexOf('/')) || '/' : '.';
};

/** realpath of the deepest existing ancestor, plus the rest. */
function realOf(p, realpath) {
  let cur = p;
  const rest = [];
  for (;;) {
    try { return join(realpath(cur), ...rest.reverse()); } catch { /* does not exist (yet) */ }
    const parent = resolve(cur, '..');
    if (parent === cur) return p;
    rest.push(cur.slice(parent.length).replace(/^\/+/, ''));
    cur = parent;
  }
}

const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The raw path arguments of a tool call. */
export function rawPaths(tool, args = {}) {
  const out = [];
  for (const k of PATH_KEYS) if (typeof args[k] === 'string' && args[k] !== '') out.push(args[k]);
  if (tool === 'Glob' && typeof args.pattern === 'string') out.push(globBase(args.pattern));
  if (tool === 'Bash' && typeof args.command === 'string') {
    for (const w of shellWords(args.command)) {
      const p = pathLike(w);
      if (p) out.push(globBase(p));
    }
  }
  return out;
}

export function accessGuard(tool, args = {}, ctx = {}) {
  const realpath = ctx.realpath ?? realpathSync.native;
  const env = ctx.env ?? {};
  const home = ctx.home ?? env.HOME ?? '';
  if (!ctx.root || !home) return { decision: 'deny', reason: 'access_guard needs the worktree root and the home directory', paths: [] };
  const root = realOf(resolve(ctx.root), realpath);
  const allowed = [root, ...(ctx.allow ?? []).filter(Boolean).map((d) => realOf(resolve(d), realpath))];
  const privateDirs = (ctx.deny ?? []).filter(Boolean).flatMap((d) => {
    const p = resolve(expand(d, { ...env, HOME: home }).path ?? d);
    return [p, realOf(p, realpath)];
  });
  const base = typeof args.cwd === 'string' && args.cwd ? resolve(root, expand(args.cwd, { ...env, HOME: home }).path ?? args.cwd) : root;
  const paths = [];
  if (tool === 'Bash' && typeof args.command === 'string' && writesProtected(args.command)) {
    return { decision: 'deny', reason: PROTECTED_MESSAGE, paths };
  }
  if (tool === 'Bash' && typeof args.command === 'string' && skipsHooks(args.command)) {
    return { decision: 'deny', reason: 'the command skips the commit hook (DEC-027): no --no-verify, -n or core.hooksPath override; check:spec validates every commit', paths };
  }
  const verify = ctx.verify ?? env.AUTOPILOT_GUARD_VERIFY;
  if (typeof verify === 'string') {
    const why = testsRule(tool, args, verify);
    if (why) return { decision: 'deny', reason: why, paths };
  }
  const readOnly = (ctx.denyWrite ?? []).filter(Boolean).map((d) => d.replace(/^\.?\//, ''));
  const roMessage = (d) => `${d.endsWith('/') ? d : `${d}/`} is read-only for this agent (DEC-027): it may read and run it, never write it`;
  if (tool === 'Bash' && typeof args.command === 'string') {
    const d = writesUnder(args.command, readOnly);
    if (d) return { decision: 'deny', reason: roMessage(d), paths };
  }
  for (const raw of rawPaths(tool, args)) {
    const e = expand(raw, { ...env, HOME: home });
    if (e.unknown) return { decision: 'deny', reason: `cannot resolve $${e.unknown} in ${raw}: a path that cannot be checked is denied`, paths };
    const lexical = normalize(isAbsolute(e.path) ? e.path : resolve(base, e.path));
    const real = realOf(lexical, realpath);
    paths.push(real);
    if (privateDirs.some((d) => under(lexical, d) || under(real, d))) {
      return { decision: 'deny', reason: `${real} is under a denied path (private data of the agents)`, paths };
    }
    if (WRITE_TOOLS.includes(tool) && (real === join(root, 'spec', 'TASKS.json') || under(real, join(root, 'artifacts')))) {
      return { decision: 'deny', reason: PROTECTED_MESSAGE, paths };
    }
    const ro = WRITE_TOOLS.includes(tool) && readOnly.find((d) => under(real, join(root, d.replace(/\/$/, ''))));
    if (ro) return { decision: 'deny', reason: roMessage(ro), paths };
    // T-97: the run's records live in the worktree but are not the agent's; an explicitly allowed directory inside wins
    const runs = join(root, '.autopilot');
    if ((under(lexical, runs) || under(real, runs)) && !allowed.slice(1).some((d) => under(d, runs) && under(real, d))) {
      return { decision: 'deny', reason: `${real} is under ${runs}/, the records of the autopilot run: no agent reads or writes them`, paths };
    }
    if (DEVICES.includes(lexical)) continue;
    if (!allowed.some((d) => under(real, d))) {
      return { decision: 'deny', reason: `${real} is outside the worktree ${root}${allowed.length > 1 ? ' and the allowed directories' : ''}`, paths };
    }
  }
  return { decision: 'allow', reason: '', paths };
}
