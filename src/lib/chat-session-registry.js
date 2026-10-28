'use strict';

// The claude sessions Husk itself opened in Chat view. Husk drives claude over
// its stream protocol, and the CLI records every turn of such a session as
// programmatic (promptSource "sdk", entrypoint "sdk-cli"), the same marks a
// framework hook's `claude --print` run or an orchestrator leaves. The Sessions
// list hides those runs, and without this record it hid the user's own chats
// with them: a chat typed in Husk vanished from the list the moment the app
// was restarted. Husk picks the session id before the child starts, so it can
// write the id down here and the list can tell its chats from the look-alikes.
//
// One JSON array of ids in the config directory, newest last, capped. Reads
// and writes never throw: a missing or torn file is an empty record.

const { SESSION_ID: ID } = require('./chat-transport');

function createChatSessionRegistry({ file, fs, seed = () => [], cap = 5000 } = {}) {
  // ids keeps insertion order for the cap and the on-disk form; idSet answers
  // has() in O(1), which matters because the Sessions list calls has() once per
  // candidate transcript (up to 300) on every listing.
  let ids = null;
  let idSet = null;
  let seedSet = null;

  function load() {
    if (ids) return ids;
    ids = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === 'string' && ID.test(x));
    } catch (_) { /* first run, or unreadable: start empty */ }
    idSet = new Set(ids);
    return ids;
  }

  // The ids recorded elsewhere before this file existed, materialized once
  // rather than rebuilt on every miss.
  function seeds() {
    if (seedSet) return seedSet;
    try { seedSet = new Set((seed() || []).map((x) => String(x || ''))); }
    catch (_) { seedSet = new Set(); }
    return seedSet;
  }

  function save() {
    try { fs.writeFileSync(file, JSON.stringify(ids), { mode: 0o600 }); } catch (_) {}
  }

  // Whether a session is one of Husk's chats.
  function has(id) {
    const s = String(id || '');
    if (!s) return false;
    load();
    return idSet.has(s) || seeds().has(s);
  }

  function add(id) {
    const s = String(id || '').trim();
    if (!ID.test(s)) return false;
    const list = load();
    if (idSet.has(s)) return false;
    list.push(s);
    idSet.add(s);
    while (list.length > cap) idSet.delete(list.shift());
    save();
    return true;
  }

  // The session line claude answers with when a resumed chat starts, which Husk
  // did not pick itself. Takes one event or a batch; the per-event streaming
  // path inlines the single-event check at its caller rather than going
  // through here.
  function addFromEvents(events) {
    for (const e of Array.isArray(events) ? events : [events]) {
      if (e && e.type === 'session' && e.sessionId) add(e.sessionId);
    }
  }

  return { has, add, addFromEvents, size: () => load().length };
}

module.exports = { createChatSessionRegistry };
