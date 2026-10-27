// spec/LOG.md is append-only: two branches that each append an entry must merge without conflict (.gitattributes
// merge=union), which is what scripts/merge-pr.sh relies on.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

test('.gitattributes merges spec/LOG.md by union: two appended entries never conflict', () => {
  const attributes = readFileSync(join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^spec\/LOG\.md merge=union$/m);

  const repo = mkdtempSync(join(tmpdir(), 'merge-union-'));
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'spec'));
  writeFileSync(join(repo, '.gitattributes'), attributes);
  writeFileSync(join(repo, 'spec/LOG.md'), '# LOG\n\n## entrada 0\n- base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');

  git(repo, 'checkout', '-q', '-b', 'pr-a');
  writeFileSync(join(repo, 'spec/LOG.md'), '# LOG\n\n## entrada 0\n- base\n\n## entrada A\n- del PR A\n');
  git(repo, 'commit', '-q', '-am', 'A');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'spec/LOG.md'), '# LOG\n\n## entrada 0\n- base\n\n## entrada B\n- del PR B\n');
  git(repo, 'commit', '-q', '-am', 'B');

  git(repo, 'merge', '-q', '--no-edit', 'pr-a');
  const merged = readFileSync(join(repo, 'spec/LOG.md'), 'utf8');
  assert.ok(!merged.includes('<<<<<<<'), merged);
  assert.ok(merged.includes('## entrada A') && merged.includes('## entrada B'), merged);
});

test('scripts/merge-pr.sh brings main into the PR branch, waits for MERGEABLE and merges with --delete-branch', () => {
  const script = readFileSync(join(root, 'scripts/merge-pr.sh'), 'utf8');
  for (const s of ['git merge-base --is-ancestor origin/main HEAD', 'origin/main', 'mergeable', 'gh pr merge "$n" --merge --delete-branch', 'Task: none', 'Req: none']) {
    assert.ok(script.includes(s), s);
  }
  assert.throws(() => execFileSync(join(root, 'scripts/merge-pr.sh'), ['abc'], { stdio: 'pipe' }), /usage/);
  assert.ok(script.includes('gh pr view --json number'), 'without a number it takes the PR of the current branch');
});
