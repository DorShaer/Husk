'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { shapeServer, readJsonFile, readJsonFileStrict, writeJsonFile, buildServerEntry } = require('./common');
const { parseMcpListOutput } = require('../mcp-status');

const CONFIG_PATH = path.join(os.homedir(), '.claude.json');

function readConfig() { return readJsonFile(CONFIG_PATH); }
function writeConfig(obj) { return writeJsonFile(CONFIG_PATH, obj); }

// Read for the write path. Returns the parsed config, or an error
// string when the file exists but cannot be parsed so the caller can
// refuse to overwrite it.
function readConfigForWrite() {
  const r = readJsonFileStrict(CONFIG_PATH);
  if (!r.ok) return { error: 'Refusing to write: ~/.claude.json exists but could not be read' };
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
  if (!writeConfig(cfg)) return { ok: false, error: 'Could not write ~/.claude.json' };
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
// enabled/disabled status. Used by the Edit MCP flow. Returns
// `{ ok: false, error: 'MCP server "<id>" not found' }` when the id
// is not present in either bucket.
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
  // Optional rename. A JSON object key can't be mutated in place, so a
  // rename means writing the entry under the new key and dropping the old
  // one. Reject names that collide with an existing server in either bucket.
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
  if (!writeConfig(cfg)) return { ok: false, error: 'Could not write ~/.claude.json' };
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

// Live probe via `claude mcp list`. The command takes 25-40 seconds in
// practice because it actually round-trips every configured server.
// Because it is slow, a fresh result is cached for a short window and
// concurrent callers share a single in-flight probe: opening the MCP
// panel or re-rendering must not stack a new 30s+ child process each
// time.
const HEALTH_TTL_MS = 20000;
let healthCache = null;       // { at, result }
let healthInflight = null;    // Promise while a probe is running

function runHealthProbe() {
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

function health(opts = {}) {
  const now = Date.now();
  if (!opts.force && healthCache && (now - healthCache.at) < HEALTH_TTL_MS) {
    return Promise.resolve(healthCache.result);
  }
  if (healthInflight) return healthInflight;
  healthInflight = runHealthProbe().then((result) => {
    // Only cache a successful probe; a transient spawn error should not
    // suppress the next real attempt for the whole TTL window.
    if (result && result.ok) healthCache = { at: Date.now(), result };
    healthInflight = null;
    return result;
  }).catch((err) => {
    healthInflight = null;
    return { ok: false, error: (err && err.message) || 'probe failed', status: {} };
  });
  return healthInflight;
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
  update,
};
