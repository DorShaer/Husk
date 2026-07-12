'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// main.js is an Electron entrypoint and cannot be required, so lift the real
// latestAiTitle out of the source and run it against transcripts on disk.
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
const IMPL = SRC.match(/const aiTitleCache = new Map\(\);[\s\S]*?\nfunction latestAiTitle\(fullPath\) \{[\s\S]*?\n\}\n/);
assert.ok(IMPL, 'could not find latestAiTitle in src/main.js');

function freshImpl() {
  const ctx = { fs, Map, Buffer, JSON };
  vm.createContext(ctx);
  vm.runInContext(`${IMPL[0]}\nthis.latestAiTitle = latestAiTitle;`, ctx);
  return ctx.latestAiTitle;
}

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-title-'));
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// A filler entry big enough that a handful push the transcript past the 32KB
// window the head parser reads.
const filler = (i) => ({ type: 'assistant', timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`, message: { content: 'x'.repeat(4096) } });

test('finds a title written past the 32KB head window', () => {
  const latestAiTitle = freshImpl();
  const lines = [{ type: 'user', message: { content: 'hello' } }];
  for (let i = 0; i < 20; i++) lines.push(filler(i)); // ~80KB of transcript
  lines.push({ type: 'ai-title', aiTitle: 'Configure the Slack bot' });
  const p = writeTranscript(lines);

  assert.ok(fs.statSync(p).size > 32768, 'transcript must exceed the head window');
  assert.equal(latestAiTitle(p), 'Configure the Slack bot');
});

test('keeps the newest title when the agent refines it', () => {
  const latestAiTitle = freshImpl();
  const p = writeTranscript([
    { type: 'user', message: { content: 'hi' } },
    { type: 'ai-title', aiTitle: 'First guess' },
    filler(1),
    { type: 'ai-title', aiTitle: 'Better name' },
    { type: 'ai-title', aiTitle: 'Final name' },
  ]);
  assert.equal(latestAiTitle(p), 'Final name');
});

test('picks up a title appended after an earlier read', () => {
  const latestAiTitle = freshImpl();
  const p = writeTranscript([{ type: 'user', message: { content: 'hi' } }]);
  assert.equal(latestAiTitle(p), '', 'no title yet');

  fs.appendFileSync(p, JSON.stringify({ type: 'ai-title', aiTitle: 'Earned a name' }) + '\n');
  assert.equal(latestAiTitle(p), 'Earned a name', 'the appended title is seen on the next read');
});

test('a partially written last line is not consumed until it is complete', () => {
  const latestAiTitle = freshImpl();
  const p = writeTranscript([{ type: 'user', message: { content: 'hi' } }]);

  // The agent is mid-write: the line has no trailing newline yet.
  fs.appendFileSync(p, '{"type":"ai-title","aiTitle":"Half writ');
  assert.equal(latestAiTitle(p), '', 'an incomplete line yields no title');

  fs.appendFileSync(p, 'ten"}\n');
  assert.equal(latestAiTitle(p), 'Half written', 'the line resolves once it is complete');
});

test('a replaced (shorter) transcript is rescanned rather than trusted from cache', () => {
  const latestAiTitle = freshImpl();
  const p = writeTranscript([
    { type: 'user', message: { content: 'hi' } },
    filler(1),
    { type: 'ai-title', aiTitle: 'Old session' },
  ]);
  assert.equal(latestAiTitle(p), 'Old session');

  fs.writeFileSync(p, JSON.stringify({ type: 'user', message: { content: 'brand new' } }) + '\n');
  assert.equal(latestAiTitle(p), '', 'the new, shorter transcript has no title of its own');
});

test('a transcript with no title yields an empty string, not a throw', () => {
  const latestAiTitle = freshImpl();
  const p = writeTranscript([{ type: 'user', message: { content: 'hi' } }, filler(1)]);
  assert.equal(latestAiTitle(p), '');
});

test('a missing file yields an empty string', () => {
  const latestAiTitle = freshImpl();
  assert.equal(latestAiTitle('/nonexistent/session.jsonl'), '');
});
