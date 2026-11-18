'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { peekFromEvents, peekFromTranscript } = require('../../src/lib/session-peek');
const { CONTEXT_HEAD, CONTEXT_TAIL, RULES_HEAD, RULES_TAIL } = require('../../src/lib/brain');

const wire = (typed) => `${RULES_HEAD}\n- be brief\n${RULES_TAIL}\n${CONTEXT_HEAD}\n- deploy: runs on push\n${CONTEXT_TAIL}\n\n${typed}`;

test('a transcript user turn shows only what the user typed', () => {
  const lines = [
    { type: 'user', message: { role: 'user', content: wire('how does deploy work?') }, timestamp: '2026-11-17T10:00:00Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: wire('and rollbacks?') }] }, timestamp: '2026-11-17T10:01:00Z' },
    { type: 'user', message: { role: 'user', content: wire('') }, timestamp: '2026-11-17T10:02:00Z' },
  ].map((o) => JSON.stringify(o)).join('\n');
  const users = peekFromTranscript(lines).entries.filter((e) => e.kind === 'user').map((e) => e.text);
  assert.deepEqual(users, ['how does deploy work?', 'and rollbacks?']);
});

test('an event feed user turn shows only what the user typed', () => {
  const { entries } = peekFromEvents([{ type: 'user', text: wire('plain question') }, { type: 'user', text: 'typed [Husk Brain: x] inline' }]);
  assert.deepEqual(entries.map((e) => e.text), ['plain question', 'typed [Husk Brain: x] inline']);
});
