'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  validateBranchName,
  validateRef,
  validateSha,
  validateStashRef,
  validatePathspec,
} = require('../../src/lib/git-ref');

// Every hostile value below is one git argv away from meaning something other
// than a name, so each one gets its own line and its own assertion message.
const HOSTILE_NAMES = [
  ['-r', 'a leading dash reads as an option'],
  ['--all', 'a long option reads as an option'],
  ['--upload-pack=/tmp/x', 'an option with a value runs a program'],
  ['a..b', 'two dots read as a range'],
  ['.hidden', 'a leading dot is not a ref name'],
  ['main.lock', 'a .lock suffix is reserved'],
  ['main@{1}', 'an @{ opens the reflog grammar'],
  ['@', 'a bare @ reads as HEAD'],
  ['feat:x', 'a colon splits a refspec'],
  ['/main', 'a leading slash is not a ref name'],
  ['main/', 'a trailing slash is not a ref name'],
  ['a//b', 'an empty path part is not a ref name'],
  ['x'.repeat(300), 'a 300 byte name is past the cap'],
  ['main\nfeature', 'a newline splits the value'],
  ['main\0x', 'a null byte truncates the value'],
  ['HEAD', 'HEAD is a position, not a branch'],
  ['4a91c02e2a4d86feb933cabf7f09c02065248f51', 'a 40 character commit id is not a branch'],
];

const REAL_NAMES = ['main', 'feature/source-control', 'release-2.11', 'fix/husk-1', 'v2', 'renovate/lock-file'];

test('a table of hostile branch names is refused, one case at a time', () => {
  for (const [value, why] of HOSTILE_NAMES) {
    const r = validateBranchName(value);
    assert.strictEqual(r.ok, false, why);
    assert.strictEqual(typeof r.reason, 'string', why);
    assert.ok(r.reason.length > 0, why);
  }
});

test('a refusal explains the rule without repeating the value back', () => {
  for (const [value, why] of HOSTILE_NAMES) {
    const r = validateBranchName(value);
    assert.strictEqual(r.reason.includes(value), false, why);
  }
});

test('the branch names a repository really carries all pass', () => {
  for (const name of REAL_NAMES) {
    const r = validateBranchName(name);
    assert.strictEqual(r.ok, true, name);
    assert.strictEqual(r.value, name, name);
  }
});

test('a branch field refuses a bare commit id and HEAD, a ref field takes both', () => {
  assert.strictEqual(validateBranchName('4a91c02').ok, false);
  assert.strictEqual(validateBranchName('HEAD').ok, false);
  assert.strictEqual(validateRef('4a91c02').ok, true);
  assert.strictEqual(validateRef('HEAD').ok, true);
  assert.strictEqual(validateRef('origin/main').ok, true);
  assert.strictEqual(validateRef('main~3').ok, false);
  assert.strictEqual(validateRef('main^').ok, false);
});

test('a sha field takes a commit id and no revision expression at all', () => {
  assert.deepStrictEqual(validateSha('4a91c02'), { ok: true, value: '4a91c02' });
  assert.strictEqual(validateSha('a'.repeat(40)).ok, true);
  assert.strictEqual(validateSha('a'.repeat(64)).ok, true);
  const refused = ['4a91c0', 'a'.repeat(65), 'HEAD', '4A91C02', '4a91c02..HEAD', '4a91c02^', '4a91c02~1', 'main@{1}', ''];
  for (const value of refused) {
    assert.strictEqual(validateSha(value).ok, false, value || 'the empty string');
  }
});

test('a stash reference is the printed form or a commit id, and nothing else', () => {
  for (const value of ['stash@{0}', 'stash@{12}', 'stash@{9999}', '4a91c02', 'a'.repeat(40)]) {
    assert.strictEqual(validateStashRef(value).ok, true, value);
  }
  for (const value of ['stash@{HEAD}', 'stash@{-1}', 'stash@{}', 'stash@{10000}', 'stash', 'refs/stash', 'stash@{0} ', '']) {
    assert.strictEqual(validateStashRef(value).ok, false, value || 'the empty string');
  }
});

test('a pathspec refuses the magic forms a confinement check alone would accept', () => {
  // Both of these resolve inside the root, so only this test stops them.
  for (const value of [':(exclude)src', ':/', ':!src', ':(top)', ':^src']) {
    const r = validatePathspec(value);
    assert.strictEqual(r.ok, false, value);
    assert.strictEqual(r.reason.includes(value), false, value);
  }
});

test('a pathspec refuses a dash, a walk upward, an absolute path and a control byte', () => {
  const refused = [
    ['-rf', 'a leading dash reads as an option'],
    ['../etc/passwd', 'a parent part walks out of the repository'],
    ['src/../../etc/passwd', 'a parent part in the middle walks out too'],
    ['/etc/passwd', 'an absolute path is not repository relative'],
    ['src/lib\n/x.js', 'a newline splits the value'],
    ['src/lib\0x.js', 'a null byte truncates the value'],
    ['src/', 'a trailing slash is a directory pathspec'],
    ['src//lib.js', 'an empty path part is not a path'],
    ['', 'the empty string is not a path'],
  ];
  for (const [value, why] of refused) {
    assert.strictEqual(validatePathspec(value).ok, false, why);
  }
});

test('a pathspec accepts the ordinary paths a repository is made of', () => {
  const accepted = [
    'src/lib/git-ref.js',
    '.gitignore',
    '.github/workflows/release.yml',
    'yarn.lock',
    'test/unit/git ref.test.js',
    'docs/images/a.b.c.png',
  ];
  for (const value of accepted) {
    const r = validatePathspec(value);
    assert.strictEqual(r.ok, true, value);
    assert.strictEqual(r.value, value, value);
  }
});

test('malformed input is refused with a reason rather than thrown over', () => {
  const validators = [validateBranchName, validateRef, validateSha, validateStashRef, validatePathspec];
  for (const validate of validators) {
    for (const value of [null, undefined, 0, 42, {}, [], true, Symbol.iterator]) {
      const r = validate(value);
      assert.strictEqual(r.ok, false, String(typeof value));
      assert.strictEqual(typeof r.reason, 'string', String(typeof value));
    }
  }
});
