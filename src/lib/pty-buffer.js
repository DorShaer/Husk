'use strict';

// A PTY burst can outrun the flush that drains it, so every buffer holding one
// carries a ceiling. Trimming keeps the newest output, which is the part a
// reader wants, and resumes at a line boundary so an escape sequence never
// reaches the terminal cut in half. The retained tail is prefixed with a reset
// so attributes set by dropped bytes do not colour it, and with a notice, so a
// gap in the output is always visible as one.
const PTY_BUFFER_MAX = 4 * 1024 * 1024;

function capPtyBuffer(buf, max) {
  const limit = typeof max === 'number' ? max : PTY_BUFFER_MAX;
  const s = buf === null || buf === undefined ? '' : String(buf);
  if (!(limit > 0) || s.length <= limit) return s;
  const tail = s.slice(-limit);
  const nl = tail.indexOf('\n');
  const body = nl === -1 ? tail : tail.slice(nl + 1);
  const dropped = s.length - body.length;
  return `\x1b[0m\r\n[husk] ${dropped} characters of output trimmed\r\n${body}`;
}

module.exports = { capPtyBuffer, PTY_BUFFER_MAX };
