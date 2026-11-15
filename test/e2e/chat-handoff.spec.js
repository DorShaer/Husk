'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

test('the new chat menu names CLIs and the composer continues a discussion with another CLI', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-handoff-'));
  const bin = path.join(home, 'bin');
  const config = path.join(home, '.config/husk');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'gemini', agentCwd: home }));
  for (const name of ['gemini', 'kiro-cli']) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test/e2e/fixtures/fake-acp-agent.js')}" "$@"\n`, { mode: 0o755 });
  }
  const promptLog = path.join(home, 'prompts.jsonl');
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', HUSK_FAKE_ACP_PROMPTS: promptLog } });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.husk && document.querySelector('.chat-pane.show .chat-input'));
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    await win.locator('#cs-new').click();
    await expect(win.locator('#new-tab-menu [data-cmd="gemini"]')).toContainText('New chat with');
    await expect(win.locator('#new-tab-menu [data-cmd="kiro-cli"]')).toContainText('New chat with');
    await win.keyboard.press('Escape');
    const pane = win.locator('.chat-pane.show');
    await expect(pane.locator('.chat-input')).toBeEnabled();
    await pane.locator('.chat-input').fill('Keep the greeting blue');
    await pane.locator('.chat-input').press('Enter');
    await pane.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(pane).toContainText('Done, permission was');
    await pane.locator('.chat-composer-meta button').first().click();
    await win.locator('#chat-context-menu').getByRole('menuitem', { name: /Kiro/ }).click();
    await win.locator('#chat-context-menu').getByRole('menuitem', { name: 'Continue this discussion' }).click();
    await expect(pane.locator('.chat-composer-meta')).toContainText('kiro-cli');
    await expect(pane.locator('.chat-input')).toBeEnabled();
    await pane.locator('.chat-input').fill('Continue with the same colour');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane).toContainText('Continued from');
    await expect.poll(async () => {
      const chats = await win.evaluate(() => window.husk.chat.list());
      const tabId = chats.sessions[0]?.tabId;
      return win.evaluate((id) => window.husk.chat.handoff({ tabId: id }), tabId);
    }).toMatchObject({ ok: true });
    const transcripts = path.join(config, 'transcripts');
    expect(fs.readdirSync(transcripts).length).toBeGreaterThanOrEqual(2);
    const prompts = () => fs.readFileSync(promptLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line).text);
    expect(prompts().at(-1)).toContain('Keep the greeting blue');

  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
