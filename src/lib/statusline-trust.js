'use strict';

// Which statusline script Husk is willing to execute.
//
// Husk runs this script with bash every thirty seconds while the window is
// open, so which file it picks is a decision rather than a detail. Husk also
// launches agent CLIs that write files as they work, following directions that
// come from whatever repository they were pointed at, so a script arriving
// under ~/.claude that the user did not put there is a state this has to answer
// for. Unchecked, such a file runs within thirty seconds, with the user's
// environment, and again every thirty seconds after, with nothing on screen.
//
// The rule is trust on first use, pinned by content:
//
//   no pin yet        record what is there and run it. Every install that
//                     already works keeps working, which is the only reason
//                     this is not a hard prompt.
//   pin matches       run it.
//   pin says none     a script that appears later is refused. This is the case
//                     that catches a file written onto a machine that had none.
//   pin disagrees     refused. A legitimate reinstall lands here too, and the
//                     user clears the pin to re-approve. Refusing a real
//                     upgrade costs a stale statusline; accepting a forged one
//                     costs the machine.
//
// Trust on first use is weaker than a signature. A signature would require
// every user to hold a key for a script the framework writes, which does not
// exist. What this does buy is that the file cannot change underneath the user
// without Husk noticing.
//
// The decision is separated from the execution so it can be tested without
// spawning anything. decide() performs no IO of its own: the caller supplies a
// digest reader, which is also what lets a test drive the swap cases.

const REFUSE_CHANGED = 'changed';
const REFUSE_APPEARED = 'appeared';
const REFUSE_MALFORMED = 'malformed';

// A pin is either absent, meaning Husk has never looked, or a record of what it
// saw. Anything else is a third state, and the safe reading of a record that
// cannot be understood is that something is wrong rather than that nothing is.
// Treating it as absent would re-pin to whatever is on disk at that moment,
// which hands the decision to a file that may be the reason the record broke.
function wellFormed(pin) {
  if (pin === null || pin === undefined) return true;
  if (typeof pin !== 'object' || Array.isArray(pin)) return false;
  const pathOk = pin.path === null || typeof pin.path === 'string';
  const shaOk = pin.sha256 === null || typeof pin.sha256 === 'string';
  return pathOk && shaOk;
}

// candidates  absolute paths, most preferred first
// pin         { path, sha256 } from config, or null when nothing recorded yet.
//             { path: null } records a machine that had no script.
// readDigest  (absolutePath) => sha256 hex, or null when the path is not a
//             regular file. Throwing is treated as not readable.
//
// Returns { run, pin, reason }:
//   run     the path to execute, or null
//   pin     a pin to persist, or null when the stored one still stands
//   reason  why nothing runs, for the log
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
    // Record the absence, so a script appearing later is a change rather than
    // a first sight. Without it, a file written onto a machine that never had
    // one would read as an ordinary first install.
    if (!stored) return { run: null, pin: { path: null, sha256: null }, reason: null };
    return { run: null, pin: null, reason: null };
  }

  if (!stored) return { run: found, pin: { path: found, sha256: digest }, reason: null };

  if (stored.path === null) return { run: null, pin: null, reason: REFUSE_APPEARED };
  if (stored.path === found && stored.sha256 === digest) return { run: found, pin: null, reason: null };
  return { run: null, pin: null, reason: REFUSE_CHANGED };
}

module.exports = { decide, wellFormed, REFUSE_CHANGED, REFUSE_APPEARED, REFUSE_MALFORMED };
