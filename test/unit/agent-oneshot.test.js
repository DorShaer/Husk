'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { agentBaseName, oneShotArgs } = require('../../src/lib/agent-oneshot');

test('agentBaseName normalizes paths, extensions, and case', () => {
  assert.equal(agentBaseName('claude'), 'claude');
  assert.equal(agentBaseName('/usr/local/bin/Codex'), 'codex');
  assert.equal(agentBaseName('C:\\tools\\aider.EXE'), 'aider');
  assert.equal(agentBaseName('copilot --allow-all-tools'), 'copilot');
  assert.equal(agentBaseName(''), 'claude');
  assert.equal(agentBaseName(null), 'claude');
});

test('claude, copilot, and gemini take -p', () => {
  for (const cli of ['claude', 'copilot', 'gemini']) {
    assert.deepEqual(oneShotArgs(cli, 'do the thing'), ['-p', 'do the thing']);
  }
});

test('codex takes exec with the git-repo check skipped', () => {
  assert.deepEqual(oneShotArgs('codex', 'plan'), ['exec', '--skip-git-repo-check', 'plan']);
});

test('aider takes --message and never blocks on confirmations', () => {
  assert.deepEqual(oneShotArgs('aider', 'plan'), ['--message', 'plan', '--yes-always']);
});

test('unknown CLIs fall back to -p', () => {
  assert.deepEqual(oneShotArgs('somefuturecli', 'x'), ['-p', 'x']);
});

test('full command strings resolve by their base binary', () => {
  assert.deepEqual(oneShotArgs('aider --model ollama/qwen', 'x'), ['--message', 'x', '--yes-always']);
});

test('model args are preserved before each CLI prompt form', () => {
  assert.deepEqual(
    oneShotArgs('claude', 'x', { modelArgs: ['--model', 'sonnet'] }),
    ['--model', 'sonnet', '-p', 'x'],
  );
  assert.deepEqual(
    oneShotArgs('codex', 'x', { modelArgs: ['--model', 'gpt-5'] }),
    ['exec', '--model', 'gpt-5', '--skip-git-repo-check', 'x'],
  );
  assert.deepEqual(
    oneShotArgs('aider', 'x', { modelArgs: ['--model', 'opus'] }),
    ['--model', 'opus', '--message', 'x', '--yes-always'],
  );
});
