'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMouseModeStripper } = require('../../src/lib/term-mouse');

const ESC = '\x1b';

test('strips mouse tracking enable/disable sequences', () => {
  const s = createMouseModeStripper();
  const input = `hi${ESC}[?1002h${ESC}[?1006hbye${ESC}[?1000l`;
  assert.equal(s.strip(input), 'hibye');
});

test('leaves non-mouse modes intact (alt-screen, focus, bracketed paste, cursor)', () => {
  const s = createMouseModeStripper();
  const input = `${ESC}[?1049h${ESC}[?1004h${ESC}[?2004h${ESC}[?25ltext`;
  assert.equal(s.strip(input), input);
});

test('reassembles a mouse sequence split across two chunks', () => {
  const s = createMouseModeStripper();
  // "\x1b[?100" arrives, then "2h" completes ?1002h next chunk.
  const a = s.strip(`before${ESC}[?100`);
  const b = s.strip(`2hafter`);
  assert.equal(a + b, 'beforeafter');
});

test('does not hold back a complete sequence', () => {
  const s = createMouseModeStripper();
  assert.equal(s.strip(`done${ESC}[?1002h`), 'done');
});

test('an incomplete non-mouse CSI is carried then emitted intact', () => {
  const s = createMouseModeStripper();
  const a = s.strip(`x${ESC}[1;31`);   // partial color SGR
  const b = s.strip('mred');            // completes ESC[1;31m
  assert.equal(a + b, `x${ESC}[1;31mred`);
});

test('plain text is unchanged', () => {
  const s = createMouseModeStripper();
  assert.equal(s.strip('just some output\n'), 'just some output\n');
});

test('tracks mouse-reporting on/off across enable and disable', () => {
  const s = createMouseModeStripper();
  assert.equal(s.isMouseOn(), false);
  s.strip(`${ESC}[?1002h${ESC}[?1006h`);
  assert.equal(s.isMouseOn(), true);
  s.strip(`${ESC}[?1002l${ESC}[?1000l`);
  assert.equal(s.isMouseOn(), false);
});

test('the latest toggle in a chunk wins', () => {
  const s = createMouseModeStripper();
  s.strip(`${ESC}[?1002h text ${ESC}[?1002l`);
  assert.equal(s.isMouseOn(), false);
});

test('reset clears the mouse-reporting state', () => {
  const s = createMouseModeStripper();
  s.strip(`${ESC}[?1002h`);
  assert.equal(s.isMouseOn(), true);
  s.reset();
  assert.equal(s.isMouseOn(), false);
});

test('encoding-only modes (1006) do not flip reporting on', () => {
  const s = createMouseModeStripper();
  s.strip(`${ESC}[?1006h`);
  assert.equal(s.isMouseOn(), false);
});
