'use strict';

// The status panel context follows the focused chat tab. Each tab reports its
// own transcript and context count.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('status panel context follows the focused chat tab', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

  // Tab 1 cwd: a claude session log carrying a large context occupancy.
  const busyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-busy-'));
  const busyEnc = busyCwd.replace(/[/\\:]/g, '-');
  const busyProj = path.join(homeDir, '.claude', 'projects', busyEnc);
  fs.mkdirSync(busyProj, { recursive: true });
  const busyLog = path.join(busyProj, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  fs.writeFileSync(busyLog, [
    JSON.stringify({ timestamp: new Date().toISOString(), cwd: busyCwd, type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 400000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ].join('\n') + '\n');

  // Tab 2 runs in the SAME cwd as the busy tab (the real scenario: two chats
  // in one project). The fresh tab must report its own empty context, not
  // adopt the busy tab's transcript that lives in the same project dir.
  const freshCwd = busyCwd;

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  // Tab 1: run in the busy cwd, then bump the log mtime so the tab adopts it.
  await win.evaluate((cwd) => window.husk.pty.restart({ cols: 80, rows: 24, command: 'true', cwd }), busyCwd);
  fs.utimesSync(busyLog, new Date(), new Date());
  await win.waitForTimeout(400);
  const ctxBusy = await win.evaluate(async () => {
    await refreshStats();
    const s = await window.husk.stats.get();
    return s.usage && s.usage.session ? (s.usage.session.ctxTokens || 0) : 0;
  });
  expect(ctxBusy).toBeGreaterThan(300000);

  // Switch to a brand-new chat in the fresh cwd: context must drop to this
  // tab's own (zero), not stay on the busy tab's figure.
  await win.evaluate((cwd) => openNewChatTab({ command: 'true', cwd }), freshCwd);
  await win.waitForTimeout(400);
  const ctxFresh = await win.evaluate(async () => {
    const s = await window.husk.stats.get();
    return s.usage && s.usage.session ? (s.usage.session.ctxTokens || 0) : 0;
  });
  expect(ctxFresh).toBe(0);

  await app.close();
});
