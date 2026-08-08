'use strict';

// Text that reaches a live agent's terminal, and the two places its content
// comes from outside Husk.
//
// The far end is not a shell, it is an agent CLI's TUI. There a carriage return
// reads as Enter and an escape opens a control sequence, so a control byte in
// anything Husk writes to the PTY is the ability to submit a turn the user
// never typed, to an agent already bound to their working directory.
//
// Two inputs, neither of them written here:
//   - a workflow step's output, pasted into a new chat. A step prompt can ask
//     the model to print any literal bytes, and on an imported workflow the
//     step's name came from the file's author.
//   - a file name, dragged in or picked. POSIX permits every byte except "/"
//     and NUL, so a repository or an archive can carry one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { stripControls, hasControls, chatFileRef } = require('../../src/lib/terminal-safe');

const ESC = '\x1b';
const CR = '\r';
const NUL = '\x00';

// ─── the paste wrapper ─────────────────────────────────────────────────────

test('the bracketed-paste terminator cannot survive inside pasted step output', () => {
  // A terminator inside the text would close the wrapper early, and the newline
  // after it is then read as send rather than as part of the block.
  const embedded = `looks fine${ESC}[201~\na following line\n`;
  const out = stripControls(embedded);

  assert.ok(!out.includes(ESC), 'an escape survived into the paste');
  assert.ok(!out.includes(`${ESC}[201~`), 'the paste terminator survived');
  assert.equal(hasControls(out.replace(/[\n\t]/g, '')), false,
    `a control byte survived: ${JSON.stringify(out)}`);
});

test('the paste keeps the two bytes that make a block readable', () => {
  const out = stripControls('one\ntwo\tthree');
  assert.equal(out, 'one\ntwo\tthree', 'newline or tab was stripped, which would flatten the block');
});

test('ordinary text passes through the paste guard untouched', () => {
  const plain = 'Here is the output of the workflow step "Verify":\n\nALL TESTS PASS';
  assert.equal(stripControls(plain), plain);
});

test('carriage return is removed from pasted output', () => {
  // CR is the byte a TUI reads as Enter, so it must not reach the prompt even
  // though it is whitespace.
  assert.equal(stripControls(`a${CR}b`), 'ab');
});

test('the paste guard is total across the control ranges', () => {
  for (let code = 0; code <= 0x9f; code++) {
    if (code === 0x09 || code === 0x0a) continue;      // tab and newline stay
    if (code > 0x1f && code < 0x7f) continue;          // printable ASCII stays
    const ch = String.fromCharCode(code);
    assert.equal(stripControls(`a${ch}b`), 'ab',
      `U+${code.toString(16).padStart(4, '0')} survived the paste guard`);
  }
});

// ─── the file reference ────────────────────────────────────────────────────

test('a file name carrying a carriage return is refused, not quoted', () => {
  // Quoting does not help: to a TUI the quotes are ordinary characters and the
  // carriage return is still delivered.
  const withCr = `/home/u/notes.md${CR}a second line`;
  assert.equal(chatFileRef(withCr), '', 'a name carrying a carriage return reached the agent');
});

test('a file name carrying an escape or a NUL is refused', () => {
  assert.equal(chatFileRef(`/home/u/a${ESC}[201~b.md`), '', 'an escape reached the agent');
  assert.equal(chatFileRef(`/home/u/a${NUL}b.md`), '', 'a NUL reached the agent');
});

test('ordinary names still work, including the awkward ones', () => {
  assert.equal(chatFileRef('/home/u/notes.md'), '/home/u/notes.md ');
  assert.equal(chatFileRef('/home/u/my notes.md'), '"/home/u/my notes.md" ',
    'a name with a space lost its quoting');
  assert.equal(chatFileRef("/home/u/o'brien.md"), "/home/u/o'brien.md ");
  assert.equal(chatFileRef('/home/u/שלום.md'), '/home/u/שלום.md ',
    'a non-Latin name was refused');
});

test('an empty or absent path produces nothing rather than a bare space', () => {
  for (const empty of ['', null, undefined]) {
    assert.equal(chatFileRef(empty), '', `${JSON.stringify(empty)} produced output`);
  }
});

// ─── the ingestion point ───────────────────────────────────────────────────

// Refusing at the sink alone is not enough: the dropped file is stored under
// that name and every later surface reads it back.
test('the drop handler refuses a control character before the file is copied', () => {
  const MAIN = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  const handler = MAIN.match(/ipcMain\.handle\('fs:dropFile'[\s\S]*?\n\}\);/);
  assert.ok(handler, 'the fs:dropFile handler was not found');

  const guardAt = handler[0].search(/x00-\\?x1F/);
  const copyAt = handler[0].indexOf('copyFileSync');
  assert.ok(guardAt > -1, 'fs:dropFile accepts a basename containing control characters');
  assert.ok(copyAt > -1, 'the copy was not found');
  assert.ok(guardAt < copyAt, 'the control-character check runs after the file is already copied');
});

// The renderer must reach the shared rule rather than keeping a second copy,
// because two copies of a security check drift and only one of them gets fixed.
test('the renderer delegates both guards to the shared module', () => {
  const APP = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.match(APP, /window\.husk\.text\.stripControls/, 'the paste guard is not the shared one');
  assert.match(APP, /window\.husk\.text\.chatFileRef/, 'the file-reference guard is not the shared one');

  const PRELOAD = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'preload.js'), 'utf8');
  assert.match(PRELOAD, /require\('\.\/lib\/terminal-safe'\)/, 'the bridge does not expose the shared rule');
});
