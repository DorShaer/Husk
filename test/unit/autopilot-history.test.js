'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { groupHistoryRuns } = require('../../src/lib/autopilot-history');

test('groups collab agent sessions into one fleet history row', () => {
  const runs = [
    {
      sessionId: 'auto-worker-a',
      groupId: 'g1',
      role: 'worker-a',
      fileCount: 4,
      dollars: 0.10,
      tokens: 1000,
      endedAt: '2026-01-01T00:01:00.000Z',
    },
    {
      sessionId: 'auto-worker-b',
      groupId: 'g1',
      role: 'worker-b',
      fileCount: 6,
      dollars: 0.20,
      tokens: 2000,
      endedAt: '2026-01-01T00:02:00.000Z',
    },
    {
      sessionId: 'auto-integrator',
      groupId: 'g1',
      role: 'integrator',
      isIntegrator: true,
      fileCount: 0,
      dollars: 0.05,
      tokens: 500,
      endedAt: '2026-01-01T00:03:00.000Z',
    },
  ];
  const grouped = groupHistoryRuns(runs);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sessionId, 'auto-integrator');
  assert.equal(grouped[0].memberCount, 3);
  assert.deepEqual(grouped[0].sessionIds.sort(), ['auto-integrator', 'auto-worker-a', 'auto-worker-b']);
  assert.equal(grouped[0].fileCount, 10);
  assert.equal(grouped[0].tokens, 3500);
  assert.equal(Math.round(grouped[0].dollars * 100), 35);
});

test('uses integrator file count when the integrator has a final merged diff', () => {
  const grouped = groupHistoryRuns([
    { sessionId: 'a', groupId: 'g', fileCount: 4, endedAt: '2026-01-01T00:01:00.000Z' },
    { sessionId: 'i', groupId: 'g', isIntegrator: true, fileCount: 4, endedAt: '2026-01-01T00:02:00.000Z' },
  ]);
  assert.equal(grouped[0].sessionId, 'i');
  assert.equal(grouped[0].fileCount, 4);
});

test('keeps solo runs as individual history rows', () => {
  const grouped = groupHistoryRuns([
    { sessionId: 'auto-one', fileCount: 1, endedAt: '2026-01-01T00:01:00.000Z' },
    { sessionId: 'auto-two', fileCount: 2, endedAt: '2026-01-01T00:02:00.000Z' },
  ]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((r) => r.sessionId), ['auto-two', 'auto-one']);
});

test('sums the change mix across workers when no integrator merged the diff', () => {
  const grouped = groupHistoryRuns([
    { sessionId: 'a', groupId: 'g', fileCount: 2, changes: { added: 1, modified: 1, deleted: 0 }, endedAt: '2026-01-01T00:01:00.000Z' },
    { sessionId: 'b', groupId: 'g', fileCount: 3, changes: { added: 0, modified: 2, deleted: 1 }, endedAt: '2026-01-01T00:02:00.000Z' },
  ]);
  assert.deepEqual(grouped[0].changes, { added: 1, modified: 3, deleted: 1 });
});

test('takes the change mix from the integrator when it carries the merged diff', () => {
  const grouped = groupHistoryRuns([
    { sessionId: 'a', groupId: 'g', fileCount: 2, changes: { added: 2, modified: 0, deleted: 0 }, endedAt: '2026-01-01T00:01:00.000Z' },
    { sessionId: 'i', groupId: 'g', isIntegrator: true, fileCount: 2, changes: { added: 1, modified: 1, deleted: 0 }, endedAt: '2026-01-01T00:02:00.000Z' },
  ]);
  assert.deepEqual(grouped[0].changes, { added: 1, modified: 1, deleted: 0 });
});

test('a run with no recorded change mix still reports a full shape', () => {
  const grouped = groupHistoryRuns([
    { sessionId: 'solo', fileCount: 0, endedAt: '2026-01-01T00:01:00.000Z' },
  ]);
  assert.deepEqual(grouped[0].changes, { added: 0, modified: 0, deleted: 0 });
});
