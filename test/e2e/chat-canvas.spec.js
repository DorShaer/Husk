'use strict';

// The canvas beside a chat. A turn that moves files in the working tree leaves
// a card in the thread; the card opens the canvas on that file's diff; the
// branch's pull request and its checks sit on the other tabs, and their actions
// go back to the chat as prompts. `codex` and `gh` are fixtures on PATH.

const { test, expect, _electron: electron } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CODEX = path.join(__dirname, 'fixtures', 'fake-codex-app-server.js');

const PULLS = [{
  number: 7, title: 'Add backoff to the retry', state: 'OPEN', isDraft: false, author: { login: 'octo' },
  headRefName: 'main', baseRefName: 'release', additions: 4, deletions: 1, changedFiles: 1, labels: [],
  reviewDecision: '', mergeable: 'MERGEABLE', url: 'https://example.com/pull/7',
  statusCheckRollup: [
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.com/run/1' },
    { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://example.com/run/2' },
  ],
}];

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-canvas-'));
  const repo = path.join(homeDir, 'work');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'retry.js'), 'function retry() {\n  return wait(500);\n}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'codex', resumeLastOnLaunch: false, agentCwd: repo, theme: 'midnight',
  }));
  const bin = path.join(homeDir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${CODEX}" "$@"\n`);
  fs.writeFileSync(path.join(bin, 'pulls.json'), JSON.stringify(PULLS));
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\ncase "$*" in *"pr list"*) cat "$(dirname "$0")/pulls.json" ;; *) echo "gh version 2.60.0" ;; esac\n');
  for (const name of ['codex', 'gh']) fs.chmodSync(path.join(bin, name), 0o755);
  return { homeDir, bin, repo };
}

async function launch(homeDir, bin) {
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      HUSK_CANVAS_TERMINAL: '1',
      HUSK_CANVAS_TERMINAL_LOG: path.join(homeDir, 'terminal-input.txt'),
      HUSK_CANVAS_DEMO: process.env.HUSK_CANVAS_SHOT ? '1' : '',
      HUSK_E2E_REPLY: process.env.HUSK_CANVAS_SHOT ? 'The retry now backs off exponentially and caps at thirty seconds.' : process.env.HUSK_E2E_REPLY,
    },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForFunction(() => window.husk && window.husk.chat && window.HuskChat && window.ChatCanvas && document.querySelector('.chat-stage'));
  await win.waitForFunction(() => {
    const i = document.querySelector('.chat-pane.show .chat-input');
    return i && !/Starting/.test(i.placeholder);
  });
  return { app, win };
}

test('a turn that changes a file leaves a card that opens its diff, and a failing check can be sent back to the chat', async () => {
  const { homeDir, bin, repo } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    const pane = win.locator('.chat-pane.show');
    const canvas = win.locator('#chat-canvas');
    await expect(canvas).toBeHidden();

    await pane.locator('.chat-input').fill('add backoff');
    await pane.locator('.chat-input').press('Enter');
    const perm = pane.locator('.chat-perm');
    await expect(perm).toBeVisible();
    // The turn is open and waiting: the tree moves now, inside its window.
    fs.writeFileSync(path.join(repo, 'retry.js'), 'function retry(n) {\n  return wait(Math.min(500 * 2 ** n, 30000));\n}\n');
    await perm.locator('.chat-perm-btn', { hasText: /^Allow$/ }).click();

    const card = pane.locator('.chat-changes');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.chat-changes-title')).toHaveText('1 file changed during this turn');
    await expect(card.locator('.chat-changes-row')).toHaveText(/retry\.js/);
    const chip = pane.locator('.chat-pr');
    await expect(chip).toContainText('PR #7');
    await expect(chip).toContainText('1 check failing');
    await expect(win.locator('#rail .rail-item[data-page="github"] .rail-mark')).toHaveText('1');

    await card.locator('.chat-changes-row').first().click();
    await expect(canvas).toBeVisible();
    await expect(win.locator('#btn-canvas')).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.locator('.cc-file.is-on .cc-path')).toHaveText('retry.js');
    await expect(canvas.locator('.cc-file.is-on .cc-turn')).toHaveCount(1);
    await expect(canvas.locator('.cc-diff .sc-dl.is-add', { hasText: 'Math.min' })).toHaveCount(1);
    // The chat keeps the rest of the stage; the two do not overlap.
    const boxes = await win.evaluate(() => {
      const p = document.querySelector('.chat-pane.show').getBoundingClientRect();
      const c = document.getElementById('chat-canvas').getBoundingClientRect();
      return { paneRight: p.right, canvasLeft: c.left };
    });
    expect(boxes.paneRight).toBeLessThanOrEqual(boxes.canvasLeft + 1);

    await chip.click();
    await expect(canvas.locator('.cc-tab.is-on')).toHaveText(/Checks/);
    await expect(canvas.locator('.cc-check')).toHaveCount(2);
    await expect(canvas.locator('.cc-check.is-on')).toContainText('unit');
    await expect(canvas.locator('.cc-btn', { hasText: /^Explain$/ })).toBeVisible();
    await expect(canvas.locator('.cc-btn', { hasText: /^Open log$/ })).toBeVisible();
    const actionBounds = await canvas.locator('.cc-chead .cc-btn').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { right: r.right, visible: r.width > 0 && getComputedStyle(el).visibility === 'visible' };
    }));
    const canvasRight = await canvas.evaluate((el) => el.getBoundingClientRect().right);
    expect(actionBounds.every((b) => b.visible && b.right <= canvasRight + 1)).toBe(true);
    if (process.env.HUSK_CANVAS_SHOT) {
      await win.evaluate(() => window.husk.ui.zoomSet(0));
      await win.waitForTimeout(250);
      const display = await win.evaluate(() => ({ width: screen.availWidth, height: screen.availHeight }));
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds({
        x: 0, y: 0, width: Math.min(1760, size.width - 24), height: Math.min(1040, size.height - 48),
      }), display);
      await win.evaluate(() => {
        if (document.body.dataset.status !== 'collapsed') document.getElementById('btn-status-toggle').click();
      });
      await win.waitForTimeout(400);
      const captureBounds = await canvas.locator('.cc-chead .cc-btn').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
      const captureCanvasRight = await canvas.evaluate((el) => el.getBoundingClientRect().right);
      expect(captureBounds.every((right) => right <= captureCanvasRight + 1)).toBe(true);
      await win.screenshot({ path: process.env.HUSK_CANVAS_SHOT, animations: 'disabled' });
    }
    const users = pane.locator('.chat-item-user');
    const before = await users.count();
    await canvas.locator('.cc-btn', { hasText: /^Fix$/ }).click();
    await expect(users).toHaveCount(before + 1);
    await expect(users.last()).toContainText('The check "unit" on pull request #7');

    await canvas.locator('#cc-close').click();
    await expect(canvas).toBeHidden();
    await expect(win.locator('#btn-canvas')).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a turn that changes nothing leaves no card, and the canvas says the tree is clean', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('say hi');
    await pane.locator('.chat-input').press('Enter');
    await pane.locator('.chat-perm .chat-perm-btn', { hasText: /^Allow$/ }).click();
    await expect(pane.locator('.chat-meta .chat-meta-line')).toContainText('Done');
    await expect(pane.locator('.chat-pr')).toContainText('PR #7');
    await expect(pane.locator('.chat-changes')).toHaveCount(0);

    await win.locator('#btn-canvas').click();
    await expect(win.locator('#chat-canvas .cc-empty-title')).toHaveText('Working tree is clean');
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('a long list of PR checks scrolls to its last check in a short window', async () => {
  const { homeDir, bin } = makeHome();
  const pulls = JSON.parse(JSON.stringify(PULLS));
  pulls[0].statusCheckRollup = Array.from({ length: 50 }, (_, i) => ({
    name: `check-${String(i + 1).padStart(2, '0')}`, status: 'COMPLETED', conclusion: 'SUCCESS',
    detailsUrl: `https://example.com/run/${i + 1}`,
  }));
  fs.writeFileSync(path.join(bin, 'pulls.json'), JSON.stringify(pulls));
  const { app, win } = await launch(homeDir, bin);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1200, 620);
    });
    await win.locator('#btn-canvas').click();
    const canvas = win.locator('#chat-canvas');
    await canvas.locator('.cc-tab[data-tab="checks"]').click();
    await expect(canvas.locator('.cc-check')).toHaveCount(50);
    const body = canvas.locator('.cc-body');
    await expect.poll(() => body.evaluate((n) => n.scrollHeight > n.clientHeight)).toBe(true);
    await body.hover();
    await win.mouse.wheel(0, 10000);
    await expect.poll(() => body.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
    const last = canvas.locator('.cc-check').last();
    await expect(last).toBeInViewport();
    await last.click();
    await expect(canvas.locator('.cc-title')).toContainText('check-50');
    await expect(canvas.locator('.cc-foot')).toBeInViewport();
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('Fix and Explain submit their prompt to the CLI in Terminal mode', async () => {
  const { homeDir, bin } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  const logPath = path.join(homeDir, 'terminal-input.txt');
  try {
    await win.evaluate(async () => setTabMode(TABS.get(activeTabId), 'terminal'));
    await expect(win.locator('.term-pane.show')).toBeVisible();
    await win.locator('#btn-canvas').click();
    const canvas = win.locator('#chat-canvas');
    await canvas.locator('.cc-tab[data-tab="checks"]').click();
    await expect(canvas.locator('.cc-btn', { hasText: /^Explain$/ })).toBeVisible();
    await canvas.locator('.cc-btn', { hasText: /^Explain$/ }).click();
    await expect.poll(() => {
      try { return fs.readFileSync(logPath, 'utf8'); } catch (_) { return ''; }
    }).toContain('Explain where the check "unit" on pull request #7');
    await expect.poll(() => {
      try { return fs.readFileSync(logPath, 'utf8'); } catch (_) { return ''; }
    }).toContain('\n');
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
