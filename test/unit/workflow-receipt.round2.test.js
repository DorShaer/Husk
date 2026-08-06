'use strict';

// Second adversarial pass over src/lib/workflow-receipt.js. Every test here is
// written to fail against the module as it stands: each states a property the
// module's own comments or the artifact spec promise, then shows an input for
// which the module does not hold it. When a defect is fixed the test stays as
// the regression that keeps it fixed.
//
// The first four findings are one root cause wearing four faces. The walk
// trusts the caller's container for its length, for its slice and for its
// iterator, and reads each of the three exactly once, in the wrong order:
// sourceRuns and the unread bucket are fixed before the loop, the cap is
// applied through a method the container owns, and the loop itself has no
// bound of its own. A caller that hands over a plain array from JSON.parse
// never notices. Every other read in this file assumes its input is hostile,
// and the container is the one that is taken on trust.

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

// G1. MAX_SOURCE_RUNS calls itself a "hard bound on how much history we will
// walk in one call", and it is the only thing keeping `runs` inside the wire
// schema's 1..10000. It is applied by calling slice on the caller's container,
// so a container that owns its own slice keeps every row, and the aggregate
// then reports a run count the schema refuses while `publishable` says yes.
// The cap has to be enforced by the walk, not requested from the input.
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

// G2. Same cap, same failure, reached without touching a single property on
// the container: an ordinary Array subclass is enough, because slice is looked
// up on the instance.
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

// G3. The for-of walk has no bound of its own, so a row that appends to the
// array while it is being read is walked forever: the array iterator re-reads
// length on every step. The module's header promises that a row which fights
// back "costs itself its place in the tally and nothing else"; here it costs
// the calling process its main thread, which on this codebase is the Electron
// one. The growth below is stopped by hand so this test can terminate at all,
// and the assertion is on how many rows were read, not on how long it took.
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

// G4. sourceRuns and the excluded buckets are published side by side so a
// surface can subtract one from the other and get zero, and unread exists for
// exactly that arithmetic. Both are fixed before the loop from a length read
// once, so a container whose length moves under the walk leaves the surface
// holding a remainder with no name on it.
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

// G5. Every count in the aggregate is a count, and a negative one is not a
// number any surface can render. unread is a subtraction of two lengths taken
// from the caller's container, so it inherits whatever relationship those two
// have, including none.
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

// G6. The all-zero rule and the per-step fallback disagree. runTokens branches
// on whether readUsage produced a record, not on whether that record said
// anything, so a run-level tokens object of four zeros (which the module's own
// rule calls no report at all) short-circuits the branch that would have found
// the real usage on the steps. A recordWorkflowRun that initialises a zero
// accumulator and always writes it, which is the shape ms already has at
// main.js:5343, turns every claude run's token figures into null.
test('an all-zero run total does not hide the usage the steps reported', () => {
  const tokens = R._internal.runTokens({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    steps: [{ usage: { input: 500, output: 200 } }],
  });
  assert.deepEqual(tokens, { input: 500, output: 200, cacheRead: 0, cacheCreate: 0 });
});

// G7. Both key spellings are accepted so a row written straight from a
// stream-json event still reads. The pick helper falls through to the second
// spelling only when the first is undefined, and a JSON null is not undefined,
// so a row that carries both a normalized null and a raw value reports the
// null and drops the number sitting next to it. Every other tier in the same
// record reads fine, so the result is a quietly under-reported total rather
// than a rejected one.
test('an explicit null in one spelling falls through to the other', () => {
  const usage = R._internal.readUsage({ input: null, input_tokens: 500, output_tokens: 20 });
  assert.deepEqual(usage, { input: 500, output: 20, cacheRead: 0, cacheCreate: 0 });
});

// G8. isoStamp refuses a year below 1000 because Date.UTC maps 0..99 onto the
// twentieth century and a first-millennium row is a corrupted field rather
// than a run. The check runs on the year as written, and the offset is applied
// afterwards, so the same corrupted field walks straight through the guard by
// carrying an offset that pushes it back over the boundary.
test('the first-millennium guard is not escapable by an offset', () => {
  assert.equal(R._internal.isoStamp('1000-01-01T00:00:00.000+23:59'), null);
});
