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
// `recorded` puts the diff in the run_summary payload (finish-time truth);
// `live` puts it at top level (recomputed, goes empty after apply/discard).
function summary({ status = 'ended', haltReason = 'natural', dollars = 0, tokens = 0,
                   durationMs = 1000, files = 0, recordedFiles = null, caps = {},
                   signal = null, goal = 'g' } = {}) {
  const liveDiff = Array.from({ length: files }, (_, i) => ({ path: `f${i}.js` }));
  const recDiff = recordedFiles == null ? liveDiff
    : Array.from({ length: recordedFiles }, (_, i) => ({ path: `f${i}.js` }));
  return {
    ok: true, goal, caps, diff: liveDiff,
    summary: { status, haltReason, durationMs, diff: recDiff,
               haltDetail: signal ? { signal } : null,
               meter: { dollars, totalTokens: tokens, caps } },
  };
}

test('fromSummary maps meter, diff and halt fields into a row', () => {
  const row = fromSummary(summary({ dollars: 1.5, tokens: 40000, files: 3, haltReason: 'stall', signal: 'spinning', caps: { dollars: 5, tokens: 200000 } }), { agent: 'claude' });
  assert.equal(row.agent, 'claude');
  assert.equal(row.dollars, 1.5);
  assert.equal(row.filesChanged, 3);
  assert.equal(row.stallSignal, 'spinning');
});

test('fromSummary prefers the recorded diff so an applied run stays "landed"', () => {
  // Worktree applied: live diff empty, but the run_summary recorded 8 files.
  const s = summary({ status: 'ended', files: 0, recordedFiles: 8 });
  const row = fromSummary(s);
  assert.equal(row.filesChanged, 8);
  assert.equal(classify(row), 'landed');
});

test('classify buckets each outcome correctly', () => {
  assert.equal(classify(fromSummary(summary({ status: 'ended', files: 2 }))), 'landed');
  assert.equal(classify(fromSummary(summary({ status: 'ended', files: 0 }))), 'empty');
  assert.equal(classify(fromSummary(summary({ haltReason: 'stall', signal: 'spinning' }))), 'saved');
  assert.equal(classify(fromSummary(summary({ haltReason: 'budget' }))), 'capped');
  assert.equal(classify(fromSummary(summary({ status: 'cancelled', haltReason: 'user' }))), 'stopped');
});

test('estimateSavings projects the run OWN realized rate forward', () => {
  const row = fromSummary(summary({ haltReason: 'stall', signal: 'spinning', dollars: 0.50, tokens: 10000, caps: { dollars: 5, tokens: 100000 } }));
  const sv = estimateSavings(row);
  assert.equal(sv.basis, 'projectedRate');
  // perTok = 0.50/10000; remaining = 100000-10000 = 90000; saved = 90000*perTok = 4.50
  assert.equal(sv.dollars, 4.5);
  assert.equal(sv.tokens, 90000);
});

test('CRITICAL: a flat-rate/$0 run never fabricates dollar savings', () => {
  // Copilot-style: dollars always 0, but the default $5 cap is present. The
  // old code returned $5 here out of thin air. Must be $0, tokens only.
  const row = fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 0, tokens: 9000, caps: { dollars: 5, tokens: 200000 } }), { agent: 'copilot' });
  const sv = estimateSavings(row);
  assert.equal(sv.dollars, 0, 'no dollar claim on a run that cost nothing');
  assert.equal(sv.basis, 'tokensOnly');
  assert.equal(sv.tokens, 191000);
});

test('estimateSavings: an UNCAPPED stall projects the burn rate over the horizon', () => {
  // $1.00 in 2 minutes, no caps. Over a 15-minute unattended horizon that
  // rate projects 7.5x = $7.50 it would have kept burning.
  const row = fromSummary(summary({ haltReason: 'stall', signal: 'spinning', dollars: 1.0, tokens: 20000, durationMs: 120000, caps: {} }));
  const sv = estimateSavings(row, 900000);
  assert.equal(sv.basis, 'projectedRate');
  assert.equal(sv.dollars, 7.5);
});

test('estimateSavings: an uncapped flat-rate stall projects tokens only, no dollars', () => {
  const row = fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 0, tokens: 10000, durationMs: 60000, caps: {} }), { agent: 'copilot' });
  const sv = estimateSavings(row, 900000);
  assert.equal(sv.dollars, 0);
  assert.equal(sv.basis, 'tokensOnly');
});

test('estimateSavings: a non-stalled run has zero savings', () => {
  assert.equal(estimateSavings(fromSummary(summary({ status: 'ended', files: 3, dollars: 2, caps: { dollars: 5 } }))).dollars, 0);
});

test('buildFleetReceipt aggregates spend, counts, and honest savings', () => {
  const rows = [
    fromSummary(summary({ status: 'ended', files: 4, dollars: 0.8, tokens: 20000, durationMs: 60000 }), { agent: 'claude' }),
    fromSummary(summary({ status: 'ended', files: 2, dollars: 0.5, tokens: 12000, durationMs: 40000 }), { agent: 'copilot' }),
    // real-cost stall: projects 4.50 saved
    fromSummary(summary({ haltReason: 'stall', signal: 'spinning', dollars: 0.50, tokens: 10000, durationMs: 30000, caps: { tokens: 100000 } }), { agent: 'claude' }),
    // flat-rate stall: 0 dollars saved, tokens only
    fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 0, tokens: 5000, durationMs: 20000, caps: { tokens: 100000 } }), { agent: 'codex' }),
  ];
  const r = buildFleetReceipt(rows, { label: 'nightly backlog' });
  assert.equal(r.runCount, 4);
  assert.equal(r.counts.landed, 2);
  assert.equal(r.counts.saved, 2);
  assert.equal(r.totalDollars, 1.8);          // 0.8 + 0.5 + 0.5 + 0
  assert.equal(r.totalDurationMs, 60000);      // parallel: max
  assert.equal(r.savings.caughtStalls, 2);
  assert.equal(r.savings.dollars, 4.5);        // only the real-cost stall contributes
});

test('headline shows saved dollars only when they are real', () => {
  const rows = [
    fromSummary(summary({ status: 'ended', files: 4, dollars: 1.7 }), { agent: 'claude' }),
    fromSummary(summary({ haltReason: 'stall', signal: 'spinning', dollars: 0.30, tokens: 6000, caps: { tokens: 100000 } }), { agent: 'claude' }),
  ];
  const r = buildFleetReceipt(rows);
  assert.match(r.headline, /2 agents/);
  assert.match(r.headline, /1 landed/);
  assert.match(r.headline, /1 runaway caught \(up to \$4\.70 saved\)/); // 0.30/6000*94000
});

test('headline omits the dollar clause when savings are flat-rate only', () => {
  const rows = [
    fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 0, tokens: 5000, caps: { tokens: 100000 } }), { agent: 'copilot' }),
  ];
  const r = buildFleetReceipt(rows);
  assert.match(r.headline, /1 runaway caught/);
  assert.doesNotMatch(r.headline, /saved/);
});

test('a fleet that lands nothing reads as no-changes, not a win', () => {
  const rows = [
    fromSummary(summary({ haltReason: 'stall', signal: 'spinning', dollars: 1.2, tokens: 30000, durationMs: 120000, caps: {} })),
    fromSummary(summary({ haltReason: 'stall', signal: 'loop', dollars: 0.9, tokens: 20000, durationMs: 90000, caps: {} })),
  ];
  const r = buildFleetReceipt(rows);
  assert.equal(r.counts.landed, 0);
  assert.equal(r.outcome, 'no-changes');
  assert.match(r.headline, /no changes landed/);
});

test('empty fleet is safe', () => {
  const r = buildFleetReceipt([]);
  assert.equal(r.runCount, 0);
  assert.equal(r.savings.dollars, 0);
});
