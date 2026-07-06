'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_THRESHOLDS,
  createProgressMeter,
} = require('../../src/lib/autonomy/progress');

const T0 = 1_000_000_000_000;
const MIN = 60000;

test('defaults: 5m no-progress, 6k waste tokens, 4 loop repeats', () => {
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { noProgressMs: 300000, minWasteTokens: 6000, loopRepeat: 4, idleMs: 90000 });
});

test('a fresh meter is not stalled', () => {
  const m = createProgressMeter({ startedAt: T0 });
  assert.equal(m.state(T0).stalled, null);
});

// ─── the critical false-positive guards ────────────────────────────────────

test('NO false-kill: a long SILENT run (no output, no tokens) never stalls', () => {
  const m = createProgressMeter({ startedAt: T0 });
  // 10 minutes of pure silence: no output, no tokens, no diff. This is the
  // quiet-watchdog's job, NOT the governor's. The governor must stay quiet.
  const s = m.state(T0 + 10 * MIN);
  assert.equal(s.stalled, null);
  assert.equal(s.idle, true, 'idle telemetry still reports true');
});

test('NO false-kill: a long silent TOOL CALL (diff frozen, but no token burn) never stalls', () => {
  const m = createProgressMeter({ startedAt: T0 });
  // Establish a diff baseline, then the agent runs a 6-minute build: diff
  // frozen, but it is not burning model tokens while the tool runs.
  m.tick({ now: T0 + 1000, diffSignature: 'files=2;churn=40', totalTokens: 5000 });
  const s = m.state(T0 + 7 * MIN); // 6+ min frozen, but tokens never grew past 5000
  assert.equal(s.stalled, null, 'frozen diff without token burn is not waste');
});

test('NO false-kill: a slow but PROGRESSING run never stalls, however long', () => {
  const m = createProgressMeter({ startedAt: T0 });
  let tok = 0;
  // 30 minutes, editing a file every 4 minutes while burning tokens.
  for (let i = 1; i <= 7; i++) {
    tok += 20000;
    const s = m.tick({ now: T0 + i * 4 * MIN, diffSignature: `files=${i};churn=${i * 100}`, totalTokens: tok, charsFromAgent: 200 });
    assert.equal(s.stalled, null, `progress tick ${i} must stay healthy`);
  }
});

// ─── true-positive: real busy-stall waste ──────────────────────────────────

test('spinning: diff frozen past 5m WHILE burning >6k tokens halts', () => {
  const m = createProgressMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, diffSignature: 'files=1;churn=10', totalTokens: 1000 });
  // Agent keeps burning tokens (chattering/retrying) but the diff never moves.
  m.tick({ now: T0 + 2 * MIN, diffSignature: 'files=1;churn=10', totalTokens: 4000, charsFromAgent: 500 });
  let s = m.state(T0 + 4 * MIN);
  assert.equal(s.stalled, null, 'under 5 minutes frozen is still allowed');
  s = m.tick({ now: T0 + 6 * MIN, diffSignature: 'files=1;churn=10', totalTokens: 9000, charsFromAgent: 500 });
  assert.equal(s.stalled, 'spinning');
  assert.ok(s.tokensSinceProgress >= 6000);
});

test('spinning resets the instant the diff advances', () => {
  const m = createProgressMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, diffSignature: 'files=1;churn=10', totalTokens: 1000 });
  // Almost spinning: 5m frozen, tokens burned...
  let s = m.tick({ now: T0 + 6 * MIN, diffSignature: 'files=1;churn=10', totalTokens: 9000 });
  assert.equal(s.stalled, 'spinning');
  // ...then a real edit lands. Progress must clear the stall immediately.
  s = m.tick({ now: T0 + 6 * MIN + 1000, diffSignature: 'files=2;churn=80', totalTokens: 9500 });
  assert.equal(s.stalled, null);
  assert.equal(s.tokensSinceProgress, 0);
});

// ─── loop ──────────────────────────────────────────────────────────────────

test('loop: same action 4x with no progress halts', () => {
  const m = createProgressMeter({ startedAt: T0 });
  const sig = 'run:npm test';
  for (let i = 1; i <= 3; i++) {
    assert.equal(m.tick({ now: T0 + i * 1000, signature: sig, charsFromAgent: 50 }).stalled, null);
  }
  assert.equal(m.tick({ now: T0 + 4000, signature: sig, charsFromAgent: 50 }).stalled, 'loop');
});

test('loop is reset by forward progress (diff change zeroes the repeat)', () => {
  const m = createProgressMeter({ startedAt: T0 });
  const sig = 'edit:file';
  m.tick({ now: T0 + 1000, signature: sig, diffSignature: 'd0' });
  m.tick({ now: T0 + 2000, signature: sig, diffSignature: 'd0' });
  m.tick({ now: T0 + 3000, signature: sig, diffSignature: 'd0' });
  // A real edit lands: progress clears the accrued repeats. The action on
  // this same tick counts as the first post-progress occurrence (1), well
  // under the loop threshold, so the loop is broken.
  const reset = m.tick({ now: T0 + 4000, signature: sig, diffSignature: 'd1' });
  assert.equal(reset.repeatCount, 1);
  assert.equal(reset.stalled, null);
});

test('loop is reset by a different action', () => {
  const m = createProgressMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, signature: 'a' });
  m.tick({ now: T0 + 2000, signature: 'a' });
  m.tick({ now: T0 + 3000, signature: 'a' });
  const r = m.tick({ now: T0 + 4000, signature: 'b' });
  assert.equal(r.repeatCount, 1);
  assert.equal(r.stalled, null);
});

// ─── robustness ────────────────────────────────────────────────────────────

test('token intake is monotonic: a smaller cumulative report is ignored', () => {
  const m = createProgressMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, diffSignature: 'd', totalTokens: 1000 });   // progress baseline
  m.tick({ now: T0 + 2 * MIN, totalTokens: 9000 });                    // burned to 9000
  m.tick({ now: T0 + 3 * MIN, totalTokens: 3000 });                    // flaky low read: must NOT regress
  // Frozen 7m with 8000 tokens burned since progress -> spinning. If the
  // flaky 3000 had regressed curTokens, the burn would read <6000 and miss.
  const s = m.state(T0 + 7 * MIN);
  assert.equal(s.stalled, 'spinning');
  assert.equal(s.tokensSinceProgress, 8000);
});

test('spinning stays dormant when no diff signature is ever fed', () => {
  const m = createProgressMeter({ startedAt: T0 });
  // Burns tokens for 10 minutes but the caller never feeds a diff signature.
  for (let i = 1; i <= 10; i++) m.tick({ now: T0 + i * MIN, totalTokens: i * 5000, charsFromAgent: 100 });
  const s = m.state(T0 + 11 * MIN);
  assert.equal(s.diffTracked, false);
  assert.equal(s.stalled, null); // loop can still fire, spinning cannot
});

test('spinning takes precedence over a simultaneous loop', () => {
  const m = createProgressMeter({ startedAt: T0 });
  const sig = 'x';
  m.tick({ now: T0 + 1000, signature: sig, diffSignature: 'd', totalTokens: 1000 });
  // Repeat the same action many times, diff frozen, tokens burned, past 5m.
  for (let i = 2; i <= 6; i++) m.tick({ now: T0 + i * 1000, signature: sig, totalTokens: 1000 + i });
  const s = m.tick({ now: T0 + 6 * MIN, signature: sig, diffSignature: 'd', totalTokens: 12000 });
  assert.equal(s.stalled, 'spinning');
});

test('thresholds clamp to sane values', () => {
  const m = createProgressMeter({ startedAt: T0, thresholds: { noProgressMs: -1, minWasteTokens: NaN, loopRepeat: 1, idleMs: -5 } });
  const t = m.state(T0).thresholds;
  assert.equal(t.noProgressMs, DEFAULT_THRESHOLDS.noProgressMs);
  assert.equal(t.minWasteTokens, DEFAULT_THRESHOLDS.minWasteTokens);
  assert.equal(t.loopRepeat, DEFAULT_THRESHOLDS.loopRepeat);
  assert.equal(t.idleMs, DEFAULT_THRESHOLDS.idleMs);
});
