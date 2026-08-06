'use strict';

// Apply used to be the one irreversible step in a system whose whole promise is
// reversibility. The pre-run snapshot captures the run's worktree, Apply copies
// out of that worktree into the real project, and Apply then deletes the
// worktree. Revert therefore restored a directory nobody was looking at while
// every applied change stayed in the repo.
//
// The fix is a scoped snapshot of the destination, taken before the copy. These
// tests exercise that round trip against the real modules: capture the project
// side of the change set, apply, then restore and assert the project is back
// where it started without touching anything the apply never wrote.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Snapshot = require('../../src/lib/autonomy/snapshot');
const { applyWorktreeChanges } = require('../../src/lib/autopilot-apply');

let tmp;
let wt;      // the run's isolated worktree
let ws;      // the user's real project
let storage; // autopilot storage root

const SID = 'auto-test-preapply';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-apply-undo-'));
  wt = path.join(tmp, 'worktree');
  ws = path.join(tmp, 'project');
  storage = path.join(tmp, 'storage');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
});

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

// ─── scoped capture ──────────────────────────────────────────────────────────

test('scoped capture records only the named paths and marks the manifest scoped', () => {
  write(ws, 'src/a.js', 'original a');
  write(ws, 'src/untouched.js', 'not part of this change set');

  const res = Snapshot.captureSnapshot(ws, storage, SID, { paths: ['src/a.js', 'src/added.js'] });

  assert.equal(res.ok, true);
  assert.equal(res.manifest.scoped, true);
  assert.deepEqual(Object.keys(res.manifest.entries).sort(), ['src/a.js', 'src/added.js']);
  assert.equal(res.manifest.entries['src/a.js'].type, 'file');
  // The path that does not exist yet is the one that makes the undo symmetric.
  assert.equal(res.manifest.entries['src/added.js'].type, 'absent');
});

test('a full capture is not marked scoped, so strict restore still applies', () => {
  write(ws, 'src/a.js', 'original a');
  const res = Snapshot.captureSnapshot(ws, storage, SID, {});
  assert.equal(res.ok, true);
  assert.equal(res.manifest.scoped, false);
});

// ─── the round trip this fix exists for ──────────────────────────────────────

test('apply then revert puts the project back and removes what the run added', () => {
  // Project before the run.
  write(ws, 'src/a.js', 'original a');
  write(ws, 'src/keep.js', 'never part of the run');
  write(ws, 'src/gone.js', 'the run deletes this');

  // What the run produced in its worktree.
  write(wt, 'src/a.js', 'agent edited a');
  write(wt, 'src/deep/new/added.js', 'agent added this');

  const changes = [
    { path: 'src/a.js', status: 'modified' },
    { path: 'src/deep/new/added.js', status: 'added' },
    { path: 'src/gone.js', status: 'deleted' },
  ];

  const cap = Snapshot.captureSnapshot(ws, storage, SID, { paths: changes.map((c) => c.path) });
  assert.equal(cap.ok, true);

  const applied = applyWorktreeChanges(wt, ws, changes);
  assert.equal(applied.ok, true);
  assert.equal(read(ws, 'src/a.js'), 'agent edited a');
  assert.equal(read(ws, 'src/deep/new/added.js'), 'agent added this');
  assert.equal(exists(ws, 'src/gone.js'), false);

  // The worktree is removed right after a successful apply, exactly as
  // autopilot:applyRun does. The undo must not depend on it.
  fs.rmSync(wt, { recursive: true, force: true });

  const rev = Snapshot.restoreFromSnapshot(ws, storage, SID, {});
  assert.equal(rev.ok, true);
  assert.deepEqual(rev.warnings, []);

  assert.equal(read(ws, 'src/a.js'), 'original a');
  assert.equal(read(ws, 'src/gone.js'), 'the run deletes this');
  assert.equal(exists(ws, 'src/deep/new/added.js'), false);
  // The directories Apply created on the way to the added file go too.
  assert.equal(exists(ws, 'src/deep'), false);
  // Anything the run never touched is untouched.
  assert.equal(read(ws, 'src/keep.js'), 'never part of the run');
});

test('restoring a scoped manifest never deletes the rest of the project', () => {
  write(ws, 'src/a.js', 'original a');
  write(ws, 'src/b.js', 'unrelated');
  write(ws, 'README.md', 'unrelated');

  const cap = Snapshot.captureSnapshot(ws, storage, SID, { paths: ['src/a.js'] });
  assert.equal(cap.ok, true);
  write(ws, 'src/a.js', 'changed');

  // preserveExtras is deliberately NOT passed. The scoped flag on the manifest
  // has to be enough, or a caller who forgets it wipes the project.
  const rev = Snapshot.restoreFromSnapshot(ws, storage, SID, {});
  assert.equal(rev.ok, true);
  assert.equal(read(ws, 'src/a.js'), 'original a');
  assert.equal(read(ws, 'src/b.js'), 'unrelated');
  assert.equal(read(ws, 'README.md'), 'unrelated');
});

test('a full manifest still performs a strict revert', () => {
  write(ws, 'src/a.js', 'original a');
  const cap = Snapshot.captureSnapshot(ws, storage, SID, {});
  assert.equal(cap.ok, true);

  write(ws, 'src/a.js', 'changed');
  write(ws, 'src/agent-added.js', 'added after the snapshot');

  const rev = Snapshot.restoreFromSnapshot(ws, storage, SID, {});
  assert.equal(rev.ok, true);
  assert.equal(read(ws, 'src/a.js'), 'original a');
  assert.equal(exists(ws, 'src/agent-added.js'), false);
});

// ─── safety ──────────────────────────────────────────────────────────────────

test('scoped capture refuses paths that escape the workspace root', () => {
  write(ws, 'src/a.js', 'original a');
  const res = Snapshot.captureSnapshot(ws, storage, SID, { paths: ['../outside.js', 'src/a.js'] });
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.manifest.entries), ['src/a.js']);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0].reason, /escapes workspaceRoot/);
});

test('scoped capture round-trips a symlink without following it', () => {
  write(ws, 'real.txt', 'real content');
  fs.symlinkSync('real.txt', path.join(ws, 'link.txt'));

  const cap = Snapshot.captureSnapshot(ws, storage, SID, { paths: ['link.txt'] });
  assert.equal(cap.ok, true);
  assert.equal(cap.manifest.entries['link.txt'].type, 'symlink');
  assert.equal(cap.manifest.entries['link.txt'].target, 'real.txt');

  fs.rmSync(path.join(ws, 'link.txt'));
  const rev = Snapshot.restoreFromSnapshot(ws, storage, SID, {});
  assert.equal(rev.ok, true);
  assert.equal(fs.readlinkSync(path.join(ws, 'link.txt')), 'real.txt');
});

test('an encrypted scoped undo round-trips through decrypt', () => {
  const encrypt = (buf) => Buffer.concat([Buffer.from('X'), buf]);
  const decrypt = (buf) => buf.subarray(1);

  write(ws, 'src/a.js', 'original a');
  const cap = Snapshot.captureSnapshot(ws, storage, SID, { paths: ['src/a.js'], encrypt });
  assert.equal(cap.ok, true);

  write(ws, 'src/a.js', 'changed');
  const rev = Snapshot.restoreFromSnapshot(ws, storage, SID, { decrypt });
  assert.equal(rev.ok, true);
  assert.equal(read(ws, 'src/a.js'), 'original a');
});
