'use strict';

// Progress governor for Husk Autonomy Mode -- the "busy-stall" detector.
//
// There are two ways an autonomous run wastes money, and they need two
// different detectors:
//
//   quiet-stall -- the agent goes silent (hung, deadlocked, waiting on
//                  nothing). This is already handled well by the run
//                  idle-watchdog in main.js: it nudges a few times, then
//                  ends the run. It checks live PTY bytes and the busy
//                  marker so it never touches an agent that is genuinely
//                  working through a long silent tool call.
//
//   busy-stall  -- the agent is LOUD (chattering, retrying, re-running the
//                  same failing command) so the quiet-watchdog thinks it is
//                  fine, but the workspace never changes and tokens keep
//                  climbing. Nothing else in the system catches this, and
//                  it is where real money leaks. That is this module's job.
//
// The governor deliberately does NOT halt on silence -- doing so would
// false-kill a healthy agent waiting on a 3-minute build. It halts only on
// evidence of active waste, always gated on the workspace making no forward
// progress:
//
//   spinning -- the workspace diff has not advanced for noProgressMs WHILE
//               the agent burned at least minWasteTokens in that window.
//               Frozen output + real spend = spinning. A silent or idle
//               agent (no token growth) is NOT spinning; that is the
//               watchdog's quiet-stall.
//   loop     -- the same identifiable action repeated loopRepeat times with
//               no forward progress between repeats. Any diff advance resets
//               the loop, so a legitimate try/adjust/retry cycle never trips.
//
// Design rules (same contract as budget.js): pure, caller-supplied clock,
// no fs. The caller feeds the parsed signals; the workspace diff signature
// and cumulative token count come from the supervisor. `progress` -- a
// change in the diff signature -- is the single source of truth that resets
// both waste signals, so a run that keeps changing files can never be
// halted no matter how slow, chatty, or long it runs.

const DEFAULT_THRESHOLDS = Object.freeze({
  // Diff frozen at least this long is the first half of "spinning". Five
  // minutes is long enough that reading/exploring a codebase before the
  // first edit, or a slow multi-step tool sequence, never trips it.
  noProgressMs: 300000,
  // ...and the agent must have burned at least this many tokens in that
  // frozen window for it to count as waste. Without real spend it is not
  // "spinning", it is idle -- which the quiet-watchdog owns, not this.
  minWasteTokens: 6000,
  // The same action this many times in a row with no diff progress between
  // them is a loop. Four is the smallest count that cannot be a legitimate
  // try/adjust/retry cycle.
  loopRepeat: 4,
  // Idle telemetry only (surfaced for the UI ramp); the governor never
  // HALTS on idle -- the quiet-watchdog does.
  idleMs: 90000,
});

function createProgressMeter(opts = {}) {
  const th = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
  if (!Number.isFinite(th.noProgressMs) || th.noProgressMs < 0) th.noProgressMs = DEFAULT_THRESHOLDS.noProgressMs;
  if (!Number.isFinite(th.minWasteTokens) || th.minWasteTokens < 0) th.minWasteTokens = DEFAULT_THRESHOLDS.minWasteTokens;
  if (!Number.isInteger(th.loopRepeat) || th.loopRepeat < 2) th.loopRepeat = DEFAULT_THRESHOLDS.loopRepeat;
  if (!Number.isFinite(th.idleMs) || th.idleMs < 0) th.idleMs = DEFAULT_THRESHOLDS.idleMs;

  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();

  // Idle telemetry.
  let lastOutputAt = startedAt;
  // Loop tracking (reset by any forward progress).
  let lastSignature = null;
  let repeatCount = 0;
  // Progress tracking. lastProgressAt is the last time the diff changed;
  // tokensAtProgress is the cumulative token count at that moment. sawDiff
  // stays false until a diff signature is ever fed, which keeps "spinning"
  // dormant for callers that do not supply diffs.
  let lastDiffSignature = null;
  let lastProgressAt = startedAt;
  let tokensAtProgress = 0;
  let sawDiff = false;
  // Monotonic cumulative tokens; never regresses on a flaky report.
  let curTokens = 0;

  // tick({ now?, charsFromAgent?, signature?, diffSignature?, totalTokens? })
  function tick(input = {}) {
    const now = Number.isFinite(input.now) ? input.now : Date.now();

    if (Number.isFinite(input.charsFromAgent) && input.charsFromAgent > 0) lastOutputAt = now;

    // Monotonic token intake: only a larger cumulative count moves it.
    if (Number.isFinite(input.totalTokens) && input.totalTokens > curTokens) curTokens = input.totalTokens;

    // Forward progress is the master reset: a changed diff means the run is
    // producing, so both waste signals start over from now.
    if (typeof input.diffSignature === 'string') {
      sawDiff = true;
      if (input.diffSignature !== lastDiffSignature) {
        lastDiffSignature = input.diffSignature;
        lastProgressAt = now;
        tokensAtProgress = curTokens;
        repeatCount = 0;
        lastSignature = null;
      }
    }

    // A distinct action is also forward progress. The diff is not the only way
    // a run moves: a read-only task (audit, review, report) never changes the
    // workspace, but reading a new file or running a new command is real work.
    // So a NEW action signature resets the waste timers exactly like a diff
    // change, while the SAME action repeated accrues the loop count. This is
    // what keeps a legitimate audit from being read as spinning: spinning now
    // means loud, spending, AND doing the same thing, not merely that no files
    // changed. The action signature hashes only the action's own fields (tool,
    // command, path), so it stays stable across a genuine repeat.
    if (typeof input.signature === 'string' && input.signature.length) {
      if (input.signature === lastSignature) {
        repeatCount += 1;
      } else {
        lastSignature = input.signature;
        repeatCount = 1;
        lastProgressAt = now;
        tokensAtProgress = curTokens;
      }
    }

    return state(now);
  }

  function state(nowParam) {
    const now = Number.isFinite(nowParam) ? nowParam : Date.now();
    const idleMs = Math.max(0, now - lastOutputAt);
    const sinceProgressMs = Math.max(0, now - lastProgressAt);
    const tokensSinceProgress = Math.max(0, curTokens - tokensAtProgress);

    // spinning: needs a diff baseline, a long frozen window, AND real spend
    // in that window. All three so a silent/idle or exploring-but-cheap run
    // is never mistaken for waste.
    const spinning = sawDiff
      && sinceProgressMs >= th.noProgressMs
      && tokensSinceProgress >= th.minWasteTokens;

    // loop: repetition with no forward progress (progress zeroes repeatCount).
    const loop = repeatCount >= th.loopRepeat;

    let stalled = null;
    if (spinning) stalled = 'spinning';
    else if (loop) stalled = 'loop';

    return {
      thresholds: { ...th },
      startedAt,
      idleMs,                       // telemetry only; never a halt reason
      idle: idleMs >= th.idleMs,    // telemetry flag for the UI ramp
      repeatCount,
      repeatSignature: lastSignature,
      sinceProgressMs,
      tokensSinceProgress,
      diffTracked: sawDiff,
      stalled,                      // 'spinning' | 'loop' | null
      ratios: {
        spinning: th.noProgressMs > 0 && sawDiff ? Math.min(1, sinceProgressMs / th.noProgressMs) : 0,
        loop: th.loopRepeat > 0 ? Math.min(1, repeatCount / th.loopRepeat) : 0,
        idle: th.idleMs > 0 ? Math.min(1, idleMs / th.idleMs) : 0,
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
