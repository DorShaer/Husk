'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

test('new-chat vendor selection and saved defaults leave existing discussions alone', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-vendor-isolation-'));
  const bin = path.join(home, 'bin');
  const config = path.join(home, '.config/husk');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'gemini', agentCwd: home }));
  for (const name of ['gemini', 'kiro-cli']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test/e2e/fixtures/fake-acp-agent.js')}" "$@"\n`, { mode: 0o755 });
  }
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' } });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => window.husk && document.querySelector('.chat-pane.show .chat-input'));
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    await expect.poll(() => win.evaluate(async () => (await window.husk.chat.list()).sessions.length)).toBe(1);
    const original = await win.evaluate(async () => (await window.husk.chat.list()).sessions[0]);
    await win.locator('#rail-agent-pill').click();
    await win.locator('#rail-agent-menu [data-cmd="kiro-cli"]').click();
    await expect.poll(() => win.evaluate(async () => (await window.husk.chat.list()).sessions.length)).toBe(2);
    expect(await win.evaluate(() => cfg.agentCommand)).toBe('gemini');
    const before = await win.evaluate(async () => (await window.husk.chat.list()).sessions);
    expect(before.find((s) => s.tabId === original.tabId).command).toBe(original.command);
    await win.evaluate(async () => {
      cfg = await window.husk.config.set({ agentCommand: 'gemini', agentVendor: 'openai', agentBaseUrl: 'http://127.0.0.1:1/v1', agentModel: 'unreachable-test', agentApiKey: 'test-key' });
      bindPrefs();
      document.querySelector('#pref-save').click();
    });
    await expect(win.locator('#toast-stack')).toContainText('Defaults saved for new chats');
    expect((await win.evaluate(async () => (await window.husk.chat.list()).sessions)).map((s) => s.tabId).sort()).toEqual(before.map((s) => s.tabId).sort());
    await win.evaluate(async () => restartChat(TABS.get(activeTabId), { silent: true }));
    await expect(win.locator('.chat-pane.show .chat-input')).toBeEnabled();
    const after = await win.evaluate(async () => (await window.husk.chat.list()).sessions);
    expect(after.find((s) => s.tabId !== original.tabId)).toMatchObject({ command: 'kiro-cli', connection: 'cli' });
    expect(after.find((s) => s.tabId === original.tabId).command).toBe('gemini');
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
