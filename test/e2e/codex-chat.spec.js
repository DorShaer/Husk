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

async function launch(homeDir, bin, extraEnv = {}) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CODEX_HOME: path.join(homeDir, '.codex'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', ...extraEnv },
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

test('Codex questions support choices, typed answers, reload and dismissal while Allow all is on', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    await win.evaluate(() => window.husk.chat.allowAll({ tabId: activeTabId, on: true }));
    const pane = win.locator('.chat-pane.show');
    const input = pane.locator('.chat-input');
    await input.fill('questions: ask about the panel');
    await input.press('Enter');
    let card = pane.locator('.chat-perm:not(.is-resolved)');
    await expect(card).toContainText('Waiting for your answer');
    await expect(pane).toContainText('I can keep checking the layout while you choose.');
    await expect(input).toHaveAttribute('placeholder', /Enter to send/);
    await win.reload();
    await chatReady(win);
    card = pane.locator('.chat-perm:not(.is-resolved)');
    await expect(card.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: /Both/ }).click();
    await card.getByRole('textbox', { name: 'Details', exact: true }).fill('Remember the width');
    await card.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(pane).toContainText('"panel":{"answers":["Both"]}');
    await expect(pane).toContainText('"note":{"answers":["Remember the width"]}');
    await expect(input).toHaveAttribute('placeholder', /Enter to send/);
    await input.fill('questions: dismiss this one');
    await input.press('Enter');
    await pane.locator('.chat-perm:not(.is-resolved)').getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(pane).toContainText('Question reply: {"answers":{}}');
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

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
    await expect(perm.locator('.chat-perm-btn')).toHaveCount(3);
    await perm.locator('.chat-perm-btn', { hasText: /^Allow$/ }).click();
    await expect(tool).toHaveAttribute('data-status', 'done');
    await expect(pane.locator('.chat-item-text').last()).toContainText('decision was accept');
    await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');

    // Native context stays below the input; the side panel keeps its terminal reading.
    await win.evaluate(() => setStatusPane('work')); // eslint-disable-line no-undef
    await expect(win.locator('#sp-pane-work .sp-ctxbar')).toHaveCount(0);
    await expect(pane.locator('.chat-context-value')).toContainText('10%');
    expect(await pane.locator('.chat-context-window').evaluate((meter) => meter.previousElementSibling.classList.contains('chat-composer'))).toBe(true);
    expect(await pane.locator('.chat-context-window').evaluate((meter) => meter.getBoundingClientRect().bottom <= Math.min(innerHeight, meter.closest('.chat-pane').getBoundingClientRect().bottom))).toBe(true);
    await win.evaluate(() => {
      const tab = TABS.get(activeTabId);
      tab.mode = 'terminal';
      lastStats = { agentIsClaude: true, usage: { session: { ctxTokens: 20000, ctxWindow: 200000, ctxPct: 10 } } };
      paintWorkPane();
    });
    await expect(win.locator('#sp-pane-work .sp-ctxbar')).toBeVisible();
    await win.evaluate(() => { TABS.get(activeTabId).mode = 'chat'; paintWorkPane(); });
    await win.evaluate(() => setStatusPane('status')); // eslint-disable-line no-undef
    await expect(win.locator('#sp-content .sp-ctxbar')).toHaveCount(0);
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'codex-chat.png') });
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
    await win.evaluate(() => {
      [...TABS.values()].forEach((tab, i) => { tab.chat.apply({ type: 'usage', used: (i + 1) * 1000, size: 128000 }); tab.chat.flush(); });
    });
    await expect(win.locator('.chat-pane.show .chat-context-value')).toContainText('2K / 128K');

    // gemini is not the configured tool, so the footer names it; its model too.
    await expect(win.locator('#sb-agent-item')).toBeVisible();
    await expect(win.locator('#sb-agent')).toHaveText('gemini');
    await win.evaluate(() => setStatusPane('status')); // eslint-disable-line no-undef
    await expect(win.locator('#sp-content')).toContainText('Gemini');

    await tabs.nth(0).click();
    await expect(win.locator('#sb-agent')).toHaveText('codex');
    await expect(win.locator('.chat-pane.show .chat-context-value')).toContainText('1K / 128K');
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


for (const archived of [false, true]) {
test(`resuming a ${archived ? 'archived' : 'saved'} Codex rollout shows history and continues the original thread`, async () => {
  const { homeDir, bin } = makeHome();
  const id = '01a1d208-8467-7c32-8e5a-27d5e8d10a95';
  const dir = archived ? path.join(homeDir, '.codex', 'archived_sessions') : path.join(homeDir, '.codex', 'sessions', '2026', '11', '13');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-11-13T01-12-15-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd: REPO_ROOT, timestamp: '2026-11-13T01:12:15Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the release tests' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All 292 end-to-end tests passed.' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    await win.evaluate(({ sessionId, project }) => resumeSessionInChat({ id: sessionId, owner: 'codex', project, title: 'Release checks' }), { sessionId: id, project: REPO_ROOT }); // eslint-disable-line no-undef
    await chatReady(win);
    const pane = win.locator('.chat-pane.show');
    await expect(pane).toContainText('Check the release tests');
    await expect(pane).toContainText('All 292 end-to-end tests passed.');
    const sessions = await win.evaluate(() => window.husk.chat.list());
    expect(sessions.sessions.some((s) => s.sessionId === id)).toBe(true);
    await pane.locator('.chat-input').fill('continue');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-perm')).toBeVisible();
    await pane.locator('.chat-perm-btn', { hasText: /^Allow$/ }).click();
    await expect(pane).toContainText('decision was accept');
    await expect(pane).toContainText('All 292 end-to-end tests passed.');
  } finally { await app.close(); }
});
}

test('job model selectors use chat protocol names and discover Codex models without an open chat', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    await win.evaluate(() => {
      cfg = { ...cfg, taskRouting: { cheap: { vendor: 'codex', model: '' } } };
      openOrchestratorModal();
    });
    await expect(win.locator('#aut-mr-simple option[value="gpt-fake"]')).toHaveText('GPT Fake');
    await expect(win.locator('#aut-mr-simple option[value="gpt-5.3-codex"]')).toHaveCount(0);
    await win.evaluate(async () => {
      const live = await window.husk.chat.list();
      for (const s of live.sessions) await window.husk.chat.stop({ tabId: s.tabId });
    });
    const catalog = await win.evaluate(() => window.husk.models.list({ command: 'codex', refresh: true }));
    expect(catalog.source).toBe('app-server');
    expect(catalog.models).toEqual([{ value: 'gpt-fake', label: 'GPT Fake' }]);
    await win.evaluate(async () => {
      closeOrchestratorModal();
      await bindAutopilotRunRouting();
      document.querySelector('#aut-run-vendor').value = 'codex';
      await loadAutopilotRunModels();
    });
    await expect(win.locator('#aut-run-model option[value="gpt-fake"]')).toHaveText('GPT Fake');
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('chat actions copy real IDs and resume commands, and move context to an existing chat ID once', async () => {
  const { homeDir, bin } = makeHome();
  const log = path.join(homeDir, 'handoff-prompts.jsonl');
  const { app, win } = await launch(homeDir, bin, { HUSK_FAKE_ACP_PROMPTS: log });
  try {
    await chatReady(win);
    const source = await win.evaluate(() => ({ tabId: activeTabId, id: chatIdentity(TABS.get(activeTabId)).id }));
    await win.locator('.chat-pane.show .chat-actions').click();
    await win.getByRole('menuitem', { name: 'Copy chat ID', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(source.id);
    await win.locator('.chat-pane.show .chat-actions').click();
    await win.getByRole('menuitem', { name: 'Copy resume command', exact: true }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`codex resume ${source.id}`);
    await win.evaluate(() => window.husk.chat.allowAll({ tabId: activeTabId, on: true }));
    await win.locator('.chat-pane.show .chat-input').fill('Keep source requirement blue');
    await win.locator('.chat-pane.show .chat-input').press('Enter');
    await expect(win.locator('.chat-pane.show')).toContainText('decision was accept');
    await win.evaluate(() => openNewChatTab({ command: 'gemini', preferChat: true }));
    await chatReady(win);
    const target = await win.evaluate(() => ({ tabId: activeTabId, id: chatIdentity(TABS.get(activeTabId)).id }));
    await win.locator('.chat-pane.show .chat-input').fill('Keep destination notes green');
    await win.locator('.chat-pane.show .chat-input').press('Enter');
    await win.locator('.chat-pane.show').getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(win.locator('.chat-pane.show')).toContainText('Done, permission was');
    await win.evaluate((id) => activateTab(id), source.tabId);
    await win.locator('.chat-pane.show .chat-move-discussion').click();
    await win.getByRole('menuitem', { name: 'Move to a specific chat ID…', exact: true }).click();
    await win.getByRole('menuitem', { name: /Chat ID in Gemini/ }).click();
    await win.locator('#text-input').fill(target.id);
    await win.locator('#text-ok').click();
    await expect.poll(() => win.evaluate(() => activeTabId)).toBe(target.tabId);
    await expect(win.locator('.chat-pane.show')).toContainText('Keep destination notes green');
    expect(await win.evaluate(({ source, target }) => window.husk.chat.handoffTo({ source: { tabId: source.tabId }, targetTabId: target.tabId }), { source, target })).toMatchObject({ ok: false });
    expect(await win.evaluate((id) => window.husk.chat.handoffTo({ source: { tabId: id }, targetTabId: id }), source.tabId)).toMatchObject({ ok: false });
    await win.reload(); await chatReady(win);
    await win.locator('.chat-pane.show .chat-input').fill('Continue in the destination');
    await win.locator('.chat-pane.show .chat-input').press('Enter');
    await expect(win.locator('.chat-pane.show')).toContainText('Continued from');
    await expect.poll(() => fs.readFileSync(log, 'utf8')).toContain('Keep source requirement blue');
    await win.locator('.chat-pane.show').getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(win.locator('.chat-pane.show .chat-input')).toBeEnabled();
    await win.locator('.chat-pane.show .chat-input').fill('One more message');
    await win.locator('.chat-pane.show .chat-input').press('Enter');
    await expect.poll(() => fs.readFileSync(log, 'utf8').trim().split('\n').length).toBe(3);
    expect(JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1)).text).not.toContain('Keep source requirement blue');
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('move to ID resumes a saved destination in Native Chat and preserves its prior history', async () => {
  const { homeDir, bin } = makeHome();
  const id = '01a1d208-8467-7c32-8e5a-27d5e8d10a96';
  const dir = path.join(homeDir, '.codex/sessions/2026/11/13');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-11-13T01-12-15-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd: REPO_ROOT, timestamp: '2026-11-13T01:12:15Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original destination instructions' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    await win.evaluate(() => window.husk.chat.allowAll({ tabId: activeTabId, on: true }));
    await win.locator('.chat-pane.show .chat-input').fill('Source discussion to continue');
    await win.locator('.chat-pane.show .chat-input').press('Enter');
    await expect(win.locator('.chat-pane.show')).toContainText('decision was accept');
    await win.evaluate(() => { cfg.chatView = 'terminal'; });
    await win.locator('.chat-pane.show .chat-move-discussion').click();
    await win.getByRole('menuitem', { name: 'Move to a specific chat ID…', exact: true }).click();
    await win.getByRole('menuitem', { name: /Chat ID in OpenAI Codex/ }).click();
    await win.locator('#text-input').fill(id);
    await win.locator('#text-ok').click();
    await expect(win.locator('.chat-pane.show')).toContainText('Original destination instructions');
    await expect(win.locator('.chat-pane.show')).toContainText('Discussion context is ready');
    expect(await win.evaluate(() => chatIdentity(TABS.get(activeTabId)).id)).toBe(id);
    expect((await win.evaluate(() => window.husk.chat.list())).sessions).toHaveLength(2);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});
