'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  claudeChatArgs, encodeUserMessage, encodePermissionResponse, encodeInterrupt, isPermissionRequest,
} = require('../../src/lib/claude-stream');

test('claudeChatArgs builds the bidirectional stream-json argv', () => {
  assert.deepEqual(claudeChatArgs(), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio',
  ]);
});

test('claudeChatArgs appends resume, else session-id, then user flags', () => {
  const r = claudeChatArgs({ resume: 'abc', sessionId: 'ignored', userFlags: ['--model', 'opus'] });
  assert.deepEqual(r.slice(-4), ['--resume', 'abc', '--model', 'opus']);
  const s = claudeChatArgs({ sessionId: 'sid' });
  assert.deepEqual(s.slice(-2), ['--session-id', 'sid']);
});

test('encodeUserMessage matches the stdin line shape', () => {
  assert.deepEqual(encodeUserMessage('hi'), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
});

test('encodePermissionResponse allows with the input and denies with a message', () => {
  assert.deepEqual(encodePermissionResponse('r1', true, { command: 'ls' }), {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } },
  });
  const d = encodePermissionResponse('r2', false);
  assert.equal(d.response.response.behavior, 'deny');
  assert.ok(d.response.response.message.length > 0);
});

test('encodeInterrupt and isPermissionRequest', () => {
  assert.deepEqual(encodeInterrupt('i1'), { type: 'control_request', request_id: 'i1', request: { subtype: 'interrupt' } });
  assert.equal(isPermissionRequest({ type: 'control_request', request: { subtype: 'can_use_tool' } }), true);
  assert.equal(isPermissionRequest({ type: 'control_request', request: { subtype: 'initialize' } }), false);
  assert.equal(isPermissionRequest({ type: 'assistant' }), false);
});

test('encodePermissionResponse carries updatedPermissions only on allow with suggestions', () => {
  const sugg = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  assert.deepEqual(encodePermissionResponse('r1', true, { a: 1 }, undefined, sugg).response.response, { behavior: 'allow', updatedInput: { a: 1 }, updatedPermissions: sugg });
  assert.equal(encodePermissionResponse('r1', true, { a: 1 }, undefined, []).response.response.updatedPermissions, undefined);
  assert.equal(encodePermissionResponse('r1', false, { a: 1 }, 'no', sugg).response.response.updatedPermissions, undefined);
});

test('encodeUserMessage carries pasted images as base64 image blocks', () => {
  const m = encodeUserMessage('look', [{ mimeType: 'image/png', data: 'AAAA' }, { mimeType: 'image/jpeg', data: 'BBBB' }, { data: '' }]);
  assert.deepEqual(m.message.content, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
  ]);
  // Image only: no empty text block.
  assert.equal(encodeUserMessage('', [{ data: 'X' }]).message.content[0].type, 'image');
  assert.equal(encodeUserMessage('', [{ data: 'X' }]).message.content[0].source.media_type, 'image/png');
});
