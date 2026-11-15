'use strict';

// Durable chat transcripts: the normalized chat events of each chat, one JSON
// line per event, in <dir>/<id>.jsonl. Every CLI gets one, whether or not it
// keeps a session file of its own. Files are private to the user, bounded in
// size, and pruned by age.

const path = require('node:path');
const crypto = require('node:crypto');
const { readBoundedFile } = require('./bounded-file');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const OUTPUT_KEEP = 2000;
// State events repeat often and carry nothing a transcript reader needs.
const SKIP = new Set(['session', 'commands', 'usage', 'billing', 'mode', 'title', 'allow_all', 'thought', 'turn_start']);

function validId(id) { return typeof id === 'string' && ID_RE.test(id); }

// The id a chat's transcript is filed under: the CLI and its session id.
function transcriptId(agent, sessionId) {
  const clean = (v) => String(v || '').replace(/[^A-Za-z0-9._-]/g, '_');
  const id = `${clean(agent) || 'agent'}-${clean(sessionId)}`.slice(0, 150);
  return validId(id) ? id : null;
}

function slim(ev) {
  if (ev.type !== 'tool') return ev;
  const out = Object.assign({}, ev);
  if (typeof out.output === 'string' && out.output.length > OUTPUT_KEEP) out.output = out.output.slice(0, OUTPUT_KEEP);
  if (out.input !== undefined) {
    let size = 0;
    try { size = JSON.stringify(out.input).length; } catch (_) { size = OUTPUT_KEEP + 1; }
    if (size > OUTPUT_KEEP) delete out.input;
  }
  if (Array.isArray(out.diffs)) out.diffs = out.diffs.map((d) => ({ path: String((d && d.path) || '') }));
  return out;
}

// Removes files in dir last written more than `days` ago. Zero or less keeps
// everything. Returns how many were removed.
function pruneDir(fs, dir, days, now) {
  const limit = Number(days);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const cutoff = (typeof now === 'number' ? now : Date.now()) - limit * 864e5;
  let names = [];
  try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return 0; names = fs.readdirSync(dir); } catch (_) { return 0; }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      fs.unlinkSync(file);
      removed += 1;
    } catch (_) {}
  }
  return removed;
}

// Creates dir (0700) if needed and writes one private file (0600) in it.
function privateDir(fs, dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Expected a private directory');
  fs.chmodSync(dir, 0o700);
}

function writePrivate(fs, dir, name, text) {
  if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('Invalid private file name');
  privateDir(fs, dir);
  const file = path.join(dir, name);
  const temp = path.join(dir, '.' + crypto.randomUUID());
  try {
    fs.writeFileSync(temp, String(text), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch (_) {} }
  return file;
}

function createTranscriptStore({ dir, fs, maxBytes } = {}) {
  if (!dir || !fs) throw new TypeError('dir and fs are required');
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_BYTES;
  // Streamed text arrives in small chunks; one line per run of text is kept.
  const open = new Map();
  let ready = false;

  const fileOf = (id) => path.join(dir, id + '.jsonl');

  function ensureDir() {
    if (ready) return;
    privateDir(fs, dir);
    ready = true;
  }

  function write(id, events) {
    if (!events.length) return;
    ensureDir();
    const bounded = events.map((e) => {
      const json = JSON.stringify(e);
      if (Buffer.byteLength(json) <= cap / 2) return e;
      return { type: e.type === 'user' ? 'user' : 'text', text: String(e.text || '[Message omitted]').slice(-Math.max(1, Math.floor(cap / 16))) };
    });
    const data = bounded.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const file = fileOf(id);
    let before = null;
    try { before = fs.lstatSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error('Expected a regular transcript');
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0)
      | (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
    const fd = fs.openSync(file, flags, 0o600);
    let size = 0;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || (before && (before.ino !== st.ino || before.dev !== st.dev))) throw new Error('The transcript changed while opening it');
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, data);
      size = fs.fstatSync(fd).size;
    } finally { fs.closeSync(fd); }
    if (size > cap) trim(id);
  }

  // Keeps the newest lines that fit in half the cap.
  function trim(id) {
    const lines = readBoundedFile(fileOf(id), cap * 2, fs).toString('utf8').split('\n').filter(Boolean);
    const keep = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      bytes += Buffer.byteLength(lines[i]) + 1;
      if (bytes > cap / 2 && keep.length) break;
      keep.unshift(lines[i]);
    }
    const head = JSON.stringify({ type: 'status', text: 'Earlier messages in this chat are not kept.' });
    writePrivate(fs, dir, id + '.jsonl', [head].concat(keep).join('\n') + '\n');
  }

  function flush(id) {
    const pending = open.get(id);
    if (!pending) return;
    open.delete(id);
    try { write(id, [pending]); } catch (_) {}
  }

  function append(id, ev) {
    if (!validId(id) || !ev || typeof ev !== 'object' || SKIP.has(ev.type)) return false;
    const pending = open.get(id);
    if (ev.type === 'text') {
      if (pending) {
        pending.text += String(ev.text || '');
        if (pending.text.length > cap / 8) flush(id);
        return true;
      }
      open.set(id, Object.assign({ type: 'text', text: String(ev.text || '') }, ev.at === undefined ? {} : { at: ev.at }));
      return true;
    }
    // The full message replaces the chunks streamed ahead of it.
    if (ev.type === 'text_final') open.delete(id);
    else flush(id);
    try { write(id, [slim(ev)]); return true; } catch (_) { return false; }
  }

  function read(id) {
    if (!validId(id)) return [];
    flush(id);
    let raw = '';
    try { raw = readBoundedFile(fileOf(id), cap, fs).toString('utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const ev = JSON.parse(line); if (ev && typeof ev === 'object') out.push(ev); } catch (_) {}
    }
    return out;
  }

  function has(id) {
    if (!validId(id)) return false;
    if (open.has(id)) return true;
    try { const st = fs.lstatSync(fileOf(id)); return st.isFile() && !st.isSymbolicLink() && st.size > 0; } catch (_) { return false; }
  }

  function flushAll() { for (const id of open.keys()) flush(id); }

  function prune(days, now) {
    return pruneDir(fs, dir, days, now);
  }

  return { append, flush, flushAll, read, has, prune, fileOf };
}

module.exports = { createTranscriptStore, transcriptId, pruneDir, writePrivate, MAX_BYTES };
