'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../../src/lib/autopilot-pool');

function makeState(finishing = false) {
  return { runner: {}, pty: null, outputBuf: '', finishing, tickInterval: null };
}

beforeEach(() => {
  // Reset shared pool state between tests.
  pool.runs.clear();
  pool.pendingRuns.length = 0;
});

// ─── add / get / remove ──────────────────────────────────────────────────────

test('addRun stores a run by runId', () => {
  const s = makeState();
  pool.addRun('r1', s);
  assert.equal(pool.getRun('r1'), s);
});

test('getRun returns null for unknown runId', () => {
  assert.equal(pool.getRun('no-such'), null);
});

test('hasRun returns true only for known runIds', () => {
  pool.addRun('r2', makeState());
  assert.equal(pool.hasRun('r2'), true);
  assert.equal(pool.hasRun('r99'), false);
});

test('removeRun deletes the entry and returns true', () => {
  pool.addRun('r3', makeState());
  assert.equal(pool.removeRun('r3'), true);
  assert.equal(pool.getRun('r3'), null);
});

test('removeRun returns false for unknown runId', () => {
  assert.equal(pool.removeRun('no-such'), false);
});

test('listRuns returns all current entries as [runId, state] pairs', () => {
  pool.addRun('r4', makeState());
  pool.addRun('r5', makeState());
  const entries = pool.listRuns();
  assert.equal(entries.length, 2);
  assert.ok(entries.some(([id]) => id === 'r4'));
  assert.ok(entries.some(([id]) => id === 'r5'));
});

// ─── concurrency accounting ───────────────────────────────────────────────────

test('getActiveCount counts runs where finishing=false', () => {
  pool.addRun('r6', makeState(false));
  pool.addRun('r7', makeState(true));  // finishing: should not count
  assert.equal(pool.getActiveCount(), 1);
});

test('getActiveCount returns 0 on empty pool', () => {
  assert.equal(pool.getActiveCount(), 0);
});

// ─── concurrency cap + queue ─────────────────────────────────────────────────

test('enqueuePending appends to pendingRuns', () => {
  pool.enqueuePending({ runId: 'q1', payload: {}, workspaceRoot: '/tmp/proj' });
  assert.equal(pool.pendingCount(), 1);
  assert.equal(pool.pendingRuns[0].runId, 'q1');
});

test('drainPending dequeues and calls startFn when slot is free', async () => {
  pool.enqueuePending({ runId: 'q2', payload: { goal: 'test' }, workspaceRoot: '/p' });
  let started = null;
  const startFn = async (runId, payload, workspaceRoot) => {
    started = { runId, payload, workspaceRoot };
  };
  const dispatched = pool.drainPending(4, startFn);
  assert.equal(dispatched, true);
  assert.equal(pool.pendingCount(), 0);
  // startFn is async: give it a tick to resolve
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, { runId: 'q2', payload: { goal: 'test' }, workspaceRoot: '/p' });
});

test('drainPending does not dispatch when at concurrency cap', () => {
  // Fill up to cap
  for (let i = 0; i < 4; i++) pool.addRun(`r-cap-${i}`, makeState(false));
  pool.enqueuePending({ runId: 'q3', payload: {}, workspaceRoot: '/p' });
  let called = false;
  const dispatched = pool.drainPending(4, async () => { called = true; });
  assert.equal(dispatched, false);
  assert.equal(called, false);
  assert.equal(pool.pendingCount(), 1);
});

test('drainPending returns false when queue is empty', () => {
  const dispatched = pool.drainPending(4, async () => {});
  assert.equal(dispatched, false);
});

// ─── per-run isolation ────────────────────────────────────────────────────────

test('modifying one run state does not affect another', () => {
  const s1 = makeState();
  const s2 = makeState();
  pool.addRun('rA', s1);
  pool.addRun('rB', s2);
  pool.getRun('rA').outputBuf = 'data from A';
  assert.equal(pool.getRun('rB').outputBuf, '');
});

test('removing a run does not affect other runs', () => {
  pool.addRun('rC', makeState());
  pool.addRun('rD', makeState());
  pool.removeRun('rC');
  assert.equal(pool.hasRun('rC'), false);
  assert.equal(pool.hasRun('rD'), true);
});

test('finishing a run reduces active count without removing it', () => {
  const s = makeState(false);
  pool.addRun('rE', s);
  assert.equal(pool.getActiveCount(), 1);
  s.finishing = true;
  assert.equal(pool.getActiveCount(), 0);
  assert.equal(pool.hasRun('rE'), true);  // still in map until removed
});
