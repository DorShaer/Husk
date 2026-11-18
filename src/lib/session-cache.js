'use strict';

// Per-file facts the session list derives from transcripts (title, last turn,
// how the chat opened), kept on disk so a launch does not reread every
// transcript. An entry holds while its file's size and mtime hold.

const nodeFs = require('node:fs');
const path = require('node:path');

const VERSION = 2;

// carry: fields an entry keeps when its file only grew, for scans that resume.
function createFileFactsCache({ file, max = 10000, carry = [], fs = nodeFs } = {}) {
  const map = new Map();
  let loaded = false;
  let dirty = false;

  function adopt(text) {
    let o = null;
    try { o = JSON.parse(text); } catch (_) { return; }
    if (!o || o.v !== VERSION || !o.entries || typeof o.entries !== 'object') return;
    for (const [k, v] of Object.entries(o.entries)) {
      if (map.size >= max) break;
      if (v && typeof v === 'object' && typeof v.sig === 'string' && !map.has(k)) map.set(k, v);
    }
  }

  async function load() {
    if (loaded) return;
    loaded = true;
    let text = '';
    try { text = await fs.promises.readFile(file, 'utf8'); } catch (_) { return; }
    adopt(text);
  }

  function loadSync() {
    if (loaded) return;
    loaded = true;
    try { adopt(fs.readFileSync(file, 'utf8')); } catch (_) {}
  }

  // The entry for one file version. A changed file gets a fresh entry.
  function reads(key, st) {
    const sig = `${st.size}:${st.mtimeMs}`;
    const old = map.get(key);
    if (old && old.sig === sig) return old;
    const v = { sig, size: st.size };
    if (old && st.size >= (old.size || 0)) for (const f of carry) if (old[f] !== undefined) v[f] = old[f];
    map.delete(key);
    map.set(key, v);
    if (map.size > max) map.delete(map.keys().next().value);
    dirty = true;
    return v;
  }

  // Fills one field of an entry once.
  function fill(entry, field, compute) {
    if (entry[field] === undefined) { entry[field] = compute(); dirty = true; }
    return entry[field];
  }

  async function save() {
    if (!dirty) return false;
    dirty = false;
    for (const k of [...map.keys()]) if (!fs.existsSync(k)) map.delete(k);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(tmp, JSON.stringify({ v: VERSION, entries: Object.fromEntries(map) }), { mode: 0o600 });
      await fs.promises.rename(tmp, file);
      return true;
    } catch (_) {
      try { await fs.promises.unlink(tmp); } catch (_e) {}
      return false;
    }
  }

  return { load, loadSync, reads, fill, touch: () => { dirty = true; }, save, size: () => map.size };
}

module.exports = { createFileFactsCache };
