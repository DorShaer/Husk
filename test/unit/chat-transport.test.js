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
  assert.equal(transportFor('codex'), 'codex');
  assert.equal(transportFor('codex --model gpt-x'), 'codex');
  assert.equal(transportFor('some-other-cli'), null);
});

test('claude aliases (claude-work, claude_test, a path) speak the claude protocol', () => {
  // A custom command is usually the real claude under an alias, so it must open
  // in native chat, not the raw CLI terminal view.
  assert.equal(transportFor('claude-test'), 'claude');
  assert.equal(transportFor('claude-bright --model opus'), 'claude');
  assert.equal(transportFor('claude_work'), 'claude');
  assert.equal(transportFor('/home/user/.local/bin/claude-test'), 'claude');
  // No separator after "claude" is not an alias we assume is claude-compatible.
  assert.equal(transportFor('claude2'), null);
  assert.equal(transportFor('claudia'), null);
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

const { commandSessionId } = require('../../src/lib/chat-transport');
test('commandSessionId reads the session a command names, and nothing else', () => {
  assert.equal(commandSessionId('claude --resume 6b3d4688-a66f-4648-95be-a50254aae502'), '6b3d4688-a66f-4648-95be-a50254aae502');
  assert.equal(commandSessionId('claude --session-id=abcdefgh-1234'), 'abcdefgh-1234');
  assert.equal(commandSessionId('claude --model opus --resume abcdefgh-1234 --fork-session'), 'abcdefgh-1234');
  assert.equal(commandSessionId('claude'), null);
  assert.equal(commandSessionId('claude --resume'), null);
  assert.equal(commandSessionId('claude --resume "x; rm"'), null);
  assert.equal(commandSessionId('claude agents --json'), null);
});
