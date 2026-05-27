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
