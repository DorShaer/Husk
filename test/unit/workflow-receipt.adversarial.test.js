'use strict';

// Adversarial probes against src/lib/workflow-receipt.js. Every test in this
// file is written to FAIL against the current implementation: each one states
// a property the module's own header or the artifact spec promises, and then
// demonstrates an input for which the module does not hold it. When a defect
// is fixed the test stays as the regression that keeps it fixed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../src/lib/workflow-receipt');
const { aggregateRuns } = R;

const HASH = 'husk-wfg-1:sha256:' + 'a'.repeat(64);
const WF = 'wf-1762000000000';

function row(over = {}) {
  return Object.assign({
    id: 'run-1',
    workflowId: WF,
    graphHash: HASH,
    status: 'done',
    startedAt: '2026-02-06T10:00:00.000Z',
    finishedAt: '2026-02-06T10:02:00.000Z',
    ms: 120000,
    steps: [],
  }, over);
}

function agg(runs, opts = {}) {
  return aggregateRuns(runs, Object.assign({ workflowId: WF, graphHash: HASH }, opts));
}

// F1. The house contract for src/lib is that an exported function refuses,
// never throws. A row whose property access raises is the cheapest way to make
// this one throw: nothing in aggregateRuns is guarded, so the exception walks
// straight out of the library and into whatever was rendering the card.
test('a run row with a throwing accessor is refused rather than propagated', () => {
  const hostile = row();
  Object.defineProperty(hostile, 'status', { get() { throw new Error('boom'); }, enumerable: true });
  let res;
  assert.doesNotThrow(() => { res = agg([hostile]); });
  assert.equal(typeof res.ok, 'boolean');
});

test('a proxied run row is refused rather than propagated', () => {
  const hostile = new Proxy(row(), { get() { throw new Error('boom'); } });
  let res;
  assert.doesNotThrow(() => { res = agg([hostile]); });
  assert.equal(typeof res.ok, 'boolean');
});

test('an opts object with a throwing accessor is refused rather than propagated', () => {
  const opts = { graphHash: HASH };
  Object.defineProperty(opts, 'workflowId', { get() { throw new Error('boom'); }, enumerable: true });
  let res;
  assert.doesNotThrow(() => { res = aggregateRuns([], opts); });
  assert.equal(res.ok, false);
});

// F2. The module header claims no clock and no I/O, which is what makes it
// testable and what makes two machines agree on one history. isoStamp reaches
// the host timezone database through Date.parse, so a timestamp carrying no
// offset publishes a different window on every machine that reads it.
test('the published window does not depend on the host timezone', () => {
  const offsetless = row({ startedAt: '2026-02-06T10:00:00', finishedAt: '2026-02-06T10:02:00' });
  const seen = new Set();
  const original = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      process.env.TZ = tz;
      seen.add(agg([offsetless]).aggregate.window.firstRunAt);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
  assert.equal(seen.size, 1, `one history produced ${seen.size} different windows: ${[...seen].join(', ')}`);
});

// F3. "A quantity that cannot be honestly computed is null, never zero", and
// slice 7 is done when a run that reported nothing yields medianTokens null
// "rather than zeros". The per-run rule holds, but four independent medians
// can each land on zero while every contributing run reported real usage, so
// the aggregate publishes exactly the row of zeros the rule forbids.
test('the aggregate never publishes a token record whose every field is zero', () => {
  const a = agg([
    row({ id: '1', tokens: { input: 1, output: 0, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '2', tokens: { input: 0, output: 1, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '3', tokens: { input: 0, output: 0, cacheRead: 1, cacheCreate: 0 } }),
  ]).aggregate;
  assert.equal(a.medianTokensN, 3);
  const allZero = a.medianTokens !== null && Object.values(a.medianTokens).every((v) => v === 0);
  assert.equal(allZero, false, `medianTokens published as ${JSON.stringify(a.medianTokens)} from ${a.medianTokensN} reporting runs`);
});

// F4. The wire receipt marks medianTokens and chain nullable and does not mark
// window or medianDurationMs nullable, so an aggregate carrying null in either
// with runs >= 1 cannot be published. medianDurationExceedsMax exists precisely
// so the caller learns about an unpublishable figure without inspecting it, and
// these two unpublishable states arrive with no flag at all.
test('an aggregate that cannot be published says so, as it does for an over-long median', () => {
  const a = agg([row({ startedAt: 'yesterday', finishedAt: 'tomorrow', ms: undefined })]).aggregate;
  assert.equal(a.runs, 1);
  assert.equal(a.window, null);
  assert.equal(a.medianDurationMs, null);
  assert.ok(
    Object.keys(a).some((k) => /publish|incomplete|missing/i.test(k)),
    `runs=1 with window=null and medianDurationMs=null carries no flag saying it is unpublishable: ${Object.keys(a).join(', ')}`,
  );
});

// F5. The canonicalization rules require negative zero to be normalised before
// serialisation. safeCount admits -0 because -0 < 0 is false, and Math.floor
// and Math.round both preserve it, so it travels all the way to the figures a
// caller is about to hand to the schema.
test('negative zero is normalised out of every published figure', () => {
  const parsed = JSON.parse(`[{"workflowId":${JSON.stringify(WF)},"graphHash":${JSON.stringify(HASH)},"status":"done","ms":-0}]`);
  const a = agg(parsed).aggregate;
  assert.equal(Object.is(a.medianDurationMs, -0), false, 'medianDurationMs is -0');
  assert.equal(Object.is(a.durationRangeMs.min, -0), false, 'durationRangeMs.min is -0');
});

// F6. Every other input is validated and refused by name. historyMax and
// stepTimeoutMs are folded through `safeCount(...) || DEFAULT`, so a zero, a
// negative and a string all silently become the default: a caller that asked
// for a 60 second kill threshold, or for zero, is answered with 300000 and
// told nothing.
//
// 0 was in this list and is not any more, because it cannot be: the next test
// requires a stepTimeoutMs of 0 to be honoured, and a value cannot be both
// refused and honoured in the same call. 0 is a meaningful threshold ("treat
// any failed step as censored") rather than an unusable one, which is what the
// finding this test came from says in its own prose. The remaining five are
// the values with no reading at all, and each is refused by name.
test('an unusable historyMax or stepTimeoutMs is refused rather than silently defaulted', () => {
  for (const bad of [-1, 'sixty', NaN, Infinity, 1e308]) {
    const res = aggregateRuns([], { workflowId: WF, graphHash: HASH, stepTimeoutMs: bad });
    assert.equal(res.ok, false, `stepTimeoutMs ${String(bad)} was accepted`);
    assert.match(res.error, /stepTimeoutMs/);
    const other = aggregateRuns([], { workflowId: WF, graphHash: HASH, historyMax: bad });
    assert.equal(other.ok, false, `historyMax ${String(bad)} was accepted`);
    assert.match(other.error, /historyMax/);
  }
});

test('a zero step timeout is honoured rather than replaced by the default', () => {
  const runs = [row({ status: 'failed', steps: [{ status: 'failed', ms: 5 }] })];
  assert.equal(agg(runs, { stepTimeoutMs: 0 }).aggregate.durationCensored, 1);
});

// F7. excluded exists so a surface can explain a thin receipt. A row with no
// workflowId is junk, not another workflow's history, and counting it as
// otherWorkflow tells the reader a story about workflows they do not have.
test('a row with no workflowId is malformed, not another workflow', () => {
  const a = agg([row(), { graphHash: HASH, status: 'done', ms: 1000 }]).aggregate;
  assert.equal(a.runs, 1);
  assert.equal(a.excluded.malformed, 1, `counted as ${JSON.stringify(a.excluded)}`);
});

// F8. sourceRuns is published next to excluded so the two can be reconciled,
// but rows past MAX_SOURCE_RUNS are dropped before the loop and land in no
// bucket at all, so the arithmetic a surface would naturally do is wrong by
// however many rows were discarded.
test('runs plus the excluded buckets account for every source row', () => {
  const many = [];
  for (let i = 0; i < R.MAX_SOURCE_RUNS + 25; i += 1) many.push(row({ id: `r${i}`, workflowId: 'wf-other' }));
  const a = agg(many).aggregate;
  const accounted = a.runs + Object.values(a.excluded).reduce((x, y) => x + y, 0);
  assert.equal(accounted, a.sourceRuns, `${accounted} rows accounted for out of ${a.sourceRuns}`);
});
