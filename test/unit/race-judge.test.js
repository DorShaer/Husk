'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { rankRuns, pickWinner } = require('../../src/lib/race-judge');

function run(id, agent, fileCount, dollars, durationMs, tokens) {
  return { runId: id, agent, metrics: { fileCount, dollars, durationMs, tokens }, changes: Array.from({ length: fileCount }, (_, i) => ({ path: `f${i}` })) };
}

test('empty race returns empty', () => {
  assert.deepEqual(rankRuns([]), []);
  assert.equal(pickWinner([]), null);
});

test('fewer files changed ranks first', () => {
  const ranked = rankRuns([run('a', 'claude', 5, 1, 100), run('b', 'codex', 2, 1, 100)]);
  assert.equal(ranked[0].runId, 'b');
  assert.equal(ranked[0].suggested, true);
  assert.equal(ranked[1].suggested, false);
});

test('cheaper breaks a file-count tie', () => {
  const ranked = rankRuns([run('a', 'claude', 3, 5, 100), run('b', 'codex', 3, 1, 100)]);
  assert.equal(ranked[0].runId, 'b');
});

test('faster breaks a file+cost tie', () => {
  const ranked = rankRuns([run('a', 'claude', 3, 1, 900), run('b', 'codex', 3, 1, 200)]);
  assert.equal(ranked[0].runId, 'b');
});

test('a zero-diff run never wins and sorts last', () => {
  const ranked = rankRuns([run('a', 'claude', 0, 1, 50), run('b', 'codex', 4, 9, 999)]);
  assert.equal(ranked[0].runId, 'b');
  assert.equal(ranked[0].suggested, true);
  const zero = ranked.find((r) => r.runId === 'a');
  assert.equal(zero.suggested, false);
  assert.match(zero.reason, /no changes/i);
});

test('all zero-diff => no winner', () => {
  const ranked = rankRuns([run('a', 'claude', 0, 1, 50), run('b', 'codex', 0, 1, 60)]);
  assert.equal(pickWinner([run('a', 'claude', 0, 1, 50), run('b', 'codex', 0, 1, 60)]), null);
  assert.ok(ranked.every((r) => r.suggested === false));
});

test('per-metric bests are flagged', () => {
  const ranked = rankRuns([
    run('a', 'claude', 2, 5, 900), // smallest files
    run('b', 'codex', 6, 1, 800),  // cheapest
    run('c', 'copilot', 6, 9, 100),// fastest
  ]);
  const by = (id) => ranked.find((r) => r.runId === id);
  assert.equal(by('a').isSmallest, true);
  assert.equal(by('b').isCheapest, true);
  assert.equal(by('c').isFastest, true);
});

test('neutrality: same metrics rank the same regardless of agent name', () => {
  const r1 = rankRuns([run('a', 'claude', 3, 1, 100), run('b', 'codex', 2, 1, 100)]);
  const r2 = rankRuns([run('a', 'codex', 3, 1, 100), run('b', 'claude', 2, 1, 100)]);
  assert.equal(r1[0].runId, r2[0].runId); // 'b' wins in both, agent name irrelevant
});

test('stable tie-break by original order for identical metrics', () => {
  const ranked = rankRuns([run('a', 'claude', 3, 1, 100), run('b', 'codex', 3, 1, 100)]);
  assert.equal(ranked[0].runId, 'a'); // first in wins the exact tie
});

test('fileCount falls back to changes.length when metrics.fileCount missing', () => {
  const noMetric = { runId: 'x', agent: 'claude', changes: [{ path: 'a' }, { path: 'b' }] };
  const ranked = rankRuns([noMetric, run('y', 'codex', 5, 1, 100)]);
  assert.equal(ranked[0].runId, 'x'); // 2 files < 5 files
  assert.equal(ranked[0].fileCount, 2);
});
