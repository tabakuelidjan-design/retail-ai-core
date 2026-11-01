// Regression (2026-11-01, Windows): JsonlCallJournal judged "inside the repository" against process.cwd(). Launched from a parent folder or the user's home,
// every journal under it was refused even when it was outside the repository; launched from INSIDE a sub-folder of the repo, a journal elsewhere in the repo
// was accepted. The check now uses the repository that holds the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { JsonlCallJournal, repositoryRootOf, isInside } from '../src/marketing-creative/alibaba/journal.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the repository root is found from the code, not from the working directory', () => {
  assert.equal(repositoryRootOf(), repositoryRootOf(path.join(REPO, 'src', 'marketing-creative')));
  const root = repositoryRootOf();
  assert.ok(root && isInside(root, REPO));
});

test('a git WORKTREE (.git is a file) is recognised as a repository', () => {
  const wt = mkdtempSync(path.join(tmpdir(), 'wt-'));
  writeFileSync(path.join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
  mkdirSync(path.join(wt, 'src', 'a'), { recursive: true });
  assert.equal(repositoryRootOf(path.join(wt, 'src', 'a')), wt);
});

test('cwd is a PARENT of the output folder: a journal outside the repository is accepted (the Windows false refusal)', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'home-'));
  const before = process.cwd();
  try {
    process.chdir(parent);
    const j = new JsonlCallJournal(path.join(parent, 'nordla-essais', 'essai-1', 'calls.jsonl'));
    assert.ok(j.filePath.startsWith(parent));
  } finally { process.chdir(before); }
});

test('cwd OUTSIDE the repository: a journal inside the repository is still refused (fail-closed)', () => {
  const before = process.cwd();
  try {
    process.chdir(tmpdir());
    assert.throws(() => new JsonlCallJournal(path.join(REPO, 'data', 'calls.jsonl')), /outside repository/);
    assert.throws(() => new JsonlCallJournal(REPO), /outside repository/);
  } finally { process.chdir(before); }
});

test('an explicit repository root is honoured; relative paths stay refused', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'repo-'));
  assert.throws(() => new JsonlCallJournal(path.join(repo, 'x.jsonl'), { repositoryRoot: repo }), /outside repository/);
  assert.ok(new JsonlCallJournal(path.join(tmpdir(), 'elsewhere', 'x.jsonl'), { repositoryRoot: repo }));
  assert.throws(() => new JsonlCallJournal('relative/x.jsonl'), /absolute/);
});

test('Windows paths: case-insensitive, sibling folders with a common prefix are not "inside"', () => {
  const w = path.win32;
  assert.equal(isInside('C:\\Users\\elidjan\\retail-ai-core', 'c:\\users\\ELIDJAN\\retail-ai-core\\data\\x.jsonl', w), true);
  assert.equal(isInside('C:\\Users\\elidjan\\retail-ai-core', 'C:\\Users\\elidjan\\retail-ai-core-essais\\x.jsonl', w), false);
  assert.equal(isInside('C:\\Users\\elidjan\\retail-ai-core', 'C:\\Users\\elidjan\\nordla-essais\\x.jsonl', w), false);
  assert.equal(isInside('C:\\Users\\elidjan\\retail-ai-core', 'D:\\nordla\\x.jsonl', w), false);
  assert.equal(isInside('/repo', '/repo-other/x', path.posix), false);
  assert.equal(isInside('/repo', '/repo', path.posix), true);
});
