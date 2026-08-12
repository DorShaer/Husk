'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { countLines, lineDelta, emptyRunStats, addFileDelta } = require('../../src/lib/autopilot-linestats');

test('countLines treats a trailing newline as a terminator, not a line', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines(null), 0);
});

test('lineDelta counts only the lines that actually appear or vanish', () => {
  assert.deepEqual(lineDelta('a\nb\nc\n', 'a\nb\nc\n'), { insertions: 0, deletions: 0 });
  assert.deepEqual(lineDelta('a\nb\n', 'a\nb\nc\n'), { insertions: 1, deletions: 0 });
  assert.deepEqual(lineDelta('a\nb\nc\n', 'a\nc\n'), { insertions: 0, deletions: 1 });
  assert.deepEqual(lineDelta('a\nb\n', 'b\na\n'), { insertions: 0, deletions: 0 });
});

test('lineDelta reads a new file as pure insertion and a removed file as pure deletion', () => {
  assert.deepEqual(lineDelta('', 'x\ny\n'), { insertions: 2, deletions: 0 });
  assert.deepEqual(lineDelta('x\ny\n', ''), { insertions: 0, deletions: 2 });
});

test('lineDelta respects repeated lines', () => {
  assert.deepEqual(lineDelta('a\na\n', 'a\na\na\n'), { insertions: 1, deletions: 0 });
  assert.deepEqual(lineDelta('a\na\na\n', 'a\n'), { insertions: 0, deletions: 2 });
});

test('addFileDelta folds each outcome into the run totals', () => {
  const stats = emptyRunStats();
  addFileDelta(stats, 'added', { insertions: 10, deletions: 0 });
  addFileDelta(stats, 'modified', { insertions: 3, deletions: 4 });
  addFileDelta(stats, 'deleted', { insertions: 0, deletions: 7 });
  assert.deepEqual(stats, {
    files: 3, added: 1, modified: 1, deleted: 1, insertions: 13, deletions: 11, truncated: false,
  });
});

test('addFileDelta treats an unknown status as a modification and ignores junk counts', () => {
  const stats = addFileDelta(emptyRunStats(), 'renamed', { insertions: -5, deletions: 'nope' });
  assert.equal(stats.modified, 1);
  assert.equal(stats.insertions, 0);
  assert.equal(stats.deletions, 0);
});
