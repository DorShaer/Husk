'use strict';

// Ctrl+R reloads the window and comes back to the chat that was focused. It
// used to restart the agent on the chat page, which minted a fresh empty
// session in the tab and dropped the real one to a second card, so one chat
// showed up twice. These checks drive the shortcut handler directly (the key
// is swallowed in the main process, out of a renderer test's reach).

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-ctrlr-'));
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  const work = path.join(homeDir, 'work'); fs.mkdirSync(work);
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  // resumeLastOnLaunch left unset, like the real config, so boot resume is live.
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude', agentCwd: work,
  }));
  const bin = path.join(homeDir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  return { homeDir, bin };
}

async function launch(env) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.homeDir, USERPROFILE: env.homeDir, PATH: `${env.bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return { app, win };
}

async function chatReady(win) {
  await win.waitForFunction(() => { const i = document.querySelector('.chat-pane.show .chat-input'); return i && !i.disabled && !/Starting/.test(i.placeholder); }, null, { timeout: 30_000 });
}
async function ask(win, text) {
  await chatReady(win);
  await win.fill('.chat-pane.show .chat-input', text);
  await win.press('.chat-pane.show .chat-input', 'Enter');
  await win.waitForFunction(() => { const p = document.querySelector('.chat-pane.show'); return p && p.querySelector('.chat-item-text') && !(TABS.get(activeTabId) || {}).chatRunning; }, null, { timeout: 30_000 }).catch(() => {});
  await win.waitForTimeout(800);
}

test('Ctrl+R reloads to the focused chat without doubling it', async () => {
  test.setTimeout(90_000);
  const env = makeHome();
  const { app, win } = await launch(env);
  try {
    await ask(win, 'hi');
    // A second chat so there is a focus to preserve across the reload.
    await win.evaluate(() => openNewChatTab({})); // eslint-disable-line no-undef
    await ask(win, 'yo');

    const before = await win.evaluate(() => ({
      tabs: TABS.size, // eslint-disable-line no-undef
      active: activeTabId, // eslint-disable-line no-undef
      sids: Array.from(TABS.values()).map((t) => t.agentId).sort(), // eslint-disable-line no-undef
    }));
    expect(before.tabs).toBe(2);

    // The shortcut handler, as Ctrl+R triggers it.
    await win.evaluate(() => refreshFromShortcut()); // eslint-disable-line no-undef
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof TABS !== 'undefined' && window.HuskChat && bootingFromReloadState === null, null, { timeout: 30_000 });
    await win.waitForTimeout(2000);

    const after = await win.evaluate(() => ({
      tabs: TABS.size, // eslint-disable-line no-undef
      active: activeTabId, // eslint-disable-line no-undef
      sids: Array.from(TABS.values()).map((t) => t.agentId).sort(), // eslint-disable-line no-undef
      hiCards: Array.from(document.querySelectorAll('.cs-card')).filter((c) => /\bhi\b/.test(c.textContent) && !/yo/.test(c.textContent)).length,
      titles: Array.from(TABS.values()).map((t) => t.title), // eslint-disable-line no-undef
    }));
    // No restart: same two sessions, not a third fresh one.
    expect(after.tabs, 'the reload changed the number of tabs').toBe(2);
    expect(after.sids, 'a fresh session was minted on reload').toEqual(before.sids);
    // The focused tab is the one that was focused.
    expect(after.active, 'the reload did not come back to the focused chat').toBe(before.active);
    // One card for the hi chat, not two.
    const hiCount = await win.evaluate((sid) => document.querySelectorAll(`.cs-card[data-session="${sid}"]`).length, before.sids.find(Boolean));
    expect(hiCount, 'the hi chat is listed more than once').toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});

test('a new chat is titled New Chat and sits at the top of the column', async () => {
  const env = makeHome();
  const { app, win } = await launch(env);
  try {
    await ask(win, 'first');
    await win.evaluate(() => openNewChatTab({})); // eslint-disable-line no-undef
    await win.waitForTimeout(600);
    const state = await win.evaluate(() => ({
      activeTitle: (TABS.get(activeTabId) || {}).title, // eslint-disable-line no-undef
      firstCard: (document.querySelector('.cs-card') || {}).textContent || '',
    }));
    expect(state.activeTitle, 'a new chat is not called New Chat').toBe('New Chat');
    // The brand-new chat is the top card in the column.
    expect(state.firstCard).toMatch(/New Chat/);
  } finally {
    await app.close();
  }
});
