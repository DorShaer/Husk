'use strict';

// What someone meets first: a setup that says what Install will run, no
// changelog for a person with nothing to compare it to, a trust notice in
// plain words, an empty chat that offers a first move, a size control with a
// name, and a rail that does not open as a wall.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');

function makeHome(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-first-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  if (config) fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify(config));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  // An npm that only records being called: nothing here may install anything.
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$@" >> "${path.join(homeDir, 'npm-calls.log')}"\n`);
  fs.chmodSync(path.join(bin, 'npm'), 0o755);
  return { homeDir, bin };
}

async function launch({ homeDir, bin }) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

const config = (homeDir) => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8'));

test('a first install: Install shows its command before running it, no changelog follows setup, and the tools start folded', async () => {
  const home = makeHome(null);
  const { app, win } = await launch(home);
  try {
    await expect(win.locator('#onboarding')).toBeVisible();
    await win.click('#ob-start');
    // An agent that is not installed offers Install. One click only says what
    // would run; nothing has been run.
    const install = win.locator('#ob-agents .ob-cli-install').first();
    await expect(install).toBeVisible();
    await install.click();
    await expect(win.locator('#ob-log')).toContainText('npm install -g');
    await expect(install).toHaveText('Run it');
    expect(fs.existsSync(path.join(home.homeDir, 'npm-calls.log'))).toBe(false);

    // Through the rest of setup with the agent that is already here.
    await win.locator('#ob-agents .ob-cli[data-id="claude"]').click();
    await win.click('#ob-cli-next');
    await win.click('#ob-finish');
    await expect(win.locator('#onboarding')).toBeHidden();

    // No What's new for someone who has never seen what was old, and the
    // version counts as seen so it does not turn up on the next launch either.
    await expect(win.locator('#whatsnew')).toBeHidden();
    await expect.poll(() => config(home.homeDir).lastSeenVersion).toBeTruthy();
    expect(fs.existsSync(path.join(home.homeDir, 'npm-calls.log'))).toBe(false);

    // The rail opens on the everyday pages; Tools is one heading until asked for.
    expect(config(home.homeDir).railToolsFolded).toBe(true);
    await expect(win.locator('#rail-tools')).toHaveClass(/is-folded/);
    await expect(win.locator('.rail-item[data-page="skills"]')).toBeHidden();
    await expect(win.locator('.rail-item[data-page="chat"]')).toBeVisible();
    await win.click('#rail-tools-fold');
    await expect(win.locator('.rail-item[data-page="skills"]')).toBeVisible();
    await expect(win.locator('#rail-tools-fold')).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => config(home.homeDir).railToolsFolded).toBe(false);
    // Folded again, the page you are on stays in sight.
    await win.evaluate(() => setPage('skills')); // eslint-disable-line no-undef
    await win.click('#rail-tools-fold');
    await expect(win.locator('.rail-item[data-page="skills"]')).toBeVisible();
    await expect(win.locator('.rail-item[data-page="mcp"]')).toBeHidden();
  } finally { await app.close(); }
});

test('an existing install keeps its rail, and the chat page explains itself', async () => {
  const home = makeHome({ firstRunDone: true, skipWelcome: true, agentCommand: 'claude', resumeLastOnLaunch: false, railExpanded: true });
  const { app, win } = await launch(home);
  try {
    await win.evaluate(() => { document.querySelectorAll('.modal, #whatsnew').forEach((m) => { m.hidden = true; }); });
    const pane = win.locator('.chat-pane.show');
    await expect(pane).toBeVisible();
    await win.waitForFunction(() => {
      const i = document.querySelector('.chat-pane.show .chat-input');
      return i && !/Starting/.test(i.placeholder);
    });

    // Nothing folded for someone who already knows where things are.
    await expect(win.locator('#rail-tools')).not.toHaveClass(/is-folded/);
    await expect(win.locator('.rail-item[data-page="skills"]')).toBeVisible();

    // The trust notice says what trusting does, and has more for whoever asks.
    await expect(win.locator('#trust-banner')).toBeVisible();
    await expect(win.locator('#trust-banner .trust-banner-text')).toContainText('Trust this folder to let the agent use the permissions you saved for it.');
    await expect(win.locator('#trust-banner-more')).toBeHidden();
    await win.click('#btn-trust-why');
    await expect(win.locator('#trust-banner-more')).toBeVisible();
    await expect(win.locator('#trust-banner-more')).toContainText('Only trust a folder whose contents you know');
    await expect(win.locator('#btn-trust-why')).toHaveAttribute('aria-expanded', 'true');

    // An empty chat offers four first moves; one click fills the composer and sends nothing.
    await expect(pane.locator('.chat-starter')).toHaveCount(4);
    await win.screenshot({ path: path.join(REPO_ROOT, 'test-results', 'first-impressions-chat.png') });
    await pane.locator('.chat-starter', { hasText: 'Explain this project' }).click();
    await expect(pane.locator('.chat-input')).toHaveValue(/^Read through this project/);
    await expect(pane.locator('.chat-item-user')).toHaveCount(0);
    await pane.locator('.chat-input').fill('');

    // The chips under the composer say what they are.
    await expect(pane.locator('.chat-composer-meta .chat-chip').first()).toHaveAttribute('title', 'Agent: claude');
    await expect(pane.locator('.chat-composer-meta .chat-composer-cwd')).toHaveAttribute('title', /^Folder: /);
    await expect(pane.locator('.chat-composer-meta .chat-model-btn')).toHaveAttribute('title', /^Model/);

    // Interface size has a name in Preferences, moves the real zoom, and is saved.
    const base = await win.evaluate(() => window.husk.ui.zoomBase);
    await win.evaluate(() => setPage('prefs')); // eslint-disable-line no-undef
    await win.click('.prefs-nav-item[data-prefs-section="appearance"]');
    await expect(win.locator('#pref-ui-size')).toHaveValue('0');
    await win.locator('#pref-ui-size').selectOption('2');
    expect(await win.evaluate(() => window.husk.ui.zoomGet())).toBe(base + 1);
    await expect(win.locator('#toast-stack')).toContainText('Interface size: 120% of default');
    await expect.poll(() => config(home.homeDir).uiZoom).toBe(base + 1);
    // The keys and the control are one setting.
    await win.evaluate(() => { reportZoom(window.husk.ui.zoomOut()); }); // eslint-disable-line no-undef
    await expect(win.locator('#pref-ui-size')).toHaveValue('1');
    await win.locator('#pref-ui-size').selectOption('0');
    await expect(win.locator('#toast-stack')).toContainText('Interface size: default');
    await expect.poll(() => config(home.homeDir).uiZoom).toBe(null);
    // The save button says what it restarts.
    await win.click('.prefs-nav-item[data-prefs-section="agent"]');
    await expect(win.locator('#pref-save')).toHaveText('Save and restart agent');

    // Workflows with no run yet: calls to action, no row of zeros and blanks.
    await win.evaluate(() => setPage('workflows')); // eslint-disable-line no-undef
    await expect(win.locator('#wfx-cta-build')).toBeVisible();
    await expect(win.locator('.wfx-hero-stats')).toBeHidden();
  } finally { await app.close(); }
});
