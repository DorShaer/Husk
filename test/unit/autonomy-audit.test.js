'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  SCHEMA_VERSION,
  GENESIS_HASH,
  DEFAULT_MAX_INLINE_BYTES,
  createAuditLog,
  readAuditLog,
  verifyAuditChain,
  _internal,
} = require('../../src/lib/autonomy/audit');

const SID = 'sess-audit-001';
let store;
beforeEach(() => { store = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-audit-')); });
afterEach(() => { try { fs.rmSync(store, { recursive: true, force: true }); } catch (_) {} });

function auditFile() { return path.join(store, 'sessions', SID, 'audit.jsonl'); }
function blobsDirPath() { return path.join(store, 'sessions', SID, 'blobs'); }
function makeWriter(opts) {
  const r = createAuditLog(store, SID, opts);
  assert.equal(r.ok, true);
  return r.writer;
}

// ─── happy path ──────────────────────────────────────────────────────────

test('first append writes a JSONL line at sessionDir/audit.jsonl', () => {
  const w = makeWriter();
  const r = w.append({ kind: 'start_run', payload: { goal: 'demo' } });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(auditFile()), true);
  const lines = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.v, SCHEMA_VERSION);
  assert.equal(row.sid, SID);
  assert.equal(row.kind, 'start_run');
  assert.deepEqual(row.payload, { goal: 'demo' });
  assert.equal(row.seq, 0);
  assert.equal(row.prev, GENESIS_HASH);
});

test('records carry an ISO timestamp by default, opts.now overrides for determinism', () => {
  let i = 0;
  const w = makeWriter({ now: () => `2026-05-27T03:00:0${i++}.000Z` });
  w.append({ kind: 'a' });
  w.append({ kind: 'b' });
  const lines = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  const r0 = JSON.parse(lines[0]); const r1 = JSON.parse(lines[1]);
  assert.equal(r0.ts, '2026-05-27T03:00:00.000Z');
  assert.equal(r1.ts, '2026-05-27T03:00:01.000Z');
});

test('seq increments per append, starts at 0 for a fresh log', () => {
  const w = makeWriter();
  for (let i = 0; i < 5; i++) w.append({ kind: 'tick' });
  const lines = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [0, 1, 2, 3, 4]);
});

test('agent and turn fields are passed through when supplied', () => {
  const w = makeWriter();
  w.append({ kind: 'tool_call', agent: 'claude', turn: 12, payload: { tool: 'Read' } });
  const row = JSON.parse(fs.readFileSync(auditFile(), 'utf8').split('\n')[0]);
  assert.equal(row.agent, 'claude');
  assert.equal(row.turn, 12);
});

// ─── hash chain ──────────────────────────────────────────────────────────

test('each row prev == sha256 of the previous line', () => {
  const w = makeWriter({ now: () => '2026-05-27T03:00:00.000Z' });
  w.append({ kind: 'a' });
  w.append({ kind: 'b' });
  w.append({ kind: 'c' });
  const lines = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const row = JSON.parse(lines[i]);
    const expected = _internal.sha256Hex(lines[i - 1]);
    assert.equal(row.prev, expected, `row ${i} prev`);
  }
});

test('verifyAuditChain returns valid:true on a freshly written log', () => {
  const w = makeWriter();
  for (let i = 0; i < 3; i++) w.append({ kind: 'tick', payload: { i } });
  const r = verifyAuditChain(store, SID);
  assert.equal(r.ok, true);
  assert.equal(r.valid, true);
  assert.equal(r.brokenAtIndex, -1);
  assert.equal(r.lineCount, 3);
});

test('SECURITY: tampering with a payload mid-log breaks the chain', () => {
  const w = makeWriter();
  w.append({ kind: 'a', payload: { x: 1 } });
  w.append({ kind: 'b', payload: { x: 2 } });
  w.append({ kind: 'c', payload: { x: 3 } });
  // Hand-edit row index 1 to corrupt its payload.
  let txt = fs.readFileSync(auditFile(), 'utf8');
  txt = txt.replace('"x":2', '"x":999');
  fs.writeFileSync(auditFile(), txt);
  const r = verifyAuditChain(store, SID);
  assert.equal(r.ok, true);
  assert.equal(r.valid, false);
  // Tampering with row N makes row N+1's prev mismatch, so the
  // breakage is reported at index 2.
  assert.equal(r.brokenAtIndex, 2);
});

test('SECURITY: deleting a middle row breaks the chain at the next row', () => {
  const w = makeWriter();
  w.append({ kind: 'a' });
  w.append({ kind: 'b' });
  w.append({ kind: 'c' });
  const lines = fs.readFileSync(auditFile(), 'utf8').split('\n');
  // Drop the second line (index 1).
  const tampered = [lines[0], lines[2], lines[3]].filter(Boolean).join('\n') + '\n';
  fs.writeFileSync(auditFile(), tampered);
  const r = verifyAuditChain(store, SID);
  assert.equal(r.valid, false);
});

test('SECURITY: appending an extra line not produced by the writer breaks the chain', () => {
  const w = makeWriter();
  w.append({ kind: 'real' });
  fs.appendFileSync(auditFile(), JSON.stringify({ v: 1, prev: 'cafe', seq: 99, kind: 'spliced' }) + '\n');
  const r = verifyAuditChain(store, SID);
  assert.equal(r.valid, false);
});

// ─── resume / append on existing log ─────────────────────────────────────

test('reopening an existing log resumes the chain from the last row hash', () => {
  let w = makeWriter();
  w.append({ kind: 'a' });
  w.append({ kind: 'b' });
  const lines1 = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  // Drop the in-memory writer and re-open.
  w = makeWriter();
  // The new writer's prev should chain to line index 1 (the last
  // line of the existing log).
  const expectedPrev = _internal.sha256Hex(lines1[1]);
  w.append({ kind: 'c' });
  const lines2 = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  const row2 = JSON.parse(lines2[2]);
  assert.equal(row2.prev, expectedPrev);
  assert.equal(row2.seq, 2);
  // And the chain still verifies as valid end-to-end.
  const v = verifyAuditChain(store, SID);
  assert.equal(v.valid, true);
});

test('reopening a log with a valid unterminated row adds the missing newline', () => {
  let w = makeWriter();
  w.append({ kind: 'a' });
  let text = fs.readFileSync(auditFile(), 'utf8');
  fs.writeFileSync(auditFile(), text.replace(/\n$/, ''));
  w = makeWriter();
  w.append({ kind: 'b' });
  const lines = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(verifyAuditChain(store, SID).valid, true);
});

test('reopening a log with an incomplete trailing row drops that row', () => {
  let w = makeWriter();
  w.append({ kind: 'a' });
  fs.appendFileSync(auditFile(), '{"v":1,"kind":"partial"');
  w = makeWriter();
  w.append({ kind: 'b' });
  const rows = fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => r.kind), ['a', 'b']);
  assert.equal(verifyAuditChain(store, SID).valid, true);
});

// ─── blob spill ──────────────────────────────────────────────────────────

test('large payloads spill into the blob store with sha256 names', () => {
  const w = makeWriter({ maxInlineBytes: 64 });
  const bigPayload = { body: 'x'.repeat(2048) };
  const r = w.append({ kind: 'tool_result', payload: bigPayload });
  assert.equal(r.ok, true);
  // Row should NOT have inline payload; should have blob_ref.
  const row = JSON.parse(fs.readFileSync(auditFile(), 'utf8').split('\n')[0]);
  assert.equal(row.payload, undefined);
  assert.match(row.blob_ref, /^[a-f0-9]{64}$/);
  // Blob file exists at the matching name.
  assert.equal(fs.existsSync(path.join(blobsDirPath(), row.blob_ref)), true);
});

test('small payloads stay inline; only oversize content spills', () => {
  const w = makeWriter();
  w.append({ kind: 'small', payload: { x: 1 } });
  const row = JSON.parse(fs.readFileSync(auditFile(), 'utf8').split('\n')[0]);
  assert.deepEqual(row.payload, { x: 1 });
  assert.equal(row.blob_ref, undefined);
});

test('opts.encrypt wraps every spilled blob, not just one', () => {
  const w = makeWriter({ maxInlineBytes: 32, encrypt: (buf) => Buffer.concat([Buffer.from('E:'), buf]) });
  w.append({ kind: 'a', payload: { body: 'a'.repeat(200) } });
  w.append({ kind: 'b', payload: { body: 'b'.repeat(200) } });
  const blobs = fs.readdirSync(blobsDirPath());
  assert.equal(blobs.length, 2);
  for (const name of blobs) {
    const head = fs.readFileSync(path.join(blobsDirPath(), name)).slice(0, 2).toString();
    assert.equal(head, 'E:', `blob ${name} encrypted`);
  }
});

test('readAuditLog resolves blob_ref back into payload (with decrypt)', () => {
  const enc = (buf) => Buffer.concat([Buffer.from('ENC:'), buf]);
  const dec = (buf) => buf.slice(4);
  const w = makeWriter({ maxInlineBytes: 32, encrypt: enc });
  w.append({ kind: 'spilled', payload: { body: 'x'.repeat(200) } });
  const r = readAuditLog(store, SID, { decrypt: dec });
  assert.equal(r.ok, true);
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].payload.body.length, 200);
});

test('readAuditLog with resolveBlobs:false leaves blob_ref untouched', () => {
  const w = makeWriter({ maxInlineBytes: 32 });
  w.append({ kind: 'spilled', payload: { body: 'x'.repeat(200) } });
  const r = readAuditLog(store, SID, { resolveBlobs: false });
  assert.equal(r.records[0].payload, undefined);
  assert.match(r.records[0].blob_ref, /^[a-f0-9]{64}$/);
});

test('readAuditLog warns when a blob_ref points at a blob with mismatched hash', () => {
  const w = makeWriter({ maxInlineBytes: 32 });
  w.append({ kind: 'spilled', payload: { body: 'x'.repeat(200) } });
  // Tamper the blob.
  const sha = JSON.parse(fs.readFileSync(auditFile(), 'utf8').split('\n')[0]).blob_ref;
  fs.writeFileSync(path.join(blobsDirPath(), sha), 'TAMPERED');
  const r = readAuditLog(store, SID);
  assert.ok(r.warnings.find((w) => /sha mismatch/.test(w.reason)));
});

// ─── parser resilience ──────────────────────────────────────────────────

test('readAuditLog: a single unparseable line is skipped, others survive', () => {
  const w = makeWriter();
  w.append({ kind: 'good1' });
  fs.appendFileSync(auditFile(), 'not json\n');
  w.append({ kind: 'good2' });
  const r = readAuditLog(store, SID);
  assert.equal(r.ok, true);
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0].kind, 'good1');
  assert.equal(r.records[1].kind, 'good2');
  assert.ok(r.warnings.find((w) => /parse error/.test(w.reason)));
});

// ─── input validation ──────────────────────────────────────────────────

test('createAuditLog rejects bad sessionId values', () => {
  for (const bad of ['', null, '../escape', 'a/b', 'a\\b', 'x'.repeat(200)]) {
    const r = createAuditLog(store, bad);
    assert.equal(r.ok, false, `bad sessionId: ${JSON.stringify(bad)}`);
  }
});

test('createAuditLog rejects a relative storageRoot', () => {
  const r = createAuditLog('relative/path', SID);
  assert.equal(r.ok, false);
});

test('append rejects non-object events', () => {
  const w = makeWriter();
  assert.equal(w.append(null).ok, false);
  assert.equal(w.append('string').ok, false);
  assert.equal(w.append(123).ok, false);
});

// ─── ANTI-CRITERIA ────────────────────────────────────────────────────

test('ISC-A1: audit log only writes inside storageRoot/sessions/<sid>/', () => {
  const before = fs.readdirSync(store).sort();
  const w = makeWriter({ maxInlineBytes: 8 });
  w.append({ kind: 'big', payload: { body: 'x'.repeat(64) } });
  const after = fs.readdirSync(store).sort();
  assert.deepEqual(after, ['sessions']);
  assert.equal(JSON.stringify(before), '[]');
  const inside = fs.readdirSync(path.join(store, 'sessions'));
  assert.deepEqual(inside, [SID]);
  const sdir = path.join(store, 'sessions', SID);
  assert.deepEqual(fs.readdirSync(sdir).sort(), ['audit.jsonl', 'blobs']);
});

test('ISC-A2: encryption applied to EVERY spilled blob, not a subset', () => {
  const seen = [];
  const w = makeWriter({ maxInlineBytes: 8, encrypt: (buf) => { seen.push(buf.length); return buf; } });
  w.append({ kind: 'a', payload: { body: 'a'.repeat(64) } });
  w.append({ kind: 'b', payload: { body: 'b'.repeat(64) } });
  w.append({ kind: 'c', payload: { body: 'c'.repeat(64) } });
  assert.equal(seen.length, 3);
});

test('ISC-A3: prev hash on the first row is the public GENESIS constant', () => {
  const w = makeWriter();
  w.append({ kind: 'first' });
  const row = JSON.parse(fs.readFileSync(auditFile(), 'utf8').split('\n')[0]);
  assert.equal(row.prev, GENESIS_HASH);
  assert.equal(GENESIS_HASH, '0'.repeat(64));
});

test('ISC-A4: writer.lastHash and writer.seq track on-disk state', () => {
  const w = makeWriter();
  assert.equal(w.lastHash(), GENESIS_HASH);
  assert.equal(w.seq(), 0);
  w.append({ kind: 'first' });
  const line = fs.readFileSync(auditFile(), 'utf8').split('\n')[0];
  assert.equal(w.lastHash(), _internal.sha256Hex(line));
  assert.equal(w.seq(), 1);
});

test('DEFAULT_MAX_INLINE_BYTES is the documented 4 KiB', () => {
  assert.equal(DEFAULT_MAX_INLINE_BYTES, 4096);
});
