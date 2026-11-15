'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listClaudeTranscripts, scanTranscript, realPath, WHOLE_SCAN_CAP } = require('../../src/lib/session-scan');
const { inCurrentProject } = require('../../src/lib/session-view');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-session-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function transcript(content, extra = {}) {
  return [
    JSON.stringify({ type: 'user', promptSource: 'sdk', message: { role: 'user', content }, ...extra }),
    JSON.stringify({ type: 'assistant', message: { content: 'Done' } }),
  ].join('\n');
}
function scan(t, text) {
  const file = path.join(fixture(t), 'session.jsonl');
  fs.writeFileSync(file, text);
  return scanTranscript(file, Buffer.byteLength(text));
}

test('caps surviving chats after classifying 2500 transcripts and reuses reads', (t) => {
  const root = fixture(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const cache = new Map();
  const reads = (file) => {
    if (!cache.has(file)) cache.set(file, {});
    return cache.get(file);
  };
  for (let i = 0; i < 2500; i++) {
    const file = path.join(project, `${i}.jsonl`);
    fs.writeFileSync(file, transcript(i < 68 ? [{ type: 'text', text: `Chat ${i}` }] : 'Background'));
    fs.utimesSync(file, 1700000000 + i, 1700000000 + i);
  }
  const options = { reads, accept: ({ scan }) => !scan.oneShot };
  const first = listClaudeTranscripts(root, options);
  assert.equal(first.length, 68);
  assert.deepEqual(first.map((s) => s.id), Array.from({ length: 68 }, (_, i) => String(67 - i)));
  const cached = cache.get(first[0].fullPath).scan;
  assert.equal(listClaudeTranscripts(root, options)[0].scan, cached);
  assert.equal(listClaudeTranscripts(root, { ...options, cap: 10 }).length, 10);
});

test('classifies user records and keeps stream chats without a registry entry', (t) => {
  assert.equal(scan(t, transcript('Background')).oneShot, true);
  assert.equal(scan(t, transcript([{ type: 'text', text: 'Chat' }])).oneShot, false);
  assert.equal(scan(t, transcript('Chat', { promptSource: 'typed' })).oneShot, false);
  assert.equal(scan(t, transcript('Old chat', { promptSource: undefined })).oneShot, false);
  assert.equal(scan(t, JSON.stringify({ type: 'queue-operation', content: 'Queued' })).receipt, true);
});

test('reads authorship beyond the head and ignores marker text in messages', (t) => {
  const long = 'x'.repeat(40000);
  assert.equal(scan(t, transcript(long)).oneShot, true);
  assert.equal(scan(t, transcript([{ type: 'text', text: long }])).oneShot, false);
  const human = JSON.stringify({ type: 'user', promptSource: 'typed', message: { content: 'Follow up' } });
  assert.equal(scan(t, transcript(long) + '\n' + human).oneShot, false);
  assert.equal(scan(t, transcript(long + ' "kind":"human"')).oneShot, true);
  assert.equal(scan(t, transcript('x'.repeat(WHOLE_SCAN_CAP + 1))).oneShot, false);
});

test('matches resolved folders, descendants, trailing separators and missing folders', (t) => {
  const root = fixture(t);
  const project = path.join(root, 'project');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(project);
  fs.symlinkSync(project, alias, 'dir');
  const current = realPath(alias);
  assert.equal(current, project);
  assert.equal(inCurrentProject({ realCwd: realPath(path.join(alias, 'missing', 'child')) }, current), true);
  assert.equal(inCurrentProject({ originalCwd: `${project}/` }, `${current}/`), true);
  assert.equal(inCurrentProject({ originalCwd: `${project}-other` }, current), false);
  assert.equal(inCurrentProject({ originalCwd: project }, ''), false);
  assert.equal(inCurrentProject({ originalCwd: project }, '/'), true);
  assert.equal(inCurrentProject({ realCwd: 'C:\\work\\project\\child' }, 'C:\\work\\project\\'), true);
});
