'use strict';

// Third adversarial pass over src/lib/workflow-receipt.js. Every test in this
// file is written to FAIL against the module as it stands: each states a
// property the module's own comments promise, then shows an input for which the
// module does not hold it. When a defect is fixed the test stays as the
// regression that keeps it fixed.
//
// The first four tests are one root cause, and it is one the module has already
// met once and solved once. The comment above the outer walk
// (workflow-receipt.js:593-605) is explicit about it: iterating a
// caller-supplied list with for-of hands the stopping condition to the list,
// because the array iterator asks for `length` on every step, so a row whose own
// accessor appends to the list "is an unbounded loop that no try/catch can
// interrupt: nothing throws, it simply never returns, and the thread it never
// returns to is the Electron main one". The outer walk was rewritten to an
// indexed loop over a count fixed before the first read. The two inner walks
// over `row.steps`, in isCensored and in runTokens, were not, and they read
// from the same file, written by the same hand, with the same hostility budget.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../src/lib/workflow-receipt');
const { aggregateRuns, MAX_SOURCE_RUNS } = R;

const HASH = 'husk-wfg-1:sha256:' + 'a'.repeat(64);
const WF = 'wf-1762000000000';

// No walk in this module may exceed the one budget the module states for
// itself. A per-step walk is entitled to its own constant, but until one exists
// MAX_SOURCE_RUNS is the only ceiling on record, and a walk that passes it by
// two orders of magnitude is not bounded by anything.
const WALK_BUDGET = MAX_SOURCE_RUNS;

// The tests below cannot let the defect run to completion, because the defect
// is non-termination: an appending accessor never lets the loop end, and a
// proxied length of 2^53-1 keeps it going for longer than the process will
// live. Each hostile accessor therefore carries a breaker that throws once it
// has been entered far more times than any bound would allow. The throw is
// caught by the module's own per-row guard, so aggregateRuns returns and the
// assertion gets to run; the count it asserts on is the evidence.
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

// G1. isCensored walks row.steps with for-of. A step whose `timedOut` accessor
// appends another step keeps the array one element ahead of the index forever.
// Nothing here is exotic: plain array, plain object, plain getter, no Proxy and
// no subclass. The process does not throw and does not return; under a real
// Electron main it stops answering IPC, and because the array grows by one
// element per iteration it eventually takes the renderer down with a V8 OOM
// abort, which is the one failure no try/catch in this file can contain.
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

// G2. The same walk, with the allocation removed so the failure is visible as
// what it is. Array.isArray is true for a Proxy whose target is an array
// (the module's own sourceLength comment says so), and the array iterator
// re-reads length on every next(), so a length trap answering
// Number.MAX_SAFE_INTEGER pins a core for the rest of the process's life
// without allocating a byte. This is the shape that hangs rather than crashes,
// which is worse: a crash leaves a stack trace and a hang leaves a support
// ticket that says the app froze while opening the publish sheet.
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

// G3. runTokens holds the second copy of the same loop, so fixing only
// isCensored moves the hang rather than removing it. Here the step that
// censoring reads is inert and the one the token sum reads is the hostile one,
// which is exactly what a row shaped to survive a partial fix would look like.
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

// G4. A run whose steps could not be read to the end is not the same fact as a
// run with no interesting steps, and today it is recorded as the latter: the
// hostile row above lands in `malformed` only because the breaker throws, and a
// row that hangs instead of throwing never lands anywhere. Once the walks carry
// their own budget, a row that exhausts it has to be excluded rather than
// summarised from the prefix that happened to fit, because a token total over
// the first N of an unknown number of steps is a smaller number presented as a
// complete one. This states the property; it will need the same fix.
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

// ─── two absence rules, forty lines apart ────────────────────────────────────

// G5. readUsage says why it reads both key spellings: main.js normalizes
// claude's stream-json usage to camelCase on the autopilot path, "but the
// underlying event carries snake_case and a row written straight from one would
// otherwise read as 'reported nothing'" (workflow-receipt.js:272-281). Its
// `pick` helper treats undefined and null as absence and falls through to the
// other spelling for them. It does not treat zero that way. Twenty lines later
// totalOrNull decides that four zeros are exactly "no report at all", so a
// writer that persists a zero-initialised accumulator next to the raw event
// hits both rules at once: pick reads the zeros as measurements, totalOrNull
// then reads those measurements as nothing, and the 5200 tokens sitting in the
// snake_case fields beside them are never looked at. The row reads as reported
// nothing, which is the outcome the dual-spelling read exists to prevent.
//
// The zero-initialised accumulator is not a straw man. The module's own runTokens
// comment cites main.js:5343 writing `st.ms || 0` as evidence that this codebase
// persists zeroed accumulators, and uses that to justify the steps fallback.
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

// G6. readUsage's contract is stated in its own header: "A record with a field
// present but unusable is rejected whole rather than partially trusted. Half a
// usage record is not a smaller usage record, it is evidence that something
// wrote this file badly, and the honest response to that is to drop the run
// from the token sample." readUsage does return null. runTokens then treats
// that null identically to "the run carried no tokens field at all" and
// substitutes the per-step sum, so the run is not dropped: it is republished at
// whatever the steps happen to add up to. A row whose run total claimed 5000
// input tokens and whose steps carry 1 publishes 1, with nothing anywhere
// saying the authoritative figure was refused.
test('a run whose token record is rejected is dropped rather than restated from its steps', () => {
  const a = agg([row({
    tokens: { input: '5000', output: 200 },
    steps: [{ usage: { input: 1, output: 1 } }],
  })]).aggregate;

  assert.equal(a.medianTokens, null, 'the record was refused, so the run has no token figure to publish');
  assert.equal(a.medianTokensN, 0);
});
