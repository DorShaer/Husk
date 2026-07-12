'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deriveCopilotSessionTitleFromEventsText } = require('../../src/lib/copilot-session-title');

test('derives title from Copilot user.message data.content string', () => {
  const text = [
    JSON.stringify({ type: 'session.model_change', data: { newModel: 'gpt-5.5' } }),
    JSON.stringify({ type: 'user.message', data: { content: 'Fix the MCP server connection timeout\nand validate it' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'Sure' } }),
  ].join('\n');
  assert.deepEqual(deriveCopilotSessionTitleFromEventsText(text), {
    title: 'Fix the MCP server connection timeout and validate it',
    firstMessage: 'Fix the MCP server connection timeout and validate it',
    sawAssistant: true,
  });
});

test('derives title from Copilot content arrays', () => {
  const text = JSON.stringify({
    type: 'user.message',
    data: { content: [{ type: 'text', text: 'Improve UI for Production' }] },
  });
  const r = deriveCopilotSessionTitleFromEventsText(text);
  assert.equal(r.title, 'Improve UI for Production');
  assert.equal(r.firstMessage, 'Improve UI for Production');
});

test('falls back to Copilot transformedContent', () => {
  const text = JSON.stringify({
    type: 'user.message',
    data: { content: '', transformedContent: 'Name the Copilot session from transformed content' },
  });
  const r = deriveCopilotSessionTitleFromEventsText(text);
  assert.equal(r.title, 'Name the Copilot session from transformed content');
});

test('prefers explicit session title events over first prompt', () => {
  const text = [
    JSON.stringify({ type: 'user.message', data: { content: 'very long raw request' } }),
    JSON.stringify({ type: 'session.title', data: { title: 'MCP connection fix' } }),
  ].join('\n');
  const r = deriveCopilotSessionTitleFromEventsText(text);
  assert.equal(r.title, 'MCP connection fix');
  assert.equal(r.firstMessage, 'very long raw request');
});
