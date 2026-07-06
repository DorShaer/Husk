'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  fromSummary,
  classify,
  estimateSavings,
  buildFleetReceipt,
} = require('../../src/lib/autonomy/receipt');

// A minimal supervisor-summary shape, as buildSummary would return it.
function summary({ status = 'ended', haltReason = 'natural', dollars = 0, tokens = 0,
                   durationMs = 1000, files = 0, caps = {}, signal = null, goal = 'g' } = {}) {
  return {
    ok: true,
    goal,
    caps,
    diff: Array.from({ length: files }, (_, i) => ({ path: `f${i}.js` })),
    summary: {
      status, haltReason, durationMs,
      haltDetail: signal ? { signal } : null,
      meter: { dollars, totalTokens: tokens, caps },
    },
  };
}

test('fromSummary maps meter, diff and halt fields into a row', () => {
  const row = fromSummary(summary({ dollars: 1.5, tokens: 40000, files: 3, haltReason: 'stall', signal: 'loop', caps: { dollars: 5, tokens: 200000 } }), { agent: 'claude' });
  assert.equal(row.agent, 'claude');
  assert.equal(row.dollars, 1.5);
  assert.equal(row.tokens, 40000);
  assert.equal(row.filesChanged, 3);
  assert.equal(row.haltReason, 'stall');
  assert.equal(row.stallSignal, 'loop');
  assert.equal(row.caps.dollars, 5);
});

test('classify buckets each outcome correctly', () => {
  assert.equal(classify(fromSummary(summary({ status: 'ended', files: 2 }))), 'landed');
  assert.equal(classify(fromSummary(summary({ status: 'ended', files: 0 }))), 'empty');
  assert.equal(classify(fromSummary(summary({ haltReason: 'stall', signal: 'idle' }))), 'saved');
  assert.equal(classify(fromSummary(summary({ haltReason: 'budget' }))), 'capped');
  assert.equal(classify(fromSummary(summary({ status: 'cancelled', haltReason: 'user' }))), 'stopped');
});

test('estimateSavings: dollar cap gives cap-minus-spent as the ceiling', () => {
  const row = fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 1.2, tokens: 30000, caps: { dollars: 5, tokens: 200000 } }));
  const sv = estimateSavings(row);
  assert.equal(sv.basis, 'dollarCap');
  assert.equal(sv.dollars, 3.8); // 5 - 1.2
});

test('estimateSavings: no cap and no dollars -> tokens only, no dollar claim', () => {
  const row = fromSummary(summary({ haltReason: 'stall', signal: 'idle', dollars: 0, tokens: 5000, caps: {} }));
  const sv = estimateSavings(row);
  assert.equal(sv.dollars, 0);
  assert.equal(sv.basis, 'none');
});

test('estimateSavings: a non-stalled run has zero savings', () => {
  const row = fromSummary(summary({ status: 'ended', files: 3, dollars: 2, caps: { dollars: 5 } }));
  assert.equal(estimateSavings(row).dollars, 0);
});

test('buildFleetReceipt aggregates spend, counts, and savings across runs', () => {
  const rows = [
    fromSummary(summary({ status: 'ended', files: 4, dollars: 0.8, tokens: 20000, durationMs: 60000 }), { agent: 'claude' }),
    fromSummary(summary({ status: 'ended', files: 2, dollars: 0.5, tokens: 12000, durationMs: 40000 }), { agent: 'copilot' }),
    fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 0.4, tokens: 9000, durationMs: 30000, caps: { dollars: 5, tokens: 200000 } }), { agent: 'claude' }),
    fromSummary(summary({ haltReason: 'stall', signal: 'idle', dollars: 0.44, tokens: 10000, durationMs: 20000, caps: { dollars: 5, tokens: 200000 } }), { agent: 'codex' }),
  ];
  const r = buildFleetReceipt(rows, { label: 'nightly backlog' });
  assert.equal(r.runCount, 4);
  assert.equal(r.counts.landed, 2);
  assert.equal(r.counts.saved, 2);
  assert.equal(r.totalDollars, 2.14);           // 0.8 + 0.5 + 0.4 + 0.44
  assert.equal(r.totalTokens, 51000);
  assert.equal(r.totalDurationMs, 60000);        // parallel: max, not sum
  assert.equal(r.savings.caughtStalls, 2);
  assert.equal(r.savings.dollars, 9.16);         // (5-0.4) + (5-0.44)
  assert.equal(r.agents.find((a) => a.agent === 'claude').runs, 2);
});

test('headline is the compact shareable line', () => {
  const rows = [
    fromSummary(summary({ status: 'ended', files: 4, dollars: 1.7 }), { agent: 'claude' }),
    fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 0.44, caps: { dollars: 5 } }), { agent: 'codex' }),
  ];
  const r = buildFleetReceipt(rows);
  assert.match(r.headline, /2 agents/);
  assert.match(r.headline, /\$2\.14/);
  assert.match(r.headline, /1 landed/);
  assert.match(r.headline, /1 runaway caught \(up to \$4\.56 saved\)/);
});

test('estimated tokens flip the money to a ~ prefix and never claim exactness', () => {
  const rows = [fromSummary(summary({ status: 'ended', files: 1, dollars: 0.3, tokens: 8000 })) ];
  rows[0].tokensEstimated = true;
  const r = buildFleetReceipt(rows);
  assert.match(r.headline, /~\$0\.30/);
  assert.equal(r.tokensEstimated, true);
});

test('empty fleet is safe', () => {
  const r = buildFleetReceipt([]);
  assert.equal(r.runCount, 0);
  assert.equal(r.totalDollars, 0);
  assert.equal(r.savings.dollars, 0);
});
