'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePorcelain, statusBadge } = require('../../src/lib/git-porcelain');

test('parsePorcelain: empty input yields empty array', () => {
  assert.deepEqual(parsePorcelain(''), []);
  assert.deepEqual(parsePorcelain('\n'), []);
});

test('parsePorcelain: non-string input yields empty array', () => {
  assert.deepEqual(parsePorcelain(null), []);
});

test('parsePorcelain: modified in working tree', () => {
  const [entry] = parsePorcelain(' M src/app.js\n');
  assert.deepEqual(entry, {
    path: 'src/app.js',
    status: 'modified',
    staged: false,
    unstaged: true,
  });
});

test('parsePorcelain: staged vs unstaged columns', () => {
  const staged = parsePorcelain('M  src/a.js\n')[0];
  assert.equal(staged.staged, true);
  assert.equal(staged.unstaged, false);

  const both = parsePorcelain('MM src/b.js\n')[0];
  assert.equal(both.staged, true);
  assert.equal(both.unstaged, true);
});

test('parsePorcelain: added file', () => {
  const [entry] = parsePorcelain('A  new.txt\n');
  assert.equal(entry.status, 'added');
  assert.equal(entry.path, 'new.txt');
  assert.equal(entry.staged, true);
  assert.equal(entry.unstaged, false);
});

test('parsePorcelain: deleted file', () => {
  const [entry] = parsePorcelain(' D gone.txt\n');
  assert.equal(entry.status, 'deleted');
  assert.equal(entry.unstaged, true);
  assert.equal(entry.staged, false);
});

test('parsePorcelain: untracked file', () => {
  const [entry] = parsePorcelain('?? junk.log\n');
  assert.deepEqual(entry, {
    path: 'junk.log',
    status: 'untracked',
    staged: false,
    unstaged: true,
  });
});

test('parsePorcelain: ignored file', () => {
  const [entry] = parsePorcelain('!! node_modules/\n');
  assert.deepEqual(entry, {
    path: 'node_modules/',
    status: 'ignored',
    staged: false,
    unstaged: false,
  });
});

test('parsePorcelain: rename keeps the new path', () => {
  const [entry] = parsePorcelain('R  old/name.js -> new/name.js\n');
  assert.equal(entry.status, 'renamed');
  assert.equal(entry.path, 'new/name.js');
  assert.equal(entry.staged, true);
});

test('parsePorcelain: copy keeps the new path', () => {
  const [entry] = parsePorcelain('C  base.txt -> copy.txt\n');
  assert.equal(entry.status, 'copied');
  assert.equal(entry.path, 'copy.txt');
});

test('parsePorcelain: type change', () => {
  const [entry] = parsePorcelain('T  link\n');
  assert.equal(entry.status, 'type-changed');
});

test('parsePorcelain: conflicted (unmerged) file', () => {
  const uu = parsePorcelain('UU merge.txt\n')[0];
  assert.equal(uu.status, 'conflicted');
  assert.equal(uu.staged, true);
  assert.equal(uu.unstaged, true);

  const aa = parsePorcelain('AA both-added.txt\n')[0];
  assert.equal(aa.status, 'conflicted');
});

test('parsePorcelain: quoted path with escapes is decoded', () => {
  // Path containing a space, a tab and a quote character.
  const [entry] = parsePorcelain(' M "with space\\tand\\"quote.js"\n');
  assert.equal(entry.path, 'with space\tand"quote.js');
  assert.equal(entry.status, 'modified');
});

test('parsePorcelain: quoted path with octal escapes decodes UTF-8', () => {
  // "café.txt" - the é is encoded as its two UTF-8 bytes in octal.
  const [entry] = parsePorcelain(' M "caf\\303\\251.txt"\n');
  assert.equal(entry.path, 'café.txt');
});

test('parsePorcelain: quoted path keeps unknown escapes literally', () => {
  const [entry] = parsePorcelain(' M "literal\\qescape.txt"\n');
  assert.equal(entry.path, 'literalqescape.txt');
});

test('parsePorcelain: quoted rename decodes both sides and keeps new', () => {
  const [entry] = parsePorcelain('R  "old name.js" -> "new name.js"\n');
  assert.equal(entry.status, 'renamed');
  assert.equal(entry.path, 'new name.js');
});

test('parsePorcelain: multiple lines in one status block', () => {
  const text = 'M  a.js\n?? b.log\n D c.txt\n';
  const entries = parsePorcelain(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.status), ['modified', 'untracked', 'deleted']);
});

test('parsePorcelain: unknown status code defaults to modified label', () => {
  const [entry] = parsePorcelain('X  odd.txt\n');
  assert.equal(entry.status, 'modified');
  assert.equal(entry.staged, true);
  assert.equal(entry.unstaged, false);
});

test('statusBadge: maps every human label to its single letter', () => {
  assert.equal(statusBadge('modified'), 'M');
  assert.equal(statusBadge('added'), 'A');
  assert.equal(statusBadge('deleted'), 'D');
  assert.equal(statusBadge('untracked'), '?');
  assert.equal(statusBadge('renamed'), 'R');
  assert.equal(statusBadge('copied'), 'C');
  assert.equal(statusBadge('type-changed'), 'T');
  assert.equal(statusBadge('conflicted'), 'U');
  assert.equal(statusBadge('ignored'), '!');
  assert.equal(statusBadge('unknown-thing'), '?');
});
