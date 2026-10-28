'use strict';

// The record of which claude sessions are Husk's own chats.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChatSessionRegistry } = require('../../src/lib/chat-session-registry');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'husk-reg-')), 'chat-sessions.json');
}

test('a session Husk opened is known afterwards, across a restart', () => {
  const file = tmpFile();
  const a = createChatSessionRegistry({ file, fs });
  assert.equal(a.has('320639f2-926d-41cf-bba3-5ec12c5a6d11'), false);
  assert.equal(a.add('320639f2-926d-41cf-bba3-5ec12c5a6d11'), true);
  assert.equal(a.add('320639f2-926d-41cf-bba3-5ec12c5a6d11'), false, 'a second add of the same id rewrote the file');
  const b = createChatSessionRegistry({ file, fs });
  assert.equal(b.has('320639f2-926d-41cf-bba3-5ec12c5a6d11'), true, 'the id did not survive a reload from disk');
  assert.equal(b.has('116f6389-e5e3-436d-beec-018a3c613dfb'), false);
});

test('the session line of a resumed chat is enough to record it', () => {
  const r = createChatSessionRegistry({ file: tmpFile(), fs });
  r.addFromEvents([{ type: 'text_delta', text: 'hi' }, { type: 'session', sessionId: 'de550eaf-fb8c-4e30-945d-47a7901e6d87', model: 'x' }]);
  r.addFromEvents({ type: 'session', model: 'only-a-model' });
  assert.equal(r.has('de550eaf-fb8c-4e30-945d-47a7901e6d87'), true);
  assert.equal(r.size(), 1);
});

test('ids recorded before the file existed count through the seed', () => {
  const r = createChatSessionRegistry({ file: tmpFile(), fs, seed: () => ['0ef56f9a-8e5a-4d65-8f18-0eed81ff47c4'] });
  assert.equal(r.has('0ef56f9a-8e5a-4d65-8f18-0eed81ff47c4'), true);
  assert.equal(r.size(), 0, 'the seed was written to disk');
});

test('junk is refused and a torn file reads as empty', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '[{"not":"an id"}, "ok-looking-id-1234", 7, "../x"');
  const r = createChatSessionRegistry({ file, fs });
  assert.equal(r.size(), 0);
  for (const bad of ['', 'short', 'a b c d e f g h', 'x;rm -rf', null, undefined]) assert.equal(r.add(bad), false, `${JSON.stringify(bad)} was recorded`);
  assert.equal(r.add('ok-looking-id-1234'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), ['ok-looking-id-1234']);
});

test('the record is capped at the newest ids', () => {
  const file = tmpFile();
  const r = createChatSessionRegistry({ file, fs, cap: 3 });
  for (let i = 0; i < 5; i++) r.add(`session-id-${i}-xxxxxxxx`);
  assert.equal(r.has('session-id-0-xxxxxxxx'), false);
  assert.equal(r.has('session-id-4-xxxxxxxx'), true);
  assert.equal(r.size(), 3);
});
