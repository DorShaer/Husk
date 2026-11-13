'use strict';

// A session's "last activity" is the timestamp of its last real conversation
// turn (a user or assistant message). Opening or resuming a session appends
// non-turn lines (api-request, session-owner, framework hooks) carrying a
// current timestamp; those must not count, or merely viewing a yesterday chat
// would bump it to "now" and jump it to the top of the list.
//
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
    // Cheap prefilter: only a user/assistant turn carries activity, and parsing
    // every line of a large transcript is the expensive part.
    if (line.indexOf('"timestamp"') === -1) continue;
    if (!/"type":"(user|assistant)"/.test(line)) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (o && (o.type === 'user' || o.type === 'assistant') && typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp);
      if (isFinite(t)) ms = t;
    }
  }
  return { ms, consumed: Buffer.byteLength(s.slice(0, nl + 1), 'utf8') };
}

module.exports = { lastTurnMs };
