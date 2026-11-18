'use strict';

// A chat has a title as soon as it has a conversation. The first message names
// it until the CLI sends a title of its own, which then replaces it; a resumed
// session the CLI never named stays open to that title too.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');
const SID = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

function makeHome({ pastUnnamed = false } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-title-'));
  const work = path.join(homeDir, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'copilot', agentCwd: work,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'copilot'), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'copilot'), 0o755);
  if (pastUnnamed) {
    const dir = path.join(homeDir, '.copilot', 'session-state', SID);
    fs.mkdirSync(dir, { recursive: true });
    const when = new Date(Date.now() - 1800 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${SID}\ncwd: ${work}\ncreated_at: ${when}\nupdated_at: ${when}\n`);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      { type: 'user.message', data: { content: 'fix the flaky installer test' } },
      { type: 'assistant.message', data: { content: 'Looking at it.' } },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  }
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

async function ask(win, text) {
  await win.waitForFunction(() => { const i = document.querySelector('.chat-pane.show .chat-input'); return i && !i.disabled && !/Starting/.test(i.placeholder); }, null, { timeout: 30_000 });
  const pane = win.locator('.chat-pane.show');
  await pane.locator('.chat-input').fill(text);
  await pane.locator('.chat-input').press('Enter');
  await expect.poll(async () => {
    const allow = pane.locator('.chat-perm-btn.btn-primary').first();
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
    return win.evaluate(() => !(TABS.get(activeTabId) || {}).chatRunning); // eslint-disable-line no-undef
  }, { timeout: 20_000 }).toBe(true);
}

const label = (win) => win.locator('.chat-tab.active .chat-tab-label');

test('a new chat is titled by its first message, then by the title the CLI sends', async () => {
  const env = makeHome();
  const { app, win } = await launch(env);
  try {
    await expect(label(win)).toHaveText('New Chat', { timeout: 20_000 });
    await ask(win, 'plan the release notes');
    await expect(label(win)).toHaveText('plan the release notes');
    // The CLI's own title replaces the first-message one.
    await ask(win, 'copilot: write the greeting');
    await expect(label(win)).toHaveText('Greeting file');
  } finally {
    await app.close();
    fs.rmSync(env.homeDir, { recursive: true, force: true });
  }
});

test('a resumed session the CLI never named takes the title the CLI sends later', async () => {
  const env = makeHome({ pastUnnamed: true });
  const { app, win } = await launch(env);
  try {
    // Launch reopens it, named after its first message for now.
    await expect(label(win)).toHaveText('fix the flaky installer test', { timeout: 30_000 });
    await ask(win, 'copilot: write the greeting');
    await expect(label(win)).toHaveText('Greeting file');
  } finally {
    await app.close();
    fs.rmSync(env.homeDir, { recursive: true, force: true });
  }
});
