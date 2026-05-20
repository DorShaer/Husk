'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveInside, isInside } = require('../../src/lib/path-confine');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-pc-'));

test('resolveInside: simple name resolves under root', () => {
  assert.equal(resolveInside(ROOT, 'a.md'), path.join(ROOT, 'a.md'));
});

test('resolveInside: nested name resolves under root', () => {
  assert.equal(resolveInside(ROOT, 'sub/a.md'), path.join(ROOT, 'sub', 'a.md'));
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
