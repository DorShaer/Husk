'use strict';

// Progress governor for Husk Autonomy Mode: the busy-stall detector.
//
// A run that goes silent is handled by the idle-watchdog in main.js, which
// nudges a few times and then ends the run. This module covers the loud
// case: the agent keeps chattering and retrying while the workspace never
// changes and tokens keep climbing.
//
// It halts on evidence of active waste, always gated on the workspace
// making no forward progress:
//
//   spinning - the workspace diff has not advanced for noProgressMs while
//              the agent burned at least minWasteTokens in that window.
//   loop     - the same identifiable action repeated loopRepeat times with
//              no forward progress between repeats. Any diff advance resets
//              the loop, so a try/adjust/retry cycle runs to completion.
//
// Same contract as budget.js: pure, caller-supplied clock, no fs. The
// caller feeds the parsed signals; the workspace diff signature and the
// cumulative token count come from the supervisor. A change in the diff
// signature is the progress marker that resets both waste signals.

const DEFAULT_THRESHOLDS = Object.freeze({
  // A diff frozen at least this long is the first half of "spinning".
  noProgressMs: 300000,
  // Tokens the agent must burn inside that frozen window for it to count
  // as waste rather than as idle.
  minWasteTokens: 6000,
  // The same action this many times in a row, with no diff progress between
  // them, counts as a loop.
  loopRepeat: 4,
  // Idle telemetry for the UI ramp. The governor reports idle and never
  // halts on it.
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
  // Progress tracking. lastProgressAt is the last time the diff changed and
  // tokensAtProgress is the cumulative token count at that moment. sawDiff
  // stays false until a diff signature is fed, so "spinning" stays dormant
  // for callers that do not supply diffs.
  let lastDiffSignature = null;
  let lastProgressAt = startedAt;
  let tokensAtProgress = 0;
  let sawDiff = false;
  // Monotonic cumulative token count.
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

    // A distinct action is also forward progress: a read-only task never
    // changes the workspace, but reading a new file or running a new command
    // is real work. A new action signature resets the waste timers like a
    // diff change, while the same action repeated accrues the loop count.
    // The signature hashes only the action's own fields (tool, command,
    // path), so it stays stable across a genuine repeat.
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

    // spinning: a diff baseline, a long frozen window, and real spend
    // inside that window.
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
