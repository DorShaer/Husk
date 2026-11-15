'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/lib/usage-monitor');
const { parseRateLimitInfo } = require('../../src/lib/chat-events');

test('thresholds validate and multiple sources report the strongest state', () => {
  assert.deepEqual(M.normalizeThresholds({ close: 90, critical: 80 }), M.DEFAULT_THRESHOLDS);
  assert.deepEqual(M.normalizeThresholds({ close: 75.5, critical: 90 }), M.DEFAULT_THRESHOLDS);
  const next = M.evaluate([{ id: 'a', used: 80, limit: 100 }, { id: 'b', used: 95, limit: 100 }], {}, 1000);
  assert.equal(next.overall, 'critical');
  assert.equal(next.attention, 2);
  assert.equal(M.crossings(null, next).length, 2);
  assert.equal(M.crossings(next, next).length, 0);
});
test('a passed reset clears usage and a rejecting state', () => {
  const r = M.evaluate([{ id: 'a', used: 100, limit: 100, reached: true, resetsAt: 1000 }], {}, 1000);
  assert.equal(r.overall, 'ok');
  assert.equal(r.sources[0].used, 0);
});
test('daily counters roll over at local midnight and reject negative increments', () => {
  const now = new Date(2026, 10, 15, 23, 59).getTime();
  const first = M.addDaily({}, { tokens: 50, dollars: 2 }, now);
  assert.equal(M.addDaily(first, { tokens: -100 }, now).tokens, 50);
  assert.equal(M.dailyCounter(first, M.nextLocalMidnight(now)).tokens, 0);
  assert.equal(M.budgetReadings(first, { tokens: 100 }, now)[0].resetsAt, M.nextLocalMidnight(now));
  assert.equal(M.turnTokens({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 100 }), 118);
});
test('limit readings retain generic and inferred rejections', () => {
  const r = M.planReadings('agent', [{ window: 'possible', reached: true, inferred: true }, { window: 'plan', reached: true }]);
  assert.equal(r.length, 2);
  assert.equal(M.evaluate(r, {}, 1).overall, 'reached');
  assert.equal(M.matchLimitPhrase('quota exceeded'), true);
  assert.equal(M.matchLimitPhrase('unexpected file permissions'), false);
});
test('plan cache converts minor currency units and keeps prior scalar fields', () => {
  const got = M.planCacheFields({ five_hour: { utilization: 80, resets_at: '2026-11-15T16:00:00Z' }, extra_usage: { is_enabled: true, used_credits: 125, monthly_limit: 500 } }, { session_cost: '$2', ws_cost_dollars: '3' }, 'now');
  assert.equal(got.extra_used_dollars, 1.25);
  assert.equal(got.extra_limit_dollars, 5);
  assert.equal(got.session_cost, '$2');
  assert.equal(got.ws_cost_dollars, '3');
});
test('rate limit events parse fractions and seconds with rejection status', () => {
  assert.deepEqual(parseRateLimitInfo({ rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 2000, status: 'allowed_warning' }), { type: 'limit', rejected: false, window: 'short', windows: [{ window: 'short', pct: 90, resetsAt: 2000000, warning: true }] });
  assert.equal(parseRateLimitInfo({ status: 'rejected', resetsAt: 2000 }).resetsAt, 2000000);
  assert.equal(parseRateLimitInfo({}), null);
});

test('session token readings count growth and resumed readings establish a baseline', () => {
  const first = M.usageDelta({}, { type: 'usage', total: 100 });
  assert.equal(first.tokens, 100);
  const same = M.usageDelta(first.state, { type: 'usage', total: 100 });
  assert.equal(same.tokens, 0);
  assert.equal(M.usageDelta(same.state, { type: 'usage', total: 130 }).tokens, 30);
  const resumed = M.usageDelta({ awaitingBaseline: true }, { type: 'usage', total: 1000 });
  assert.equal(resumed.tokens, 0);
  assert.equal(M.usageDelta(resumed.state, { type: 'usage', total: 1010 }).tokens, 10);
});
test('subscription prices are excluded while reported API estimates count', () => {
  const subscription = M.usageDelta({}, { type: 'billing', plan: 'subscription' }).state;
  assert.equal(M.usageDelta(subscription, { type: 'turn_end', costUsd: 2 }).dollars, 0);
  assert.equal(M.usageDelta({}, { type: 'turn_end', costUsd: 0.02 }).dollars, 0.02);
});
