'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInside, isInside, realParentInside } = require('../../src/lib/path-confine');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-pc-'));

test('resolveInside: simple name resolves under root', () => {
  assert.equal(resolveInside(ROOT, 'a.md'), path.join(ROOT, 'a.md'));
});

test('resolveInside: nested name resolves under root', () => {
  assert.equal(resolveInside(ROOT, 'sub/a.md'), path.join(ROOT, 'sub', 'a.md'));
});

test('resolveInside: dot name resolves to root itself', () => {
  assert.equal(resolveInside(ROOT, '.'), ROOT);
});

test('resolveInside: a parent-relative name throws', () => {
  assert.throws(() => resolveInside(ROOT, '../sibling'), /outside root/);
});

test('resolveInside: a deeply-nested parent-relative name throws', () => {
  assert.throws(() => resolveInside(ROOT, 'a/b/../../../sibling'), /outside root/);
});

test('resolveInside: an absolute name throws', () => {
  assert.throws(() => resolveInside(ROOT, '/abs/path'), /absolute path/);
});

test('resolveInside: an empty name throws', () => {
  assert.throws(() => resolveInside(ROOT, ''), /name required/);
});

test('resolveInside: a name containing a null byte throws', () => {
  assert.throws(() => resolveInside(ROOT, 'a\x00b'), /null byte/);
});

test('resolveInside: a missing root throws', () => {
  assert.throws(() => resolveInside('', 'a.md'), /root required/);
});

test('resolveInside: non-string root or name throws', () => {
  assert.throws(() => resolveInside(null, 'a.md'), /root required/);
  assert.throws(() => resolveInside(ROOT, null), /name required/);
});

test('isInside: a target inside root returns true', () => {
  assert.equal(isInside(ROOT, path.join(ROOT, 'a', 'b.md')), true);
});

test('isInside: a target outside root returns false', () => {
  assert.equal(isInside(ROOT, '/somewhere/else'), false);
});

test('isInside: a target built with ../ returns false', () => {
  assert.equal(isInside(ROOT, path.join(ROOT, '..', '..', 'sibling')), false);
});

test('isInside: root itself returns true', () => {
  assert.equal(isInside(ROOT, ROOT), true);
});

test('isInside: similar path prefix is not considered inside', () => {
  assert.equal(isInside(ROOT, ROOT + '-sibling'), false);
});

test('isInside: non-string root or target returns false', () => {
  assert.equal(isInside(null, ROOT), false);
  assert.equal(isInside(ROOT, null), false);
});

// Symlink-escape guard: the composition the fs:readFile handler uses to refuse
// a link inside root that points outside root (realpath, then isInside).
test('isInside rejects a symlink whose target escapes root (realpath re-check)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-sym-'));
  try {
    const outside = path.join(base, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    const root = path.join(base, 'proj');
    fs.mkdirSync(root);
    const inside = path.join(root, 'ok.txt');
    fs.writeFileSync(inside, 'safe');
    const evil = path.join(root, 'evil');
    fs.symlinkSync(outside, evil);
    // The confined string is inside root, but its realpath is not.
    assert.equal(isInside(root, fs.realpathSync(inside)), true);
    assert.equal(isInside(root, fs.realpathSync(evil)), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ─── realParentInside ──────────────────────────────────────────────────────

// The string checks above cannot see a link. That is enough for a path that
// exists, because the caller canonicalizes it and compares. It is not enough
// for a path that does not exist yet: realpath throws, and a create that falls
// back to the unresolved string writes through whatever the directories along
// it happen to be.

test('realParentInside: an ordinary new file under root is allowed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-rpi-'));
  try {
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    assert.equal(realParentInside(path.join(root, 'new.txt'), root), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('realParentInside: a new file under a real subdirectory is allowed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-rpi-'));
  try {
    const root = path.join(base, 'root');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    assert.equal(realParentInside(path.join(root, 'sub', 'new.txt'), root), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('realParentInside: a new file under a linked directory is refused', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-rpi-'));
  try {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, 'linkdir'));
    // The string resolves under root; the directory it names does not.
    assert.equal(realParentInside(path.join(root, 'linkdir', 'new.txt'), root), false,
      'a link in the path was accepted as inside root');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('realParentInside: a parent that does not exist is refused, not assumed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-rpi-'));
  try {
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    assert.equal(realParentInside(path.join(root, 'missing', 'new.txt'), root), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('realParentInside: a similar sibling name is not inside root', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-rpi-'));
  try {
    fs.mkdirSync(path.join(base, 'root'));
    fs.mkdirSync(path.join(base, 'rootevil'));
    assert.equal(realParentInside(path.join(base, 'rootevil', 'f.txt'), path.join(base, 'root')), false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('realParentInside: non-string input is refused', () => {
  for (const bad of [null, undefined, 42, '', {}]) {
    assert.equal(realParentInside(bad, '/tmp'), false);
    assert.equal(realParentInside('/tmp/x', bad), false);
  }
});
