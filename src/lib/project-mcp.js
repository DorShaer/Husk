'use strict';

// Per-project MCP server selection.
//
// The agent CLIs each keep one global MCP list, so every folder gets every
// server and the only lever is turning a server off everywhere. That costs
// context on every request and offers the agent tools that have nothing to do
// with the folder it is working in.
//
// Husk owns the mapping instead of leaning on any one CLI's scope model:
// config.projectMcp maps a project path to { serverId: 'on' | 'off' }. A server
// with no entry inherits whatever the global list says, so a project with no
// overrides behaves exactly as it did before anyone touched this page.
//
// The resolved set is applied at launch through each CLI's own flags. Nothing
// on disk is rewritten, so a CLI started outside Husk still sees the user's own
// global configuration.
//
//   claude   --mcp-config <file> --strict-mcp-config   (file is the whole set)
//   copilot  --additional-mcp-config @<file>           (adds project-on servers)
//            --disable-mcp-server <id>                 (one per excluded server)
//   gemini   --allowed-mcp-server-names <id...>        (allowlist)
//
// Everything here is pure except writeConfigFile, so the resolution and the
// argument shapes are testable without spawning anything.

const fs = require('fs');
const path = require('path');

const STATE_ON = 'on';
const STATE_OFF = 'off';
const STATE_INHERIT = 'inherit';

// Trailing separators and unnormalized segments would key the same folder twice.
function normalizeProjectPath(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const norm = path.normalize(s).replace(/[\\/]+$/, '');
  return norm || path.sep;
}

// Split on both separators: a Windows path reaching a POSIX host would keep its
// backslashes and path.basename would hand back the whole string.
function agentKind(agentExe) {
  const base = String(agentExe || '').trim().split(/\s+/)[0]
    .split(/[\\/]/).pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/i, '');
  if (base === 'claude' || base === 'copilot' || base === 'gemini') return base;
  return null;
}

// overridesFor(projectMcp, cwd) returns the { id: state } map for one folder.
function overridesFor(projectMcp, cwd) {
  const key = normalizeProjectPath(cwd);
  if (!key || !projectMcp || typeof projectMcp !== 'object') return {};
  const raw = projectMcp[key];
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [id, state] of Object.entries(raw)) {
    if (state === STATE_ON || state === STATE_OFF) out[id] = state;
  }
  return out;
}

// resolveEffective decides which servers a folder actually runs.
//
// A server is in when the project says 'on', or when the project says nothing
// and the global list has it enabled. 'off' always wins for that folder. The
// result carries enough provenance for the UI to say why each server is there.
function resolveEffective(servers, overrides) {
  const list = Array.isArray(servers) ? servers.filter((s) => s && s.id) : [];
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const effective = [];
  const excluded = [];
  const rows = [];

  for (const server of list) {
    const state = ov[server.id] === STATE_ON || ov[server.id] === STATE_OFF ? ov[server.id] : STATE_INHERIT;
    const globallyOn = server.enabled !== false;
    const on = state === STATE_ON ? true : state === STATE_OFF ? false : globallyOn;
    // A row is "from the project" when the override disagrees with the global
    // list; matching the global default is still an inherit as far as the user
    // is concerned, whatever is stored.
    const source = state !== STATE_INHERIT && state !== (globallyOn ? STATE_ON : STATE_OFF)
      ? 'project'
      : 'global';
    rows.push({ id: server.id, on, state, globallyOn, source });
    if (on) effective.push(server);
    else if (globallyOn) excluded.push(server.id);
  }

  return {
    servers: effective,
    excluded,
    rows,
    // No disagreement with the global list means no launch flags are needed.
    customized: rows.some((r) => r.source === 'project'),
  };
}

// Shape one server the way every MCP config file expects. Mirrors the entries
// the CLIs write themselves, so a server round-trips without losing fields.
function serverEntry(server) {
  if (!server || !server.id) return null;
  if (server.transport === 'http' || server.transport === 'sse' || server.url) {
    const entry = { type: server.transport === 'sse' ? 'sse' : 'http', url: server.url || '' };
    if (server.headers && Object.keys(server.headers).length) entry.headers = server.headers;
    return entry;
  }
  const entry = { type: 'stdio', command: server.command || '', args: Array.isArray(server.args) ? server.args : [] };
  if (server.env && Object.keys(server.env).length) entry.env = server.env;
  return entry;
}

function renderConfigFile(servers) {
  const mcpServers = {};
  for (const server of Array.isArray(servers) ? servers : []) {
    const entry = serverEntry(server);
    if (entry) mcpServers[server.id] = entry;
  }
  return { mcpServers };
}

// One file per project, under a Husk-managed directory. The name is derived
// from the path so a project keeps the same file across launches, and the hash
// keeps two folders with the same basename apart.
function configFileName(cwd) {
  const key = normalizeProjectPath(cwd);
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash * 33) ^ key.charCodeAt(i)) >>> 0;
  const slug = (path.basename(key) || 'project').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40);
  return `${slug}-${hash.toString(16)}.json`;
}

// Which servers belong in the launch config file, per CLI. claude runs in
// strict mode off this file, so it needs the whole resolved set. copilot keeps
// reading its own config and only needs the servers the project switched on
// that are globally off. gemini takes an allowlist and needs no file.
function serversForConfigFile(agentExe, resolved) {
  const kind = agentKind(agentExe);
  if (!kind || !resolved || !resolved.customized) return [];
  if (kind === 'claude') return resolved.servers;
  if (kind === 'copilot') {
    const extra = new Set(resolved.rows.filter((r) => r.on && !r.globallyOn).map((r) => r.id));
    return resolved.servers.filter((s) => extra.has(s.id));
  }
  return [];
}

function writeConfigFile(dir, cwd, servers) {
  const file = path.join(dir, configFileName(cwd));
  try {
    // dir is a Husk-managed directory under userData; the basename is derived
    // from the project path and stripped to [A-Za-z0-9_-].
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(file, JSON.stringify(renderConfigFile(servers), null, 2));
    return file;
  } catch (_) {
    return null;
  }
}

// buildLaunchArgs returns the flags that pin one launch to the resolved set.
// Returns [] when the CLI has no lever for this, or when the project agrees
// with the global list and there is nothing to pin.
//
// configFile must already hold the resolved set (see writeConfigFile); it is
// passed in rather than written here to keep this pure.
function buildLaunchArgs({ agentExe, resolved, configFile, existingArgs }) {
  const kind = agentKind(agentExe);
  if (!kind || !resolved || !resolved.customized) return [];
  const have = Array.isArray(existingArgs) ? existingArgs : [];

  if (kind === 'claude') {
    // Without a config file there is nothing to point claude at, and
    // --strict-mcp-config alone would silently drop every server.
    if (!configFile) return [];
    if (have.includes('--mcp-config') || have.includes('--strict-mcp-config')) return [];
    return ['--mcp-config', configFile, '--strict-mcp-config'];
  }

  if (kind === 'copilot') {
    const args = [];
    // Servers the project switched on are not in copilot's own config when
    // they are globally off, so they have to be supplied for this session.
    const extra = resolved.rows.filter((r) => r.on && !r.globallyOn);
    if (extra.length && configFile && !have.includes('--additional-mcp-config')) {
      args.push('--additional-mcp-config', `@${configFile}`);
    }
    for (const id of resolved.excluded) {
      if (have.some((a, i) => a === id && have[i - 1] === '--disable-mcp-server')) continue;
      args.push('--disable-mcp-server', id);
    }
    return args;
  }

  // gemini takes an allowlist, which expresses the resolved set directly.
  if (have.includes('--allowed-mcp-server-names')) return [];
  const names = resolved.servers.map((s) => s.id);
  if (!names.length) return [];
  return ['--allowed-mcp-server-names', ...names];
}

module.exports = {
  STATE_ON,
  STATE_OFF,
  STATE_INHERIT,
  normalizeProjectPath,
  agentKind,
  overridesFor,
  resolveEffective,
  renderConfigFile,
  serversForConfigFile,
  configFileName,
  writeConfigFile,
  buildLaunchArgs,
};
