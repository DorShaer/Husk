'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

test('bundles install only after review and blocked scans cannot install', async () => {
  const { packBundle } = require('../../src/lib/market-bundle');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-foundation-'));
  const config = path.join(home, '.config/husk'); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'aider', scannerPath: path.join(ROOT, 'test/fixtures/fake-scanner.js') }));
  const file = path.join(home, 'bundle.json');
  function bundle(id) {
    const packed = packBundle({ id, name: id, kind: 'skill', version: '1.0.0', publisher: 'Fixture', description: 'A sample skill', permissions: { runsCommands: false, networkHosts: [], fileAccess: 'read' } }, [{ path: 'SKILL.md', content: `---\nname: ${id}\ndescription: A sample skill\n---\nRead a project file.` }, { path: 'notes.txt', content: 'Supporting text' }]);
    fs.writeFileSync(file, packed.text);
  }
  bundle('reviewed-skill');
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', HUSK_FAKE_SCAN: 'clear' } });
  try {
    const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.husk?.foundation);
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await win.evaluate(() => { window.importResult = null; window.husk.foundation.importBundle().then((r) => { window.importResult = r; }); });
    const review = win.getByRole('dialog', { name: 'Review installation' });
    await expect(review).toContainText('Scan: clear');
    expect(fs.existsSync(path.join(home, '.agents/skills/reviewed-skill'))).toBe(false);
    await review.getByRole('button', { name: 'Install', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.importResult)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(home, '.agents/skills/reviewed-skill/notes.txt'), 'utf8')).toBe('Supporting text');
    await win.evaluate(() => openPrefs('foundation'));
    await win.locator('button.prefs-nav-item[data-prefs-section="foundation"]').click();
    await expect(win.locator('#pref-plan-status, #pref-licence-paste')).toHaveCount(0);
    expect(await win.evaluate(() => typeof window.husk.foundation.activate)).toBe('undefined');
    await expect(win.locator('#pref-bundle-name option')).toContainText(['reviewed-skill']);
    const exported = path.join(home, 'exported.json');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exported);
    await win.locator('#pref-bundle-export').click();
    await expect.poll(() => fs.existsSync(exported)).toBe(true);
    const packed = JSON.parse(fs.readFileSync(exported, 'utf8'));
    expect(packed.format).toBe('husk-bundle');
    expect(packed.files.find((f) => f.path === 'notes.txt').content).toBe('Supporting text');

    bundle('blocked-skill');
    await app.evaluate(() => { process.env.HUSK_FAKE_SCAN = 'block'; });
    await win.evaluate(() => { window.importResult = null; window.husk.foundation.importBundle().then((r) => { window.importResult = r; }); });
    await expect(review).toContainText('Scan: block');
    await expect(review.getByRole('button', { name: /Install/ })).toHaveCount(0);
    await review.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => win.evaluate(() => window.importResult)).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(home, '.agents/skills/blocked-skill'))).toBe(false);
    bundle('unscanned-skill');
    await win.evaluate(() => window.husk.foundation.removeScanner());
    await win.evaluate(() => { window.importResult = null; window.husk.foundation.importBundle().then((r) => { window.importResult = r; }); });
    await expect(review).toContainText('Unscanned: review required');
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => win.evaluate(() => window.importResult)).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(home, '.agents/skills/unscanned-skill'))).toBe(false);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
