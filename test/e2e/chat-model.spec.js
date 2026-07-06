'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('status panel shows the active model', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

  // A real cwd for the pty, and a matching claude session log carrying a model.
  const realCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-cwd-'));
  const encoded = realCwd.replace(/[/\\:]/g, '-');
  const projDir = path.join(homeDir, '.claude', 'projects', encoded);
  fs.mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: new Date().toISOString(), cwd: realCwd, type: 'user', message: { content: 'hi' } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hello' }] } }),
  ];
  fs.writeFileSync(path.join(projDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), lines.join('\n') + '\n');

  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  // Spawn a pty in the matching cwd so activePtyCwd is set, then read stats.
  await win.evaluate((cwd) => window.husk.pty.restart({ cols: 80, rows: 24, command: 'true', cwd }), realCwd);
  await win.waitForTimeout(300);

  const result = await win.evaluate(async () => {
    const s = await window.husk.stats.get();
    // Render the status panel from fresh stats.
    await refreshStats();
    refreshStatusline();
    const sp = document.getElementById('sp-content');
    const rows = Array.from(sp.querySelectorAll('.sp-row')).map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    const modelRow = rows.find((t) => t.startsWith('Model'));
    return { statModel: s.usage && s.usage.session && s.usage.session.model, modelRow };
  });
  expect(result.statModel).toBe('claude-opus-4-8');
  expect(result.modelRow).toContain('Opus 4.8');
  await app.close();
});
