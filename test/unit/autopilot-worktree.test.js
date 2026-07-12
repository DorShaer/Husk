'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createRunWorktree, removeRunWorktree, worktreeRoot } = require('../../src/lib/autopilot-worktree');

let tmpDir;
let userData;
let repoDir;

function initGitRepo(dir) {
  execFileSync('git', ['init', dir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-wt-test-'));
  userData = path.join(tmpDir, 'userData');
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('worktreeRoot returns path under userData', () => {
  const r = worktreeRoot('/some/userData');
  assert.equal(r, path.join('/some/userData', 'autopilot-worktrees'));
});

test('createRunWorktree creates a worktree under managed root', () => {
  const result = createRunWorktree(userData, 'run-abc', repoDir);
  assert.equal(result.ok, true, result.error);
  assert.ok(result.worktreePath.startsWith(worktreeRoot(userData)));
  assert.ok(fs.existsSync(result.worktreePath));
  assert.ok(fs.existsSync(path.join(result.worktreePath, 'readme.txt')));
});

test('createRunWorktree refuses non-git directory', () => {
  const nonGit = path.join(tmpDir, 'plain');
  fs.mkdirSync(nonGit);
  const result = createRunWorktree(userData, 'run-abc', nonGit);
  assert.equal(result.ok, false);
  assert.match(result.error, /git repository/);
});

test('createRunWorktree refuses HOME as workspaceRoot', () => {
  const result = createRunWorktree(userData, 'run-abc', os.homedir());
  assert.equal(result.ok, false);
  assert.match(result.error, /home directory/i);
});

test('createRunWorktree fails with missing args', () => {
  assert.equal(createRunWorktree('', 'run-abc', repoDir).ok, false);
  assert.equal(createRunWorktree(userData, '', repoDir).ok, false);
  assert.equal(createRunWorktree(userData, 'run-abc', '').ok, false);
});

test('createRunWorktree refuses runIds that escape the managed root', () => {
  const result = createRunWorktree(userData, '../escape', repoDir);
  assert.equal(result.ok, false);
  assert.match(result.error, /escapes managed root/);
  assert.equal(fs.existsSync(path.join(userData, 'escape')), false);
});

test('removeRunWorktree removes the worktree directory', () => {
  const result = createRunWorktree(userData, 'run-xyz', repoDir);
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.worktreePath));
  removeRunWorktree(result.worktreePath, repoDir);
  assert.equal(fs.existsSync(result.worktreePath), false);
});

test('removeRunWorktree is a no-op when path does not exist', () => {
  assert.doesNotThrow(() => removeRunWorktree('/nonexistent/path', repoDir));
});

test('removeRunWorktree handles null gracefully', () => {
  assert.doesNotThrow(() => removeRunWorktree(null, repoDir));
});

test('worktree path is confined under managed root, not project root', () => {
  const result = createRunWorktree(userData, 'run-confined', repoDir);
  assert.equal(result.ok, true);
  const resolvedWt = path.resolve(result.worktreePath);
  const resolvedRepo = path.resolve(repoDir);
  assert.equal(resolvedWt.startsWith(resolvedRepo), false, 'worktree must not be inside project');
});
