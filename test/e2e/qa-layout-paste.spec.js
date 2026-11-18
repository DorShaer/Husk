'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

test('large pastes stay compact and narrow chat keeps room to work', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-layout-paste-'));
  fs.mkdirSync(path.join(home, '.config/husk'), { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${ROOT}/test/e2e/fixtures/fake-acp-agent.js" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.config/husk/config.json'), JSON.stringify({ firstRunDone: true, welcomeVersion: 99, tourVersion: 99, lastSeenVersion: '9.9.9', agentCommand: 'gemini', agentCwd: home, theme: 'light', accent: 'indigo', statusCollapsed: false, sessionsCollapsed: false }));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, HUSK_E2E: '1', HUSK_FAKE_ACP_PROMPTS: path.join(home, 'prompts.jsonl'), ELECTRON_DISABLE_SANDBOX: '1' } });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => { const i = document.querySelector('.chat-pane.show .chat-input'); return i && !i.disabled && !/Starting/.test(i.placeholder); });
    const timings = await win.evaluate(() => {
      const input = document.querySelector('.chat-pane.show .chat-input');
      const dt = new DataTransfer(); dt.setData('text/plain', 'X'.repeat(120000) + ' END');
      const start = performance.now();
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return { ms: performance.now() - start, value: input.value.length };
    });
    expect(timings.value).toBe(0);
    expect(timings.ms).toBeLessThan(100);
    await expect(win.locator('.chat-pane.show .chat-text-attachment')).toContainText('120,004');
    await win.locator('.chat-pane.show .chat-input').press('Enter');
    await expect(win.locator('.chat-pane.show .chat-user-more')).toBeVisible();
    await expect.poll(() => fs.existsSync(path.join(home, 'prompts.jsonl')) && fs.readFileSync(path.join(home, 'prompts.jsonl'), 'utf8').includes('END')).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'prompts.jsonl'), 'utf8').trim()).text).toContain('X'.repeat(120000) + ' END');
    expect(await win.locator('.chat-pane.show .chat-user-text').evaluate((e) => e.textContent.length)).toBeLessThan(2500);
    console.log('paste handler ms', timings.ms);
    for (const theme of ['light', 'midnight']) {
      await win.evaluate((theme) => { applyTheme(theme); }, theme);
      for (const [w, h] of [[1024, 640], [1280, 720], [1440, 900], [1920, 1080]]) {
        await app.evaluate(({ BrowserWindow }, { w, h }) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), { w, h });
        const width = await win.locator('.chat-pane.show .chat-input').evaluate((e) => e.getBoundingClientRect().width);
        expect(width).toBeGreaterThan(300);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
        fs.mkdirSync('/tmp/husk-recovery-layout', { recursive: true });
        fs.writeFileSync(`/tmp/husk-recovery-layout/${theme}-${w}.png`, Buffer.from(png, 'base64'));
      }
    }
    for (const level of [-2, 3]) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640));
      await win.evaluate((level) => { const ui = window.husk.ui; ui.zoomSet(ui.zoomBase + level * ui.zoomStep); }, level);
      await win.waitForTimeout(150);
      const bounds = await win.evaluate(() => ({ top: document.querySelector('#tab-strip').getBoundingClientRect().top, bottom: document.querySelector('#topbar').getBoundingClientRect().bottom }));
      expect(bounds.top).toBeGreaterThanOrEqual(bounds.bottom - 1);
      expect(await win.locator('.chat-pane.show .chat-input').evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(200);
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(`/tmp/husk-recovery-layout/zoom-${level}.png`, Buffer.from(png, 'base64'));
    }
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('running workflow cards report activity and the next workflow can queue', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-workflow-queue-'));
  const dir = path.join(home, '.config/husk'); fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Claude 1.0"; exit 0; fi\nsleep 3\necho \'{"type":"result","subtype":"success","result":"done"}\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, welcomeVersion: 99, tourVersion: 99, lastSeenVersion: '9.9.9', agentCommand: 'claude', agentCwd: home, theme: 'light' }));
  fs.writeFileSync(path.join(dir, 'workflows.json'), JSON.stringify(['a', 'b'].map((id) => ({ id, name: `Workflow ${id}`, trigger: 'manual', graph: { nodes: [{ id: 'n1', name: 'Check', prompt: 'Check the folder', agentCommand: 'claude', x: 0, y: 0 }], edges: [] } }))));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1' } });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof setPage === 'function' && typeof runWorkflow === 'function');
    await win.evaluate(async () => { setPage('workflows'); await renderWorkflows(); });
    const starting = win.evaluate(() => runWorkflow('a'));
    const gate = win.getByRole('button', { name: 'Use it anyway', exact: true });
    if (await gate.isVisible().catch(() => false)) await gate.click();
    await starting;
    await win.evaluate(() => { wfShowView('list'); paintWorkflowList(); });
    await expect(win.locator('.wf-card[data-id="a"] .wf-card-when')).toContainText('Running');
    const queueing = win.evaluate(() => runWorkflow('b'));
    await win.getByRole('button', { name: 'Queue after current', exact: true }).click();
    await queueing;
    await expect(win.locator('#confirm-modal')).toBeHidden();
    await win.waitForTimeout(150);
    await expect(win.locator('.wf-card[data-id="b"] .wf-card-when')).toContainText('Queued');
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.mkdirSync('/tmp/husk-recovery-layout', { recursive: true });
    fs.writeFileSync('/tmp/husk-recovery-layout/workflow-queue.png', Buffer.from(png, 'base64'));
    await win.reload();
    await win.waitForFunction(() => window.husk && window.husk.workflows);
    await expect.poll(async () => {
      const r = await win.evaluate(() => window.husk.workflows.runs());
      return (r.runs || []).filter((r) => r.workflowId === 'b').length;
    }, { timeout: 30000 }).toBe(1);
    await win.evaluate(async () => { setPage('workflows'); await renderWorkflows(); await runWorkflow('a'); });
    const late = win.evaluate(() => runWorkflow('b'));
    await expect(win.getByRole('button', { name: 'Queue after current', exact: true })).toBeVisible();
    await expect.poll(async () => {
      const r = await win.evaluate(() => window.husk.workflows.activeRun());
      return r.run;
    }, { timeout: 15000 }).toBeNull();
    await win.getByRole('button', { name: 'Queue after current', exact: true }).click();
    await late;
    await expect.poll(async () => {
      const r = await win.evaluate(() => window.husk.workflows.runs());
      return (r.runs || []).filter((r) => r.workflowId === 'b').length;
    }, { timeout: 30000 }).toBe(2);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('large drafts survive history and reload, and editing cannot leak a text attachment', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-draft-history-'));
  const configDir = path.join(home, '.config/husk'); fs.mkdirSync(configDir, { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${ROOT}/test/e2e/fixtures/fake-acp-agent.js" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ firstRunDone: true, welcomeVersion: 99, tourVersion: 99, lastSeenVersion: '9.9.9', agentCommand: 'gemini', agentCwd: home, theme: 'light', accent: 'indigo' }));
  const prompts = path.join(home, 'prompts.jsonl');
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, HUSK_E2E: '1', HUSK_FAKE_ACP_PROMPTS: prompts, ELECTRON_DISABLE_SANDBOX: '1' } });
  try {
    const win = await app.firstWindow();
    const pane = win.locator('.chat-pane.show');
    const input = pane.locator('.chat-input');
    await win.waitForFunction(() => { const i = document.querySelector('.chat-pane.show .chat-input'); return i && !i.disabled && !/Starting/.test(i.placeholder); });
    await input.fill('earlier short prompt'); await input.press('Enter');
    await pane.locator('.chat-perm-btn', { hasText: 'Allow once' }).click();
    await expect(pane.locator('.chat-meta-line')).toContainText('Done');
    await expect(pane.locator('.chat-stop')).toBeHidden();
    const draft = 'L'.repeat(18000);
    await win.evaluate((text) => {
      const input = document.querySelector('.chat-pane.show .chat-input');
      const data = new DataTransfer(); data.setData('text/plain', text);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, draft);
    await input.fill(' suffix'); await input.press('Home'); await input.press('ArrowUp');
    await expect(input).toHaveValue('earlier short prompt');
    await expect(pane.locator('.chat-text-attachment')).toHaveCount(0);
    await win.evaluate(() => reloadRendererPreservingPlace());
    await expect(input).toHaveValue('earlier short prompt');
    await input.press('ArrowDown');
    expect(await win.evaluate(() => { const s = TABS.get(activeTabId).chat.captureUi(); return s.pendingText + s.draft; })).toBe(draft + ' suffix');
    await input.press('ArrowUp'); await input.press('Enter');
    await expect.poll(() => fs.readFileSync(prompts, 'utf8').trim().split('\n').length).toBe(2);
    expect(require('../../src/lib/brain').withoutContext(JSON.parse(fs.readFileSync(prompts, 'utf8').trim().split('\n')[1]).text).trim()).toBe('earlier short prompt');
    await pane.locator('.chat-perm-btn', { hasText: 'Allow once' }).click();
    await expect(pane.locator('.chat-stop')).toBeHidden();
    await expect(pane.locator('.chat-meta-line').last()).toContainText('Done');
    await win.evaluate((text) => TABS.get(activeTabId).chat.send(text), draft);
    await pane.locator('.chat-perm-btn', { hasText: 'Allow once' }).click();
    await expect(pane.locator('.chat-stop')).toBeHidden();
    await expect(pane.locator('.chat-meta-line').last()).toContainText('Done');
    await pane.locator('.chat-act-rerun').last().click();
    await expect(pane.locator('.chat-text-attachment')).toBeVisible();
    await win.evaluate(() => reloadRendererPreservingPlace());
    await expect(pane.locator('.chat-edit-note')).toBeVisible();
    await win.waitForTimeout(150);
    const editPng = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.writeFileSync('/tmp/husk-draft-edit-reload.png', Buffer.from(editPng, 'base64'));
    await pane.locator('.chat-edit-cancel').click();
    await expect(pane.locator('.chat-text-attachment')).toHaveCount(0);
    await expect(input).toHaveValue('');
    const recovered = await win.evaluate(({ draft }) => {
      const chat = TABS.get(activeTabId).chat;
      chat.setRunning(true); chat.send('queued-' + draft);
      const input = document.querySelector('.chat-pane.show .chat-input');
      const data = new DataTransfer(); data.setData('text/plain', draft);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      chat.setExited(true);
      const saved = chat.captureUi(); return saved.pendingText + saved.draft;
    }, { draft });
    expect(recovered).toBe('queued-' + draft + '\n' + draft);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
