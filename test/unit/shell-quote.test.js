'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { shJoin } = require('../../src/lib/shell-quote');

// Contract: shJoin produces a string that /bin/sh -c parses back into
// the same argv we passed in. We feed the result into /bin/sh and read
// argv back as NUL-delimited words.

function shellArgv(exe, args) {
  const cmd = shJoin(exe, args);
  const res = spawnSync('/bin/sh', ['-c', `set -- ${cmd}; printf '%s\\0' "$@"`], { encoding: 'utf8' });
  assert.equal(res.status, 0, `shell exited ${res.status}: ${res.stderr}`);
  return res.stdout.split('\0').filter(Boolean);
}

test('shJoin: single arg round-trips through /bin/sh', () => {
  assert.deepEqual(shellArgv('echo', ['hello world']), ['echo', 'hello world']);
});

test('shJoin: single quote inside argument is escaped', () => {
  assert.deepEqual(shellArgv('printf', ["it's fine"]), ['printf', "it's fine"]);
});

test('shJoin: double quote and backslash pass through literally', () => {
  assert.deepEqual(shellArgv('printf', ['a"b\\c']), ['printf', 'a"b\\c']);
});

test('shJoin: semicolon in argument stays one word', () => {
  assert.deepEqual(shellArgv('printf', ['a;b']), ['printf', 'a;b']);
});

test('shJoin: $VAR in argument is not expanded', () => {
  assert.deepEqual(shellArgv('printf', ['$HOME']), ['printf', '$HOME']);
});

test('shJoin: backticks in argument are not evaluated', () => {
  assert.deepEqual(shellArgv('printf', ['`id`']), ['printf', '`id`']);
});

test('shJoin: empty args list produces a quoted exe', () => {
  assert.equal(shJoin('echo', []), "'echo'");
});

test('shJoin: undefined args list does not throw', () => {
  assert.equal(shJoin('echo'), "'echo'");
});

test('shJoin: exe is shell-escaped', () => {
  assert.equal(shJoin('a;b', ['c']), "'a;b' 'c'");
});

test('shJoin: backtick in exe is shell-escaped', () => {
  assert.equal(shJoin('`id`', ['x']), "'`id`' 'x'");
});

test('shJoin: single quote in exe is escaped', () => {
  assert.equal(shJoin("a'b", ['x']), "'a'\\''b' 'x'");
});

test('shJoin: shell parses the exe as a single word', () => {
  const cmd = shJoin('a;b', ['c']);
  const res = spawnSync('/bin/sh', ['-c', `set -- ${cmd}; printf '%s\\0' "$@"`], { encoding: 'utf8' });
  const words = res.stdout.split('\0').filter(Boolean);
  assert.deepEqual(words, ['a;b', 'c']);
});
