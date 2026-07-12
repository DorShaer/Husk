'use strict';

// Smoke test: launch the real Electron app and assert it boots cleanly. This
// covers main-process startup, preload bridge availability, and early renderer
// mount. Feature E2E belongs in focused specs.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Isolate config so the test never reads/writes the developer's real config.
function makeIsolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

test('app boots, exposes preload bridge, no console errors', async () => {
  const homeDir = makeIsolatedHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });

  const consoleErrors = [];
  app.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');

  const title = await win.title();
  expect(title.toLowerCase()).toContain('husk');

  const bridge = await win.evaluate(() => {
    const w = window;
    return {
      hasHusk: !!w.husk,
      ptyShape: w.husk && typeof w.husk.pty === 'object',
      configShape: w.husk && typeof w.husk.config === 'object',
      workflowsShape: w.husk && typeof w.husk.workflows === 'object',
    };
  });
  expect(bridge.hasHusk).toBe(true);
  expect(bridge.ptyShape).toBe(true);
  expect(bridge.configShape).toBe(true);
  expect(bridge.workflowsShape).toBe(true);

  const pages = await win.evaluate(() => {
    return Array.from(document.querySelectorAll('.page')).map((el) => el.getAttribute('data-page'));
  });
  expect(pages.length).toBeGreaterThan(0);

  await app.close();

  const fatal = consoleErrors.filter((t) => !/Autofill|DevTools|Failed to load resource: net::ERR_FILE_NOT_FOUND/i.test(t));
  expect(fatal, `unexpected console errors:\n${fatal.join('\n')}`).toEqual([]);
});
