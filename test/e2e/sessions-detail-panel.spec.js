'use strict';

// Regression: opening a session detail panel must not be squeezed shut when
// the status panel is collapsed. The collapsed-status grid rule used to win
// the cascade over the detail-open rule, shrinking the third column to a 28px
// sliver so the detail panel rendered effectively hidden.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeIsolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const proj = path.join(dir, '.claude', 'projects', '-home-test-proj');
  fs.mkdirSync(proj, { recursive: true });
  // sessions:list skips user-only files as queue-operation receipts, so the
  // fixture needs an assistant turn to count as a real conversation.
  const lines = [
    JSON.stringify({ timestamp: new Date().toISOString(), cwd: '/home/test/proj', type: 'user', message: { content: 'hello world first message' } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant', message: { content: [{ type: 'text', text: 'hello back' }] } }),
  ];
  fs.writeFileSync(path.join(proj, '11111111-2222-3333-4444-555555555555.jsonl'), lines.join('\n') + '\n');
  return dir;
}

test('session detail panel stays full width when status panel is collapsed', async () => {
  const homeDir = makeIsolatedHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  // The trigger condition: status panel collapsed.
  await win.evaluate(() => { document.body.dataset.status = 'collapsed'; });
  await win.evaluate(() => setPage('sessions'));
  await win.waitForSelector('.session-row', { timeout: 10_000 });
  await win.click('.session-row');
  await win.waitForTimeout(400); // dp-in animation settles

  const info = await win.evaluate(() => {
    const panel = document.getElementById('detail-panel');
    const cs = getComputedStyle(panel);
    const rect = panel.getBoundingClientRect();
    return { display: cs.display, visibility: cs.visibility, width: Math.round(rect.width) };
  });
  expect(info.display).not.toBe('none');
  expect(info.visibility).toBe('visible');
  // Must be the real panel width, not the 28px collapsed-status sliver.
  expect(info.width).toBeGreaterThan(380);
  await app.close();
});
