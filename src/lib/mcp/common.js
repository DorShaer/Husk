'use strict';

const fs = require('fs');
const path = require('path');

// shapeServer takes the raw config entry (as written in the agent's
// mcp-servers config file) and returns the renderer-friendly shape.
// Both stdio (command + args + env) and remote (http/sse + url +
// headers) transports surface; the renderer picks fields based on the
// transport string.
function shapeServer(id, def, disabled) {
  const isRemote = def && (def.type === 'http' || def.type === 'sse' || def.url);
  if (isRemote) {
    return {
      id,
      enabled: !disabled,
      transport: def.type || 'http',
      url: def.url || '',
      headers: def.headers || {},
    };
  }
  return {
    id,
    enabled: !disabled,
    transport: 'stdio',
    command: def.command || '',
    args: def.args || [],
    env: def.env || {},
  };
}

// readJsonFile + writeJsonFile share a config-file pattern used by
// claude and copilot. filePath is provided by the calling adapter and
// is one of a small fixed set (~/.claude.json, ~/.copilot/mcp-config
// .json). Both files hold secrets (API keys, OAuth tokens, MCP env
// vars) so the write is mode 0o600.
function readJsonFile(filePath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(filePath)) return {};
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Strict reader for the read-modify-write path. A missing file is a
// clean empty config, but a file that exists yet does not parse is an
// error: returning {} there would let a mutating op overwrite a config
// it could not actually read and drop every key it holds. The config
// file is owned and written by the agent CLI itself, so callers must
// refuse to write when this returns ok:false.
function readJsonFileStrict(filePath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(filePath)) return { ok: true, data: {}, missing: true };
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'unreadable' };
  }
}

// Atomic write: serialize to a sibling temp file then rename over the
// target. rename is atomic on a single filesystem, so a crash or full
// disk mid-write leaves the original config intact instead of a
// half-written, unparseable file.
function writeJsonFile(filePath, obj) {
  let tmp;
  try {
    const dir = path.dirname(filePath);
    tmp = path.join(dir, '.' + path.basename(filePath) + '.husk-' + process.pid + '.tmp');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    try { fs.chmodSync(tmp, 0o600); } catch (_) {}
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.renameSync(tmp, filePath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    return true;
  } catch (_) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (tmp) try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

// buildServerEntry takes a renderer payload and produces the config-
// file entry. Same for both claude and copilot (compatible schema).
function buildServerEntry(payload) {
  if (payload.transport === 'http' || payload.transport === 'sse' || payload.url) {
    if (!payload.url) return { error: 'URL required for HTTP/SSE transport' };
    const entry = { type: payload.transport || 'http', url: payload.url };
    if (payload.headers && Object.keys(payload.headers).length) entry.headers = payload.headers;
    return { entry };
  }
  if (!payload.command) return { error: 'Command required for stdio transport' };
  const entry = { command: payload.command, args: Array.isArray(payload.args) ? payload.args : [] };
  if (payload.env && Object.keys(payload.env).length) entry.env = payload.env;
  return { entry };
}

// agentKey(agentCommand) returns the lowercase basename of the first
// whitespace-separated token, used to pick the right adapter.
function agentKey(agentCommand) {
  const raw = String(agentCommand || 'claude').trim();
  if (!raw) return 'claude';
  const first = raw.split(/\s+/)[0];
  const base = first.split(/[\\/]/).pop().toLowerCase();
  // Strip Windows extensions for resilience (claude.exe, claude.cmd).
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

module.exports = { shapeServer, readJsonFile, readJsonFileStrict, writeJsonFile, buildServerEntry, agentKey };
