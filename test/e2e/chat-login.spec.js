'use strict';

// /login typed in a chat. Over the stream protocol the CLI answers that the
// command is not available, so it never let the user switch accounts from
// Chat view. The command now opens the CLI's own sign-in in a terminal tab,
// and when that finishes the chat is told who is signed in.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-auth.js');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-login-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude', resumeLastOnLaunch: false,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  const capture = path.join(homeDir, 'argv.log');
  fs.writeFileSync(capture, '');
  return { homeDir, bin, capture };
}

const calls = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).argv);

test('/login opens the CLI sign-in in a terminal tab and reports the account when it finishes', async () => {
  test.setTimeout(90_000);
  const env = makeHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.homeDir, USERPROFILE: env.homeDir, PATH: `${env.bin}${path.delimiter}${process.env.PATH}`, CAPTURE: env.capture, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
    await win.waitForFunction(() => {
      const i = document.querySelector('.chat-pane.show .chat-input');
      return i && !i.disabled && !/Starting/.test(i.placeholder);
    }, null, { timeout: 30_000 });
    const chatTabId = await win.evaluate(() => activeTabId); // eslint-disable-line no-undef

    await win.fill('.chat-pane.show .chat-input', '/login');
    // The first Enter takes the slash completion, the second sends, which is
    // the keystrokes a person makes too.
    await win.press('.chat-pane.show .chat-input', 'Enter');
    await win.press('.chat-pane.show .chat-input', 'Enter');

    // A second tab, in Terminal mode, running the CLI's sign-in.
    await win.waitForFunction(() => TABS.size === 2, null, { timeout: 15_000 }); // eslint-disable-line no-undef
    const opened = await win.evaluate((id) => { // eslint-disable-line no-undef
      const t = Array.from(TABS.values()).find((x) => x.id !== id); // eslint-disable-line no-undef
      return { mode: t.mode, command: t.launchCommand, title: t.customTitle, active: activeTabId === t.id }; // eslint-disable-line no-undef
    }, chatTabId);
    expect(opened).toEqual({ mode: 'terminal', command: 'claude auth login', title: 'Sign in', active: true });
    await expect.poll(() => calls(env.capture).some((a) => a[0] === 'auth' && a[1] === 'login'), { timeout: 15_000 }).toBe(true);
    // The command was never sent to the chat child as a prompt.
    const thread = await win.evaluate(() => document.querySelector('.chat-pane .chat-thread, .chat-pane').textContent);
    expect(thread).not.toContain("isn't available");

    // When the sign-in exits, the account is read back and announced.
    await expect(win.locator('#toast-stack')).toContainText('Signed in as tester@example.com (max)', { timeout: 20_000 });
    expect(calls(env.capture).some((a) => a[0] === 'auth' && a[1] === 'status')).toBe(true);
    const chatText = await win.evaluate((id) => { // eslint-disable-line no-undef
      const t = TABS.get(id); return t.chat ? JSON.stringify(t.chat.getState().items.map((i) => i.text || '')) : ''; // eslint-disable-line no-undef
    }, chatTabId);
    expect(chatText).toContain('Signed in as tester@example.com');
    expect(chatText).not.toMatch(/[\u2014\u2013]/);
  } finally {
    await app.close();
  }
});
