'use strict';

// Progress meter for Husk Autonomy Mode -- the "governor" that stops a
// run from burning tokens while making no forward progress.
//
// The budget meter (budget.js) answers "has this run spent too much?".
// This meter answers the orthogonal question "is this run still doing
// useful work, or is it idling / looping and wasting spend?". A run can
// be well under its dollar cap and still be pure waste: an agent stuck
// in a retry loop, or hung waiting on nothing, keeps the meter running
// with zero value. Catching that early is the difference between a
// governor and a passive odometer.
//
// Three independent stall signals, cheapest-first so the whole meter is
// pure (no fs, no PTY, no clock -- the caller supplies timestamps and
// the parsed signals, exactly like budget.js):
//
//   1. idle       -- no agent output for idleMs. The process is alive
//                    but silent (hung on input, deadlocked, waiting on a
//                    network call that will never return). Every second
//                    idle is a second of wall-clock cap burned for free.
//   2. loop       -- the same action signature repeats loopRepeat times
//                    in a row. Classic agent failure: re-running the same
//                    failing command, re-reading the same file, retrying
//                    an edit that never applies. This is where real token
//                    spend leaks, because each repeat is a fresh model
//                    turn.
//   3. noProgress -- optional, diff-based: the workspace diff has not
//                    advanced for noProgressMs while the agent IS active
//                    (producing output). Talking a lot, changing nothing.
//                    Only evaluated when the caller feeds a diffSignature;
//                    left dormant otherwise so the meter stays fs-free.
//
// Design rules (identical contract to budget.js so the supervisor can
// treat both meters the same way):
//   - Pure: no side effects, no fs, no Date.now(). The caller supplies
//     `now` on every tick so the module is testable with fake timers.
//   - Conservative: a signal only trips when it is unambiguous. Idle
//     needs true silence; loop needs consecutive identical signatures;
//     noProgress needs both activity AND a frozen diff. False pauses are
//     worse than a slightly late one, so every default leans lenient.
//   - Independent signals: tripping any one stalls the run. The first
//     tripped signal (idle, then loop, then noProgress) is reported.

const DEFAULT_THRESHOLDS = Object.freeze({
  // Silence this long with no agent output -> idle. 90s is comfortably
  // past a slow model turn or a big file read, so a healthy run never
  // trips it, but a genuinely hung process is caught inside two minutes.
  idleMs: 90000,
  // The same action signature this many times in a row -> loop. Three
  // is the smallest count that cannot be a legitimate "try, adjust,
  // retry" cycle; a fourth identical attempt is a stuck agent.
  loopRepeat: 4,
  // Diff frozen this long WHILE the agent is active -> noProgress. Only
  // used when the caller feeds diffSignature. Longer than idleMs because
  // "thinking out loud before an edit" is normal and must not trip it.
  noProgressMs: 180000,
});

function createProgressMeter(opts = {}) {
  const th = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
  if (!Number.isFinite(th.idleMs) || th.idleMs < 0) th.idleMs = DEFAULT_THRESHOLDS.idleMs;
  if (!Number.isInteger(th.loopRepeat) || th.loopRepeat < 2) th.loopRepeat = DEFAULT_THRESHOLDS.loopRepeat;
  if (!Number.isFinite(th.noProgressMs) || th.noProgressMs < 0) th.noProgressMs = DEFAULT_THRESHOLDS.noProgressMs;

  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();

  // Last moment the agent produced any output. Seeded to startedAt so a
  // run that never emits a byte still trips idle after idleMs rather
  // than reading as "never started".
  let lastOutputAt = startedAt;
  // Loop tracking: the signature of the most recent action and how many
  // times in a row it has appeared. A different signature resets the run
  // length to 1.
  let lastSignature = null;
  let repeatCount = 0;
  // noProgress tracking: the most recent diff signature and when it last
  // changed. Null until the caller opts in by passing diffSignature.
  let lastDiffSignature = null;
  let lastProgressAt = startedAt;
  let sawDiff = false;

  // tick({ now?, charsFromAgent?, signature?, diffSignature? })
  //   charsFromAgent  -- bytes of agent output since the last tick; any
  //                      positive value counts as "alive" and resets idle.
  //   signature       -- a stable string identifying the current action
  //                      (e.g., a normalized tool call or command). Feeding
  //                      it enables loop detection; omit for output-only
  //                      ticks (which still count as activity).
  //   diffSignature   -- a stable string summarizing the workspace diff
  //                      (e.g., "files=3;churn=812"). Feeding it enables
  //                      noProgress detection; omit to keep the meter
  //                      fs-free.
  function tick(input = {}) {
    const now = Number.isFinite(input.now) ? input.now : Date.now();

    const hasOutput = Number.isFinite(input.charsFromAgent) && input.charsFromAgent > 0;
    if (hasOutput) lastOutputAt = now;

    if (typeof input.signature === 'string' && input.signature.length) {
      if (input.signature === lastSignature) {
        repeatCount += 1;
      } else {
        lastSignature = input.signature;
        repeatCount = 1;
      }
    }

    if (typeof input.diffSignature === 'string') {
      sawDiff = true;
      if (input.diffSignature !== lastDiffSignature) {
        lastDiffSignature = input.diffSignature;
        lastProgressAt = now;
      }
    }

    return state(now);
  }

  function state(nowParam) {
    const now = Number.isFinite(nowParam) ? nowParam : Date.now();
    const idleMs = Math.max(0, now - lastOutputAt);
    // Only meaningful once a diff has ever been seen; otherwise a run
    // that never opts into diff signals would falsely accrue "frozen"
    // time from startedAt.
    const sinceProgressMs = sawDiff ? Math.max(0, now - lastProgressAt) : 0;

    const idleTripped = idleMs >= th.idleMs;
    const loopTripped = repeatCount >= th.loopRepeat;
    // noProgress requires the agent to be ACTIVE (not already idle) so it
    // never double-reports what idle already caught: a silent frozen diff
    // is idle, a chatty frozen diff is noProgress.
    const noProgressTripped = sawDiff && !idleTripped && sinceProgressMs >= th.noProgressMs;

    let stalled = null;
    if (idleTripped) stalled = 'idle';
    else if (loopTripped) stalled = 'loop';
    else if (noProgressTripped) stalled = 'noProgress';

    return {
      thresholds: { ...th },
      startedAt,
      idleMs,
      repeatCount,
      repeatSignature: lastSignature,
      sinceProgressMs,
      diffTracked: sawDiff,
      stalled,
      ratios: {
        idle: th.idleMs > 0 ? Math.min(1, idleMs / th.idleMs) : 0,
        loop: th.loopRepeat > 0 ? Math.min(1, repeatCount / th.loopRepeat) : 0,
        noProgress: th.noProgressMs > 0 ? Math.min(1, sinceProgressMs / th.noProgressMs) : 0,
      },
    };
  }

  return {
    tick,
    state,
    startedAt() { return startedAt; },
    lastOutputAt() { return lastOutputAt; },
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  createProgressMeter,
};
