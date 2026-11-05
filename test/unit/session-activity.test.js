'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lastTurnMs } = require('../../src/lib/session-activity');

const YDAY = '2026-11-04T09:00:00.000Z';
const YDAY2 = '2026-11-04T09:05:00.000Z';
const NOW = '2026-11-05T18:00:00.000Z';

const line = (o) => JSON.stringify(o) + '\n';

test('activity is the last user/assistant turn, not a later api-request or hook line', () => {
  const text = line({ type: 'user', timestamp: YDAY, message: { content: 'hi' } })
    + line({ type: 'assistant', timestamp: YDAY2, message: { content: 'hello' } })
    // opening/resuming appends these with a current time; they must not count
    + line({ type: 'api-request', timestamp: NOW })
    + line({ type: 'session-owner' })
    + line({ type: 'api-request-blob', data: 'x'.repeat(100) });
  const { ms } = lastTurnMs(text, null);
  assert.equal(ms, Date.parse(YDAY2));
});

test('a forward scan keeps the turn time when only non-turn lines are appended', () => {
  const first = line({ type: 'assistant', timestamp: YDAY2, message: {} });
  const a = lastTurnMs(first, null);
  assert.equal(a.ms, Date.parse(YDAY2));
  // Resume appends an api-request with "now"; scanning only the new bytes.
  const b = lastTurnMs(line({ type: 'api-request', timestamp: NOW }), a.ms);
  assert.equal(b.ms, Date.parse(YDAY2)); // unchanged: no new turn
});

test('a new user turn does advance the activity time', () => {
  const b = lastTurnMs(line({ type: 'user', timestamp: NOW, message: {} }), Date.parse(YDAY2));
  assert.equal(b.ms, Date.parse(NOW));
});

test('a trailing partial line is not consumed', () => {
  const text = line({ type: 'user', timestamp: YDAY }) + '{"type":"assistant","timestamp":"' + NOW;
  const { ms, consumed } = lastTurnMs(text, null);
  assert.equal(ms, Date.parse(YDAY));
  assert.equal(consumed, Buffer.byteLength(line({ type: 'user', timestamp: YDAY })));
});

test('seed is returned when the chunk has no turn', () => {
  const { ms } = lastTurnMs(line({ type: 'api-request', timestamp: NOW }), 123);
  assert.equal(ms, 123);
});
