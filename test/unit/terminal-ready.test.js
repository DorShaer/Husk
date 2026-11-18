'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { waitForTerminalReady } = require('../../src/lib/terminal-ready');

// A fake clock: sleep advances it, and each step may change the output time.
function clock(onStep = () => {}) {
  let t = 1000;
  return { now: () => t, sleep: async (ms) => { t += ms; onStep(t); } };
}

test('ready once output arrived after the start and went quiet', async () => {
  let out = 0;
  const c = clock((t) => { if (t === 1500) out = t; });
  const ok = await waitForTerminalReady({ lastOutputAt: () => out, since: 1000, quietMs: 700, limitMs: 5000, now: c.now, sleep: c.sleep });
  assert.equal(ok, true);
  assert.ok(c.now() - 1500 >= 700);
});

test('output from before the start does not count', async () => {
  const c = clock();
  const ok = await waitForTerminalReady({ lastOutputAt: () => 900, since: 1000, limitMs: 3000, now: c.now, sleep: c.sleep });
  assert.equal(ok, false);
});

test('a terminal that keeps drawing is not ready until it stops', async () => {
  let out = 0;
  const c = clock((t) => { if (t <= 3000) out = t; });
  const ok = await waitForTerminalReady({ lastOutputAt: () => out, since: 1000, quietMs: 700, limitMs: 10000, now: c.now, sleep: c.sleep });
  assert.equal(ok, true);
  assert.ok(c.now() >= 3700);
});

test('a terminal that went away stops the wait at once', async () => {
  const c = clock();
  const ok = await waitForTerminalReady({ lastOutputAt: () => 0, gone: () => true, now: c.now, sleep: c.sleep });
  assert.equal(ok, false);
  assert.equal(c.now(), 1000);
});
