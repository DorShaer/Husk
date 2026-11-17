'use strict';

// Every action that restarts the agent under an open chat keeps the thread on
// screen, and the CLI resumes the same session where it can. A CLI that cannot
// resume keeps the thread with a one-line note that its context is fresh.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures');

function makeHome(cli, fixture) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-restart-'));
  const work = path.join(homeDir, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: cli, agentCwd: work,
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "${path.join(FIXTURES, fixture)}" "$@"\n`);
  fs.chmodSync(path.join(bin, cli), 0o755);
  return { homeDir, bin, work, argv: path.join(homeDir, 'argv.jsonl') };
}

async function launch(env) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.homeDir, USERPROFILE: env.homeDir, PATH: `${env.bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', CAPTURE: env.argv },
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
  const pane = win.locator('.chat-pane.show');
  const before = await pane.locator('.chat-item-user').count();
  await pane.locator('.chat-input').fill(text);
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user')).toHaveCount(before + 1);
  // ACP turns ask for one permission; allow it so the turn ends.
  await expect.poll(async () => {
    const allow = pane.locator('.chat-perm-btn.btn-primary').first();
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
    return win.evaluate(() => !(TABS.get(activeTabId) || {}).chatRunning); // eslint-disable-line no-undef
  }, { timeout: 20_000 }).toBe(true);
}

const sessionArgs = (env) => fs.readFileSync(env.argv, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv)
  .filter((a) => a.includes('--input-format'))
  .map((a) => { const i = a.findIndex((x) => x === '--resume' || x === '--session-id'); return `${a[i]} ${a[i + 1]}`; });

async function expectThread(win, notes) {
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText(['first about frogs', 'second about toads'], { timeout: 20_000 });
  await expect(pane.locator('.chat-item-text').first()).toContainText('Echo: first about frogs');
  if (notes) await expect(pane.locator('.chat-meta-line', { hasText: notes })).toHaveCount(1);
}

test('Restart agent, Trust this folder, sign-in, a model switch and Ctrl+R keep the claude conversation', async () => {
  test.setTimeout(150_000);
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await ask(win, 'first about frogs');
    await ask(win, 'second about toads');
    const sid = await win.evaluate(() => TABS.get(activeTabId).agentId); // eslint-disable-line no-undef
    const title = await win.evaluate(() => TABS.get(activeTabId).title); // eslint-disable-line no-undef

    // Restart agent, as the palette, the shortcut and the restart toasts run it.
    await win.evaluate(() => restartPty()); // eslint-disable-line no-undef
    await expectThread(win, 'Agent restarted in the same conversation');
    await chatReady(win);

    // Trust this folder restarts the agent too.
    await win.evaluate(() => { document.getElementById('trust-banner').hidden = false; });
    await win.click('#btn-trust-folder');
    await expect.poll(() => sessionArgs(env).length, { timeout: 20_000 }).toBe(3);
    await expectThread(win, 'Agent restarted in the same conversation');
    await chatReady(win);

    // A finished sign-in brings the agent back the same way.
    await win.evaluate(() => nativeApply(TABS.get(activeTabId), 'Signed in.')); // eslint-disable-line no-undef
    await expect.poll(() => sessionArgs(env).length, { timeout: 20_000 }).toBe(4);
    await expectThread(win);
    await chatReady(win);

    // A model the CLI cannot take live restarts it under the same session.
    const res = await win.evaluate(() => window.husk.chat.setModel({ tabId: activeTabId, modelId: 'claude-other', modelName: 'Other' })); // eslint-disable-line no-undef
    expect(res.ok).toBe(true);
    expect(res.restarted).toBe(true);
    await expectThread(win);

    // Ctrl+R reloads the window back to the same thread.
    await win.evaluate(() => refreshFromShortcut()); // eslint-disable-line no-undef
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof TABS !== 'undefined' && window.HuskChat && bootingFromReloadState === null, null, { timeout: 30_000 }); // eslint-disable-line no-undef
    await expectThread(win);

    // One session the whole way: the first start pins it, every restart resumes it.
    const args = sessionArgs(env);
    expect(args[0]).toBe(`--session-id ${sid}`);
    expect(args.slice(1).every((a) => a === `--resume ${sid}`), args.join(' | ')).toBe(true);
    const after = await win.evaluate(() => ({ tabs: TABS.size, id: TABS.get(activeTabId).agentId, title: TABS.get(activeTabId).title })); // eslint-disable-line no-undef
    expect(after).toEqual({ tabs: 1, id: sid, title });
  } finally {
    await app.close();
    fs.rmSync(env.homeDir, { recursive: true, force: true });
  }
});

test('moving the chat to another folder keeps the thread with a fresh-context note', async () => {
  test.setTimeout(90_000);
  const env = makeHome('claude', 'fake-claude-stream.js');
  const other = path.join(env.homeDir, 'other');
  fs.mkdirSync(other);
  const { app, win } = await launch(env);
  try {
    await ask(win, 'first about frogs');
    await ask(win, 'second about toads');
    await win.evaluate((cwd) => restartPty({ cwd }), other); // eslint-disable-line no-undef
    await expectThread(win, 'fresh context');
    await chatReady(win);
    // A new session in the new folder, not a resume of one that lives elsewhere.
    const args = sessionArgs(env);
    expect(args[args.length - 1]).toMatch(/^--session-id /);
  } finally {
    await app.close();
    fs.rmSync(env.homeDir, { recursive: true, force: true });
  }
});

test('an ACP chat that cannot resume keeps its thread and says the context is fresh', async () => {
  test.setTimeout(90_000);
  const env = makeHome('copilot', 'fake-acp-agent.js');
  const { app, win } = await launch(env);
  try {
    await ask(win, 'first about frogs');
    await ask(win, 'second about toads');
    await win.evaluate(() => restartPty()); // eslint-disable-line no-undef
    const pane = win.locator('.chat-pane.show');
    await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText(['first about frogs', 'second about toads'], { timeout: 20_000 });
    await expect(pane.locator('.chat-meta-line', { hasText: 'fresh context' })).toHaveCount(1);
    await chatReady(win);
  } finally {
    await app.close();
    fs.rmSync(env.homeDir, { recursive: true, force: true });
  }
});

test('reload preserves a draft and queued message while a permission is open', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await chatReady(win);
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('WAIT_PERMISSION reload');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-perm-btn.btn-primary')).toBeVisible();
    await pane.locator('.chat-input').fill('queued follow up');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-queued-label')).toHaveCount(1);
    await pane.locator('.chat-input').fill('unfinished draft');
    await win.keyboard.press('Control+r');
    await chatReady(win);
    await expect(win.locator('.chat-pane.show .chat-input')).toHaveValue('unfinished draft');
    await expect(win.locator('.chat-pane.show .chat-queued-label')).toHaveCount(1);
    await expect(win.locator('.chat-pane.show .chat-perm-btn.btn-primary')).toBeVisible();
    await win.screenshot({ path: '/tmp/husk-reload-draft-queue.png' });
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});

test('terminal shell keys stay in the shell and a reload restores its terminal tab', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await chatReady(win);
    await win.evaluate(() => openTerminalTab()); // eslint-disable-line no-undef
    await win.waitForFunction(() => TABS.get(activeTabId)?.isShell); // eslint-disable-line no-undef
    await win.evaluate(() => { window.__reloadMarker = true; TABS.get(activeTabId).term.focus(); }); // eslint-disable-line no-undef
    await win.keyboard.press('Control+k');
    await expect(win.locator('#palette')).toBeHidden();
    await win.keyboard.press('Control+r');
    expect(await win.evaluate(() => window.__reloadMarker)).toBe(true);
    await win.keyboard.press('Control+\\');
    expect(await win.evaluate(() => SPLIT)).toBe(null); // eslint-disable-line no-undef
    await win.keyboard.press('Control+Shift+k');
    await expect(win.locator('#palette')).toBeVisible();
    await win.keyboard.press('Alt+a');
    await expect(win.locator('#agent-map')).toBeHidden();
    await win.keyboard.press('Escape');
    await win.keyboard.press('F5');
    await win.waitForFunction(() => typeof TABS !== 'undefined' && TABS.get(activeTabId)?.isShell); // eslint-disable-line no-undef
    expect(await win.evaluate(() => TABS.get(activeTabId).title)).toBe('Terminal'); // eslint-disable-line no-undef
    await win.screenshot({ path: '/tmp/husk-terminal-reload.png' });
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});

test('restart waits for a reply by default and expires requests when restarted now', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await chatReady(win);
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('WAIT_PERMISSION restart');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-perm-btn.btn-primary')).toBeVisible();
    await win.evaluate(() => { restartPty(); }); // eslint-disable-line no-undef
    await expect(win.locator('#confirm-cancel')).toHaveText('After this reply');
    await win.locator('#confirm-ok').click();
    await chatReady(win);
    await expect(pane.locator('.chat-perm-verdict')).toContainText('Expired');
    await expect(pane.locator('.chat-perm-btn')).toHaveCount(0);
    await win.screenshot({ path: '/tmp/husk-expired-request.png' });
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});

test('project switching preserves the current chat and a missing project asks before recreation', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const beta = path.join(env.homeDir, 'beta'); fs.mkdirSync(beta);
  const { app, win } = await launch(env);
  try {
    await ask(win, 'first about frogs');
    const original = await win.evaluate(() => activeTabId); // eslint-disable-line no-undef
    await win.evaluate(async ({ alpha, beta }) => {
      await window.husk.config.set({ projects: [{ id: 'alpha', name: 'Alpha', path: alpha }, { id: 'beta', name: 'Beta', path: beta }], activeProjectId: 'alpha' });
      await refreshProjectsState(); // eslint-disable-line no-undef
      await openProject('beta'); // eslint-disable-line no-undef
    }, { alpha: env.work, beta });
    await chatReady(win);
    expect(await win.evaluate((id) => TABS.get(id).chat.getState().items.some((it) => it.kind === 'user' && it.text === 'first about frogs'), original)).toBe(true); // eslint-disable-line no-undef
    expect(await win.evaluate(() => TABS.get(activeTabId).cwd)).toBe(beta); // eslint-disable-line no-undef
    const missing = path.join(env.homeDir, 'missing-project');
    await win.evaluate((cwd) => { openNewChatTab({ cwd }); }, missing); // eslint-disable-line no-undef
    await expect(win.locator('#confirm-title')).toHaveText('Folder not found');
    expect(fs.existsSync(missing)).toBe(false);
    await expect(win.locator('#confirm-body')).toContainText(missing);
    await win.screenshot({ path: '/tmp/husk-missing-folder.png' });
    await win.locator('#confirm-ok').click();
    await expect.poll(() => fs.existsSync(missing)).toBe(true);
    await chatReady(win);
    expect(await win.evaluate(() => TABS.get(activeTabId).cwd)).toBe(missing); // eslint-disable-line no-undef
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});

test('after this reply restarts before sending the preserved queue', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await chatReady(win);
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('WAIT_PERMISSION defer');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-perm-btn.btn-primary')).toBeVisible();
    await pane.locator('.chat-input').fill('queued after restart');
    await pane.locator('.chat-input').press('Enter');
    await win.evaluate(() => { restartPty(); }); // eslint-disable-line no-undef
    await win.locator('#confirm-cancel').click();
    expect(sessionArgs(env)).toHaveLength(1);
    await win.keyboard.press('Control+r');
    await chatReady(win);
    await expect(pane.locator('.chat-queued-label')).toHaveCount(1);
    expect(await win.evaluate(() => !!TABS.get(activeTabId).restartAfterReply)).toBe(true); // eslint-disable-line no-undef
    await pane.locator('.chat-perm-btn.btn-primary').click();
    await expect(pane.locator('.chat-meta-line', { hasText: 'Agent restarted in the same conversation' })).toHaveCount(1);
    await expect(pane.locator('.chat-item-text').filter({ hasText: 'Echo: queued after restart' })).toHaveCount(1);
    expect(sessionArgs(env)).toHaveLength(2);
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});

test('a reader stays at the same scroll position after restart and reload', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await ask(win, Array.from({ length: 100 }, (_, i) => `Paragraph ${i}: a long answer gives the reader room to scroll.`).join('\n\n'));
    const thread = win.locator('.chat-pane.show .chat-thread');
    await thread.evaluate((el) => { el.scrollTop = 200; });
    await expect.poll(() => thread.evaluate((el) => Math.round(el.scrollTop))).toBe(200);
    await win.evaluate(() => restartPty()); // eslint-disable-line no-undef
    await chatReady(win);
    await expect.poll(() => thread.evaluate((el) => Math.round(el.scrollTop))).toBe(200);
    await win.keyboard.press('Control+r');
    await chatReady(win);
    await expect.poll(() => win.locator('.chat-pane.show .chat-thread').evaluate((el) => Math.round(el.scrollTop))).toBe(200);
    await win.screenshot({ path: '/tmp/husk-preserved-scroll.png' });
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});

test('reload keeps a text attachment larger than Web Storage quota', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await chatReady(win);
    const quotaBlocked = await win.evaluate(() => {
      const c = TABS.get(activeTabId).chat; // eslint-disable-line no-undef
      c.restoreUi({ draft: 'draft with large text', pendingText: 'x'.repeat(16 * 1024 * 1024), pinned: true });
      const stale = JSON.stringify({ page: 'prefs', ts: Date.now(), suppressAutoChat: true });
      sessionStorage.setItem('husk:reload-state', stale);
      localStorage.setItem('husk:reload-state', stale);
      const nativeSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'husk:reload-state' && value.length > 5 * 1024 * 1024) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        return nativeSet.call(this, key, value);
      };
      saveReloadState(); // eslint-disable-line no-undef
      return sessionStorage.getItem('husk:reload-state') === stale && localStorage.getItem('husk:reload-state') === stale;
    });
    expect(quotaBlocked).toBe(true);
    await win.keyboard.press('Control+r');
    await chatReady(win);
    await expect(win.locator('.chat-pane.show .chat-input')).toHaveValue('draft with large text');
    expect(await win.evaluate(() => TABS.get(activeTabId).chat.captureUi().pendingText.length)).toBe(16 * 1024 * 1024); // eslint-disable-line no-undef
    expect(await win.evaluate(() => document.body.dataset.page)).toBe('chat');
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});

test('an inactive scrolled chat keeps its reading position through reload', async () => {
  const env = makeHome('claude', 'fake-claude-stream.js');
  const { app, win } = await launch(env);
  try {
    await ask(win, Array.from({ length: 100 }, (_, i) => `Paragraph ${i}: a long answer gives the reader room to scroll.`).join('\n\n'));
    const id = await win.evaluate(() => activeTabId); // eslint-disable-line no-undef
    const thread = win.locator('.chat-pane.show .chat-thread');
    await thread.evaluate((el) => { el.scrollTop = 200; });
    await expect.poll(() => thread.evaluate((el) => Math.round(el.scrollTop))).toBe(200);
    await win.evaluate(() => openNewChatTab({ skipWelcome: true })); // eslint-disable-line no-undef
    await chatReady(win);
    expect(await win.evaluate((id) => TABS.get(id).chat.captureUi().pinned, id)).toBe(false); // eslint-disable-line no-undef
    await win.keyboard.press('Control+r');
    await chatReady(win);
    await win.evaluate((id) => activateTab(id), id); // eslint-disable-line no-undef
    await expect.poll(() => win.locator('.chat-pane.show .chat-thread').evaluate((el) => Math.round(el.scrollTop))).toBe(200);
    await win.screenshot({ path: '/tmp/husk-inactive-scroll.png' });
  } finally { await app.close(); fs.rmSync(env.homeDir, { recursive: true, force: true }); }
});
