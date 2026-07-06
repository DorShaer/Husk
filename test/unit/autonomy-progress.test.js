'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_THRESHOLDS,
  createProgressMeter,
} = require('../../src/lib/autonomy/progress');

const T0 = 1_000_000_000_000;

test('default thresholds: 90s idle, 4 repeats, 180s no-progress', () => {
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { idleMs: 90000, loopRepeat: 4, noProgressMs: 180000 });
});

test('a fresh meter is not stalled', () => {
  const m = createProgressMeter({ startedAt: T0 });
  const s = m.state(T0);
  assert.equal(s.stalled, null);
  assert.equal(s.idleMs, 0);
  assert.equal(s.repeatCount, 0);
});

test('idle: silence past idleMs trips idle', () => {
  const m = createProgressMeter({ startedAt: T0 });
  // Just under the threshold: still fine.
  assert.equal(m.state(T0 + 89000).stalled, null);
  // Past it: idle.
  assert.equal(m.state(T0 + 90000).stalled, 'idle');
});

test('idle: any output resets the idle clock', () => {
  const m = createProgressMeter({ startedAt: T0 });
  // Output at 80s keeps it alive; 80s later would be 160s absolute but
  // only 80s since last output -> not idle yet.
  m.tick({ now: T0 + 80000, charsFromAgent: 200 });
  assert.equal(m.state(T0 + 160000).stalled, null);
  // 90s after the last output -> idle.
  assert.equal(m.state(T0 + 170000).stalled, 'idle');
});

test('loop: the same signature loopRepeat times in a row trips loop', () => {
  const m = createProgressMeter({ startedAt: T0 });
  const sig = 'run:npm test';
  // Keep output flowing so idle never fires; isolate the loop signal.
  for (let i = 1; i <= 3; i++) {
    const s = m.tick({ now: T0 + i * 1000, charsFromAgent: 50, signature: sig });
    assert.equal(s.stalled, null, `repeat ${i} should not trip yet`);
  }
  const s4 = m.tick({ now: T0 + 4000, charsFromAgent: 50, signature: sig });
  assert.equal(s4.repeatCount, 4);
  assert.equal(s4.stalled, 'loop');
});

test('loop: a different signature resets the repeat run', () => {
  const m = createProgressMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, charsFromAgent: 10, signature: 'a' });
  m.tick({ now: T0 + 2000, charsFromAgent: 10, signature: 'a' });
  m.tick({ now: T0 + 3000, charsFromAgent: 10, signature: 'a' });
  const reset = m.tick({ now: T0 + 4000, charsFromAgent: 10, signature: 'b' });
  assert.equal(reset.repeatCount, 1);
  assert.equal(reset.stalled, null);
});

test('noProgress: frozen diff while active trips only after noProgressMs', () => {
  const m = createProgressMeter({ startedAt: T0 });
  // First diff observation establishes a baseline.
  m.tick({ now: T0 + 1000, charsFromAgent: 100, signature: 'edit:1', diffSignature: 'files=1;churn=10' });
  // Agent keeps talking (output flows, varied signatures -> no idle, no loop)
  // but the diff never advances.
  let s = m.tick({ now: T0 + 100000, charsFromAgent: 100, signature: 'think:1', diffSignature: 'files=1;churn=10' });
  assert.equal(s.stalled, null, 'under noProgressMs is fine');
  s = m.tick({ now: T0 + 182000, charsFromAgent: 100, signature: 'think:2', diffSignature: 'files=1;churn=10' });
  assert.equal(s.stalled, 'noProgress');
});

test('noProgress: an advancing diff keeps the run healthy', () => {
  const m = createProgressMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, charsFromAgent: 100, signature: 'edit:1', diffSignature: 'files=1;churn=10' });
  m.tick({ now: T0 + 90000, charsFromAgent: 100, signature: 'edit:2', diffSignature: 'files=2;churn=50' });
  const s = m.tick({ now: T0 + 200000, charsFromAgent: 100, signature: 'edit:3', diffSignature: 'files=3;churn=120' });
  assert.equal(s.stalled, null);
});

test('noProgress stays dormant when no diffSignature is ever fed', () => {
  const m = createProgressMeter({ startedAt: T0 });
  // Chatty run, varied signatures, no diff signals at all.
  for (let i = 1; i <= 5; i++) m.tick({ now: T0 + i * 30000, charsFromAgent: 100, signature: `s${i}` });
  const s = m.state(T0 + 200000);
  // Only idle can trip here (last output at 150s, so 200s -> idle). The
  // point: sinceProgressMs must not have accrued from startedAt.
  assert.equal(s.diffTracked, false);
  assert.equal(s.sinceProgressMs, 0);
});

test('idle takes precedence over loop in the reported signal', () => {
  const m = createProgressMeter({ startedAt: T0 });
  const sig = 'x';
  // Build a loop, then go silent long enough to also be idle.
  m.tick({ now: T0 + 1000, charsFromAgent: 10, signature: sig });
  m.tick({ now: T0 + 2000, charsFromAgent: 10, signature: sig });
  m.tick({ now: T0 + 3000, charsFromAgent: 10, signature: sig });
  m.tick({ now: T0 + 4000, charsFromAgent: 10, signature: sig }); // loop tripped
  const s = m.state(T0 + 4000 + 90000); // now also idle
  assert.equal(s.stalled, 'idle');
});

test('thresholds are clamped to sane values', () => {
  const m = createProgressMeter({
    startedAt: T0,
    thresholds: { idleMs: -5, loopRepeat: 1, noProgressMs: NaN },
  });
  const s = m.state(T0);
  assert.equal(s.thresholds.idleMs, DEFAULT_THRESHOLDS.idleMs);
  assert.equal(s.thresholds.loopRepeat, DEFAULT_THRESHOLDS.loopRepeat);
  assert.equal(s.thresholds.noProgressMs, DEFAULT_THRESHOLDS.noProgressMs);
});
