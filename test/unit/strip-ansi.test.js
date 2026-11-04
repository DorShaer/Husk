'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi } = require('../../src/lib/strip-ansi');

test('strips CSI colour/cursor, OSC (BEL or ST), and charset escapes', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(stripAnsi('\x1b[2J\x1b[Hhome'), 'home');
  assert.equal(stripAnsi('\x1b]0;title\x07text'), 'text'); // OSC terminated by BEL
  assert.equal(stripAnsi('\x1b]0;title\x1b\\text'), 'text'); // OSC terminated by ST
  assert.equal(stripAnsi('\x1b(Bplain'), 'plain'); // charset designation
});

test('is null-safe and leaves plain text alone', () => {
  assert.equal(stripAnsi(undefined), '');
  assert.equal(stripAnsi(null), '');
  assert.equal(stripAnsi('just text'), 'just text');
});
