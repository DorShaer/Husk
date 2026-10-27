'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { transportFor, acpArgs, userFlags } = require('../../src/lib/chat-transport');

test('ACP CLIs route to acp, claude to claude, the rest to null', () => {
  assert.equal(transportFor('copilot'), 'acp');
  assert.equal(transportFor('gemini --model gemini-2.5-pro'), 'acp');
  assert.equal(transportFor('/home/u/.local/bin/kiro-cli'), 'acp');
  assert.equal(transportFor('claude'), 'claude');
  assert.equal(transportFor('claude --model opus'), 'claude');
  assert.equal(transportFor('aider'), null);
  assert.equal(transportFor('codex'), null);
  assert.equal(transportFor('some-other-cli'), null);
});

test('acpArgs matches each CLI help text', () => {
  assert.deepEqual(acpArgs('copilot'), ['--acp']);
  assert.deepEqual(acpArgs('gemini'), ['--acp']);
  assert.deepEqual(acpArgs('kiro-cli'), ['acp']);
  assert.equal(acpArgs('claude'), null);
  assert.equal(acpArgs('aider'), null);
});

test('acpArgs returns a fresh array each call', () => {
  const a = acpArgs('gemini');
  a.push('--x');
  assert.deepEqual(acpArgs('gemini'), ['--acp']);
});

test('userFlags keeps flags and drops the program and any subcommand', () => {
  assert.deepEqual(userFlags('claude'), []);
  assert.deepEqual(userFlags('claude --model opus'), ['--model', 'opus']);
  assert.deepEqual(userFlags('kiro-cli chat --model x'), ['--model', 'x']);
  assert.deepEqual(userFlags(''), []);
});
