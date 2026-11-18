'use strict';

// Moving a discussion into a CLI that only runs in a terminal: the carried
// context is pasted once that CLI is at its prompt, and when it never gets
// there the user is told and can paste again.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

async function setup(aiderBody) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-handoff-term-'));
  const bin = path.join(home, 'bin');
  const config = path.join(home, '.config/husk');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'gemini', agentCwd: home }));
  fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test/e2e/fixtures/fake-acp-agent.js')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'aider'), `#!/bin/sh\n${aiderBody}\n`, { mode: 0o755 });
  const termLog = path.join(home, 'term.log');
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', HUSK_FAKE_TERM_LOG: termLog } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => window.husk && document.querySelector('.chat-pane.show .chat-input'));
  await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-input')).toBeEnabled();
  await pane.locator('.chat-input').fill('Keep the greeting blue');
  await pane.locator('.chat-input').press('Enter');
  await pane.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(pane).toContainText('Done, permission was');
  await pane.getByRole('button', { name: 'Move discussion', exact: true }).click();
  await win.locator('#chat-context-menu').getByRole('menuitem', { name: /Aider/ }).click();
  const logged = () => (fs.existsSync(termLog) ? fs.readFileSync(termLog, 'utf8') : '');
  return { app, win, home, logged };
}

test('a terminal-only CLI slow to reach its prompt still gets the discussion', async () => {
  const s = await setup(`exec "${process.execPath}" "${path.join(ROOT, 'test/e2e/fixtures/slow-prompt-cli.js')}"`);
  try {
    await expect.poll(s.logged, { timeout: 20_000 }).toContain('Keep the greeting blue');
    expect(s.logged()).toContain('Continue the discussion from where it stopped.');
    await expect(s.win.locator('.toast-action', { hasText: 'Paste again' })).toHaveCount(0);
  } finally { await s.app.close(); fs.rmSync(s.home, { recursive: true, force: true }); }
});

test('a terminal-only CLI that never reaches its prompt is reported with Paste again', async () => {
  test.setTimeout(90_000);
  const s = await setup('exec cat >> "$HUSK_FAKE_TERM_LOG"');
  try {
    const again = s.win.locator('.toast-action', { hasText: 'Paste again' });
    await expect(again).toBeVisible({ timeout: 30_000 });
    await expect(s.win.locator('.toast-body', { hasText: 'not pasted' })).toBeVisible();
    expect(s.logged()).toBe('');
    await again.click();
    await expect.poll(s.logged, { timeout: 10_000 }).toContain('Keep the greeting blue');
  } finally { await s.app.close(); fs.rmSync(s.home, { recursive: true, force: true }); }
});
