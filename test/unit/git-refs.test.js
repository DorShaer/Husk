'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  parseForEachRef,
  parseTrack,
  parseWorktreeList,
  parseLogRecords,
  parseNumstat,
} = require('../../src/lib/git-refs');

// Every fixture below is real output, captured from a throwaway repository that
// was built to carry the awkward cases: a gone upstream, a branch another
// worktree holds, a root commit, a body with blank lines, a rename, a binary
// file and a path with a quote and a tab in its name.

const FOR_EACH_REF = [
  'feature/gone\x1fa17f50a2e2a4\x1forigin/feature/gone\x1f[gone]\x1f1787498655\x1ffeat(core): local two\x1f \x1f',
  'feature/side\x1f29d39af00bb8\x1f\x1f\x1f1787498655\x1ffeat(side): side commit\x1f \x1f/tmp/scmcap/wt-side',
  'main\x1fa17f50a2e2a4\x1forigin/main\x1f[ahead 2, behind 1]\x1f1787498655\x1ffeat(core): local two\x1f*\x1f/tmp/scmcap/work',
  'origin/main\x1f6a8e4182343a\x1f\x1f\x1f1787498655\x1fchore(core): remote only commit\x1f \x1f',
].join('\n') + '\n';

const WORKTREE_LIST = [
  'worktree /tmp/scmcap/work',
  'HEAD a17f50a2e2a4d86feb933cabf7f09c02065248f5',
  'branch refs/heads/main',
  '',
  'worktree /tmp/scmcap/wt-detached',
  'HEAD a17f50a2e2a4d86feb933cabf7f09c02065248f5',
  'detached',
  'locked busy',
  '',
  'worktree /tmp/scmcap/wt-side',
  'HEAD 29d39af00bb88663182e0706b5c4351740f83286',
  'branch refs/heads/feature/side',
  '',
].join('\n');

const BARE_WORKTREE_LIST = ['worktree /tmp/scmcap/bare.git', 'bare', ''].join('\n');

const LOG = [
  'a17f50a2e2a4d86feb933cabf7f09c02065248f5\x1fa17f50a\x1f1ad8a35f1662e1c7b554098a4c9f3620e31cf65a\x1fTest\x1ftest@example.com\x1f1787498655\x1fHEAD -> main, feature/gone\x1ffeat(core): local two\x1f\x1e',
  '1ad8a35f1662e1c7b554098a4c9f3620e31cf65a\x1f1ad8a35\x1fa3586052f833168795377a7d30bd6b65de8fb31b\x1fTest\x1ftest@example.com\x1f1787498655\x1f\x1ffeat(core): local one\x1f\x1e',
  'a3586052f833168795377a7d30bd6b65de8fb31b\x1fa358605\x1fda1db66a370c117aed5d6f763493023a7964d5ae\x1fTest\x1ftest@example.com\x1f1787498655\x1f\x1ffix(core): second commit\x1fA body line.',
  'Another body line.',
  '',
  'With a blank line inside.',
  '\x1e',
  'da1db66a370c117aed5d6f763493023a7964d5ae\x1fda1db66\x1f\x1fTest\x1ftest@example.com\x1f1787498655\x1f\x1ffeat(core): first commit\x1f\x1e',
].join('\n') + '\n';

const LOG_PUNCTUATION = [
  '5fe13efa93bb938d09f628b95fb2f53cdfbdd6b4\x1f5fe13ef\x1fc25e03e8eac67950cf4a0ed77020d0d97b588e96\x1fTest\x1ftest@example.com\x1f1787498681\x1fHEAD -> main\x1fchore(core): mixed\x1f\x1e',
  'c25e03e8eac67950cf4a0ed77020d0d97b588e96\x1fc25e03e\x1f\x1fTest\x1ftest@example.com\x1f1787498681\x1f\x1ffeat(core): seed -> the tree {a => b}\x1f\x1e',
].join('\n') + '\n';

// diff --cached --numstat -z: a modification, a binary file, a rename and a
// path carrying a quote and a tab.
const NUMSTAT_Z = '1\t0\ta.txt\x00-\t-\tbin.dat\x001\t0\t\x00src/old.txt\x00src/new.txt\x001\t0\twe"ird\tname.txt\x00';

// The same change set without -z, where git quotes the awkward path and folds
// the rename into a brace form.
const NUMSTAT_LINES = [
  '1\t0\ta.txt',
  '-\t-\tbin.dat',
  '1\t0\tsrc/{old.txt => new.txt}',
  '1\t0\t"we\\"ird\\tname.txt"',
].join('\n') + '\n';

const NUMSTAT_Z_RENAME_ONLY = '0\t0\t\x00src/deep.txt\x00src/nested/deep.txt\x00';

test('for-each-ref output parses into one record per ref', () => {
  const refs = parseForEachRef(FOR_EACH_REF);
  assert.strictEqual(refs.length, 4);
  assert.deepStrictEqual(refs.map((r) => r.name), ['feature/gone', 'feature/side', 'main', 'origin/main']);
  assert.strictEqual(refs[2].sha, 'a17f50a2e2a4');
  assert.strictEqual(refs[2].subject, 'feat(core): local two');
  assert.strictEqual(refs[2].dateMs, 1787498655000);
  assert.strictEqual(refs[2].isHead, true);
  assert.strictEqual(refs[0].isHead, false);
});

test('a branch with no upstream reports no upstream and no counts', () => {
  const side = parseForEachRef(FOR_EACH_REF).find((r) => r.name === 'feature/side');
  assert.strictEqual(side.upstream, null);
  assert.strictEqual(side.ahead, null);
  assert.strictEqual(side.behind, null);
  assert.strictEqual(side.gone, false);
});

test('a branch whose upstream is gone says so and carries no counts', () => {
  const gone = parseForEachRef(FOR_EACH_REF).find((r) => r.name === 'feature/gone');
  assert.strictEqual(gone.upstream, 'origin/feature/gone');
  assert.strictEqual(gone.gone, true);
  assert.strictEqual(gone.ahead, null);
  assert.strictEqual(gone.behind, null);
});

test('a branch another worktree holds carries that worktree path', () => {
  const refs = parseForEachRef(FOR_EACH_REF);
  assert.strictEqual(refs.find((r) => r.name === 'feature/side').worktreePath, '/tmp/scmcap/wt-side');
  assert.strictEqual(refs.find((r) => r.name === 'origin/main').worktreePath, null);
});

test('the tracked counts come off the upstream field', () => {
  const main = parseForEachRef(FOR_EACH_REF).find((r) => r.name === 'main');
  assert.strictEqual(main.upstream, 'origin/main');
  assert.strictEqual(main.ahead, 2);
  assert.strictEqual(main.behind, 1);
});

test('the track field reads every form git prints, including the empty one', () => {
  assert.deepStrictEqual(parseTrack('[ahead 2, behind 1]'), { ahead: 2, behind: 1, gone: false });
  assert.deepStrictEqual(parseTrack('[ahead 3]'), { ahead: 3, behind: 0, gone: false });
  assert.deepStrictEqual(parseTrack('[behind 4]'), { ahead: 0, behind: 4, gone: false });
  assert.deepStrictEqual(parseTrack('[gone]'), { ahead: 0, behind: 0, gone: true });
  assert.deepStrictEqual(parseTrack(''), { ahead: 0, behind: 0, gone: false });
  assert.deepStrictEqual(parseTrack(null), { ahead: 0, behind: 0, gone: false });
});

test('worktree list parses the main tree, a detached tree and a locked tree', () => {
  const list = parseWorktreeList(WORKTREE_LIST);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list[0], {
    path: '/tmp/scmcap/work',
    head: 'a17f50a2e2a4d86feb933cabf7f09c02065248f5',
    branch: 'main',
    detached: false,
    bare: false,
    locked: false,
  });
  assert.strictEqual(list[1].detached, true);
  assert.strictEqual(list[1].locked, true);
  assert.strictEqual(list[1].branch, null);
  assert.strictEqual(list[2].branch, 'feature/side');
});

test('a bare repository parses as one bare entry with no head', () => {
  const list = parseWorktreeList(BARE_WORKTREE_LIST);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].bare, true);
  assert.strictEqual(list[0].head, null);
  assert.strictEqual(list[0].branch, null);
});

test('log records parse with their parents, refs and dates', () => {
  const recs = parseLogRecords(LOG);
  assert.strictEqual(recs.length, 4);
  assert.strictEqual(recs[0].shortSha, 'a17f50a');
  assert.deepStrictEqual(recs[0].parents, ['1ad8a35f1662e1c7b554098a4c9f3620e31cf65a']);
  assert.deepStrictEqual(recs[0].refs, ['HEAD -> main', 'feature/gone']);
  assert.strictEqual(recs[0].author, 'Test');
  assert.strictEqual(recs[0].email, 'test@example.com');
  assert.strictEqual(recs[0].dateMs, 1787498655000);
  assert.strictEqual(recs[1].refs.length, 0);
});

test('a commit body with its own blank lines survives the record split', () => {
  const rec = parseLogRecords(LOG).find((r) => r.shortSha === 'a358605');
  assert.strictEqual(rec.subject, 'fix(core): second commit');
  assert.strictEqual(rec.body, 'A body line.\nAnother body line.\n\nWith a blank line inside.');
});

test('a root commit reports no parents rather than an empty name', () => {
  const root = parseLogRecords(LOG).find((r) => r.shortSha === 'da1db66');
  assert.deepStrictEqual(root.parents, []);
  assert.strictEqual(root.body, '');
});

test('a subject carrying an arrow and braces is read as one subject', () => {
  const recs = parseLogRecords(LOG_PUNCTUATION);
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[1].subject, 'feat(core): seed -> the tree {a => b}');
  assert.deepStrictEqual(recs[1].parents, []);
});

test('the two numstat formats read the same change set the same way', () => {
  const expected = [
    { adds: 1, dels: 0, path: 'a.txt', oldPath: null, binary: false },
    { adds: 0, dels: 0, path: 'bin.dat', oldPath: null, binary: true },
    { adds: 1, dels: 0, path: 'src/new.txt', oldPath: 'src/old.txt', binary: false },
    { adds: 1, dels: 0, path: 'we"ird\tname.txt', oldPath: null, binary: false },
  ];
  assert.deepStrictEqual(parseNumstat(NUMSTAT_Z), expected);
  assert.deepStrictEqual(parseNumstat(NUMSTAT_LINES), expected);
});

test('a binary file reports zero counts and says it is binary', () => {
  const bin = parseNumstat(NUMSTAT_Z).find((e) => e.path === 'bin.dat');
  assert.strictEqual(bin.binary, true);
  assert.strictEqual(bin.adds, 0);
  assert.strictEqual(bin.dels, 0);
});

test('a rename into a new directory keeps both paths', () => {
  assert.deepStrictEqual(parseNumstat(NUMSTAT_Z_RENAME_ONLY), [
    { adds: 0, dels: 0, path: 'src/nested/deep.txt', oldPath: 'src/deep.txt', binary: false },
  ]);
  assert.deepStrictEqual(parseNumstat('0\t0\tsrc/{ => nested}/deep.txt\n'), [
    { adds: 0, dels: 0, path: 'src/nested/deep.txt', oldPath: 'src/deep.txt', binary: false },
  ]);
});

test('malformed input reads as no records rather than throwing', () => {
  const parsers = [parseForEachRef, parseWorktreeList, parseLogRecords, parseNumstat];
  for (const parse of parsers) {
    for (const value of [null, undefined, '', 0, 42, {}, [], true]) {
      assert.deepStrictEqual(parse(value), [], String(typeof value));
    }
    assert.deepStrictEqual(parse('nonsense with no separators'), [], 'prose');
  }
});
