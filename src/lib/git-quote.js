'use strict';

// Decode the C-style quoting git uses for paths with special characters, shared
// by every git-output parser. git wraps such a path in double quotes and
// escapes its bytes: single-character escapes (\n \t \\ ...) and octal \NNN.

const ESCAPE_BYTES = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '\\': 0x5c,
  '"': 0x22,
};

// decodeQuoted takes a value INCLUDING its surrounding quotes and returns the
// real path. Callers that are not sure a value is quoted use unquote instead.
function decodeQuoted(raw) {
  const inner = raw.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) break; // a lone trailing backslash: stop, do not throw
    if (next >= '0' && next <= '7') {
      let oct = next;
      let j = i + 2;
      while (j < inner.length && oct.length < 3 && inner[j] >= '0' && inner[j] <= '7') {
        oct += inner[j];
        j++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(ESCAPE_BYTES, next)) {
      bytes.push(ESCAPE_BYTES[next]);
      i++;
      continue;
    }
    // Unknown escape: keep the following character literally.
    for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

// unquote decodes a value only when it is actually quoted, and answers '' for a
// non-string so a malformed field never throws.
function unquote(raw) {
  if (typeof raw !== 'string') return '';
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  return decodeQuoted(raw);
}

module.exports = { unquote, decodeQuoted };
