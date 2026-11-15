'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

test('themes and the picked background render through the stored image scheme', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-appearance-'));
  const bin = path.join(home, 'bin');
  const config = path.join(home, '.config/husk');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'gemini' }));
  fs.writeFileSync(path.join(bin, 'gemini'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test/e2e/fixtures/fake-acp-agent.js')}" "$@"\n`, { mode: 0o755 });
  const image = path.join(home, 'picked.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXeUAAAAASUVORK5CYII=', 'base64'));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' } });
  try {
    const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.HuskThemes && document.querySelector('.chat-pane.show .chat-input'));
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    const validImage = await win.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; const x = c.getContext('2d'); x.fillStyle = '#3377aa'; x.fillRect(0, 0, 200, 100); return c.toDataURL('image/png').split(',')[1]; });
    fs.writeFileSync(image, Buffer.from(validImage, 'base64'));
    await app.evaluate(({ dialog }, image) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] }); }, image);
    const result = await win.evaluate(() => window.husk.background.choose());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.background.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(image);
    await win.evaluate((r) => takeBackgroundResult(r), result);
    await expect(win.locator('#bg-layer')).toBeVisible();
    expect(await win.locator('#bg-layer-image').evaluate((el) => el.style.backgroundImage)).toContain('husk-bg://image/');
    const response = await win.evaluate(async (bg) => {
      const image = new Image();
      return new Promise((resolve) => { image.onload = () => resolve(image.naturalWidth); image.onerror = () => resolve(0); image.src = `husk-bg://image/${bg.hash}.${bg.ext}`; });
    }, result.background);
    expect(response).toBe(200);
    await win.evaluate(() => window.husk.ui.zoomSet(0));
    fs.mkdirSync('/tmp/husk-review', { recursive: true });
    for (const theme of ['solarized-light', 'kanagawa', 'hc-dark']) {
      await win.evaluate(async (theme) => { cfg = await window.husk.config.set({ theme }); setPage('chat'); applyTheme(theme); }, theme);
      await win.screenshot({ path: `/tmp/husk-review/${theme}-chat.png` });
      await win.evaluate(() => openPrefs('appearance'));
      await win.screenshot({ path: `/tmp/husk-review/${theme}-prefs.png` });
    }
    const stored = fs.readdirSync(path.join(config, 'backgrounds'));
    expect(stored).toHaveLength(1);
    await win.evaluate(() => window.husk.background.remove());
    expect(fs.readdirSync(path.join(config, 'backgrounds'))).toHaveLength(0);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
