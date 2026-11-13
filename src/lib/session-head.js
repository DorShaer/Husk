'use strict';

const { withoutContext } = require('./brain');

// The session scan reads only the start of a transcript for its title. A chat
// whose first line is huge (a long pasted prompt, hook output) has no user
// message inside that window, so it was listed without a name. This reads on
// through the file for the first thing the person typed.
const DEEP_MAX_BYTES = 8 * 1024 * 1024;
const cache = new Map();

function deepFirstUserMessage(fs, fullPath, size, { skip } = {}) {
  if (!size || size > DEEP_MAX_BYTES) return '';
  const key = `${fullPath}:${size}`;
  if (cache.has(key)) return cache.get(key);
  let found = '';
  try {
    for (const line of fs.readFileSync(fullPath, 'utf8').split('\n')) {
      if (!line.includes('"user"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (!obj || obj.type !== 'user' || !obj.message) continue;
      const c = obj.message.content;
      let text = '';
      if (typeof c === 'string') text = c.trim();
      else if (Array.isArray(c)) { const t = c.find((p) => p && p.type === 'text' && typeof p.text === 'string'); if (t) text = t.text.trim(); }
      if (!text || (skip && skip(text))) continue;
      text = withoutContext(text).trim();
      if (text) { found = text; break; }
    }
  } catch (_) { found = ''; }
  if (cache.size > 500) cache.clear();
  cache.set(key, found);
  return found;
}

module.exports = { deepFirstUserMessage };
