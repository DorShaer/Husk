'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('Ctrl+R reloads non-chat pages but restarts Copilot chat without renderer reload', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-copilot-reload-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    agentCommand: 'copilot',
  }));
  fs.mkdirSync(path.join(homeDir, '.copilot', 'session-state'), { recursive: true });
  const binDir = path.join(homeDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const fakeCopilot = path.join(binDir, 'copilot');
  fs.writeFileSync(fakeCopilot, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
if (process.argv.includes('--version') || process.argv.includes('-v') || process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('1.0.69');
  process.exit(0);
}
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => process.exit(0));
const home = process.env.COPILOT_HOME || path.join(process.env.HOME, '.copilot');
const id = 'fake-' + process.pid + '-' + Date.now();
const dir = path.join(home, 'session-state', id);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'id: ' + id + '\\nname: Fake Copilot session\\ncwd: ' + process.cwd() + '\\ncreated_at: ' + new Date().toISOString() + '\\nupdated_at: ' + new Date().toISOString() + '\\n');
fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'user.message', data: { content: 'fake start' } }) + '\\n');
process.stdout.write('fake copilot ready\\n');
setInterval(() => {}, 1000);
`);
  fs.chmodSync(fakeCopilot, 0o755);

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', COPILOT_HOME: path.join(homeDir, '.copilot') },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  await win.waitForFunction(async () => {
    const live = await window.husk.pty.list();
    return live && live.ok && live.sessions.length === 1;
  }, null, { timeout: 10_000 });
  await expect.poll(
    () => fs.readdirSync(path.join(homeDir, '.copilot', 'session-state')).length,
    { timeout: 10_000 },
  ).toBe(1);
  const beforeDirs = fs.readdirSync(path.join(homeDir, '.copilot', 'session-state')).sort();

  await win.evaluate(() => setPage('mcp'));
  await win.bringToFront();
  await win.click('body');
  await win.keyboard.press('Control+R');
  await win.waitForFunction(() => document.body && document.body.dataset.page === 'mcp', null, { timeout: 10_000 });
  await win.waitForTimeout(500);

  const result = await win.evaluate(async () => {
    const live = await window.husk.pty.list();
    return {
      page: document.body.dataset.page,
      liveSessions: live && live.ok ? live.sessions.length : -1,
      tabs: TABS.size,
    };
  });
  expect(result.page).toBe('mcp');
  expect(result.liveSessions).toBe(1);
  expect(result.tabs).toBe(1);
  const dirs = fs.readdirSync(path.join(homeDir, '.copilot', 'session-state')).sort();
  expect(dirs).toEqual(beforeDirs);

  await win.evaluate(() => {
    setPage('chat');
    window.__huskNoReloadSentinel = 'chat-before';
  });
  await win.waitForTimeout(900);
  await win.bringToFront();
  await win.click('body');
  await win.keyboard.press('Control+R');
  await expect.poll(
    () => fs.readdirSync(path.join(homeDir, '.copilot', 'session-state')).length,
    { timeout: 10_000 },
  ).toBe(2);

  const afterRestart = await win.evaluate(async () => {
    const live = await window.husk.pty.list();
    return {
      page: document.body.dataset.page,
      sentinel: window.__huskNoReloadSentinel,
      liveSessions: live && live.ok ? live.sessions.length : -1,
      tabs: TABS.size,
    };
  });
  expect(afterRestart.page).toBe('chat');
  expect(afterRestart.sentinel).toBe('chat-before');
  expect(afterRestart.liveSessions).toBe(1);
  expect(afterRestart.tabs).toBe(1);
  await win.evaluate(async () => {
    const live = await window.husk.pty.list();
    if (live && live.ok) {
      for (const s of live.sessions) await window.husk.pty.close(s.sessionId);
    }
  });
  await app.close();
});
