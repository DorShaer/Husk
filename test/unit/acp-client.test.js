'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAcpClient, textPrompt, METHOD_NOT_FOUND } = require('../../src/lib/acp-client');

function harness(opts) {
  const sent = [];
  const client = createAcpClient(Object.assign({ send: (m) => sent.push(m) }, opts || {}));
  return { sent, client };
}

test('request assigns incrementing ids and settles on the matching response', async () => {
  const { sent, client } = harness();
  const p1 = client.request('initialize', { protocolVersion: 1 });
  const p2 = client.request('session/new', { cwd: '/x' });
  assert.equal(sent[0].id, 1);
  assert.equal(sent[1].id, 2);
  assert.equal(sent[0].jsonrpc, '2.0');
  client.receive({ jsonrpc: '2.0', id: 2, result: { sessionId: 's1' } });
  client.receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
  assert.deepEqual(await p2, { sessionId: 's1' });
  assert.deepEqual(await p1, { protocolVersion: 1 });
  assert.equal(client.pendingCount(), 0);
});

test('an error response rejects with code and message', async () => {
  const { client } = harness();
  const p = client.request('session/prompt', {});
  client.receive({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } });
  await assert.rejects(p, (e) => e.message === 'nope' && e.code === -32000);
});

test('session/update notifications reach onUpdate with sessionId and update', () => {
  const updates = [];
  const { client } = harness({ onUpdate: (u) => updates.push(u) });
  client.receive({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sessionId, 's1');
  assert.equal(updates[0].update.sessionUpdate, 'agent_message_chunk');
});

test('session/request_permission is answered with the option onPermission picks', async () => {
  const { sent, client } = harness({ onPermission: async (params) => params.options[1].optionId });
  client.receive({
    jsonrpc: '2.0', id: 'req-7', method: 'session/request_permission',
    params: { sessionId: 's1', toolCall: { toolCallId: 't1', title: 'rm -rf build' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] },
  });
  await new Promise((r) => setImmediate(r));
  const reply = sent.find((m) => m.id === 'req-7');
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 'req-7', result: { outcome: { outcome: 'selected', optionId: 'reject' } } });
});

test('a null permission answer cancels, and a throwing handler still answers', async () => {
  const a = harness({ onPermission: async () => null });
  a.client.receive({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: { options: [] } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a.sent[0].result, { outcome: { outcome: 'cancelled' } });

  const b = harness({ onPermission: async () => { throw new Error('ui gone'); } });
  b.client.receive({ jsonrpc: '2.0', id: 2, method: 'session/request_permission', params: { options: [] } });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.sent[0].result, { outcome: { outcome: 'cancelled' } });
});

test('unknown server requests get METHOD_NOT_FOUND instead of silence', () => {
  const { sent, client } = harness();
  client.receive({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
  assert.equal(sent[0].id, 9);
  assert.equal(sent[0].error.code, METHOD_NOT_FOUND);
});

test('initialize advertises protocol 1 with no fs or terminal capability', () => {
  const { sent, client } = harness();
  client.initialize({ name: 'husk', version: '2.12.0' });
  assert.equal(sent[0].method, 'initialize');
  assert.equal(sent[0].params.protocolVersion, 1);
  assert.deepEqual(sent[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.deepEqual(sent[0].params.clientInfo, { name: 'husk', version: '2.12.0' });
});

test('prompt and cancel use the session wire shapes', () => {
  const { sent, client } = harness();
  client.prompt('s1', textPrompt('hello'));
  client.cancel('s1');
  assert.equal(sent[0].method, 'session/prompt');
  assert.deepEqual(sent[0].params, { sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] });
  assert.equal(sent[1].method, 'session/cancel');
  assert.equal(sent[1].id, undefined);
});

test('close rejects every in-flight request', async () => {
  const { client } = harness();
  const p = client.request('session/prompt', {});
  client.close('agent exited');
  await assert.rejects(p, /agent exited/);
  await assert.rejects(client.request('x'), /closed/);
});

test('textPrompt adds ACP image blocks after the text', () => {
  assert.deepEqual(textPrompt('see', [{ mimeType: 'image/png', data: 'AAAA' }]), [{ type: 'text', text: 'see' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  assert.deepEqual(textPrompt('', [{ data: 'Z' }]), [{ type: 'image', data: 'Z', mimeType: 'image/png' }]);
  assert.deepEqual(textPrompt('plain'), [{ type: 'text', text: 'plain' }]);
});
