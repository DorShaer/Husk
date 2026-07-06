'use strict';

const os = require('os');
const path = require('path');
const { shapeServer, readJsonFile, readJsonFileStrict, writeJsonFile, buildServerEntry } = require('./common');

// Gemini CLI stores MCP servers in ~/.gemini/settings.json under the
// "mcpServers" key, the same map shape as claude and copilot (command +
// args + env for stdio, url/httpUrl for remote). settings.json also holds
// unrelated user settings (theme, etc.), so every write reads the whole
// object and only touches mcpServers plus the Husk disabled-sidecar; all
// other keys are preserved. Gemini exposes no programmatic health probe,
// so status is 'configured' and the probe is skipped.
const CONFIG_PATH = path.join(os.homedir(), '.gemini', 'settings.json');

function readConfig() { return readJsonFile(CONFIG_PATH); }
function writeConfig(obj) { return writeJsonFile(CONFIG_PATH, obj); }

function readConfigForWrite() {
  const r = readJsonFileStrict(CONFIG_PATH);
  if (!r.ok) return { error: 'Refusing to write: ~/.gemini/settings.json exists but could not be read' };
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
  if (!writeConfig(cfg)) return { ok: false, error: 'Could not write ~/.gemini/settings.json' };
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

function update(id, payload = {}) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: 'Invalid server id' };
  const read = readConfigForWrite();
  if (read.error) return { ok: false, error: read.error };
  const cfg = read.cfg;
  const inEnabled = !!(cfg.mcpServers && cfg.mcpServers[id]);
  const inDisabled = !!(cfg._huskMcpDisabled && cfg._huskMcpDisabled[id]);
  if (!inEnabled && !inDisabled) return { ok: false, error: `MCP server "${id}" not found` };
  const newId = payload.newId && payload.newId !== id ? payload.newId : null;
  if (newId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(newId)) return { ok: false, error: 'Invalid server name' };
    if ((cfg.mcpServers && cfg.mcpServers[newId]) || (cfg._huskMcpDisabled && cfg._huskMcpDisabled[newId])) {
      return { ok: false, error: `MCP server "${newId}" already exists` };
    }
  }
  const built = buildServerEntry(payload);
  if (built.error) return { ok: false, error: built.error };
  const targetId = newId || id;
  if (inEnabled) {
    cfg.mcpServers = cfg.mcpServers || {};
    if (newId) delete cfg.mcpServers[id];
    cfg.mcpServers[targetId] = built.entry;
  } else {
    cfg._huskMcpDisabled = cfg._huskMcpDisabled || {};
    if (newId) delete cfg._huskMcpDisabled[id];
    cfg._huskMcpDisabled[targetId] = built.entry;
  }
  if (!writeConfig(cfg)) return { ok: false, error: 'Could not write ~/.gemini/settings.json' };
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

function health() {
  return Promise.resolve({ ok: true, status: {} });
}

module.exports = {
  agent: 'gemini',
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
