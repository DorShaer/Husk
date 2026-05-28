'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startRun, revertRun, summarizeRun } = require('../../src/lib/autonomy/supervisor');
const Audit = require('../../src/lib/autonomy/audit');

const SID = 'sup-test-001';

let work; let store;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-sup-work-'));
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-sup-store-'));
});
afterEach(() => {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(store, { recursive: true, force: true }); } catch (_) {}
});

function start(opts = {}) {
  const r = startRun(Object.assign({
    sessionId: SID, workspaceRoot: work, storageRoot: store,
    now: () => 1_000_000_000_000,
  }, opts));
  assert.equal(r.ok, true, r.error);
  return r.runner;
}

function audit() {
  const r = Audit.readAuditLog(store, SID);
  return r.records;
}

// ─── happy path ──────────────────────────────────────────────────────────

test('startRun snapshots the workspace and writes a start_run event', () => {
  fs.writeFileSync(path.join(work, 'a.txt'), 'A');
  const runner = start({ goal: 'do the thing' });
  const recs = audit();
  assert.equal(recs[0].kind, 'start_run');
  assert.equal(recs[0].payload.goal, 'do the thing');
  assert.equal(recs[0].payload.workspaceRoot, work);
  assert.ok(runner.snapshotManifest().entries['a.txt']);
});

test('recordEvent appends to the audit log and ticks the budget', () => {
  const runner = start();
  const r = runner.recordEvent({
    kind: 'tool_call', agent: 'claude', turn: 1, payload: { tool: 'Read' },
    tokens: { input: 10, output: 5 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.meterState.totalTokens, 15);
  const recs = audit();
  // First record is start_run, second is the tool_call.
  assert.equal(recs[1].kind, 'tool_call');
  assert.equal(recs[1].turn, 1);
});

test('recordEvent rejects events after halt / cancel / end', () => {
  const runner = start();
  runner.cancel({ note: 'user clicked stop' });
  const r = runner.recordEvent({ kind: 'late' });
  assert.equal(r.ok, false);
});

// ─── budget-driven halt ──────────────────────────────────────────────────

test('hitting a token cap halts the run with a halt_budget event', () => {
  const runner = start({ caps: { minutes: 1e9, tokens: 100, dollars: 1e9 } });
  runner.recordEvent({ kind: 'huge', tokens: { output: 150 } });
  const recs = audit();
  const halt = recs.find((r) => r.kind === 'halt_budget');
  assert.ok(halt, 'halt_budget present');
  assert.equal(halt.payload.cap, 'tokens');
  assert.equal(runner.getState().status, 'halted');
});

test('a wall-clock tick can halt even without events arriving', () => {
  let clock = 1_000_000_000_000;
  const runner = startRun({
    sessionId: SID, workspaceRoot: work, storageRoot: store,
    caps: { minutes: 1, tokens: 1e9, dollars: 1e9 },
    now: () => clock,
  }).runner;
  clock += 2 * 60 * 1000; // jump 2 minutes
  runner.tickClock();
  const halt = audit().find((r) => r.kind === 'halt_budget');
  assert.ok(halt, 'halt_budget present');
  assert.equal(halt.payload.cap, 'minutes');
});

// ─── cancel + end + run_summary ─────────────────────────────────────────

test('cancel marks the run cancelled and writes halt_user', () => {
  const runner = start();
  runner.cancel({ note: 'oops' });
  const recs = audit();
  assert.equal(recs.find((r) => r.kind === 'halt_user').payload.note, 'oops');
  assert.equal(runner.getState().status, 'cancelled');
});

test('endRun writes run_summary with the diff against the snapshot', () => {
  fs.writeFileSync(path.join(work, 'a.txt'), 'original');
  const runner = start();
  fs.writeFileSync(path.join(work, 'a.txt'), 'changed');
  fs.writeFileSync(path.join(work, 'added.txt'), 'new');
  runner.endRun({});
  const recs = audit();
  const sum = recs.find((r) => r.kind === 'run_summary');
  assert.ok(sum);
  // The diff should mention both files.
  const paths = new Set(sum.payload.diff.map((d) => d.path));
  assert.ok(paths.has('a.txt'));
  assert.ok(paths.has('added.txt'));
  assert.equal(sum.payload.status, 'ended');
});

test('endRun on an already-cancelled run still appends a run_summary', () => {
  const runner = start();
  runner.cancel({});
  runner.endRun();
  const recs = audit();
  // Order is: start_run, halt_user, run_summary
  assert.equal(recs[recs.length - 1].kind, 'run_summary');
});

// ─── revert + summarize ─────────────────────────────────────────────────

test('revertRun restores the workspace to the snapshot', () => {
  fs.writeFileSync(path.join(work, 'a.txt'), 'before');
  const runner = start();
  fs.writeFileSync(path.join(work, 'a.txt'), 'AFTER');
  fs.writeFileSync(path.join(work, 'rogue.txt'), 'should disappear');
  runner.endRun();
  const r = revertRun({ sessionId: SID, workspaceRoot: work, storageRoot: store });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'before');
  assert.equal(fs.existsSync(path.join(work, 'rogue.txt')), false);
});

test('summarizeRun returns event count + chain validity + diff', () => {
  fs.writeFileSync(path.join(work, 'a.txt'), 'original');
  const runner = start();
  runner.recordEvent({ kind: 'tool_call', payload: { tool: 'Read' } });
  fs.writeFileSync(path.join(work, 'a.txt'), 'tampered');
  runner.endRun();
  const s = summarizeRun({ sessionId: SID, workspaceRoot: work, storageRoot: store });
  assert.equal(s.ok, true);
  assert.ok(s.eventCount >= 3); // start, tool_call, end, summary
  assert.equal(s.chain.valid, true);
  assert.ok(s.diff.find((d) => d.path === 'a.txt' && d.status === 'modified'));
  assert.equal(s.summary.status, 'ended');
});

// ─── encrypted round-trip via callbacks ─────────────────────────────────

test('encrypt/decrypt callbacks round-trip through audit blobs and snapshot blobs', () => {
  const encrypt = (buf) => Buffer.concat([Buffer.from('E:'), buf]);
  const decrypt = (buf) => buf.slice(2);
  fs.writeFileSync(path.join(work, 'a.txt'), 'sensitive');
  const runner = startRun({
    sessionId: SID, workspaceRoot: work, storageRoot: store,
    now: () => 1_000_000_000_000,
    encrypt, decrypt,
    // force the start_run payload (which is small) to spill so we
    // exercise the encrypted-blob path.
    maxInlineBytes: 0,
  }).runner;
  runner.recordEvent({ kind: 'tool_result', payload: { body: 'x'.repeat(2048) } });
  runner.endRun();
  // Every blob must start with the encrypt prefix.
  const blobDir = path.join(store, 'sessions', SID, 'blobs');
  for (const name of fs.readdirSync(blobDir)) {
    const head = fs.readFileSync(path.join(blobDir, name)).slice(0, 2).toString();
    assert.equal(head, 'E:', `blob ${name} encrypted`);
  }
  // Reading the log with the matching decrypt resolves payloads.
  const r = Audit.readAuditLog(store, SID, { decrypt });
  assert.equal(r.ok, true);
  const big = r.records.find((rec) => rec.kind === 'tool_result');
  assert.ok(big);
  assert.equal(typeof big.payload, 'object');
  assert.equal(big.payload.body.length, 2048);
});

// ─── input validation ───────────────────────────────────────────────────

test('startRun rejects missing required fields', () => {
  assert.equal(startRun({}).ok, false);
  assert.equal(startRun({ sessionId: SID }).ok, false);
  assert.equal(startRun({ sessionId: SID, workspaceRoot: work }).ok, false);
});

test('startRun rejects relative paths', () => {
  const r = startRun({ sessionId: SID, workspaceRoot: 'relative', storageRoot: store });
  assert.equal(r.ok, false);
});
