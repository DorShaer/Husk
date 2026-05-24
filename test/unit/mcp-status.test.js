'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseMcpListOutput, stripAnsi } = require('../../src/lib/mcp-status');

// Fixture captured from a real `claude mcp list` invocation
// (Claude Code 2.1.150). Used as the contract the parser must match.
const REAL_OUTPUT = [
  'Checking MCP server health…',
  '',
  'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication',
  'memory: npx -y @modelcontextprotocol/server-memory - ✓ Connected',
  'opensearch: uvx opensearch-mcp-server-py - ✗ Failed to connect',
  'Jira: uvx --python=3.12 mcp-atlassian - ✓ Connected',
  'slack-logs: node /home/u/proj/index.js - ✓ Connected',
  'brightsec-com: https://app.brightsec.com/mcp (HTTP) - ✓ Connected',
].join('\n');

test('parseMcpListOutput: real claude mcp list fixture', () => {
  const got = parseMcpListOutput(REAL_OUTPUT);
  assert.deepEqual(got, {
    'claude.ai Gmail': 'auth',
    'memory': 'connected',
    'opensearch': 'failed',
    'Jira': 'connected',
    'slack-logs': 'connected',
    'brightsec-com': 'connected',
  });
});

test('parseMcpListOutput: ids containing spaces are preserved', () => {
  const got = parseMcpListOutput('claude.ai Gmail: https://x - ! Needs authentication');
  assert.equal(got['claude.ai Gmail'], 'auth');
});

test('parseMcpListOutput: failed is detected before connected', () => {
  // "Failed to connect" contains "connect", so check order matters
  const got = parseMcpListOutput('serv: x - ✗ Failed to connect');
  assert.equal(got['serv'], 'failed');
});

test('parseMcpListOutput: skips the header line', () => {
  const got = parseMcpListOutput('Checking MCP server health…\nmemory: x - ✓ Connected');
  assert.deepEqual(got, { memory: 'connected' });
});

test('parseMcpListOutput: ignores blank lines', () => {
  const got = parseMcpListOutput('\n\n\nmemory: x - ✓ Connected\n\n');
  assert.deepEqual(got, { memory: 'connected' });
});

test('parseMcpListOutput: ignores lines without a colon', () => {
  const got = parseMcpListOutput('just some text\nmemory: x - ✓ Connected');
  assert.deepEqual(got, { memory: 'connected' });
});

test('parseMcpListOutput: disabled is detected', () => {
  const got = parseMcpListOutput('s: x - disabled');
  assert.equal(got['s'], 'disabled');
});

test('parseMcpListOutput: needs auth variant', () => {
  const got = parseMcpListOutput('s: x - ! Needs auth');
  assert.equal(got['s'], 'auth');
});

test('parseMcpListOutput: ANSI escape codes are stripped', () => {
  const colored = '\x1B[32mmemory\x1B[0m: x - \x1B[32m✓ Connected\x1B[0m';
  const got = parseMcpListOutput(colored);
  assert.equal(got['memory'], 'connected');
});

test('parseMcpListOutput: returns empty object on empty input', () => {
  assert.deepEqual(parseMcpListOutput(''), {});
  assert.deepEqual(parseMcpListOutput(null), {});
  assert.deepEqual(parseMcpListOutput(undefined), {});
});

test('parseMcpListOutput: skips lines that start with Error', () => {
  const got = parseMcpListOutput('Error: command not found: claude\nmemory: x - ✓ Connected');
  assert.deepEqual(got, { memory: 'connected' });
});

test('parseMcpListOutput: a line with an empty id is skipped', () => {
  const got = parseMcpListOutput(': something - ✓ Connected\nmemory: x - ✓ Connected');
  assert.deepEqual(got, { memory: 'connected' });
});

test('stripAnsi: removes color escapes', () => {
  assert.equal(stripAnsi('\x1B[31mred\x1B[0m'), 'red');
});

test('stripAnsi: leaves non-ansi text alone', () => {
  assert.equal(stripAnsi('plain text'), 'plain text');
  assert.equal(stripAnsi(''), '');
  assert.equal(stripAnsi(null), '');
});
