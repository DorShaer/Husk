'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../../src/lib/workflow-receipt');
const { aggregateRuns } = R;
const { median, isoStamp, readUsage, runTokens, runDurationMs, isCensored, outcomeBucket } = R._internal;

const HASH = 'husk-wfg-1:sha256:' + 'a'.repeat(64);
const OTHER_HASH = 'husk-wfg-1:sha256:' + 'b'.repeat(64);
const WF = 'wf-1762000000000';

// One run row in the shape main.js records, plus graphHash, timedOut and
// per-run tokens. Defaults are a clean two minute run.
function row(over = {}) {
  const startedAt = over.startedAt !== undefined ? over.startedAt : '2026-02-06T10:00:00.000Z';
  return Object.assign({
    id: 'run-1',
    workflowId: WF,
    graphHash: HASH,
    workflowName: 'Triage, patch, verify',
    status: 'done',
    startedAt,
    finishedAt: '2026-02-06T10:02:00.000Z',
    ms: 120000,
    steps: [],
    edgesTaken: [],
    failedStep: '',
  }, over);
}

// n runs with the given durations, each started a minute after the last so the
// window has something ordered to find.
function runsWithMs(list, over = {}) {
  return list.map((ms, i) => row(Object.assign({
    id: `run-${i}`,
    ms,
    startedAt: new Date(Date.UTC(2026, 0, 9, 8, i, 0)).toISOString(),
  }, over)));
}

function ok(runs, opts = {}) {
  const res = aggregateRuns(runs, Object.assign({ workflowId: WF, graphHash: HASH }, opts));
  assert.equal(res.ok, true, res.error);
  return res.aggregate;
}

// ─── input validation ────────────────────────────────────────────────────────

test('refuses anything but an array of runs, and never throws doing it', () => {
  for (const bad of [null, undefined, 'runs', 42, {}, { length: 3 }, new Set()]) {
    const res = aggregateRuns(bad, { workflowId: WF, graphHash: HASH });
    assert.equal(res.ok, false);
    assert.match(res.error, /array/);
  }
});

test('refuses a missing or unusable workflowId', () => {
  for (const bad of [undefined, '', null, 7, {}, 'x'.repeat(257)]) {
    const res = aggregateRuns([], { workflowId: bad, graphHash: HASH });
    assert.equal(res.ok, false);
    assert.match(res.error, /workflowId/);
  }
});

test('refuses a missing or unusable graphHash, since unfiltered runs are another program', () => {
  for (const bad of [undefined, '', null, 7, {}, 'has spaces', 'x'.repeat(201), '<script>']) {
    const res = aggregateRuns([], { workflowId: WF, graphHash: bad });
    assert.equal(res.ok, false);
    assert.match(res.error, /graphHash/);
  }
});

test('refuses opts that is not an object', () => {
  for (const bad of [null, undefined, 'wf', 3, []]) {
    const res = aggregateRuns([], bad);
    assert.equal(res.ok, false);
  }
});

// ─── 0, 1, 2 and 31 runs ─────────────────────────────────────────────────────

test('zero runs aggregates to an empty record rather than an error', () => {
  const a = ok([]);
  assert.equal(a.runs, 0);
  assert.equal(a.medianDurationMs, null);
  assert.equal(a.medianDurationN, 0);
  assert.equal(a.medianTokens, null);
  assert.equal(a.medianTokensN, 0);
  assert.equal(a.durationRangeMs, null);
  assert.equal(a.window, null);
  assert.equal(a.durationCensored, 0);
  assert.equal(a.precision, 'none');
  assert.deepEqual(a.outcomes, { completed: 0, failed: 0, stopped: 0, timedOut: 0 });
  assert.equal(a.outcomeBasis, 'process-exit');
});

test('one run reports that run and calls its precision single', () => {
  const a = ok(runsWithMs([90000]));
  assert.equal(a.runs, 1);
  assert.equal(a.medianDurationMs, 90000);
  assert.equal(a.medianDurationN, 1);
  assert.equal(a.precision, 'single');
  assert.deepEqual(a.durationRangeMs, { min: 90000, max: 90000 });
  assert.deepEqual(a.outcomes, { completed: 1, failed: 0, stopped: 0, timedOut: 0 });
  assert.deepEqual(a.window, { firstRunAt: '2026-01-09T08:00:00.000Z', lastRunAt: '2026-01-09T08:00:00.000Z' });
});

test('two runs are a range, and the figure is the mean of the pair', () => {
  const a = ok(runsWithMs([60000, 180000]));
  assert.equal(a.runs, 2);
  assert.equal(a.precision, 'range');
  assert.equal(a.medianDurationMs, 120000);
  assert.deepEqual(a.durationRangeMs, { min: 60000, max: 180000 });
});

test('three or more runs earn the word median', () => {
  assert.equal(ok(runsWithMs([1, 2, 3])).precision, 'median');
  assert.equal(ok(runsWithMs([1, 2, 3, 4])).precision, 'median');
});

test('thirty-one runs produce the sixteenth value and a tally that sums to runs', () => {
  // 1000..31000 shuffled, so a correct median cannot come from insertion order.
  const values = [];
  for (let i = 1; i <= 31; i += 1) values.push(i * 1000);
  const shuffled = values.slice(16).concat(values.slice(0, 16).reverse());
  const a = ok(runsWithMs(shuffled));
  assert.equal(a.runs, 31);
  assert.equal(a.medianDurationMs, 16000);
  assert.equal(a.medianDurationN, 31);
  assert.equal(a.precision, 'median');
  const { completed, failed, stopped, timedOut } = a.outcomes;
  assert.equal(completed + failed + stopped + timedOut, a.runs);
});

test('the worked example shape: 26 completed, 4 failed, 1 killed, censored once', () => {
  const runs = [];
  for (let i = 0; i < 26; i += 1) runs.push(row({ id: `c${i}`, ms: 288000, status: 'done' }));
  for (let i = 0; i < 4; i += 1) runs.push(row({ id: `f${i}`, ms: 100000, status: 'failed' }));
  runs.push(row({ id: 'k', ms: 320000, status: 'failed', timedOut: true }));
  const a = ok(runs);
  assert.equal(a.runs, 31);
  assert.deepEqual(a.outcomes, { completed: 26, failed: 4, stopped: 0, timedOut: 1 });
  assert.equal(a.durationCensored, 1);
  assert.equal(a.medianDurationMs, 288000);
});

// ─── the even-count median rule ──────────────────────────────────────────────

test('an even sample takes the mean of the two middle values, not the lower one', () => {
  assert.equal(median([100, 200, 300, 400]), 250);
  assert.equal(median([1, 2]), 1.5);
  assert.equal(ok(runsWithMs([100, 200, 300, 401])).medianDurationMs, 250);
});

test('an odd sample takes the middle value', () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([9]), 9);
});

test('a half millisecond median rounds to an integer, since the wire format is integral', () => {
  const a = ok(runsWithMs([100, 201]));
  assert.equal(a.medianDurationMs, 151);
  assert.equal(Number.isInteger(a.medianDurationMs), true);
});

test('the median does not depend on the order runs arrive in', () => {
  const asc = ok(runsWithMs([10, 20, 30, 40, 50])).medianDurationMs;
  const desc = ok(runsWithMs([50, 40, 30, 20, 10])).medianDurationMs;
  const mixed = ok(runsWithMs([30, 10, 50, 20, 40])).medianDurationMs;
  assert.equal(asc, 30);
  assert.equal(desc, 30);
  assert.equal(mixed, 30);
});

// ─── filtering by workflowId and graphHash ───────────────────────────────────

test('runs from another workflow are excluded and counted', () => {
  const a = ok([row(), row({ id: 'x', workflowId: 'wf-other' })]);
  assert.equal(a.runs, 1);
  assert.equal(a.excluded.otherWorkflow, 1);
});

test('runs from an edited graph are excluded: they are receipts for a different program', () => {
  const a = ok([row(), row({ id: 'x', graphHash: OTHER_HASH })]);
  assert.equal(a.runs, 1);
  assert.equal(a.excluded.otherGraph, 1);
});

test('runs with no fingerprint are counted apart from runs on another fingerprint', () => {
  const a = ok([row(), row({ id: 'a', graphHash: undefined }), row({ id: 'b', graphHash: '' }), row({ id: 'c', graphHash: 12 })]);
  assert.equal(a.runs, 1);
  assert.equal(a.excluded.unhashed, 3);
  assert.equal(a.excluded.otherGraph, 0);
});

test('fingerprint comparison is exact, so case and whitespace are different graphs', () => {
  const a = ok([
    row({ id: 'up', graphHash: HASH.toUpperCase() }),
    row({ id: 'pad', graphHash: `${HASH} ` }),
    row({ id: 'short', graphHash: HASH.slice(0, 24) }),
  ]);
  assert.equal(a.runs, 0);
  assert.equal(a.excluded.otherGraph, 3);
});

test('the aggregate echoes the identity it filtered on', () => {
  const a = ok([row()]);
  assert.equal(a.workflowId, WF);
  assert.equal(a.graphHash, HASH);
});

// ─── outcomes ────────────────────────────────────────────────────────────────

test('each terminal status lands in its bucket', () => {
  const a = ok([
    row({ id: '1', status: 'done' }),
    row({ id: '2', status: 'completed' }),
    row({ id: '3', status: 'failed' }),
    row({ id: '4', status: 'stopped' }),
    row({ id: '5', status: 'cancelled' }),
  ]);
  assert.deepEqual(a.outcomes, { completed: 2, failed: 1, stopped: 2, timedOut: 0 });
  assert.equal(a.runs, 5);
});

test('a run still in flight is excluded, so outcomes always sum to runs', () => {
  const a = ok([row({ id: '1' }), row({ id: '2', status: 'running' }), row({ id: '3', status: '' }), row({ id: '4', status: 'weird' })]);
  assert.equal(a.runs, 1);
  assert.equal(a.excluded.unfinished, 3);
  const { completed, failed, stopped, timedOut } = a.outcomes;
  assert.equal(completed + failed + stopped + timedOut, a.runs);
});

test('a killed run is reported as timedOut rather than as a plain failure', () => {
  const a = ok([row({ status: 'failed', timedOut: true })]);
  assert.deepEqual(a.outcomes, { completed: 0, failed: 0, stopped: 0, timedOut: 1 });
});

test('a run the user stopped stays stopped even when a step was killed', () => {
  const a = ok([row({ status: 'stopped', timedOut: true })]);
  assert.deepEqual(a.outcomes, { completed: 0, failed: 0, stopped: 1, timedOut: 0 });
  assert.equal(a.durationCensored, 1);
});

test('outcomeBucket is total over hostile status values', () => {
  for (const bad of [null, undefined, 5, {}, [], 'DONE']) {
    assert.equal(outcomeBucket(bad, false), null);
  }
});

// ─── durationCensored ────────────────────────────────────────────────────────

test('durationCensored counts runs whose steps hit the per-step kill', () => {
  const a = ok([
    row({ id: '1', ms: 100000, status: 'done' }),
    row({ id: '2', ms: 305000, status: 'failed', steps: [{ name: 'Verify', status: 'failed', ms: 300001 }] }),
    row({ id: '3', ms: 302000, status: 'failed', steps: [{ name: 'Verify', status: 'failed', ms: 300000, timedOut: true }] }),
  ]);
  assert.equal(a.durationCensored, 2);
  assert.equal(a.outcomes.timedOut, 2);
});

test('a step that failed just under the kill is not censored', () => {
  const a = ok([row({ status: 'failed', steps: [{ status: 'failed', ms: 299999 }] })]);
  assert.equal(a.durationCensored, 0);
  assert.equal(a.outcomes.failed, 1);
});

test('a long step that succeeded is not censored, because the kill always fails a step', () => {
  const a = ok([row({ status: 'done', steps: [{ status: 'done', ms: 400000 }] })]);
  assert.equal(a.durationCensored, 0);
  assert.equal(a.outcomes.completed, 1);
});

test('the censoring threshold follows the caller when the per-step kill changes', () => {
  const runs = [row({ status: 'failed', steps: [{ status: 'failed', ms: 60000 }] })];
  assert.equal(ok(runs).durationCensored, 0);
  assert.equal(ok(runs, { stepTimeoutMs: 60000 }).durationCensored, 1);
});

test('censored runs stay in the duration sample, so the median is not quietly de-biased', () => {
  const a = ok([
    row({ id: '1', ms: 10000, status: 'done' }),
    row({ id: '2', ms: 20000, status: 'done' }),
    row({ id: '3', ms: 300000, status: 'failed', timedOut: true }),
  ]);
  assert.equal(a.medianDurationN, 3);
  assert.equal(a.medianDurationMs, 20000);
  assert.equal(a.durationCensored, 1);
});

test('isCensored survives rows whose steps are junk', () => {
  assert.equal(isCensored({ steps: 'nope' }, 300000), false);
  assert.equal(isCensored({ steps: [null, 3, 'x', []] }, 300000), false);
  assert.equal(isCensored({}, 300000), false);
});

// ─── runsWindowed ────────────────────────────────────────────────────────────

test('runsWindowed is true once the source history is at the trim limit', () => {
  const under = runsWithMs(new Array(199).fill(1000));
  const at = runsWithMs(new Array(200).fill(1000));
  assert.equal(ok(under).runsWindowed, false);
  assert.equal(ok(at).runsWindowed, true);
});

test('runsWindowed counts every row read, not just the matching ones', () => {
  const mine = runsWithMs(new Array(5).fill(1000));
  const theirs = new Array(195).fill(0).map((_, i) => row({ id: `o${i}`, workflowId: 'wf-other' }));
  const a = ok(mine.concat(theirs));
  assert.equal(a.runs, 5);
  assert.equal(a.sourceRuns, 200);
  assert.equal(a.runsWindowed, true);
});

test('a caller that trimmed the list itself can still declare the window', () => {
  const a = ok(runsWithMs([1000]), { sourceTruncated: true });
  assert.equal(a.runsWindowed, true);
});

test('a caller with a different history limit gets that limit honoured', () => {
  const runs = runsWithMs(new Array(20).fill(1000));
  assert.equal(ok(runs, { historyMax: 50 }).runsWindowed, false);
  assert.equal(ok(runs, { historyMax: 20 }).runsWindowed, true);
});

test('an absurd history is bounded, kept newest first, and reported as windowed', () => {
  const runs = runsWithMs(new Array(R.MAX_SOURCE_RUNS + 10).fill(1000));
  const a = ok(runs);
  assert.equal(a.sourceRuns, R.MAX_SOURCE_RUNS + 10);
  assert.equal(a.runs, R.MAX_SOURCE_RUNS);
  assert.equal(a.runsWindowed, true);
});

// ─── tokens ──────────────────────────────────────────────────────────────────

test('a claude run records a median from the tokens it reported', () => {
  const runs = [
    row({ id: '1', tokens: { input: 9000, output: 800, cacheRead: 12000, cacheCreate: 0 } }),
    row({ id: '2', tokens: { input: 9110, output: 806, cacheRead: 12800, cacheCreate: 0 } }),
    row({ id: '3', tokens: { input: 9200, output: 900, cacheRead: 13000, cacheCreate: 10 } }),
  ];
  const a = ok(runs);
  assert.deepEqual(a.medianTokens, { input: 9110, output: 806, cacheRead: 12800, cacheCreate: 0 });
  assert.equal(a.medianTokensN, 3);
});

test('a vendor that reports no usage gets null, never a row of zeros', () => {
  const a = ok([row({ id: '1' }), row({ id: '2' }), row({ id: '3' })]);
  assert.equal(a.medianTokens, null);
  assert.equal(a.medianTokensN, 0);
  assert.equal(a.runs, 3);
});

test('an all-zero usage record is no report at all, so it does not manufacture a zero median', () => {
  const zeros = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const a = ok([row({ id: '1', tokens: zeros }), row({ id: '2', tokens: zeros })]);
  assert.equal(a.medianTokens, null);
  assert.equal(a.medianTokensN, 0);
});

test('four medians that all land on zero are no report either, and the count still says so', () => {
  // Every run here reported real usage, so medianTokensN stays at 3 while the
  // four independent medians all land on zero.
  const a = ok([
    row({ id: '1', tokens: { input: 1, output: 0, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '2', tokens: { input: 0, output: 1, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '3', tokens: { input: 0, output: 0, cacheRead: 1, cacheCreate: 0 } }),
  ]);
  assert.equal(a.medianTokens, null);
  assert.equal(a.medianTokensN, 3);
});

test('the token sample carries its own count when only some runs reported', () => {
  const a = ok([
    row({ id: '1', tokens: { input: 100, output: 10, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '2' }),
    row({ id: '3' }),
  ]);
  assert.equal(a.runs, 3);
  assert.equal(a.medianTokensN, 1);
  assert.deepEqual(a.medianTokens, { input: 100, output: 10, cacheRead: 0, cacheCreate: 0 });
});

test('each token field is its own median over the reporting runs', () => {
  const a = ok([
    row({ id: '1', tokens: { input: 10, output: 900, cacheRead: 1, cacheCreate: 0 } }),
    row({ id: '2', tokens: { input: 20, output: 500, cacheRead: 2, cacheCreate: 0 } }),
    row({ id: '3', tokens: { input: 30, output: 100, cacheRead: 3, cacheCreate: 0 } }),
  ]);
  assert.deepEqual(a.medianTokens, { input: 20, output: 500, cacheRead: 2, cacheCreate: 0 });
});

test('an even token sample uses the same mean-of-two-middles rule and stays integral', () => {
  const a = ok([
    row({ id: '1', tokens: { input: 100, output: 1, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '2', tokens: { input: 201, output: 2, cacheRead: 0, cacheCreate: 0 } }),
  ]);
  assert.deepEqual(a.medianTokens, { input: 151, output: 2, cacheRead: 0, cacheCreate: 0 });
  assert.equal(Number.isInteger(a.medianTokens.output), true);
});

test('per-step usage is summed when the run carries no total', () => {
  const a = ok([row({
    tokens: undefined,
    steps: [
      { name: 'Reproduce', status: 'done', ms: 1000, usage: { input: 100, output: 20, cacheRead: 5, cacheCreate: 1 } },
      { name: 'Patch', status: 'done', ms: 1000, usage: { input: 300, output: 40, cacheRead: 5, cacheCreate: 0 } },
      { name: 'Report', status: 'done', ms: 1000 },
    ],
  })]);
  assert.deepEqual(a.medianTokens, { input: 400, output: 60, cacheRead: 10, cacheCreate: 1 });
});

test('the stream-json spelling of a usage record is read as well as the normalized one', () => {
  assert.deepEqual(
    readUsage({ input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 }),
    { input: 5, output: 6, cacheRead: 7, cacheCreate: 8 },
  );
});

test('a usage record with an unusable field is dropped whole, not partly believed', () => {
  for (const bad of [NaN, Infinity, -1, '900', true, {}, [], 1e308, 1.5e16]) {
    assert.equal(readUsage({ input: 100, output: bad }), null, `expected null for ${String(bad)}`);
  }
});

test('a field that is simply absent reads as zero, since JSON writes a missing tier as null', () => {
  assert.equal(readUsage({ input: 100, output: undefined }).output, 0);
  assert.equal(readUsage({ input: 100, output: null }).output, 0);
  assert.deepEqual(readUsage({ input: 100 }), { input: 100, output: 0, cacheRead: 0, cacheCreate: 0 });
});

test('usage that is not an object reports nothing rather than throwing', () => {
  for (const bad of [null, undefined, 'x', 7, [], true]) assert.equal(readUsage(bad), null);
  for (const bad of [null, undefined, 'x', 7, true]) assert.equal(runTokens({ tokens: bad }), null);
});

test('a run whose totals are hostile falls out of the token sample without poisoning it', () => {
  const a = ok([
    row({ id: '1', tokens: { input: 10, output: 10, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '2', tokens: { input: Number.MAX_VALUE, output: 1, cacheRead: 0, cacheCreate: 0 } }),
    row({ id: '3', tokens: { input: -5, output: 1, cacheRead: 0, cacheCreate: 0 } }),
  ]);
  assert.equal(a.runs, 3);
  assert.equal(a.medianTokensN, 1);
  assert.deepEqual(a.medianTokens, { input: 10, output: 10, cacheRead: 0, cacheCreate: 0 });
});

test('there is no dollar figure anywhere in the aggregate', () => {
  const a = ok([row({ tokens: { input: 100000, output: 50000, cacheRead: 0, cacheCreate: 0 } })]);
  const keys = JSON.stringify(a).toLowerCase();
  assert.equal(keys.includes('dollar'), false);
  assert.equal(keys.includes('cost'), false);
  assert.equal(keys.includes('usd'), false);
});

// ─── durations and the window ────────────────────────────────────────────────

test('a missing ms falls back to the run timestamps', () => {
  const a = ok([row({ ms: undefined, startedAt: '2026-02-06T10:00:00.000Z', finishedAt: '2026-02-06T10:04:30.000Z' })]);
  assert.equal(a.medianDurationMs, 270000);
});

test('a run with no usable duration still counts in the tally but not in the median', () => {
  const a = ok([
    row({ id: '1', ms: 60000 }),
    row({ id: '2', ms: undefined, startedAt: 'not a date', finishedAt: 'also not' }),
    row({ id: '3', ms: -5, startedAt: '2026-02-06T10:05:00.000Z', finishedAt: '2026-02-06T10:00:00.000Z' }),
  ]);
  assert.equal(a.runs, 3);
  assert.equal(a.medianDurationN, 1);
  assert.equal(a.medianDurationMs, 60000);
  assert.equal(a.outcomes.completed, 3);
});

test('runDurationMs refuses values it cannot defend', () => {
  assert.equal(runDurationMs({ ms: NaN, startedAt: null, finishedAt: null }), null);
  assert.equal(runDurationMs({ ms: Infinity }), null);
  assert.equal(runDurationMs({ ms: '1000' }), null);
  assert.equal(runDurationMs({ ms: 1000.7 }), 1000);
});

test('the window spans the first and last run start, normalized to the wire form', () => {
  const a = ok([
    row({ id: '1', startedAt: '2026-01-09T08:11:03.22Z' }),
    row({ id: '2', startedAt: '2026-02-06T09:35:00.860Z' }),
    row({ id: '3', startedAt: '2026-01-20T00:00:00.000Z' }),
  ]);
  assert.deepEqual(a.window, { firstRunAt: '2026-01-09T08:11:03.220Z', lastRunAt: '2026-02-06T09:35:00.860Z' });
  assert.equal(a.window.firstRunAt.length, 24);
});

test('timestamps that cannot be published are left out of the window', () => {
  for (const bad of ['', 'yesterday', '2026-13-45T99:99:99Z', 12, null, {}, '+275760-09-13T00:00:00.000Z', 'x'.repeat(200)]) {
    assert.equal(isoStamp(bad), null, `expected null for ${String(bad)}`);
  }
  const a = ok([row({ startedAt: 'yesterday' })]);
  assert.equal(a.runs, 1);
  assert.equal(a.window, null);
});

test('a median longer than the wire format allows is flagged rather than clamped', () => {
  const short = ok(runsWithMs([1000]));
  assert.equal(short.medianDurationExceedsMax, false);
  const long = ok(runsWithMs([R.MAX_RECEIPT_DURATION_MS + 1]));
  assert.equal(long.medianDurationMs, R.MAX_RECEIPT_DURATION_MS + 1);
  assert.equal(long.medianDurationExceedsMax, true);
});

// ─── hostile and malformed history ───────────────────────────────────────────

test('junk rows are counted as malformed and never throw', () => {
  const a = ok([null, undefined, 'run', 42, [], true, row(), () => {}]);
  assert.equal(a.runs, 1);
  assert.equal(a.excluded.malformed, 7);
});

test('a row carrying a JSON __proto__ key does not reach Object.prototype', () => {
  const hostile = JSON.parse(`{"workflowId":${JSON.stringify(WF)},"graphHash":${JSON.stringify(HASH)},"status":"done","ms":1000,"__proto__":{"polluted":true}}`);
  const a = ok([hostile]);
  assert.equal(a.runs, 1);
  assert.equal({}.polluted, undefined);
});

test('a row whose steps or tokens are deeply wrong is still aggregated for what it does carry', () => {
  const a = ok([row({ steps: { length: 1e9 }, tokens: [1, 2, 3], edgesTaken: null })]);
  assert.equal(a.runs, 1);
  assert.equal(a.medianTokens, null);
  assert.equal(a.medianDurationMs, 120000);
});

test('the source list is not mutated by aggregation', () => {
  const runs = runsWithMs([300, 100, 200]);
  const before = JSON.stringify(runs);
  ok(runs);
  assert.equal(JSON.stringify(runs), before);
});

// ─── the timestamp grammar ───────────────────────────────────────────────────

test('a timestamp carrying an offset is converted, not merely reformatted', () => {
  assert.equal(isoStamp('2026-02-06T10:00:00+02:00').text, '2026-02-06T08:00:00.000Z');
  assert.equal(isoStamp('2026-02-06T10:00:00-0500').text, '2026-02-06T15:00:00.000Z');
  assert.equal(isoStamp('2026-02-06T10:00:00.500z').text, '2026-02-06T10:00:00.500Z');
  assert.equal(isoStamp('2026-02-06T10:00Z').text, '2026-02-06T10:00:00.000Z');
});

test('a timestamp with no offset is read as UTC, so two machines publish one window', () => {
  const original = process.env.TZ;
  const seen = new Set();
  try {
    for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Asia/Jerusalem']) {
      process.env.TZ = tz;
      seen.add(isoStamp('2026-02-06T10:00:00').text);
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
  assert.deepEqual([...seen], ['2026-02-06T10:00:00.000Z']);
});

test('a string that names no instant is refused rather than assigned one', () => {
  // Each of these names a date or a wall clock rather than an instant.
  for (const bad of ['2026', '2026-02', '2026-02-06', 'Feb 6 2026', '6 Feb 2026 10:00 GMT', '2026-02-06 10:00:00']) {
    assert.equal(isoStamp(bad), null, `expected null for ${bad}`);
  }
});

test('a date that does not exist on the calendar is refused', () => {
  assert.equal(isoStamp('2026-02-29T00:00:00Z'), null);
  assert.equal(isoStamp('2026-04-31T00:00:00Z'), null);
  assert.equal(isoStamp('2026-00-10T00:00:00Z'), null);
  assert.equal(isoStamp('2026-02-06T24:00:00Z'), null);
  assert.equal(isoStamp('2026-06-30T23:59:60Z'), null);
  assert.equal(isoStamp('2026-02-06T10:00:00+24:00'), null);
  assert.equal(isoStamp('2024-02-29T00:00:00Z').text, '2024-02-29T00:00:00.000Z');
  assert.equal(isoStamp('2000-02-29T00:00:00Z').text, '2000-02-29T00:00:00.000Z');
});

test('a two-digit year is refused rather than quietly landing in the twentieth century', () => {
  assert.equal(isoStamp('0026-02-06T10:00:00Z'), null);
  assert.equal(isoStamp('0999-02-06T10:00:00Z'), null);
});

test('a sub-millisecond fraction is truncated, never rounded past the instant it names', () => {
  assert.equal(isoStamp('2026-02-06T10:00:00.9996Z').text, '2026-02-06T10:00:00.999Z');
  assert.equal(isoStamp('2026-02-06T10:00:00.2Z').text, '2026-02-06T10:00:00.200Z');
});

// ─── publishability ──────────────────────────────────────────────────────────

test('a complete aggregate says it can be published and names no blockers', () => {
  const a = ok(runsWithMs([1000, 2000, 3000]));
  assert.equal(a.publishable, true);
  assert.deepEqual(a.publishBlockers, []);
});

test('each thing that stops publication is named, not left to be re-derived', () => {
  assert.deepEqual(ok([]).publishBlockers, ['runs', 'window', 'medianDurationMs']);
  assert.deepEqual(ok([row({ startedAt: 'yesterday' })]).publishBlockers, ['window']);
  assert.deepEqual(ok([row({ ms: undefined, startedAt: 'yesterday', finishedAt: 'tomorrow' })]).publishBlockers,
    ['window', 'medianDurationMs']);
  assert.deepEqual(ok(runsWithMs([R.MAX_RECEIPT_DURATION_MS + 1])).publishBlockers, ['medianDurationExceedsMax']);
  assert.equal(ok(runsWithMs([R.MAX_RECEIPT_DURATION_MS + 1])).publishable, false);
});

// ─── the excluded ledger ─────────────────────────────────────────────────────

test('runs plus the excluded buckets always account for every source row', () => {
  const histories = [
    [],
    [row()],
    [row(), null, 'junk', row({ id: 'x', workflowId: 'wf-other' }), row({ id: 'y', graphHash: OTHER_HASH })],
    [row({ id: 'a', graphHash: undefined }), row({ id: 'b', status: 'running' }), { status: 'done' }],
  ];
  for (const runs of histories) {
    const a = ok(runs);
    const accounted = a.runs + Object.values(a.excluded).reduce((x, y) => x + y, 0);
    assert.equal(accounted, a.sourceRuns, `${accounted} of ${a.sourceRuns} accounted for`);
  }
});

test('rows past the hard cap are counted as unread rather than vanishing', () => {
  const runs = runsWithMs(new Array(R.MAX_SOURCE_RUNS + 7).fill(1000));
  const a = ok(runs);
  assert.equal(a.excluded.unread, 7);
  assert.equal(a.runs + Object.values(a.excluded).reduce((x, y) => x + y, 0), a.sourceRuns);
});

// A list whose length is not a readable count is aggregated as empty.
test('a source list whose length cannot be read aggregates to nothing', () => {
  const raises = new Proxy([row()], {
    get(target, key) {
      if (key === 'length') throw new Error('boom');
      return target[key];
    },
  });
  const a = ok(raises);
  assert.equal(a.sourceRuns, 0);
  assert.equal(a.runs, 0);
  assert.equal(a.excluded.unread, 0);
  assert.equal(a.publishable, false);

  for (const lie of ['3', NaN, Infinity, -1, null]) {
    const lying = new Proxy([row(), row({ id: '2' })], {
      get(target, key) { return key === 'length' ? lie : target[key]; },
    });
    const b = ok(lying);
    assert.equal(b.sourceRuns, 0, `expected nothing to be walked for a length of ${String(lie)}`);
    assert.equal(b.runs, 0);
  }
});

// The subscript read sits inside the same per-row guard as every other read.
test('an index that raises on being read costs one row and no more', () => {
  const hostile = new Proxy([row({ id: '1', ms: 1000 }), null, row({ id: '2', ms: 3000 })], {
    get(target, key) {
      if (key === '1') throw new Error('boom');
      return target[key];
    },
  });
  const a = ok(hostile);
  assert.equal(a.sourceRuns, 3);
  assert.equal(a.runs, 2);
  assert.equal(a.excluded.malformed, 1);
  assert.equal(a.medianDurationMs, 2000);
});

// ─── rows that fight back ────────────────────────────────────────────────────

test('a row that raises while it is read costs itself its place and nothing else', () => {
  const hostile = row({ id: 'hostile' });
  Object.defineProperty(hostile, 'steps', { get() { throw new Error('boom'); }, enumerable: true });
  const a = ok([row({ id: '1', ms: 1000 }), hostile, row({ id: '2', ms: 3000 })]);
  assert.equal(a.runs, 2);
  assert.equal(a.excluded.malformed, 1);
  assert.equal(a.medianDurationMs, 2000);
});

test('a refusal never quotes the exception it caught back at the caller', () => {
  const opts = { graphHash: HASH };
  Object.defineProperty(opts, 'workflowId', { get() { throw new Error('<img onerror=alert(1)>'); }, enumerable: true });
  const res = aggregateRuns([], opts);
  assert.equal(res.ok, false);
  assert.equal(res.error.includes('img'), false);
});

// ─── negative zero ───────────────────────────────────────────────────────────

test('negative zero is flattened at the one gate every number passes through', () => {
  assert.equal(Object.is(R._internal.safeCount(-0), -0), false);
  const a = ok([row({ ms: -0 }), row({ id: '2', ms: -0 })]);
  assert.equal(Object.is(a.medianDurationMs, -0), false);
  assert.equal(Object.is(a.durationRangeMs.min, -0), false);
  assert.equal(Object.is(a.durationRangeMs.max, -0), false);
});

test('every publishable figure is an integer or null', () => {
  const a = ok([
    row({ id: '1', ms: 100, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 } }),
    row({ id: '2', ms: 201, tokens: { input: 2, output: 3, cacheRead: 4, cacheCreate: 5 } }),
  ]);
  assert.equal(Number.isInteger(a.medianDurationMs), true);
  assert.equal(Number.isInteger(a.durationCensored), true);
  assert.equal(Number.isInteger(a.runs), true);
  for (const v of Object.values(a.medianTokens)) assert.equal(Number.isInteger(v), true);
  for (const v of Object.values(a.outcomes)) assert.equal(Number.isInteger(v), true);
});
