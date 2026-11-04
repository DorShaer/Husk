'use strict';

// Strip terminal escape sequences so token/sentinel/JSON scans see rendered
// text, not cursor movement and color commands. Covers CSI (colour/cursor),
// OSC terminated by BEL or ST, and charset-designation escapes.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '');
}

module.exports = { stripAnsi };
