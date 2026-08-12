'use strict';

// Decides which statusline script the app may run, pinned by path and content.

const REFUSE_CHANGED = 'changed';
const REFUSE_APPEARED = 'appeared';
const REFUSE_MALFORMED = 'malformed';

// A pin is null, or { path, sha256 } with each field a string or null.
function wellFormed(pin) {
  if (pin === null || pin === undefined) return true;
  if (typeof pin !== 'object' || Array.isArray(pin)) return false;
  const pathOk = pin.path === null || typeof pin.path === 'string';
  const shaOk = pin.sha256 === null || typeof pin.sha256 === 'string';
  return pathOk && shaOk;
}

// candidates  absolute paths, most preferred first
// pin         the stored pin, or null when nothing is recorded yet
// readDigest  (absolutePath) => sha256 hex, or null when not a regular file
//
// Returns { run, pin, reason }: the path to run or null, a pin to persist or
// null to keep the stored one, and the refusal reason when nothing runs.
//
// With no pin, the first script found is recorded and run. With a pin, the
// script runs only when its path and digest both match.
function decide(candidates, pin, readDigest) {
  if (!wellFormed(pin)) return { run: null, pin: null, reason: REFUSE_MALFORMED };
  const list = Array.isArray(candidates) ? candidates.filter((p) => typeof p === 'string' && p) : [];
  const stored = (pin === null || pin === undefined) ? null : pin;

  let found = null;
  let digest = null;
  for (const candidate of list) {
    let d = null;
    try { d = readDigest(candidate); } catch (_) { d = null; }
    if (d) { found = candidate; digest = d; break; }
  }

  if (!found) {
    if (!stored) return { run: null, pin: { path: null, sha256: null }, reason: null };
    return { run: null, pin: null, reason: null };
  }

  if (!stored) return { run: found, pin: { path: found, sha256: digest }, reason: null };

  if (stored.path === null) return { run: null, pin: null, reason: REFUSE_APPEARED };
  if (stored.path === found && stored.sha256 === digest) return { run: found, pin: null, reason: null };
  return { run: null, pin: null, reason: REFUSE_CHANGED };
}

module.exports = { decide, wellFormed, REFUSE_CHANGED, REFUSE_APPEARED, REFUSE_MALFORMED };
