'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capPtyBuffer, PTY_BUFFER_MAX } = require('../../src/lib/pty-buffer');

const ESC = '\x1b';

test('a buffer under the ceiling is returned untouched', () => {
  assert.equal(capPtyBuffer('hello', 64), 'hello');
  assert.equal(capPtyBuffer('x'.repeat(64), 64), 'x'.repeat(64));
});

test('a buffer over the ceiling keeps the newest output', () => {
  const out = capPtyBuffer('old\nmid\nnew', 5);
  assert.ok(out.endsWith('new'));
  assert.ok(!out.includes('old'));
});

test('the retained tail starts after a newline so no escape sequence is split', () => {
  const head = 'a'.repeat(40);
  const out = capPtyBuffer(`${head}\n${ESC}[31mred${ESC}[0m\n`, 20);
  const body = out.slice(out.indexOf('trimmed\r\n') + 'trimmed\r\n'.length);
  assert.ok(!body.startsWith('['));
  assert.ok(!body.startsWith('3'));
  assert.ok(body.startsWith(ESC) || body === '');
});

test('the notice states how many characters went and resets attributes', () => {
  const out = capPtyBuffer('aaa\nbbb\nccc', 5);
  assert.ok(out.startsWith(`${ESC}[0m\r\n[husk] `));
  assert.match(out, /\[husk\] 8 characters of output trimmed/);
  assert.ok(out.endsWith('ccc'));
});

test('a tail with no newline is kept whole behind the notice', () => {
  const out = capPtyBuffer('x'.repeat(100), 10);
  assert.match(out, /\[husk\] 90 characters of output trimmed/);
  assert.ok(out.endsWith('x'.repeat(10)));
});

test('empty, null and undefined all collapse to an empty string', () => {
  assert.equal(capPtyBuffer('', 10), '');
  assert.equal(capPtyBuffer(null, 10), '');
  assert.equal(capPtyBuffer(undefined, 10), '');
});

test('the ceiling defaults to PTY_BUFFER_MAX when none is given', () => {
  assert.equal(PTY_BUFFER_MAX, 4 * 1024 * 1024);
  const under = 'y'.repeat(1000);
  assert.equal(capPtyBuffer(under), under);
  const over = 'y'.repeat(PTY_BUFFER_MAX + 10);
  assert.ok(over.length > capPtyBuffer(over).length - 64);
  assert.match(capPtyBuffer(over), /characters of output trimmed/);
});

test('a non-positive ceiling leaves the buffer alone', () => {
  assert.equal(capPtyBuffer('abc', 0), 'abc');
  assert.equal(capPtyBuffer('abc', -1), 'abc');
});
