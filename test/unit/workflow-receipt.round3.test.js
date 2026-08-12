'use strict';

// Regression tests for the per-step walks in src/lib/workflow-receipt.js, in
// isCensored and runTokens, plus the two rules that decide token absence.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../src/lib/workflow-receipt');
const { aggregateRuns, MAX_SOURCE_RUNS } = R;

const HASH = 'husk-wfg-1:sha256:' + 'a'.repeat(64);
const WF = 'wf-1762000000000';

// MAX_SOURCE_RUNS is the ceiling every walk in the module holds to.
const WALK_BUDGET = MAX_SOURCE_RUNS;

// Each step accessor below carries a breaker that throws once it has been
// entered far past any bound. The module's per-row guard catches the throw, so
// aggregateRuns returns and the assertion runs on the count that was reached.
const BREAKER = WALK_BUDGET * 5;

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

// isCensored walks a step count fixed before its first read.
test('the walk over a run steps is bounded when a step accessor grows the list', () => {
  let entered = 0;
  const steps = [];
  const makeStep = () => ({
    get timedOut() {
      entered += 1;
      if (entered > BREAKER) throw new Error('breaker');
      steps.push(makeStep());
      return false;
    },
    status: 'done',
    ms: 1,
  });
  steps.push(makeStep());

  const res = agg([row({ steps })]);
  assert.equal(res.ok, true);
  assert.ok(
    entered <= WALK_BUDGET,
    `isCensored walked ${entered} steps for one run, past every bound the module states (${WALK_BUDGET}); without the breaker it never stops`,
  );
});

// The same walk over a list that reports a length far past the budget.
test('the walk over a run steps is bounded when the list only claims to be long', () => {
  let indexReads = 0;
  const steps = new Proxy([], {
    get(target, key) {
      if (key === 'length') return Number.MAX_SAFE_INTEGER;
      if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
        indexReads += 1;
        if (indexReads > BREAKER) throw new Error('breaker');
        return { status: 'done', ms: 1 };
      }
      return Reflect.get(target, key);
    },
  });

  const res = agg([row({ steps })]);
  assert.equal(res.ok, true);
  assert.ok(
    indexReads <= WALK_BUDGET,
    `the steps walk read ${indexReads} indices from a list that declares 2^53-1 of them; the count it walks has to be fixed before the first read, as the outer walk already does`,
  );
});

// runTokens walks the same steps list and holds to the same budget.
test('the token sum over a run steps is bounded when a step accessor grows the list', () => {
  let entered = 0;
  const steps = [];
  const makeStep = () => ({
    timedOut: false,
    status: 'done',
    ms: 1,
    get usage() {
      entered += 1;
      if (entered > BREAKER) throw new Error('breaker');
      steps.push(makeStep());
      return null;
    },
  });
  steps.push(makeStep());

  const res = agg([row({ steps })]);
  assert.equal(res.ok, true);
  assert.ok(
    entered <= WALK_BUDGET,
    `runTokens walked ${entered} steps for one run; the bound has to live in both inner walks or the hostile row just moves to the other one`,
  );
});

// A run whose steps exhaust the walk budget is excluded as malformed, rather
// than summarised from the prefix that was read.
test('a run whose steps exceed the walk budget is excluded rather than half counted', () => {
  const steps = [];
  for (let i = 0; i < WALK_BUDGET + 1; i += 1) {
    steps.push({ status: 'done', ms: 1, usage: { input: 1, output: 1 } });
  }

  const res = agg([row({ steps })]);
  assert.equal(res.ok, true);
  assert.equal(res.aggregate.runs, 0, 'a run with more steps than the walk will read cannot contribute a token figure');
  assert.equal(res.aggregate.excluded.malformed, 1);
});

// ─── the two absence rules ───────────────────────────────────────────────────

// readUsage reads both key spellings, since main.js normalizes stream-json
// usage to camelCase while the underlying event carries snake_case. A tier
// zeroed in one spelling reads the raw count beside it.
test('a zeroed camelCase tier does not hide the raw count beside it', () => {
  const a = agg([row({
    tokens: {
      input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
      input_tokens: 5000, output_tokens: 200,
    },
    steps: [],
  })]).aggregate;

  assert.equal(a.medianTokensN, 1, 'the run reported usage, so it belongs in the token sample');
  assert.deepEqual(a.medianTokens, { input: 5000, output: 200, cacheRead: 0, cacheCreate: 0 });
});

// A usage record with a field present but unusable is refused whole, and the
// run leaves the token sample rather than being restated from its steps.
test('a run whose token record is rejected is dropped rather than restated from its steps', () => {
  const a = agg([row({
    tokens: { input: '5000', output: 200 },
    steps: [{ usage: { input: 1, output: 1 } }],
  })]).aggregate;

  assert.equal(a.medianTokens, null, 'the record was refused, so the run has no token figure to publish');
  assert.equal(a.medianTokensN, 0);
});
