'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron, expect } = require('@playwright/test');

async function main() {
  const folder = path.resolve(process.argv[2] || 'dist/linux-unpacked');
  const executablePath = path.join(folder, 'husk');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-package-'));
  const configDir = path.join(home, '.config', 'husk');
  const bin = path.join(home, 'bin');
  let app;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, lastSeenVersion: require('../package.json').version, paiEnabled: false, resumeLastOnLaunch: false, agentCommand: 'gemini', agentCwd: home, planUsageSource: 'cli' }));
    const fixture = path.resolve(__dirname, '../test/e2e/fixtures/fake-acp-agent.js');
    fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: path.join(home, '.copilot'), CODEX_HOME: path.join(home, '.codex'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' };
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete env[key];
    app = await electron.launch({ executablePath, args: ['--no-sandbox', ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : [])], env, timeout: 30000 });
    const win = await app.firstWindow();
    win.setDefaultTimeout(30000);
    const errors = [];
    win.on('pageerror', (err) => errors.push(err.message));
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.HuskThemes && window.husk?.foundation && document.querySelector('.chat-pane.show .chat-input'));
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((modal) => { modal.hidden = true; }));
    const meta = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }));
    assert.equal(meta.packaged, true);
    assert.equal(meta.version, require('../package.json').version);
    const themeCount = await win.evaluate(() => window.HuskThemes.THEMES.length);
    assert.equal(themeCount, require('../src/lib/themes').THEMES.length);
    assert.equal(await win.evaluate(() => typeof window.husk.foundation.importBundle), 'function');
    assert.equal(await win.evaluate(() => typeof window.husk.foundation.activate), 'undefined');
    const pane = win.locator('.chat-pane.show');
    await expect(pane.locator('.chat-input')).toBeEnabled();
    await pane.locator('.chat-input').fill('copilot: high context');
    await pane.locator('.chat-input').press('Enter');
    await expect(win.locator('#usage-bell')).toHaveAttribute('data-state', 'critical');
    await pane.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(pane).toContainText('Done, permission was');
    const image = path.join(home, 'background.png');
    const bytes = await win.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 60;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#2f465c'; ctx.fillRect(0, 0, 100, 60);
      return canvas.toDataURL().split(',')[1];
    });
    fs.writeFileSync(image, Buffer.from(bytes, 'base64'));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, image);
    const background = await win.evaluate(() => window.husk.background.choose());
    assert.equal(background.ok, true, background.error);
    await win.evaluate((result) => takeBackgroundResult(result), background);
    await expect(win.locator('#bg-layer')).toBeVisible();
    const transcripts = fs.readdirSync(path.join(configDir, 'transcripts'));
    assert.ok(transcripts.length > 0);
    assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ ...meta, themeCount, chat: 'passed', usage: 'passed', background: 'passed', transcripts: transcripts.length }) + '\n');
  } finally {
    try { if (app) await app.close(); }
    finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
}
main().catch((err) => { process.stderr.write(err.stack + '\n'); process.exitCode = 1; });
