'use strict';

// Chat mode end to end: a tab switched to Chat runs the agent headlessly over
// ACP and paints the thread itself. The agent is the fixture fake-acp-agent.js
// reached under the name `gemini` through a shim on PATH, so transportFor
// routes it to ACP and the whole main-process path (spawn, handshake, prompt,
// permission, exit) is the real one.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-chat-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    agentCommand: 'gemini',
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  const shim = path.join(bin, 'gemini');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
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

test('a chat tab streams text, shows a tool card, answers a permission and ends the turn', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);

  // Chat is the default view for a CLI with a protocol; there is no toggle.

  // The pane is up, with the footer naming the agent and no xterm pane shown.
  const pane = win.locator('.chat-pane.show');
  await expect(pane).toBeVisible();
  await expect(pane.locator('.chat-composer-meta')).toContainText('gemini');
  await expect(win.locator('.term-pane.show')).toHaveCount(0);
  await expect(pane.locator('.chat-input')).not.toBeDisabled();
  await chatReady(win);

  await pane.locator('.chat-input').fill('write a greeting');
  await pane.locator('.chat-input').press('Enter');

  await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('write a greeting');
  await expect(pane.locator('.chat-item-thought')).toHaveCount(1);
  // Markdown landed as elements, not literal asterisks.
  await expect(pane.locator('.chat-item-text strong').first()).toHaveText('greeting.txt');
  await expect(pane.locator('.chat-item-text li')).toHaveCount(2);

  const tool = pane.locator('.chat-tool');
  await expect(tool).toHaveCount(1);
  await expect(tool.locator('.chat-tool-title')).toHaveText('write greeting.txt');
  await expect(tool).toHaveAttribute('data-status', 'running');

  const perm = pane.locator('.chat-perm');
  await expect(perm).toBeVisible();
  await expect(perm.locator('.chat-perm-btn')).toHaveCount(3);
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-mode-permission.png') });
  await perm.locator('.chat-perm-btn', { hasText: 'Allow once' }).click();

  await expect(perm).toHaveClass(/is-resolved/);
  await expect(perm.locator('.chat-perm-verdict')).toHaveText('Allowed');
  await expect(tool).toHaveAttribute('data-status', 'done');
  await expect(tool.locator('.chat-diff-line.is-add .chat-diff-text')).toHaveText('hello from husk');
  await expect(pane.locator('.chat-item-text').last()).toContainText('permission was allow-once');
  await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');
  await expect(pane.locator('.chat-send')).toBeVisible();
  await expect(pane.locator('.chat-stop')).toBeHidden();
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-mode-done.png') });

  // The agent terminal is still reachable through the preference path.
  await win.evaluate(() => setTabMode(TABS.get(activeTabId), 'terminal'));
  await expect(win.locator('.chat-pane.show')).toHaveCount(0);
  await expect(win.locator('.term-pane.show')).toHaveCount(1);

  await app.close();
});

test('rejecting a permission marks the tool failed and keeps the thread usable', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await chatReady(win);
  await pane.locator('.chat-input').fill('try it');
  await pane.locator('.chat-input').press('Enter');
  const perm = pane.locator('.chat-perm');
  await perm.locator('.chat-perm-btn', { hasText: 'Reject' }).click();
  await expect(perm.locator('.chat-perm-verdict')).toHaveText('Denied');
  await expect(pane.locator('.chat-tool')).toHaveAttribute('data-status', 'error');
  await expect(pane.locator('.chat-item-text').last()).toContainText('did not write the file');
  await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');
  // A second turn goes out on the same session.
  await pane.locator('.chat-input').fill('again');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user')).toHaveCount(2);
  await expect(pane.locator('.chat-perm')).toHaveCount(2);
  await app.close();
});

test('a CLI without a protocol opens in the agent terminal, with no chat pane', async () => {
  const { homeDir, bin } = makeHome();
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'aider' }));
  const { app, win } = await launch(homeDir, bin);
  await expect(win.locator('.term-pane.show')).toHaveCount(1);
  await expect(win.locator('.chat-pane.show')).toHaveCount(0);
  expect(await win.evaluate(() => window.husk.chat.transportFor('aider'))).toBe(null);
  await app.close();
});

// Waits until the visible chat pane's agent has finished starting.
async function chatReady(win) {
  await win.waitForFunction(() => {
    const i = document.querySelector('.chat-pane.show .chat-input');
    return i && !/Starting/.test(i.placeholder);
  });
}

test('a reload keeps the chat tab, its thread and its live agent', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  let pane = win.locator('.chat-pane.show');
  await chatReady(win);
  await pane.locator('.chat-input').fill('write a greeting');
  await pane.locator('.chat-input').press('Enter');
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');

  await win.evaluate(() => { window.__beforeReload = true; });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => window.HuskChat && document.querySelector('.chat-pane.show'));

  expect(await win.evaluate(() => window.__beforeReload)).toBeUndefined();
  await expect(win.locator('.chat-pane')).toHaveCount(1);
  pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('write a greeting');
  await expect(pane.locator('.chat-tool')).toHaveAttribute('data-status', 'done');
  await expect(pane.locator('.chat-tool .chat-diff-line.is-add .chat-diff-text')).toHaveText('hello from husk');
  await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');
  await expect(win.locator('.chat-pane.show')).toBeVisible();
  await expect(win.locator('.term-pane.show')).toHaveCount(0);
  await expect(pane.locator('.chat-input')).not.toBeDisabled();

  // Same child, still talking: a second turn goes out without a restart.
  await pane.locator('.chat-input').fill('and again');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user')).toHaveCount(2);
  await expect(pane.locator('.chat-item-user .chat-bubble').nth(1)).toHaveText('and again');
  await expect(pane.locator('.chat-perm')).toHaveCount(2);
  await expect(pane.locator('.chat-perm').nth(1).locator('.chat-perm-btn')).toHaveCount(3);
  await app.close();
});

test('typing / lists the agent commands and Enter completes instead of sending', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await chatReady(win);
  const input = pane.locator('.chat-input');
  await input.click();
  await input.pressSequentially('/he');
  const ac = pane.locator('.chat-ac');
  await expect(ac).toBeVisible();
  await expect(ac).toHaveAttribute('role', 'listbox');
  await expect(ac.locator('.chat-ac-row')).toHaveCount(1);
  await expect(ac.locator('.chat-ac-row.is-active')).toContainText('help');
  await expect(ac.locator('.chat-ac-row.is-active')).toContainText('Show help');
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-mode-slash.png') });
  await input.press('Enter');
  await expect(input).toHaveValue('/help ');
  await expect(ac).toBeHidden();
  await expect(pane.locator('.chat-item-user')).toHaveCount(0);
  // Escape closes the list without touching the text.
  await input.fill('');
  await input.pressSequentially('/');
  await expect(ac).toBeVisible();
  await input.press('Escape');
  await expect(ac).toBeHidden();
  await expect(input).toHaveValue('/');
  await app.close();
});

test('typing @ lists files under the chat folder and Tab inserts the path', async () => {
  const { homeDir, bin } = makeHome();
  const work = path.join(homeDir, 'work');
  fs.mkdirSync(path.join(work, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(work, 'notes', 'readme.md'), '# notes\n');
  fs.writeFileSync(path.join(work, 'main.js'), '');
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'gemini', agentCwd: work,
  }));
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await chatReady(win);
  const input = pane.locator('.chat-input');
  await input.click();
  await input.pressSequentially('look at @read');
  const ac = pane.locator('.chat-ac');
  const row = ac.locator('.chat-ac-row[data-value="@notes/readme.md"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.chat-ac-name')).toHaveText('readme.md');
  await expect(row.locator('.chat-ac-desc')).toHaveText('notes');
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-mode-mention.png') });
  await input.press('Tab');
  await expect(input).toHaveValue('look at @notes/readme.md ');
  await expect(ac).toBeHidden();
  await expect(pane.locator('.chat-item-user')).toHaveCount(0);
  await app.close();
});

test('a Chat profile boots straight into a chat pane with no welcome screen, even with skipWelcome off', async () => {
  const { homeDir, bin } = makeHome();
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: false, agentCommand: 'gemini',
  }));
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await expect(pane).toBeVisible();
  await expect(win.locator('#chat-empty')).not.toHaveClass(/show/);
  await expect(win.locator('.chat-pane.show')).toBeVisible();
  await expect(win.locator('.term-pane.show')).toHaveCount(0);
  await chatReady(win);
  await pane.locator('.chat-input').fill('hello straight away');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user .chat-bubble').first()).toHaveText('hello straight away');
  await expect(pane.locator('.chat-item-text strong').first()).toHaveText('greeting.txt');
  await expect(pane.locator('.chat-perm')).toBeVisible();
  // The welcome screen is still the Terminal profile's front door.
  await app.close();
  const term = makeHome();
  fs.writeFileSync(path.join(term.homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: false, agentCommand: 'gemini', chatView: 'terminal',
  }));
  const second = await launch(term.homeDir, term.bin);
  await expect(second.win.locator('#chat-empty.show #ce-prompt')).toBeVisible();
  await second.app.close();
});

test('an agent that exits on its own offers Restart in the composer, and Restart works', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await chatReady(win);
  await pane.locator('.chat-input').fill('exit now');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-meta-error')).toContainText('Agent exited (code 3)');
  const restart = pane.locator('.chat-restart');
  await expect(restart).toBeVisible();
  await expect(pane.locator('.chat-send')).toBeHidden();
  await expect(pane.locator('.chat-stop')).toBeHidden();
  await expect(pane.locator('.chat-input')).toHaveAttribute('placeholder', /exited. Press Restart/);
  await restart.click();
  await chatReady(win);
  await expect(restart).toBeHidden();
  await expect(pane.locator('.chat-item-user')).toHaveCount(0);
  await pane.locator('.chat-input').fill('back again');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('back again');
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');
  await app.close();
});

test('an agent title names the tab, usage shows as ctx %, and Yes / Always / No with a string patch render', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await chatReady(win);
  // gemini-shaped sessions report no usage, so the footer has none.
  await expect(pane.locator('.chat-composer-usage')).toHaveCount(0);
  await pane.locator('.chat-input').fill('copilot: write a greeting');
  await pane.locator('.chat-input').press('Enter');

  await expect(win.locator('.chat-tab.active')).toHaveAttribute('title', 'Greeting file');
  const usage = pane.locator('.chat-composer-meta .chat-composer-usage');
  await expect(usage).toHaveText('ctx 3%');
  await expect(usage).toHaveAttribute('title', /of .* context tokens used/);

  const perm = pane.locator('.chat-perm');
  await expect(perm.locator('.chat-perm-btn')).toHaveText(['Yes', 'Always', 'No']);
  await expect(perm.locator('.chat-perm-detail')).toContainText('*** Add File: greeting.txt');
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-mode-kiro-perm.png') });
  await perm.locator('.chat-perm-btn', { hasText: 'Always' }).click();
  await expect(perm.locator('.chat-perm-btn')).toHaveCount(0);
  await expect(perm.locator('.chat-perm-verdict')).toHaveText('Always allowed');
  const tool = pane.locator('.chat-tool');
  await expect(tool).toHaveAttribute('data-status', 'done');
  await tool.locator('.chat-tool-head').click();
  await expect(tool.locator('.chat-tool-pre').first()).toContainText('+hello from husk');
  await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');

  // The title and usage come back from the replay log after a reload.
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => window.HuskChat && document.querySelector('.chat-pane.show'));
  await expect(win.locator('.chat-tab.active')).toHaveAttribute('title', 'Greeting file');
  await expect(win.locator('.chat-pane.show .chat-composer-usage')).toHaveText('ctx 3%');
  await app.close();
});

test('the Sessions column lists live tabs with their state, + New adds a second card, and search filters', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await chatReady(win);

  // The column shows on the chat page and the rail stands in its icon strip.
  const col = win.locator('#chat-sessions');
  await expect(col).toBeVisible();
  await expect(win.locator('body')).toHaveAttribute('data-rail', 'collapsed');
  const live = col.locator('.cs-card[data-kind="live"]');
  await expect(live).toHaveCount(1);
  await expect(live.first()).toHaveClass(/is-active/);
  await expect(live.first().locator('.cs-card-agent')).toHaveText('gemini');

  await pane.locator('.chat-input').fill('slow: write a greeting');
  await pane.locator('.chat-input').press('Enter');
  await expect(live.first()).toHaveAttribute('data-state', 'running');
  await expect(live.first().locator('.cs-card-state')).toHaveText('Thinking...');
  await expect(live.first().locator('.cs-card-excerpt')).toContainText('slow: write a greeting');
  await expect(win.locator('#tcs-run')).toHaveAttribute('data-on', '1');
  await expect(live.first()).toHaveAttribute('data-state', 'needs');
  await expect(live.first().locator('.cs-card-state')).toHaveText('Needs approval');
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(live.first()).toHaveAttribute('data-state', 'done');
  await expect(win.locator('#tcs-run')).toHaveAttribute('data-on', '0');

  // + New opens a second tab, which gets its own card and becomes the active one.
  await col.locator('#cs-new').click();
  await expect(win.locator('.chat-tab')).toHaveCount(2);
  await expect(live).toHaveCount(2);
  await expect(col.locator('.cs-card.is-active')).toHaveCount(1);
  await expect(col.locator('.cs-card.is-active .cs-card-title')).not.toHaveText('slow: write a greeting');
  // The caret lists the agent CLIs a new chat can start with.
  await col.locator('#cs-new-caret').click();
  await expect(col.locator('#cs-agent-menu')).toBeVisible();
  await expect(col.locator('#cs-agent-menu .cs-menu-item').first()).toBeVisible();
  await win.keyboard.press('Escape');
  await col.locator('.cs-title').click();
  await expect(col.locator('#cs-agent-menu')).toBeHidden();

  // Search narrows by title and last line, and says so when nothing is left.
  const q = col.locator('#cs-q');
  await q.fill('greet');
  await expect(live).toHaveCount(1);
  await expect(live.first().locator('.cs-card-title')).toHaveText('slow: write a greeting');
  await q.fill('no such chat anywhere');
  await expect(col.locator('.cs-card')).toHaveCount(0);
  await expect(col.locator('.cs-empty')).toHaveText('No sessions match.');
  await q.fill('');
  await expect(live).toHaveCount(2);

  // A card switches tabs.
  await live.filter({ hasText: 'slow: write a greeting' }).click();
  await expect(win.locator('.chat-tab.active')).toHaveAttribute('title', 'slow: write a greeting');
  await expect(win.locator('.chat-pane.show .chat-item-user')).toHaveCount(1);

  // The head toggle hides the column and gives the rail back.
  await win.locator('#btn-sessions-col').click();
  await expect(col).toBeHidden();
  await expect(win.locator('body')).toHaveAttribute('data-rail', 'expanded');
  await win.locator('#btn-sessions-col').click();
  await expect(col).toBeVisible();
  await app.close();
});

test('a tool row opens into its card, Formatted and Raw switch, the top bar counts context, and Ember is warm', async () => {
  const { homeDir, bin } = makeHome();
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'gemini', theme: 'ember',
  }));
  const { app, win } = await launch(homeDir, bin);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1500, 900); });
  await expect(win.locator('body')).toHaveAttribute('data-theme', 'ember');
  await expect(win.locator('#pref-theme option[value="ember"]')).toHaveText('Ember');
  expect(await win.locator('#pref-theme').inputValue()).toBe('ember');
  const bg = await win.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bg').trim());
  expect(bg).toBe('#171311');
  const bodyBg = await win.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bodyBg).toBe('rgb(23, 19, 17)');

  const pane = win.locator('.chat-pane.show');
  await chatReady(win);
  await expect(win.locator('#topbar-chatstat')).toBeVisible();
  await expect(win.locator('#tcs-conn')).toHaveAttribute('data-on', '1');
  await expect(win.locator('#tcs-ctx')).toBeHidden();

  await pane.locator('.chat-input').fill('copilot: write a greeting');
  await pane.locator('.chat-input').press('Enter');
  await expect(win.locator('#tcs-ctx-text')).toHaveText('3.2K / 128K');
  await expect(win.locator('#tab-strip .chat-tab.active .chat-tab-label')).toHaveText('Greeting file');
  await expect(pane.locator('.chat-item-user .chat-bubble')).toHaveText('copilot: write a greeting');
  await expect(pane.locator('.chat-thought-label')).toHaveText(/Thought|Thinking/);

  // The tool is a light row while it waits on the permission.
  const tool = pane.locator('.chat-tool');
  await expect(tool).toHaveAttribute('data-waiting', '1');
  await expect(tool.locator('.chat-tool-verb')).toHaveText('Running:');
  await expect(tool.locator('.chat-tool-card')).toBeHidden();
  await tool.locator('.chat-tool-head').click();
  const card = tool.locator('.chat-tool-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.chat-pill-status')).toHaveText('Waiting for approval');
  await expect(card.locator('.chat-pill-time')).toHaveText(/^\d\d:\d\d$/);
  await expect(card.locator('.chat-tg-btn[data-view="formatted"]')).toHaveClass(/is-on/);
  await expect(card.locator('.chat-tg-btn[data-side="input"]')).toHaveClass(/is-on/);
  await expect(card.locator('.chat-tg-btn[data-side="output"]')).toBeDisabled();
  await expect(card.locator('.chat-kv-key')).toHaveText('patch');
  await expect(card.locator('.chat-kv-val')).toContainText('*** Add File: greeting.txt');
  // Raw shows the input as JSON, Formatted brings the key and value back.
  await card.locator('.chat-tg-btn[data-view="raw"]').click();
  await expect(card.locator('.chat-tg-btn[data-view="raw"]')).toHaveClass(/is-on/);
  await expect(card.locator('.chat-kv')).toHaveCount(0);
  await expect(card.locator('.chat-tool-raw')).toContainText('"*** Begin Patch\\n*** Add File: greeting.txt');
  await card.locator('.chat-tg-btn[data-view="formatted"]').click();
  await expect(card.locator('.chat-tool-raw')).toHaveCount(0);
  await expect(card.locator('.chat-kv-key')).toHaveText('patch');
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-crew-ember-waiting.png') });

  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Yes' }).click();
  await expect(tool).toHaveAttribute('data-status', 'done');
  await expect(tool).not.toHaveAttribute('data-waiting', '1');
  await expect(tool.locator('.chat-tool-verb')).toHaveText('Ran:');
  await expect(card.locator('.chat-pill-status')).toHaveText('Done');
  await card.locator('.chat-tg-btn[data-side="output"]').click();
  await expect(card.locator('.chat-diff-line.is-add .chat-diff-text')).toHaveText('hello from husk');
  await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');

  // Under the finished turn: copy and re-run. The agent terminal is a
  // preference now, not a per-turn action.
  const acts = pane.locator('.chat-meta .chat-turn-actions');
  await expect(acts.locator('.chat-act')).toHaveCount(2);
  await expect(acts.locator('.chat-act-term')).toHaveCount(0);
  await acts.locator('.chat-act-rerun').click();
  await expect(pane.locator('.chat-input')).toHaveValue('copilot: write a greeting');
  await pane.locator('.chat-input').fill('');
  await win.mouse.move(5, 5);
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-crew-ember.png') });
  await app.close();
});


// Shared seed: one past copilot session (the fixture stands in for copilot) in
// a temporary HOME, so a cold boot has something to come back to.
function seedPastSession(homeDir, bin, extraConfig) {
  const shim = path.join(bin, 'copilot');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const work = path.join(homeDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const id = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
  const dir = path.join(homeDir, '.copilot', 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - 1800 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${work}\ncreated_at: ${when}\nupdated_at: ${when}\nname: Yesterday's thread\n`);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    { type: 'user.message', data: { content: 'where were we' } },
    { type: 'assistant.message', data: { content: 'We were fixing the installer.' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify(Object.assign({
    firstRunDone: true, skipWelcome: true, agentCommand: 'copilot', agentCwd: work,
  }, extraConfig || {})));
  return { id, work };
}

test('a cold boot resumes the newest session into Chat instead of opening an empty chat', async () => {
  const { homeDir, bin } = makeHome();
  const { id } = seedPastSession(homeDir, bin);
  const { app, win } = await launch(homeDir, bin);
  await expect(win.locator('.chat-tab')).toHaveCount(1);
  await expect(win.locator('.chat-tab.active')).toHaveAttribute('title', "Yesterday's thread");
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-item-user .chat-bubble').first()).toHaveText('where were we');
  await expect(pane.locator('.chat-item-text').first()).toContainText('We were fixing the installer.');
  await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Resumed session' })).toHaveCount(1);
  await expect(win.locator('#chat-empty')).not.toHaveClass(/show/);
  // The resumed session is the live tab, not a second entry in the column.
  await expect(win.locator(`#chat-sessions .cs-card[data-kind="past"][data-session="${id}"]`)).toHaveCount(0);
  await chatReady(win);
  await pane.locator('.chat-input').fill('continue');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user')).toHaveCount(2);
  // + New still opens a fresh chat beside it.
  await win.locator('#cs-new').click();
  await expect(win.locator('.chat-tab')).toHaveCount(2);
  await expect(win.locator('.chat-pane.show .chat-item-user')).toHaveCount(0);
  await app.close();
});

test('resumeLastOnLaunch: false keeps the old behaviour of a fresh chat on boot', async () => {
  const { homeDir, bin } = makeHome();
  seedPastSession(homeDir, bin, { resumeLastOnLaunch: false });
  const { app, win } = await launch(homeDir, bin);
  await expect(win.locator('.chat-tab')).toHaveCount(1);
  await expect(win.locator('.chat-pane.show .chat-item-user')).toHaveCount(0);
  await expect(win.locator('#chat-sessions .cs-card[data-kind="past"]')).toHaveCount(1);
  await app.close();
});

test('a past session card resumes into Chat with its history replayed above the live part', async () => {
  const { homeDir, bin } = makeHome();
  // The fixture stands in for copilot, which speaks ACP, so the resume runs
  // the real path: the session list, resumeCommand, chat:history, chat:start.
  const shim = path.join(bin, 'copilot');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const work = path.join(homeDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const id = '5d6c1f0e-2b7a-4c1e-9f00-0123456789ab';
  const dir = path.join(homeDir, '.copilot', 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${work}\ncreated_at: ${when}\nupdated_at: ${when}\nname: Old greeting chat\n`);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), [
    { type: 'user.message', data: { content: 'say hi from before' } },
    { type: 'assistant.message', data: { content: 'Hi from the earlier session.' } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  // A newer session exists too, so boot resumes that one and this older one
  // stays a card to click.
  const newerId = '9f8e7d6c-5b4a-4392-8170-fedcba987654';
  const newerDir = path.join(homeDir, '.copilot', 'session-state', newerId);
  fs.mkdirSync(newerDir, { recursive: true });
  const later = new Date(Date.now() - 600 * 1000).toISOString();
  fs.writeFileSync(path.join(newerDir, 'workspace.yaml'), `id: ${newerId}\ncwd: ${work}\ncreated_at: ${later}\nupdated_at: ${later}\nname: Newer chat\n`);
  fs.writeFileSync(path.join(newerDir, 'events.jsonl'), JSON.stringify({ type: 'user.message', data: { content: 'newest one' } }) + '\n');
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'copilot', agentCwd: work,
  }));
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  await expect(win.locator('.chat-tab.active')).toHaveAttribute('title', 'Newer chat');
  const col = win.locator('#chat-sessions');
  const past = col.locator(`.cs-card[data-kind="past"][data-session="${id}"]`);
  await expect(past).toBeVisible();
  await expect(past.locator('.cs-card-title')).toHaveText('Old greeting chat');
  await expect(past.locator('.cs-card-agent')).toHaveText('copilot');
  await past.click();

  await expect(win.locator('.chat-tab')).toHaveCount(2);
  await expect(win.locator('.chat-tab.active')).toHaveAttribute('title', 'Old greeting chat');
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-item-user .chat-bubble').first()).toHaveText('say hi from before');
  await expect(pane.locator('.chat-item-text').first()).toContainText('Hi from the earlier session.');
  await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Resumed session' })).toHaveCount(1);
  await expect(win.locator('.term-pane.show')).toHaveCount(0);
  await chatReady(win);
  // The live part continues under the history.
  await pane.locator('.chat-input').fill('and now');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-item-user')).toHaveCount(2);
  await expect(pane.locator('.chat-item-user .chat-bubble').nth(1)).toHaveText('and now');
  await expect(pane.locator('.chat-perm')).toBeVisible();
  const order = await pane.evaluate((p) => [...p.querySelectorAll('.chat-item')].map((n) =>
    n.classList.contains('chat-item-user') ? 'user' : n.classList.contains('chat-meta') ? 'meta:' + n.textContent : 'other'));
  const resumedAt = order.findIndex((x) => x === 'meta:Resumed session');
  expect(resumedAt).toBeGreaterThan(0);
  expect(order.indexOf('user')).toBeLessThan(resumedAt);
  expect(order.lastIndexOf('user')).toBeGreaterThan(resumedAt);
  await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'chat-crew-resumed.png') });
  await app.close();
});

test('Enter while a reply streams queues the message and sends it when the turn ends', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  const input = pane.locator('.chat-input');
  await input.fill('slow: first one');
  await input.press('Enter');
  await expect(pane.locator('.chat-item-user')).toHaveCount(1);
  await expect(input).toHaveAttribute('placeholder', /queues it/);
  await input.fill('second one');
  await input.press('Enter');
  // Not refused: it waits in the queue strip, and the field is clear again.
  await expect(pane.locator('.chat-item-user.is-queued')).toHaveCount(1);
  await expect(pane.locator('.is-queued .chat-bubble')).toHaveText('second one');
  await expect(input).toHaveValue('');
  await expect(pane.locator('.chat-item-user:not(.is-queued)')).toHaveCount(1);
  // The first turn needs its permission answered before it can end.
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  // Then the queued one goes out by itself, in order, and the strip empties.
  await expect(pane.locator('.chat-item-user')).toHaveCount(2, { timeout: 15_000 });
  await expect(pane.locator('.chat-item-user .chat-bubble').nth(1)).toHaveText('second one');
  await expect(pane.locator('.chat-item-user.is-queued')).toHaveCount(0);
  await expect(pane.locator('.chat-perm')).toHaveCount(2);
  await app.close();
});

test('a queued message can be removed before it goes out', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  const input = pane.locator('.chat-input');
  await input.fill('slow: hold');
  await input.press('Enter');
  await input.fill('never mind');
  await input.press('Enter');
  await expect(pane.locator('.chat-item-user.is-queued')).toHaveCount(1);
  await pane.locator('.chat-queue-x').click();
  await expect(pane.locator('.chat-item-user.is-queued')).toHaveCount(0);
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Done' })).toHaveCount(1);
  await expect(pane.locator('.chat-item-user')).toHaveCount(1);
  await app.close();
});

test('Up and Down walk the prompt history in the composer', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  const input = pane.locator('.chat-input');
  for (const text of ['alpha prompt', 'beta prompt']) {
    await input.fill(text);
    await input.press('Enter');
    await pane.locator('.chat-perm:not(.is-resolved) .chat-perm-btn', { hasText: 'Reject' }).click();
    await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Done' })).toHaveCount(text === 'alpha prompt' ? 1 : 2);
  }
  await input.fill('draft in progress');
  // The caret sits at the end, so Up does nothing until it is at the start.
  await input.press('ArrowUp');
  await expect(input).toHaveValue('draft in progress');
  await input.press('Home');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('beta prompt');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('alpha prompt');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('alpha prompt');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('beta prompt');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('draft in progress');
  // A recalled prompt sends like any other.
  await input.fill('');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('beta prompt');
  await input.press('Enter');
  await expect(pane.locator('.chat-item-user .chat-bubble').nth(2)).toHaveText('beta prompt');
  await app.close();
});

test('the thread shows a live Thinking row while a turn runs and drops it when the reply lands', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-typing')).toHaveCount(0);
  await pane.locator('.chat-input').fill('quiet: think first');
  await pane.locator('.chat-input').press('Enter');
  const typing = pane.locator('.chat-typing');
  await expect(typing).toBeVisible();
  await expect(typing.locator('.chat-typing-label')).toHaveText('Thinking');
  // Always the last thing in the thread, under the prompt that started it.
  // While the row is showing it is the last thing in the thread; by the time
  // this reads, the agent may already be streaming, in which case the row has
  // stepped aside and the streaming block is last instead.
  const tail = await pane.evaluate((p) => { const inner = p.querySelector('.chat-thread-inner'); const last = inner.lastElementChild; return { typingShown: !!inner.querySelector('.chat-typing'), lastIsTyping: last.classList.contains('chat-typing'), lastKind: last.className }; });
  if (tail.typingShown) expect(tail.lastIsTyping).toBe(true);
  else expect(tail.lastKind).toMatch(/chat-item-thought|chat-item-text|chat-tool|chat-perm/);
  // A permission card is the state while it waits on the reader: no row.
  await expect(pane.locator('.chat-perm')).toBeVisible();
  await expect(typing).toHaveCount(0);
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Done' })).toHaveCount(1);
  await expect(typing).toHaveCount(0);
  await app.close();
});

test('Edit and resend rewrites the earlier prompt in place: the old exchange leaves and the new one follows', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  const input = pane.locator('.chat-input');
  for (const text of ['first prompt', 'second prompt']) {
    await input.fill(text);
    await input.press('Enter');
    await pane.locator('.chat-perm:not(.is-resolved) .chat-perm-btn', { hasText: 'Reject' }).click();
    await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Done' })).toHaveCount(text === 'first prompt' ? 1 : 2);
  }
  await expect(pane.locator('.chat-item-user')).toHaveCount(2);
  // Edit the FIRST turn.
  await pane.locator('.chat-act-rerun').first().click();
  await expect(input).toHaveValue('first prompt');
  await expect(pane.locator('.chat-edit-note')).toBeVisible();
  // Escape backs out without sending or cutting anything.
  await input.press('Escape');
  await expect(pane.locator('.chat-edit-note')).toBeHidden();
  await expect(input).toHaveValue('');
  await expect(pane.locator('.chat-item-user')).toHaveCount(2);
  // Now really edit it.
  await pane.locator('.chat-act-rerun').first().click();
  await input.fill('first prompt, rewritten');
  await input.press('Enter');
  await expect(pane.locator('.chat-item-user')).toHaveCount(1);
  await expect(pane.locator('.chat-item-user .chat-bubble').first()).toHaveText('first prompt, rewritten');
  await expect(pane.locator('.chat-item-text', { hasText: 'second' })).toHaveCount(0);
  await expect(pane.locator('.chat-perm')).toHaveCount(1);
  await expect(pane.locator('.chat-edit-note')).toBeHidden();
  await pane.locator('.chat-perm:not(.is-resolved) .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Done' })).toHaveCount(1);
  await app.close();
});

test('the model chip opens a picker from the agent list, picking one switches it live, and /model works too', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-model-btn')).toHaveText('Fake 1');
  await pane.locator('.chat-model-btn').click();
  const menu = pane.locator('.chat-model-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.chat-model-item')).toHaveCount(2);
  await expect(menu.locator('.chat-model-item.is-current .chat-model-name')).toHaveText('Fake 1');
  await menu.locator('.chat-model-item', { hasText: 'Fake 2' }).click();
  await expect(menu).toBeHidden();
  await expect(pane.locator('.chat-model-btn')).toHaveText('Fake 2');
  await expect(pane.locator('.chat-meta-line', { hasText: 'Model set to Fake 2' })).toHaveCount(1);
  // The agent really took it: its next reply names the model.
  await pane.locator('.chat-input').fill('write it');
  await pane.locator('.chat-input').press('Enter');
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-item-text').last()).toContainText('(model fake-2)');
  // /model <id> is the keyboard route.
  await pane.locator('.chat-input').fill('/model fake-1');
  await pane.locator('.chat-input').press('Enter');
  await expect(pane.locator('.chat-model-btn')).toHaveText('fake-1');
  await expect(pane.locator('.chat-item-user:not(.is-queued)')).toHaveCount(1);
  // An id outside the list goes through the custom row.
  await pane.locator('.chat-model-btn').click();
  await expect(menu.locator('.chat-model-source')).toHaveText('Listed by gemini');
  await menu.locator('.chat-model-custom-input').fill('fake-9-preview');
  await menu.locator('.chat-model-custom-go').click();
  await expect(pane.locator('.chat-model-btn')).toHaveText('fake-9-preview');
  // Bare /model opens the picker instead of sending anything.
  await pane.locator('.chat-input').fill('/model');
  await pane.locator('.chat-input').press('Enter');
  await expect(menu).toBeVisible();
  await expect(pane.locator('.chat-item-user:not(.is-queued)')).toHaveCount(1);
  await app.close();
});

test('Report a bug and Request a feature live in the top bar and the Help menu, with prefilled GitHub issue links', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  // One help button in the top bar; bug and lightbulb live in its menu.
  await expect(win.locator('#btn-help')).toBeVisible();
  await expect(win.locator('#btn-report-bug')).toBeHidden();
  await win.locator('#btn-help').click();
  await expect(win.locator('#btn-report-bug')).toBeVisible();
  await expect(win.locator('#btn-request-feature')).toBeVisible();
  // The menu is on top: the element under each item's centre is the item.
  const onTop = await win.evaluate(() => [...document.querySelectorAll('#topbar-help-menu .tb-menu-item')].every((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!hit && b.contains(hit); }));
  expect(onTop).toBe(true);
  const order = await win.evaluate(() => [...document.querySelectorAll('#topbar-help-menu .tb-menu-item')].map((b) => b.id));
  expect(order).toEqual(['btn-report-bug', 'btn-request-feature', 'btn-help-github']);
  await win.keyboard.press('Escape');
  await expect(win.locator('#btn-report-bug')).toBeHidden();
  // Right side reads as groups: agents/status, help, then the two actions.
  const groups = await win.evaluate(() => [...document.querySelectorAll('.topbar-side-right > *')].map((n) => n.id || n.className.split(' ')[0]));
  expect(groups).toEqual(['topbar-agents', 'topbar-chatstat', 'tb-sep', 'topbar-help', 'tb-sep', 'btn-new-session', 'btn-status-toggle']);
  const bug = await win.evaluate(() => window.husk.feedback.url('bug'));
  expect(bug.ok).toBe(true);
  const u = new URL(bug.url);
  expect(u.origin + u.pathname).toBe('https://github.com/DorShaer/Husk/issues/new');
  expect(u.searchParams.get('labels')).toBe('bug');
  expect(u.searchParams.get('body')).toContain('- Husk ');
  expect(u.searchParams.get('body')).toContain('- Agent gemini');
  const feat = await win.evaluate(() => window.husk.feedback.url('feature'));
  expect(new URL(feat.url).searchParams.get('labels')).toBe('enhancement');
  const menu = await app.evaluate(({ Menu }) => {
    const m = Menu.getApplicationMenu();
    const labels = m.items.map((i) => i.label);
    const help = m.items.find((i) => i.label === 'Help');
    return { labels, help: help ? help.submenu.items.map((i) => i.label).filter(Boolean) : [] };
  });
  expect(menu.labels.slice(-2)).toEqual(['Window', 'Help']);
  expect(menu.help.slice(0, 2)).toEqual(['Report a bug', 'Request a feature']);
  await app.close();
});

test('Up pulls a queued message back for editing; cleared it is never sent, edited it re-queues', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  const input = pane.locator('.chat-input');
  await input.fill('slow: first one');
  await input.press('Enter');
  await input.fill('second one');
  await input.press('Enter');
  await expect(pane.locator('.chat-item-user.is-queued')).toHaveCount(1);
  // Up takes it back out of the queue and into the field.
  await input.press('ArrowUp');
  await expect(input).toHaveValue('second one');
  await expect(pane.locator('.chat-item-user.is-queued')).toHaveCount(0);
  // Deleting it means it never goes out.
  await input.fill('');
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-meta .chat-meta-line', { hasText: 'Done' })).toHaveCount(1);
  await expect(pane.locator('.chat-item-user:not(.is-queued)')).toHaveCount(1);
  // Edited instead: the edited text is what queues.
  await input.fill('slow: again');
  await input.press('Enter');
  await input.fill('third one');
  await input.press('Enter');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('third one');
  await input.fill('third one, edited');
  await input.press('Enter');
  await expect(pane.locator('.is-queued .chat-bubble')).toHaveText('third one, edited');
  await pane.locator('.chat-perm:not(.is-resolved) .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-item-user:not(.is-queued) .chat-bubble').nth(2)).toHaveText('third one, edited', { timeout: 15_000 });
  await app.close();
});

test('pasting an image attaches a thumbnail, sends it with the prompt, and the bubble shows it', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  const input = pane.locator('.chat-input');
  await input.focus();
  // A 1x1 PNG pasted the way the clipboard delivers it: a file item on the event.
  await win.evaluate(() => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('.chat-pane.show .chat-input').dispatchEvent(ev);
  });
  await expect(pane.locator('.chat-attach-thumb')).toHaveCount(1);
  await expect(pane.locator('.chat-attach-thumb img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(pane.locator('.chat-send')).toBeEnabled();
  await input.fill('what is in this picture');
  await input.press('Enter');
  await expect(pane.locator('.chat-attach-thumb')).toHaveCount(0);
  const bubble = pane.locator('.chat-item-user:not(.is-queued) .chat-bubble').first();
  await expect(bubble.locator('img')).toHaveCount(1);
  await expect(bubble).toContainText('what is in this picture');
  await pane.locator('.chat-perm .chat-perm-btn', { hasText: 'Allow once' }).click();
  await expect(pane.locator('.chat-item-text').last()).toContainText('(images 1)');
  // The × drops a pasted image before it goes.
  await win.evaluate(() => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'two.png', { type: 'image/png' }));
    document.querySelector('.chat-pane.show .chat-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(pane.locator('.chat-attach-thumb')).toHaveCount(1);
  await pane.locator('.chat-attach-x').click();
  await expect(pane.locator('.chat-attach-thumb')).toHaveCount(0);
  await app.close();
});

test('a bare / lists every command in a scrolling popover, and Alt+Backspace deletes a word', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  const input = pane.locator('.chat-input');
  await input.fill('/');
  const rows = pane.locator('.chat-ac .chat-ac-row');
  await expect(rows).toHaveCount(13);
  const scroll = await pane.locator('.chat-ac').evaluate((n) => ({ sh: n.scrollHeight, ch: n.clientHeight, top: n.scrollTop }));
  expect(scroll.sh).toBeGreaterThan(scroll.ch);
  // Up from the first row wraps to the last and brings it into view.
  await input.press('ArrowUp');
  await expect(rows.last()).toHaveClass(/is-active/);
  const after = await pane.locator('.chat-ac').evaluate((n) => n.scrollTop);
  expect(after).toBeGreaterThan(0);
  // Typing narrows the list.
  await input.fill('/hc');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('/hcmd');
  await input.press('Escape');
  await input.fill('');

  await input.fill('delete the last word');
  await input.press('Alt+Backspace');
  await expect(input).toHaveValue('delete the last ');
  await input.press('Alt+Backspace');
  await expect(input).toHaveValue('delete the ');
  await input.press('Home');
  await input.press('Alt+Delete');
  await expect(input).toHaveValue(' the ');
  await app.close();
});

test('a long resumed conversation opens scrolled to its last message', async () => {
  const { homeDir, bin } = makeHome();
  const shim = path.join(bin, 'copilot');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const work = path.join(homeDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const id = '3c2b1a09-8f7e-4d6c-9b5a-112233445566';
  const dir = path.join(homeDir, '.copilot', 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - 900 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${work}\ncreated_at: ${when}\nupdated_at: ${when}\nname: Long thread\n`);
  const lines = [];
  for (let i = 1; i <= 40; i++) {
    lines.push({ type: 'user.message', data: { content: 'question number ' + i } });
    lines.push({ type: 'assistant.message', data: { content: 'answer number ' + i + '. ' + 'Lorem ipsum dolor sit amet. '.repeat(6) } });
  }
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'copilot', agentCwd: work }));
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-item-user')).toHaveCount(40, { timeout: 15_000 });
  await expect.poll(() => pane.locator('.chat-thread').evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight), { timeout: 5000 }).toBeLessThan(60);
  await expect(pane.locator('.chat-item-text', { hasText: 'answer number 40.' })).toBeInViewport();
  await expect(pane.locator('.chat-item-user', { hasText: 'question number 1' }).first()).not.toBeInViewport();
  // Scrolling up holds; a new streamed reply does not yank the reader down.
  await pane.locator('.chat-thread').evaluate((n) => { n.scrollTop = 0; n.dispatchEvent(new Event('scroll')); });
  await win.waitForTimeout(200);
  expect(await pane.locator('.chat-thread').evaluate((n) => n.scrollTop)).toBe(0);
  await app.close();
});

test('a session log over the replay limit still resumes into Chat, showing its latest part', async () => {
  const { homeDir, bin } = makeHome();
  const shim = path.join(bin, 'copilot');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  const work = path.join(homeDir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const id = '0a1b2c3d-4e5f-4061-8293-a4b5c6d7e8f9';
  const dir = path.join(homeDir, '.copilot', 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  const when = new Date(Date.now() - 600 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${id}\ncwd: ${work}\ncreated_at: ${when}\nupdated_at: ${when}\nname: Huge thread\n`);
  // ~14 MB of old turns (a pasted screenshot each), then the recent exchange.
  const blob = 'A'.repeat(200 * 1024);
  const out = fs.createWriteStream(path.join(dir, 'events.jsonl'));
  for (let i = 0; i < 70; i++) out.write(JSON.stringify({ type: 'user.message', data: { content: 'old ' + i, attachments: [{ data: blob }] } }) + '\n');
  out.write(JSON.stringify({ type: 'user.message', data: { content: 'the most recent question' } }) + '\n');
  out.write(JSON.stringify({ type: 'assistant.message', data: { content: 'the most recent answer' } }) + '\n');
  await new Promise((r) => out.end(r));
  expect(fs.statSync(path.join(dir, 'events.jsonl')).size).toBeGreaterThan(13 * 1024 * 1024);
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'copilot', agentCwd: work }));
  const { app, win } = await launch(homeDir, bin);
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-item-text', { hasText: 'the most recent answer' })).toBeVisible({ timeout: 15_000 });
  await expect(pane.locator('.chat-meta-line', { hasText: 'Earlier messages in this session are not shown.' })).toHaveCount(1);
  await expect(win.locator('.term-pane.show')).toHaveCount(0);
  await app.close();
});

test('the status bar names the model the chat reports, and follows a switch', async () => {
  const { homeDir, bin } = makeHome();
  // A default for new sessions that this chat is not running.
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify({ model: 'some-other-model' }));
  const { app, win } = await launch(homeDir, bin);
  await chatReady(win);
  const pane = win.locator('.chat-pane.show');
  await expect(pane.locator('.chat-model-btn')).toHaveText('Fake 1');
  await expect(win.locator('#sb-model')).toHaveText('Fake 1');
  await pane.locator('.chat-model-btn').click();
  await win.locator('.chat-model-item', { hasText: 'Fake 2' }).click();
  await expect(pane.locator('.chat-model-btn')).toHaveText('Fake 2');
  await expect(win.locator('#sb-model')).toHaveText('Fake 2');
  await app.close();
});
