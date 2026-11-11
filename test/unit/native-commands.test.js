'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { nativeCommand, nativeReply } = require('../../src/lib/native-commands');

test('/mcp maps to each CLI\'s own listing', () => {
  assert.deepEqual(nativeCommand('claude', '/mcp'), { program: 'claude', args: ['mcp', 'list'], label: 'claude mcp list' });
  assert.deepEqual(nativeCommand('codex --model x', ' /mcp '), { program: 'codex', args: ['mcp', 'list'], label: 'codex mcp list' });
  assert.equal(nativeCommand('/usr/bin/copilot', '/mcp').program, '/usr/bin/copilot');
  assert.equal(nativeCommand('kiro-cli', '/mcp').label, 'kiro-cli mcp list');
});

test('a claude alias runs the listing under its own name', () => {
  const n = nativeCommand('claude-work', '/mcp');
  assert.equal(n.program, 'claude-work');
  assert.deepEqual(n.args, ['mcp', 'list']);
});

test('anything else goes to the CLI untouched', () => {
  assert.equal(nativeCommand('claude', '/mcp add foo'), null);
  assert.equal(nativeCommand('claude', '/compact'), null);
  assert.equal(nativeCommand('claude', 'what does /mcp do'), null);
  assert.equal(nativeCommand('aider', '/mcp'), null);
  assert.equal(nativeCommand('claude', '/constructor'), null);
});

test('the reply names the command and fences what it printed', () => {
  assert.equal(nativeReply('claude mcp list', 'a: ok\r\nb: ok\n'), '`claude mcp list`\n\n```\na: ok\nb: ok\n```');
  assert.match(nativeReply('x', ''), /\(no output\)/);
  assert.ok(!nativeReply('x', 'a ``` b').slice(8, -4).includes('```'));
});
