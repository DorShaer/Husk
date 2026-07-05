'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pickResumeSessionId } = require('../../src/lib/claude-session');

function tempProj() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'husk-sess-'));
}

// Write a transcript file and (optionally) backdate its mtime so ordering is
// deterministic regardless of filesystem timestamp granularity.
function writeTranscript(dir, id, mtimeMs) {
  const p = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(p, '{}\n');
  if (mtimeMs != null) { const t = mtimeMs / 1000; fs.utimesSync(p, t, t); }
  return p;
}

test('pickResumeSessionId: resumes the saved id when its transcript exists', () => {
  const dir = tempProj();
  writeTranscript(dir, 'aaaa-1111');
  writeTranscript(dir, 'bbbb-2222');
  // Even though bbbb may be newer, an explicit saved id wins.
  assert.equal(pickResumeSessionId(dir, 'aaaa-1111'), 'aaaa-1111');
});

test('pickResumeSessionId: ignores a saved id whose transcript is gone, falls back to newest', () => {
  const dir = tempProj();
  writeTranscript(dir, 'old-session', 1000);
  writeTranscript(dir, 'new-session', 2000);
  // Saved id was deleted on disk -> do not resume a missing file; take newest.
  assert.equal(pickResumeSessionId(dir, 'deleted-id'), 'new-session');
});

test('pickResumeSessionId: with no saved id, resumes the newest transcript', () => {
  const dir = tempProj();
  writeTranscript(dir, 'first', 1000);
  writeTranscript(dir, 'second', 3000);
  writeTranscript(dir, 'third', 2000);
  assert.equal(pickResumeSessionId(dir, null), 'second');
});

test('pickResumeSessionId: returns null for an empty project dir (caller mints fresh)', () => {
  const dir = tempProj();
  assert.equal(pickResumeSessionId(dir, null), null);
});

test('pickResumeSessionId: returns null when the project dir does not exist', () => {
  assert.equal(pickResumeSessionId('/no/such/husk/proj/dir', 'anything'), null);
});

test('pickResumeSessionId: ignores non-jsonl files when picking newest', () => {
  const dir = tempProj();
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  writeTranscript(dir, 'only-session', 1000);
  assert.equal(pickResumeSessionId(dir, null), 'only-session');
});
