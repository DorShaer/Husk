'use strict';

// Regression tests for aggregateRuns in src/lib/workflow-receipt.js, covering
// the source cap, the excluded ledger, token reads and timestamp parsing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../src/lib/workflow-receipt');
const { aggregateRuns } = R;

const HASH = 'husk-wfg-1:sha256:' + 'a'.repeat(64);
const WF = 'wf-1762000000000';

// The wire receipt caps runs at 10000 (spec, "receipts": runs integer 1..10000).
const WIRE_MAX_RUNS = 10000;

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

// MAX_SOURCE_RUNS is the walk's own bound, and it keeps `runs` inside the wire
// schema's 1..10000.
test('the source cap holds even when the container supplies its own slice', () => {
  const big = [];
  for (let i = 0; i < WIRE_MAX_RUNS + 2500; i += 1) big.push(row({ id: `r${i}` }));
  big.slice = function () { return this; };

  const res = agg(big);
  assert.equal(res.ok, true);
  assert.ok(
    res.aggregate.runs <= WIRE_MAX_RUNS,
    `runs came out at ${res.aggregate.runs}, above the wire schema's ${WIRE_MAX_RUNS}`,
  );
  assert.equal(
    res.aggregate.publishable && res.aggregate.runs > WIRE_MAX_RUNS,
    false,
    'an aggregate the schema refuses was reported as publishable',
  );
});

// The same cap, over an ordinary Array subclass.
test('the source cap holds for an array subclass that overrides slice', () => {
  class Sneaky extends Array { slice() { return this; } }
  const runs = new Sneaky();
  for (let i = 0; i < WIRE_MAX_RUNS + 1; i += 1) runs.push(row({ id: `r${i}` }));

  const res = agg(runs);
  assert.equal(res.ok, true);
  assert.ok(
    res.aggregate.runs <= WIRE_MAX_RUNS,
    `runs came out at ${res.aggregate.runs}, above the wire schema's ${WIRE_MAX_RUNS}`,
  );
});

// The walk reads a count fixed before its first read. The ceiling below caps
// the row growth so the test terminates, and the assertion is on rows read.
test('a runs array that grows while it is read is still bounded by the cap', () => {
  const runs = [];
  let reads = 0;
  const ceiling = R.MAX_SOURCE_RUNS * 3;
  const evil = {
    graphHash: HASH,
    status: 'done',
    startedAt: '2026-02-06T10:00:00.000Z',
    ms: 1000,
    steps: [],
    get workflowId() {
      reads += 1;
      if (runs.length < ceiling) runs.push(evil);
      return WF;
    },
  };
  runs.push(evil);

  const res = agg(runs);
  assert.equal(res.ok, true);
  assert.ok(
    reads <= R.MAX_SOURCE_RUNS,
    `the walk read ${reads} rows, past its own hard bound of ${R.MAX_SOURCE_RUNS}`,
  );
  assert.ok(
    res.aggregate.runs <= WIRE_MAX_RUNS,
    `runs came out at ${res.aggregate.runs}, above the wire schema's ${WIRE_MAX_RUNS}`,
  );
});

// sourceRuns and the excluded buckets are published side by side so a surface
// can subtract one from the other and get zero. unread exists for that sum.
test('the ledger still reconciles when the container length moves under the walk', () => {
  const runs = [];
  for (let i = 0; i < 10; i += 1) runs.push(row({ id: `r${i}` }));
  Object.defineProperty(runs[0], 'workflowId', {
    get() { runs.length = 2; return WF; },
    enumerable: true,
  });

  const a = agg(runs).aggregate;
  const accounted = a.runs + Object.values(a.excluded).reduce((x, y) => x + y, 0);
  assert.equal(
    accounted,
    a.sourceRuns,
    `${accounted} rows accounted for out of ${a.sourceRuns}: ${JSON.stringify(a.excluded)}`,
  );
});

// Every count in the aggregate is a non-negative integer.
test('no excluded bucket is ever negative', () => {
  const big = [];
  for (let i = 0; i < R.MAX_SOURCE_RUNS + 1; i += 1) big.push(row({ id: `r${i}` }));
  big.slice = function () {
    const out = this.concat(this);
    out.slice = Array.prototype.slice;
    return out;
  };

  const a = agg(big).aggregate;
  for (const [bucket, n] of Object.entries(a.excluded)) {
    assert.ok(Number.isInteger(n) && n >= 0, `excluded.${bucket} is ${n}`);
  }
});

// A run total of four zeros counts as no report, so runTokens falls through to
// the per-step usage sum.
test('an all-zero run total does not hide the usage the steps reported', () => {
  const tokens = R._internal.runTokens({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    steps: [{ usage: { input: 500, output: 200 } }],
  });
  assert.deepEqual(tokens, { input: 500, output: 200, cacheRead: 0, cacheCreate: 0 });
});

// Both key spellings are accepted so a row written straight from a stream-json
// event still reads. An absent value in one spelling reads the other.
test('an explicit null in one spelling falls through to the other', () => {
  const usage = R._internal.readUsage({ input: null, input_tokens: 500, output_tokens: 20 });
  assert.deepEqual(usage, { input: 500, output: 20, cacheRead: 0, cacheCreate: 0 });
});

// isoStamp confines timestamps to years from 1000 on, offset included.
test('the first-millennium guard is not escapable by an offset', () => {
  assert.equal(R._internal.isoStamp('1000-01-01T00:00:00.000+23:59'), null);
});
