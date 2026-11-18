'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { baseContextWindow, fitWindow } = require('../../src/lib/context-window');

test('current Claude families are 1M', () => {
  for (const id of ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-5-5', 'claude-opus-4-8', 'claude-opus-4-6',
    'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-opus', 'claude-sonnet']) {
    assert.equal(baseContextWindow(id), 1000000, id);
  }
});

test('older Claude models stay 200K', () => {
  for (const id of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5',
    'claude-opus-4-1', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219']) {
    assert.equal(baseContextWindow(id), 200000, id);
  }
});

test('other vendors keep their sizes and unknown ids are null', () => {
  assert.equal(baseContextWindow('gpt-5.2-codex'), 400000);
  assert.equal(baseContextWindow('gemini-3-pro'), 1000000);
  assert.equal(baseContextWindow('mystery-model'), null);
});

test('observed usage past the table size widens the window', () => {
  assert.equal(fitWindow(200000, 291000), 1000000);
  assert.equal(fitWindow(200000, 150000), 200000);
  assert.equal(fitWindow(1000000, 0), 1000000);
});
