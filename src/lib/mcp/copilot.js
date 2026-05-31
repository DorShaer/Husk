'use strict';

const os = require('os');
const path = require('path');
const { shapeServer, readJsonFile, readJsonFileStrict, writeJsonFile, buildServerEntry } = require('./common');

// Copilot's MCP config lives at ~/.copilot/mcp-config.json. Schema is
// compatible with claude's (mcpServers map, transport+url for remote,
// command+args+env for stdio). Copilot's `copilot mcp list` CLI only
// prints the configured list with no live status, so we surface
// status 'configured' and skip the probe.
const CONFIG_PATH = path.join(os.homedir(), '.copilot', 'mcp-config.json');

function readConfig() { return readJsonFile(CONFIG_PATH); }
function writeConfig(obj) { return writeJsonFile(CONFIG_PATH, obj); }

// Read for the write path. Refuses to proceed when the file exists but
// cannot be parsed so a mutating op never overwrites a config it could
// not read.
function readConfigForWrite() {
  const r = readJsonFileStrict(CONFIG_PATH);
  if (!r.ok) return { error: 'Refusing to write: ~/.copilot/mcp-config.json exists but could not be read' };
  return { cfg: r.data };
}

function list() {
  const cfg = readConfig();
  const enabled = cfg.mcpServers || {};
  const disabled = cfg._huskMcpDisabled || {};
  const servers = [];
  for (const id of Object.keys(enabled)) servers.push(shapeServer(id, enabled[id], false));
  for (const id of Object.keys(disabled)) servers.push(shapeServer(id, disabled[id], true));
  servers.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, servers };
}

function add(payload = {}) {
  const { id } = payload;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: 'Invalid server id' };
  const read = readConfigForWrite();
  if (read.error) return { ok: false, error: read.error };
  const cfg = read.cfg;
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers[id] || (cfg._huskMcpDisabled && cfg._huskMcpDisabled[id])) {
    return { ok: false, error: `MCP server "${id}" already exists` };
  }
  const built = buildServerEntry(payload);
  if (built.error) return { ok: false, error: built.error };
  cfg.mcpServers[id] = built.entry;
  if (!writeConfig(cfg)) return { ok: false, error: 'Could not write ~/.copilot/mcp-config.json' };
  return { ok: true };
}

function remove(id) {
  if (!id) return { ok: false, error: 'No id' };
  const read = readConfigForWrite();
  if (read.error) return { ok: false, error: read.error };
  const cfg = read.cfg;
  if (cfg.mcpServers && cfg.mcpServers[id]) delete cfg.mcpServers[id];
  if (cfg._huskMcpDisabled && cfg._huskMcpDisabled[id]) delete cfg._huskMcpDisabled[id];
  writeConfig(cfg);
  return { ok: true };
}

// update overwrites an existing server entry in place, preserving its
// enabled/disabled status. Same contract as the claude adapter.
function update(id, payload = {}) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: 'Invalid server id' };
  const read = readConfigForWrite();
  if (read.error) return { ok: false, error: read.error };
  const cfg = read.cfg;
  const inEnabled = !!(cfg.mcpServers && cfg.mcpServers[id]);
  const inDisabled = !!(cfg._huskMcpDisabled && cfg._huskMcpDisabled[id]);
  if (!inEnabled && !inDisabled) {
    return { ok: false, error: `MCP server "${id}" not found` };
  }
  const built = buildServerEntry(payload);
  if (built.error) return { ok: false, error: built.error };
  if (inEnabled) {
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[id] = built.entry;
  } else {
    cfg._huskMcpDisabled = cfg._huskMcpDisabled || {};
    cfg._huskMcpDisabled[id] = built.entry;
  }
  if (!writeConfig(cfg)) return { ok: false, error: 'Could not write ~/.copilot/mcp-config.json' };
  return { ok: true };
}

function toggle(id) {
  if (!id) return { ok: false, error: 'No id' };
  const read = readConfigForWrite();
  if (read.error) return { ok: false, error: read.error };
  const cfg = read.cfg;
  cfg.mcpServers = cfg.mcpServers || {};
  cfg._huskMcpDisabled = cfg._huskMcpDisabled || {};
  if (cfg.mcpServers[id]) {
    cfg._huskMcpDisabled[id] = cfg.mcpServers[id];
    delete cfg.mcpServers[id];
  } else if (cfg._huskMcpDisabled[id]) {
    cfg.mcpServers[id] = cfg._huskMcpDisabled[id];
    delete cfg._huskMcpDisabled[id];
  } else {
    return { ok: false, error: `MCP server "${id}" not found` };
  }
  writeConfig(cfg);
  return { ok: true };
}

// Copilot has no programmatic health probe today. Return an empty
// status map so the renderer paints rows as "configured" rather than
// "unknown".
function health() {
  return Promise.resolve({ ok: true, status: {} });
}

module.exports = {
  agent: 'copilot',
  configPath: CONFIG_PATH,
  supportsWrite: true,
  supportsLiveStatus: false,
  list,
  health,
  add,
  update,
  remove,
  toggle,
};
