'use strict';

// Append-only, hash-chained audit log for Husk Autonomy Mode.
//
// Every event the supervisor sees while a run is live (user message,
// assistant message, tool call, tool result, file write, file read,
// subprocess spawn, error, start/halt/end markers) lands as one
// JSONL row in <storageRoot>/sessions/<sessionId>/audit.jsonl.
//
// Each row carries the sha256 of the previous row's serialized line in a
// `prev` field, anchored at GENESIS_HASH for the first row.
// `verifyAuditChain` walks the file in order and reports the first row
// whose `prev` does not match.
//
// Large payloads (anything that would make a row exceed
// opts.maxInlineBytes, default 4 KiB) spill into the same blob store the
// snapshot module uses: blobs/<sha256> under the session dir, optionally
// encrypted via opts.encrypt. The row then carries `blob_ref: <sha>`
// instead of `payload`, so the JSONL stays cheap to grep and tail.
//
// Re-opening an existing log resumes the chain from the last line's hash,
// so several writer sessions over one audit.jsonl stay chained end to end.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const SESSION_DIR_RE = /^[A-Za-z0-9._-]+$/;
const GENESIS_HASH = '0'.repeat(64);
const DEFAULT_MAX_INLINE_BYTES = 4096;

function isSafeSessionId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SESSION_DIR_RE.test(id);
}

function sessionDir(storageRoot, sessionId) {
  return path.join(storageRoot, 'sessions', sessionId);
}
function blobsDir(storageRoot, sessionId) {
  return path.join(sessionDir(storageRoot, sessionId), 'blobs');
}
function auditPath(storageRoot, sessionId) {
  return path.join(sessionDir(storageRoot, sessionId), 'audit.jsonl');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// readLastLineSync returns the last non-empty line of the file at
// filePath, or null if the file is empty or missing. Callers resume
// the hash chain from it when re-opening an existing audit log.
function readLastLineSync(filePath) {
  // One read call; a missing or empty file yields null.
  let buf;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return null;
  }
  if (!buf || !buf.length) return null;
  let end = buf.length;
  // Strip any trailing newlines.
  while (end > 0 && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end--;
  let start = end;
  while (start > 0 && buf[start - 1] !== 0x0a) start--;
  if (start === end) return null;
  return buf.slice(start, end).toString('utf8');
}

function healAuditTailSync(filePath) {
  let buf;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return;
  }
  if (!buf || !buf.length) return;
  const last = buf[buf.length - 1];
  if (last === 0x0a || last === 0x0d) return;
  let start = buf.length;
  while (start > 0 && buf[start - 1] !== 0x0a) start--;
  const tail = buf.slice(start).toString('utf8');
  try {
    JSON.parse(tail);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
    fs.appendFileSync(filePath, '\n');
  } catch (_) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
    fs.truncateSync(filePath, start);
  }
}

// createAuditLog opens (or resumes) the audit log for one session.
// Returns { ok: true, writer } on success, or { ok: false, error }
// on validation failure. The writer is single-process, single-thread;
// the supervisor owns it for the lifetime of a run.
function createAuditLog(storageRoot, sessionId, opts = {}) {
  if (!isSafeSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  const bdir = blobsDir(storageRoot, sessionId);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under storageRoot
    fs.mkdirSync(bdir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `could not create audit dir: ${err.message}` };
  }
  const ap = auditPath(storageRoot, sessionId);
  healAuditTailSync(ap);
  const lastLine = readLastLineSync(ap);
  let prevHash = lastLine ? sha256Hex(lastLine) : GENESIS_HASH;
  let seq = countLinesSync(ap);

  const maxInline = Number.isFinite(opts.maxInlineBytes) && opts.maxInlineBytes >= 0
    ? Math.floor(opts.maxInlineBytes)
    : DEFAULT_MAX_INLINE_BYTES;
  const encrypt = typeof opts.encrypt === 'function' ? opts.encrypt : null;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();

  function append(event) {
    if (!event || typeof event !== 'object') {
      return { ok: false, error: 'event must be an object' };
    }
    const kind = typeof event.kind === 'string' && event.kind ? event.kind : 'unknown';
    const ts = typeof event.ts === 'string' && event.ts ? event.ts : now();
    const agent = typeof event.agent === 'string' ? event.agent : null;
    const turn = Number.isFinite(event.turn) ? event.turn : null;
    let payload = event.payload === undefined ? null : event.payload;
    let blobRef = null;

    // Spill check: serialize the payload alone and compare it to the
    // inline cap, so metadata fields do not move the threshold.
    if (payload !== null) {
      let payloadJson;
      try { payloadJson = JSON.stringify(payload); } catch (_) { payloadJson = null; }
      if (payloadJson && Buffer.byteLength(payloadJson, 'utf8') > maxInline) {
        const buf = Buffer.from(payloadJson, 'utf8');
        const sha = sha256Hex(buf);
        const blobAbs = path.join(bdir, sha);
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under bdir
          const toWrite = encrypt ? encrypt(buf) : buf;
          try {
            // wx creates the blob in one syscall only when it is absent;
            // EEXIST means the identical content is already stored.
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under bdir
            fs.writeFileSync(blobAbs, toWrite, { flag: 'wx' });
          } catch (e) {
            if (e.code !== 'EEXIST') throw e;
          }
          blobRef = sha;
          payload = null;
        } catch (err) {
          return { ok: false, error: `could not spill blob: ${err.message}` };
        }
      }
    }

    const row = {
      v: SCHEMA_VERSION,
      ts,
      sid: sessionId,
      seq,
      kind,
      prev: prevHash,
    };
    if (agent !== null) row.agent = agent;
    if (turn !== null) row.turn = turn;
    if (blobRef) row.blob_ref = blobRef;
    else if (payload !== null) row.payload = payload;
    // Key insertion order above is deterministic, and JS engines preserve
    // it, so two identical events serialize to identical rows.

    let line;
    try {
      line = JSON.stringify(row);
    } catch (err) {
      return { ok: false, error: `could not serialize row: ${err.message}` };
    }
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
      fs.appendFileSync(ap, line + '\n');
    } catch (err) {
      return { ok: false, error: `could not write audit line: ${err.message}` };
    }
    // Chain bookkeeping runs after a successful write, so prev always
    // points at the last line on disk.
    prevHash = sha256Hex(line);
    seq += 1;
    return { ok: true, record: row, line };
  }

  return {
    ok: true,
    writer: {
      append,
      lastHash() { return prevHash; },
      seq() { return seq; },
      auditPath: ap,
      blobsDir: bdir,
    },
  };
}

function countLinesSync(filePath) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
    const buf = fs.readFileSync(filePath);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    return n;
  } catch (_) {
    return 0;
  }
}

// readAuditLog parses every JSONL row, optionally resolving blob_ref
// values back into payloads (with decryption). Returns the array of
// records plus a warnings array for any unparseable lines.
function readAuditLog(storageRoot, sessionId, opts = {}) {
  if (!isSafeSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  const ap = auditPath(storageRoot, sessionId);
  const bdir = blobsDir(storageRoot, sessionId);
  let raw;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
    raw = fs.readFileSync(ap, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read audit log: ${err.message}` };
  }
  const decrypt = typeof opts.decrypt === 'function' ? opts.decrypt : null;
  const resolveBlob = opts.resolveBlobs !== false;
  const records = [];
  const warnings = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch (err) {
      warnings.push({ index: i, reason: `parse error: ${err.message}` });
      continue;
    }
    if (resolveBlob && typeof row.blob_ref === 'string' && /^[a-f0-9]{64}$/.test(row.blob_ref)) {
      const blobAbs = path.join(bdir, row.blob_ref);
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under bdir
        let buf = fs.readFileSync(blobAbs);
        if (decrypt) buf = decrypt(buf);
        if (sha256Hex(buf) !== row.blob_ref) {
          warnings.push({ index: i, reason: 'blob sha mismatch on resolve' });
        } else {
          try { row.payload = JSON.parse(buf.toString('utf8')); } catch (_) {
            row.payload = buf.toString('utf8');
          }
        }
      } catch (err) {
        warnings.push({ index: i, reason: `blob read failed: ${err.message}` });
      }
    }
    records.push(row);
  }
  return { ok: true, records, warnings };
}

// verifyAuditChain walks every line in order and reports whether the
// hash chain is intact. Returns { ok, valid, brokenAtIndex } where
// brokenAtIndex is -1 if every row's prev matches sha256 of the
// previous line. The genesis row must carry prev = GENESIS_HASH.
function verifyAuditChain(storageRoot, sessionId) {
  if (!isSafeSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    return { ok: false, error: 'storageRoot must be an absolute path' };
  }
  const ap = auditPath(storageRoot, sessionId);
  let raw;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under sessionDir
    raw = fs.readFileSync(ap, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read audit log: ${err.message}` };
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch (_) {
      return { ok: true, valid: false, brokenAtIndex: i, reason: 'parse error' };
    }
    if (row.prev !== prevHash) {
      return { ok: true, valid: false, brokenAtIndex: i, reason: 'prev hash mismatch' };
    }
    prevHash = sha256Hex(lines[i]);
  }
  return { ok: true, valid: true, brokenAtIndex: -1, lineCount: lines.length };
}

module.exports = {
  SCHEMA_VERSION,
  GENESIS_HASH,
  DEFAULT_MAX_INLINE_BYTES,
  createAuditLog,
  readAuditLog,
  verifyAuditChain,
  _internal: { sha256Hex, isSafeSessionId, readLastLineSync, countLinesSync },
};
