'use strict';

// On a narrow chat the rail stays reachable and the status panel folds.
// The rail's middle section scrolls; the status body scales its content to fit,
// so every section stays on screen and nothing is clipped.
//
// The fit tracks window height only, so the status panel's painted content
// grows with every zoom step.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { setWindowContentSize } = require('../helpers/electron-window');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('short window keeps the rail bottom visible and folds the status panel', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  // firstRunDone carries boot() past the welcome wizard, which needs an agent
  // CLI that CI runners do not have.
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, statusCollapsed: false }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await setWindowContentSize(app, 2200, 900);

  // The status panel fills in over IPC after boot, so wait for its sections to
  // exist before shrinking the window around them.
  await win.waitForFunction(() => {
    const fit = document.getElementById('sp-fit');
    return !!fit && fit.children.length > 0 && fit.scrollHeight > 0;
  }, null, { timeout: 15_000 });

  await setWindowContentSize(app, 1100, 620);

  await expect(win.locator('#status-panel')).toBeHidden();
  const info = await win.evaluate(() => ({
    bottom: document.querySelector('#btn-open-prefs').getBoundingClientRect().bottom,
    height: window.innerHeight,
    preference: document.body.dataset.status,
  }));
  expect(info.bottom).toBeLessThanOrEqual(info.height + 1);
  expect(info.preference).toBe('expanded');
  await setWindowContentSize(app, 1920, 900);
  await expect(win.locator('#status-panel')).toBeVisible();

  await app.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('zooming in enlarges the status panel content', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, statusCollapsed: false }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await setWindowContentSize(app, 2200, 900);
  await win.waitForFunction(() => {
    const fit = document.getElementById('sp-fit');
    return !!fit && fit.children.length > 0 && fit.scrollHeight > 0;
  }, null, { timeout: 15_000 });

  // devicePixelRatio carries the zoom, so multiplying the CSS height by it
  // gives the size on screen.
  const paintedHeight = () => win.evaluate(() => {
    const fit = document.getElementById('sp-fit');
    return fit.getBoundingClientRect().height * window.devicePixelRatio;
  });

  const painted = [await paintedHeight()];
  for (let step = 0; step < 4; step++) {
    await win.evaluate(() => window.husk.ui.zoomIn());
    // The fit pass runs off a ResizeObserver, so wait for it to settle.
    await win.waitForTimeout(400);
    painted.push(await paintedHeight());
  }

  // Every step paints strictly larger than the one before it.
  for (let i = 1; i < painted.length; i++) {
    expect(painted[i], `zoom step ${i} must paint larger than step ${i - 1}: ${JSON.stringify(painted)}`)
      .toBeGreaterThan(painted[i - 1]);
  }

  await app.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('the status rows keep both edges at any fit scale', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, statusCollapsed: false }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await setWindowContentSize(app, 2200, 900);
  await win.waitForFunction(() => {
    const fit = document.getElementById('sp-fit');
    return !!fit && fit.children.length > 0 && fit.scrollHeight > 0;
  }, null, { timeout: 15_000 });

  // The gutter either side of a row, measured against the scrolling box.
  const gaps = () => win.evaluate(() => {
    const box = document.getElementById('sp-content');
    const fit = document.getElementById('sp-fit');
    const row = fit.querySelector('.sp-row');
    if (!row) return null;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const t = getComputedStyle(fit).transform;
    return {
      left: Math.round(r.left - b.left),
      right: Math.round(b.right - r.right),
      scale: t === 'none' ? 1 : +parseFloat(t.split('(')[1].split(',')[0]).toFixed(2),
    };
  });

  // Two window heights, both inside the smallest screen this runs on. The rows
  // reach the same two edges at either height.
  await setWindowContentSize(app, 1920, 760);
  await win.waitForTimeout(700);
  const tall = await gaps();
  expect(Math.abs(tall.left - tall.right), JSON.stringify(tall)).toBeLessThanOrEqual(1);

  // Short enough that the fit has more work to do, at whatever scale comes out.
  await setWindowContentSize(app, 1920, 520);
  await win.waitForTimeout(900);
  const short = await gaps();
  expect(Math.abs(short.left - short.right), JSON.stringify(short)).toBeLessThanOrEqual(1);
  expect(Math.abs(short.left - tall.left), JSON.stringify({ tall, short })).toBeLessThanOrEqual(1);

  await app.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('long branch names stay on one line while sync counts remain visible', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-branch-layout-'));
  fs.mkdirSync(path.join(home, '.config/husk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/husk/config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, welcomeVersion: 99, tourVersion: 99, lastSeenVersion: require('../../package.json').version, statusCollapsed: false, theme: 'light', agentCommand: 'true' }));
  const app = await electron.launch({ args: [path.join(REPO_ROOT, 'src/main.js'), '--no-sandbox'], cwd: REPO_ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1', TZ: 'UTC' } });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof cfg !== 'undefined' && cfg);
    await setWindowContentSize(app, 1440, 900);
    const branch = 'integration/product-complete-with-a-very-long-descriptive-branch-name';
    await win.waitForFunction(() => !!document.querySelector('#sp-fit .sp-section'));
    const stats = { agent: 'codex', agentVersion: '1.0.0', huskVer: require('../../package.json').version, location: { city: 'Demo workspace' }, workspace: { name: 'demo-app', cwd: '/tmp/demo-app', git: { isRepo: true, branch, ahead: 3, behind: 2, dirty: 4 } } };
    await app.evaluate(({ ipcMain }, stats) => {
      ipcMain.removeHandler('stats:get');
      ipcMain.handle('stats:get', () => stats);
    }, stats);
    await win.evaluate(async () => {
      document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
      lastStats = await window.husk.stats.get();
      await refreshStatusline();
    });
    await expect(win.locator('#status-panel')).toBeVisible();
    const name = win.locator('.sp-branch-name');
    await expect(name).toHaveText(branch);
    await expect(win.locator('.sp-branch')).toHaveAttribute('title', branch + ' ↑3 ↓2');
    await expect(win.locator('.sp-branch-sync')).toHaveText('↑3 ↓2');
    const bounds = await name.evaluate((el) => {
      const text = el.getBoundingClientRect();
      const row = el.closest('.sp-row').getBoundingClientRect();
      const label = el.closest('.sp-row').firstElementChild.getBoundingClientRect();
      const sync = el.nextElementSibling.getBoundingClientRect();
      const css = getComputedStyle(el);
      return { clipped: el.scrollWidth > el.clientWidth, oneLine: css.whiteSpace, ellipsis: css.textOverflow, separated: text.left >= label.right, contained: sync.right <= row.right + 1 };
    });
    expect(bounds).toEqual({ clipped: true, oneLine: 'nowrap', ellipsis: 'ellipsis', separated: true, contained: true });
    await name.hover();
    await win.waitForTimeout(200);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.mkdirSync('/tmp/husk-node-branch-fixes', { recursive: true });
    fs.writeFileSync('/tmp/husk-node-branch-fixes/long-branch.png', Buffer.from(png, 'base64'));
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
