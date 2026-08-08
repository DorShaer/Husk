'use strict';

// Text on its way into a live agent's terminal.
//
// The far end is not a shell, it is an agent CLI's TUI. There a carriage return
// reads as Enter and an escape opens a control sequence, so a control byte in
// anything Husk writes to the PTY is not a rendering artefact: it is the
// ability to submit a turn the user never typed, to an agent already bound to
// their working directory.
//
// Both inputs this guards are chosen by somebody else. Agent output is whatever
// the model printed, and a workflow step's prompt can ask for any literal bytes.
// A file name is chosen by whoever wrote the repository or built the archive:
// POSIX permits every byte except "/" and NUL, so a carriage return in a name
// is legal and portable.

// C0, DEL and C1. Tab and newline are excluded by stripControls, which keeps
// them, and included here, because a path has no business carrying either.
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/;

// Everything except tab and newline, which are what make a pasted block
// readable. Removing the escape is what matters: with no escape there is no
// sequence, so an embedded bracketed-paste terminator becomes ordinary text
// instead of closing the wrapper early and letting the next newline submit.
const CONTROL_CHARS_KEEP_WS_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

function stripControls(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(CONTROL_CHARS_KEEP_WS_RE, '');
}

function hasControls(value) {
  return CONTROL_CHARS_RE.test(String(value === null || value === undefined ? '' : value));
}

// A path as it should appear in an agent prompt, or the empty string when it
// may not appear at all.
//
// A name carrying a control character is refused rather than repaired.
// Stripping would produce a path that no longer names the file, which is a
// different wrong answer, and quoting does not help because quotes are ordinary
// characters to a TUI while the control byte is still delivered.
function chatFileRef(filePath) {
  const p = String(filePath === null || filePath === undefined ? '' : filePath);
  if (!p || hasControls(p)) return '';
  return /\s/.test(p) ? `"${p}" ` : `${p} `;
}

module.exports = { stripControls, hasControls, chatFileRef, CONTROL_CHARS_RE };
