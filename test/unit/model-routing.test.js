'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { modelArgsFor, classifyTier, normalizeTier } = require('../../src/lib/model-routing');

test('claude routes both tiers with stable aliases', () => {
  assert.deepEqual(modelArgsFor('claude', 'cheap'), ['--model', 'haiku']);
  assert.deepEqual(modelArgsFor('claude', 'smart'), ['--model', 'opus']);
});

test('only claude ships defaults; other CLIs are opt-in (no default names)', () => {
  // gemini knows its flag but ships no default names -> no routing until set.
  assert.deepEqual(modelArgsFor('gemini', 'cheap'), []);
  assert.deepEqual(modelArgsFor('copilot', 'cheap'), []);
  assert.deepEqual(modelArgsFor('aider', 'smart'), []);
  assert.deepEqual(modelArgsFor('codex', 'cheap'), []);
});

test('gemini routes once the user supplies names, using its verified -m flag', () => {
  const ov = { gemini: { cheap: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' } };
  assert.deepEqual(modelArgsFor('gemini', 'cheap', ov), ['-m', 'gemini-2.5-flash']);
  assert.deepEqual(modelArgsFor('gemini', 'smart', ov), ['-m', 'gemini-2.5-pro']);
});

test('an unknown CLI injects no flag', () => {
  assert.deepEqual(modelArgsFor('somenewcli', 'cheap'), []);
});

test('overrides let a user map any vendor to real model names', () => {
  const ov = { codex: { flag: '--model', cheap: 'gpt-5-mini', smart: 'gpt-5' } };
  assert.deepEqual(modelArgsFor('codex', 'cheap', ov), ['--model', 'gpt-5-mini']);
  assert.deepEqual(modelArgsFor('codex', 'smart', ov), ['--model', 'gpt-5']);
});

test('an override of null disables routing for a vendor', () => {
  assert.deepEqual(modelArgsFor('claude', 'cheap', { claude: null }), []);
});

test('override supplying only model names deep-merges the known flag', () => {
  // codex knows its flag (--model) but ships no model names; the settings UI
  // supplies just the names.
  assert.deepEqual(modelArgsFor('codex', 'cheap', { codex: { cheap: 'gpt-5-mini' } }), ['--model', 'gpt-5-mini']);
  // partial override: cheap set, smart still unrouted
  assert.deepEqual(modelArgsFor('codex', 'smart', { codex: { cheap: 'gpt-5-mini' } }), []);
});

test('classifyTier routes mechanical work to cheap', () => {
  assert.equal(classifyTier('Bump safe patch/minor versions of devDependencies in package.json'), 'cheap');
  assert.equal(classifyTier('find all TODO and FIXME comments'), 'cheap');
  assert.equal(classifyTier('reformat the codebase with prettier'), 'cheap');
  assert.equal(classifyTier('rename the getUser helper everywhere'), 'cheap');
});

test('classifyTier defaults complex work to smart', () => {
  assert.equal(classifyTier('implement OAuth login with refresh tokens'), 'smart');
  assert.equal(classifyTier('debug the race condition in the pty layer'), 'smart');
  assert.equal(classifyTier('refactor the autopilot supervisor'), 'smart');
  assert.equal(classifyTier(''), 'smart');
});

test('normalizeTier is safe', () => {
  assert.equal(normalizeTier('cheap'), 'cheap');
  assert.equal(normalizeTier('smart'), 'smart');
  assert.equal(normalizeTier('garbage'), 'smart');
  assert.equal(normalizeTier(undefined), 'smart');
});
