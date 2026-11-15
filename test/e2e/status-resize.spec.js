'use strict';

// The side panel's width belongs to the user: drag its left edge, the new
// width survives a reload, and a double-click puts the default back.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-resize-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'true', chatView: 'terminal', statusCollapsed: false }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForSelector('#status-resize');
  return { app, win, homeDir };
}

const panelWidth = (win) => win.evaluate(() => document.getElementById('status-panel').getBoundingClientRect().width);

test('dragging the side panel edge resizes it, the width persists, and double-click resets', async () => {
  const { app, win, homeDir } = await launch();
  // The width is applied once boot has read the config, so poll for it.
  await expect.poll(async () => Math.round(await panelWidth(win))).toBe(380);

  const grip = await win.locator('#status-resize').boundingBox();
  const y = grip.y + grip.height / 2;
  const x = grip.x + grip.width / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x - 60, y, { steps: 6 });
  await win.mouse.move(x - 140, y, { steps: 6 });
  await win.mouse.up();
  // The grip is a 7px strip centred 3px left of the border, so the pointer
  // lands a couple of pixels off the edge it drags.
  const widened = Math.round(await panelWidth(win));
  expect(widened).toBeGreaterThanOrEqual(515);
  expect(widened).toBeLessThanOrEqual(525);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8')).statusWidth).toBe(widened);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('#status-resize');
  await expect.poll(async () => Math.round(await panelWidth(win))).toBe(widened);

  // The width is clamped so the panel can neither vanish nor eat the window.
  const g2 = await win.locator('#status-resize').boundingBox();
  await win.mouse.move(g2.x + 3, g2.y + 40);
  await win.mouse.down();
  await win.mouse.move(g2.x + 900, g2.y + 40, { steps: 8 });
  await win.mouse.up();
  await expect.poll(async () => Math.round(await panelWidth(win))).toBe(280);

  await win.locator('#status-resize').dblclick();
  await expect.poll(async () => Math.round(await panelWidth(win))).toBe(380);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8')).statusWidth).toBe(null);
  await app.close();
});

for (const column of [
  { page: 'prefs', panel: '#rail', grip: '#rail-resize', key: 'railWidth', initial: 232 },
  { page: 'chat', panel: '#chat-sessions', grip: '#sessions-resize', key: 'sessionsWidth', initial: 272 },
]) {
  test(`${column.key} can be dragged, restored after reload and reset`, async () => {
    const { app, win, homeDir } = await launch();
    try {
      await win.evaluate((page) => setPage(page), column.page);
      const width = () => win.locator(column.panel).evaluate((el) => Math.round(el.getBoundingClientRect().width));
      await expect.poll(width).toBe(column.initial);
      const grip = win.locator(column.grip);
      await expect(grip).toBeVisible();
      const box = await grip.boundingBox();
      await win.mouse.move(box.x + 3, box.y + 100);
      await win.mouse.down();
      await win.mouse.move(box.x + 83, box.y + 100, { steps: 8 });
      await win.mouse.up();
      const resized = await width();
      expect(resized).toBeGreaterThan(column.initial + 70);
      const saved = () => JSON.parse(fs.readFileSync(path.join(homeDir, '.config/husk/config.json'), 'utf8'))[column.key];
      await expect.poll(saved).toBe(resized);
      await win.reload();
      await win.waitForFunction(() => !!cfg);
      await win.evaluate((page) => setPage(page), column.page);
      await expect.poll(width).toBe(resized);
      await grip.focus();
      await win.keyboard.press('ArrowLeft');
      await expect.poll(width).toBe(resized - 16);
      await expect.poll(saved).toBe(resized - 16);
      await grip.dblclick();
      await expect.poll(width).toBe(column.initial);
      await expect.poll(saved).toBe(null);
      if (column.key === 'railWidth') {
        await win.evaluate(() => { document.body.dataset.rail = 'collapsed'; });
        await expect(grip).toBeHidden();
      }
    } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
  });
}
