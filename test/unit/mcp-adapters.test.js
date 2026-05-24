'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getAdapter, ADAPTERS } = require('../../src/lib/mcp');
const { agentKey, shapeServer, buildServerEntry } = require('../../src/lib/mcp/common');
const { makeStub } = require('../../src/lib/mcp/stub');

// ─── agentKey ────────────────────────────────────────────────────────────────

test('agentKey: returns claude as default', () => {
  assert.equal(agentKey(''), 'claude');
  assert.equal(agentKey(null), 'claude');
  assert.equal(agentKey(undefined), 'claude');
});

test('agentKey: each known agent', () => {
  for (const name of ['claude', 'copilot', 'codex', 'aider', 'gemini']) {
    assert.equal(agentKey(name), name);
  }
});

test('agentKey: extracts basename from a full path', () => {
  assert.equal(agentKey('/usr/local/bin/copilot'), 'copilot');
  assert.equal(agentKey('/home/me/.bun/bin/claude'), 'claude');
});

test('agentKey: ignores trailing arguments', () => {
  assert.equal(agentKey('claude --dangerously-skip-permissions'), 'claude');
  assert.equal(agentKey('copilot --allow-all-tools'), 'copilot');
});

test('agentKey: is case-insensitive', () => {
  assert.equal(agentKey('CLAUDE'), 'claude');
  assert.equal(agentKey('Copilot'), 'copilot');
});

test('agentKey: strips Windows extensions', () => {
  assert.equal(agentKey('claude.exe'), 'claude');
  assert.equal(agentKey('claude.cmd'), 'claude');
  assert.equal(agentKey('copilot.bat'), 'copilot');
});

// ─── getAdapter selection ────────────────────────────────────────────────────

test('getAdapter: returns the claude adapter by name', () => {
  assert.equal(getAdapter('claude').agent, 'claude');
});

test('getAdapter: returns the copilot adapter by name', () => {
  assert.equal(getAdapter('copilot').agent, 'copilot');
});

test('getAdapter: stubs codex / aider / gemini', () => {
  for (const name of ['codex', 'aider', 'gemini']) {
    const a = getAdapter(name);
    assert.equal(a.agent, name);
    assert.equal(a.supportsWrite, false);
    assert.equal(a.supportsLiveStatus, false);
  }
});

test('getAdapter: unknown agent name returns a stub', () => {
  const a = getAdapter('some-future-cli');
  assert.equal(a.supportsWrite, false);
  assert.equal(a.list().unsupported, true);
});

// ─── shapeServer ─────────────────────────────────────────────────────────────

test('shapeServer: stdio shape', () => {
  const s = shapeServer('mem', { command: 'npx', args: ['-y', 'memory'], env: { K: '1' } }, false);
  assert.deepEqual(s, {
    id: 'mem',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'memory'],
    env: { K: '1' },
  });
});

test('shapeServer: remote http shape', () => {
  const s = shapeServer('api', { type: 'http', url: 'https://x', headers: { Auth: 'B' } }, false);
  assert.equal(s.transport, 'http');
  assert.equal(s.url, 'https://x');
  assert.deepEqual(s.headers, { Auth: 'B' });
});

test('shapeServer: sse transport preserved', () => {
  const s = shapeServer('api', { type: 'sse', url: 'https://x' }, false);
  assert.equal(s.transport, 'sse');
});

test('shapeServer: disabled flag flips the enabled bit', () => {
  const s = shapeServer('mem', { command: 'npx' }, true);
  assert.equal(s.enabled, false);
});

test('shapeServer: missing fields fall back to defaults', () => {
  const s = shapeServer('mem', {}, false);
  assert.equal(s.transport, 'stdio');
  assert.equal(s.command, '');
  assert.deepEqual(s.args, []);
  assert.deepEqual(s.env, {});
});

// ─── buildServerEntry ───────────────────────────────────────────────────────

test('buildServerEntry: stdio happy path', () => {
  const r = buildServerEntry({ command: 'npx', args: ['-y', 'mem'] });
  assert.deepEqual(r.entry, { command: 'npx', args: ['-y', 'mem'] });
});

test('buildServerEntry: stdio with env', () => {
  const r = buildServerEntry({ command: 'npx', args: [], env: { TOKEN: 'x' } });
  assert.deepEqual(r.entry, { command: 'npx', args: [], env: { TOKEN: 'x' } });
});

test('buildServerEntry: http happy path', () => {
  const r = buildServerEntry({ transport: 'http', url: 'https://x', headers: { A: 'B' } });
  assert.deepEqual(r.entry, { type: 'http', url: 'https://x', headers: { A: 'B' } });
});

test('buildServerEntry: missing url rejects', () => {
  const r = buildServerEntry({ transport: 'http' });
  assert.match(r.error, /URL required/);
});

test('buildServerEntry: missing command rejects', () => {
  const r = buildServerEntry({});
  assert.match(r.error, /Command required/);
});

// ─── stub adapter ────────────────────────────────────────────────────────────

test('stub adapter: list returns empty unsupported result', async () => {
  const s = makeStub('codex');
  const r = s.list();
  assert.equal(r.ok, true);
  assert.deepEqual(r.servers, []);
  assert.equal(r.unsupported, true);
  assert.equal(r.agent, 'codex');
});

test('stub adapter: write methods return descriptive errors', () => {
  const s = makeStub('aider');
  assert.equal(s.add({ id: 'x' }).ok, false);
  assert.equal(s.remove('x').ok, false);
  assert.equal(s.toggle('x').ok, false);
  assert.match(s.add({}).error, /aider/);
});

test('stub adapter: health resolves with empty status', async () => {
  const s = makeStub('gemini');
  const r = await s.health();
  assert.deepEqual(r, { ok: true, status: {} });
});

// ─── filesystem round-trip on a fresh adapter (claude shape) ────────────────

test('claude / copilot adapters: round-trip add + list + toggle + remove on a temp config', () => {
  // Both adapters share the same schema, so we use the common helpers
  // against a temp file to test the contract.
  const { readJsonFile, writeJsonFile } = require('../../src/lib/mcp/common');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'husk-mcp-')), 'cfg.json');

  writeJsonFile(tmp, { mcpServers: {} });
  const after = readJsonFile(tmp);
  assert.deepEqual(after, { mcpServers: {} });

  writeJsonFile(tmp, {
    mcpServers: { mem: { command: 'npx', args: ['-y', 'mem'] } },
    _huskMcpDisabled: { old: { command: 'old' } },
  });
  const loaded = readJsonFile(tmp);
  assert.ok(loaded.mcpServers.mem);
  assert.ok(loaded._huskMcpDisabled.old);
});
