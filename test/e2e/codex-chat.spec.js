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
    await expect(pane.locator('.chat-meta .chat-meta-line').filter({ hasText: /^Done/ })).toContainText('Done');

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

    // The top bar names the focused chat's own tool and model.
    await expect(win.locator('#tcs-cli')).toHaveText('Gemini');
    await win.evaluate(() => setStatusPane('status')); // eslint-disable-line no-undef
    await expect(win.locator('#sp-content')).toContainText('Gemini');

    await tabs.nth(0).click();
    await expect(win.locator('#tcs-cli')).toHaveText('Codex');
    await expect(win.locator('.chat-pane.show .chat-context-value')).toContainText('1K / 128K');
    await expect(win.locator('#tcs-model')).toHaveText('GPT Fake');
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
    fs.mkdirSync('/tmp/husk-shared-models', { recursive: true });
    const capture = async (name) => {
      await win.waitForTimeout(200);
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
      fs.writeFileSync('/tmp/husk-shared-models/' + name + '.png', Buffer.from(png, 'base64'));
    };
    await win.locator('.chat-pane.show .chat-model-btn').click();
    await expect(win.locator('.chat-pane.show .chat-model-menu .chat-model-desc')).toHaveText('The fixture model.');
    await capture('chat');
    await win.locator('.chat-pane.show .chat-model-item').click();
    await win.evaluate(() => {
      cfg = { ...cfg, taskRouting: { cheap: { vendor: 'codex', model: '' } } };
      openOrchestratorModal();
    });
    await expect(win.locator('#aut-mr-simple option[value="gpt-fake"]')).toHaveText('GPT Fake');
    await expect(win.locator('#aut-mr-simple option[value="gpt-5.3-codex"]')).toHaveCount(0);
    await win.locator('#aut-mr-simple').click();
    const sharedMenu = win.locator('.husk-model-menu');
    await expect(sharedMenu.locator('[data-model="gpt-fake"] .chat-model-desc')).toHaveText('The fixture model.');
    await expect(sharedMenu.locator('[data-model="gpt-fake"] .chat-model-name')).toHaveText('GPT Fake');
    await expect(sharedMenu.locator('[data-model="gpt-fake"] .chat-model-id')).toHaveText('gpt-fake');
    await capture('autopilot');
    await sharedMenu.locator('[data-model="gpt-fake"]').click();
    await expect(win.locator('#aut-mr-simple')).toHaveValue('gpt-fake');
    await win.locator('#aut-mr-simple').press('Enter');
    await expect(sharedMenu).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(sharedMenu).toHaveCount(0);
    await expect(win.locator('#aut-orch-modal')).toBeVisible();
    await win.locator('#aut-cli-advanced > summary').click();
    await win.locator('#aut-cli-routing .aut-cli-row[data-vendor="codex"] button').first().click();
    await expect(win.locator('#aut-cli-pick-cheap')).toBeEnabled();
    await win.locator('#aut-cli-pick-cheap').click();
    await expect(sharedMenu.locator('[data-model="gpt-fake"] .chat-model-desc')).toHaveText('The fixture model.');
    await capture('vendor-defaults');
    await sharedMenu.locator('[data-model="gpt-fake"]').click();
    await expect(win.locator('#aut-cli-pick-cheap')).toHaveValue('gpt-fake');
    await win.evaluate(async () => {
      const live = await window.husk.chat.list();
      for (const s of live.sessions) await window.husk.chat.stop({ tabId: s.tabId });
    });
    const catalog = await win.evaluate(() => window.husk.models.list({ command: 'codex', refresh: true }));
    expect(catalog.source).toBe('app-server');
    expect(catalog.models).toEqual([{ value: 'gpt-fake', label: 'GPT Fake', description: 'The fixture model.' }]);
    await win.evaluate(async () => {
      closeOrchestratorModal();
      await bindAutopilotRunRouting();
      document.querySelector('#aut-run-vendor').value = 'codex';
      await loadAutopilotRunModels();
    });
    await expect(win.locator('#aut-run-model option[value="gpt-fake"]')).toHaveText('GPT Fake');
    await win.evaluate(() => { document.querySelector('#autopilot-start-modal').hidden = false; });
    await win.locator('#aut-run-model').click();
    await expect(sharedMenu.locator('[data-model="gpt-fake"] .chat-model-desc')).toHaveText('The fixture model.');
    await capture('run-override');
    await sharedMenu.locator('[data-model="gpt-fake"]').click();
    await expect(win.locator('#aut-run-model')).toHaveValue('gpt-fake');
    await win.evaluate(() => { document.querySelector('#autopilot-start-modal').hidden = true; });
    await win.evaluate(async () => {
      setPage('workflows');
      await renderWorkflows();
      openWorkflowBuilder(null);
    });
    await win.locator('#btn-add-wf-node').click();
    await win.evaluate(async () => {
      showNodePanel(document.querySelector('#wf-canvas .drawflow-node').id.replace('node-', ''));
      document.querySelector('#wf-np-agent').value = 'codex';
      await wfLoadNodeModels('codex', '');
    });
    await win.locator('#wf-np-model').click();
    await expect(sharedMenu.locator('[data-model="gpt-fake"] .chat-model-desc')).toHaveText('The fixture model.');
    await capture('workflow');
    await sharedMenu.locator('[data-model="gpt-fake"]').click();
    await expect(win.locator('#wf-np-model')).toHaveValue('gpt-fake');

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

test('Codex-only context recovery compacts the same thread and keeps drafts, without proposing another vendor', async () => {
  const { homeDir, bin } = makeHome();
  const log = path.join(homeDir, 'compact-requests.jsonl');
  const { app, win } = await launch(homeDir, bin, { FAKE_CODEX_REQUEST_LOG: log });
  const requests = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try {
    await chatReady(win);
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agents:detect');
      ipcMain.handle('agents:detect', () => ({ agents: [{ command: 'codex', label: 'Codex', available: true }] }));
    });
    await win.evaluate(async () => { await refreshAgentMenu(); });
    const input = win.locator('.chat-pane.show .chat-input');
    await input.fill('Keep this unsent draft');
    const sessionId = await win.evaluate(() => TABS.get(activeTabId).chatState.sessionId);
    const highContext = () => win.evaluate(() => {
      const tab = TABS.get(activeTabId);
      tab.chat.apply({ type: 'usage', used: 122000, size: 128000 }); tab.chat.flush(); window.HuskUsageBell.refresh();
    });
    await highContext();
    const alert = win.locator('.toast:not(.is-out)');
    await expect(alert).toContainText('not your subscription quota');
    await expect(alert.getByRole('button', { name: 'Compact conversation', exact: true })).toBeVisible();
    await expect(alert.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
    await expect(alert.getByRole('button', { name: /vendor|another model/i })).toHaveCount(0);
    fs.mkdirSync('/tmp/husk-context-recovery', { recursive: true });
    await win.waitForTimeout(150);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.writeFileSync('/tmp/husk-context-recovery/codex-only.png', Buffer.from(png, 'base64'));
    await alert.getByRole('button', { name: 'Compact conversation', exact: true }).click();
    await expect.poll(() => requests().filter(r => r.method === 'thread/compact/start').length).toBe(1);
    const compact = requests().find(r => r.method === 'thread/compact/start');
    expect(compact.params).toEqual({ threadId: sessionId });
    expect(requests().filter(r => r.method === 'thread/start')).toHaveLength(1);
    expect(requests().filter(r => r.method === 'turn/start')).toHaveLength(0);
    await expect(win.locator('.chat-pane.show')).toContainText('Conversation compacted.');
    await expect(win.locator('.chat-pane.show .chat-context-value')).toContainText('5K / 128K');
    await expect(input).toHaveValue('Keep this unsent draft');
    expect(await win.evaluate(() => TABS.get(activeTabId).chatState.sessionId)).toBe(sessionId);
    await win.evaluate(() => window.HuskUsageBell.refresh());
    await highContext();
    await expect(win.locator('.toast:not(.is-out)').getByRole('button', { name: 'Compact conversation', exact: true })).toBeVisible();
    await win.locator('.toast:not(.is-out) .usage-toast-actions').getByRole('button', { name: 'Dismiss', exact: true }).click();
    // A real provider limit with only one vendor offers usage information,
    // without suggesting a new session or compaction as a quota workaround.
    await win.evaluate(() => window.HuskUsageBell.onChatEvent(TABS.get(activeTabId), { type: 'limit', rejected: true, window: 'plan' }));
    await expect(win.locator('.toast:not(.is-out)').getByRole('button', { name: 'View usage', exact: true })).toBeVisible();
    await expect(win.locator('.toast:not(.is-out)').getByRole('button', { name: /vendor|Compact|New conversation/i })).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('context compaction waits for the reply and runs before queued messages', async () => {
  const { homeDir, bin } = makeHome();
  const log = path.join(homeDir, 'compact-order.jsonl');
  const { app, win } = await launch(homeDir, bin, { FAKE_CODEX_REQUEST_LOG: log });
  const requests = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try {
    await chatReady(win);
    const pane = win.locator('.chat-pane.show');
    const input = pane.locator('.chat-input');
    await input.fill('first task'); await input.press('Enter');
    await expect(pane.locator('.chat-perm:not(.is-resolved)')).toBeVisible();
    await win.evaluate(() => { const tab = TABS.get(activeTabId); tab.chat.apply({ type: 'usage', used: 122000, size: 128000 }); tab.chat.flush(); window.HuskUsageBell.refresh(); });
    await win.locator('.toast:not(.is-out)').getByRole('button', { name: 'Compact after reply', exact: true }).click();
    expect(requests().some(r => r.method === 'thread/compact/start')).toBe(false);
    await input.fill('second queued task'); await input.press('Enter');
    await pane.locator('.chat-perm:not(.is-resolved) .chat-perm-btn').filter({ hasText: /^Allow$/ }).click();
    await expect.poll(() => requests().filter(r => r.method === 'turn/start').length).toBe(2);
    const sequence = requests().filter(r => r.method === 'turn/start' || r.method === 'thread/compact/start').map(r => r.method);
    expect(sequence).toEqual(['turn/start', 'thread/compact/start', 'turn/start']);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('older Codex compaction failures are visible and do not replace the conversation', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin, { FAKE_CODEX_NO_COMPACT: '1' });
  try {
    await chatReady(win);
    const before = await win.evaluate(() => TABS.get(activeTabId).chatState.sessionId);
    const result = await win.evaluate(() => window.husk.chat.compact({ tabId: activeTabId }));
    expect(result.ok).toBe(false); expect(result.code).toBe('unsupported');
    await expect(win.locator('.chat-pane.show')).toContainText('does not support compaction here');
    expect(await win.evaluate(() => TABS.get(activeTabId).chatState.sessionId)).toBe(before);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('context recovery starts a separate same-vendor conversation and ignores a closed warning target', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    const before = await win.evaluate(() => ({ id: activeTabId, sessionId: TABS.get(activeTabId).chatState.sessionId }));
    await win.evaluate(() => { const t = TABS.get(activeTabId); t.chat.apply({ type: 'usage', used: 122000, size: 128000 }); t.chat.flush(); window.HuskUsageBell.refresh(); });
    await win.locator('.toast:not(.is-out)').getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect.poll(() => win.evaluate(() => activeTabId)).not.toBe(before.id);
    await chatReady(win);
    await expect.poll(() => win.evaluate((oldId) => ({ oldExists: TABS.has(oldId), command: tabAgentCommand(TABS.get(activeTabId)), sessionId: TABS.get(activeTabId).chatState.sessionId }), before.id)).toEqual({ oldExists: true, command: 'codex', sessionId: 'thread-0001' });
    await win.evaluate(() => { const t = TABS.get(activeTabId); t.chat.apply({ type: 'usage', used: 122000, size: 128000 }); t.chat.flush(); window.HuskUsageBell.refresh(); });
    // A stale warning must never compact a different focused chat.
    const target = await win.evaluate(() => { const id = activeTabId; const t = TABS.get(id); TABS.delete(id); return { id, t: !!t }; });
    await win.locator('.toast:not(.is-out)').getByRole('button', { name: 'Compact conversation', exact: true }).click();
    expect(target.t).toBe(true);
    expect(await win.evaluate(() => [...TABS.values()].some(t => t.compactRequest))).toBe(false);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('switching vendor to one that reports no model prompts for a pick instead of keeping the old model', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin, { FAKE_ACP_NO_MODEL: '1' });
  try {
    await chatReady(win);
    const pane = win.locator('.chat-pane.show');
    // Codex names its own model in the chip.
    await expect(pane.locator('.chat-model-btn')).toHaveText('GPT Fake');
    // Give the thread a user turn so the switch carries history (the real path).
    await win.evaluate(() => window.husk.chat.allowAll({ tabId: activeTabId, on: true }));
    await pane.locator('.chat-input').fill('hello');
    await pane.locator('.chat-input').press('Enter');
    await expect(pane.locator('.chat-meta-line', { hasText: 'Done' })).toHaveCount(1);
    // Agent chip -> switch to gemini -> start fresh.
    await pane.locator('.chat-composer-meta .chat-context-btn').first().click();
    await win.locator('#chat-context-menu .cs-menu-item', { hasText: 'gemini' }).click();
    await win.locator('#chat-context-menu .cs-menu-item', { hasText: 'Start fresh' }).click();
    await chatReady(win);
    // gemini reports no current model, so the chip reads as a prompt, in red,
    // and never shows codex's gpt-fake.
    const chip = win.locator('.chat-pane.show .chat-model-btn');
    await expect(chip).toHaveText('Select model');
    await expect(chip).toHaveClass(/chat-model-btn--pick/);
    await expect(chip).not.toHaveText('GPT Fake');
    // Picking one clears the prompt.
    await chip.click();
    await win.locator('.chat-pane.show .chat-model-menu .chat-model-item', { hasText: 'Fake 1' }).click();
    await expect(chip).toHaveText('Fake 1');
    await expect(chip).not.toHaveClass(/chat-model-btn--pick/);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('a subagent fork rollout is not listed as its own session', async () => {
  const { homeDir, bin } = makeHome();
  const dir = path.join(homeDir, '.codex', 'sessions', '2026', '11', '17');
  fs.mkdirSync(dir, { recursive: true });
  const parentId = '01a1e9ff-5eba-7de0-98fa-b654abb25fb4';
  const forkId = '01a1ea00-619a-7602-ba9f-7ff91e060cb8';
  const prompt = 'look at claude id ea213ea9 transcript and continue from there';
  const write = (name, meta) => fs.writeFileSync(path.join(dir, name), [
    { type: 'session_meta', payload: { id: meta.id, session_id: parentId, cwd: REPO_ROOT, timestamp: meta.ts, ...meta.extra } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working on it' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  write(`rollout-2026-11-17T16-53-09-${parentId}.jsonl`, { id: parentId, ts: '2026-11-17T16:53:09Z', extra: { source: 'vscode' } });
  write(`rollout-2026-11-17T16-54-15-${forkId}.jsonl`, { id: forkId, ts: '2026-11-17T16:54:15Z', extra: { forked_from_id: parentId, parent_thread_id: parentId, source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } } });
  const { app, win } = await launch(homeDir, bin);
  try {
    await chatReady(win);
    const res = await win.evaluate(() => window.husk.sessions.list({ agent: 'codex' }));
    const ids = res.sessions.map((s) => s.id);
    expect(ids).toContain(parentId);
    expect(ids).not.toContain(forkId);
    expect(res.sessions.filter((s) => (s.firstMessage || '').startsWith('look at claude id')).length).toBe(1);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});
