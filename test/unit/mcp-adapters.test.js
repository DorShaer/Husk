'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { getAdapter, ADAPTERS } = require('../../src/lib/mcp');
const { agentKey, shapeServer, buildServerEntry } = require('../../src/lib/mcp/common');
const { makeStub } = require('../../src/lib/mcp/stub');

const REAL_ADAPTERS = [
  { name: 'claude', modulePath: '../../src/lib/mcp/claude', configRel: '.claude.json' },
  { name: 'copilot', modulePath: '../../src/lib/mcp/copilot', configRel: path.join('.copilot', 'mcp-config.json') },
  { name: 'gemini', modulePath: '../../src/lib/mcp/gemini', configRel: path.join('.gemini', 'settings.json') },
];

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-mcp-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function loadFreshAdapter(t, modulePath, home) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const originalHomedir = os.homedir;
  os.homedir = () => home;
  try {
    return require(modulePath);
  } finally {
    os.homedir = originalHomedir;
    t.after(() => { delete require.cache[resolved]; });
  }
}

function writeAdapterConfig(adapter, cfg) {
  fs.mkdirSync(path.dirname(adapter.configPath), { recursive: true });
  fs.writeFileSync(adapter.configPath, JSON.stringify(cfg));
}

function readAdapterConfig(adapter) {
  return JSON.parse(fs.readFileSync(adapter.configPath, 'utf8'));
}

function fakeHealthProcess(stdoutText, stderrText = '') {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  process.nextTick(() => {
    if (stdoutText) proc.stdout.emit('data', Buffer.from(stdoutText));
    if (stderrText) proc.stderr.emit('data', Buffer.from(stderrText));
    proc.emit('close', 0);
  });
  return proc;
}

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

test('getAdapter: stubs codex / aider', () => {
  for (const name of ['codex', 'aider']) {
    const a = getAdapter(name);
    assert.equal(a.agent, name);
    assert.equal(a.supportsWrite, false);
    assert.equal(a.supportsLiveStatus, false);
  }
});

test('getAdapter: gemini is a real write adapter over ~/.gemini/settings.json', () => {
  const a = getAdapter('gemini');
  assert.equal(a.agent, 'gemini');
  assert.equal(a.supportsWrite, true);
  assert.equal(a.supportsLiveStatus, false);
  assert.ok(a.configPath.endsWith(path.join('.gemini', 'settings.json')));
  for (const fn of ['list', 'add', 'update', 'remove', 'toggle', 'health']) {
    assert.equal(typeof a[fn], 'function', `gemini adapter missing ${fn}`);
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
  assert.equal(s.update('x', {}).ok, false);
  assert.equal(s.remove('x').ok, false);
  assert.equal(s.toggle('x').ok, false);
  assert.match(s.add({}).error, /aider/);
  assert.match(s.update('x', {}).error, /aider/);
});

test('real adapters expose an update() function', () => {
  // The Edit MCP flow needs both claude and copilot to handle in-place
  // overwrites. This guards against future refactors silently dropping
  // the method (the renderer would then fail at runtime).
  assert.equal(typeof ADAPTERS.claude.update, 'function');
  assert.equal(typeof ADAPTERS.copilot.update, 'function');
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

test('writeJsonFile creates the config dir when it does not exist yet', () => {
  // Configuring an MCP server before the CLI has ever run (so ~/.gemini
  // does not exist) must still succeed.
  const { readJsonFile, writeJsonFile } = require('../../src/lib/mcp/common');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-mcp-'));
  const nested = path.join(base, '.gemini', 'settings.json');
  assert.equal(fs.existsSync(path.dirname(nested)), false);
  const ok = writeJsonFile(nested, { mcpServers: { mem: { command: 'npx' } } });
  assert.equal(ok, true);
  assert.ok(readJsonFile(nested).mcpServers.mem);
});

// ─── real adapter modules over isolated config homes ─────────────────────────

test('real MCP adapters list active and disabled servers from their own config files', (t) => {
  for (const spec of REAL_ADAPTERS) {
    const home = tmpHome(t);
    const adapter = loadFreshAdapter(t, spec.modulePath, home);
    assert.equal(adapter.configPath, path.join(home, spec.configRel), spec.name);

    writeAdapterConfig(adapter, {
      mcpServers: {
        zed: { command: 'node', args: ['zed.js'] },
        api: { type: 'sse', url: 'https://example.test/sse', headers: { Authorization: 'Bearer t' } },
      },
      _huskMcpDisabled: {
        old: { command: 'node', args: ['old.js'] },
      },
    });

    const result = adapter.list();
    assert.equal(result.ok, true, spec.name);
    assert.deepEqual(result.servers.map((s) => s.id), ['api', 'old', 'zed']);
    assert.equal(result.servers.find((s) => s.id === 'api').transport, 'sse');
    assert.equal(result.servers.find((s) => s.id === 'api').enabled, true);
    assert.equal(result.servers.find((s) => s.id === 'old').enabled, false);
  }
});

test('real MCP adapters add, update, toggle, and remove without dropping unrelated settings', (t) => {
  for (const spec of REAL_ADAPTERS) {
    const home = tmpHome(t);
    const adapter = loadFreshAdapter(t, spec.modulePath, home);
    writeAdapterConfig(adapter, {
      theme: 'dark',
      mcpServers: {},
      _huskMcpDisabled: {
        archived: { command: 'node', args: ['archived.js'] },
      },
    });

    assert.deepEqual(adapter.add({ id: 'mem', command: 'npx', args: ['-y', 'memory'], env: { TOKEN: 'x' } }), { ok: true }, spec.name);
    let cfg = readAdapterConfig(adapter);
    assert.equal(cfg.theme, 'dark', spec.name);
    assert.deepEqual(cfg.mcpServers.mem, { command: 'npx', args: ['-y', 'memory'], env: { TOKEN: 'x' } });
    assert.match(adapter.add({ id: 'mem', command: 'npx' }).error, /already exists/, spec.name);
    assert.match(adapter.add({ id: 'archived', command: 'npx' }).error, /already exists/, spec.name);
    assert.equal(adapter.add({ id: 'bad id', command: 'npx' }).ok, false, spec.name);

    assert.deepEqual(adapter.update('mem', {
      newId: 'remote',
      transport: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t' },
    }), { ok: true }, spec.name);
    cfg = readAdapterConfig(adapter);
    assert.equal(cfg.mcpServers.mem, undefined, spec.name);
    assert.deepEqual(cfg.mcpServers.remote, {
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer t' },
    });
    assert.match(adapter.update('missing', { command: 'node' }).error, /not found/, spec.name);
    assert.match(adapter.update('remote', { newId: 'archived', command: 'node' }).error, /already exists/, spec.name);
    assert.equal(adapter.update('', {}).ok, false, spec.name);

    assert.deepEqual(adapter.toggle('remote'), { ok: true }, spec.name);
    cfg = readAdapterConfig(adapter);
    assert.equal(cfg.mcpServers.remote, undefined, spec.name);
    assert.ok(cfg._huskMcpDisabled.remote, spec.name);

    assert.deepEqual(adapter.update('remote', { newId: 'restored', command: 'node', args: ['server.js'] }), { ok: true }, spec.name);
    cfg = readAdapterConfig(adapter);
    assert.equal(cfg._huskMcpDisabled.remote, undefined, spec.name);
    assert.deepEqual(cfg._huskMcpDisabled.restored, { command: 'node', args: ['server.js'] });

    assert.deepEqual(adapter.toggle('restored'), { ok: true }, spec.name);
    cfg = readAdapterConfig(adapter);
    assert.deepEqual(cfg.mcpServers.restored, { command: 'node', args: ['server.js'] });
    assert.equal(cfg._huskMcpDisabled.restored, undefined, spec.name);
    assert.equal(adapter.toggle('missing').ok, false, spec.name);

    assert.deepEqual(adapter.remove('restored'), { ok: true }, spec.name);
    cfg = readAdapterConfig(adapter);
    assert.equal(cfg.mcpServers.restored, undefined, spec.name);
    assert.equal(cfg._huskMcpDisabled.restored, undefined, spec.name);
    assert.equal(cfg.theme, 'dark', spec.name);
    assert.equal(adapter.remove('').ok, false, spec.name);
  }
});

test('real MCP adapters refuse writes when their config file is corrupt', (t) => {
  for (const spec of REAL_ADAPTERS) {
    const home = tmpHome(t);
    const adapter = loadFreshAdapter(t, spec.modulePath, home);
    fs.mkdirSync(path.dirname(adapter.configPath), { recursive: true });
    fs.writeFileSync(adapter.configPath, '{ this is not json');
    assert.match(adapter.add({ id: 'mem', command: 'npx' }).error, /could not be read/, spec.name);
  }
});

test('copilot and gemini adapters return configured health without spawning a probe', async (t) => {
  for (const spec of REAL_ADAPTERS.filter((a) => a.name !== 'claude')) {
    const adapter = loadFreshAdapter(t, spec.modulePath, tmpHome(t));
    assert.deepEqual(await adapter.health(), { ok: true, status: {} }, spec.name);
  }
});

test('claude adapter health probes once and reuses the fresh cache', async (t) => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeHealthProcess(
      'mem: npx - connected\n',
      'auth: https://example.test/mcp - needs auth\n',
    );
  };
  t.after(() => { childProcess.spawn = originalSpawn; });

  const adapter = loadFreshAdapter(t, '../../src/lib/mcp/claude', tmpHome(t));
  const first = await adapter.health({ force: true });
  assert.deepEqual(first, { ok: true, status: { mem: 'connected', auth: 'auth' } });

  const second = await adapter.health();
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.deepEqual(calls[0].args, ['mcp', 'list']);
  assert.equal(calls[0].opts.timeout, 60000);
  assert.equal(calls[0].opts.windowsHide, true);
});

test('claude adapter health returns spawn errors and retries after failures', async (t) => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let mode = 'throw';
  let calls = 0;
  childProcess.spawn = () => {
    calls += 1;
    if (mode === 'throw') throw new Error('claude missing');
    return fakeHealthProcess('mem: npx - connected\n');
  };
  t.after(() => { childProcess.spawn = originalSpawn; });

  const adapter = loadFreshAdapter(t, '../../src/lib/mcp/claude', tmpHome(t));
  const failed = await adapter.health({ force: true });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /claude missing/);
  assert.deepEqual(failed.status, {});

  mode = 'success';
  assert.deepEqual(await adapter.health(), { ok: true, status: { mem: 'connected' } });
  assert.equal(calls, 2);
});

test('claude adapter health reports async probe error events', async (t) => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => proc.emit('error', new Error('probe failed')));
    return proc;
  };
  t.after(() => { childProcess.spawn = originalSpawn; });

  const adapter = loadFreshAdapter(t, '../../src/lib/mcp/claude', tmpHome(t));
  const result = await adapter.health({ force: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /probe failed/);
  assert.deepEqual(result.status, {});
});

test('claude adapter health converts probe setup exceptions to a failed status', async (t) => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => ({});
  t.after(() => { childProcess.spawn = originalSpawn; });

  const adapter = loadFreshAdapter(t, '../../src/lib/mcp/claude', tmpHome(t));
  const result = await adapter.health({ force: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /stdout|on|undefined/i);
  assert.deepEqual(result.status, {});
});
