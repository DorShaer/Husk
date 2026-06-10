'use strict';

// Regression: the plugin editor modal must render wide and left-aligned.
// The base .modal-card rule (460px, centered) used to win the cascade over
// .plugin-editor-card, squeezing the file list and editor into a sliver.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeIsolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  // Without firstRunDone, boot() blocks on the welcome wizard (no agent CLI
  // on CI runners) and its modal intercepts the edit-button click.
  fs.writeFileSync(path.join(dir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true }));
  const pluginsRoot = path.join(dir, '.claude', 'plugins');
  const installPath = path.join(pluginsRoot, 'cache', 'caveman');
  fs.mkdirSync(path.join(installPath, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(installPath, 'README.md'), '# caveman\n');
  fs.writeFileSync(path.join(installPath, 'skills', 'SKILL.md'), '# skill\nbody\n');
  fs.writeFileSync(path.join(pluginsRoot, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'caveman@local': [{ scope: 'user', version: '1.0.0', installPath, installedAt: new Date().toISOString() }],
    },
  }));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'caveman@local': true },
  }));
  return dir;
}

test('plugin editor modal opens wide with a usable file list and editor', async () => {
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
  await win.evaluate(() => setPage('plugins'));
  await win.waitForSelector('.plugin-row', { timeout: 10_000 });
  await win.click('.plugin-row [data-act="edit"]');
  await win.waitForSelector('.pe-file', { timeout: 10_000 });

  const layout = await win.evaluate(() => {
    const card = document.querySelector('.plugin-editor-card');
    const cs = getComputedStyle(card);
    return {
      cardWidth: Math.round(card.getBoundingClientRect().width),
      textAlign: cs.textAlign,
      filesWidth: Math.round(document.querySelector('.pe-files').getBoundingClientRect().width),
      editorWidth: Math.round(document.querySelector('.pe-content').getBoundingClientRect().width),
    };
  });
  // Wide layout, not the 460px centered base modal.
  expect(layout.cardWidth).toBeGreaterThanOrEqual(700);
  expect(layout.textAlign).toBe('left');
  expect(layout.filesWidth).toBeGreaterThanOrEqual(200);
  expect(layout.editorWidth).toBeGreaterThanOrEqual(400);

  // Selecting a file loads it into an enabled editor.
  await win.click('.pe-file');
  const editorState = await win.evaluate(() => {
    const ta = document.getElementById('pe-content');
    return { disabled: ta.disabled, hasContent: ta.value.length > 0 };
  });
  expect(editorState.disabled).toBe(false);
  expect(editorState.hasContent).toBe(true);

  await app.close();
});
