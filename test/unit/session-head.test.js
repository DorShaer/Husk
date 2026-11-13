'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deepFirstUserMessage } = require('../../src/lib/session-head');

function transcript(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'husk-head-')), `${Math.random()}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, size: fs.statSync(file).size };
}

test('a first message past a huge opening line is found', () => {
  const { file, size } = transcript([
    { type: 'attachment', attachment: { text: 'x'.repeat(60000) } },
    { type: 'user', message: { role: 'user', content: 'who am I ?' } },
    { type: 'assistant', message: { role: 'assistant', content: 'a person' } },
  ]);
  assert.equal(deepFirstUserMessage(fs, file, size), 'who am I ?');
});

test('notes Husk sent ahead of the prompt are not the title, and wrappers are skipped', () => {
  const framed = '[Husk Brain: notes kept for this workspace that may bear on the message below.]\n- a: b\n[End of Husk Brain notes]\n\nfix the login bug';
  const { file, size } = transcript([
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: framed }] } },
  ]);
  assert.equal(deepFirstUserMessage(fs, file, size, { skip: (t) => t.startsWith('<command-') }), 'fix the login bug');
});

test('a transcript with no typed message gives nothing, and a file over the cap is left alone', () => {
  const { file, size } = transcript([{ type: 'assistant', message: { role: 'assistant', content: 'hi' } }]);
  assert.equal(deepFirstUserMessage(fs, file, size), '');
  assert.equal(deepFirstUserMessage(fs, file, 9 * 1024 * 1024), '');
});
