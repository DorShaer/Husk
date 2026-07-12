'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyTier, isTrivialFileTask } = require('../../src/lib/model-routing');

// Routing wrong toward cheap costs quality, so the trivial tier has to be narrow.
// These cases pin both edges of it.

test('a bare file write goes to the cheap tier', () => {
  for (const goal of [
    'create a single file call it test.txt and wriute hello123 there',
    'create test.txt with hello world',
    'add a file notes.md saying TODO',
    'touch a file called api.json with {}',
    'write hello into a file',
  ]) {
    assert.equal(classifyTier(goal), 'cheap', goal);
  }
});

test('a filename is not a requirement', () => {
  // test.txt must not read as "write tests", and api.json must not read as
  // "build an API": the words that mean real work are looked for with the
  // filenames removed.
  assert.equal(classifyTier('create test.txt with hello123'), 'cheap');
  assert.equal(classifyTier('create a file api.json containing {}'), 'cheap');
  // The same words outside a filename still mean real work.
  assert.equal(classifyTier('write tests in a file for the parser'), 'smart');
  assert.equal(classifyTier('create the API endpoint file for users'), 'smart');
});

test('anything that needs judgement stays on the smart tier', () => {
  for (const goal of [
    'create a file that implements the auth middleware',
    'add a module that parses the config file',
    'write a script that migrates the schema',
    'debug why the login file fails',
    'refactor the session file handling',
    'redesign the whole autopilot dashboard',
    'add dark mode support',
  ]) {
    assert.equal(classifyTier(goal), 'smart', goal);
  }
});

test('a long goal is never trivial, however it starts', () => {
  const long = 'create a file with the full implementation of a JSON parser supporting '
    + 'streaming, comments, and error recovery with line numbers and column offsets';
  assert.ok(long.length > 140);
  assert.equal(isTrivialFileTask(long), false);
  assert.equal(classifyTier(long), 'smart');
});

test('an empty or absent goal is not trivial', () => {
  assert.equal(isTrivialFileTask(''), false);
  assert.equal(isTrivialFileTask(null), false);
  assert.equal(isTrivialFileTask(undefined), false);
  // classifyTier still has to answer, and the safe answer is the capable model.
  assert.equal(classifyTier(''), 'smart');
});

test('the existing mechanical routing is unchanged', () => {
  assert.equal(classifyTier('bump the deps to latest'), 'cheap');
  assert.equal(classifyTier('run prettier over the repo'), 'cheap');
  assert.equal(classifyTier('find all the TODO comments'), 'cheap');
  assert.equal(classifyTier('rename the helper variable'), 'cheap');
});
