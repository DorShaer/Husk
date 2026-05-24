'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { shapeServer, readJsonFile, writeJsonFile, buildServerEntry } = require('./common');
const { parseMcpListOutput } = require('../mcp-status');

const CONFIG_PATH = path.join(os.homedir(), '.claude.json');

function readConfig() { return readJsonFile(CONFIG_PATH); }
function writeConfig(obj) { return writeJsonFile(CONFIG_PATH, obj); }

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
  const cfg = readConfig();
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers[id] || (cfg._huskMcpDisabled && cfg._huskMcpDisabled[id])) {
    return { ok: false, error: `MCP server "${id}" already exists` };
  }
  const built = buildServerEntry(payload);
  if (built.error) return { ok: false, error: built.error };
  cfg.mcpServers[id] = built.entry;
  if (!writeConfig(cfg)) return { ok: false, error: 'Could not write ~/.claude.json' };
  return { ok: true };
}

function remove(id) {
  if (!id) return { ok: false, error: 'No id' };
  const cfg = readConfig();
  if (cfg.mcpServers && cfg.mcpServers[id]) delete cfg.mcpServers[id];
  if (cfg._huskMcpDisabled && cfg._huskMcpDisabled[id]) delete cfg._huskMcpDisabled[id];
  writeConfig(cfg);
  return { ok: true };
}

function toggle(id) {
  if (!id) return { ok: false, error: 'No id' };
  const cfg = readConfig();
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

// Live probe via `claude mcp list`. The command takes 25-40 seconds in
// practice because it actually round-trips every configured server.
function health() {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('claude', ['mcp', 'list'], { env: process.env, timeout: 60000, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message, status: {} });
      return;
    }
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d.toString(); });
    proc.stderr.on('data', (d) => { buf += d.toString(); });
    proc.on('error', (err) => resolve({ ok: false, error: err.message, status: {} }));
    proc.on('close', () => resolve({ ok: true, status: parseMcpListOutput(buf) }));
  });
}

module.exports = {
  agent: 'claude',
  configPath: CONFIG_PATH,
  supportsWrite: true,
  supportsLiveStatus: true,
  list,
  health,
  add,
  remove,
  toggle,
};
