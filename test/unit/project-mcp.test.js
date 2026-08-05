'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeProjectPath,
  agentKind,
  overridesFor,
  resolveEffective,
  renderConfigFile,
  serversForConfigFile,
  configFileName,
  writeConfigFile,
  buildLaunchArgs,
} = require('../../src/lib/project-mcp');

const SERVERS = [
  { id: 'memory', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'server-memory'] },
  { id: 'opensearch', enabled: false, transport: 'stdio', command: 'uvx', args: ['opensearch-mcp'] },
  { id: 'jira', enabled: true, transport: 'http', url: 'https://example.test/mcp' },
];

test('normalizes project paths so one folder keys one entry', () => {
  assert.equal(normalizeProjectPath('/a/b/'), '/a/b');
  assert.equal(normalizeProjectPath('/a/b//'), '/a/b');
  assert.equal(normalizeProjectPath('/a/./b'), '/a/b');
  assert.equal(normalizeProjectPath('  /a/b  '), '/a/b');
  assert.equal(normalizeProjectPath(''), '');
  assert.equal(normalizeProjectPath(null), '');
});

test('recognizes the CLIs that expose a launch-time MCP lever', () => {
  assert.equal(agentKind('claude'), 'claude');
  assert.equal(agentKind('/usr/local/bin/copilot'), 'copilot');
  assert.equal(agentKind('C:\\tools\\gemini.cmd'), 'gemini');
  assert.equal(agentKind('aider'), null);
  assert.equal(agentKind(''), null);
});

test('reads overrides for a folder and ignores junk states', () => {
  const map = { '/a/b': { memory: 'off', jira: 'on', bogus: 'maybe' } };
  assert.deepEqual(overridesFor(map, '/a/b/'), { memory: 'off', jira: 'on' });
  assert.deepEqual(overridesFor(map, '/other'), {});
  assert.deepEqual(overridesFor(null, '/a/b'), {});
});

test('a folder with no overrides resolves to the global set unchanged', () => {
  const r = resolveEffective(SERVERS, {});
  assert.deepEqual(r.servers.map((s) => s.id), ['memory', 'jira']);
  assert.deepEqual(r.excluded, []);
  // Nothing disagrees with the global list, so nothing is pinned at launch.
  assert.equal(r.customized, false);
});

test('project off removes a globally enabled server for that folder only', () => {
  const r = resolveEffective(SERVERS, { memory: 'off' });
  assert.deepEqual(r.servers.map((s) => s.id), ['jira']);
  assert.deepEqual(r.excluded, ['memory']);
  assert.equal(r.customized, true);
  assert.equal(r.rows.find((x) => x.id === 'memory').source, 'project');
  assert.equal(r.rows.find((x) => x.id === 'jira').source, 'global');
});

test('project on adds a globally disabled server for that folder only', () => {
  const r = resolveEffective(SERVERS, { opensearch: 'on' });
  assert.deepEqual(r.servers.map((s) => s.id), ['memory', 'opensearch', 'jira']);
  assert.deepEqual(r.excluded, []);
  assert.equal(r.customized, true);
});

test('an override that agrees with the global list is not a customization', () => {
  // Storing 'on' for something already on changes nothing, so the launch stays
  // flag-free rather than pinning a set identical to the default.
  const r = resolveEffective(SERVERS, { memory: 'on', opensearch: 'off' });
  assert.equal(r.customized, false);
  assert.deepEqual(r.servers.map((s) => s.id), ['memory', 'jira']);
});

test('claude pins the whole resolved set and ignores every other config', () => {
  const resolved = resolveEffective(SERVERS, { memory: 'off' });
  const args = buildLaunchArgs({ agentExe: 'claude', resolved, configFile: '/tmp/x.json', existingArgs: [] });
  assert.deepEqual(args, ['--mcp-config', '/tmp/x.json', '--strict-mcp-config']);
  assert.deepEqual(serversForConfigFile('claude', resolved).map((s) => s.id), ['jira']);
});

test('claude passes nothing when there is no config file to point at', () => {
  const resolved = resolveEffective(SERVERS, { memory: 'off' });
  // Pinning strict mode with no file would drop every server instead of one.
  assert.deepEqual(buildLaunchArgs({ agentExe: 'claude', resolved, configFile: null, existingArgs: [] }), []);
});

test('copilot disables excluded servers and supplies only the added ones', () => {
  const resolved = resolveEffective(SERVERS, { memory: 'off', opensearch: 'on' });
  const args = buildLaunchArgs({ agentExe: 'copilot', resolved, configFile: '/tmp/x.json', existingArgs: [] });
  assert.deepEqual(args, ['--additional-mcp-config', '@/tmp/x.json', '--disable-mcp-server', 'memory']);
  // copilot keeps reading its own config, so the file carries the extra only.
  assert.deepEqual(serversForConfigFile('copilot', resolved).map((s) => s.id), ['opensearch']);
});

test('copilot needs no config file when the project only removes servers', () => {
  const resolved = resolveEffective(SERVERS, { memory: 'off' });
  const args = buildLaunchArgs({ agentExe: 'copilot', resolved, configFile: '/tmp/x.json', existingArgs: [] });
  assert.deepEqual(args, ['--disable-mcp-server', 'memory']);
  assert.deepEqual(serversForConfigFile('copilot', resolved), []);
});

test('gemini expresses the resolved set as an allowlist', () => {
  const resolved = resolveEffective(SERVERS, { memory: 'off' });
  assert.deepEqual(
    buildLaunchArgs({ agentExe: 'gemini', resolved, configFile: null, existingArgs: [] }),
    ['--allowed-mcp-server-names', 'jira'],
  );
  assert.deepEqual(serversForConfigFile('gemini', resolved), []);
});

test('an uncustomized folder adds no flags for any CLI', () => {
  const resolved = resolveEffective(SERVERS, {});
  for (const exe of ['claude', 'copilot', 'gemini']) {
    assert.deepEqual(buildLaunchArgs({ agentExe: exe, resolved, configFile: '/tmp/x.json', existingArgs: [] }), [], exe);
  }
});

test('a CLI with no MCP lever is left alone', () => {
  const resolved = resolveEffective(SERVERS, { memory: 'off' });
  assert.deepEqual(buildLaunchArgs({ agentExe: 'aider', resolved, configFile: '/tmp/x.json', existingArgs: [] }), []);
});

test('flags the user already typed are not duplicated', () => {
  const resolved = resolveEffective(SERVERS, { memory: 'off' });
  assert.deepEqual(
    buildLaunchArgs({ agentExe: 'claude', resolved, configFile: '/tmp/x.json', existingArgs: ['--strict-mcp-config'] }),
    [],
  );
  assert.deepEqual(
    buildLaunchArgs({ agentExe: 'gemini', resolved, configFile: null, existingArgs: ['--allowed-mcp-server-names', 'jira'] }),
    [],
  );
  assert.deepEqual(
    buildLaunchArgs({ agentExe: 'copilot', resolved, configFile: null, existingArgs: ['--disable-mcp-server', 'memory'] }),
    [],
  );
});

test('renders stdio and http servers in the shape the CLIs expect', () => {
  const out = renderConfigFile(SERVERS);
  assert.deepEqual(out.mcpServers.memory, { type: 'stdio', command: 'npx', args: ['-y', 'server-memory'] });
  assert.deepEqual(out.mcpServers.jira, { type: 'http', url: 'https://example.test/mcp' });
});

test('two folders sharing a basename get separate config files', () => {
  const a = configFileName('/home/dor/work/husk');
  const b = configFileName('/home/dor/archive/husk');
  assert.notEqual(a, b);
  assert.match(a, /^husk-[0-9a-f]+\.json$/);
  // A folder keeps the same file across launches.
  assert.equal(configFileName('/home/dor/work/husk/'), a);
});

test('writes a config file the CLIs can read back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-pmcp-'));
  const file = writeConfigFile(dir, '/home/dor/work/husk', [SERVERS[0]]);
  assert.ok(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.memory.command, 'npx');
  fs.rmSync(dir, { recursive: true, force: true });
});
