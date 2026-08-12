'use strict';

// Reading an agent's reported state.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { agentState, isLive } = require('../../src/lib/agent-state');

test('the states the CLI reports each land where a reader expects', () => {
  assert.equal(agentState('working'), 'running');
  assert.equal(agentState('blocked'), 'blocked');
  assert.equal(agentState('failed'), 'failed');
  assert.equal(agentState('done'), 'done');
});

// Not done is not the same as running.
test('a failed agent is not running', () => {
  assert.equal(agentState('failed'), 'failed');
  assert.equal(isLive('failed'), false, 'a failed agent was treated as live');
});

// An agent that never took a prompt is reported the same way as one that
// broke, so it is read as finished rather than as a failure.
test('an agent that never took a prompt reads as finished, not as failed', () => {
  assert.equal(agentState('failed', { started: false }), 'done');
  assert.equal(agentState('failed', { started: true }), 'failed',
    'an agent that ran and then stopped lost its failure');
});

test('never having started does not make a working agent finished', () => {
  assert.equal(agentState('working', { started: false }), 'running');
  assert.equal(agentState('blocked', { started: false }), 'blocked');
});

test('a stopped agent is not running either', () => {
  assert.equal(agentState('stopped'), 'done');
  assert.equal(isLive('stopped'), false);
});

test('only working and blocked agents are live', () => {
  assert.equal(isLive('working'), true);
  assert.equal(isLive('blocked'), true, 'an agent waiting on the user is still there to answer');
  assert.equal(isLive('done'), false);
});

test('an agent on its way up is live', () => {
  for (const s of ['starting', 'queued']) {
    assert.equal(isLive(s), true, `${s} was treated as finished`);
  }
});

// A state nobody has taught this module about must not be advertised as live:
// showing "running" for an agent that is not is the failure being fixed.
test('an unknown state reads as finished rather than as running', () => {
  for (const s of ['idle', 'zombie', 'whatever', '']) {
    assert.equal(agentState(s), 'done', `${JSON.stringify(s)} was classified as something live`);
    assert.equal(isLive(s), false);
  }
});

test('a missing state does not throw', () => {
  for (const s of [null, undefined, 0, {}]) {
    assert.equal(isLive(s), false, `${JSON.stringify(s)} was treated as live`);
  }
});

test('case and padding do not change the reading', () => {
  assert.equal(agentState('  WORKING '), 'running');
  assert.equal(agentState('Blocked'), 'blocked');
});
