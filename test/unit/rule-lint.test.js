'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { detect, isMechanical, applyMechanical, lint } = require('../../src/lib/rule-lint');

test('detect maps em-dash intent and content to the builtin', () => {
  assert.equal(detect('no em dashes anywhere'), 'no-em-dash');
  assert.equal(detect('never use em-dash'), 'no-em-dash');
  assert.equal(detect('strip — from output'), 'no-em-dash');
  assert.equal(detect('sound like Vercel settings'), null);
});

test('an explicit check tag wins over the text', () => {
  assert.ok(isMechanical({ text: 'anything', check: { builtin: 'no-em-dash' } }));
  assert.equal(isMechanical({ text: 'write with warmth' }), false);
});

test('applyMechanical repairs em dashes and leaves clean text untouched', () => {
  const rules = [{ text: 'no em dashes' }];
  assert.equal(applyMechanical('distribution — the bottleneck', rules), 'distribution - the bottleneck');
  assert.equal(applyMechanical('word—word', rules), 'word-word');
  assert.equal(applyMechanical('already clean, no dash', rules), 'already clean, no dash');
});

test('a judgment rule transforms nothing', () => {
  assert.equal(applyMechanical('keep the — here', [{ text: 'be concise' }]), 'keep the — here');
});

test('lint counts violations without changing the text', () => {
  const rules = [{ text: 'no em dashes' }];
  assert.deepEqual(lint('a — b — c', rules), [{ id: 'no-em-dash', label: 'no em dashes', count: 2 }]);
  assert.deepEqual(lint('clean text', rules), []);
});
