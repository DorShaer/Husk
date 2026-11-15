'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectedAgents, newChatEntries } = require('../../src/lib/new-chat-menu');

const agents = [
  { command: 'claude', label: 'Claude Code', available: true },
  { command: 'copilot', label: 'GitHub Copilot CLI', available: false },
  { command: 'gemini', label: 'Gemini CLI', available: true },
  { command: 'aider', label: 'Aider', available: true },
];

test('one entry per detected CLI, then the terminal, each chat naming its folder', () => {
  const entries = newChatEntries({ agents, folder: '~/work/app' });
  assert.deepStrictEqual(entries.map((e) => e.label), ['New chat with Claude Code', 'New chat with Gemini CLI', 'New chat with Aider', 'Terminal']);
  assert.deepStrictEqual(entries.map((e) => e.command), ['claude', 'gemini', 'aider', '']);
  assert.deepStrictEqual(entries.map((e) => e.kind), ['chat', 'chat', 'chat', 'terminal']);
  assert.deepStrictEqual(entries.map((e) => e.sub), ['~/work/app', '~/work/app', '~/work/app', '']);
});

test('the CLI used last comes first and unused ones keep their order', () => {
  const order = detectedAgents(agents, { gemini: 200, aider: 100, copilot: 999 }).map((a) => a.command);
  assert.deepStrictEqual(order, ['gemini', 'aider', 'claude']);
});

test('a single detected CLI still names its vendor', () => {
  const entries = newChatEntries({ agents: agents.slice(0, 2), folder: '/w' });
  assert.deepStrictEqual(entries.map((e) => [e.label, e.command]), [['New chat with Claude Code', 'claude'], ['Terminal', '']]);
});

test('nothing detected still offers a plain new chat on the default CLI', () => {
  for (const list of [[], null, undefined]) {
    assert.deepStrictEqual(newChatEntries({ agents: list }).map((e) => [e.label, e.command, e.sub]), [['New chat', '', ''], ['Terminal', '', '']]);
  }
});
