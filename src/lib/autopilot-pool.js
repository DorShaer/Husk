'use strict';

// Concurrent Autopilot runs registry.
//
// Each entry in `runs` holds:
//   { runner, pty, _dataDisposable, _exitDisposable,
//     worktreePath, workspaceRoot,
//     outputBuf, flushTimer, finishing, tickInterval }
//
// Callers own the lifecycle of each field; this module only
// manages identity (add/get/remove) and concurrency accounting.

const runs = new Map();        // runId → runState
const pendingRuns = [];        // { runId, payload, workspaceRoot }
const DEFAULT_MAX_CONCURRENT = 4;

function getActiveCount() {
  let n = 0;
  for (const r of runs.values()) { if (!r.finishing) n++; }
  return n;
}

function addRun(runId, state) {
  runs.set(runId, state);
}

function getRun(runId) {
  return runs.get(runId) || null;
}

function hasRun(runId) {
  return runs.has(runId);
}

function removeRun(runId) {
  return runs.delete(runId);
}

function listRuns() {
  return [...runs.entries()];
}

// Enqueue a pending run spec. Called when the concurrency cap is full.
function enqueuePending(spec) {
  pendingRuns.push(spec);
}

// Pop and start the next pending run when a slot opens up.
// `startFn(runId, payload, workspaceRoot)` is the async starter from main.js.
// Returns true if a pending run was dispatched.
function drainPending(maxConcurrent, startFn) {
  if (!pendingRuns.length) return false;
  const cap = typeof maxConcurrent === 'number' && maxConcurrent > 0
    ? maxConcurrent
    : DEFAULT_MAX_CONCURRENT;
  if (getActiveCount() >= cap) return false;
  const next = pendingRuns.shift();
  if (!next) return false;
  try {
    Promise.resolve(startFn(next.runId, next.payload, next.workspaceRoot))
      .then((res) => {
        if (res && res.ok === false) drainPending(maxConcurrent, startFn);
      })
      .catch(() => { drainPending(maxConcurrent, startFn); });
  } catch (_) {
    drainPending(maxConcurrent, startFn);
  }
  return true;
}

function pendingCount() {
  return pendingRuns.length;
}

module.exports = {
  runs,
  pendingRuns,
  DEFAULT_MAX_CONCURRENT,
  addRun,
  getRun,
  hasRun,
  removeRun,
  listRuns,
  getActiveCount,
  enqueuePending,
  drainPending,
  pendingCount,
};
