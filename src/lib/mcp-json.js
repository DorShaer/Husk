'use strict';

// Lenient parser for MCP JSON snippets the user pastes into the
// custom-install modal. People copy from all sorts of places, with all
// sorts of surrounding context (indentation from inside a config file,
// a trailing comma from being mid-array, a stray "mcpServers" wrapper,
// a leading key like `"my-server":` because they grabbed a single
// property out of a bigger object). This parser tries to repair the
// snippet through a small set of well-known transformations and
// returns a normalized list of entries the install pipeline can act on.
//
// Shape on success:
//   { ok: true, entries: [{ id, entry }, ...] }
// Shape on failure:
//   { ok: false, error: 'message' }
//
// An "entry" here is the raw object the user wrote (command/args/env
// for stdio, type/url/headers for remote). The downstream shapeEntry
// helper turns one entry into the canonical add()-payload shape.

function parseLooseMcpJson(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { ok: false, error: 'empty input' };

  // Tier 1: try the input as-is. Fast path for well-formed JSON.
  const direct = tryParseAndNormalize(raw);
  if (direct.ok) return direct;

  // Tier 2: strip trailing commas. Common when the snippet was lifted
  // from the middle of an array or object.
  const noTrailingCommas = raw.replace(/,(\s*[}\]])/g, '$1');
  const t2 = tryParseAndNormalize(noTrailingCommas);
  if (t2.ok) return t2;

  // Tier 3: trim a leading comma and try wrapping with braces. Handles
  // `"my-server": { ... }` pasted out of a larger object.
  const trimmed = noTrailingCommas.replace(/^,\s*/, '').replace(/,\s*$/, '');
  const t3 = tryParseAndNormalize('{' + trimmed + '}');
  if (t3.ok) return t3;

  // Tier 4: maybe the input has both leading AND trailing commas plus
  // sibling entries — wrap the whole thing.
  const t4 = tryParseAndNormalize('{' + noTrailingCommas.replace(/^[,\s]+|[,\s]+$/g, '') + '}');
  if (t4.ok) return t4;

  return { ok: false, error: t2.error || direct.error || 'could not parse JSON' };
}

function tryParseAndNormalize(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (err) { return { ok: false, error: err.message }; }
  return normalize(obj);
}

function normalize(obj) {
  if (Array.isArray(obj)) {
    const entries = [];
    for (const item of obj) {
      if (looksLikeEntry(item)) entries.push({ id: '', entry: item });
    }
    if (!entries.length) return { ok: false, error: 'array had no MCP entries' };
    return { ok: true, entries };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'not a JSON object' };

  // A bare entry the user typed straight into the box. Lower priority
  // than the wrapped shapes — we only treat it as a bare entry if the
  // top level itself has command/url/type. An object whose values are
  // objects with command/url is the multi-server case below.
  if (looksLikeEntry(obj)) return { ok: true, entries: [{ id: '', entry: obj }] };

  // { "mcpServers": { ... } } — the canonical claude / copilot config
  // wrapper. Unwrap and recurse exactly once.
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    return normalize(obj.mcpServers);
  }
  // Same for VS Code's `servers` wrapper, used in ~/.config/Code/User/mcp.json
  if (obj.servers && typeof obj.servers === 'object' && !Array.isArray(obj.servers)) {
    return normalize(obj.servers);
  }

  // { id1: entry1, id2: entry2, ... } — the multi-server shape that
  // lets `Install` create N servers at once. Preserve the user's key
  // names (sanitized at install time, not here).
  const keys = Object.keys(obj);
  if (!keys.length) return { ok: false, error: 'no entries found' };
  const entries = [];
  for (const key of keys) {
    const value = obj[key];
    if (looksLikeEntry(value)) entries.push({ id: key, entry: value });
  }
  if (entries.length) return { ok: true, entries };
  return { ok: false, error: 'no recognizable MCP entries' };
}

function looksLikeEntry(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (typeof v.command === 'string' && v.command) return true;
  if (typeof v.url === 'string' && v.url) return true;
  // `type: stdio` without a command is incomplete — we still report it
  // as an entry so the user sees a clear "command required" error at
  // install time rather than silently dropping it.
  if (typeof v.type === 'string' && /^(stdio|http|sse)$/.test(v.type)) return true;
  return false;
}

function sanitizeId(id) {
  return String(id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
}

// shapeEntry turns one normalized { id, entry } into the canonical
// add()-payload an adapter expects. Returns either { ok: true, payload }
// or { ok: false, error }.
function shapeEntry(id, entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'entry must be an object' };
  const cleanId = sanitizeId(id);
  const isRemote = !!(entry.url || entry.type === 'http' || entry.type === 'sse');
  if (isRemote) {
    if (!entry.url) return { ok: false, error: 'url required for remote MCP' };
    const payload = {
      id: cleanId,
      transport: entry.type === 'sse' ? 'sse' : 'http',
      url: String(entry.url),
    };
    if (entry.headers && typeof entry.headers === 'object' && Object.keys(entry.headers).length) {
      payload.headers = entry.headers;
    }
    return { ok: true, payload };
  }
  if (!entry.command) return { ok: false, error: 'command required for stdio MCP' };
  const payload = {
    id: cleanId,
    transport: 'stdio',
    command: String(entry.command),
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
  };
  if (entry.env && typeof entry.env === 'object' && Object.keys(entry.env).length) {
    payload.env = entry.env;
  }
  return { ok: true, payload };
}

module.exports = { parseLooseMcpJson, shapeEntry, sanitizeId };
