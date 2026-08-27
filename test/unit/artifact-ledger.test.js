'use strict';

const test = require('node:test');
const assert = require('node:assert');

const L = require('../../src/lib/artifact-ledger');

const wf = (over) => ({
  id: 'run-1', workflowId: 'w1', workflowName: 'Guarded release',
  status: 'done', startedAt: '2026-08-20T10:00:00Z', finishedAt: '2026-08-20T10:05:00Z',
  ms: 300000, steps: [], failedStep: '', environment: { agentResolved: 'claude' },
  ...over,
});

const ap = (over) => ({
  sessionId: 'auto-abc', capturedAt: '2026-08-21T10:00:00Z', endedAt: '2026-08-21T10:30:00Z',
  workspaceRoot: '/home/user/code/husk', goal: 'Fix the parser', status: 'done',
  fileCount: 4, dollars: 0.42, tokens: 12000, agent: 'claude',
  ...over,
});

const step = (over) => ({ nodeId: 'n0', name: 'Plan', status: 'done', ms: 1000, entries: [], ...over });

// ─── shape ───────────────────────────────────────────────────────────────

test('both stores land in one list with one shape', () => {
  const rows = L.buildLedger({ workflowRuns: [wf()], autopilotRuns: [ap()] });
  assert.strictEqual(rows.length, 2);
  for (const r of rows) {
    assert.deepStrictEqual(Object.keys(r).sort(), [
      'agent', 'detail', 'dollars', 'endedAt', 'failedStep', 'files', 'hasLog',
      'id', 'key', 'ms', 'outcome', 'source', 'startedAt', 'steps', 'title',
      'tokens', 'workspace',
    ]);
  }
});

test('a row keeps the original beside the common shape', () => {
  const row = L.buildLedger({ workflowRuns: [wf({ failedStep: 'Verify' })] })[0];
  assert.strictEqual(row.detail.workflowId, 'w1');
  assert.strictEqual(row.failedStep, 'Verify');
});

test('keys are unique across the two sources', () => {
  // The same id in both stores must not collide into one row.
  const rows = L.buildLedger({
    workflowRuns: [wf({ id: 'x' })],
    autopilotRuns: [ap({ sessionId: 'x' })],
  });
  assert.strictEqual(new Set(rows.map((r) => r.key)).size, 2);
});

test('a run without an id is skipped rather than shown without one', () => {
  const rows = L.buildLedger({ workflowRuns: [wf({ id: '' }), wf()], autopilotRuns: [ap({ sessionId: null })] });
  assert.strictEqual(rows.length, 1);
});

test('junk in either store is skipped rather than thrown over', () => {
  const rows = L.buildLedger({ workflowRuns: [null, 'nope', 42], autopilotRuns: [undefined, []] });
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(L.buildLedger(), []);
  assert.deepStrictEqual(L.buildLedger({}), []);
});

// ─── outcomes ────────────────────────────────────────────────────────────

test('the two stores spell outcomes differently and both map onto one set', () => {
  const of = (s) => L.buildLedger({ workflowRuns: [wf({ status: s })] })[0].outcome;
  assert.strictEqual(of('done'), 'done');
  assert.strictEqual(of('failed'), 'failed');
  assert.strictEqual(of('cancelled'), 'halted');
  assert.strictEqual(of('running'), 'running');
  assert.strictEqual(of('something-new'), 'unknown');

  const ofA = (s) => L.buildLedger({ autopilotRuns: [ap({ status: s })] })[0].outcome;
  assert.strictEqual(ofA('complete'), 'done');
  assert.strictEqual(ofA('halted'), 'halted');
  assert.strictEqual(ofA('unknown'), 'unknown');
});

test('every outcome a row can carry is in the closed list', () => {
  for (const s of ['done', 'failed', 'cancelled', 'running', 'zzz']) {
    assert.ok(L.OUTCOMES.includes(L.buildLedger({ workflowRuns: [wf({ status: s })] })[0].outcome));
  }
});

// ─── figures ─────────────────────────────────────────────────────────────

test('a run nobody measured tokens for carries null, not zero', () => {
  const row = L.buildLedger({ workflowRuns: [wf({ steps: [step(), step()] })] })[0];
  assert.strictEqual(row.tokens, null);
});

test('tokens are summed only over the steps that reported', () => {
  const row = L.buildLedger({ workflowRuns: [wf({ steps: [
    step({ usage: { input_tokens: 100, output_tokens: 50 } }),
    step(),
    step({ usage: { input_tokens: 10, cache_read_input_tokens: 5 } }),
  ] })] })[0];
  assert.strictEqual(row.tokens, 165);
});

test('a measured zero survives as zero rather than becoming absent', () => {
  const row = L.buildLedger({ workflowRuns: [wf({ steps: [step({ usage: { input_tokens: 0 } })] })] })[0];
  assert.strictEqual(row.tokens, 0);
});

test('a nonsense usage report is an absence rather than a total', () => {
  assert.strictEqual(L._internal.stepTokens(null), null);
  assert.strictEqual(L._internal.stepTokens('lots'), null);
  assert.strictEqual(L._internal.stepTokens({ input_tokens: -5 }), null);
  assert.strictEqual(L._internal.stepTokens({ nothing_useful: 1 }), null);
});

test('a column that does not apply to a kind of run is null, not zero', () => {
  const [a, w] = L.buildLedger({ workflowRuns: [wf()], autopilotRuns: [ap()] });
  const wfRow = [a, w].find((r) => r.source === 'workflow');
  const apRow = [a, w].find((r) => r.source === 'autopilot');
  assert.strictEqual(wfRow.files, null);
  assert.strictEqual(wfRow.dollars, null);
  assert.strictEqual(apRow.steps, null);
});

test('a duration is derived only when both ends were recorded', () => {
  assert.strictEqual(L.buildLedger({ autopilotRuns: [ap()] })[0].ms, 1800000);
  assert.strictEqual(L.buildLedger({ autopilotRuns: [ap({ endedAt: null })] })[0].ms, null);
  assert.strictEqual(L.buildLedger({ autopilotRuns: [ap({ capturedAt: '' })] })[0].ms, null);
});

test('a row says whether its evidence survived the history cap', () => {
  const withLog = L.buildLedger({ workflowRuns: [wf({ steps: [step({ entries: [{ kind: 'out', text: 'x' }] })] })] })[0];
  const without = L.buildLedger({ workflowRuns: [wf({ steps: [step()] })] })[0];
  assert.strictEqual(withLog.hasLog, true);
  assert.strictEqual(without.hasLog, false);
});

// ─── ordering ────────────────────────────────────────────────────────────

test('newest first, by when a run ended', () => {
  const rows = L.buildLedger({
    workflowRuns: [wf({ id: 'old', finishedAt: '2026-01-01T00:00:00Z' })],
    autopilotRuns: [ap({ sessionId: 'new', endedAt: '2026-09-01T00:00:00Z' })],
  });
  assert.deepStrictEqual(rows.map((r) => r.id), ['new', 'old']);
});

test('a run still going sorts above every finished one', () => {
  const rows = L.buildLedger({
    workflowRuns: [
      wf({ id: 'recent', finishedAt: '2026-12-31T00:00:00Z' }),
      wf({ id: 'live', status: 'running', finishedAt: '' }),
    ],
  });
  assert.strictEqual(rows[0].id, 'live');
});

test('a run with no end falls back to when it started', () => {
  const rows = L.buildLedger({ workflowRuns: [
    wf({ id: 'a', finishedAt: '', startedAt: '2026-05-01T00:00:00Z' }),
    wf({ id: 'b', finishedAt: '', startedAt: '2026-06-01T00:00:00Z' }),
  ] });
  assert.deepStrictEqual(rows.map((r) => r.id), ['b', 'a']);
});

// ─── filtering ───────────────────────────────────────────────────────────

const LEDGER = () => L.buildLedger({
  workflowRuns: [wf({ id: 'w-ok' }), wf({ id: 'w-bad', status: 'failed', workflowName: 'Docs sweep' })],
  autopilotRuns: [ap({ sessionId: 'a-ok' })],
});

test('a source narrows the ledger to one kind of run', () => {
  assert.strictEqual(L.filterLedger(LEDGER(), { source: 'workflow' }).length, 2);
  assert.strictEqual(L.filterLedger(LEDGER(), { source: 'autopilot' }).length, 1);
  // A source nobody knows is ignored rather than emptying the list.
  assert.strictEqual(L.filterLedger(LEDGER(), { source: 'nonsense' }).length, 3);
});

test('an outcome narrows the ledger, and composes with a source', () => {
  assert.deepStrictEqual(L.filterLedger(LEDGER(), { outcome: 'failed' }).map((r) => r.id), ['w-bad']);
  assert.strictEqual(L.filterLedger(LEDGER(), { source: 'autopilot', outcome: 'failed' }).length, 0);
});

test('a query reaches the title, the agent and the workspace', () => {
  assert.deepStrictEqual(L.filterLedger(LEDGER(), { query: 'docs' }).map((r) => r.id), ['w-bad']);
  assert.deepStrictEqual(L.filterLedger(LEDGER(), { query: 'code/husk' }).map((r) => r.id), ['a-ok']);
  assert.strictEqual(L.filterLedger(LEDGER(), { query: 'claude' }).length, 3);
});

test('filtering nothing is empty rather than an error', () => {
  assert.deepStrictEqual(L.filterLedger(null, { query: 'x' }), []);
  assert.strictEqual(L.filterLedger(LEDGER(), {}).length, 3);
  assert.strictEqual(L.filterLedger(LEDGER()).length, 3);
});

// ─── totals ──────────────────────────────────────────────────────────────

test('totals say how many rows each one was measured over', () => {
  const s = L.summarise(LEDGER());
  assert.strictEqual(s.runs, 3);
  assert.strictEqual(s.done, 2);
  assert.strictEqual(s.failed, 1);
  // Only the autopilot run recorded money and tokens.
  assert.strictEqual(s.dollarRows, 1);
  assert.strictEqual(s.tokenRows, 1);
  assert.strictEqual(s.tokens, 12000);
  assert.strictEqual(s.files, 4);
});

test('a total nobody measured is absent rather than zero', () => {
  const s = L.summarise(L.buildLedger({ workflowRuns: [wf({ steps: [step()] })] }));
  assert.strictEqual(s.tokens, null);
  assert.strictEqual(s.tokenRows, 0);
  assert.strictEqual(s.dollars, null);
});

test('summarising nothing is a zero-run summary rather than an error', () => {
  const s = L.summarise([]);
  assert.strictEqual(s.runs, 0);
  assert.strictEqual(s.ms, null);
  assert.deepStrictEqual(L.summarise(null).runs, 0);
});
