'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { projectAuditRow, auditKindCounts } = require('../../src/lib/autonomy/audit-view');

test('a start row shows the goal it opened with', () => {
  const row = projectAuditRow({ seq: 1, ts: '2026-01-01T00:00:00.000Z', kind: 'start_run', payload: { goal: 'tidy the imports' } });
  assert.equal(row.kind, 'start_run');
  assert.equal(row.key, 'goal');
  assert.equal(row.details, 'tidy the imports');
  assert.equal(row.seq, 1);
});

test('a status row names the status and folds its blockers into the detail', () => {
  const row = projectAuditRow({
    kind: 'run_status',
    payload: { status: 'blocked', summary: 'waiting on review', blockers: ['no network', 'no token'] },
  });
  assert.equal(row.key, 'blocked');
  assert.equal(row.details, 'waiting on review · blocked on no network; no token');
});

test('a summary row reports files, tokens, spend and duration', () => {
  const row = projectAuditRow({
    kind: 'run_summary',
    payload: {
      status: 'ended',
      diff: [{ path: 'a' }, { path: 'b' }],
      meter: { totalTokens: 12400, dollars: 1.5 },
      durationMs: 92000,
    },
  });
  assert.equal(row.key, 'ended');
  assert.equal(row.details, '2 files changed · 12.4k tokens · $1.50 · 92s');
});

test('a single changed file reads as one file, not one files', () => {
  const row = projectAuditRow({ kind: 'run_summary', payload: { diff: [{ path: 'a' }] } });
  assert.match(row.details, /^1 file changed/);
});

test('a halt row leads with the cap it tripped', () => {
  const row = projectAuditRow({ kind: 'halt_budget', payload: { cap: 'dollars', limit: 5 } });
  assert.equal(row.key, 'dollars');
  assert.match(row.details, /limit 5/);
});

test('an unknown kind still reports its own scalar fields', () => {
  const row = projectAuditRow({ kind: 'something_new', payload: { path: 'src/a.js', count: 3, list: [1, 2] } });
  assert.equal(row.key, 'src/a.js');
  assert.equal(row.details, 'count 3 · list 2');
});

test('the field promoted into the key is left out of the details', () => {
  const row = projectAuditRow({ kind: 'end_run', payload: { reason: 'agent_complete' } });
  assert.equal(row.key, 'agent_complete');
  assert.equal(row.details, '');
});

test('a spilled payload is flagged so the table can say so', () => {
  const row = projectAuditRow({ kind: 'agent_output', blob_ref: 'a'.repeat(64) });
  assert.equal(row.spilled, true);
  assert.equal(row.kind, 'agent_output');
});

test('a malformed row still projects to the table shape', () => {
  const row = projectAuditRow(null);
  assert.equal(row.kind, 'unknown');
  assert.equal(row.key, '');
  assert.equal(row.details, '');
  assert.equal(row.seq, null);
});

test('details are clipped so one row cannot flood the table', () => {
  const row = projectAuditRow({ kind: 'start_run', payload: { goal: 'x'.repeat(2000) } });
  assert.ok(row.details.length <= 600);
});

test('whitespace in a payload collapses so a cell stays one paragraph', () => {
  const row = projectAuditRow({ kind: 'start_run', payload: { goal: 'line one\n\n  line two' } });
  assert.equal(row.details, 'line one line two');
});

test('kind counts come back busiest first, ties broken by name', () => {
  const counts = auditKindCounts([
    { kind: 'agent_output' }, { kind: 'agent_output' }, { kind: 'agent_output' },
    { kind: 'run_status' }, { kind: 'start_run' },
    {}, null,
  ]);
  assert.deepEqual(counts, [
    { kind: 'agent_output', count: 3 },
    { kind: 'unknown', count: 2 },
    { kind: 'run_status', count: 1 },
    { kind: 'start_run', count: 1 },
  ]);
});
