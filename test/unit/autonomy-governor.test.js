'use strict';

// Integration: the progress governor wired into the supervisor. Proves the
// busy-stall model end to end -- a spinning or looping run halts with reason
// 'stall', a silent or progressing run never does, and budget wins ties.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startRun } = require('../../src/lib/autonomy/supervisor');
const Audit = require('../../src/lib/autonomy/audit');

const SID = 'gov-test-001';
const T0 = 1_000_000_000_000;
const MIN = 60000;
const BIG_CAPS = { minutes: 100000, tokens: 1e12, dollars: 1e9 };

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

test('spinning: frozen diff + token burn past 5m halts with stall/spinning', () => {
  const runner = start({ governor: true, caps: BIG_CAPS });
  runner.reportProgress('files=1;churn=10');            // diff baseline at T0
  clock = T0 + 1000;
  runner.recordEvent({ kind: 'tool_use', tokens: { input: 4000, output: 4000 }, payload: { command: 'retry' } });
  clock = T0 + 6 * MIN;                                  // 6 min frozen, 8000 tokens burned
  runner.tickClock();
  const st = runner.getState();
  assert.equal(st.status, 'halted');
  assert.equal(st.haltReason, 'stall');
  assert.equal(st.haltDetail.signal, 'spinning');
  assert.ok(haltKinds().includes('halt_stall'));
});

test('loop: four identical actions with no progress halt with stall/loop', () => {
  const runner = start({ governor: true, caps: BIG_CAPS });
  for (let i = 1; i <= 4; i++) {
    clock = T0 + i * 1000;
    runner.recordEvent({ kind: 'tool_use', tokens: { chars: 40 }, payload: { command: 'npm test' } });
  }
  const st = runner.getState();
  assert.equal(st.status, 'halted');
  assert.equal(st.haltReason, 'stall');
  assert.equal(st.haltDetail.signal, 'loop');
});

test('NO false-kill: a long silent run is never stall-halted', () => {
  const runner = start({ governor: true, caps: BIG_CAPS });
  runner.reportProgress('files=1;churn=10');
  // 20 minutes of pure silence: no events, no tokens, diff frozen. The
  // governor must NOT halt (the quiet-watchdog owns silence).
  clock = T0 + 20 * MIN;
  runner.tickClock();
  assert.equal(runner.getState().status, 'running');
  assert.equal(runner.governorState().stalled, null);
});

test('NO false-kill: a progressing run never stalls, however long', () => {
  const runner = start({ governor: true, caps: BIG_CAPS });
  for (let i = 1; i <= 8; i++) {
    clock = T0 + i * 4 * MIN;                            // an edit every 4 minutes
    runner.recordEvent({ kind: 'tool_use', tokens: { input: 8000, output: 8000 }, payload: { command: `step-${i}` } });
    runner.reportProgress(`files=${i};churn=${i * 100}`);
    assert.equal(runner.getState().status, 'running', `progress round ${i}`);
  }
  assert.equal(runner.governorState().stalled, null);
});

test('governor off: no stall halt ever (behaviour unchanged)', () => {
  const runner = start({ caps: BIG_CAPS });
  clock = T0 + 30 * MIN;
  runner.tickClock();
  assert.equal(runner.getState().status, 'running');
  assert.equal(runner.governorState(), null);
});

test('reportAction: the same tool signature 4x halts with stall/loop', () => {
  const runner = start({ governor: true, caps: BIG_CAPS });
  for (let i = 1; i <= 4; i++) {
    clock = T0 + i * 1000;
    runner.reportAction('Bash:npm test');
  }
  const st = runner.getState();
  assert.equal(st.status, 'halted');
  assert.equal(st.haltReason, 'stall');
  assert.equal(st.haltDetail.signal, 'loop');
});

test('reportProgress clears an almost-spinning run', () => {
  const runner = start({ governor: true, caps: BIG_CAPS });
  runner.reportProgress('files=1;churn=10');
  clock = T0 + 1000;
  runner.recordEvent({ kind: 'tool_use', tokens: { input: 5000, output: 5000 }, payload: { command: 'c' } });
  clock = T0 + 4 * MIN;                 // approaching the 5m spinning window
  assert.equal(runner.tickClock().hitCap, null);
  assert.equal(runner.getState().status, 'running');
  // A real edit lands: progress resets the spinning timer.
  runner.reportProgress('files=2;churn=90');
  clock = T0 + 8 * MIN;                 // 4m since the reset, not yet spinning
  runner.tickClock();
  assert.equal(runner.getState().status, 'running');
});

test('budget cap takes precedence over a simultaneous stall', () => {
  const runner = start({ governor: true, caps: { tokens: 1, minutes: 60, dollars: 5 } });
  clock = T0 + 1000;
  runner.recordEvent({ kind: 'tool_use', tokens: { input: 10, output: 10 }, payload: { command: 'x' } });
  assert.equal(runner.getState().haltReason, 'budget');
});
