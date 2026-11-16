'use strict';

// The first-run welcome: real CLIs with their versions, connect by keys, a
// project, a theme that applies live, and a first chat on the picked CLI.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-claude-stream.js');
const SHOTS = path.join(REPO_ROOT, 'test-results');

function makeHome(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-welcome-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  if (config) fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify(config));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  const tool = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); fs.chmodSync(path.join(bin, name), 0o755); };
  tool('claude', `if [ "$1" = "--version" ]; then echo "2.1.310 (Claude Code)"; exit 0; fi\nexec "${process.execPath}" "${FIXTURE}" "$@"`);
  tool('codex', 'if [ "$1" = "--version" ]; then echo "codex-cli 0.168.0"; fi\nexit 0');
  tool('npm', `echo "$@" >> "${path.join(homeDir, 'npm-calls.log')}"`);
  const project = path.join(homeDir, 'work', 'acme-notes');
  fs.mkdirSync(project, { recursive: true });
  return { homeDir, bin, project };
}

async function launch({ homeDir, bin }) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    // Only the fake CLIs and the system tools, so the list does not depend on this machine.
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

const config = (homeDir) => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8'));
const bg = (win) => win.evaluate(() => getComputedStyle(document.getElementById('onboarding')).backgroundColor);
// The window's own capture, since a page screenshot at a fractional zoom crops the frame.
async function shot(app, name) {
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(png, 'base64'));
}

test('first run: connect by keys, pick a project and a theme, and start a chat on the picked CLI', async () => {
  const home = makeHome(null);
  const { app, win } = await launch(home);
  await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, home.project);
  try {
    const ob = win.locator('#onboarding');
    await expect(ob).toBeVisible();
    await expect(win.locator('.cine-scene[data-s="0"]')).toHaveClass(/is-on/);
    await expect(win.locator('.cine-scene[data-s="0"] h1')).toContainText('at home.');
    // A fresh install is light, and the welcome still opens on its own black field.
    await expect(win.locator('body')).toHaveAttribute('data-theme', 'light');
    expect(await bg(win)).toBe('rgb(0, 0, 0)');
    await win.waitForTimeout(700);
    await shot(app, 'onboarding-hero.png');

    await win.keyboard.press('Enter');
    await expect(win.locator('.cine-scene[data-s="1"]')).toHaveClass(/is-on/);
    const card = (cmd) => win.locator(`#ob-clis .cine-cli[data-cmd="${cmd}"]`);
    await expect(card('claude').locator('.cine-cli-state')).toHaveText('Ready · v2.1.310');
    await expect(card('codex').locator('.cine-cli-state')).toHaveText('Ready · v0.168.0');
    await expect(card('gemini').locator('.cine-cli-state')).toHaveText('Not installed');
    await expect(card('gemini').locator('.cine-cli-btn')).toHaveText('Install');
    // Installed CLIs start connected; the number keys toggle them in list order.
    await expect(card('claude')).toHaveAttribute('aria-checked', 'true');
    await expect(card('codex')).toHaveAttribute('aria-checked', 'true');
    const order = await win.locator('#ob-clis .cine-cli').evaluateAll((els) => els.map((e) => e.dataset.cmd));
    const key = (cmd) => String(order.indexOf(cmd) + 1);
    // Any other CLI on this machine's system path is connected too; all go off.
    const on = await win.locator('#ob-clis .cine-cli[aria-checked="true"]').evaluateAll((els) => els.map((e) => e.dataset.cmd));
    for (const cmd of on) await win.keyboard.press(key(cmd));
    await expect(card('claude')).toHaveAttribute('aria-checked', 'false');
    await expect(card('codex')).toHaveAttribute('aria-checked', 'false');
    await expect(win.locator('#ob-next')).toBeDisabled();
    await expect(win.locator('#ob-clis-need')).toBeVisible();
    await win.keyboard.press(key('claude'));
    await expect(card('claude')).toHaveClass(/is-on/);
    await expect(win.locator('#ob-next')).toBeEnabled();
    await win.waitForTimeout(600);
    await shot(app, 'onboarding-connect.png');
    await win.keyboard.press('Enter');
    await expect(win.locator('.cine-scene[data-s="2"]')).toHaveClass(/is-on/);
    await expect.poll(() => config(home.homeDir).connectedClis).toEqual(['claude']);

    await win.locator('#ob-projects button', { hasText: 'Choose a folder' }).click();
    await expect(win.locator('#ob-projects .cine-project', { hasText: 'acme-notes' })).toHaveClass(/is-on/);
    await expect(win.locator('#ob-folder')).toContainText('acme-notes');
    await win.click('#ob-next');
    await expect(win.locator('.cine-scene[data-s="3"]')).toContainText("Husk's security scanner");
    await win.click('#ob-next');

    // A theme pick applies to the app and the welcome at once, and is saved.
    await expect(win.locator('.cine-look')).toHaveCount(await win.evaluate(() => window.HuskThemes.THEMES.length));
    await win.click('.cine-look[data-theme="tokyo-night"]');
    await expect(win.locator('body')).toHaveAttribute('data-theme', 'tokyo-night');
    await expect.poll(() => bg(win)).toBe('rgb(26, 27, 38)');
    await expect.poll(() => config(home.homeDir).theme).toBe('tokyo-night');
    await win.click('.cine-accent[data-accent="emerald"]');
    await expect(win.locator('body')).toHaveAttribute('data-accent', 'emerald');
    await expect.poll(() => config(home.homeDir).accent).toBe('emerald');
    await win.waitForTimeout(600);
    await shot(app, 'onboarding-theme.png');

    await win.keyboard.press('Enter');
    await expect(win.locator('.cine-scene[data-s="5"]')).toHaveClass(/is-on/);
    await expect(win.locator('#ob-cli-pick option')).toHaveText(['Claude Code']);
    await expect(win.locator('#ob-project-chip')).toHaveText('acme-notes');
    await expect(win.locator('#ob-prompt')).toHaveValue('Orient me to this project');
    await expect(win.locator('#ob-next')).toHaveText('Start chat');
    await win.click('#ob-next');

    await expect(ob).toBeHidden();
    const pane = win.locator('.chat-pane.show');
    await expect(pane.locator('.chat-item-user')).toContainText('Orient me to this project');
    await expect(pane).toContainText('Echo: Orient me to this project');
    const saved = config(home.homeDir);
    expect(saved.agentCommand).toBe('claude');
    expect(saved.firstRunDone).toBe(true);
    expect(saved.projects.find((p) => p.id === saved.activeProjectId).path).toBe(home.project);
    expect(fs.existsSync(path.join(home.homeDir, 'npm-calls.log'))).toBe(false);
  } finally { await app.close(); }
});

test('Skip closes the welcome, replay reopens it, and reduced motion holds everything still', async () => {
  const home = makeHome(null);
  const { app, win } = await launch(home);
  try {
    await win.emulateMedia({ reducedMotion: 'reduce' });
    await expect(win.locator('#onboarding')).toBeVisible();
    const motion = await win.evaluate(() => {
      const pod = getComputedStyle(document.querySelector('.cine-scene.is-on .cine-pod img'));
      const scene = getComputedStyle(document.querySelector('.cine-scene'));
      const scan = getComputedStyle(document.querySelector('.cine-scan'), '::after');
      return [pod.animationName, scene.transitionDuration, scan.animationName];
    });
    expect(motion).toEqual(['none', '0s', 'none']);

    await win.click('#ob-skip');
    await expect(win.locator('#onboarding')).toBeHidden();
    await expect.poll(() => config(home.homeDir).firstRunDone).toBe(true);
    expect(config(home.homeDir).connectedClis).toBeUndefined();

    await win.evaluate(() => { runOnboarding({ replay: true }); }); // eslint-disable-line no-undef
    await expect(win.locator('#onboarding')).toBeVisible();
    await expect(win.locator('.cine-scene[data-s="0"]')).toHaveClass(/is-on/);
    await win.click('#ob-skip');
    await expect(win.locator('#onboarding')).toBeHidden();
    expect(config(home.homeDir).firstRunDone).toBe(true);
  } finally { await app.close(); }
});

test('connected CLIs lead the new chat menu and the rest sit under More CLIs', async () => {
  const home = makeHome({ firstRunDone: true, skipWelcome: true, agentCommand: 'claude', connectedClis: ['codex'], resumeLastOnLaunch: false });
  const { app, win } = await launch(home);
  try {
    await win.evaluate(() => { document.querySelectorAll('.modal, #whatsnew').forEach((m) => { m.hidden = true; }); });
    await win.evaluate(() => refreshAgentMenu()); // eslint-disable-line no-undef
    await win.evaluate(() => openNewTabMenu()); // eslint-disable-line no-undef
    const menu = win.locator('#new-tab-menu');
    const labels = menu.locator('.cs-menu-item .cs-menu-label');
    await expect(labels.nth(0)).toHaveText('New chat with OpenAI Codex CLI');
    await expect(labels.nth(1)).toHaveText('Terminal');
    await expect(menu.locator('.cs-menu-group')).toHaveText('More CLIs');
    // Unconnected CLIs stay reachable, after the group heading.
    await expect(menu.locator('.cs-menu-group ~ .cs-menu-item', { hasText: 'New chat with Claude Code' })).toHaveCount(1);
  } finally { await app.close(); }
});
