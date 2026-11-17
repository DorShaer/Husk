'use strict';

// Launch on a heavy session history must not freeze the main process. The
// window setup Electron does before first paint is the same on an empty home
// and is not counted; everything after it is.

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { makeHome, run } = require('../../scripts/measure-boot');

test('2500 transcripts: no main loop stall over 100ms in the first 15s, cold or warm', async () => {
  test.setTimeout(180_000);
  const home = makeHome(2500);
  try {
    for (const label of ['cold', 'warm']) {
      const r = await run(home, 15, label);
      // Include Electron window creation when checking for multi-second freezes.
      expect(r.maxBlockMs, `${label} startup stall`).toBeLessThan(2000);
      expect(r.maxAfterWindowMs, `${label} stall`).toBeLessThan(100);
      expect(r.claudeAll, `${label} listing`).toBe(2500);
      expect(r.sessions).toBe(500);
    }
    expect(fs.statSync(`${home}/.config/husk/session-cache.json`).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
