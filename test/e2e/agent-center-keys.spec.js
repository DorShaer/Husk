'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The agent center reads keys from the whole document so the terminal under it
// never sees them. That reach used to have no floor: any printable key typed
// anywhere in the app was redirected into the center's search box, so once the
// center had been opened, no form in Husk could be typed into again.

async function boot() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-agent-keys-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    agentCommand: 'claude',
  }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(2500);
  return { app, win };
}

test('leaving the page closes the agent center', async () => {
  const { app, win } = await boot();
  await win.evaluate(() => document.querySelector('#topbar-agents').click());
  await win.waitForTimeout(600);
  expect(await win.evaluate(() => !document.querySelector('#agent-map').hidden)).toBe(true);

  await win.evaluate(() => document.querySelector('.rail-item[data-page="mcp"]').click());
  await win.waitForTimeout(600);
  expect(await win.evaluate(() => document.querySelector('#agent-map').hidden)).toBe(true);
  await app.close();
});

test('a form field keeps its keystrokes while the agent center is up', async () => {
  const { app, win } = await boot();
  await win.evaluate(() => document.querySelector('.rail-item[data-page="mcp"]').click());
  await win.waitForTimeout(600);
  // Hold the center open over the page the way a stale overlay used to.
  await win.evaluate(() => { document.querySelector('#agent-map').hidden = false; });
  await win.evaluate(() => document.querySelector('#btn-mcp-add-custom').click());
  await win.waitForTimeout(500);

  await win.click('#mig-custom-id');
  await win.keyboard.type('my-server');
  await win.click('#mig-custom-cmd');
  await win.keyboard.type('npx');

  const typed = await win.evaluate(() => ({
    id: document.querySelector('#mig-custom-id').value,
    cmd: document.querySelector('#mig-custom-cmd').value,
    search: document.querySelector('#am-search-input').value,
  }));
  expect(typed.id).toBe('my-server');
  expect(typed.cmd).toBe('npx');
  expect(typed.search).toBe('');
  await app.close();
});

test('the center still takes plain typing into its own search', async () => {
  const { app, win } = await boot();
  await win.evaluate(() => document.querySelector('#topbar-agents').click());
  await win.waitForTimeout(800);
  await win.keyboard.type('abc');
  const search = await win.evaluate(() => document.querySelector('#am-search-input').value);
  expect(search).toBe('abc');
  await app.close();
});
