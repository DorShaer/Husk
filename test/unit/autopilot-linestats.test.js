'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { countLines, lineDelta, emptyRunStats, addFileDelta } = require('../../src/lib/autopilot-linestats');

test('empty text holds no lines and a trailing newline invents none', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines(null), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\n'), 1);
  assert.equal(countLines('one\ntwo'), 2);
  assert.equal(countLines('one\ntwo\n'), 2);
});

test('a new file counts every line as an insertion', () => {
  assert.deepEqual(lineDelta('', 'a\nb\nc\n'), { insertions: 3, deletions: 0 });
});

test('a removed file counts every line as a deletion', () => {
  assert.deepEqual(lineDelta('a\nb\n', ''), { insertions: 0, deletions: 2 });
});

test('an edited file reports both sides', () => {
  assert.deepEqual(lineDelta('a\nb\nc\n', 'a\nB\nc\nd\n'), { insertions: 2, deletions: 1 });
});

test('untouched content reports no change', () => {
  assert.deepEqual(lineDelta('a\nb\n', 'a\nb\n'), { insertions: 0, deletions: 0 });
});

test('repeated lines are counted by how many of them there are', () => {
  assert.deepEqual(lineDelta('a\na\n', 'a\na\na\n'), { insertions: 1, deletions: 0 });
});

test('a line that moves counts as neither side', () => {
  assert.deepEqual(lineDelta('a\nb\n', 'b\na\n'), { insertions: 0, deletions: 0 });
});

test('file deltas fold into one run total by status', () => {
  const stats = emptyRunStats();
  addFileDelta(stats, 'added', { insertions: 10, deletions: 0 });
  addFileDelta(stats, 'modified', { insertions: 4, deletions: 3 });
  addFileDelta(stats, 'deleted', { insertions: 0, deletions: 7 });
  assert.deepEqual(stats, {
    files: 3, added: 1, modified: 1, deleted: 1,
    insertions: 14, deletions: 10, truncated: false,
  });
});

test('an unrecognised status folds in as a modification and junk counts are ignored', () => {
  const stats = addFileDelta(emptyRunStats(), 'renamed', { insertions: -5, deletions: 'nope' });
  assert.equal(stats.modified, 1);
  assert.equal(stats.insertions, 0);
  assert.equal(stats.deletions, 0);
});
