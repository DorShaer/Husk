'use strict';

// Trusting the folder restarts the agent. A chat that already has a turn in it
// has to come back as the same chat: one tab, the thread still showing, and the
// agent resumed on the session it was on. A fresh start in its place left the
// conversation behind as a second entry beside an empty chat.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');

test('trusting the folder keeps the chat it was asked in', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-trust-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude', resumeLastOnLaunch: false,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const capture = path.join(homeDir, 'argv.log');

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CAPTURE: capture, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
    const pane = win.locator('.chat-pane.show');
    await expect(pane).toBeVisible();
    await win.waitForFunction(() => {
      const i = document.querySelector('.chat-pane.show .chat-input');
      return i && !/Starting/.test(i.placeholder);
    });

    await pane.locator('.chat-input').fill('remember the frog');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-item-text').last()).toContainText('Echo: remember the frog');
    const before = await win.evaluate(() => { const t = TABS.get(activeTabId); return { id: t.id, session: t.agentId, tabs: TABS.size }; }); // eslint-disable-line no-undef
    expect(before.session).toBeTruthy();

    await expect(win.locator('#trust-banner')).toBeVisible();
    await win.click('#btn-trust-folder');
    await expect(win.locator('#trust-banner')).toBeHidden();
    await expect(pane.locator('.chat-meta', { hasText: 'Resumed session' })).toBeVisible();

    // The same tab, the same session, the thread still there.
    const after = await win.evaluate(() => { const t = TABS.get(activeTabId); return { id: t.id, session: t.agentId, tabs: TABS.size }; }); // eslint-disable-line no-undef
    expect(after).toEqual(before);
    await expect(win.locator('#tab-strip .chat-tab')).toHaveCount(1);
    await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('remember the frog');

    // The agent was started again on that session, not on a new one.
    const chats = fs.readFileSync(capture, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv).filter((a) => a.includes('--input-format'));
    expect(chats.length).toBe(2);
    expect(chats[1].join(' ')).toContain(`--resume ${before.session}`);
    expect(chats[1]).not.toContain('--session-id');

    // And it still answers.
    await pane.locator('.chat-input').fill('still there?');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-item-text').last()).toContainText('Echo: still there?');
  } finally { await app.close(); }
});
