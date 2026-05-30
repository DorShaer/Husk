'use strict';

// Tests for src/lib/autonomy/snapshot.js. Every test mints its own
// tmp workspace + storage root via mkdtempSync; no test ever touches
// the real home directory or any shared state. Same convention as
// pai-state.test.js and repo-mcp.test.js.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  DEFAULT_IGNORE,
  captureSnapshot,
  captureSnapshotAsync,
  restoreFromSnapshot,
  diffWorkspace,
  _internal,
} = require('../../src/lib/autonomy/snapshot');

const SID = 'sess-test-001';

let work;
let store;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-snap-work-'));
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-snap-store-'));
});
afterEach(() => {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(store, { recursive: true, force: true }); } catch (_) {}
});

function writeFile(rel, content) {
  const abs = path.join(work, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}
function readFile(rel) {
  return fs.readFileSync(path.join(work, rel));
}

// ─── internals smoke ──────────────────────────────────────────────────────

test('internal: isSafeSessionId rejects path-traversal patterns', () => {
  assert.equal(_internal.isSafeSessionId(SID), true);
  assert.equal(_internal.isSafeSessionId('../foo'), false);
  assert.equal(_internal.isSafeSessionId('a/b'), false);
  assert.equal(_internal.isSafeSessionId('a\\b'), false);
  assert.equal(_internal.isSafeSessionId(''), false);
  assert.equal(_internal.isSafeSessionId(null), false);
});

test('internal: joinSafely blocks .. and absolute paths in manifest entries', () => {
  assert.equal(_internal.joinSafely('/abs', '../etc/passwd'), null);
  assert.equal(_internal.joinSafely('/abs', '/etc/passwd'), null);
  assert.equal(_internal.joinSafely('/abs', 'subdir/file.js'), path.join('/abs', 'subdir', 'file.js'));
});

// ─── captureSnapshot happy path ──────────────────────────────────────────

test('ISC-1..5: capture walks workspace, hashes files, writes blobs and a manifest', () => {
  writeFile('readme.md', 'hello world\n');
  writeFile('src/index.js', 'console.log("ok");\n');
  // Duplicate content to verify blob deduplication (ISC-5).
  writeFile('src/dup.js', 'console.log("ok");\n');

  const res = captureSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  assert.equal(Object.keys(res.manifest.entries).sort().join(','),
    'readme.md,src/dup.js,src/index.js');

  const sdir = path.join(store, 'sessions', SID);
  assert.equal(fs.existsSync(path.join(sdir, 'snapshot.json')), true);
  const blobNames = fs.readdirSync(path.join(sdir, 'blobs'));
  // Two unique contents => exactly two blobs (dedup confirmed).
  assert.equal(blobNames.length, 2);
  for (const name of blobNames) assert.match(name, /^[a-f0-9]{64}$/);
});

test('ISC-6: default ignore list keeps .git, node_modules, dist out', () => {
  writeFile('.git/HEAD', 'ref: refs/heads/main\n');
  writeFile('node_modules/foo/package.json', '{}');
  writeFile('dist/bundle.js', '/* built */');
  writeFile('src/index.js', 'ok');
  const res = captureSnapshot(work, store, SID);
  const keys = Object.keys(res.manifest.entries);
  assert.deepEqual(keys.sort(), ['src/index.js']);
});

test('ISC-7: user-supplied ignore patterns honored on top of defaults', () => {
  writeFile('logs/run.log', 'noise');
  writeFile('src/index.js', 'ok');
  const res = captureSnapshot(work, store, SID, { ignore: ['logs'] });
  const keys = Object.keys(res.manifest.entries);
  assert.deepEqual(keys.sort(), ['src/index.js']);
});

test('ISC-8: symlinks are recorded as { type: symlink, target }', () => {
  writeFile('real.txt', 'hello');
  fs.symlinkSync('real.txt', path.join(work, 'link.txt'));
  const res = captureSnapshot(work, store, SID);
  const link = res.manifest.entries['link.txt'];
  assert.ok(link, 'symlink recorded');
  assert.equal(link.type, 'symlink');
  assert.equal(link.target, 'real.txt');
});

test('ISC-9: a file disappearing mid-walk yields a warning, not a throw', () => {
  // Simulate by making a file unreadable via a sentinel pattern: we
  // create the file, walk, and force the reader to fail by deleting
  // the file between readdir and readFile. The exact race is hard to
  // hit deterministically, so instead we cover the explicit
  // try/catch shape by feeding a malformed binary file that the OS
  // returns EACCES on. Simpler: write a real file, then chmod to 0
  // on POSIX; on Windows skip with a doesNotThrow guarantee.
  writeFile('a.txt', 'a');
  // Skip the chmod-0 trick on Windows; just confirm the code shape
  // handles read failures via warnings rather than throws.
  if (process.platform !== 'win32') {
    const abs = path.join(work, 'a.txt');
    fs.chmodSync(abs, 0o000);
    try {
      const res = captureSnapshot(work, store, SID);
      assert.equal(res.ok, true);
      // Either the file was captured (root ran the test) or there
      // was a warning. Both shapes are acceptable; the contract is
      // "do not throw".
      if (!res.manifest.entries['a.txt']) {
        assert.ok(res.warnings.length >= 1);
      }
    } finally {
      try { fs.chmodSync(abs, 0o644); } catch (_) {}
    }
  } else {
    const res = captureSnapshot(work, store, SID);
    assert.equal(res.ok, true);
  }
});

// ─── captureSnapshot encryption ──────────────────────────────────────────

test('ISC-10: opts.encrypt wraps every blob written by capture', () => {
  writeFile('a.txt', 'plaintext content A\n');
  writeFile('b.txt', 'plaintext content B\n');
  let calls = 0;
  const encrypt = (buf) => { calls++; return Buffer.concat([Buffer.from('ENC:'), buf]); };
  const res = captureSnapshot(work, store, SID, { encrypt });
  assert.equal(res.ok, true);
  // Two unique files => encrypt called twice (once per blob written).
  assert.equal(calls, 2);
  const blobsList = fs.readdirSync(path.join(store, 'sessions', SID, 'blobs'));
  for (const name of blobsList) {
    const buf = fs.readFileSync(path.join(store, 'sessions', SID, 'blobs', name));
    assert.equal(buf.slice(0, 4).toString(), 'ENC:', `blob ${name} encrypted`);
  }
});

test('encryption: dedup means encrypt fires ONCE per unique content, not once per path', () => {
  writeFile('a.txt', 'same\n');
  writeFile('subdir/b.txt', 'same\n');
  let calls = 0;
  captureSnapshot(work, store, SID, { encrypt: (buf) => { calls++; return buf; } });
  assert.equal(calls, 1);
});

// ─── restoreFromSnapshot ─────────────────────────────────────────────────

test('ISC-11, ISC-13, ISC-19: capture + mutate + restore brings files back byte-exact', () => {
  writeFile('a.txt', 'original A\n');
  writeFile('b/c.js', 'original C\n');
  captureSnapshot(work, store, SID);
  // Mutate after capture
  writeFile('a.txt', 'TAMPERED\n');
  writeFile('b/c.js', 'TAMPERED\n');
  writeFile('extra.tmp', 'should not exist post-restore\n');
  const res = restoreFromSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  assert.equal(readFile('a.txt').toString(), 'original A\n');
  assert.equal(readFile('b/c.js').toString(), 'original C\n');
  // ISC-15 covered here: extra files removed.
  assert.equal(fs.existsSync(path.join(work, 'extra.tmp')), false);
});

test('ISC-12: opts.decrypt is called on every blob during restore when supplied', () => {
  writeFile('a.txt', 'A\n');
  writeFile('b.txt', 'B\n');
  const enc = (buf) => Buffer.concat([Buffer.from('ENC:'), buf]);
  const dec = (buf) => buf.slice(4);
  captureSnapshot(work, store, SID, { encrypt: enc });
  fs.unlinkSync(path.join(work, 'a.txt'));
  fs.unlinkSync(path.join(work, 'b.txt'));
  let calls = 0;
  const tracking = (buf) => { calls++; return dec(buf); };
  const res = restoreFromSnapshot(work, store, SID, { decrypt: tracking });
  assert.equal(res.ok, true);
  assert.equal(calls, 2, 'decrypt called for every restored file blob');
  assert.equal(readFile('a.txt').toString(), 'A\n');
  assert.equal(readFile('b.txt').toString(), 'B\n');
});

test('ISC-14, ISC-20: round-trip preserves symlinks structurally', () => {
  writeFile('real.txt', 'hi');
  fs.symlinkSync('real.txt', path.join(work, 'link.txt'));
  captureSnapshot(work, store, SID);
  fs.unlinkSync(path.join(work, 'link.txt'));
  const res = restoreFromSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  const lstat = fs.lstatSync(path.join(work, 'link.txt'));
  assert.equal(lstat.isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(work, 'link.txt')), 'real.txt');
});

test('ISC-15: restore removes files in workspace that were NOT in the snapshot', () => {
  writeFile('keep.txt', 'k\n');
  captureSnapshot(work, store, SID);
  writeFile('extra.txt', 'should disappear\n');
  writeFile('sub/extra2.txt', 'also disappear\n');
  const res = restoreFromSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(work, 'extra.txt')), false);
  assert.equal(fs.existsSync(path.join(work, 'sub/extra2.txt')), false);
});

// ─── diffWorkspace ────────────────────────────────────────────────────────

test('ISC-16, ISC-17, ISC-18: diff reports added, modified, deleted', () => {
  writeFile('keep.txt', 'same\n');
  writeFile('changeme.txt', 'before\n');
  writeFile('goneme.txt', 'about to be deleted\n');
  captureSnapshot(work, store, SID);
  writeFile('changeme.txt', 'after\n');
  fs.unlinkSync(path.join(work, 'goneme.txt'));
  writeFile('newfile.txt', 'fresh\n');
  const res = diffWorkspace(work, store, SID);
  assert.equal(res.ok, true);
  const byStatus = {};
  for (const c of res.changes) byStatus[c.path] = c.status;
  assert.equal(byStatus['changeme.txt'], 'modified');
  assert.equal(byStatus['goneme.txt'], 'deleted');
  assert.equal(byStatus['newfile.txt'], 'added');
  assert.equal(byStatus['keep.txt'], undefined, 'unchanged file not in diff');
});

test('ISC-21: capture twice on unchanged workspace produces identical manifest entries', () => {
  writeFile('a.txt', 'A');
  writeFile('b.txt', 'B');
  const r1 = captureSnapshot(work, store, SID);
  const r2 = captureSnapshot(work, store, SID);
  assert.deepEqual(r1.manifest.entries, r2.manifest.entries);
});

// ─── Anti-criteria (security boundaries) ─────────────────────────────────

test('ISC-A1: capture never writes outside storageRoot/sessions/<sid>/', () => {
  writeFile('a.txt', 'A');
  const before = fs.readdirSync(store).sort();
  captureSnapshot(work, store, SID);
  const after = fs.readdirSync(store).sort();
  // Only the "sessions" dir should appear under storageRoot
  assert.deepEqual(after, ['sessions']);
  assert.equal(JSON.stringify(before), '[]');
  // Inside sessions, only our SID dir.
  const inside = fs.readdirSync(path.join(store, 'sessions'));
  assert.deepEqual(inside, [SID]);
});

test('ISC-A2: restore refuses manifest entries whose path escapes workspaceRoot', () => {
  writeFile('a.txt', 'A');
  captureSnapshot(work, store, SID);
  // Hand-edit the manifest to inject a traversal entry.
  const m = JSON.parse(fs.readFileSync(path.join(store, 'sessions', SID, 'snapshot.json'), 'utf8'));
  m.entries['../escape.txt'] = { type: 'file', sha: 'deadbeef' };
  fs.writeFileSync(path.join(store, 'sessions', SID, 'snapshot.json'), JSON.stringify(m));
  // The "escape" path should NOT show up outside the workspace.
  const parentDir = path.dirname(work);
  const escapeAbs = path.join(parentDir, 'escape.txt');
  // pre-check: not there
  assert.equal(fs.existsSync(escapeAbs), false);
  const res = restoreFromSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(escapeAbs), false, 'restore must not create the escape file');
  assert.ok(res.warnings.find((w) => w.path === '../escape.txt'),
    'warning surfaced for the traversal attempt');
});

test('ISC-A3: encryption applied to every blob, not just first/secret ones', () => {
  writeFile('a.txt', 'A');
  writeFile('b.txt', 'B');
  writeFile('c.txt', 'C');
  const seen = [];
  const encrypt = (buf) => { seen.push(buf.toString()); return Buffer.concat([Buffer.from('E:'), buf]); };
  captureSnapshot(work, store, SID, { encrypt });
  assert.deepEqual(seen.sort(), ['A', 'B', 'C']);
});

test('ISC-A4: capture rejects sessionId with path separators', () => {
  writeFile('a.txt', 'A');
  const bad = captureSnapshot(work, store, '../escape', {});
  assert.equal(bad.ok, false);
});

test('argument validation: workspaceRoot must exist and be absolute', () => {
  const r1 = captureSnapshot('relative/path', store, SID);
  assert.equal(r1.ok, false);
  const r2 = captureSnapshot('/nope/not/here/' + crypto.randomBytes(4).toString('hex'), store, SID);
  assert.equal(r2.ok, false);
});

// ─── Adversarial review fixes ────────────────────────────────────────────

test('SECURITY: writeFileSync does NOT follow a symlink-replaced file', () => {
  // Capture a regular file. Then between capture and restore, an
  // attacker (or buggy agent) replaces the file with a symlink to
  // a sensitive path. The restore must not write through the link.
  writeFile('target.txt', 'original\n');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-snap-outside-'));
  const outsideTarget = path.join(outsideDir, 'pwned.txt');
  fs.writeFileSync(outsideTarget, 'untouched\n');
  try {
    captureSnapshot(work, store, SID);
    // Swap: target.txt becomes a symlink to outsideTarget
    fs.unlinkSync(path.join(work, 'target.txt'));
    fs.symlinkSync(outsideTarget, path.join(work, 'target.txt'));
    const res = restoreFromSnapshot(work, store, SID);
    assert.equal(res.ok, true);
    // The outside file MUST be unchanged. The restore must have
    // unlinked the symlink and written a fresh file in the workspace.
    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'untouched\n');
    assert.equal(fs.lstatSync(path.join(work, 'target.txt')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(work, 'target.txt'), 'utf8'), 'original\n');
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('SECURITY: writeFileSync does NOT follow an ancestor symlink', () => {
  // The full attack from the adversarial review: workspace/sub
  // becomes a symlink to outside; manifest tries to write
  // sub/inner.txt. The write would land outside workspace without
  // the ancestor-chain validator.
  writeFile('sub/inner.txt', 'inner original\n');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-snap-outside-'));
  try {
    captureSnapshot(work, store, SID);
    // Replace workspace/sub with a symlink pointing outside.
    fs.rmSync(path.join(work, 'sub'), { recursive: true, force: true });
    fs.symlinkSync(outsideDir, path.join(work, 'sub'));
    const res = restoreFromSnapshot(work, store, SID);
    assert.equal(res.ok, true);
    // Nothing must have been written inside outsideDir.
    assert.deepEqual(fs.readdirSync(outsideDir), []);
    // The restore should have warned for sub/inner.txt.
    assert.ok(res.warnings.find((w) => w.path === path.join('sub', 'inner.txt') || w.path === 'sub/inner.txt'));
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('SECURITY: a tampered blob (sha mismatch after decrypt) is refused', () => {
  writeFile('a.txt', 'real content\n');
  captureSnapshot(work, store, SID);
  // Locate the blob and tamper it (replace with different content).
  const blobs = path.join(store, 'sessions', SID, 'blobs');
  const blobNames = fs.readdirSync(blobs);
  assert.equal(blobNames.length, 1);
  fs.writeFileSync(path.join(blobs, blobNames[0]), 'TAMPERED\n');
  // Wipe the workspace and restore.
  fs.unlinkSync(path.join(work, 'a.txt'));
  const res = restoreFromSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  // a.txt must NOT have been restored with tampered content.
  // Because preserveExtras default is false, the destructive pass
  // does not re-create a.txt either (file was not in manifest after
  // tamper). Just confirm the warning shape:
  assert.ok(res.warnings.find((w) => /sha mismatch/.test(w.reason)));
  assert.equal(fs.existsSync(path.join(work, 'a.txt')), false);
});

test('SECURITY: manifest entries with non-hex sha values are refused', () => {
  writeFile('a.txt', 'A');
  captureSnapshot(work, store, SID);
  // Tamper the manifest to point a.txt at a non-hex sha (and
  // therefore an arbitrary filename under blobs/).
  const mp = path.join(store, 'sessions', SID, 'snapshot.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.entries['a.txt'] = { type: 'file', sha: '../../../etc/passwd' };
  fs.writeFileSync(mp, JSON.stringify(m));
  fs.unlinkSync(path.join(work, 'a.txt'));
  const res = restoreFromSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  assert.ok(res.warnings.find((w) => /64-char hex/.test(w.reason)));
  assert.equal(fs.existsSync(path.join(work, 'a.txt')), false);
});

test('joinSafely tolerates a trailing path separator on base', () => {
  // The bug from the adversarial review: base + path.sep would
  // double up if base already ended in a separator. path.resolve
  // strips trailing separators before the prefix check.
  const base = '/tmp/foo' + path.sep;
  const ok = _internal.joinSafely(base, 'sub/file.js');
  assert.equal(ok, path.resolve('/tmp/foo/sub/file.js'));
});

test('opts.preserveExtras: true skips the destructive removeExtras pass', () => {
  writeFile('keep.txt', 'keep');
  captureSnapshot(work, store, SID);
  writeFile('extra.txt', 'should survive when preserveExtras=true\n');
  const res = restoreFromSnapshot(work, store, SID, { preserveExtras: true });
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(work, 'extra.txt')), true);
  assert.equal(fs.existsSync(path.join(work, 'keep.txt')), true);
});

test('opts.preserveExtras default is false (strict-revert behavior)', () => {
  writeFile('keep.txt', 'keep');
  captureSnapshot(work, store, SID);
  writeFile('extra.txt', 'should be removed by default\n');
  const res = restoreFromSnapshot(work, store, SID);
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(work, 'extra.txt')), false);
});

test('captureSnapshotAsync matches captureSnapshot output and reports fileCount', async () => {
  writeFile('a.txt', 'a');
  writeFile('nested/b.txt', 'b');
  writeFile('nested/c.txt', 'c');
  const res = await captureSnapshotAsync(work, store, SID);
  assert.equal(res.ok, true);
  assert.equal(typeof res.fileCount, 'number');
  assert.equal(res.fileCount, 3);
  assert.ok(res.manifest.entries['a.txt']);
  assert.ok(res.manifest.entries[path.join('nested', 'b.txt')]);
  assert.ok(res.manifest.entries[path.join('nested', 'c.txt')]);
});

test('captureSnapshotAsync invokes onProgress at least once on a multi-file workspace', async () => {
  // Drop enough files past the YIELD_EVERY threshold (50) so progress
  // fires. Keep the count modest to keep the test fast.
  for (let i = 0; i < 110; i++) writeFile(`f${i}.txt`, `payload ${i}`);
  const events = [];
  const res = await captureSnapshotAsync(work, store, SID, {
    onProgress: (info) => events.push(info),
  });
  assert.equal(res.ok, true);
  assert.equal(res.fileCount, 110);
  assert.ok(events.length >= 1, 'expected at least one onProgress callback');
  for (const ev of events) {
    assert.equal(typeof ev.count, 'number');
    assert.ok(ev.count > 0);
  }
});

test('captureSnapshotAsync aborts when workspace exceeds maxEntries', async () => {
  for (let i = 0; i < 20; i++) writeFile(`f${i}.txt`, 'x');
  const res = await captureSnapshotAsync(work, store, SID, { maxEntries: 5 });
  assert.equal(res.ok, false);
  assert.match(res.error || '', /exceeds 5 files/);
});

// ─── restore safety: workspaceRoot must match the manifest ────────────────

test('restore refuses when the target dir differs from the captured manifest root', () => {
  writeFile('keep.txt', 'original');
  const cap = captureSnapshot(work, store, SID);
  assert.equal(cap.ok, true);
  // A second, unrelated directory that happens to hold the user's files.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-snap-other-'));
  try {
    fs.writeFileSync(path.join(other, 'precious.txt'), 'do not delete me');
    const res = restoreFromSnapshot(other, store, SID);
    assert.equal(res.ok, false);
    assert.match(res.error || '', /does not match the snapshot manifest/);
    // The unrelated directory's file must be untouched.
    assert.equal(fs.readFileSync(path.join(other, 'precious.txt'), 'utf8'), 'do not delete me');
  } finally {
    try { fs.rmSync(other, { recursive: true, force: true }); } catch (_) {}
  }
});
