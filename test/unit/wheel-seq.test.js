'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wheelSequence, wheelSteps } = require('../../src/lib/wheel-seq');

const ESC = '\x1b';

test('wheel up uses button 64, down uses 65, with 1-based cell coords', () => {
  assert.equal(wheelSequence(true, 10, 5), `${ESC}[<64;10;5M`);
  assert.equal(wheelSequence(false, 10, 5), `${ESC}[<65;10;5M`);
});

test('coords are clamped to a minimum of 1', () => {
  assert.equal(wheelSequence(true, 0, 0), `${ESC}[<64;1;1M`);
  assert.equal(wheelSequence(false, -3, -1), `${ESC}[<65;1;1M`);
});

test('pixel-mode delta maps ~53px to one step', () => {
  assert.equal(wheelSteps(53, 0), 1);
  assert.equal(wheelSteps(120, 0), 2);
  assert.equal(wheelSteps(10, 0), 1); // small but non-zero -> at least one
});

test('line-mode delta is taken as a line count', () => {
  assert.equal(wheelSteps(1, 1), 1);
  assert.equal(wheelSteps(3, 1), 3);
});

test('steps are clamped to 5 and zero delta yields zero', () => {
  assert.equal(wheelSteps(10000, 0), 5);
  assert.equal(wheelSteps(0, 0), 0);
});
