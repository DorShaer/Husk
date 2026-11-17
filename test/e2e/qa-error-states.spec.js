'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

async function launch(installed = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-errors-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  if (installed) {
    for (const name of ['claude', 'codex']) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures/fake-claude-stream.js')}" "$@"\n`, { mode: 0o755 });
    }
  }
  fs.mkdirSync(path.join(home, '.config/husk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/husk/config.json'), JSON.stringify({
    firstRunDone: true, welcomeVersion: 2, tourVersion: 2, lastSeenVersion: '9.9.9',
    theme: 'light', accent: 'indigo', skipWelcome: true, agentCommand: 'claude', agentCwd: home, connectedClis: ['claude', 'codex'],
    workflows: [{ id: 'scheduled-work', name: 'Scheduled work', graph: { nodes: [], edges: [] } }],
  }));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1' } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return { app, win, home };
}
async function close({ app, home }) { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
async function shot(app, name) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return (await window.capturePage()).toPNG().toString('base64');
  });
  fs.writeFileSync(`/tmp/husk-errors-${name}.png`, Buffer.from(b64, 'base64'));
}

test('missing CLI gives recovery actions and retains the draft without a running reply', async () => {
  const env = await launch(false);
  try {
    const { win } = env;
    await expect(win.locator('.chat-missing-cli')).toBeVisible();
    await expect(win.locator('.chat-missing-cli')).toContainText('Claude Code is not installed');
    await expect(win.locator('.chat-missing-install')).toBeVisible();
    await expect(win.locator('.chat-missing-other')).toBeVisible();
    const input = win.locator('.chat-pane.show .chat-input');
    await input.fill('Keep my unsent question');
    await input.press('Enter');
    await expect(input).toHaveValue('Keep my unsent question');
    expect(await win.evaluate(() => !!TABS.get(activeTabId).chatRunning)).toBe(false);
    await shot(env.app, 'missing-cli');
  } finally { await close(env); }
});

test('routing is seeded, missing MCP is actionable, and workflow deletion protects schedules', async () => {
  const env = await launch();
  try {
    const { win } = env;
    const config = await win.evaluate(() => window.husk.config.get());
    expect(config.taskRouting.smart.vendor).toBe('claude');
    expect(config.taskRouting.cheap.vendor).toBe('claude');
    await win.evaluate(() => window.husk.mcp.add({ id: 'missing-tool', transport: 'stdio', command: 'husk-nonexistent-mcp-qa', args: [] }));
    await win.evaluate(() => setPage('mcp'));
    await expect(win.locator('.mcp-row[data-id="missing-tool"]')).toContainText('Command not found: husk-nonexistent-mcp-qa');
    await expect(win.locator('.mcp-row[data-id="missing-tool"] [data-edit]')).toBeVisible();
    await expect(win.locator('.mcp-row[data-id="missing-tool"] [data-toggle]')).not.toHaveClass(/on/);
    await shot(env.app, 'missing-mcp');
    const schedule = await win.evaluate(() => window.husk.schedules.save({ name: 'Scheduled check', target: 'workflow', targetId: 'scheduled-work', kind: 'every', everyMinutes: 60, enabled: true }));
    expect(schedule.ok).toBe(true);
    const refused = await win.evaluate(() => window.husk.workflows.delete('scheduled-work'));
    expect(refused.needsScheduleChoice).toBe(true);
    expect((await win.evaluate(() => window.husk.workflows.delete({ id: 'scheduled-work', scheduleAction: 'pause' }))).ok).toBe(true);
    const rows = await win.evaluate(() => window.husk.schedules.list());
    expect(rows.schedules[0]).toMatchObject({ enabled: false, broken: true, nextRunAt: null });
    await win.evaluate((schedules) => window.husk.config.set({ schedules: schedules.map((s) => ({ ...s, enabled: true })) }), rows.schedules);
    await win.evaluate(() => setPage('schedule'));
    await expect(win.locator('.sch-row[data-id]')).toContainText('Needs a workflow');
    await expect(win.locator('.sch-row[data-id]')).toContainText('Choose workflow');
    await expect(win.locator('#sch-sub')).toContainText('0 active');
    await expect(win.locator('.sch-row[data-id] [data-act=run]')).toBeDisabled();
    await shot(env.app, 'broken-schedule');
    expect((await win.evaluate(() => window.husk.registry.list())).registries).toEqual([]);
    await win.evaluate(() => setPage('workflows'));
    await win.locator('#btn-wf-market').click();
    await expect(win.locator('#wfm-state')).toContainText('No workflow catalog connected');
    await shot(env.app, 'marketplace-empty');
    await win.evaluate(() => setPage('prefs'));
    await expect(win.locator('#pref-save')).toHaveText('Save connection');
    await expect(win.locator('#pref-scanner-remove')).toBeHidden();
  } finally { await close(env); }
});
