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
