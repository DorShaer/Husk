'use strict';

// Guards for text written into an agent's PTY.

const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/;
const CONTROL_CHARS_KEEP_WS_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

// Removes control characters, keeping tab and newline.
function stripControls(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(CONTROL_CHARS_KEEP_WS_RE, '');
}

// True when the value contains any control character.
function hasControls(value) {
  return CONTROL_CHARS_RE.test(String(value === null || value === undefined ? '' : value));
}

// Formats a path for an agent prompt, quoting it when it contains whitespace.
// Returns '' for an empty path or one containing control characters.
function chatFileRef(filePath) {
  const p = String(filePath === null || filePath === undefined ? '' : filePath);
  if (!p || hasControls(p)) return '';
  return /\s/.test(p) ? `"${p}" ` : `${p} `;
}

module.exports = { stripControls, hasControls, chatFileRef, CONTROL_CHARS_RE };
