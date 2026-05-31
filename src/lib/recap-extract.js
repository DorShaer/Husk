'use strict';

// Extract the agent's spoken-summary line from rendered terminal rows.
//
// Reading the GRID (not the raw byte stream) is what keeps the recap clean. A
// full-screen agent (e.g. copilot in the alternate screen) streams its reply
// while redrawing the screen with cursor positioning, which interleaves UI
// chrome (status bar, spinner, prompt) into the byte stream. The rendered grid,
// by contrast, has each line cleanly on its own row, so the recap row is not
// contaminated by surrounding chrome.
//
// Patterns read:
//   🗣️ <Name>: <one-line summary>     (PAI NATIVE/MINIMAL trailing line)
//   * recap: <one-line summary>        (Claude Code recap)
//
// rows: array of { text, wrapped } in top-to-bottom order. `wrapped` marks a
// row that is xterm's soft-wrap continuation of the row above; it is joined
// back into one logical line before matching.

const SPEECH_BALLOON_RE = /\u{1F5E3}\u{FE0F}?\s*[^\r\n:]{0,40}?:\s*(.+)$/u;
const RECAP_RE = /^\s*\*\s+recap:\s*(.+)$/i;

function toLogicalLines(rows) {
  const out = [];
  for (const r of rows || []) {
    const text = r && typeof r.text === 'string' ? r.text : '';
    if (r && r.wrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  return out;
}

// Return the text of the last row that matches a recap pattern, or null. The
// last match wins because a scrolling transcript renders the newest reply at
// the bottom.
function extractRecap(rows) {
  const lines = toLogicalLines(rows);
  let found = null;
  for (const line of lines) {
    const m = line.match(SPEECH_BALLOON_RE) || line.match(RECAP_RE);
    if (m && m[1]) {
      const text = m[1].trim();
      if (text) found = text;
    }
  }
  return found;
}

module.exports = { extractRecap, toLogicalLines, SPEECH_BALLOON_RE, RECAP_RE };
