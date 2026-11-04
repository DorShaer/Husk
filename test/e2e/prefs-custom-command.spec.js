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
  if (config) fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2));
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

// The Agent > Command picker is a <select> plus a hidden free-text <input>.
// Choosing "Custom command…" must reveal the input so a user can type their own
// command (e.g. a work alias); choosing a listed command must hide it and feed
// its value to Save. A missing change handler left the dropdown inert.
test('selecting "Custom command…" reveals the free-text field; a listed command hides it and syncs', async () => {
  const app = await launch({ firstRunDone: true, skipWelcome: true, agentCommand: 'claude' });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

  // The picker is painted asynchronously at boot (it awaits agent detection).
  await win.waitForFunction(() => {
    const p = document.querySelector('#pref-agent-pick');
    return p && p.options.length >= 2
      && Array.from(p.options).some((o) => o.value === '__custom');
  }, null, { timeout: 15_000 });

  const r = await win.evaluate(() => {
    const pick = document.querySelector('#pref-agent-pick');
    const field = document.querySelector('#pref-agent');
    const fire = () => pick.dispatchEvent(new Event('change', { bubbles: true }));

    pick.value = '__custom';
    fire();
    const afterCustom = { hidden: field.hidden };

    // 'claude' is always an option (detected, or the stored value is unshifted).
    pick.value = 'claude';
    fire();
    const afterListed = { hidden: field.hidden, value: field.value };

    return { afterCustom, afterListed };
  });

  expect(r.afterCustom.hidden).toBe(false); // input visible for custom entry
  expect(r.afterListed.hidden).toBe(true);  // hidden again for a listed command
  expect(r.afterListed.value).toBe('claude'); // Save reads #pref-agent, so it must sync
  await app.close();
});
