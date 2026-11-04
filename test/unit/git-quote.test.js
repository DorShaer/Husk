'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unquote, decodeQuoted } = require('../../src/lib/git-quote');

test('unquote leaves an unquoted path untouched and guards non-strings', () => {
  assert.equal(unquote('src/main.js'), 'src/main.js');
  assert.equal(unquote(''), '');
  assert.equal(unquote(undefined), '');
  assert.equal(unquote(null), '');
  assert.equal(unquote(42), '');
});

test('unquote decodes C-escapes and octal UTF-8 inside quotes', () => {
  assert.equal(unquote('"a\\tb"'), 'a\tb');
  assert.equal(unquote('"a\\nb"'), 'a\nb');
  assert.equal(unquote('"a\\\\b"'), 'a\\b');
  // octal \303\251 is UTF-8 for é
  assert.equal(unquote('"caf\\303\\251"'), 'café');
  // unknown escape keeps the next char literally
  assert.equal(unquote('"a\\qb"'), 'aqb');
});

test('a lone trailing backslash inside quotes stops instead of throwing', () => {
  assert.doesNotThrow(() => decodeQuoted('"abc\\"'));
  assert.equal(decodeQuoted('"abc\\"'), 'abc');
});

test('decodeQuoted assumes surrounding quotes and strips them', () => {
  assert.equal(decodeQuoted('"plain"'), 'plain');
});
