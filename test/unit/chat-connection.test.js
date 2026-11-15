'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveChatConnection } = require('../../src/lib/chat-connection');
const config = { agentVendor: 'openai', agentBaseUrl: 'http://localhost:9999/v1', agentModel: 'local-model', agentApiKey: 'test-key' };
test('endpoint default cannot redirect an explicitly chosen CLI chat', () => {
  for (const command of ['codex', 'claude', 'gemini']) {
    assert.deepEqual(resolveChatConnection({ config, connection: 'cli', command }), { ok: true, connection: 'cli', openai: null });
    assert.equal(resolveChatConnection({ config, command }).connection, 'cli');
  }
});
test('explicit endpoint and legacy no-command default use configured endpoint', () => {
  for (const input of [{ connection: 'endpoint', command: 'codex' }, {}]) {
    const result = resolveChatConnection({ config, ...input });
    assert.equal(result.connection, 'endpoint');
    assert.deepEqual(result.openai, { baseUrl: config.agentBaseUrl, model: config.agentModel, apiKey: config.agentApiKey });
  }
});
test('missing endpoint settings fail; local endpoint without key works', () => {
  assert.equal(resolveChatConnection({ config: {}, connection: 'endpoint' }).ok, false);
  assert.equal(resolveChatConnection({ config: { ...config, agentApiKey: '' }, connection: 'endpoint' }).ok, true);
  assert.equal(resolveChatConnection({ config, connection: 'invalid' }).ok, false);
});
