'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openaiTurn, openaiModels } = require('../../src/lib/openai-stream');

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, base: `http://127.0.0.1:${s.address().port}/v1` }));
  });
}

test('openaiTurn streams SSE deltas as claude-shaped events and reports the full text', async () => {
  const { s, base } = await server((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const events = [];
  const text = await new Promise((resolve, reject) => {
    openaiTurn({ baseUrl: base, apiKey: 'k', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      (ev) => events.push(ev),
      (err, r) => (err ? reject(err) : resolve(r.text)));
  });
  s.close();
  assert.equal(text, 'Hello');
  const deltas = events.filter((e) => e.event && e.event.type === 'content_block_delta').map((e) => e.event.delta.text);
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.ok(events.some((e) => e.event && e.event.type === 'message_start'));
  assert.ok(events.some((e) => e.event && e.event.type === 'message_stop'));
  const asst = events.find((e) => e.type === 'assistant');
  assert.equal(asst.message.content[0].text, 'Hello');
});

test('openaiTurn surfaces an HTTP error through done()', async () => {
  const { s, base } = await server((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad key' } }));
  });
  const err = await new Promise((resolve) => {
    openaiTurn({ baseUrl: base, apiKey: 'k', model: 'm', messages: [] }, () => {}, (e) => resolve(e));
  });
  s.close();
  assert.ok(err && /401/.test(err.message) && /bad key/.test(err.message));
});

test('openaiModels reads the OpenAI /models list and the Ollama /api tags shape', async () => {
  const { s, base } = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-5-nano' }] }));
  });
  const models = await new Promise((resolve, reject) => openaiModels({ baseUrl: base, apiKey: 'k' }, (e, m) => (e ? reject(e) : resolve(m))));
  s.close();
  assert.deepEqual(models, ['gpt-6-luna', 'gpt-5-nano']);
});
