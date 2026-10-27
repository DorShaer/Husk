'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { claudeTranscriptToEvents, copilotEventsToEvents, transcriptToEvents, isSyntheticPrompt } = require('../../src/lib/transcript-replay');
const { emptyThread, reduceThread } = require('../../src/lib/chat-events');

function lines(objs) { return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'; }
function fold(events) { return events.reduce((s, e) => reduceThread(s, e), emptyThread()); }

test('claude transcript: prompts, text, tool use and results become a thread', () => {
  const raw = lines([
    { type: 'last-prompt', leafUuid: 'x', sessionId: 's' },
    { type: 'attachment', attachment: { type: 'hook_success' } },
    { type: 'user', isSidechain: false, message: { role: 'user', content: '<local-command-caveat>ran /model</local-command-caveat>' } },
    { type: 'user', message: { role: 'user', content: 'Create note.txt' } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'thinking', thinking: 'plan it', signature: 'z' }] } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'Writing note.txt now.' }] } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/p/note.txt', content: 'hi' } }] } },
    { type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'File created' }] } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'Done.' }] } },
    { type: 'cost-state', totalCostUSD: 1 },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'and now read it' }] } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'It says hi.' }] } },
  ]);
  const ev = claudeTranscriptToEvents(raw);
  assert.deepEqual(ev.map((e) => e.type), ['user', 'session', 'thought', 'block_end', 'text_final', 'tool', 'tool', 'text_final', 'turn_end', 'user', 'text_final', 'turn_end']);
  const s = fold(ev);
  assert.equal(s.model, 'claude-x');
  assert.equal(s.turnOpen, false);
  const kinds = s.items.map((i) => i.kind);
  assert.deepEqual(kinds, ['user', 'thought', 'text', 'tool', 'text', 'meta', 'user', 'text', 'meta']);
  assert.equal(s.items[0].text, 'Create note.txt');
  assert.equal(s.items[3].title, 'Write');
  assert.equal(s.items[3].status, 'done');
  assert.equal(s.items[3].output, 'File created');
  assert.equal(s.items[6].text, 'and now read it');
});

test('claude transcript keeps CLI-authored user turns out of the thread', () => {
  // Sampled from a real log on 2026-10-27: a background task notification, the
  // summary written after compaction, a slash command echo and an attachment
  // companion all land as `user` lines, and none of them is the user's words.
  const raw = lines([
    { type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: 'watch the build' } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'Watching.' }] } },
    { type: 'user', promptSource: 'system', turnOrigin: 'task_notification', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor "Wait for the build" stream ended</summary>\n</task-notification>' } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'Build is green.' }] } },
    { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation...' } },
    { type: 'user', isMeta: true, turnCompanion: true, message: { role: 'user', content: '[Image: source: /tmp/x.png]' } },
    { type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } },
    { type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } },
    { type: 'user', promptSource: 'typed', message: { role: 'user', content: [{ type: 'text', text: '<task-notification><summary>Old-format notice</summary></task-notification>' }] } },
    { type: 'user', promptSource: 'typed', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }, { type: 'text', text: 'now ship it' }] } },
    { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'Shipping.' }] } },
  ]);
  const ev = claudeTranscriptToEvents(raw);
  const users = ev.filter((e) => e.type === 'user').map((e) => e.text);
  assert.deepEqual(users, ['watch the build', 'now ship it']);
  const notes = ev.filter((e) => e.type === 'status').map((e) => e.text);
  assert.deepEqual(notes, [
    'Background task: Monitor "Wait for the build" stream ended',
    'The agent summarized the conversation so far to free up context.',
    'Background task: Old-format notice',
  ]);
  const s = fold(ev);
  assert.equal(s.turnOpen, false);
  assert.ok(!s.items.some((i) => i.kind === 'user' && /^</.test(i.text)));
});

test('claude transcript tolerates torn lines and an unfinished last turn', () => {
  const raw = lines([{ type: 'user', message: { role: 'user', content: 'go' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }]) + '{"type":"assistant","message":{"con';
  const ev = claudeTranscriptToEvents(raw);
  assert.equal(ev[ev.length - 1].type, 'turn_end');
  assert.equal(fold(ev).turnOpen, false);
});

test('copilot events: message, tool, permission and turn end', () => {
  const raw = lines([
    { type: 'session.start', data: {} },
    { type: 'session.model_change', data: { newModel: 'gpt-6-luna' } },
    { type: 'user.message', data: { content: 'Create hi.txt' } },
    { type: 'assistant.turn_start', data: { turnId: '0' } },
    { type: 'assistant.message', data: { content: '', toolRequests: [{ toolCallId: 'c1', name: 'apply_patch', arguments: '*** Begin Patch\n*** Add File: hi.txt\n+hi\n*** End Patch\n' }] } },
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'apply_patch', toolTitle: 'Applying patch' } },
    { type: 'permission.requested', data: { requestId: 'r1', permissionRequest: { kind: 'write', toolCallId: 'c1', intention: 'Create file', fileName: '/w/hi.txt' } } },
    { type: 'permission.completed', data: { requestId: 'r1', result: { kind: 'approved' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: 'Added 1 file(s)' } } },
    { type: 'assistant.message', data: { content: 'Created hi.txt.' } },
    { type: 'assistant.turn_end', data: { turnId: '0' } },
  ]);
  const ev = copilotEventsToEvents(raw);
  const s = fold(ev);
  assert.equal(s.model, 'gpt-6-luna');
  assert.deepEqual(s.items.map((i) => i.kind), ['user', 'tool', 'permission', 'text', 'meta']);
  assert.equal(s.items[1].title, 'Applying patch');
  assert.equal(s.items[1].status, 'done');
  assert.equal(s.items[1].output, 'Added 1 file(s)');
  assert.equal(s.items[2].decision, 'approved');
  assert.equal(s.items[2].title, 'Create file');
  assert.equal(s.items[3].text, 'Created hi.txt.');
  assert.equal(s.turnOpen, false);
});

test('transcriptToEvents routes by agent and isSyntheticPrompt spots CLI echoes', () => {
  assert.deepEqual(transcriptToEvents('aider', 'x'), []);
  assert.equal(transcriptToEvents('claude', lines([{ type: 'user', message: { content: 'hi' } }]))[0].type, 'user');
  assert.equal(transcriptToEvents('copilot', lines([{ type: 'user.message', data: { content: 'hi' } }]))[0].type, 'user');
  assert.equal(isSyntheticPrompt('<local-command-caveat>x'), true);
  assert.equal(isSyntheticPrompt('  <command-name>/model</command-name>'), true);
  assert.equal(isSyntheticPrompt('hello'), false);
});
