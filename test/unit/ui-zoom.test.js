'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { BASE_ZOOM, sanitizeZoom, startZoom, stepZoom, zoomToStore, ZOOM_MIN, ZOOM_MAX } = require('../../src/lib/ui-zoom');

test('sanitizeZoom: rejects non-numbers', () => {
  for (const v of [null, undefined, 'big', NaN, Infinity, -Infinity, {}, []]) {
    assert.equal(sanitizeZoom(v), null);
  }
});

test('sanitizeZoom: snaps to the step grid and clamps to the range', () => {
  assert.equal(sanitizeZoom(0.74), 0.5);
  assert.equal(sanitizeZoom(-0.3), -0.5);
  assert.equal(sanitizeZoom(99), ZOOM_MAX);
  assert.equal(sanitizeZoom(-99), ZOOM_MIN);
});

test('startZoom: uses a valid saved level, else the base', () => {
  assert.equal(startZoom(1.5), 1.5);
  assert.equal(startZoom(-1), -1);
  assert.equal(startZoom(null), BASE_ZOOM);
  assert.equal(startZoom(undefined), BASE_ZOOM);
  assert.equal(startZoom('x'), BASE_ZOOM);
});

test('stepZoom: moves one step and stops at the limits', () => {
  assert.equal(stepZoom(0, 1), 0.5);
  assert.equal(stepZoom(0, -1), -0.5);
  assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
  assert.equal(stepZoom(NaN, 1), BASE_ZOOM + 0.5);
});

test('zoomToStore: the base level is stored as null so default changes still apply', () => {
  assert.equal(zoomToStore(BASE_ZOOM), null);
  assert.equal(zoomToStore(BASE_ZOOM + 0.5), BASE_ZOOM + 0.5);
  assert.equal(zoomToStore(-0.5), -0.5);
  assert.equal(zoomToStore('x'), null);
});
