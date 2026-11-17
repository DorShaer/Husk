'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyWorktreeChanges, findApplyConflicts, isSafeRelPath } = require('../../src/lib/autopilot-apply');

let tmp;
let wt;
let ws;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-apply-test-'));
  wt = path.join(tmp, 'worktree');
  ws = path.join(tmp, 'workspace');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

// ─── path safety ─────────────────────────────────────────────────────────────

test('isSafeRelPath rejects absolute and traversal paths', () => {
  assert.equal(isSafeRelPath('src/a.js'), true);
  assert.equal(isSafeRelPath('a/b/c.txt'), true);
  assert.equal(isSafeRelPath('/etc/passwd'), false);
  assert.equal(isSafeRelPath('../outside'), false);
  assert.equal(isSafeRelPath('a/../../b'), false);
  assert.equal(isSafeRelPath(''), false);
  assert.equal(isSafeRelPath(null), false);
});

// ─── added / modified copy ───────────────────────────────────────────────────

test('applies an added file from worktree into workspace', () => {
  fs.writeFileSync(path.join(wt, 'new.txt'), 'hello');
  const r = applyWorktreeChanges(wt, ws, [{ path: 'new.txt', status: 'added' }]);
  assert.equal(r.ok, true);
  assert.equal(r.applied.length, 1);
  assert.equal(fs.readFileSync(path.join(ws, 'new.txt'), 'utf8'), 'hello');
});

test('applies a modified file, overwriting the workspace copy', () => {
  fs.writeFileSync(path.join(ws, 'f.txt'), 'old');
  fs.writeFileSync(path.join(wt, 'f.txt'), 'new');
  const r = applyWorktreeChanges(wt, ws, [{ path: 'f.txt', status: 'modified' }]);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(ws, 'f.txt'), 'utf8'), 'new');
});

test('creates nested parent directories when applying', () => {
  fs.mkdirSync(path.join(wt, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'a', 'b', 'deep.txt'), 'x');
  const r = applyWorktreeChanges(wt, ws, [{ path: 'a/b/deep.txt', status: 'added' }]);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(ws, 'a', 'b', 'deep.txt')), true);
});

// ─── deleted ─────────────────────────────────────────────────────────────────

test('applies a deletion by removing the workspace file', () => {
  fs.writeFileSync(path.join(ws, 'gone.txt'), 'bye');
  const r = applyWorktreeChanges(wt, ws, [{ path: 'gone.txt', status: 'deleted' }]);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(ws, 'gone.txt')), false);
});

test('applies a recovered rename as delete plus add without duplicating the old file', () => {
  fs.writeFileSync(path.join(ws, 'old.txt'), 'old');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'new');
  const r = applyWorktreeChanges(wt, ws, [
    { path: 'old.txt', status: 'deleted' },
    { path: 'new.txt', status: 'added' },
  ]);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(ws, 'old.txt')), false);
  assert.equal(fs.readFileSync(path.join(ws, 'new.txt'), 'utf8'), 'new');
});

test('deletion of a non-existent file still succeeds (idempotent)', () => {
  const r = applyWorktreeChanges(wt, ws, [{ path: 'never.txt', status: 'deleted' }]);
  assert.equal(r.ok, true);
});

// ─── per-file honesty ────────────────────────────────────────────────────────

test('reports per-file failure without aborting the whole apply', () => {
  fs.writeFileSync(path.join(wt, 'good.txt'), 'ok');
  // 'bad.txt' is not present in the worktree → copy fails, but good.txt applies.
  const r = applyWorktreeChanges(wt, ws, [
    { path: 'good.txt', status: 'added' },
    { path: 'bad.txt', status: 'added' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.applied.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.applied[0].path, 'good.txt');
  assert.equal(r.failed[0].path, 'bad.txt');
});

test('rejects a traversal path in changes without touching the filesystem', () => {
  const r = applyWorktreeChanges(wt, ws, [{ path: '../escape.txt', status: 'added' }]);
  assert.equal(r.ok, false);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /unsafe/);
  assert.equal(fs.existsSync(path.join(tmp, 'escape.txt')), false);
});

// ─── argument guards ─────────────────────────────────────────────────────────

test('missing roots return an error, not a throw', () => {
  assert.equal(applyWorktreeChanges('', ws, []).ok, false);
  assert.equal(applyWorktreeChanges(wt, '', []).ok, false);
  assert.equal(applyWorktreeChanges(wt, ws, null).ok, false);
});

test('empty change set is a trivial success', () => {
  const r = applyWorktreeChanges(wt, ws, []);
  assert.equal(r.ok, true);
  assert.equal(r.applied.length, 0);
  assert.equal(r.failed.length, 0);
});

test('skips the Autopilot status file when applying changes', () => {
  fs.writeFileSync(path.join(wt, '.husk-autopilot-status.json'), '{"status":"complete"}');
  const r = applyWorktreeChanges(wt, ws, [{ path: '.husk-autopilot-status.json', status: 'added' }]);
  assert.equal(r.ok, true);
  assert.equal(r.applied.length, 0);
  assert.equal(fs.existsSync(path.join(ws, '.husk-autopilot-status.json')), false);
});

function fileEntry(text) {
  return { type: 'file', sha: require('crypto').createHash('sha256').update(text).digest('hex') };
}

test('conflicts compare binary bytes to the starting snapshot and accept the run result on repeat', () => {
  const base = Buffer.from([0, 1, 2]);
  const mine = Buffer.from([0, 4, 5]);
  const theirs = Buffer.from([0, 7, 8]);
  fs.writeFileSync(path.join(ws, 'a.bin'), base);
  fs.writeFileSync(path.join(wt, 'a.bin'), theirs);
  const changes = [{ path: 'a.bin', status: 'modified' }];
  const entries = { 'a.bin': fileEntry(base) };
  assert.deepEqual(findApplyConflicts(wt, ws, changes, entries), []);
  fs.writeFileSync(path.join(ws, 'a.bin'), mine);
  assert.deepEqual(findApplyConflicts(wt, ws, changes, entries), [{ path: 'a.bin', kind: 'edited', runStatus: 'modified' }]);
  applyWorktreeChanges(wt, ws, changes);
  assert.deepEqual(findApplyConflicts(wt, ws, changes, entries), []);
});

test('conflicts protect a local deletion, an edited run deletion, and a colliding new file', () => {
  fs.writeFileSync(path.join(wt, 'local-deletion'), 'run');
  fs.writeFileSync(path.join(ws, 'run-deletion'), 'my edit');
  fs.writeFileSync(path.join(wt, 'new-file'), 'run');
  fs.writeFileSync(path.join(ws, 'new-file'), 'mine');
  const changes = [
    { path: 'local-deletion', status: 'modified' },
    { path: 'run-deletion', status: 'deleted' },
    { path: 'new-file', status: 'added' },
  ];
  assert.deepEqual(findApplyConflicts(wt, ws, changes, {
    'local-deletion': fileEntry('base'), 'run-deletion': fileEntry('base'),
  }), [
    { path: 'local-deletion', kind: 'deleted', runStatus: 'modified' },
    { path: 'run-deletion', kind: 'edited', runStatus: 'deleted' },
    { path: 'new-file', kind: 'created', runStatus: 'added' },
  ]);
});

test('conflicts ignore files both you and the run deleted and unsafe paths', () => {
  assert.deepEqual(findApplyConflicts(wt, ws, [
    { path: 'gone', status: 'deleted' }, { path: '../outside', status: 'modified' },
  ], { gone: fileEntry('base') }), []);
});
