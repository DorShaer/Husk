'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-prefcmd-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  const binDir = path.join(homeDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(REPO_ROOT, 'test/e2e/fixtures/fake-acp-agent.js')}" "$@"\n`, { mode: 0o755 });
  if (config) fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2));
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

test('settings group CLI defaults with startup and keep connection settings separate', async () => {
  const app = await launch({ firstRunDone: true, skipWelcome: true, lastSeenVersion: require('../../package.json').version, welcomeVersion: 99, tourVersion: 99, agentCommand: 'true', theme: 'light', accent: 'indigo' });
  const home = await app.evaluate(() => process.env.HOME);
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof cfg !== 'undefined' && cfg && document.querySelector('#pref-resume-last'));
    await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); openPrefs(); });
    await expect(win.locator('.prefs-nav-item')).toHaveCount(6);
    await expect(win.locator('#pref-agent, #pref-agent-pick, #pref-agent-cwd, #pref-scanner-choose, [data-prefs-section="behavior"]')).toHaveCount(0);
    await expect(win.getByRole('heading', { name: 'Make room for your work' })).toBeVisible();
    await expect(win.locator('#pref-default-cli')).toHaveValue('true');
    await win.locator('#pref-default-cli').selectOption('gemini');
    await expect.poll(() => win.evaluate(async () => (await window.husk.config.get()).agentCommand)).toBe('gemini');
    await win.locator('#pref-default-cli').selectOption('true');
    await expect.poll(() => win.evaluate(async () => (await window.husk.config.get()).agentCommand)).toBe('true');
    await win.locator('#pref-resume-last').uncheck();
    await expect.poll(() => win.evaluate(async () => (await window.husk.config.get()).resumeLastOnLaunch)).toBe(false);
    await win.locator('#prefs-search').fill('retention');
    await expect(win.locator('#pref-transcript-days')).toBeVisible();
    await expect(win.locator('#pref-theme')).toBeHidden();
    await win.locator('#prefs-search').fill('no-such-setting');
    await expect(win.locator('#prefs-empty')).toBeVisible();
    await win.locator('#prefs-search').fill('');
    await win.locator('#prefs-nav-connections').click();
    await expect(win.getByRole('heading', { name: 'Bring your own key' })).toBeVisible();
    await expect(win.locator('#pref-agent-model')).toBeHidden();
    await win.locator('#pref-agent-vendor').selectOption('openai');
    await expect(win.locator('#pref-agent-model')).toBeVisible();
    await win.locator('#pref-agent-base-url').fill('file:///tmp/no');
    await win.locator('#pref-save').click();
    await expect(win.locator('#pref-connection-error')).toBeVisible();
    await win.locator('#pref-agent-base-url').fill('http://127.0.0.1:4000/v1');
    await win.locator('#pref-agent-model').fill('test-model');
    await win.locator('#pref-save').click();
    await expect.poll(() => win.evaluate(async () => (await window.husk.config.get()).agentBaseUrl)).toBe('http://127.0.0.1:4000/v1');
    expect(await win.evaluate(async () => (await window.husk.config.get()).agentCommand)).toBe('true');
    await win.locator('#pref-job-models').click();
    await expect(win.locator('#aut-orch-modal')).toBeVisible();
    await win.locator('#aut-orch-close').click();
    await win.evaluate(() => document.querySelector('#toast-stack')?.replaceChildren());
    fs.mkdirSync('/tmp/husk-settings-redesign', { recursive: true });
    for (const theme of ['light', 'midnight']) {
      await win.evaluate((t) => applyTheme(t), theme);
      for (const section of ['workspace', 'appearance', 'voice', 'usage', 'connections', 'about']) {
        await win.locator('#prefs-nav-' + section).click();
        await win.waitForTimeout(100);
        const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
        fs.writeFileSync(`/tmp/husk-settings-redesign/${theme}-${section}.png`, Buffer.from(data, 'base64'));
      }
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640));
    await win.locator('#prefs-nav-workspace').click();
    await win.waitForTimeout(100);
    expect(await win.locator('.prefs-content').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.writeFileSync('/tmp/husk-settings-redesign/narrow.png', Buffer.from(png, 'base64'));
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

// Bring-your-own-key: a custom endpoint and API key stored in config load back
// into the Agent prefs fields, so the user can see and edit them.
test('custom endpoint and API key round-trip through Connections', async () => {
  const app = await launch({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
    agentBaseUrl: 'http://localhost:4000', agentApiKey: 'sk-test-123',
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  // bindPrefs populates the fields once the boot config load lands.
  await win.waitForFunction(() => {
    const b = document.querySelector('#pref-agent-base-url');
    return b && b.value === 'http://localhost:4000';
  }, null, { timeout: 15_000 });
  const vals = await win.evaluate(() => ({
    base: document.querySelector('#pref-agent-base-url').value,
    key: document.querySelector('#pref-agent-api-key').value,
    keyType: document.querySelector('#pref-agent-api-key').type,
  }));
  expect(vals.base).toBe('http://localhost:4000');
  expect(vals.key).toBe('sk-test-123');
  expect(vals.keyType).toBe('password'); // key field is masked
  await app.close();
});
