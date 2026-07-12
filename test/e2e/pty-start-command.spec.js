'use strict';

// Resume-in-a-new-tab passes an explicit command to pty.start
// (for example "claude --resume <id>" or "copilot --resume=<id>").
// The pty:start IPC handler forwards that command to the spawned process.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

test('pty:start forwards a command override to the spawned process', async () => {
  const app = await launch();
  const win = await ready(app);
  const text = await win.evaluate(async () => {
    setPage('chat');
    const tab = createTab();
    activateTab(tab.id);
    // A unique marker the spawned command echoes, so we can confirm the
    // command (not the default agent) actually ran in this tab.
    await window.husk.pty.start({ cols: 80, rows: 24, command: 'printf HUSK_RESUME_OK_4242', sessionId: tab.id });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const buf = tab.term.buffer.active;
      let s = '';
      for (let y = 0; y < buf.length; y++) s += (buf.getLine(y)?.translateToString(true) || '');
      if (s.includes('HUSK_RESUME_OK_4242')) return s;
    }
    return '(marker not found)';
  });
  expect(text).toContain('HUSK_RESUME_OK_4242');
  await app.close();
});
