'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const PKG = require('../../package.json');
const { topics } = require('../../src/lib/help-content');
const DOCUMENTATION_REFERENCE = 'https://github.com/DorShaer/Husk#readme';

test('all Help entry points open real content, public references work and browser failures are visible', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-help-'));
  fs.mkdirSync(path.join(home, '.config/husk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/husk/config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, welcomeVersion: 99, tourVersion: 99, lastSeenVersion: require('../../package.json').version, agentCommand: 'true', theme: 'light', accent: 'indigo', resumeLastOnLaunch: false }));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], env: { ...process.env, HOME: home, USERPROFILE: home, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1' } });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => window.HuskHelp && typeof cfg !== 'undefined' && cfg);
    await win.route('https://**', (route) => route.abort());
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    await app.evaluate(({ shell }) => { globalThis.helpOpened = []; shell.openExternal = async (url) => { globalThis.helpOpened.push(url); }; });
    fs.mkdirSync('/tmp/husk-help-audit', { recursive: true });
    for (const topic of ['documentation', 'shortcuts', 'troubleshooting']) {
      await win.locator('#btn-help').click();
      await win.locator('#btn-help-' + topic).click();
      await expect(win.getByRole('dialog', { name: topics[topic].title })).toBeVisible();
      await expect(win.locator('#help-dialog')).toContainText('Available offline');
      await expect(win.locator('#help-dialog h3')).not.toHaveCount(0);
      await win.waitForTimeout(100);
      const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(`/tmp/husk-help-audit/${topic}.png`, Buffer.from(png, 'base64'));
      await win.locator('#help-dialog').getByRole('button', { name: 'More documentation on GitHub' }).click();
      await win.keyboard.press('Escape');
      await expect(win.locator('#help-dialog')).toHaveCount(0);
    }
    expect(await app.evaluate(() => globalThis.helpOpened)).toEqual([DOCUMENTATION_REFERENCE, DOCUMENTATION_REFERENCE, DOCUMENTATION_REFERENCE]);
    for (const [label, topic] of [['Documentation', 'documentation'], ['Keyboard shortcuts', 'shortcuts'], ['Troubleshooting', 'troubleshooting']]) {
      await app.evaluate(({ Menu }, label) => {
        const help = Menu.getApplicationMenu().items.find((item) => item.label.replace('&', '') === 'Help');
        help.submenu.items.find((item) => item.label === label).click();
      }, label);
      await expect(win.getByRole('dialog', { name: topics[topic].title })).toBeVisible();
      await win.locator('#help-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    }
    await win.evaluate(() => openPrefs('about'));
    await expect(win.locator('#pref-about-version')).toContainText(PKG.version);
    const report = await win.evaluate(() => window.husk.feedback.url('bug'));
    expect(new URL(report.url).searchParams.get('body')).toContain('Husk ' + PKG.version);
    for (const topic of ['documentation', 'shortcuts', 'troubleshooting']) {
      await win.locator('#prefs-panel-about [data-help-topic="' + topic + '"]').click();
      await expect(win.getByRole('dialog', { name: topics[topic].title })).toBeVisible();
      await win.keyboard.press('Escape');
    }
    await app.evaluate(({ shell }) => { shell.openExternal = async () => { throw new Error('No browser handler'); }; });
    await win.evaluate(() => window.HuskHelp.open('documentation'));
    await win.locator('#help-dialog').getByRole('button', { name: 'More documentation on GitHub' }).click();
    await expect(win.locator('#toast-stack')).toContainText('No browser handler');
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('RPM update recovery installs a downloaded file without assuming a DNF repository', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-rpm-recovery-'));
  fs.mkdirSync(path.join(home, '.config/husk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/husk/config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, welcomeVersion: 99, tourVersion: 99, lastSeenVersion: PKG.version, agentCommand: 'true', resumeLastOnLaunch: false, theme: 'light', accent: 'indigo' }));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], env: { ...process.env, HOME: home, USERPROFILE: home, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1' } });
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => typeof cfg !== 'undefined' && cfg);
    await win.evaluate(() => {
      openPrefs('about');
      updateState = { status: 'error', phase: 'install', packageType: 'rpm', current: '2.14.0', version: '2.15.0', error: 'Authorization cancelled' };
      openUpdatePop();
    });
    await expect(win.locator('#up-manual-copy')).toBeVisible();
    await expect(win.locator('#up-body code')).toHaveText('sudo dnf install ./husk-v2.15.0-linux-x86_64.rpm');
    await expect(win.locator('#up-body')).toContainText('download folder');
    await expect(win.locator('#up-body')).not.toContainText('dnf upgrade husk');
    fs.mkdirSync('/tmp/husk-rpm-check', { recursive: true });
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.writeFileSync('/tmp/husk-rpm-check/update-recovery.png', Buffer.from(png, 'base64'));
    await win.evaluate(() => { updateState.version = 'invalid;command'; openUpdatePop(); });
    await expect(win.locator('#up-manual-copy')).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a new release marks the Help button, announces itself once, and opens the update card', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-help-update-'));
  fs.mkdirSync(path.join(home, '.config/husk'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/husk/config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, welcomeVersion: 99, tourVersion: 99, lastSeenVersion: PKG.version, agentCommand: 'true', theme: 'light', accent: 'indigo', resumeLastOnLaunch: false }));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], env: { ...process.env, HOME: home, USERPROFILE: home, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1' } });
  const send = (s) => app.evaluate(({ BrowserWindow }, st) => BrowserWindow.getAllWindows()[0].webContents.send('update:status', st), s);
  try {
    const win = await app.firstWindow();
    await win.waitForFunction(() => window.HuskHelp && typeof cfg !== 'undefined' && cfg);
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    await expect(win.locator('#help-update-dot')).toBeHidden();
    await send({ status: 'available', current: PKG.version, version: '99.0.0' });
    await expect(win.locator('#help-update-dot')).toBeVisible();
    await expect(win.locator('.toast', { hasText: 'Husk v99.0.0 is available.' })).toHaveCount(1);
    // The same release again does not announce twice; the badge stays.
    await send({ status: 'available', current: PKG.version, version: '99.0.0' });
    await win.waitForTimeout(300);
    await expect(win.locator('.toast', { hasText: 'Husk v99.0.0 is available.' })).toHaveCount(1);
    expect(JSON.parse(fs.readFileSync(path.join(home, '.config/husk/config.json'), 'utf8')).updateNotifiedVersion).toBe('99.0.0');
    await win.locator('#btn-help').click();
    await expect(win.locator('#btn-help-update')).toHaveText('Husk v99.0.0 is available');
    await win.locator('#btn-help-update').click();
    await expect(win.locator('#prefs-panel-about')).toBeVisible();
    await expect(win.locator('#update-pop')).toBeVisible();
    // Up to date clears the mark.
    await send({ status: 'up-to-date', current: PKG.version });
    await expect(win.locator('#help-update-dot')).toBeHidden();
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
