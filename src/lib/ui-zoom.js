'use strict';

// Husk's UI zoom, in Chromium zoom levels (scale factor = 1.2 ^ level).
//
// BASE_ZOOM is what the zoom readout calls "100%" and what Ctrl/Cmd+0 returns
// to. The desktop's own scale (GNOME 125%, Windows 150%, Retina) reaches the
// renderer separately as devicePixelRatio, so this only sets Husk's size
// relative to other apps at the same setting.
//
// The user's own zoom (Ctrl/Cmd +/-, View menu) is saved in config as `uiZoom`
// and restored at the next launch. null means "use the base".

const BASE_ZOOM = 0.5;
const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;

// A stored level, or null when it is missing or not a usable number. Values
// are snapped to the step grid and clamped, so a hand-edited config cannot
// mount the window at an unreadable size.
function sanitizeZoom(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const snapped = Math.round(value / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, snapped));
}

// The level to mount at: the saved one when valid, else the base.
function startZoom(saved) {
  const s = sanitizeZoom(saved);
  return s === null ? BASE_ZOOM : s;
}

// One step in or out from `current`, clamped to the allowed range.
function stepZoom(current, dir) {
  const cur = sanitizeZoom(current);
  const from = cur === null ? BASE_ZOOM : cur;
  return sanitizeZoom(from + (dir < 0 ? -ZOOM_STEP : ZOOM_STEP));
}

// What to store for a level: null when it equals the base, so a later change
// to the default still reaches users who never zoomed away from it.
function zoomToStore(level) {
  const s = sanitizeZoom(level);
  if (s === null || s === BASE_ZOOM) return null;
  return s;
}

module.exports = { BASE_ZOOM, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, sanitizeZoom, startZoom, stepZoom, zoomToStore };
