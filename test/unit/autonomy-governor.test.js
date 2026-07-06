'use strict';

// Integration: the progress governor wired into the supervisor. Proves a
// run that idles or loops is halted with reason 'stall', and that with
// the governor off the behaviour is unchanged.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startRun } = require('../../src/lib/autonomy/supervisor');
const Audit = require('../../src/lib/autonomy/audit');

const SID = 'gov-test-001';
const T0 = 1_000_000_000_000;

let work; let store; let clock;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-gov-work-'));
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-gov-store-'));
  clock = T0;
});
afterEach(() => {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(store, { recursive: true, force: true }); } catch (_) {}
});

function start(opts = {}) {
  const r = startRun(Object.assign({
    sessionId: SID, workspaceRoot: work, storageRoot: store,
    now: () => clock,
  }, opts));
  assert.equal(r.ok, true, r.error);
  return r.runner;
}

function haltKinds() {
  return Audit.readAuditLog(store, SID).records.map((r) => r.kind).filter((k) => k.startsWith('halt_'));
}

test('idle: a silent run is halted with reason stall/idle', () => {
  const runner = start({ governor: true });
  // Advance the wall clock past the 90s idle threshold with pure clock
  // ticks (no agent output) -> idle stall.
  clock = T0 + 95000;
  runner.tickClock();
  const st = runner.getState();
  assert.equal(st.status, 'halted');
  assert.equal(st.haltReason, 'stall');
  assert.equal(st.haltDetail.signal, 'idle');
  assert.ok(haltKinds().includes('halt_stall'));
});

test('loop: four identical actions in a row halt with reason stall/loop', () => {
  const runner = start({ governor: true });
  // Keep output flowing (resets idle) but repeat the same command.
  for (let i = 1; i <= 4; i++) {
    clock = T0 + i * 1000;
    runner.recordEvent({ kind: 'tool_use', tokens: { chars: 40 }, payload: { command: 'npm test' } });
  }
  const st = runner.getState();
  assert.equal(st.status, 'halted');
  assert.equal(st.haltReason, 'stall');
  assert.equal(st.haltDetail.signal, 'loop');
});

test('healthy: varied actions with output never stall', () => {
  const runner = start({ governor: true });
  for (let i = 1; i <= 6; i++) {
    clock = T0 + i * 10000; // 10s apart, well under idle threshold
    runner.recordEvent({ kind: 'tool_use', tokens: { chars: 40 }, payload: { command: `step-${i}` } });
  }
  assert.equal(runner.getState().status, 'running');
  assert.equal(runner.governorState().stalled, null);
});

test('governor off: an idle run is NOT stall-halted (behaviour unchanged)', () => {
  const runner = start(); // no governor opt-in
  clock = T0 + 300000; // 5 minutes of silence
  runner.tickClock();
  assert.equal(runner.getState().status, 'running');
  assert.equal(runner.governorState(), null);
});

test('budget cap takes precedence over a simultaneous stall', () => {
  // Tiny token cap so the budget trips on the first event; even though
  // the same event would also start a loop, budget wins.
  const runner = start({ governor: true, caps: { tokens: 1, minutes: 60, dollars: 5 } });
  clock = T0 + 1000;
  runner.recordEvent({ kind: 'tool_use', tokens: { input: 10, output: 10 }, payload: { command: 'x' } });
  const st = runner.getState();
  assert.equal(st.status, 'halted');
  assert.equal(st.haltReason, 'budget');
});
