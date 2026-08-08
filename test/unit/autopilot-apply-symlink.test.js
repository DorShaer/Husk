'use strict';

// Applying an Autopilot run must write the path the operator reviewed, and not
// wherever a link at that path happens to point.
//
// A workspace can contain links that Husk did not create. Git stores symlinks,
// so a checked-out repository may carry one at an ordinary-looking path, and
// the run's own agent can create more. The review an operator sees names a
// relative path and shows its text; it says nothing about what that path
// resolves to in the destination. These tests pin that distinction from both
// directions: what an apply must refuse, and what it must still do.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyWorktreeChanges } = require('../../src/lib/autopilot-apply');

let base;
let wt;
let ws;
let outside;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-apply-sym-'));
  wt = path.join(base, 'worktree');
  ws = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  fs.mkdirSync(wt, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
});

// A file that lives outside the workspace. Its contents must survive untouched,
// whatever a link inside the workspace points at.
function plantTarget(name, body) {
  const p = path.join(outside, name);
  fs.writeFileSync(p, body);
  return p;
}

test('a symlinked destination file is refused, and its target is untouched', () => {
  const target = plantTarget('outside-file.txt', 'ORIGINAL');
  fs.symlinkSync(target, path.join(ws, 'config.json'));
  fs.writeFileSync(path.join(wt, 'config.json'), 'FROM_WORKTREE');

  const r = applyWorktreeChanges(wt, ws, [{ path: 'config.json', status: 'modified' }]);

  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL', 'the apply wrote through a symlink');
  assert.equal(r.ok, false, 'a refused write was reported as a clean apply');
  assert.equal(r.applied.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /symbolic link/, `unexpected reason: ${r.failed[0].reason}`);
});

test('a symlinked parent directory is refused, and nothing lands outside', () => {
  // The link is a directory component rather than the file itself, which a
  // string check cannot see at all: workspace/cfg/app.json still resolves under
  // workspace as a string.
  fs.symlinkSync(outside, path.join(ws, 'cfg'));
  fs.mkdirSync(path.join(wt, 'cfg'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'cfg', 'app.json'), 'FROM_WORKTREE');

  const r = applyWorktreeChanges(wt, ws, [{ path: 'cfg/app.json', status: 'added' }]);

  assert.equal(fs.existsSync(path.join(outside, 'app.json')), false,
    'the apply wrote through a symlinked directory');
  assert.equal(r.ok, false);
  assert.match(r.failed[0].reason, /outside workspace root/, `unexpected reason: ${r.failed[0].reason}`);
});

test('deleting through a symlink removes the link, never the file it points at', () => {
  const target = plantTarget('outside-file.txt', 'ORIGINAL');
  const link = path.join(ws, 'stale.txt');
  fs.symlinkSync(target, link);

  const r = applyWorktreeChanges(wt, ws, [{ path: 'stale.txt', status: 'deleted' }]);

  assert.equal(fs.existsSync(target), true, 'the delete followed a symlink out of the workspace');
  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.equal(fs.existsSync(link), false, 'the link itself survived the delete');
  assert.equal(r.ok, true);
});

test('a delete under a symlinked directory does not reach outside', () => {
  plantTarget('outside-file.txt', 'ORIGINAL');
  fs.symlinkSync(outside, path.join(ws, 'cfg'));

  const r = applyWorktreeChanges(wt, ws, [{ path: 'cfg/outside-file.txt', status: 'deleted' }]);

  assert.equal(fs.existsSync(path.join(outside, 'outside-file.txt')), true,
    'the delete reached through a symlinked directory');
  assert.equal(r.ok, false);
});

// The controls must not cost the ordinary case anything.

test('an ordinary added file still applies', () => {
  fs.writeFileSync(path.join(wt, 'new.txt'), 'hello');
  const r = applyWorktreeChanges(wt, ws, [{ path: 'new.txt', status: 'added' }]);
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(fs.readFileSync(path.join(ws, 'new.txt'), 'utf8'), 'hello');
});

test('an ordinary modified file is overwritten in place', () => {
  fs.writeFileSync(path.join(ws, 'f.txt'), 'before');
  fs.writeFileSync(path.join(wt, 'f.txt'), 'after');
  const r = applyWorktreeChanges(wt, ws, [{ path: 'f.txt', status: 'modified' }]);
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(fs.readFileSync(path.join(ws, 'f.txt'), 'utf8'), 'after');
});

test('a nested file creates its real directories and applies', () => {
  fs.mkdirSync(path.join(wt, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'a', 'b', 'c.txt'), 'deep');
  const r = applyWorktreeChanges(wt, ws, [{ path: 'a/b/c.txt', status: 'added' }]);
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(fs.readFileSync(path.join(ws, 'a', 'b', 'c.txt'), 'utf8'), 'deep');
});

test('one refused path does not stop the others, and the refusal is named', () => {
  const target = plantTarget('outside-file.txt', 'ORIGINAL');
  fs.symlinkSync(target, path.join(ws, 'bad.txt'));
  fs.writeFileSync(path.join(wt, 'bad.txt'), 'FROM_WORKTREE');
  fs.writeFileSync(path.join(wt, 'good.txt'), 'fine');

  const r = applyWorktreeChanges(wt, ws, [
    { path: 'bad.txt', status: 'modified' },
    { path: 'good.txt', status: 'added' },
  ]);

  assert.equal(fs.readFileSync(target, 'utf8'), 'ORIGINAL');
  assert.equal(fs.readFileSync(path.join(ws, 'good.txt'), 'utf8'), 'fine',
    'a refusal on one path blocked an unrelated one');
  assert.equal(r.ok, false, 'a partial apply reported itself as complete');
  assert.equal(r.applied.length, 1);
  assert.equal(r.failed.length, 1);
});
