'use strict';

// The Terminal page: a real shell in the window, reached from the rail item
// pinned above the tool selector. Not the agent's own screen.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('the rail opens a shell tab on the Terminal page and the shell answers', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-term-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'true', chatView: 'terminal' }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, SHELL: '/bin/bash', ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  // The rail item sits in its own section directly above the tool selector.
  const item = win.locator('.rail-section-term .rail-item[data-page="terminal"]');
  await expect(item).toBeVisible();
  const order = await win.evaluate(() => {
    const term = document.querySelector('.rail-section-term');
    const tool = document.querySelector('.rail-section-tool');
    return term && tool ? term.getBoundingClientRect().bottom <= tool.getBoundingClientRect().top + 1 : false;
  });
  expect(order).toBe(true);
  // No Chat / Terminal toggle in the chat page head any more.
  expect(await win.locator('#chat-mode-toggle').count()).toBe(0);

  await item.click();
  await expect(win.locator('.page-terminal')).toBeVisible();
  await expect(win.locator('#tm-panes .tm-pane')).toHaveCount(1);
  await expect(win.locator('#tm-strip .tm-tab:not(.tm-add)')).toHaveCount(1);
  // A real shell: it echoes what we type.
  await win.waitForTimeout(800);
  await win.keyboard.type('echo husk-shell-$((20+22))');
  await win.keyboard.press('Enter');
  await expect.poll(async () => win.evaluate(() => {
    const pane = document.querySelector('#tm-panes .tm-pane:not([hidden])');
    return pane ? pane.textContent : '';
  }), { timeout: 10_000 }).toContain('husk-shell-42');

  // A second tab opens beside the first.
  await win.locator('#tm-strip .tm-add').click();
  await expect(win.locator('#tm-strip .tm-tab:not(.tm-add)')).toHaveCount(2);
  await app.close();
});
