'use strict';

const { ADAPTERS } = require('./index');
const { agentKey } = require('./common');

const WRITE_TARGETS = Object.freeze(['claude', 'copilot', 'gemini']);

function writeAdapters() {
  return WRITE_TARGETS
    .map((key) => [key, ADAPTERS[key]])
    .filter(([, adapter]) => adapter && adapter.supportsWrite);
}

function payloadFromServer(server) {
  if (!server || !server.id) return null;
  if (server.transport === 'http' || server.transport === 'sse' || server.url) {
    const payload = {
      id: server.id,
      transport: server.transport === 'sse' ? 'sse' : 'http',
      url: server.url || '',
    };
    if (server.headers && Object.keys(server.headers).length) payload.headers = server.headers;
    return payload;
  }
  const payload = {
    id: server.id,
    transport: 'stdio',
    command: server.command || '',
    args: Array.isArray(server.args) ? server.args : [],
  };
  if (server.env && Object.keys(server.env).length) payload.env = server.env;
  return payload;
}

function findServer(adapter, id) {
  try {
    const r = adapter.list();
    const servers = r && Array.isArray(r.servers) ? r.servers : [];
    return servers.find((s) => s && s.id === id) || null;
  } catch (_) {
    return null;
  }
}

function setEnabled(adapter, id, enabled) {
  const cur = findServer(adapter, id);
  if (!cur) return { ok: false, error: `MCP server "${id}" not found` };
  if (!!cur.enabled === !!enabled) return { ok: true, changed: false };
  return adapter.toggle(id);
}

// Writes one server. oldId marks an edit; without it, an id that already
// exists is a collision and is refused rather than replaced.
function addOrUpdate(adapter, oldId, payload, enabled) {
  const id = payload && payload.id;
  if (!id) return { ok: false, error: 'missing id' };
  const existingOld = oldId ? findServer(adapter, oldId) : null;
  const existingNew = findServer(adapter, id);
  let r;
  if (existingOld) {
    if (typeof adapter.update !== 'function') return { ok: false, error: 'update not supported' };
    r = adapter.update(oldId, { ...payload, newId: id });
  } else if (existingNew) {
    if (!oldId) {
      return { ok: false, collision: true, error: `MCP server "${id}" already exists. Rename it, or edit the existing one.` };
    }
    if (typeof adapter.update !== 'function') return { ok: false, error: 'update not supported' };
    r = adapter.update(id, { ...payload, newId: id });
  } else {
    r = adapter.add(payload);
  }
  if (!r || !r.ok) return r || { ok: false, error: 'write failed' };
  return setEnabled(adapter, id, enabled !== false);
}

function collectServers(activeAgentCommand) {
  const active = agentKey(activeAgentCommand);
  const priority = [active, ...WRITE_TARGETS.filter((key) => key !== active)];
  const byId = new Map();
  const lists = {};
  const errors = [];

  for (const [key, adapter] of writeAdapters()) {
    let result;
    try { result = adapter.list(); } catch (err) {
      errors.push({ target: key, error: (err && err.message) || String(err) });
      result = { ok: false, servers: [] };
    }
    const servers = result && Array.isArray(result.servers) ? result.servers : [];
    lists[key] = servers;
    for (const server of servers) {
      if (!server || !server.id) continue;
      const entry = byId.get(server.id) || { id: server.id, variants: {} };
      entry.variants[key] = server;
      byId.set(server.id, entry);
    }
  }

  const canonical = [];
  for (const entry of byId.values()) {
    const source = priority.find((key) => entry.variants[key]) || Object.keys(entry.variants)[0];
    canonical.push({ ...entry.variants[source], source, targets: Object.keys(entry.variants).sort() });
  }
  canonical.sort((a, b) => a.id.localeCompare(b.id));
  return { active, servers: canonical, lists, errors };
}

function backfillMissing(servers) {
  const results = {};
  for (const server of servers || []) {
    const payload = payloadFromServer(server);
    if (!payload) continue;
    results[server.id] = {};
    for (const [key, adapter] of writeAdapters()) {
      if (findServer(adapter, server.id)) {
        results[server.id][key] = { status: 'exists' };
        continue;
      }
      const r = adapter.add(payload);
      if (r && r.ok) {
        const en = setEnabled(adapter, server.id, server.enabled !== false);
        results[server.id][key] = en && en.ok
          ? { status: 'installed' }
          : { status: 'error', error: (en && en.error) || 'enable state failed' };
      } else {
        results[server.id][key] = { status: 'error', error: (r && r.error) || 'install failed' };
      }
    }
  }
  return results;
}

function list(activeAgentCommand, opts = {}) {
  const collected = collectServers(activeAgentCommand);
  const sync = opts.sync === false ? {} : backfillMissing(collected.servers);
  return {
    ok: true,
    agent: agentKey(activeAgentCommand),
    shared: true,
    targets: WRITE_TARGETS.slice(),
    servers: collected.servers,
    sync,
    errors: collected.errors,
  };
}

function add(payload = {}) {
  const id = payload && payload.id;
  const results = {};
  let failures = 0;
  let collided = false;
  for (const [key, adapter] of writeAdapters()) {
    const r = addOrUpdate(adapter, null, payload, true);
    if (r && r.ok) results[key] = { status: 'installed', configPath: adapter.configPath };
    else {
      failures++;
      if (r && r.collision) collided = true;
      results[key] = { status: 'error', error: (r && r.error) || 'install failed', configPath: adapter.configPath };
    }
  }
  if (!failures) return { ok: true, id, results };
  const error = collided
    ? `MCP server "${id || ''}" already exists. Rename it, or edit the existing one.`
    : `MCP server "${id || ''}" could not be installed for ${failures} target${failures === 1 ? '' : 's'}`;
  return { ok: false, id, results, collision: collided, error };
}

function update(oldId, payload = {}) {
  const desiredId = payload && payload.newId ? payload.newId : (payload && payload.id) || oldId;
  const existing = collectServers().servers.find((s) => s.id === oldId || s.id === desiredId);
  const enabled = existing ? existing.enabled !== false : true;
  const nextPayload = { ...payload, id: desiredId };
  const results = {};
  let failures = 0;
  for (const [key, adapter] of writeAdapters()) {
    const r = addOrUpdate(adapter, oldId, nextPayload, enabled);
    if (r && r.ok) results[key] = { status: 'updated', configPath: adapter.configPath };
    else { failures++; results[key] = { status: 'error', error: (r && r.error) || 'update failed', configPath: adapter.configPath }; }
  }
  return failures
    ? { ok: false, id: desiredId, results, error: `MCP server "${oldId}" could not be updated for ${failures} target${failures === 1 ? '' : 's'}` }
    : { ok: true, id: desiredId, results };
}

function remove(id) {
  const results = {};
  let failures = 0;
  for (const [key, adapter] of writeAdapters()) {
    const r = adapter.remove(id);
    if (r && r.ok) results[key] = { status: 'removed', configPath: adapter.configPath };
    else { failures++; results[key] = { status: 'error', error: (r && r.error) || 'remove failed', configPath: adapter.configPath }; }
  }
  return failures
    ? { ok: false, id, results, error: `MCP server "${id}" could not be removed for ${failures} target${failures === 1 ? '' : 's'}` }
    : { ok: true, id, results };
}

function toggle(id, activeAgentCommand) {
  const collected = collectServers(activeAgentCommand);
  const server = collected.servers.find((s) => s.id === id);
  if (!server) return { ok: false, error: `MCP server "${id}" not found` };
  const desired = !(server.enabled !== false);
  const payload = payloadFromServer(server);
  const results = {};
  let failures = 0;
  for (const [key, adapter] of writeAdapters()) {
    const cur = findServer(adapter, id);
    if (!cur && payload) {
      const addRes = adapter.add(payload);
      if (!addRes || !addRes.ok) {
        failures++;
        results[key] = { status: 'error', error: (addRes && addRes.error) || 'install failed', configPath: adapter.configPath };
        continue;
      }
    }
    const r = setEnabled(adapter, id, desired);
    if (r && r.ok) results[key] = { status: desired ? 'enabled' : 'disabled', configPath: adapter.configPath };
    else { failures++; results[key] = { status: 'error', error: (r && r.error) || 'toggle failed', configPath: adapter.configPath }; }
  }
  return failures
    ? { ok: false, id, enabled: desired, results, error: `MCP server "${id}" could not be toggled for ${failures} target${failures === 1 ? '' : 's'}` }
    : { ok: true, id, enabled: desired, results };
}

function addMany(items = []) {
  const results = {};
  let installed = 0;
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.id) {
      results[item && item.id ? item.id : '_anon_'] = { status: 'error', error: 'missing id' };
      continue;
    }
    const r = add(item);
    if (r.ok) { results[item.id] = { status: 'installed', targets: r.results }; installed++; }
    else results[item.id] = { status: 'error', error: r.error, targets: r.results };
  }
  return { ok: true, results, installed, total: Array.isArray(items) ? items.length : 0 };
}

module.exports = {
  WRITE_TARGETS,
  list,
  add,
  update,
  remove,
  toggle,
  addMany,
  collectServers,
  payloadFromServer,
};
