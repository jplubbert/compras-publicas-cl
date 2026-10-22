import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expect } from './expect.mjs';
import { accessGuard } from '../lib/access-policy.mjs';

// The port access_guard (DEC-016, DEC-013): a pure core, tested without any agent, and the Claude Code adapter (a
// PreToolUse hook) tested apart. A temporary "home" holds .claude/ and .codex/; the worktree lives inside it.
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const HOOK = join(REPO, 'scripts/agents/claude-access-hook.mjs');

let base;
let home;
let root;
let result;
// the private data to deny comes from the adapters and the project (the core names no agent)
const ctx = (extra = {}) => ({ root, home, allow: [result], deny: [join(home, '.claude'), join(home, '.codex')], env: { HOME: home, RESULT: result }, ...extra });
const guard = (tool, args, extra) => accessGuard(tool, args, ctx(extra)).decision;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'access-policy-')));
  home = join(base, 'home');
  root = join(home, 'Projects', 'repo');
  result = join(base, 'result');
  for (const d of [join(home, '.claude', 'projects', 'p', 's', 'tool-results'), join(home, '.codex'), join(root, 'src'), result]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', 'p', 's', 'tool-results', 'out.txt'), 'secret\n');
  writeFileSync(join(home, 'notes.txt'), 'outside the worktree\n');
  writeFileSync(join(root, 'src', 'a.mjs'), 'export {};\n');
  symlinkSync(join(home, '.claude'), join(root, 'link-claude'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('access_guard core (DEC-016)', () => {
  it('allows what is inside the worktree, the role\'s result directory, /dev/null and tools without paths', () => {
    expect(guard('Read', { file_path: join(root, 'src/a.mjs') })).toBe('allow');
    expect(guard('Read', { file_path: 'src/a.mjs' })).toBe('allow');
    expect(guard('Write', { file_path: join(result, 'r.json') })).toBe('allow');
    expect(guard('Grep', { pattern: '/etc/passwd|~/.claude', path: 'src' })).toBe('allow'); // Grep's pattern is a regex
    expect(guard('Glob', { pattern: 'src/**/*.mjs' })).toBe('allow');
    expect(guard('Bash', { command: 'npm test 2>/dev/null' })).toBe('allow');
    expect(guard('Bash', { command: 'git log -n 5 -- src/a.mjs' })).toBe('allow');
    expect(guard('Bash', { command: 'node -e "console.log(1 / 2)"' })).toBe('allow');
    expect(guard('WebSearch', { query: 'express 5 routing' })).toBe('allow');
    expect(guard('WebFetch', { url: 'https://example.com/a/b' })).toBe('allow');
  });

  const claude = () => join(home, '.claude');
  for (const [name, tool, args] of [
    ['Read of ~/.claude by absolute path', 'Read', () => ({ file_path: join(claude(), 'projects/p/s/tool-results/out.txt') })],
    ['Read with a literal ~', 'Read', () => ({ file_path: '~/.claude/projects/p/s/tool-results/out.txt' })],
    ['Read with $HOME', 'Read', () => ({ file_path: '$HOME/.claude/x' })],
    ['Read of ~/.codex', 'Read', () => ({ file_path: '~/.codex/auth.json' })],
    ['Read through a relative path out of the worktree', 'Read', () => ({ file_path: '../../.claude/x' })],
    ['Read through a symlink in the worktree', 'Read', () => ({ file_path: 'link-claude/projects/p/s/tool-results/out.txt' })],
    ['Read of a file outside the worktree', 'Read', () => ({ file_path: join(home, 'notes.txt') })],
    ['Grep with a path in ~/.claude', 'Grep', () => ({ pattern: 'secret', path: join(claude(), 'projects') })],
    ['Grep through the symlink', 'Grep', () => ({ pattern: 'secret', path: 'link-claude' })],
    ['Glob with a pattern under ~/.claude', 'Glob', () => ({ pattern: '~/.claude/**/*.txt' })],
    ['Glob with a path outside', 'Glob', () => ({ pattern: '*.txt', path: home })],
    ['Bash cat', 'Bash', () => ({ command: `cat ${join(claude(), 'projects/p/s/tool-results/out.txt')}` })],
    ['Bash rg with ${HOME}', 'Bash', () => ({ command: 'rg secret "${HOME}/.claude"' })],
    ['Bash find on ~', 'Bash', () => ({ command: "find ~/.claude -name '*.txt'" })],
    ['Bash ls through the symlink', 'Bash', () => ({ command: 'ls link-claude/' })],
    ['Bash in a pipeline after a harmless command', 'Bash', () => ({ command: 'git status && cat ~/.codex/auth.json | head' })],
    ['Bash with a redirection out of the worktree', 'Bash', () => ({ command: `echo x >${join(home, 'notes.txt')}` })],
    ['Bash inside a command substitution', 'Bash', () => ({ command: 'echo $(cat ~/.claude/x)' })],
    ['Bash with an option value', 'Bash', () => ({ command: `grep -r secret --include=x ${home}` })],
    ['a cwd outside the worktree', 'Bash', () => ({ command: 'ls', cwd: claude() })],
  ]) {
    it(`denies ${name}`, () => {
      const r = accessGuard(tool, args(), ctx());
      expect(r.decision).toBe('deny');
      expect(r.reason.length > 0).toBe(true);
    });
  }

  it('names no agent: without deny paths, ~/.claude is just a path outside the worktree', () => {
    expect(accessGuard('Read', { file_path: '~/.claude/x' }, ctx({ deny: [] }))).toMatchObject({ decision: 'deny', reason: expect.stringContaining('outside the worktree') });
  });

  it('denies a variable it cannot resolve rather than guessing', () => {
    expect(accessGuard('Bash', { command: 'cat $UNKNOWN_DIR/x' }, ctx())).toMatchObject({ decision: 'deny', reason: expect.stringContaining('UNKNOWN_DIR') });
    expect(guard('Bash', { command: 'cat $RESULT/r.json' })).toBe('allow');
  });

  it('says which path and why', () => {
    const r = accessGuard('Read', { file_path: '~/.claude/x' }, ctx());
    expect(r.reason).toContain(join(home, '.claude/x'));
    expect(r.reason).toContain('a denied path (private data of the agents)');
    expect(accessGuard('Read', { file_path: join(home, 'notes.txt') }, ctx()).reason).toContain('outside the worktree');
  });
});

describe('write-protected paths: tests/acceptance/ for the implementer (DEC-027, T-59)', () => {
  const dw = { denyWrite: ['tests/acceptance/'] };
  beforeEach(() => { mkdirSync(join(root, 'tests', 'acceptance'), { recursive: true }); writeFileSync(join(root, 'tests', 'acceptance', 'a.test.sh'), 'true\n'); });
  it('denies Write, Edit and MultiEdit under it, and Bash commands that write there', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) expect(guard(tool, { file_path: join(root, 'tests/acceptance/a.test.sh') }, dw)).toBe('deny');
    expect(guard('Write', { file_path: join(root, 'tests/acceptance/new/b.test.sh') }, dw)).toBe('deny');
    for (const command of ['echo x > tests/acceptance/a.test.sh', 'rm tests/acceptance/a.test.sh', 'sed -i s/a/b/ tests/acceptance/a.test.sh',
      'git rm tests/acceptance/a.test.sh', 'mv tests/acceptance/a.test.sh /tmp/x', `cp src/a.mjs ${join(root, 'tests/acceptance/c.mjs')}`]) {
      expect(accessGuard('Bash', { command }, ctx(dw))).toMatchObject({ decision: 'deny', reason: expect.stringContaining('tests/acceptance/ is read-only for this agent (DEC-027)') });
    }
  });
  it('still allows reading and running them, and writing elsewhere; without denyWrite nothing changes', () => {
    expect(guard('Read', { file_path: join(root, 'tests/acceptance/a.test.sh') }, dw)).toBe('allow');
    for (const command of ['cat tests/acceptance/a.test.sh', 'sh tests/acceptance/a.test.sh', 'git diff tests/acceptance/', 'grep -r x tests/acceptance']) expect(guard('Bash', { command }, dw)).toBe('allow');
    expect(guard('Write', { file_path: join(root, 'src/b.mjs') }, dw)).toBe('allow');
    expect(guard('Write', { file_path: join(root, 'tests/acceptance/a.test.sh') })).toBe('allow');
  });
  it('the hook takes it as --deny-write', () => {
    const r = spawnSync('node', [HOOK, '--root', root, '--deny-write', 'tests/acceptance/'], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(root, 'tests/acceptance/a.test.sh') }, cwd: root }), encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('read-only for this agent (DEC-027)');
  });
});

describe('the run records in the worktree: .autopilot/ is denied (T-97)', () => {
  const run = () => join(root, '.autopilot', '2026-10-22_003744');
  beforeEach(() => {
    mkdirSync(run(), { recursive: true }); writeFileSync(join(run(), 'T-84-result-1.json'), '{}\n');
    mkdirSync(join(root, 'docs'), { recursive: true }); writeFileSync(join(root, 'docs', '.autopilot-notes'), 'x\n');
  });
  for (const [name, tool, args] of [
    ['T-97 Bash ls of a run directory by absolute path', 'Bash', () => ({ command: `ls ${run()}/` })],
    ['T-97 Bash ls by relative path', 'Bash', () => ({ command: 'ls .autopilot/' })],
    ['T-97 Bash ls of .autopilot itself', 'Bash', () => ({ command: 'ls -la .autopilot' })],
    ['T-97 Bash cat of a result', 'Bash', () => ({ command: 'cat .autopilot/2026-10-22_003744/T-84-result-1.json' })],
    ['T-97 Bash with a cwd inside it', 'Bash', () => ({ command: 'ls', cwd: '.autopilot' })],
    ['T-97 Read of a result', 'Read', () => ({ file_path: join(run(), 'T-84-result-1.json') })],
    ['T-97 Grep under it', 'Grep', () => ({ pattern: 'x', path: '.autopilot' })],
    ['T-97 Glob under it', 'Glob', () => ({ pattern: '.autopilot/**/*.json' })],
    ['T-97 Write into it', 'Write', () => ({ file_path: join(root, '.autopilot/new.json') })],
    ['T-97 Edit of a result', 'Edit', () => ({ file_path: join(run(), 'T-84-result-1.json') })],
  ]) {
    it(`denies ${name}, saying they are the run records`, () => {
      expect(accessGuard(tool, args(), ctx())).toMatchObject({ decision: 'deny', reason: expect.stringContaining('records of the autopilot run') });
    });
  }
  it('T-97 allows a path that only contains ".autopilot" elsewhere, and an allowed directory inside .autopilot/', () => {
    expect(guard('Read', { file_path: join(root, 'docs/.autopilot-notes') })).toBe('allow');
    expect(guard('Bash', { command: 'cat docs/.autopilot-notes' })).toBe('allow');
    expect(guard('Read', { file_path: join(root, '.autopilotrc') })).toBe('allow');
    expect(guard('Write', { file_path: join(run(), 'r.json') }, { allow: [result, run()] })).toBe('allow');
    expect(guard('Read', { file_path: join(root, '.autopilot/other.json') }, { allow: [result, run()] })).toBe('deny');
  });
  it('T-97 the hook denies it with exit 2', () => {
    const r = spawnSync('node', [HOOK, '--root', root], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls .autopilot/2026-10-22_003744/' }, cwd: root }), encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('records of the autopilot run');
  });
});

describe('no skipping the commit hook: by the real options of the command, not by its text (DEC-027, T-74)', () => {
  it('denies git commit with -n or --no-verify (also in a cluster like -nm), git push --no-verify and git -c core.hooksPath', () => {
    for (const command of ['git commit -n -m x', 'git commit -nm x', 'git commit -am x --no-verify', 'git commit --no-verify',
      'git push --no-verify origin HEAD', 'git -c core.hooksPath=/dev/null commit -m x', 'git -c core.hookspath=x commit -m y', 'cd . && git commit -n -m x']) {
      expect(accessGuard('Bash', { command }, ctx())).toMatchObject({ decision: 'deny', reason: expect.stringContaining('skips the commit hook (DEC-027)') });
    }
  });
  it('allows a commit whose message mentions -n or --no-verify, and the options that only look alike', () => {
    for (const command of ['git commit -m "T-70: deny -n flag"', "git commit -m 'explain --no-verify'", 'git commit -m x -m "uses -nm too"',
      'git commit --amend --no-edit', 'git log -n 5', 'git push -n origin HEAD', 'git -c user.name=T commit -m x', 'git commit -F msg.txt']) {
      expect(guard('Bash', { command })).toBe('allow');
    }
  });
});

describe('the implementer runs only its task\'s tests (T-107, DEC-045)', () => {
  const verify = 'node --test --test-name-pattern=T-107 scripts/test/access-policy.test.mjs scripts/test/autopilot-tasks.test.mjs && npm run check:spec';
  const impl = { verify };
  const tests = (command, extra = {}) => accessGuard('Bash', { command, ...extra }, ctx(impl));
  it('T-107 denies a whole test file, npm test and npm run test*, naming the rule', () => {
    for (const command of ['node --test scripts/test/autopilot-tasks.test.mjs', 'node --test', 'node scripts/test/access-policy.test.mjs',
      'timeout 900 node --test scripts/test/a.test.mjs', 'CI=1 node --test --test-skip-pattern=x scripts/test/a.test.mjs',
      'npm test', 'npm t', 'npm run test', 'npm run test:sdd', 'git status; npm test -- --x']) {
      expect(tests(command)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('only the task\'s tests (T-107, DEC-045)') });
    }
    expect(tests('npm test').reason).toContain(verify);
  });
  it('T-107 allows a run by --test-name-pattern, the exact verify and each of its commands', () => {
    for (const command of ['node --test --test-name-pattern=T-107 scripts/test/autopilot-tasks.test.mjs',
      'node --test --test-name-pattern "T-107" scripts/test/access-policy.test.mjs', verify, `  ${verify.replace(' && ', '  &&  ')} `,
      'npm run check:spec', 'node --check scripts/test/a.test.mjs', 'node scripts/check-spec.mjs', 'git log -n 5']) {
      expect(tests(command).decision).toBe('allow');
    }
  });
  it('T-107 the verify itself is allowed even when it runs a whole file', () => {
    const whole = { verify: 'node --test scripts/test/a.test.mjs' };
    expect(guard('Bash', { command: 'node --test scripts/test/a.test.mjs' }, whole)).toBe('allow');
    expect(guard('Bash', { command: 'node --test scripts/test/b.test.mjs' }, whole)).toBe('deny');
  });
  it('T-107 denies a command in the background (run_in_background or a trailing &)', () => {
    for (const [command, extra] of [['node --test --test-name-pattern=T-107 scripts/test/a.test.mjs', { run_in_background: true }],
      [verify, { run_in_background: true }], ['sleep 1 &', {}], ['npm run check:spec & wait', {}]]) {
      expect(tests(command, extra)).toMatchObject({ decision: 'deny', reason: expect.stringContaining('no command runs in the background for this agent (T-107') });
    }
    for (const command of ['npm run check:spec 2>&1', 'npm run check:spec &>/dev/null', 'git log --grep="a & b"']) expect(tests(command).decision).toBe('allow');
  });
  it('T-107 without a verify (any other role) nothing changes; the hook takes it from AUTOPILOT_GUARD_VERIFY', () => {
    expect(guard('Bash', { command: 'npm test' })).toBe('allow');
    expect(guard('Bash', { command: 'sleep 1', run_in_background: true })).toBe('allow');
    const run = (env) => spawnSync('node', [HOOK, '--root', root], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: root }), encoding: 'utf8', env });
    const { AUTOPILOT_GUARD_VERIFY: _, ...rest } = { ...process.env, HOME: home };
    const denied = run({ ...rest, AUTOPILOT_GUARD_VERIFY: verify });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain('(T-107, DEC-045)');
    expect(run(rest).status).toBe(0);
  });
});

describe('access_guard Claude Code adapter (PreToolUse hook)', () => {
  const hook = (input, args = []) => spawnSync('node', [HOOK, '--root', root, '--allow', result, '--deny', join(home, '.claude'), '--deny', join(home, '.codex'), ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: home },
  });

  it('calls the port: a denial blocks with exit 2 and the reason on stderr; an allowed call exits 0', () => {
    const denied = hook({ tool_name: 'Grep', tool_input: { pattern: 'x', path: join(home, '.claude') }, cwd: root });
    expect(denied.status).toBe(2);
    expect(denied.stderr).toContain('access_guard (DEC-016): denied');
    expect(denied.stderr).toContain(join(home, '.claude'));
    expect(hook({ tool_name: 'Read', tool_input: { file_path: join(root, 'src/a.mjs') }, cwd: root }).status).toBe(0);
  });

  it('agrees with the core on every tool and path it is given', () => {
    for (const [tool, args] of [['Read', { file_path: 'link-claude/x' }], ['Bash', { command: 'ls src' }], ['Bash', { command: 'cat ~/.codex/a' }], ['Glob', { pattern: 'src/*' }]]) {
      const expected = accessGuard(tool, args, ctx({ env: { ...process.env, HOME: home } })).decision === 'deny' ? 2 : 0;
      expect(hook({ tool_name: tool, tool_input: args, cwd: root }).status).toBe(expected);
    }
  });

  it('fails closed: unreadable input or a missing root blocks the tool', () => {
    expect(hook('not json').status).toBe(2);
    const noRoot = spawnSync('node', [HOOK], { input: '{"tool_name":"Read","tool_input":{"file_path":"a"}}', encoding: 'utf8' });
    expect(noRoot.status).toBe(2);
  });
});

describe('another repository (DEC-021)', () => {
  const REPO_DIR = fileURLToPath(new URL('../../', import.meta.url));
  const command = (external) => {
    const profile = join(base, 'profile.sh');
    writeFileSync(profile, ['PROFILE_ROLE=implementer', 'PROFILE_READ=("*")', 'PROFILE_WRITE=("*")', 'PROFILE_COMMANDS=()', 'PROFILE_DENIED_COMMANDS=()',
      'PROFILE_DENY=(.autopilot/)', 'PROFILE_AGENT_ALLOWED=()', 'PROFILE_AGENT_DENIED=()', 'PROFILE_WEB=0', 'PROFILE_SUBAGENTS=0', 'PROFILE_RESULT_DIR=',
      'PROFILE_MAX_USD=', 'PROFILE_MODEL=', `PROFILE_CHARTER=${base}/c.md`, `PROFILE_ROOT=${root}`, 'PROFILE_TASK=', 'PROFILE_GUARD_DENY=()',
      `PROFILE_EXTERNAL_REPOS=(${external.join(' ')})`, ''].join('\n'));
    return spawnSync('bash', ['-c', `. ${join(REPO_DIR, 'scripts/agents/claude.sh')}; agent_claude_command ${profile}`], { encoding: 'utf8' }).stdout;
  };
  it('the guard denies writing or running in another repository', () => {
    const other = join(home, 'Projects', 'other');
    mkdirSync(other, { recursive: true });
    expect(guard('Write', { file_path: join(other, 'a.txt') })).toBe('deny');
    expect(guard('Bash', { command: `git -C ${other} commit -am x` })).toBe('deny');
    expect(guard('Bash', { command: `npm test --prefix ${other}` })).toBe('deny');
    expect(guard('Write', { file_path: join(other, 'a.txt') }, { allow: [result, other] })).toBe('allow');
  });
  it('the adapter allows only the repositories the task declares, approved', () => {
    expect(command([])).not.toContain('--allow\\ /srv/other');
    expect(command(['/srv/other'])).toContain('--allow\\ /srv/other');
  });
});
