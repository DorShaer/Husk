'use strict';

// Closing a chat tab must free its pane, listeners and all. The pane registers
// a document-level click listener and a ResizeObserver; if destroy() leaves
// them behind, every chat opened in a session piles up its whole closure until
// the next reload. This opens and closes many chats and checks the net count of
// document click listeners does not climb with them.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');

test('closing chat tabs frees their document listeners', async () => {
  test.setTimeout(90_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-teardown-'));
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
  }));
  const bin = path.join(homeDir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  // Count document click listeners by wrapping add/removeEventListener before
  // the app script runs.
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.addInitScript(() => {
    window.__clickListeners = 0;
    const add = document.addEventListener.bind(document);
    const rem = document.removeEventListener.bind(document);
    document.addEventListener = function (type, ...rest) { if (type === 'click') window.__clickListeners++; return add(type, ...rest); };
    document.removeEventListener = function (type, ...rest) { if (type === 'click') window.__clickListeners--; return rem(type, ...rest); };
  });
  // The init script must be in place before the document loads; reload once so
  // it applies to the real app boot.
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForFunction(() => { const i = document.querySelector('.chat-pane.show .chat-input'); return i && !i.disabled && !/Starting/.test(i.placeholder); }, null, { timeout: 30_000 });

  const baseline = await win.evaluate(() => window.__clickListeners);

  // Open and close several chat tabs.
  for (let i = 0; i < 6; i++) {
    const id = await win.evaluate(async () => { const t = await openNewChatTab({}); return t.id; }); // eslint-disable-line no-undef
    await win.waitForTimeout(300);
    await win.evaluate((tid) => closeTab(tid), id); // eslint-disable-line no-undef
    await win.waitForTimeout(200);
  }

  const after = await win.evaluate(() => window.__clickListeners);
  // Each opened-then-closed pane that leaks adds one permanent click listener.
  // A clean teardown returns to the baseline (allow a slop of 1 for timing).
  expect(after - baseline, `document click listeners grew by ${after - baseline} over 6 open/close cycles`).toBeLessThanOrEqual(1);

  await app.close();
});
