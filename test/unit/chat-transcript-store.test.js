'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTranscriptStore, transcriptId, pruneDir, writePrivate } = require('../../src/lib/chat-transcript-store');

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'husk-ts-')), 'transcripts'); }
const mode = (p) => fs.statSync(p).mode & 0o777;

test('append keeps events in order and merges streamed text into one line', () => {
  const dir = tmp();
  const store = createTranscriptStore({ dir, fs });
  store.append('gemini-s1', { type: 'user', text: 'hi' });
  store.append('gemini-s1', { type: 'text', text: 'Hel' });
  store.append('gemini-s1', { type: 'text', text: 'lo' });
  store.append('gemini-s1', { type: 'tool', id: 't1', title: 'Read', detail: 'a.js' });
  store.append('gemini-s1', { type: 'turn_end', stopReason: 'end_turn' });
  assert.deepStrictEqual(store.read('gemini-s1').map((e) => [e.type, e.text || e.title || '']), [
    ['user', 'hi'], ['text', 'Hello'], ['tool', 'Read'], ['turn_end', ''],
  ]);
  assert.strictEqual(fs.readFileSync(store.fileOf('gemini-s1'), 'utf8').trim().split('\n').length, 4);
});

test('read returns text that is still streaming', () => {
  const store = createTranscriptStore({ dir: tmp(), fs });
  store.append('a-1', { type: 'user', text: 'q' });
  store.append('a-1', { type: 'text', text: 'partial' });
  assert.strictEqual(store.read('a-1')[1].text, 'partial');
});

test('a full message replaces the chunks streamed ahead of it', () => {
  const store = createTranscriptStore({ dir: tmp(), fs });
  store.append('a-1', { type: 'text', text: 'draft' });
  store.append('a-1', { type: 'text_final', text: 'final' });
  assert.deepStrictEqual(store.read('a-1').map((e) => e.text), ['final']);
});

test('state events are not stored and long tool output is shortened', () => {
  const store = createTranscriptStore({ dir: tmp(), fs });
  for (const type of ['session', 'commands', 'usage', 'thought', 'mode']) assert.strictEqual(store.append('a-1', { type, text: 'x' }), false);
  store.append('a-1', { type: 'tool', id: 't', output: 'o'.repeat(9000), input: { blob: 'i'.repeat(9000) }, diffs: [{ path: 'a.js', oldText: 'x', newText: 'y' }] });
  const [tool] = store.read('a-1');
  assert.strictEqual(tool.output.length, 2000);
  assert.strictEqual(tool.input, undefined);
  assert.deepStrictEqual(tool.diffs, [{ path: 'a.js' }]);
});

test('ids that are not plain names are refused', () => {
  const dir = tmp();
  const store = createTranscriptStore({ dir, fs });
  for (const id of ['../x', 'a/b', '', '.hidden', null]) {
    assert.strictEqual(store.append(id, { type: 'user', text: 'x' }), false);
    assert.deepStrictEqual(store.read(id), []);
  }
  assert.strictEqual(fs.existsSync(dir), false);
  assert.strictEqual(transcriptId('gemini', 'abc/../def'), 'gemini-abc_.._def');
});

test('a file past its cap keeps the newest events', () => {
  const store = createTranscriptStore({ dir: tmp(), fs, maxBytes: 4000 });
  for (let i = 0; i < 100; i++) store.append('a-1', { type: 'user', text: `message ${i} ${'x'.repeat(80)}` });
  const events = store.read('a-1');
  assert.ok(fs.statSync(store.fileOf('a-1')).size <= 4000);
  assert.strictEqual(events[0].type, 'status');
  assert.ok(events[events.length - 1].text.startsWith('message 99 '));
  assert.ok(events.length < 60);
});

test('the directory is 0700 and each file 0600', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const store = createTranscriptStore({ dir, fs, maxBytes: 600 });
  store.append('a-1', { type: 'user', text: 'x' });
  assert.strictEqual(mode(dir), 0o700);
  assert.strictEqual(mode(store.fileOf('a-1')), 0o600);
  for (let i = 0; i < 20; i++) store.append('a-1', { type: 'user', text: 'y'.repeat(100) });
  assert.strictEqual(mode(store.fileOf('a-1')), 0o600);
  const file = writePrivate(fs, path.join(dir, '..', 'handoffs'), 'h.md', 'doc');
  assert.strictEqual(mode(file), 0o600);
  assert.strictEqual(mode(path.dirname(file)), 0o700);
});

test('a link in place of a transcript is not written through', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const store = createTranscriptStore({ dir, fs });
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, '..', 'target.txt');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, store.fileOf('a-1'));
  assert.strictEqual(store.append('a-1', { type: 'user', text: 'x' }), false);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'keep');
});

test('prune removes files older than the retention and keeps the rest', () => {
  const dir = tmp();
  const store = createTranscriptStore({ dir, fs });
  store.append('old-1', { type: 'user', text: 'x' });
  store.append('new-1', { type: 'user', text: 'x' });
  const past = new Date(Date.now() - 31 * 864e5);
  fs.utimesSync(store.fileOf('old-1'), past, past);
  assert.strictEqual(store.prune(0), 0);
  assert.strictEqual(store.prune(30), 1);
  assert.strictEqual(store.has('old-1'), false);
  assert.strictEqual(store.has('new-1'), true);
  assert.strictEqual(pruneDir(fs, path.join(dir, 'missing'), 30), 0);
});

test('a single oversized message stays within the transcript cap', () => {
  const store = createTranscriptStore({ dir: tmp(), fs, maxBytes: 4000 });
  store.append('large-1', { type: 'user', text: 'x'.repeat(20000) });
  assert.ok(fs.statSync(store.fileOf('large-1')).size <= 4000);
  assert.strictEqual(store.read('large-1')[0].type, 'user');
});

test('block boundaries keep separate assistant messages and flushAll persists pending text', () => {
  const store = createTranscriptStore({ dir: tmp(), fs });
  store.append('blocks-1', { type: 'text', text: 'First' });
  store.append('blocks-1', { type: 'block_end' });
  store.append('blocks-1', { type: 'text', text: 'Second' });
  store.flushAll();
  assert.deepStrictEqual(store.read('blocks-1').map((e) => e.text || e.type), ['First', 'block_end', 'Second']);
});

test('reads refuse transcript links and private directory links', { skip: process.platform === 'win32' }, () => {
  const dir = tmp(); fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, '..', 'external.jsonl');
  fs.writeFileSync(target, JSON.stringify({ type: 'user', text: 'External content' }) + '\n');
  fs.symlinkSync(target, path.join(dir, 'linked-1.jsonl'));
  const store = createTranscriptStore({ dir, fs });
  assert.deepStrictEqual(store.read('linked-1'), []);
  assert.strictEqual(store.has('linked-1'), false);
  const alias = dir + '-alias'; fs.symlinkSync(dir, alias, 'dir');
  const linkedStore = createTranscriptStore({ dir: alias, fs });
  assert.strictEqual(linkedStore.append('new-1', { type: 'user', text: 'q' }), false);
});
test('appending restores private permissions on an existing transcript', { skip: process.platform === 'win32' }, () => {
  const store = createTranscriptStore({ dir: tmp(), fs });
  store.append('private-1', { type: 'user', text: 'First' });
  fs.chmodSync(store.fileOf('private-1'), 0o644);
  store.append('private-1', { type: 'user', text: 'Second' });
  assert.strictEqual(mode(store.fileOf('private-1')), 0o600);
});
