'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CAPS,
  DEFAULT_RATES,
  createBudgetMeter,
} = require('../../src/lib/autonomy/budget');

const T0 = 1_000_000_000_000;

test('default caps: 60 min, 200k tokens, $5', () => {
  assert.deepEqual({ ...DEFAULT_CAPS }, { minutes: 60, tokens: 200000, dollars: 5 });
});

test('a fresh meter reports zero usage and no hit cap', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  const s = m.state(T0);
  assert.equal(s.elapsedMs, 0);
  assert.equal(s.totalTokens, 0);
  assert.equal(s.dollars, 0);
  assert.equal(s.hitCap, null);
});

test('tick with explicit token counts accumulates correctly', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, inputTokens: 100, outputTokens: 50 });
  m.tick({ now: T0 + 2000, inputTokens: 100, outputTokens: 50 });
  const s = m.state(T0 + 2000);
  assert.equal(s.inputTokens, 200);
  assert.equal(s.outputTokens, 100);
  assert.equal(s.totalTokens, 300);
});

test('charsFromAgent fallback estimates output tokens at 4 chars per token', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, charsFromAgent: 4096 });
  const s = m.state(T0 + 1000);
  assert.equal(s.outputTokens, 1024);
  assert.equal(s.tokensEstimated, true);
});

test('explicit token counts NEVER trigger the estimation flag', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ now: T0 + 1000, inputTokens: 100, outputTokens: 50 });
  const s = m.state(T0 + 1000);
  assert.equal(s.tokensEstimated, false);
});

test('dollars are computed from per-million-token rate table', () => {
  const m = createBudgetMeter({ startedAt: T0, modelId: 'claude-sonnet-4-7' });
  // 1M input + 1M output at $3/Mtok in + $15/Mtok out = $18
  m.tick({ now: T0, inputTokens: 1_000_000, outputTokens: 1_000_000 });
  const s = m.state(T0);
  assert.equal(s.dollars, 18);
});

test('unknown modelId falls through to the _default rate', () => {
  const m = createBudgetMeter({ startedAt: T0, modelId: 'never-shipped-model' });
  assert.equal(m.state(T0).rate.in, DEFAULT_RATES._default.in);
});

test('copilot / codex / aider default to $0 (vendor-billed)', () => {
  for (const id of ['copilot', 'codex', 'aider']) {
    const m = createBudgetMeter({ startedAt: T0, modelId: id });
    m.tick({ now: T0, inputTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.equal(m.state(T0).dollars, 0, `dollars for ${id}`);
  }
});

test('hitCap returns "minutes" when wall-clock cap is reached', () => {
  const m = createBudgetMeter({ startedAt: T0, caps: { minutes: 1, tokens: 1e9, dollars: 1e9 } });
  const s = m.state(T0 + 61 * 1000);
  assert.equal(s.hitCap, 'minutes');
});

test('hitCap returns "tokens" when token cap is reached', () => {
  const m = createBudgetMeter({ startedAt: T0, caps: { minutes: 1e9, tokens: 100, dollars: 1e9 } });
  m.tick({ now: T0, outputTokens: 150 });
  assert.equal(m.state(T0).hitCap, 'tokens');
});

test('hitCap returns "dollars" when cost cap is reached', () => {
  const m = createBudgetMeter({
    startedAt: T0,
    caps: { minutes: 1e9, tokens: 1e9, dollars: 0.10 },
    modelId: 'claude-sonnet-4-7',
  });
  m.tick({ now: T0, outputTokens: 10_000 }); // 10k * $15/Mtok = $0.15
  assert.equal(m.state(T0).hitCap, 'dollars');
});

test('ratios stay between 0 and 1', () => {
  const m = createBudgetMeter({ startedAt: T0, caps: { minutes: 10, tokens: 1000, dollars: 1 } });
  m.tick({ now: T0 + 5 * 60 * 1000, inputTokens: 500 });
  const s = m.state(T0 + 5 * 60 * 1000);
  assert.ok(s.ratios.minutes >= 0 && s.ratios.minutes <= 1);
  assert.ok(s.ratios.tokens  >= 0 && s.ratios.tokens  <= 1);
  assert.ok(s.ratios.dollars >= 0 && s.ratios.dollars <= 1);
});

test('a cap of 0 disables that cap (never fires hitCap for it)', () => {
  const m = createBudgetMeter({ startedAt: T0, caps: { minutes: 0, tokens: 100, dollars: 1 }, modelId: 'claude-sonnet-4-7' });
  const s = m.state(T0 + 1e9);
  // Minutes elapsed is way past any reasonable cap but cap is
  // disabled, so hitCap should NOT be "minutes".
  assert.notEqual(s.hitCap, 'minutes');
});

test('invalid caps (negative, NaN) get clamped to the defaults', () => {
  const m = createBudgetMeter({ startedAt: T0, caps: { minutes: -5, tokens: NaN, dollars: 'oops' } });
  const s = m.state(T0);
  assert.equal(s.caps.minutes, DEFAULT_CAPS.minutes);
  assert.equal(s.caps.tokens, DEFAULT_CAPS.tokens);
  assert.equal(s.caps.dollars, DEFAULT_CAPS.dollars);
});

test('cap priority: minutes fires before tokens if both crossed in same tick', () => {
  // The supervisor only needs one halt reason. We report minutes first
  // because users care most about "stop at the time I said".
  const m = createBudgetMeter({ startedAt: T0, caps: { minutes: 1, tokens: 100, dollars: 100 } });
  m.tick({ now: T0 + 70 * 1000, outputTokens: 1000 });
  assert.equal(m.state(T0 + 70 * 1000).hitCap, 'minutes');
});

test('negative token deltas in tick are clamped to 0 (no rewinding the counter)', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ now: T0, inputTokens: 100 });
  m.tick({ now: T0, inputTokens: -50 });
  assert.equal(m.state(T0).inputTokens, 100);
});
