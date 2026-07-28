'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CAPS,
  DEFAULT_RATES,
  resolveRate,
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

test('setReportedTokens overrides chars/4 estimate as the truth source', () => {
  const m = createBudgetMeter({ startedAt: T0, modelId: 'claude-opus-4-7' });
  // chars/4 path: would estimate 5000/4 = 1250 output tokens
  m.tick({ now: T0, charsFromAgent: 5000 });
  assert.equal(m.state(T0).totalTokens, 1250);
  assert.equal(m.state(T0).tokensEstimated, true);
  // Agent reports its real number (e.g. parsed from "↓ 800 tokens")
  m.setReportedTokens(800);
  const s = m.state(T0);
  assert.equal(s.totalTokens, 800);
  assert.equal(s.tokensReported, true);
  assert.equal(s.tokensEstimated, false);
});

test('exact cache-aware cost: each tier billed at its real rate', () => {
  const m = createBudgetMeter({ startedAt: T0, modelId: 'claude-sonnet-4-7' }); // in $3, out $15
  m.tick({ inputTokens: 10000, outputTokens: 5000, cacheCreateTokens: 20000, cacheReadTokens: 1_000_000 });
  const s = m.state(T0);
  // dollars = 10k*3 + 5k*15 + 20k*(3*1.25) + 1M*(3*0.1), all /1e6
  //         = 0.03 + 0.075 + 0.075 + 0.30 = 0.48
  assert.ok(Math.abs(s.dollars - 0.48) < 1e-9, `dollars ${s.dollars}`);
  assert.equal(s.tokensExact, true);
  assert.equal(s.cacheReadTokens, 1_000_000);
});

test('cache reads are billed but EXCLUDED from the token cap basis', () => {
  // 1M cache reads under a 200k token cap must not trip it: the cap counts
  // fresh work (input + output + cache writes), not cheap cache re-reads.
  const m = createBudgetMeter({ startedAt: T0, modelId: 'claude-sonnet-4-7', caps: { minutes: 1e9, tokens: 200000, dollars: 1e9 } });
  m.tick({ inputTokens: 10000, outputTokens: 5000, cacheCreateTokens: 20000, cacheReadTokens: 1_000_000 });
  const s = m.state(T0);
  assert.equal(s.totalTokens, 35000);       // 10k + 5k + 20k, cache reads excluded
  assert.equal(s.hitCap, null);             // 35k < 200k, despite 1M cache reads
});

test('reported dollars use the cache-weighted rate, not the fresh blend', () => {
  // Calibrated from real usage: a status-line cumulative is ~97% cache reads,
  // so 1M reported tokens costs ~$0.54 for Sonnet, not the ~$11.40 a fresh blend implies.
  const m = createBudgetMeter({ startedAt: T0, modelId: 'claude-sonnet-4-7' });
  m.setReportedTokens(1_000_000);
  const s = m.state(T0);
  // rate.in*0.13 + rate.out*0.01 = 3*0.13 + 15*0.01 = 0.54
  assert.ok(Math.abs(s.dollars - 0.54) < 0.001, `dollars ${s.dollars}`);
  assert.ok(s.dollars < 1, 'nowhere near the old $11.40');
});

test('a cache-heavy high-token run does not false-trip the dollar cap', () => {
  // 5M reported tokens (cache-dominated) under a $5 cap. Old fresh blend
  // charged 5M*11.4 = $57 -> instant false halt. Calibrated: 5M*0.54 = $2.70.
  const m = createBudgetMeter({ startedAt: T0, modelId: 'claude-sonnet-4-7', caps: { minutes: 1e9, tokens: 1e9, dollars: 5 } });
  m.setReportedTokens(5_000_000);
  const s = m.state(T0);
  assert.ok(s.dollars < 5, `dollars ${s.dollars} should be under the cap`);
  assert.equal(s.hitCap, null);
});

test('setReportedTokens is monotonic (never lets the counter regress)', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.setReportedTokens(1500);
  m.setReportedTokens(900);
  assert.equal(m.state(T0).totalTokens, 1500);
  m.setReportedTokens(2200);
  assert.equal(m.state(T0).totalTokens, 2200);
});

test('reported tokens drive dollar cost via the cache-weighted rate', () => {
  // claude-opus-4-7 rates: in $5/Mtok, out $25/Mtok. A reported cumulative is
  // cache-dominated, so the calibrated rate is in*0.13 + out*0.01 =
  // 5*0.13 + 25*0.01 = 0.90/Mtok. 1000 tokens => 0.0009 dollars.
  const m = createBudgetMeter({ startedAt: T0, modelId: 'claude-opus-4-7' });
  m.setReportedTokens(1000);
  assert.ok(Math.abs(m.state(T0).dollars - 0.0009) < 1e-6, `dollars ${m.state(T0).dollars}`);
});

test('explicit transcript deltas outgrow a stale early report', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  // A status-line report lands before the transcript pins...
  m.setReportedTokens(500);
  assert.equal(m.state(T0).totalTokens, 500);
  // ...then exact per-turn deltas accumulate past it and must win.
  m.tick({ now: T0, inputTokens: 400, outputTokens: 300 });
  const s = m.state(T0);
  assert.equal(s.totalTokens, 700);
  assert.equal(s.tokensEstimated, false);
});

test('exact dollars still guard the cap when reported tokens are larger', () => {
  const m = createBudgetMeter({
    startedAt: T0,
    modelId: 'claude-sonnet-4-7',
    caps: { minutes: 1e9, tokens: 1e9, dollars: 5 },
  });
  m.tick({ now: T0, inputTokens: 2_000_000, outputTokens: 0 });
  m.setReportedTokens(5_000_000);
  const s = m.state(T0);
  assert.equal(s.totalTokens, 5_000_000);
  assert.ok(s.dollars >= 6, `dollars ${s.dollars}`);
  assert.equal(s.hitCap, 'dollars');
});

test('a larger reported cumulative still beats smaller explicit deltas', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ now: T0, inputTokens: 100, outputTokens: 100 });
  m.setReportedTokens(900);
  assert.equal(m.state(T0).totalTokens, 900);
});

test('estimate never outranks an explicit or reported signal', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ now: T0, charsFromAgent: 40000 }); // 10k estimated
  m.tick({ now: T0, inputTokens: 50, outputTokens: 50 });
  const s = m.state(T0);
  assert.equal(s.totalTokens, 100);
  assert.equal(s.tokensEstimated, false);
});

test('current model rates are real list prices (opus 5/25, haiku 1/5, fable 10/50)', () => {
  assert.deepEqual(DEFAULT_RATES['claude-opus-4-8'], { in: 5, out: 25 });
  assert.deepEqual(DEFAULT_RATES['claude-opus-4-7'], { in: 5, out: 25 });
  assert.deepEqual(DEFAULT_RATES['claude-haiku-4-5'], { in: 1, out: 5 });
  assert.deepEqual(DEFAULT_RATES['claude-fable-5'], { in: 10, out: 50 });
  assert.deepEqual(DEFAULT_RATES['claude-sonnet-5'], { in: 3, out: 15 });
});

test('resolveRate matches exact id, strips date suffix, and maps tier aliases', () => {
  assert.equal(resolveRate('claude-opus-4-8', DEFAULT_RATES).id, 'claude-opus-4-8');
  assert.equal(resolveRate('claude-opus-4-8-20260115', DEFAULT_RATES).id, 'claude-opus-4-8');
  assert.equal(resolveRate('opus', DEFAULT_RATES).id, 'claude-opus-4-8');
  assert.equal(resolveRate('haiku', DEFAULT_RATES).id, 'claude-haiku-4-5');
  assert.equal(resolveRate('fable', DEFAULT_RATES).id, 'claude-fable-5');
  assert.equal(resolveRate('somenewcli-model', DEFAULT_RATES).id, '_default');
});

test('setModel re-pins the billing rate to the model that actually ran', () => {
  // Meter created blind (no model). Same fresh work billed under haiku then opus.
  const mh = createBudgetMeter({ startedAt: T0 });
  mh.setModel('claude-haiku-4-5');            // in $1, out $5
  mh.tick({ inputTokens: 100000, outputTokens: 100000 });
  // 100k*1 + 100k*5, /1e6 = 0.1 + 0.5 = 0.6
  assert.ok(Math.abs(mh.state(T0).dollars - 0.6) < 1e-9, `haiku ${mh.state(T0).dollars}`);

  const mo = createBudgetMeter({ startedAt: T0 });
  mo.setModel('claude-opus-4-8-20260115');    // dated id -> in $5, out $25
  mo.tick({ inputTokens: 100000, outputTokens: 100000 });
  // 100k*5 + 100k*25, /1e6 = 0.5 + 2.5 = 3.0
  assert.ok(Math.abs(mo.state(T0).dollars - 3.0) < 1e-9, `opus ${mo.state(T0).dollars}`);
});

// The first cache write of a run is the prompt prefix the agent loaded before
// doing any work. Every later write is that prefix growing. The cumulative
// total cannot tell the two apart, which is what made a 27-second cancelled
// run read as half a million tokens.
test('baseline context is the first cache write, not the running total', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ inputTokens: 3000, outputTokens: 200, cacheCreateTokens: 120000, cacheReadTokens: 0 });
  m.tick({ inputTokens: 40, outputTokens: 900, cacheCreateTokens: 4000, cacheReadTokens: 120000 });
  m.tick({ inputTokens: 20, outputTokens: 700, cacheCreateTokens: 6000, cacheReadTokens: 124000 });
  const s = m.state(T0 + 1000);
  assert.equal(s.baselineContextTokens, 120000, 'baseline stays at the first write');
  assert.equal(s.cacheCreateTokens, 130000, 'cumulative keeps summing every write');
  assert.equal(s.requestCount, 3);
});

test('baseline ignores leading zero-cache turns', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ inputTokens: 10, outputTokens: 5, cacheCreateTokens: 0, cacheReadTokens: 0 });
  m.tick({ inputTokens: 10, outputTokens: 5, cacheCreateTokens: 90000, cacheReadTokens: 0 });
  assert.equal(m.state(T0 + 10).baselineContextTokens, 90000);
});

test('a run with no cache tier reports a zero baseline', () => {
  const m = createBudgetMeter({ startedAt: T0 });
  m.tick({ inputTokens: 500, outputTokens: 500 });
  const s = m.state(T0 + 10);
  assert.equal(s.baselineContextTokens, 0);
  assert.equal(s.requestCount, 1);
});
