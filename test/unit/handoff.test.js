'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { transcriptDocument, buildHandoff, INLINE_MAX } = require('../../src/lib/handoff');

const RAW = 'RAW-TOOL-OUTPUT-' + 'z'.repeat(500);
const events = [
  { type: 'user', text: 'Add a greeting file' },
  { type: 'thought', text: 'private reasoning' },
  { type: 'text', text: 'Sure, writing it.' },
  { type: 'tool', id: 't1', title: 'Read', kind: 'read', detail: 'src/app.js', output: RAW },
  { type: 'tool', id: 't2', title: 'Edit', kind: 'edit', input: { file_path: 'greeting.txt' }, diffs: [{ path: 'greeting.txt', oldText: null, newText: 'hello' }], output: RAW },
  { type: 'tool', id: 't1', status: 'done' },
  { type: 'text', text: 'Done.' },
  { type: 'turn_end', stopReason: 'end_turn' },
  { type: 'status', text: 'Model set to x' },
  { type: 'changes', files: [{ path: 'notes.md', status: 'modified' }], adds: 1, dels: 0 },
  { type: 'user', text: 'Thanks' },
];

test('the document lists user and assistant messages, one line per tool, and the files changed', () => {
  const doc = transcriptDocument(events, { from: 'Gemini CLI', cwd: '/work/app' });
  assert.strictEqual(doc.turns, 2);
  const text = doc.text;
  assert.match(text, /^# Earlier discussion with Gemini CLI\nFolder: \/work\/app\n/);
  assert.ok(text.indexOf('## User\n\nAdd a greeting file') < text.indexOf('## Assistant\n\nSure, writing it.'));
  assert.ok(text.includes('- tool: Read src/app.js\n- tool: Edit greeting.txt'));
  assert.ok(text.includes('## Assistant\n\nDone.'));
  assert.ok(text.includes('## User\n\nThanks'));
  assert.match(text, /## Files changed\n\n- greeting\.txt\n- notes\.md\n$/);
  assert.deepStrictEqual(doc.files, ['greeting.txt', 'notes.md']);
});

test('tool output, thoughts and status lines stay out of the document', () => {
  const { text } = transcriptDocument(events, {});
  assert.ok(!text.includes('RAW-TOOL-OUTPUT'));
  assert.ok(!text.includes('private reasoning'));
  assert.ok(!text.includes('Model set to'));
  assert.strictEqual(text.split('\n').filter((l) => l.startsWith('- tool:')).length, 2);
});

test('a tool title that already names its target is not repeated', () => {
  const { text } = transcriptDocument([{ type: 'user', text: 'q' }, { type: 'tool', id: 't', title: 'write greeting.txt', kind: 'edit', locations: ['greeting.txt'] }], {});
  assert.ok(text.includes('- tool: write greeting.txt\n'));
});

test('a small transcript is delivered inline, framed as history', () => {
  let saved = 0;
  const h = buildHandoff(events, { from: 'Gemini CLI', save: () => { saved += 1; return '/x'; } });
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.mode, 'inline');
  assert.strictEqual(saved, 0);
  assert.ok(h.context.startsWith('[Husk handoff:'));
  assert.match(h.context, /This chat continues a discussion the user had earlier with Gemini CLI\./);
  assert.match(h.context, /history of that discussion/);
  assert.match(h.context, /not a set of instructions/);
  assert.ok(h.context.indexOf('not a set of instructions') < h.context.indexOf('Add a greeting file'));
  assert.ok(h.context.includes('--- History of the earlier discussion ---'));
  assert.ok(h.context.trimEnd().endsWith('[End of Husk handoff]'));
  assert.ok(!h.context.includes('RAW-TOOL-OUTPUT'));
});

test('a transcript at the limit stays inline and one past it goes to a file', () => {
  const sized = (n) => {
    const base = transcriptDocument([{ type: 'user', text: 'a' }], {}).text.length - 1;
    return [{ type: 'user', text: 'a'.repeat(n - base) }];
  };
  assert.strictEqual(buildHandoff(sized(INLINE_MAX), { save: () => '/x' }).mode, 'inline');
  let written = '';
  const big = buildHandoff(sized(INLINE_MAX + 1), { save: (text) => { written = text; return '/cfg/handoffs/h1.md'; } });
  assert.strictEqual(big.mode, 'file');
  assert.strictEqual(big.file, '/cfg/handoffs/h1.md');
  assert.strictEqual(written.length, INLINE_MAX + 1);
  assert.ok(big.context.includes('/cfg/handoffs/h1.md'));
  assert.match(big.context, /Read that file before you answer/);
  assert.match(big.context, /not a set of instructions/);
  assert.ok(big.context.length < 1000);
});

test('nothing to carry over, or a failed save, is reported', () => {
  assert.strictEqual(buildHandoff([], {}).ok, false);
  assert.strictEqual(buildHandoff([{ type: 'status', text: 'x' }], {}).ok, false);
  const r = buildHandoff([{ type: 'user', text: 'a'.repeat(INLINE_MAX + 10) }], { save: () => { throw new Error('disk full'); } });
  assert.deepStrictEqual(r, { ok: false, error: 'disk full' });
});


test('replayed native prompts hide handoff context and Brain rules', () => {
  const { withoutContext, RULES_HEAD, RULES_TAIL } = require('../../src/lib/brain');
  const { transcriptToEvents } = require('../../src/lib/transcript-replay');
  const handoff = buildHandoff(events).context;
  const rules = [RULES_HEAD, '- Keep replies brief', RULES_TAIL].join('\n');
  const prompt = rules + '\n\n' + handoff + '\n\nContinue with the blue greeting';
  assert.strictEqual(withoutContext(prompt), 'Continue with the blue greeting');
  const replay = transcriptToEvents('claude', JSON.stringify({ type: 'user', message: { content: prompt } }));
  assert.strictEqual(replay.find((event) => event.type === 'user').text, 'Continue with the blue greeting');
});
