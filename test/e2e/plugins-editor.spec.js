'use strict';

// The plugin editor modal renders wide and left-aligned so the file list and
// editor both have usable space.

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

function makeCopilotHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-copilot-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true, agentCommand: 'copilot' }));

  const installPath = path.join(dir, '.copilot', 'installed-plugins', 'copilot-plugins', 'spark');
  fs.mkdirSync(path.join(installPath, 'skills', 'spark-app-template'), { recursive: true });
  fs.writeFileSync(path.join(installPath, 'README.md'), '# spark\n');
  fs.writeFileSync(path.join(installPath, 'skills', 'spark-app-template', 'SKILL.md'), '# Spark\n');
  fs.writeFileSync(path.join(dir, '.copilot', 'config.json'), `// User settings belong in settings.json.
// This file is managed automatically.
{
  "installedPlugins": [
    {
      "name": "spark",
      "marketplace": "copilot-plugins",
      "version": "1.0.0",
      "installed_at": "2026-01-01T00:00:00.000Z",
      "cache_path": ${JSON.stringify(installPath)},
      "enabled": true
    }
  ]
}
`);
  fs.writeFileSync(path.join(dir, '.copilot', 'settings.json'), JSON.stringify({
    enabledPlugins: { 'spark@copilot-plugins': true },
  }));

  const marketplaceDir = path.join(dir, '.cache', 'copilot', 'marketplaces', 'github-copilot-plugins', '.github', 'plugin');
  fs.mkdirSync(marketplaceDir, { recursive: true });
  fs.writeFileSync(path.join(marketplaceDir, 'marketplace.json'), JSON.stringify({
    name: 'copilot-plugins',
    plugins: [
      { name: 'spark', version: '1.0.0', description: 'Spark plugin for GitHub Copilot.' },
      { name: 'advanced-security', version: '2.0.0', description: 'Advanced Security plugin for GitHub Copilot.' },
    ],
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

  // The header X closes, but dirty edits demand confirmation first.
  await win.fill('#pe-content', '# edited');
  await win.click('#pe-close-x');
  await win.waitForSelector('#confirm-modal:not([hidden])', { timeout: 5_000 });
  await win.click('#confirm-cancel');
  let state = await win.evaluate(() => document.getElementById('plugin-editor').hidden);
  expect(state).toBe(false); // stayed open after "Stay"
  await win.click('#pe-close-x');
  await win.waitForSelector('#confirm-modal:not([hidden])', { timeout: 5_000 });
  await win.click('#confirm-ok');
  await win.waitForSelector('#plugin-editor', { state: 'hidden', timeout: 5_000 });
  state = await win.evaluate(() => document.getElementById('plugin-editor').hidden);
  expect(state).toBe(true); // discarded and closed

  await app.close();
});

test('plugins page treats Copilot as plugin-capable', async () => {
  const homeDir = makeCopilotHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      COPILOT_HOME: path.join(homeDir, '.copilot'),
      COPILOT_CACHE_HOME: path.join(homeDir, '.cache', 'copilot'),
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.evaluate(() => setPage('plugins'));
  await win.waitForSelector('.plugin-row', { timeout: 10_000 });

  const state = await win.evaluate(() => ({
    unsupportedHidden: document.getElementById('plugins-unsupported').hidden,
    bodyHidden: document.getElementById('plugins-body').hidden,
    installedText: document.querySelector('.plugin-row')?.textContent || '',
    updateText: document.querySelector('.plugin-row [data-act="update"]')?.textContent || '',
    updateDisabled: document.querySelector('.plugin-row [data-act="update"]')?.disabled || false,
    toggleCount: document.querySelectorAll('.plugin-row .toggle').length,
    catalogText: document.getElementById('plugins-catalog')?.textContent || '',
  }));
  expect(state.unsupportedHidden).toBe(true);
  expect(state.bodyHidden).toBe(false);
  expect(state.installedText).toContain('spark');
  expect(state.installedText).toContain('latest v1.0.0');
  expect(state.updateText).toBe('Up to date');
  expect(state.updateDisabled).toBe(true);
  expect(state.toggleCount).toBe(0);
  expect(state.catalogText).toContain('advanced-security');

  await app.close();
});
