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

test('work in flight is working while it writes and idle once quiet', () => {
  const { settle, ACTIVE_MS } = require('../../src/lib/agent-state');
  const now = 1_000_000_000;
  assert.equal(settle('working', now - 5000, now), 'working');
  assert.equal(settle('working', now - ACTIVE_MS, now), 'quiet');
  assert.equal(agentState('quiet'), 'idle');
  assert.equal(isLive('quiet'), true, 'quiet work is still in flight');
  assert.equal(settle('blocked', 0, now), 'blocked', 'waiting on a person never goes idle');
  assert.equal(settle('done', 0, now), 'done');
});

test('a blocked agent needs you only when it asked something', () => {
  const { waitingOn } = require('../../src/lib/agent-state');
  const { pulseFromTranscript } = require('../../src/lib/session-peek');
  // The CLI's own words for an agent sitting at its prompt.
  assert.equal(waitingOn({ needs: 'send a prompt to start' }).kind, 'ready');
  assert.equal(waitingOn({ needs: '(idle \u2014 send a prompt to start)', said: 'Done.' }).text, 'Done.');
  assert.equal(waitingOn({}).kind, 'ready');
  assert.deepEqual(waitingOn({ needs: 'Permission to push the branch' }), { kind: 'reply', text: 'Permission to push the branch' });
  assert.deepEqual(waitingOn({ ask: 'Which port?' }), { kind: 'question', text: 'Which port?' });
  assert.deepEqual(waitingOn({ pending: { tool: 'Bash', text: 'npm test' } }), { kind: 'permission', tool: 'Bash', text: 'npm test' });
  assert.equal(agentState('ready'), 'ready');
  assert.equal(isLive('ready'), false, 'done work is not in flight');

  const line = (o) => JSON.stringify(o);
  const ask = [
    line({ type: 'user', message: { content: 'push it' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push' } }] } }),
  ].join('\n');
  assert.deepEqual(pulseFromTranscript(ask).pending, { tool: 'Bash', text: 'git push', question: '' });
  const answered = ask + '\n' + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } })
    + '\n' + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Pushed.' }] } });
  assert.equal(pulseFromTranscript(answered).pending, null);
  assert.equal(pulseFromTranscript(answered).said, 'Pushed.');
  // A call cut off by a new prompt is not waiting on anything.
  assert.equal(pulseFromTranscript(ask + '\n' + line({ type: 'user', message: { content: 'never mind' } })).pending, null);
  const q = line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which port?' }] } }] } });
  assert.equal(waitingOn({ pending: pulseFromTranscript(q).pending }).text, 'Which port?');
});

test('the CLI idle text is shown in Husk words and still reads as ready', () => {
  const { displayNeeds, waitingOn: wait } = require('../../src/lib/agent-state');
  const shown = displayNeeds('(idle \u2014 send a prompt to start)');
  assert.equal(shown, 'Idle. Send a prompt to start.');
  assert.doesNotMatch(shown, /[\u2013\u2014]/);
  assert.equal(wait({ needs: shown }).kind, 'ready');
  assert.equal(displayNeeds('Review the diff'), 'Review the diff');
  assert.equal(wait({ needs: 'Review the diff' }).kind, 'reply');
});
