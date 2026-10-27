'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-mcp-shared-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const SharedMcp = require('../../src/lib/mcp/shared');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'));
}

test('shared add writes one MCP server to every write-capable vendor', () => {
  const r = SharedMcp.add({
    id: 'memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: { TOKEN: 'secret' },
  });
  assert.equal(r.ok, true);
  assert.equal(readJson('.claude.json').mcpServers.memory.command, 'npx');
  assert.equal(readJson('.copilot/mcp-config.json').mcpServers.memory.env.TOKEN, 'secret');
  assert.equal(readJson('.gemini/settings.json').mcpServers.memory.args[1], '@modelcontextprotocol/server-memory');
});

test('shared list backfills a server that exists in only one vendor', () => {
  const claude = readJson('.claude.json');
  claude.mcpServers.claude_only = { command: 'node', args: ['server.js'] };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(claude, null, 2));

  const r = SharedMcp.list('copilot');
  assert.equal(r.ok, true);
  assert.ok(r.servers.some((s) => s.id === 'claude_only'));
  assert.equal(readJson('.copilot/mcp-config.json').mcpServers.claude_only.command, 'node');
  assert.equal(readJson('.gemini/settings.json').mcpServers.claude_only.args[0], 'server.js');
});

test('shared toggle applies enabled state to every vendor', () => {
  const r = SharedMcp.toggle('memory', 'claude');
  assert.equal(r.ok, true);
  assert.equal(r.enabled, false);
  assert.ok(readJson('.claude.json')._huskMcpDisabled.memory);
  assert.ok(readJson('.copilot/mcp-config.json')._huskMcpDisabled.memory);
  assert.ok(readJson('.gemini/settings.json')._huskMcpDisabled.memory);
});

test('shared update/rename applies to every vendor', () => {
  const r = SharedMcp.update('claude_only', {
    id: 'shared_node',
    newId: 'shared_node',
    transport: 'stdio',
    command: 'node',
    args: ['new-server.js'],
  });
  assert.equal(r.ok, true);
  assert.equal(readJson('.claude.json').mcpServers.shared_node.args[0], 'new-server.js');
  assert.equal(readJson('.copilot/mcp-config.json').mcpServers.shared_node.args[0], 'new-server.js');
  assert.equal(readJson('.gemini/settings.json').mcpServers.shared_node.args[0], 'new-server.js');
});

test('shared clone copies a server as clone-<id> with the same shape and enabled state', () => {
  const r = SharedMcp.clone('memory', 'claude');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'clone-memory');
  // memory was disabled by the toggle test above, so the clone lands in the
  // disabled store too, with the same entry.
  const claude = readJson('.claude.json');
  assert.deepEqual(claude._huskMcpDisabled['clone-memory'], claude._huskMcpDisabled.memory);
  assert.equal(claude.mcpServers['clone-memory'], undefined);
  assert.equal(readJson('.copilot/mcp-config.json')._huskMcpDisabled['clone-memory'].env.TOKEN, 'secret');
  // A second clone does not collide with the first.
  const again = SharedMcp.clone('memory', 'claude');
  assert.equal(again.ok, true);
  assert.equal(again.id, 'clone-memory-2');
  assert.equal(SharedMcp.clone('nope', 'claude').ok, false);
  // The clone is independent: removing it leaves the original.
  assert.equal(SharedMcp.remove('clone-memory-2').ok, true);
  assert.ok(readJson('.claude.json')._huskMcpDisabled.memory);
  assert.equal(readJson('.claude.json')._huskMcpDisabled['clone-memory-2'], undefined);
});
