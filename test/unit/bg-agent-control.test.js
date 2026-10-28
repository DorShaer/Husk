'use strict';

// Ending a background agent.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { controlArgs } = require('../../src/lib/bg-agent-open');

test('stopping an agent halts it by id', () => {
  const r = controlArgs('stop', 'ebd17fde');
  assert.equal(r.ok, true, `stopping was refused: ${r.error}`);
  assert.deepEqual(r.args, ['stop', 'ebd17fde']);
});

test('removing an agent discards it by id', () => {
  const r = controlArgs('remove', 'ebd17fde');
  assert.equal(r.ok, true, `removing was refused: ${r.error}`);
  assert.deepEqual(r.args, ['rm', 'ebd17fde']);
});

// The two are not interchangeable: stopping keeps the conversation and removing
// does not, so a caller must not be able to reach one by naming the other.
test('an action nobody defined does nothing at all', () => {
  for (const action of ['', 'delete', 'kill', 'rm', 'stop; rm -rf /', null, undefined]) {
    const r = controlArgs(action, 'ebd17fde');
    assert.equal(r.ok, false, `${JSON.stringify(action)} was accepted as an action`);
  }
});

test('an id carrying anything but word characters is refused', () => {
  for (const id of ['a b', 'a;b', 'a$(b)', '../x', 'a\nb', '', 'ab']) {
    const r = controlArgs('stop', id);
    assert.equal(r.ok, false, `${JSON.stringify(id)} was accepted as an agent id`);
  }
});

test('the id and the verb stay separate arguments', () => {
  const r = controlArgs('stop', 'ebd17fde');
  assert.equal(r.args.length, 2, 'the command was flattened into one argument');
});

const { controlFailure, cleanCliMessage } = require('../../src/lib/bg-agent-open');

// Sampled from claude 2.1.311 on 2026-10-28: an agent left waiting on the user
// 58 days earlier, whose worker had long since exited, still listed as blocked
// and could not be stopped.
const STALE_STOP = "couldn't confirm 6798a198 was stopped \u2014 the background service may be restarting. Try again in a moment.";

test('a stop the CLI could not confirm is reported as stale, in words fit for a toast', () => {
  const r = controlFailure('stop', '6798a198', STALE_STOP);
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.match(r.error, /6798a198/);
  assert.doesNotMatch(r.error, /[\u2014\u2013]/, 'dash punctuation reached the message');
  assert.doesNotMatch(r.error, /try again/i, 'the user was told to retry a stop that cannot succeed');
});

test('any other refusal is passed on cleaned, and is not stale', () => {
  const r = controlFailure('stop', 'ebd17fde', '\u001b[31mno such session \u2014 ebd17fde\u001b[0m\n');
  assert.equal(r.stale, false);
  assert.equal(r.error, 'No such session: ebd17fde');
  const rm = controlFailure('remove', 'ebd17fde', STALE_STOP);
  assert.equal(rm.stale, false, 'only a stop can be stale');
  assert.equal(controlFailure('remove', 'ebd17fde', '').error, 'The agent could not be deleted.');
  assert.equal(controlFailure('stop', 'ebd17fde', '').error, 'The agent did not stop.');
});

test('cleaning keeps the words and drops the decoration', () => {
  assert.equal(cleanCliMessage('  two\n lines \u2013 joined  '), 'Two lines: joined');
  assert.equal(cleanCliMessage(null), '');
});
