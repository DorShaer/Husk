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

test('kiro takes chat --no-interactive with the prompt as positional input', () => {
  assert.deepEqual(oneShotArgs('kiro-cli', 'plan'), ['chat', '--no-interactive', 'plan']);
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
  assert.deepEqual(
    oneShotArgs('kiro-cli', 'x', { modelArgs: ['--model', 'claude-sonnet-4.6'] }),
    ['chat', '--model', 'claude-sonnet-4.6', '--no-interactive', 'x'],
  );
});

// ─── untrusted invocation ────────────────────────────────────────────────────
//
// A workflow that arrived as a file carries somebody else's instructions. The
// two convenience flags below each trade away a check, and neither trade is the
// author's to make on the importer's machine.

test('an untrusted codex call keeps the git repo check', () => {
  assert.deepEqual(oneShotArgs('codex', 'x', { untrusted: true }), ['exec', 'x']);
  assert.ok(!oneShotArgs('codex', 'x', { untrusted: true }).includes('--skip-git-repo-check'));
});

test('an untrusted aider call does not pre-answer its confirmations', () => {
  assert.deepEqual(oneShotArgs('aider', 'x', { untrusted: true }), ['--message', 'x']);
  assert.ok(!oneShotArgs('aider', 'x', { untrusted: true }).includes('--yes-always'));
});

test('untrusted keeps the model pin, which is what the receipt was earned on', () => {
  assert.deepEqual(
    oneShotArgs('codex', 'x', { untrusted: true, modelArgs: ['--model', 'gpt-5'] }),
    ['exec', '--model', 'gpt-5', 'x'],
  );
});

test('a trusted call is unchanged, so nothing that shipped before behaves differently', () => {
  assert.deepEqual(oneShotArgs('codex', 'x', {}), ['exec', '--skip-git-repo-check', 'x']);
  assert.deepEqual(oneShotArgs('aider', 'x', {}), ['--message', 'x', '--yes-always']);
  assert.deepEqual(oneShotArgs('codex', 'x', { untrusted: false }), ['exec', '--skip-git-repo-check', 'x']);
});

// Only the literal true opts in. An absent or truthy-but-not-true value must not
// silently harden a local run, because a stalled aider step with no explanation
// is a bug report, and it must not silently soften an imported one either.
test('only a literal true counts as untrusted', () => {
  for (const v of [undefined, null, 0, '', 'yes', 1, {}]) {
    assert.deepEqual(oneShotArgs('aider', 'x', { untrusted: v }), ['--message', 'x', '--yes-always']);
  }
});
