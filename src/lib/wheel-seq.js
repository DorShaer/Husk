'use strict';

// SGR (DECSET 1006) mouse-wheel encoding. Used to forward ONLY the wheel to a
// full-screen agent that enabled mouse reporting (e.g. copilot), so the wheel
// scrolls the agent's own transcript while drag-to-select stays local in the
// terminal (the agent's click/drag tracking is stripped before xterm sees it).
//
//   wheel up   -> button 64
//   wheel down -> button 65
// Press form: ESC [ < b ; col ; row M   (col/row are 1-based cell coords).

const ESC = '\x1b';

function wheelSequence(up, col, row) {
  const b = up ? 64 : 65;
  const c = Math.max(1, col | 0);
  const r = Math.max(1, row | 0);
  return `${ESC}[<${b};${c};${r}M`;
}

// How many wheel steps a DOM wheel event represents. deltaMode 1 means the
// delta is in lines; otherwise it is in pixels (~53px is the common per-notch
// unit). Clamped to [1,5] so a fast flick or trackpad burst cannot flood the
// agent with scroll input.
function wheelSteps(deltaY, deltaMode) {
  const d = Math.abs(deltaY || 0);
  if (!d) return 0;
  const raw = deltaMode === 1 ? d : d / 53;
  return Math.max(1, Math.min(5, Math.round(raw)));
}

module.exports = { wheelSequence, wheelSteps };
