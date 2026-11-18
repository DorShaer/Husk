'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sealConfig, unsealConfig, needsSeal } = require('../../src/lib/config-secrets');

const fakeKeychain = (ready = true) => ({
  ready: () => ready,
  encrypt: (s) => Buffer.from('X' + Buffer.from(s, 'utf8').toString('hex'), 'utf8'),
  decrypt: (b) => { const t = b.toString('utf8'); if (!t.startsWith('X')) throw new Error('bad'); return Buffer.from(t.slice(1), 'hex').toString('utf8'); },
});

test('a key is written sealed and read back plain', () => {
  const kc = fakeKeychain();
  const disk = sealConfig({ theme: 'light', agentApiKey: 'sk-secret-1' }, kc);
  assert.equal(disk.agentApiKey, undefined);
  assert.ok(disk.agentApiKeyEnc && !JSON.stringify(disk).includes('sk-secret-1'));
  const { config, failed } = unsealConfig(disk, kc);
  assert.equal(config.agentApiKey, 'sk-secret-1');
  assert.equal(config.agentApiKeyEnc, undefined);
  assert.deepEqual(failed, []);
});

test('without a keychain the key is written as before and nothing is lost', () => {
  const disk = sealConfig({ agentApiKey: 'sk-plain' }, fakeKeychain(false));
  assert.equal(disk.agentApiKey, 'sk-plain');
  assert.equal(disk.agentApiKeyEnc, undefined);
});

test('a sealed value read before the keychain is ready stays sealed and is kept on save', () => {
  const sealed = sealConfig({ agentApiKey: 'sk-1' }, fakeKeychain()).agentApiKeyEnc;
  const early = unsealConfig({ agentApiKeyEnc: sealed }, fakeKeychain(false)).config;
  assert.equal(early.agentApiKeyEnc, sealed);
  assert.equal(sealConfig(early, fakeKeychain(false)).agentApiKeyEnc, sealed);
});

test('a value that cannot be decrypted is reported, not dropped', () => {
  const { config, failed } = unsealConfig({ agentApiKeyEnc: Buffer.from('garbage').toString('base64') }, fakeKeychain());
  assert.deepEqual(failed, ['agentApiKey']);
  assert.ok(config.agentApiKeyEnc);
});

test('clearing the key removes both forms', () => {
  const disk = sealConfig({ agentApiKey: '', agentApiKeyEnc: 'old' }, fakeKeychain());
  assert.equal(disk.agentApiKey, undefined);
  assert.equal(disk.agentApiKeyEnc, undefined);
});

test('a plain key on disk is flagged for sealing only when the keychain is ready', () => {
  assert.equal(needsSeal({ agentApiKey: 'sk' }, fakeKeychain()), true);
  assert.equal(needsSeal({ agentApiKey: 'sk' }, fakeKeychain(false)), false);
  assert.equal(needsSeal({}, fakeKeychain()), false);
});

test('starting and saving without credentials never opens the OS keychain', () => {
  const keychain = { ready: () => assert.fail('unnecessary keychain probe') };
  const cfg = { theme: 'light', agentApiKey: '' };
  assert.deepEqual(unsealConfig(cfg, keychain).config, cfg);
  assert.equal(needsSeal(cfg, keychain), false);
  assert.deepEqual(sealConfig(cfg, keychain), { theme: 'light' });
});
