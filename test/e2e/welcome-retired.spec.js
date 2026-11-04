'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The old "press Enter to start" welcome page is retired. It used to appear for
// a terminal-mode (non-protocol) CLI when skipWelcome was not set; now it never
// shows. aider has no chat protocol, so this is the exact case that showed it.
test('the legacy "Enter to start" welcome page never shows', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-welcome-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: false,
    agentCommand: 'aider',
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  const shim = path.join(bin, 'aider');
  fs.writeFileSync(shim, '#!/bin/sh\nexec sleep 86400\n');
  fs.chmodSync(shim, 0o755);

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  // Wait for a tab to exist, then confirm the welcome overlay stays hidden.
  await win.waitForFunction(() => typeof TABS !== 'undefined' && TABS.size >= 1, null, { timeout: 15_000 });
  await win.waitForTimeout(400);
  const shown = await win.evaluate(() => {
    const e = document.querySelector('#chat-empty');
    return !!(e && e.classList.contains('show'));
  });
  expect(shown).toBe(false);
  await app.close();
});
