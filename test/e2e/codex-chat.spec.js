'use strict';

// Codex in Chat view, and the readouts that follow the focused chat. The agents
// are fixtures reached through shims on PATH: `codex` speaks app-server and
// `gemini` speaks ACP, so both tabs take the real main-process path.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CODEX = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');
const ACP = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-codex-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'codex', resumeLastOnLaunch: false,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, fixture] of [['codex', CODEX], ['gemini', ACP]]) {
    const shim = path.join(bin, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  return { homeDir, bin };
}

async function launch(homeDir, bin) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForFunction(() => window.husk && window.husk.chat && window.HuskChat && document.querySelector('.chat-stage'));
  return { app, win };
}

async function chatReady(win) {
  await win.waitForFunction(() => {
    const i = document.querySelector('.chat-pane.show .chat-input');
    return i && !/Starting/.test(i.placeholder);
  });
}

test('codex opens as a Husk thread and answers an approval', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    const pane = win.locator('.chat-pane.show');
    await expect(pane).toBeVisible();
    await expect(win.locator('.term-pane.show')).toHaveCount(0);
    await chatReady(win);

    await pane.locator('.chat-input').fill('say hi');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-item-text strong').first()).toHaveText('command');
    const tool = pane.locator('.chat-tool');
    await expect(tool.locator('.chat-tool-title')).toHaveText('Shell');
    const perm = pane.locator('.chat-perm');
    await expect(perm).toBeVisible();
    // The fixture offers accept and cancel only, so no session-wide allow shows.
    await expect(perm.locator('.chat-perm-btn')).toHaveCount(2);
    await perm.locator('.chat-perm-btn', { hasText: 'Allow' }).click();
    await expect(tool).toHaveAttribute('data-status', 'done');
    await expect(pane.locator('.chat-item-text').last()).toContainText('decision was accept');
    await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');

    // The context reading lives in the Context pane, not in Status.
    await win.evaluate(() => setStatusPane('work')); // eslint-disable-line no-undef
    await expect(win.locator('#sp-pane-work .sp-ctxbar')).toBeVisible();
    await expect(win.locator('#sp-pane-work')).toContainText('10%');
    await win.evaluate(() => setStatusPane('status')); // eslint-disable-line no-undef
    await expect(win.locator('#sp-content .sp-ctxbar')).toHaveCount(0);
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'codex-chat.png') });
  } finally { await app.close(); }
});

test('/mcp shows what the CLI itself prints, not a pointer to its terminal', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    const pane = win.locator('.chat-pane.show');
    await chatReady(win);
    await pane.locator('.chat-input').fill('/mcp');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('/mcp');
    await expect(pane.locator('.chat-item-text code').first()).toHaveText('codex mcp list');
    await expect(pane.locator('.chat-item-text pre')).toContainText('fixture  node     enabled');
    await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');
    // The command never reached the agent, so no turn of its own was played.
    await expect(pane.locator('.chat-tool')).toHaveCount(0);
  } finally { await app.close(); }
});

test('the footer and Status panel follow the focused chat, and chats reorder by drag', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    await win.evaluate(() => openNewChatTab({ command: 'gemini', preferChat: true, skipWelcome: true })); // eslint-disable-line no-undef
    await chatReady(win);
    const tabs = win.locator('#tab-strip .chat-tab');
    await expect(tabs).toHaveCount(2);

    // gemini is not the configured tool, so the footer names it; its model too.
    await expect(win.locator('#sb-agent-item')).toBeVisible();
    await expect(win.locator('#sb-agent')).toHaveText('gemini');
    await win.evaluate(() => setStatusPane('status')); // eslint-disable-line no-undef
    await expect(win.locator('#sp-content')).toContainText('Gemini');

    await tabs.nth(0).click();
    await expect(win.locator('#sb-agent')).toHaveText('codex');
    await expect(win.locator('#sb-model')).toHaveText('GPT Fake');
    await expect(win.locator('#sp-content')).toContainText('Codex');
    await expect(win.locator('#sp-content')).not.toContainText('Gemini');

    const order = () => tabs.evaluateAll((els) => els.map((e) => e.dataset.tab));
    const before = await order();
    await tabs.nth(1).dragTo(tabs.nth(0), { targetPosition: { x: 3, y: 10 } });
    await expect.poll(order).toEqual([before[1], before[0]]);
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'codex-tabs-reordered.png') });
  } finally { await app.close(); }
});

test('the default zoom is the level the renderer calls its baseline', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    const z = await win.evaluate(() => ({ now: window.husk.ui.zoomGet(), base: window.husk.ui.zoomBase, reset: window.husk.ui.zoomReset() }));
    expect(z.now).toBe(z.base);
    expect(z.reset).toBe(z.base);
    expect(z.base).toBeGreaterThan(0);
  } finally { await app.close(); }
});
