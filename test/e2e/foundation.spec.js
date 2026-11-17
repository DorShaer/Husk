'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

test('clean installs pass, blocked scans cannot install, and sharing is out of this build', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-foundation-'));
  const config = path.join(home, '.config/husk'); fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'aider', scannerPath: path.join(ROOT, 'test/fixtures/fake-scanner.js') }));
  const repo = (id) => {
    const root = path.join(home, `repo-${id}`);
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'agents', `${id}.md`), `---\nname: ${id}\ndescription: A sample agent\n---\nRead a project file.`);
    return root;
  };
  const installed = (id) => fs.existsSync(path.join(home, '.claude/agents', `${id}.md`));
  const app = await electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1', HUSK_FAKE_SCAN: 'clear' } });
  const install = (id) => win.evaluate(([root, id]) => { window.installResult = null; window.husk.repoAgents.install({ root, picks: [{ filename: `${id}.md` }] }).then((r) => { window.installResult = r; }); }, [repo(id), id]);
  let win;
  try {
    win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => window.husk?.foundation);
    await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    const review = win.getByRole('dialog', { name: 'Security check' });

    await install('reviewed-agent');
    await expect.poll(() => win.evaluate(() => window.installResult)).toMatchObject({ ok: true });
    await expect(review).toHaveCount(0);
    expect(installed('reviewed-agent')).toBe(true);

    await app.evaluate(() => { process.env.HUSK_FAKE_SCAN = 'block'; });
    await install('blocked-agent');
    await expect(review).toContainText("Husk's security scanner blocked this agent");
    await expect(review.getByRole('button', { name: 'Use it anyway' })).toHaveCount(0);
    await review.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => win.evaluate(() => window.installResult)).toMatchObject({ ok: false });
    expect(installed('blocked-agent')).toBe(false);

    await win.evaluate(() => window.husk.foundation.removeScanner());
    await install('unscanned-agent');
    await expect(review).toContainText("Not checked: connect Husk's security scanner in Preferences.");
    await review.getByRole('button', { name: "Don't use it" }).click();
    await expect.poll(() => win.evaluate(() => window.installResult)).toMatchObject({ ok: false });
    expect(installed('unscanned-agent')).toBe(false);

    await win.evaluate(() => openPrefs());
    await expect(win.locator('button.prefs-nav-item[data-prefs-section="foundation"]')).toHaveCount(0);
    await expect(win.locator('#pref-scanner-choose')).toHaveCount(0);
    await expect(win.locator('#pref-bundle-import, #pref-bundle-export, #pref-plan-status, #pref-licence-paste')).toHaveCount(0);
    await expect(win.locator('.prefs-nav-item', { hasText: 'Sharing' })).toHaveCount(0);
    expect(await win.evaluate(() => typeof window.husk.foundation.activate)).toBe('undefined');
    const channels = await win.evaluate(() => Promise.all([
      window.husk.foundation.importBundle(), window.husk.foundation.bundleItems('skill'), window.husk.foundation.exportBundle({ kind: 'skill', id: 'x' }),
    ].map((p) => p.then(() => 'answered', () => 'unregistered'))));
    expect(channels).toEqual(['unregistered', 'unregistered', 'unregistered']);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
