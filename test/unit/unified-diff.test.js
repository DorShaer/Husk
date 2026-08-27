'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseUnifiedDiff, buildHunkPatch, diffStat } = require('../../src/lib/unified-diff');

// Every fixture below is real `git diff` output, captured from a throwaway
// repository and pasted here verbatim. String.raw keeps the backslashes in the
// quoted paths and in the no-newline marker exactly as git wrote them, and TAB
// spells out the tab git appends to a header whose name holds a space.
const TAB = '\t';

const TWO_HUNKS = String.raw`diff --git a/a.txt b/a.txt
index 6dfea0f..1c5807a 100644
--- a/a.txt
+++ b/a.txt
@@ -1,5 +1,5 @@
 one
-two
+TWO
 three
 four
 five
@@ -15,6 +15,6 @@ fourteen
 fifteen
 sixteen
 seventeen
-eighteen
+EIGHTEEN
 nineteen
 twenty
`;

const RENAMED = String.raw`diff --git a/longfile.txt b/renamed.txt
similarity index 89%
rename from longfile.txt
rename to renamed.txt
index 1c99002..3591092 100644
--- a/longfile.txt
+++ b/renamed.txt
@@ -2,7 +2,7 @@
 2
 3
 4
-5
+five changed
 6
 7
 8
`;

const COPIED = String.raw`diff --git a/origin.txt b/copy.txt
similarity index 92%
copy from origin.txt
copy to copy.txt
index e8823e1..53f8626 100644
--- a/origin.txt
+++ b/copy.txt
@@ -1,6 +1,6 @@
 1
 2
-3
+three
 4
 5
 6
`;

const MULTI = String.raw`diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index cefda99..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-to be removed
diff --git a/half.txt b/half.txt
index 66a52ee..0bfc124 100644
--- a/half.txt
+++ b/half.txt
@@ -1,2 +1,2 @@
 first
-second
+second
\ No newline at end of file
diff --git a/logo.bin b/logo.bin
index bf39e0a..2b36711 100644
Binary files a/logo.bin and b/logo.bin differ
diff --git a/src/lib/one.js b/src/lib/one.js
index 85c3040..e50310a 100644
--- a/src/lib/one.js
+++ b/src/lib/one.js
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
diff --git a/src/lib/two.js b/src/lib/two.js
new file mode 100644
index 0000000..4e07fee
--- /dev/null
+++ b/src/lib/two.js
@@ -0,0 +1 @@
+made up
`;

const NO_NEWLINE_BOTH = String.raw`diff --git a/nonl.txt b/nonl.txt
index 91896af..b9dce1e 100644
--- a/nonl.txt
+++ b/nonl.txt
@@ -1,2 +1,2 @@
 alpha
-beta
\ No newline at end of file
+BETA
\ No newline at end of file
`;

const NO_NEWLINE_NEW_SIDE = String.raw`diff --git a/half.txt b/half.txt
index 66a52ee..0bfc124 100644
--- a/half.txt
+++ b/half.txt
@@ -1,2 +1,2 @@
 first
-second
+second
\ No newline at end of file
`;

const QUOTED_PATH = String.raw`diff --git "a/caf\303\251 note.txt" "b/caf\303\251 note.txt"
index cc45a5a..0a8b50a 100644
--- "a/caf\303\251 note.txt"${TAB}
+++ "b/caf\303\251 note.txt"${TAB}
@@ -1 +1 @@
-cafe one
+cafe two
`;

const QUOTED_TAB_PATH = String.raw`diff --git "a/has\ttab.txt" "b/has\ttab.txt"
index f2feafc..913a436 100644
--- "a/has\ttab.txt"
+++ "b/has\ttab.txt"
@@ -1 +1 @@
-tabbed one
+tabbed two
`;

const SPACE_PATH = String.raw`diff --git a/my notes.txt b/my notes.txt
index bd78063..dec3a1d 100644
--- a/my notes.txt${TAB}
+++ b/my notes.txt${TAB}
@@ -1 +1 @@
-space one
+space two
`;

// The deleted line here is the deletion of "-- not a header", so it reaches the
// parser as "--- not a header": the exact shape of a file header.
const HOSTILE_BODY = String.raw`diff --git a/tricky.txt b/tricky.txt
index adf465e..8282121 100644
--- a/tricky.txt
+++ b/tricky.txt
@@ -1,6 +1,6 @@
 keep
--- not a header
 --- still not
 +++ nor this
 diff --git a/fake b/fake
++++ added line
 tail
`;

// The insertion in the first hunk moves the second hunk's new side two lines
// down from its old side.
const DRIFTED = String.raw`diff --git a/drift.txt b/drift.txt
index ac9837c..a402a6b 100644
--- a/drift.txt
+++ b/drift.txt
@@ -1,5 +1,7 @@
 line 1
 line 2
+inserted one
+inserted two
 line 3
 line 4
 line 5
@@ -22,7 +24,7 @@ line 21
 line 22
 line 23
 line 24
-line 25
+line twenty five
 line 26
 line 27
 line 28
`;

const ADDED = String.raw`diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..858e580
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+brand new
+second line
`;

const DELETED = String.raw`diff --git a/doomed.txt b/doomed.txt
deleted file mode 100644
index d02fea3..0000000
--- a/doomed.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone one
-gone two
`;

const BINARY = String.raw`diff --git a/blob.bin b/blob.bin
index 4680a3e..a6ee5ae 100644
Binary files a/blob.bin and b/blob.bin differ
`;

const OMITTED_COUNT = String.raw`diff --git a/solo.txt b/solo.txt
index ceeec84..325e16e 100644
--- a/solo.txt
+++ b/solo.txt
@@ -1 +1 @@
-solo
+SOLO
`;

const only = (text) => {
  const { files } = parseUnifiedDiff(text);
  assert.strictEqual(files.length, 1);
  return files[0];
};

const kinds = (hunk) => hunk.lines.map((l) => l.kind);
const texts = (hunk) => hunk.lines.map((l) => l.text);

test('a two-hunk modification parses both hunks with their own starts and counts', () => {
  const file = only(TWO_HUNKS);
  assert.strictEqual(file.oldPath, 'a.txt');
  assert.strictEqual(file.newPath, 'a.txt');
  assert.strictEqual(file.status, 'modified');
  assert.strictEqual(file.isBinary, false);
  assert.strictEqual(file.adds, 2);
  assert.strictEqual(file.dels, 2);
  assert.strictEqual(file.hunks.length, 2);

  assert.deepStrictEqual(
    file.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines]),
    [[1, 5, 1, 5], [15, 6, 15, 6]],
  );
});

test('every line carries the number it holds on the side it exists on', () => {
  const file = only(TWO_HUNKS);
  const second = file.hunks[1];

  assert.deepStrictEqual(kinds(second), ['ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx']);
  assert.deepStrictEqual(
    second.lines.map((l) => [l.oldNo, l.newNo]),
    [[15, 15], [16, 16], [17, 17], [18, null], [null, 18], [19, 19], [20, 20]],
  );
  assert.deepStrictEqual(
    texts(second),
    ['fifteen', 'sixteen', 'seventeen', 'eighteen', 'EIGHTEEN', 'nineteen', 'twenty'],
  );
});

test('a hunk header keeps git own function context separately from the raw header', () => {
  const file = only(TWO_HUNKS);
  assert.strictEqual(file.hunks[0].fn, '');
  assert.strictEqual(file.hunks[0].header, '@@ -1,5 +1,5 @@');
  assert.strictEqual(file.hunks[1].fn, 'fourteen');
  assert.strictEqual(file.hunks[1].header, '@@ -15,6 +15,6 @@ fourteen');
});

test('a hunk header with an omitted count means one line on that side', () => {
  const file = only(OMITTED_COUNT);
  const hunk = file.hunks[0];
  assert.strictEqual(hunk.oldStart, 1);
  assert.strictEqual(hunk.oldLines, 1);
  assert.strictEqual(hunk.newStart, 1);
  assert.strictEqual(hunk.newLines, 1);
  assert.deepStrictEqual(kinds(hunk), ['del', 'add']);
});

test('a rename with a similarity index keeps both paths and reports the rename', () => {
  const file = only(RENAMED);
  assert.strictEqual(file.oldPath, 'longfile.txt');
  assert.strictEqual(file.newPath, 'renamed.txt');
  assert.strictEqual(file.status, 'renamed');
  assert.strictEqual(file.isRename, true);
  assert.strictEqual(file.similarity, 89);
});

test('a copy with a similarity index keeps both paths and is not called a rename', () => {
  const file = only(COPIED);
  assert.strictEqual(file.oldPath, 'origin.txt');
  assert.strictEqual(file.newPath, 'copy.txt');
  assert.strictEqual(file.status, 'copied');
  assert.strictEqual(file.isRename, false);
  assert.strictEqual(file.similarity, 92);
});

test('an added file has no old side and a deleted file has no new side', () => {
  const added = only(ADDED);
  assert.strictEqual(added.oldPath, null);
  assert.strictEqual(added.newPath, 'added.txt');
  assert.strictEqual(added.status, 'added');
  assert.strictEqual(added.adds, 2);
  assert.strictEqual(added.dels, 0);
  assert.deepStrictEqual(
    added.hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo]),
    [['add', null, 1], ['add', null, 2]],
  );

  const deleted = only(DELETED);
  assert.strictEqual(deleted.oldPath, 'doomed.txt');
  assert.strictEqual(deleted.newPath, null);
  assert.strictEqual(deleted.status, 'deleted');
  assert.strictEqual(deleted.adds, 0);
  assert.strictEqual(deleted.dels, 2);
  assert.strictEqual(deleted.hunks[0].newLines, 0);
});

test('a binary stub parses to a file with no hunks rather than to a refusal', () => {
  const file = only(BINARY);
  assert.strictEqual(file.isBinary, true);
  assert.strictEqual(file.oldPath, 'blob.bin');
  assert.strictEqual(file.newPath, 'blob.bin');
  assert.deepStrictEqual(file.hunks, []);
  assert.strictEqual(file.adds, 0);
  assert.strictEqual(file.dels, 0);
});

test('the no-newline marker parses as its own line on both sides of a change', () => {
  const file = only(NO_NEWLINE_BOTH);
  const hunk = file.hunks[0];
  assert.deepStrictEqual(kinds(hunk), ['ctx', 'del', 'nonl', 'add', 'nonl']);
  assert.strictEqual(hunk.lines[2].text, 'No newline at end of file');
  assert.strictEqual(hunk.lines[2].oldNo, null);
  assert.strictEqual(hunk.lines[2].newNo, null);
  // The marker is not a change, so it never reaches the counts.
  assert.strictEqual(file.adds, 1);
  assert.strictEqual(file.dels, 1);
});

test('a marker on one side only stays attached to the line above it', () => {
  const file = only(NO_NEWLINE_NEW_SIDE);
  const hunk = file.hunks[0];
  assert.deepStrictEqual(kinds(hunk), ['ctx', 'del', 'add', 'nonl']);
  assert.strictEqual(hunk.lines[2].text, 'second');
});

test('buildHunkPatch re-emits the no-newline marker where it was', () => {
  const file = only(NO_NEWLINE_BOTH);
  const patch = buildHunkPatch(file, 0, {});
  assert.deepStrictEqual(patch.split('\n'), [
    'diff --git a/nonl.txt b/nonl.txt',
    '--- a/nonl.txt',
    '+++ b/nonl.txt',
    '@@ -1,2 +1,2 @@',
    ' alpha',
    '-beta',
    '\\ No newline at end of file',
    '+BETA',
    '\\ No newline at end of file',
    '',
  ]);
});

test('a C-style quoted path with octal escapes decodes to the real path', () => {
  const file = only(QUOTED_PATH);
  assert.strictEqual(file.oldPath, 'café note.txt');
  assert.strictEqual(file.newPath, 'café note.txt');
  assert.strictEqual(file.hunks.length, 1);
});

test('a quoted path decodes its single-character escapes too', () => {
  const file = only(QUOTED_TAB_PATH);
  assert.strictEqual(file.oldPath, 'has\ttab.txt');
  assert.strictEqual(file.newPath, 'has\ttab.txt');
});

test('a bare path holding a space stops at the tab git appends after it', () => {
  const file = only(SPACE_PATH);
  assert.strictEqual(file.oldPath, 'my notes.txt');
  assert.strictEqual(file.newPath, 'my notes.txt');
});

test('a rebuilt header for a quoted path is byte for byte what git wrote', () => {
  const cases = [
    ['a path outside ASCII', QUOTED_PATH],
    ['a path holding a tab', QUOTED_TAB_PATH],
    ['a bare path holding a space', SPACE_PATH],
  ];
  for (const [label, fixture] of cases) {
    const patch = buildHunkPatch(only(fixture), 0, {});
    const built = patch.split('\n');
    const source = fixture.split('\n');
    assert.strictEqual(built[0], source[0], label + ': the diff --git line');
    // The source carries an index line the builder leaves out.
    assert.strictEqual(built[1], source[2], label + ': the old side');
    assert.strictEqual(built[2], source[3], label + ': the new side');
  }
});

test('a body line that reads like a header is read as a body line', () => {
  const file = only(HOSTILE_BODY);
  assert.strictEqual(file.oldPath, 'tricky.txt');
  assert.strictEqual(file.newPath, 'tricky.txt');
  assert.strictEqual(file.hunks.length, 1);
  assert.deepStrictEqual(kinds(file.hunks[0]), ['ctx', 'del', 'ctx', 'ctx', 'ctx', 'add', 'ctx']);
  assert.deepStrictEqual(texts(file.hunks[0]), [
    'keep',
    '-- not a header',
    '--- still not',
    '+++ nor this',
    'diff --git a/fake b/fake',
    '+++ added line',
    'tail',
  ]);
});

test('a multi-file diff answers one entry per file in the order git wrote them', () => {
  const { files } = parseUnifiedDiff(MULTI);
  assert.deepStrictEqual(
    files.map((f) => [f.newPath || f.oldPath, f.status, f.isBinary]),
    [
      ['gone.txt', 'deleted', false],
      ['half.txt', 'modified', false],
      ['logo.bin', 'modified', true],
      ['src/lib/one.js', 'modified', false],
      ['src/lib/two.js', 'added', false],
    ],
  );
});

test('diffStat totals every file in the parse', () => {
  const { files } = parseUnifiedDiff(MULTI);
  assert.deepStrictEqual(diffStat(files), { adds: 3, dels: 3 });
  assert.deepStrictEqual(diffStat(parseUnifiedDiff(TWO_HUNKS).files), { adds: 2, dels: 2 });
});

test('a patch built from one hunk re-parses to exactly that hunk', () => {
  const file = only(TWO_HUNKS);
  const patch = buildHunkPatch(file, 1, {});
  const rebuilt = only(patch);

  assert.strictEqual(rebuilt.hunks.length, 1);
  assert.strictEqual(rebuilt.oldPath, 'a.txt');
  assert.strictEqual(rebuilt.newPath, 'a.txt');
  assert.deepStrictEqual(kinds(rebuilt.hunks[0]), kinds(file.hunks[1]));
  assert.deepStrictEqual(texts(rebuilt.hunks[0]), texts(file.hunks[1]));
  assert.strictEqual(rebuilt.hunks[0].oldStart, 15);
  assert.strictEqual(rebuilt.hunks[0].oldLines, 6);
  assert.strictEqual(rebuilt.hunks[0].newLines, 6);
  assert.strictEqual(rebuilt.hunks[0].fn, 'fourteen');
});

test('the emitted counts come from the lines, not from the header they arrived on', () => {
  const file = only(TWO_HUNKS);
  // A header that disagrees with its own body is what a stale diff looks like.
  file.hunks[1].oldLines = 99;
  file.hunks[1].newLines = 4;
  const patch = buildHunkPatch(file, 1, {});
  assert.ok(patch.includes('@@ -15,6 +15,6 @@ fourteen'), patch);
});

test('a hunk lifted out of a longer diff starts both sides at the old-side line', () => {
  const file = only(DRIFTED);
  // The insertion in the first hunk pushes the second hunk two lines down.
  assert.strictEqual(file.hunks[1].oldStart, 22);
  assert.strictEqual(file.hunks[1].newStart, 24);

  // On its own, nothing ahead of it has been applied, so the drift is gone.
  const patch = buildHunkPatch(file, 1, {});
  assert.strictEqual(patch.split('\n')[3], '@@ -22,7 +22,7 @@ line 21');

  const reversed = buildHunkPatch(file, 1, { reverse: true });
  assert.strictEqual(reversed.split('\n')[3], '@@ -24,7 +24,7 @@ line 21');
});

test('a reverse patch swaps every added and removed line and swaps the counts', () => {
  const file = only(ADDED);
  const patch = buildHunkPatch(file, 0, { reverse: true });
  assert.deepStrictEqual(patch.split('\n'), [
    'diff --git a/added.txt b/added.txt',
    'deleted file mode 100644',
    '--- a/added.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-brand new',
    '-second line',
    '',
  ]);
});

test('reversing a modification twice returns the hunk it started from', () => {
  const file = only(TWO_HUNKS);
  const reversed = only(buildHunkPatch(file, 0, { reverse: true }));
  assert.deepStrictEqual(kinds(reversed.hunks[0]), ['ctx', 'add', 'del', 'ctx', 'ctx', 'ctx']);
  assert.deepStrictEqual(texts(reversed.hunks[0]), ['one', 'two', 'TWO', 'three', 'four', 'five']);

  const back = only(buildHunkPatch(reversed, 0, { reverse: true }));
  assert.deepStrictEqual(kinds(back.hunks[0]), kinds(file.hunks[0]));
  assert.deepStrictEqual(texts(back.hunks[0]), texts(file.hunks[0]));
  assert.strictEqual(back.hunks[0].header, file.hunks[0].header);
});

test('a deleted file reverses into the patch that would put it back', () => {
  const patch = buildHunkPatch(only(DELETED), 0, { reverse: true });
  assert.deepStrictEqual(patch.split('\n'), [
    'diff --git a/doomed.txt b/doomed.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/doomed.txt',
    '@@ -0,0 +1,2 @@',
    '+gone one',
    '+gone two',
    '',
  ]);
});

test('a rename keeps its rename headers so the patch moves the file it moved', () => {
  const patch = buildHunkPatch(only(RENAMED), 0, {});
  const head = patch.split('\n').slice(0, 6);
  assert.deepStrictEqual(head, [
    'diff --git a/longfile.txt b/renamed.txt',
    'similarity index 89%',
    'rename from longfile.txt',
    'rename to renamed.txt',
    '--- a/longfile.txt',
    '+++ b/renamed.txt',
  ]);
});

test('buildHunkPatch answers null for anything it cannot build a patch from', () => {
  const file = only(TWO_HUNKS);
  const cases = [
    ['no file at all', () => buildHunkPatch(null, 0, {})],
    ['a file that is not an object', () => buildHunkPatch('a.txt', 0, {})],
    ['a file with no hunks array', () => buildHunkPatch({ hunks: null }, 0, {})],
    ['a binary file', () => buildHunkPatch(only(BINARY), 0, {})],
    ['an index past the end', () => buildHunkPatch(file, 2, {})],
    ['a negative index', () => buildHunkPatch(file, -1, {})],
    ['a fractional index', () => buildHunkPatch(file, 0.5, {})],
    ['an index that is not a number', () => buildHunkPatch(file, '0', {})],
    ['an empty hunk', () => buildHunkPatch({ hunks: [{ lines: [] }] }, 0, {})],
  ];
  for (const [label, run] of cases) {
    assert.strictEqual(run(), null, label);
  }
  // The options bag is optional, and a hunk index still has to be given.
  assert.strictEqual(typeof buildHunkPatch(file, 0), 'string');
});

test('malformed input parses as an empty file list rather than thrown over', () => {
  const cases = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', { diff: 'x' }],
    ['an array', ['diff --git a/x b/x']],
    ['the empty string', ''],
    ['plain prose', 'this is not a diff at all\nnot even close\n'],
    ['a lone hunk header', '@@ -1,2 +1,2 @@\n a\n-b\n+c\n'],
    ['a truncated header', 'diff --git\n'],
    ['a header with no body', 'diff --git a/x b/x\nindex 0000000..1111111 100644\n'],
    ['an unterminated quoted path', 'diff --git "a/x b/x\n'],
    ['a hunk header with no numbers', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -a,b +c,d @@\n'],
  ];
  for (const [label, input] of cases) {
    const result = parseUnifiedDiff(input);
    assert.ok(result && Array.isArray(result.files), label + ': answers a file list');
    assert.deepStrictEqual(diffStat(result.files), { adds: 0, dels: 0 }, label + ': counts nothing');
  }
  assert.deepStrictEqual(parseUnifiedDiff(null), { files: [] });
  assert.deepStrictEqual(parseUnifiedDiff(''), { files: [] });
  assert.deepStrictEqual(parseUnifiedDiff('this is not a diff at all\n'), { files: [] });
  assert.deepStrictEqual(diffStat(null), { adds: 0, dels: 0 });
  assert.deepStrictEqual(diffStat([null, undefined, {}, 'x']), { adds: 0, dels: 0 });
});
