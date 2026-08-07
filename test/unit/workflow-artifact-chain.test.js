'use strict';

// The shipped log: writing one, walking one, and refusing one.
//
// This is the file that decides whether "matches the shipped log" means
// anything. Everything else in the feature can be read off the artifact; this
// tier is the only one that requires the reading machine to do arithmetic and
// then disagree out loud, so the tests here are mostly about the disagreeing.
//
// The forgeries are built the way a forger would build them. There is no
// signature anywhere in src/lib/autonomy, so an attacker who rewrites a row
// simply recomputes every prev after it, and a test that mutates a row without
// re-chaining is testing the hash walk rather than the five predicates layered
// on top of it. rechain() below is those fifteen lines of JavaScript, written
// once, so every hostile case starts from a chain that hashes together
// perfectly and fails for the reason it is named after.
//
// The logs themselves come out of the real audit module, not out of a fixture.
// A hand-written row that drifted from what audit.js actually appends would
// leave this suite passing over a format nothing writes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const Audit = require('../../src/lib/autonomy/audit');
const {
  GENESIS_HASH,
  MIN_CHAIN_LINES,
  ROW_START,
  ROW_BINDING,
  ROW_SUMMARY,
  graphHash,
  buildArtifact,
  parseArtifact,
  validateArtifact,
  verifyArtifactChain,
  checkReceiptEvidence,
} = require('../../src/lib/workflow-artifact');
const WorkflowReceipt = require('../../src/lib/workflow-receipt');

const GRAPH = {
  nodes: [
    { id: 'one', name: 'Reproduce', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'reproduce it', passContext: 'none', x: 0, y: 0 },
    { id: 'two', name: 'Patch', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'patch it', passContext: 'full', x: 300, y: 0 },
  ],
  edges: [
    { id: 'x', from: 'one', to: 'two', condition: { type: 'always', value: '' } },
  ],
};

const HASH = (() => {
  const r = graphHash(GRAPH);
  assert.equal(r.ok, true, r.error);
  return r.hash;
})();
const OTHER_HASH = `husk-wfg-1:sha256:${'b'.repeat(64)}`;

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-chain-'));
  return dir;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// One run's log, written through the module main.js writes through, with the
// rows main.js writes. `over` moves the handful of values a test cares about
// so each case states only what it is about.
function writeRunLog(root, sessionId, over) {
  const o = Object.assign({
    graphHash: HASH,
    startedAt: '2026-02-06T10:00:00.000Z',
    finishedAt: '2026-02-06T10:02:00.000Z',
    ms: 120000,
    status: 'done',
    steps: [
      { nodeId: 'n0', name: 'Reproduce', status: 'done', ms: 60000, timedOut: false, usage: { input: 900, output: 80, cacheRead: 1200, cacheCreate: 0 } },
      { nodeId: 'n1', name: 'Patch', status: 'done', ms: 60000, timedOut: false, usage: { input: 1100, output: 120, cacheRead: 1400, cacheCreate: 0 } },
    ],
  }, over || {});

  const opened = Audit.createAuditLog(root, sessionId, {});
  assert.equal(opened.ok, true, opened.error);
  const w = opened.writer;
  w.append({ kind: ROW_START, payload: { startedAt: o.startedAt, steps: o.steps.length, os: 'linux', huskVersion: '2.11.0' } });
  w.append({ kind: ROW_BINDING, payload: { graphHash: o.graphHash } });
  for (const step of o.steps) {
    w.append({ kind: 'step_start', payload: { nodeId: step.nodeId, name: step.name, agent: 'claude', model: null } });
    w.append({ kind: 'step_end', payload: { nodeId: step.nodeId, status: step.status, ms: step.ms, timedOut: step.timedOut === true, usage: step.usage || null } });
  }
  w.append({ kind: ROW_SUMMARY, payload: { status: o.status, startedAt: o.startedAt, finishedAt: o.finishedAt, ms: o.ms, steps: o.steps.length } });

  return readLines(root, sessionId);
}

function readLines(root, sessionId) {
  const file = path.join(root, 'sessions', sessionId, 'audit.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
}

function parseRows(lines) {
  return lines.map((l) => JSON.parse(l));
}

// The forger's tool: take rows, put the prev pointers back the way a walk
// expects them, and serialize. Every hostile fixture below goes through this,
// so none of them is failing on a broken hash it did not mean to break.
function rechain(rows, opts) {
  const o = opts || {};
  let prev = o.genesis || GENESIS_HASH;
  return rows.map((row) => {
    const line = JSON.stringify(Object.assign({}, row, { prev }));
    prev = sha256Hex(line);
    return line;
  });
}

// ─── the constant this module copies ─────────────────────────────────────────

test('the genesis anchor matches the one audit.js writes', () => {
  // workflow-artifact.js declares this rather than requiring audit.js, so that
  // it stays a module with no fs in it. This is what keeps the copy honest.
  assert.equal(GENESIS_HASH, Audit.GENESIS_HASH);
});

// ─── a real log ──────────────────────────────────────────────────────────────

test('a log written by a finished run walks clean', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000000');
  const walk = verifyArtifactChain(lines, 'run-1000000000000', { graphHash: HASH });

  assert.equal(walk.valid, true, walk.reason);
  assert.equal(walk.lineCount, lines.length);
  assert.equal(walk.graphHash, HASH);
  assert.deepEqual(walk.sessionIds, ['run-1000000000000']);
  assert.equal(walk.head, `sha256:${sha256Hex(lines[lines.length - 1])}`);
  assert.equal(walk.sessions.length, 1);
  assert.equal(walk.sessions[0].rows[0].kind, ROW_START);
  assert.equal(walk.sessions[0].rows[1].kind, ROW_BINDING);
});

test('the declared head is checked against the rows that were shipped', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000001');
  const good = verifyArtifactChain(lines, 'run-1000000000001', { head: `sha256:${sha256Hex(lines[lines.length - 1])}` });
  assert.equal(good.valid, true, good.reason);

  const bad = verifyArtifactChain(lines, 'run-1000000000001', { head: `sha256:${'0'.repeat(64)}` });
  assert.equal(bad.valid, false);
  assert.equal(bad.predicate, 'head');
});

test('two sessions concatenated in order walk as one chain', () => {
  const root = tempRoot();
  const first = writeRunLog(root, 'run-1000000000002');
  const second = writeRunLog(root, 'run-1000000000003', { status: 'failed', ms: 90000 });
  const walk = verifyArtifactChain(first.concat(second), ['run-1000000000002', 'run-1000000000003'], { graphHash: HASH });

  assert.equal(walk.valid, true, walk.reason);
  assert.equal(walk.sessions.length, 2);
  // Each session re-anchors at genesis, because each one is its own file.
  assert.equal(JSON.parse(second[0]).prev, GENESIS_HASH);
});

// ─── the five refusals ───────────────────────────────────────────────────────

test('an empty log is refused, and refused as empty', () => {
  // The specific hole in verifyAuditChain: it filters out empty lines, finds
  // nothing to walk, and reports a valid chain of zero rows. A receipt built on
  // that would carry evidence:"inline" over no evidence at all.
  const raw = Audit.verifyAuditChain(emptyLogRoot(), 'run-1000000000004');
  assert.equal(raw.valid, true);
  assert.equal(raw.lineCount, 0);

  const walk = verifyArtifactChain([], 'run-1000000000004');
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'empty-log');
});

function emptyLogRoot() {
  const root = tempRoot();
  const opened = Audit.createAuditLog(root, 'run-1000000000004', {});
  assert.equal(opened.ok, true);
  fs.writeFileSync(path.join(root, 'sessions', 'run-1000000000004', 'audit.jsonl'), '');
  return root;
}

test('a truncated tail is refused, because the run never closed', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000005');

  // Genesis anchoring protects the head only, so the prefix still hashes
  // together perfectly. Nothing but the terminal-row predicate sees this.
  const cut = lines.slice(0, lines.length - 1);
  const raw = rawWalkStaysValid(cut);
  assert.equal(raw, true);

  const walk = verifyArtifactChain(cut, 'run-1000000000005');
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'structure');
  assert.match(walk.reason, /run_summary/);
});

// The predicate verifyAuditChain tests, applied to an array of lines, so a
// fixture can assert that the raw check would have passed what we refuse.
function rawWalkStaysValid(lines) {
  let prev = GENESIS_HASH;
  for (const line of lines) {
    if (JSON.parse(line).prev !== prev) return false;
    prev = sha256Hex(line);
  }
  return true;
}

test('a log cut down below four rows is refused for its length', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000006');
  const walk = verifyArtifactChain(lines.slice(0, MIN_CHAIN_LINES - 1), 'run-1000000000006');
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'too-few-lines');
});

test('a reordered sequence is refused even when the hashes are rebuilt', () => {
  const root = tempRoot();
  const rows = parseRows(writeRunLog(root, 'run-1000000000007'));

  // Swap the two step_end rows and rebuild every prev after them. The chain is
  // now internally perfect and the run it describes has its second step
  // finishing before its first. seq is what notices: the rows carry the
  // sequence numbers they were written with, and they no longer match where
  // they sit.
  const shuffled = rows.slice();
  const a = shuffled[3];
  shuffled[3] = shuffled[5];
  shuffled[5] = a;
  const lines = rechain(shuffled);
  assert.equal(rawWalkStaysValid(lines), true);

  const walk = verifyArtifactChain(lines, 'run-1000000000007');
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'seq');
  assert.equal(walk.atIndex, 3);
});

test('a spliced session id is refused', () => {
  const root = tempRoot();
  const mine = parseRows(writeRunLog(root, 'run-1000000000008'));
  const theirs = parseRows(writeRunLog(root, 'run-1000000000009', {
    steps: [{ nodeId: 'n0', name: 'Reproduce', status: 'done', ms: 10, timedOut: false, usage: null }],
  }));

  // sid and seq are written by audit.js and never read back by it, so a row
  // from another session splices in cleanly the moment prev is recomputed.
  const spliced = mine.slice();
  spliced.splice(3, 0, theirs[3]);
  const lines = rechain(spliced);
  assert.equal(rawWalkStaysValid(lines), true);

  const walk = verifyArtifactChain(lines, 'run-1000000000008');
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'session-count');
  assert.equal(walk.atIndex, 3);
});

test('a session declared in the wrong order is refused', () => {
  const root = tempRoot();
  const first = writeRunLog(root, 'run-1000000000010');
  const second = writeRunLog(root, 'run-1000000000011');
  const walk = verifyArtifactChain(first.concat(second), ['run-1000000000011', 'run-1000000000010']);
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'session-order');
  assert.equal(walk.atIndex, 0);
});

test('one session named twice is refused before a row is read', () => {
  const walk = verifyArtifactChain(['{}', '{}', '{}', '{}'], ['run-1', 'run-1']);
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'session-ids');
});

test('a binding row naming a different fingerprint is refused', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000012', { graphHash: OTHER_HASH });

  // The log is perfectly well formed. It is simply the record of a different
  // program, which is the whole reason the binding sits inside the chain: a log
  // lifted onto somebody else's receipt cannot be moved without a rehash, and
  // it still names the graph it actually ran.
  const walk = verifyArtifactChain(lines, 'run-1000000000012', { graphHash: HASH });
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'binding');
  assert.equal(walk.atIndex, 1);

  // Against its own fingerprint it is a fine log, which is what makes the
  // refusal above a statement about the pairing rather than about the rows.
  assert.equal(verifyArtifactChain(lines, 'run-1000000000012', { graphHash: OTHER_HASH }).valid, true);
});

test('a log whose second row is not the binding is refused', () => {
  const root = tempRoot();
  const rows = parseRows(writeRunLog(root, 'run-1000000000013'));
  const without = rows.filter((r) => r.kind !== ROW_BINDING).map((r, i) => Object.assign({}, r, { seq: i }));
  const walk = verifyArtifactChain(rechain(without), 'run-1000000000013');
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'structure');
  assert.equal(walk.atIndex, 1);
});

test('two sessions run against different workflows cannot be one receipt', () => {
  const root = tempRoot();
  const mine = writeRunLog(root, 'run-1000000000014');
  const other = writeRunLog(root, 'run-1000000000015', { graphHash: OTHER_HASH });
  const walk = verifyArtifactChain(mine.concat(other), ['run-1000000000014', 'run-1000000000015']);
  assert.equal(walk.valid, false);
  assert.equal(walk.predicate, 'binding');
});

test('hostile input yields a refusal rather than a throw', () => {
  const cases = [
    [null, 'run-1'],
    [['a', 'b', 'c', 'd'], null],
    [[1, 2, 3, 4], 'run-1'],
    [['{}', '{}', '{}', '{}'], 'run-1'],
    [['[]', '[]', '[]', '[]'], 'run-1'],
    [[JSON.stringify({ v: 2, sid: 'run-1', seq: 0, kind: ROW_START, prev: GENESIS_HASH })], 'run-1'],
  ];
  for (const [lines, sid] of cases) {
    let out;
    assert.doesNotThrow(() => { out = verifyArtifactChain(lines, sid); });
    assert.equal(out.ok, true);
    assert.equal(out.valid, false);
    assert.equal(typeof out.predicate, 'string');
  }
});

// ─── the figures the log supports ────────────────────────────────────────────

test('figures recomputed from a log describe the runs in it', () => {
  const root = tempRoot();
  const first = writeRunLog(root, 'run-1000000000016');
  const second = writeRunLog(root, 'run-1000000000017', {
    status: 'failed',
    ms: 180000,
    startedAt: '2026-02-07T10:00:00.000Z',
    finishedAt: '2026-02-07T10:03:00.000Z',
    steps: [
      { nodeId: 'n0', name: 'Reproduce', status: 'done', ms: 60000, timedOut: false, usage: { input: 900, output: 80, cacheRead: 1200, cacheCreate: 0 } },
      { nodeId: 'n1', name: 'Patch', status: 'failed', ms: 120000, timedOut: true, usage: null },
    ],
  });
  const walk = verifyArtifactChain(first.concat(second), ['run-1000000000016', 'run-1000000000017']);
  assert.equal(walk.valid, true, walk.reason);

  const derived = WorkflowReceipt.figuresFromChain(walk.sessions);
  assert.equal(derived.ok, true, derived.error);
  const f = derived.figures;
  assert.equal(f.runs, 2);
  assert.equal(f.graphHash, HASH);
  // A killed step makes the run timedOut rather than failed: the kill is what
  // produced the non-zero exit, and it is the fact that qualifies the median
  // sitting next to it.
  assert.deepEqual(f.outcomes, { completed: 1, failed: 0, stopped: 0, timedOut: 1 });
  assert.equal(f.durationCensored, 1);
  assert.equal(f.medianDurationMs, 150000);
  assert.equal(f.outcomeBasis, 'process-exit');
  assert.equal(f.window.firstRunAt, '2026-02-06T10:00:00.000Z');
  assert.equal(f.window.lastRunAt, '2026-02-07T10:00:00.000Z');
  assert.equal(f.publishable, true);
});

test('a run whose steps reported no usage publishes null tokens, never zeros', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000018', {
    steps: [
      { nodeId: 'n0', name: 'Reproduce', status: 'done', ms: 60000, timedOut: false, usage: null },
      { nodeId: 'n1', name: 'Patch', status: 'done', ms: 60000, timedOut: false, usage: null },
    ],
  });
  const walk = verifyArtifactChain(lines, 'run-1000000000018');
  const derived = WorkflowReceipt.figuresFromChain(walk.sessions);
  assert.equal(derived.ok, true, derived.error);
  assert.equal(derived.figures.medianTokens, null);
});

test('compareFigures names the field that moved', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000019');
  const walk = verifyArtifactChain(lines, 'run-1000000000019');
  const derived = WorkflowReceipt.figuresFromChain(walk.sessions);

  const honest = Object.assign({}, derived.figures);
  assert.equal(WorkflowReceipt.compareFigures(honest, derived.figures).agrees, true);

  const inflated = Object.assign({}, derived.figures, { medianDurationMs: 1000 });
  const out = WorkflowReceipt.compareFigures(inflated, derived.figures);
  assert.equal(out.agrees, false);
  assert.equal(out.differences.length, 1);
  assert.equal(out.differences[0].field, 'medianDurationMs');

  // The window is not compared. It is wall-clock time, which the tier table
  // keeps permanently author-stated: checking an author's timestamps against
  // the same author's timestamps would dress a tautology as a finding.
  const moved = Object.assign({}, derived.figures, { window: { firstRunAt: 'x', lastRunAt: 'y' } });
  assert.equal(WorkflowReceipt.compareFigures(moved, derived.figures).agrees, true);
});

// ─── a whole file, read the way a stranger's Husk reads one ──────────────────

// A receipt built the way the publisher builds one: from the log, so the
// figures beside the rows are the figures the rows support.
function receiptFrom(lines, sessionIds, over) {
  const walk = verifyArtifactChain(lines, sessionIds, { graphHash: HASH });
  assert.equal(walk.valid, true, walk.reason);
  const derived = WorkflowReceipt.figuresFromChain(walk.sessions);
  assert.equal(derived.ok, true, derived.error);
  const f = derived.figures;
  return Object.assign({
    id: `rcp_${'a'.repeat(16)}`,
    graphHash: HASH,
    runs: f.runs,
    runsWindowed: false,
    window: f.window,
    outcomes: f.outcomes,
    outcomeBasis: f.outcomeBasis,
    medianDurationMs: f.medianDurationMs,
    durationCensored: f.durationCensored,
    medianTokens: f.medianTokens,
    environment: {
      agentResolved: 'claude',
      agentVersion: '',
      modelResolved: null,
      os: 'linux',
      huskVersion: '2.11.0',
      workspace: { vcs: 'git', trackedFiles: '1k-10k', languages: [] },
    },
    evidence: 'inline',
    chain: {
      sessionIds: Array.isArray(sessionIds) ? sessionIds : [sessionIds],
      head: walk.head,
      lineCount: lines.length,
      lines,
    },
  }, over || {});
}

function publish(receipt) {
  return buildArtifact({ id: 'wf-1', name: 'Triage', description: '', graph: GRAPH }, {
    huskVersion: '2.11.0',
    publishedAt: '2026-02-06T10:02:41.117Z',
    receipts: [receipt],
  });
}

test('a published file carrying its own log reads as consistent with it', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000020');
  const built = publish(receiptFrom(lines, 'run-1000000000020'));
  assert.equal(built.ok, true, built.message);
  assert.equal(built.artifact.receipts[0].evidence, 'inline');
  assert.deepEqual(built.chainCheck, { checked: true, valid: true, agrees: true, detail: null });

  // And again from the bytes, which is the path a stranger's Husk takes.
  const read = parseArtifact(Buffer.from(JSON.stringify(built.artifact), 'utf8'));
  assert.equal(read.ok, true, read.message);
  assert.equal(read.chainCheck.checked, true);
  assert.equal(read.chainCheck.valid, true);
  assert.equal(read.chainCheck.agrees, true);
  assert.equal(read.receiptChecks.length, 1);
});

test('a receipt with no log is checked:false, and stays author-stated', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000021');
  const receipt = receiptFrom(lines, 'run-1000000000021', { evidence: 'none', chain: null });
  const built = publish(receipt);
  assert.equal(built.ok, true, built.message);
  assert.deepEqual(built.chainCheck, { checked: false, valid: null, agrees: null, detail: null });
  assert.equal(checkReceiptEvidence(built.artifact.receipts[0]).checked, false);
});

test('figures the shipped log does not support collapse the receipt, not the file', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000022');
  const honest = publish(receiptFrom(lines, 'run-1000000000022'));
  assert.equal(honest.ok, true, honest.message);

  // Doubling the median after the file was built is the whole attack: the rows
  // still hash together, so a reader checking only the chain sees a pass.
  const tampered = JSON.parse(JSON.stringify(honest.artifact));
  tampered.receipts[0].medianDurationMs = honest.artifact.receipts[0].medianDurationMs * 2;

  const read = parseArtifact(Buffer.from(JSON.stringify(tampered), 'utf8'));
  // The graph is untouched by an argument about its author's arithmetic, so the
  // file still installs. What collapses is the receipt block.
  assert.equal(read.ok, true, read.message);
  assert.equal(read.chainCheck.checked, true);
  assert.equal(read.chainCheck.valid, true);
  assert.equal(read.chainCheck.agrees, false);
  assert.match(read.chainCheck.detail, /medianDurationMs/);
  assert.ok(read.warnings.some((w) => w.code === 'evidence-disagrees'));
});

test('a tampered log row collapses the receipt with the chain named', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000023');
  const honest = publish(receiptFrom(lines, 'run-1000000000023'));
  assert.equal(honest.ok, true, honest.message);

  const tampered = JSON.parse(JSON.stringify(honest.artifact));
  const rows = parseRows(tampered.receipts[0].chain.lines);
  rows[3].payload.ms = 1;
  // Rehashed but not re-headed: the file still states the head it was built
  // with, which is the row the forger forgot.
  tampered.receipts[0].chain.lines = rechain(rows);

  const read = parseArtifact(Buffer.from(JSON.stringify(tampered), 'utf8'));
  assert.equal(read.ok, true, read.message);
  assert.equal(read.chainCheck.checked, true);
  assert.equal(read.chainCheck.valid, false);
  assert.match(read.chainCheck.detail, /head/);
  assert.ok(read.warnings.some((w) => w.code === 'evidence-refused'));
});

test('a log rehashed and re-headed still cannot outrun the figures it changed', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000024');
  const honest = publish(receiptFrom(lines, 'run-1000000000024'));

  const tampered = JSON.parse(JSON.stringify(honest.artifact));
  const rows = parseRows(tampered.receipts[0].chain.lines);
  // Halve every step, which halves the run the reader recomputes while the
  // declared median stays where it was.
  for (const row of rows) {
    if (row.kind === ROW_SUMMARY) row.payload.ms = 1000;
  }
  const rebuilt = rechain(rows);
  tampered.receipts[0].chain.lines = rebuilt;
  tampered.receipts[0].chain.head = `sha256:${sha256Hex(rebuilt[rebuilt.length - 1])}`;

  const read = parseArtifact(Buffer.from(JSON.stringify(tampered), 'utf8'));
  assert.equal(read.ok, true, read.message);
  assert.equal(read.chainCheck.valid, true);
  assert.equal(read.chainCheck.agrees, false);
});

test('a receipt whose log belongs to another workflow is refused as a chain', () => {
  const root = tempRoot();
  const mine = writeRunLog(root, 'run-1000000000025');
  const built = publish(receiptFrom(mine, 'run-1000000000025'));
  const tampered = JSON.parse(JSON.stringify(built.artifact));

  // Swap in a log from a run of a different graph, rehashed so the chain walk
  // itself is clean. The binding row is what refuses it.
  const other = writeRunLog(root, 'run-1000000000026', { graphHash: OTHER_HASH });
  tampered.receipts[0].chain = {
    sessionIds: ['run-1000000000026'],
    head: `sha256:${sha256Hex(other[other.length - 1])}`,
    lineCount: other.length,
    lines: other,
  };

  const read = parseArtifact(Buffer.from(JSON.stringify(tampered), 'utf8'));
  assert.equal(read.ok, true, read.message);
  assert.equal(read.chainCheck.valid, false);
  assert.match(read.chainCheck.detail, /binding|different workflow/);
});

test('buildArtifact refuses to publish figures its own log does not support', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000027');
  const wrong = receiptFrom(lines, 'run-1000000000027', { runs: 9 });
  // runs and the outcome sum have to agree before anything else looks at the
  // log, so the sum moves with it and the refusal below is about the evidence.
  wrong.outcomes = { completed: 9, failed: 0, stopped: 0, timedOut: 0 };
  const built = publish(wrong);
  assert.equal(built.ok, false);
  assert.equal(built.code, 'receipt-invalid');
  assert.match(built.detail, /runs/);
});

test('validateArtifact carries one check per receipt', () => {
  const root = tempRoot();
  const lines = writeRunLog(root, 'run-1000000000028');
  const built = publish(receiptFrom(lines, 'run-1000000000028'));
  const checked = validateArtifact(built.artifact);
  assert.equal(checked.ok, true, checked.message);
  assert.equal(checked.receiptChecks.length, checked.artifact.receipts.length);
});
