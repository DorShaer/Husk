'use strict';

// A session's "last activity" is the timestamp of its last real conversation
// turn (a user or assistant message). Opening or resuming a session appends
// non-turn lines (api-request, session-owner, framework hooks) carrying a
// current timestamp; those must not count, or merely viewing a yesterday chat
// would bump it to "now" and jump it to the top of the list.

// The turn time one transcript line carries, or null when it is not a turn.
function turnLineMs(line) {
  // Cheap prefilter: parsing every line of a large transcript is the expensive part.
  if (!/"type":"(user|assistant)"/.test(line)) return null;
  let o;
  try { o = JSON.parse(line); } catch (_) { return null; }
  if (!o || (o.type !== 'user' && o.type !== 'assistant') || typeof o.timestamp !== 'string') return null;
  const t = Date.parse(o.timestamp);
  return isFinite(t) ? t : null;
}

// lastTurnMs scans a chunk of transcript text and returns the last turn
// timestamp it finds (in ms) plus how many whole-line bytes it consumed, so a
// caller can scan a growing file forward without rereading it. seed carries the
// value from an earlier chunk. A trailing partial line is left unconsumed.
function lastTurnMs(text, seed) {
  let ms = typeof seed === 'number' ? seed : null;
  const s = String(text || '');
  const nl = s.lastIndexOf('\n');
  if (nl < 0) return { ms, consumed: 0 };
  for (const line of s.slice(0, nl).split('\n')) {
    if (line.indexOf('"timestamp"') === -1) continue;
    const t = turnLineMs(line);
    if (t !== null) ms = t;
  }
  return { ms, consumed: Buffer.byteLength(s.slice(0, nl + 1), 'utf8') };
}

const CHUNK = 1024 * 1024;

// Newest-first search over the complete lines of an open file that contain
// marker, from byte offset `from` (a line start) to the end. Returns the first
// non-null pick(line) as value, and end, the offset just past the last newline,
// which is where a later search of the same growing file can start.
function* lastLineMatchSteps(fs, fd, size, marker, pick, from = 0, chunk = CHUNK) {
  const needle = Buffer.from(marker);
  let hi = size;
  let carry = null;
  let end = null;
  while (hi > from) {
    const lo = Math.max(from, hi - chunk);
    const part = Buffer.alloc(hi - lo);
    const got = fs.readSync(fd, part, 0, part.length, lo);
    const buf = carry ? Buffer.concat([part.subarray(0, got), carry]) : part.subarray(0, got);
    let stop = buf.length;
    if (end === null) {
      // A trailing line without its newline is still being written.
      const nl = buf.lastIndexOf(10);
      if (nl < 0) {
        if (lo === from) return { value: null, end: from };
        carry = buf; hi = lo; yield; continue;
      }
      stop = nl + 1;
      end = lo + stop;
    }
    const cut = lo === from ? 0 : buf.indexOf(10) + 1;
    if (cut === 0 && lo > from) { carry = buf; hi = lo; yield; continue; }
    let at = stop;
    while (at - needle.length >= cut) {
      const hit = buf.lastIndexOf(needle, at - needle.length);
      if (hit < cut) break;
      const s = buf.lastIndexOf(10, hit) + 1;
      let e = buf.indexOf(10, hit);
      if (e < 0 || e > stop) e = stop;
      const v = pick(buf.toString('utf8', s, e));
      if (v !== null && v !== undefined) return { value: v, end };
      at = s;
    }
    carry = buf.subarray(0, cut);
    yield;
    hi = lo;
  }
  return { value: null, end: end === null ? from : end };
}

// The same search run to completion.
function lastLineMatch(...args) {
  const it = lastLineMatchSteps(...args);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

module.exports = { lastTurnMs, turnLineMs, lastLineMatch, lastLineMatchSteps };
