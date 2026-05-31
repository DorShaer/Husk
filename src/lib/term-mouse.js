'use strict';

// Neutralize a TUI's mouse-tracking modes so the embedded terminal stays
// locally selectable: select-and-copy works, and the agent does not receive
// mouse drags/clicks. Some agents (e.g. copilot) enable mouse reporting,
// which otherwise sends every drag and click to the agent. That breaks
// copy (the selection goes to the app instead of xterm) and makes the agent
// redraw on mouse activity (which can re-trigger the recap voice).
//
// Only the mouse DECSET sequences are stripped. Alt-screen (1049), focus
// reporting (1004), bracketed paste (2004), cursor visibility, line wrap,
// etc. are left intact so the TUI still renders correctly.
//
// Returns a stateful stripper with a carry buffer, so a mode sequence that
// is split across two PTY chunks is still removed.

// ESC [ ? <num> (h|l) for the mouse-tracking modes only.
// eslint-disable-next-line no-control-regex
const MOUSE_MODE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015|1016)[hl]/g;
// The reporting-enable modes (1000 normal, 1002 button-event, 1003 any-event);
// 1005/1006/1015/1016 are only encodings. An 'h' on any of these means the app
// wants mouse reporting on, an 'l' turns it off. Tracked so the renderer can
// forward the wheel to the app while still stripping the reporting from xterm.
// eslint-disable-next-line no-control-regex
const MOUSE_TRACK_RE = /\x1b\[\?(?:1000|1002|1003)([hl])/g;
// An incomplete CSI at the very end of a chunk: ESC [ then digits/;/? with no
// final byte yet. Held back so a split sequence is reassembled next chunk.
// eslint-disable-next-line no-control-regex
const INCOMPLETE_CSI_TAIL = /\x1b\[[\d;?]*$/;
const MAX_CARRY = 32;

function createMouseModeStripper() {
  let carry = '';
  let mouseOn = false;
  return {
    strip(data) {
      let s = carry + (data == null ? '' : String(data));
      carry = '';
      const m = s.match(INCOMPLETE_CSI_TAIL);
      if (m && m[0].length <= MAX_CARRY) {
        carry = m[0];
        s = s.slice(0, s.length - m[0].length);
      }
      // Track the latest mouse-reporting toggle in this chunk before stripping.
      let tm;
      MOUSE_TRACK_RE.lastIndex = 0;
      while ((tm = MOUSE_TRACK_RE.exec(s)) !== null) mouseOn = tm[1] === 'h';
      return s.replace(MOUSE_MODE_RE, '');
    },
    isMouseOn() { return mouseOn; },
    reset() { carry = ''; mouseOn = false; },
  };
}

module.exports = { createMouseModeStripper, MOUSE_MODE_RE };
