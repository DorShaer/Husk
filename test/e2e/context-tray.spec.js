'use strict';

// Files attached to a chat land in Husk's own data folder, list from there,
// and can be removed from there.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('the context tray lives in the Husk config folder', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-ctx-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, agentCommand: 'true', chatView: 'terminal' }));
  const src = path.join(homeDir, 'notes.txt');
  fs.writeFileSync(src, 'hello');

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    const ctxDir = path.join(cfgDir, 'context');

    const dropped = await win.evaluate((p) => window.husk.fs.dropFile({ sourcePath: p, kind: 'context' }), src);
    expect(dropped.ok).toBe(true);
    expect(dropped.dest).toBe(path.join(ctxDir, 'notes.txt'));
    expect(fs.readFileSync(dropped.dest, 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(homeDir, '.claude', 'MEMORY'))).toBe(false);

    const listed = await win.evaluate(() => window.husk.context.list());
    expect(listed.items.map((i) => i.path)).toEqual([dropped.dest]);

    const outside = await win.evaluate((p) => window.husk.context.remove(p), src);
    expect(outside.ok).toBe(false);
    expect(fs.existsSync(src)).toBe(true);

    const removed = await win.evaluate((p) => window.husk.context.remove(p), dropped.dest);
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(dropped.dest)).toBe(false);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
