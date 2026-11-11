'use strict';

// The UI zoom a user picks is still there after a restart, the default is
// stored as nothing at all, and a nonsense value in the config cannot mount
// the window at an unreadable size.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeHome(extra) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-zoom-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify(Object.assign({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false }, extra || {})));
  return homeDir;
}

async function launch(homeDir) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => window.husk && window.husk.ui);
  return { app, win };
}

const saved = (homeDir) => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8')).uiZoom;

test('a zoom level survives a restart, and the default is saved as no value', async () => {
  const homeDir = makeHome();
  let { app, win } = await launch(homeDir);
  try {
    const base = await win.evaluate(() => window.husk.ui.zoomBase);
    expect(await win.evaluate(() => window.husk.ui.zoomGet())).toBe(base);
    await win.evaluate(() => { window.husk.ui.zoomIn(); window.husk.ui.zoomIn(); });
    await expect.poll(() => saved(homeDir)).toBe(base + 1);
  } finally { await app.close(); }

  ({ app, win } = await launch(homeDir));
  try {
    const base = await win.evaluate(() => window.husk.ui.zoomBase);
    expect(await win.evaluate(() => window.husk.ui.zoomGet())).toBe(base + 1);
    await win.evaluate(() => window.husk.ui.zoomReset());
    await expect.poll(() => saved(homeDir)).toBe(null);
  } finally { await app.close(); }
});

test('a zoom value nobody could have picked is brought back into range', async () => {
  const homeDir = makeHome({ uiZoom: 400 });
  const { app, win } = await launch(homeDir);
  try {
    expect(await win.evaluate(() => window.husk.ui.zoomGet())).toBe(5);
  } finally { await app.close(); }
  const junk = makeHome({ uiZoom: 'huge' });
  const second = await launch(junk);
  try {
    expect(await second.win.evaluate(() => window.husk.ui.zoomGet())).toBe(await second.win.evaluate(() => window.husk.ui.zoomBase));
  } finally { await second.app.close(); }
});
