'use strict';

// A chat CLI whose protocol does not start: silent, refusing the protocol flag,
// or slow. The CLI is a shell shim named `gemini` on PATH so the real
// main-process start, retry and failure card run; HUSK_HANDSHAKE_MS keeps the
// waits short.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');

function makeHome(body) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-compat-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'gemini' }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  const shim = path.join(bin, 'gemini');
  fs.writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gemini 0.68.0"; exit 0; fi\n${body(homeDir)}\n`);
  fs.chmodSync(shim, 0o755);
  return { homeDir, bin };
}

async function launch({ homeDir, bin }) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', HUSK_HANDSHAKE_MS: '1500' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForFunction(() => window.husk && window.husk.chat && window.HuskChat && document.querySelector('.chat-stage'));
  return { app, win };
}

test('a silent CLI is retried, then a card offers Retry and the terminal view', async () => {
  const { app, win } = await launch(makeHome(() => 'exec sleep 600'));
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-thread-inner')).toContainText('Trying once more', { timeout: 10_000 });
  const card = pane.locator('.chat-compat-card');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.chat-native-title')).toHaveText('gemini chat could not start');
  await expect(card.locator('.chat-native-pill')).toHaveText('no answer');
  await expect(card.locator('.chat-compat-facts')).toContainText('gemini 0.68.0');
  await expect(card.locator('.chat-compat-facts')).toContainText('an ACP answer to gemini --acp');
  await expect(card.locator('.chat-compat-retry')).toHaveText('Retry');
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-compat-card.png') });
  await card.locator('.chat-compat-terminal').click();
  await expect(win.locator('.term-pane.show')).toBeVisible();
  await app.close();
});

test('a CLI that rejects the protocol flag shows its words and the terminal fallback', async () => {
  const { app, win } = await launch(makeHome(() => 'if [ "$1" = "--acp" ]; then echo "error: unknown option \'--acp\'" >&2; exit 1; fi\nexec sleep 600'));
  const card = win.locator('.chat-pane.show .chat-compat-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator('.chat-native-pill')).toHaveText('refused');
  await expect(card.locator('.chat-compat-facts')).toContainText("unknown option '--acp'");
  await expect(card.locator('.chat-compat-terminal')).toHaveText('Open in Terminal view');
  await expect(win.locator('.chat-pane.show .chat-thread-inner')).not.toContainText('Trying once more');
  await expect(win.locator('.chat-pane.show .chat-thread-inner')).not.toContainText('Agent exited');
  await app.close();
});

test('a slow CLI that answers on the retry opens the chat', async () => {
  const { app, win } = await launch(makeHome((home) => `if [ -f "${home}/answered" ]; then exec "${process.execPath}" "${FIXTURE}" "$@"; fi\ntouch "${home}/answered"\nexec sleep 600`));
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-thread-inner')).toContainText('Trying once more', { timeout: 10_000 });
  await win.waitForFunction(() => {
    const i = document.querySelector('.chat-pane.show .chat-input');
    return i && !/Starting/.test(i.placeholder) && !i.disabled;
  }, null, { timeout: 15_000 });
  await expect(pane.locator('.chat-compat-card')).toHaveCount(0);
  await pane.locator('.chat-input').fill('write a greeting');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('write a greeting');
  await app.close();
});
