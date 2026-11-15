'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

test('high context raises the usage bell and shows the source', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-usage-'));
  const bin = path.join(home, 'bin');
  const config = path.join(home, '.config/husk');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'gemini', planUsageSource: 'cli' }));
  fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test/e2e/fixtures/fake-acp-agent.js')}" "$@"\n`, { mode: 0o755 });
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' } });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.HuskUsageBell && document.querySelector('.chat-pane.show .chat-input'));
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    const input = win.locator('.chat-pane.show .chat-input');
    await expect(input).toBeEnabled();
    await input.fill('copilot: high context');
    await input.press('Enter');
    await expect(win.locator('#usage-bell')).toHaveAttribute('data-state', 'critical');
    await expect(win.locator('#usage-bell-count')).toBeVisible();
    await win.locator('#usage-bell').click();
    await expect(win.locator('#usage-panel')).toContainText('Context window');
    await expect(win.locator('#usage-panel')).toContainText('122K / 128K');
    await expect(win.locator('#usage-bell-count')).toBeHidden();
    await win.locator('#usage-bell').click();
    await win.evaluate(() => window.HuskUsageBell.refresh());
    await expect(win.locator('#usage-bell-count')).toBeHidden();
    await win.evaluate(() => window.HuskUsageBell.onChatEvent(TABS.get(activeTabId), { type: 'limit', windows: [{ window: 'short', pct: 80 }] }));
    await expect(win.locator('#usage-bell-count')).toHaveText('1');
    await win.locator('#usage-bell').click();
    await expect(win.locator('#usage-bell-count')).toBeHidden();
    await win.locator('#usage-bell').click();
    await win.evaluate(() => window.HuskUsageBell.onChatEvent(TABS.get(activeTabId), { type: 'limit', windows: [{ window: 'short', pct: 95 }] }));
    await expect(win.locator('#usage-bell-count')).toHaveText('1');
    await win.evaluate(() => window.huskOfferHandoff(activeTabId, { reason: 'possible-limit' }));
    await expect(win.locator('.chat-pane.show .chat-handoff-offer')).toContainText('may have reached a usage limit');
    await win.locator('.chat-pane.show').getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute('placeholder', /Enter to send/);
    const resetsAt = Date.now() + 3600000;
    const reportReached = (reset) => win.evaluate((resetsAt) => window.HuskUsageBell.onChatEvent(TABS.get(activeTabId), { type: 'limit', windows: [{ window: 'short', pct: 100, resetsAt }] }), reset);
    await reportReached(resetsAt);
    await expect(win.locator('#toast-stack .toast-title').filter({ hasText: 'Limit reached' })).toHaveCount(1);
    await win.locator('#usage-bell').click();
    await expect(win.locator('#usage-bell-count')).toBeHidden();
    await win.locator('#usage-bell').click();
    await Promise.all([win.waitForEvent('domcontentloaded'), win.keyboard.press('Control+r')]);
    await win.waitForFunction(() => window.HuskUsageBell && document.querySelector('.chat-pane.show .chat-input'));
    await expect(input).toHaveAttribute('placeholder', /Enter to send/);
    await reportReached(resetsAt);
    await expect(win.locator('#usage-bell-count')).toBeHidden();
    await expect(win.locator('#toast-stack .toast-title').filter({ hasText: /limit/i })).toHaveCount(0);
    for (const drift of [1000, -1000, 5000, 0]) await reportReached(resetsAt + drift);
    await win.evaluate(() => window.HuskUsageBell.onChatEvent(TABS.get(activeTabId), { type: 'limit', windows: [{ window: 'short', pct: 0 }] }));
    await reportReached(resetsAt);
    await expect(win.locator('#usage-bell-count')).toBeHidden();
    await expect(win.locator('#toast-stack .toast-title').filter({ hasText: /limit/i })).toHaveCount(0);
    await win.evaluate((reset) => {
      const now = Date.now;
      Date.now = () => reset + 1;
      try { window.HuskUsageBell.onChatEvent(TABS.get(activeTabId), { type: 'limit', windows: [{ window: 'short', pct: 100, resetsAt: reset + 3600000 }] }); }
      finally { Date.now = now; }
    }, resetsAt);
    await expect(win.locator('#usage-bell-count')).toHaveText('1');
    await expect(win.locator('#toast-stack .toast-title').filter({ hasText: 'Limit reached' })).toHaveCount(1);
    const daily = await win.evaluate(async () => {
      cfg = await window.husk.config.set({ usageBudgetTokens: 1, usageHardStop: true });
      return { day: window.HuskUsage.dayKey(Date.now()), tokens: 2, dollars: 0 };
    });
    await app.evaluate(({ BrowserWindow }, daily) => BrowserWindow.getAllWindows()[0].webContents.send('usage:daily', daily), daily);
    await input.fill('Wait for budget confirmation');
    await input.press('Enter');
    await expect(win.locator('#confirm-title')).toHaveText('Daily budget reached');
    await win.locator('#confirm-cancel').click();
    await expect(input).toHaveValue('Wait for budget confirmation');
    await expect(win.locator('.chat-pane.show .chat-item-user')).toHaveCount(1);
    await win.evaluate(async () => { cfg = await window.husk.config.set({ usageHardStop: false }); });
    await input.fill('slow: finish the current reply');
    await input.press('Enter');
    await input.fill('Keep this message queued');
    await input.press('Enter');
    await expect(win.locator('.chat-pane.show .chat-queue')).toContainText('Keep this message queued');
    await win.evaluate(async () => { cfg = await window.husk.config.set({ usageHardStop: true }); });
    await app.evaluate(({ BrowserWindow }, daily) => BrowserWindow.getAllWindows()[0].webContents.send('usage:daily', daily), daily);
    await win.locator('.chat-pane.show').getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(win.locator('#confirm-title')).toHaveText('Daily budget reached');
    await win.locator('#confirm-cancel').click();
    await expect(win.locator('.chat-pane.show .chat-queue')).toContainText('Keep this message queued');
    await expect(win.locator('.chat-pane.show .chat-item-user:not(.is-queued)')).toHaveCount(2);


  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
