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

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,}$/;

function createChatSessionRegistry({ file, fs, seed = () => [], cap = 5000 } = {}) {
  let ids = null;

  function load() {
    if (ids) return ids;
    ids = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === 'string' && ID.test(x));
    } catch (_) { /* first run, or unreadable: start empty */ }
    return ids;
  }

  function save() {
    try { fs.writeFileSync(file, JSON.stringify(ids), { mode: 0o600 }); } catch (_) {}
  }

  // Whether a session is one of Husk's chats. The seed covers ids recorded
  // elsewhere before this file existed.
  function has(id) {
    const s = String(id || '');
    if (!s) return false;
    if (load().includes(s)) return true;
    try { return (seed() || []).some((x) => String(x || '') === s); } catch (_) { return false; }
  }

  function add(id) {
    const s = String(id || '').trim();
    if (!ID.test(s)) return false;
    const list = load();
    if (list.includes(s)) return false;
    list.push(s);
    if (list.length > cap) list.splice(0, list.length - cap);
    save();
    return true;
  }

  // Ids carried by a batch of chat events: the session line claude answers
  // with when a resumed chat starts, which Husk did not pick itself.
  function addFromEvents(events) {
    for (const e of Array.isArray(events) ? events : [events]) {
      if (e && e.type === 'session' && e.sessionId) add(e.sessionId);
    }
  }

  return { has, add, addFromEvents, size: () => load().length };
}

module.exports = { createChatSessionRegistry };
