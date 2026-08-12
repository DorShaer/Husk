'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { withAutopilotArgs } = require('../../src/lib/autopilot-args');

test('adds no-ask/autonomous flags for supported Autopilot agents', () => {
  assert.deepEqual(withAutopilotArgs('claude', []), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(withAutopilotArgs('copilot', []), ['--no-ask-user', '--allow-all']);
  assert.deepEqual(withAutopilotArgs('gemini', []), ['--approval-mode', 'yolo', '--skip-trust']);
  assert.deepEqual(withAutopilotArgs('aider', []), ['--yes-always', '--auto-accept-architect']);
  assert.deepEqual(withAutopilotArgs('codex', []), ['--ask-for-approval', 'never']);
  assert.deepEqual(withAutopilotArgs('kiro-cli', []), ['chat', '--trust-all-tools']);
});

test('does not duplicate existing Autopilot flags', () => {
  assert.deepEqual(withAutopilotArgs('claude', ['--permission-mode', 'auto']), ['--permission-mode', 'auto']);
  assert.deepEqual(withAutopilotArgs('copilot', ['--no-ask-user', '--allow-all']), ['--no-ask-user', '--allow-all']);
  assert.deepEqual(withAutopilotArgs('gemini', ['--approval-mode=yolo', '--skip-trust']), ['--approval-mode=yolo', '--skip-trust']);
  assert.deepEqual(withAutopilotArgs('aider', ['--yes-always', '--no-auto-accept-architect']), ['--yes-always', '--no-auto-accept-architect']);
  assert.deepEqual(withAutopilotArgs('codex', ['--approval-mode', 'never']), ['--approval-mode', 'never']);
  assert.deepEqual(withAutopilotArgs('kiro-cli', ['chat', '--trust-tools=fs_read']), ['chat', '--trust-tools=fs_read']);
});

test('leaves non-chat Kiro subcommands untouched', () => {
  assert.deepEqual(withAutopilotArgs('kiro-cli', ['login']), ['login']);
});

test('normalizes executable paths and extensions', () => {
  assert.deepEqual(withAutopilotArgs('/usr/local/bin/copilot', []), ['--no-ask-user', '--allow-all']);
  assert.deepEqual(withAutopilotArgs('C:\\tools\\aider.cmd', []), ['--yes-always', '--auto-accept-architect']);
  assert.deepEqual(withAutopilotArgs('/home/me/.local/bin/kiro-cli', []), ['chat', '--trust-all-tools']);
});
