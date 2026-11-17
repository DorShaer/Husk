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

function makeHome({ nonGit = false } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-canvas-'));
  const repo = path.join(homeDir, 'work');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
  if (!nonGit) git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'retry.js'), 'function retry() {\n  return wait(500);\n}\n');
  if (!nonGit) { git('add', '.'); git('commit', '-q', '-m', 'init'); }

  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'codex', resumeLastOnLaunch: false, agentCwd: repo, theme: process.env.HUSK_CANVAS_THEME || 'midnight',
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
    // HUSK_SHOT_SCALE renders at a fixed device scale for release captures.
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox', ...(process.env.HUSK_SHOT_SCALE ? [`--force-device-scale-factor=${process.env.HUSK_SHOT_SCALE}`] : [])],
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

test('checks GitHub did not return in time read as unavailable, not as none', async () => {
  const { homeDir, bin } = makeHome();
  const pulls = JSON.parse(JSON.stringify(PULLS));
  delete pulls[0].statusCheckRollup;
  fs.writeFileSync(path.join(bin, 'pulls.json'), JSON.stringify(pulls));
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\ncase "$*" in *statusCheckRollup*) echo "HTTP 504: Gateway Timeout" >&2; exit 1 ;; *"pr list"*) cat "$(dirname "$0")/pulls.json" ;; *) echo "gh version 2.60.0" ;; esac\n');
  const { app, win } = await launch(homeDir, bin);
  try {
    await win.locator('#btn-canvas').click();
    const canvas = win.locator('#chat-canvas');
    await canvas.locator('.cc-tab[data-tab="pr"]').click();
    await expect(canvas.locator('.cc-fields')).toContainText('Checks unavailable');
    await expect(canvas.locator('.cc-fields')).not.toContainText('no checks ran');
    await canvas.locator('.cc-tab[data-tab="checks"]').click();
    await expect(canvas.locator('.cc-body')).toContainText('Checks unavailable');
    await expect(canvas.locator('.cc-body')).not.toContainText('No checks ran');
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

test('the canvas widens from its left edge, keeps the chat floor, and double-click resets it', async () => {
  const { homeDir, bin } = makeHome();
  // Fold the side panel so the stage has room to widen the canvas.
  const cfgFile = path.join(homeDir, '.config', 'husk', 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), statusCollapsed: true }));
  const { app, win } = await launch(homeDir, bin);
  const config = () => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8'));
  const width = () => win.evaluate(() => Math.round(document.getElementById('chat-canvas').getBoundingClientRect().width));
  const stage = () => win.evaluate(() => document.querySelector('.chat-stage').getBoundingClientRect().width);
  const drag = async (dx) => {
    const g = await win.locator('#cc-resize').boundingBox();
    const x = g.x + g.width / 2, y = g.y + g.height / 2;
    await win.mouse.move(x, y);
    await win.mouse.down();
    await win.mouse.move(x + dx, y, { steps: 10 });
    await win.mouse.up();
  };
  try {
    await win.locator('#btn-canvas').click();
    await expect(win.locator('#cc-resize')).toBeVisible();
    const start = await width();

    await drag(-40);
    const wide = await width();
    expect(wide).toBeGreaterThanOrEqual(start + 35);
    expect(wide).toBeLessThanOrEqual(start + 45);
    await expect.poll(() => config().canvasWidth).toBe(wide);

    // However far the edge goes, the chat keeps its floor.
    await drag(-2000);
    expect(Math.round((await stage()) - (await width()))).toBeGreaterThanOrEqual(319);

    await win.locator('#cc-resize').dblclick();
    await expect.poll(width).toBe(start);
    await expect.poll(() => config().canvasWidth).toBe(null);
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});


test('non-Git folders show turn changes and diffs, and initialize Git only after confirmation', async () => {
  const { homeDir, bin, repo } = makeHome({ nonGit: true });
  fs.writeFileSync(path.join(repo, 'delete.txt'), 'remove me\n');
  fs.writeFileSync(path.join(repo, '.env'), 'private fixture\n');
  const { app, win } = await launch(homeDir, bin);
  // HUSK_SHOT_DIR: release captures want the thread and the canvas side by side.
  const shotDir = process.env.HUSK_SHOT_DIR;
  if (shotDir) await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1760, height: 960 }));
  try {
    const pane = win.locator('.chat-pane.show');
    const canvas = win.locator('#chat-canvas');
    await pane.locator('.chat-input').fill('update the plain folder');
    await pane.locator('.chat-input').press('Enter');
    const permission = pane.locator('.chat-perm');
    await expect(permission).toBeVisible();
    fs.writeFileSync(path.join(repo, 'retry.js'), 'function retry(n) {\n  return wait(n * 500);\n}\n');
    fs.unlinkSync(path.join(repo, 'delete.txt'));
    fs.writeFileSync(path.join(repo, 'added.txt'), 'new content\n');
    fs.writeFileSync(path.join(repo, '.env'), 'changed private fixture\n');
    await permission.locator('.chat-perm-btn', { hasText: /^Allow$/ }).click();
    const card = pane.locator('.chat-changes');
    await expect(card.locator('.chat-changes-title')).toHaveText('3 files changed during this turn');
    await expect(card).not.toContainText('.env');
    await card.locator('.chat-changes-row', { hasText: 'retry.js' }).click();
    await expect(canvas.locator('.cc-diff .sc-dl.is-add', { hasText: 'n * 500' })).toHaveCount(1);
    await expect(canvas.getByRole('button', { name: 'Explain', exact: true })).toBeVisible();
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      await win.waitForTimeout(400);
      const shot = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shotDir, 'changes-full.png'), Buffer.from(shot, 'base64'));
    }
    await canvas.locator('.cc-file', { hasText: 'delete.txt' }).click();
    await expect(canvas.locator('.cc-diff .sc-dl.is-del', { hasText: 'remove me' })).toHaveCount(1);
    const init = canvas.getByRole('button', { name: 'Initialize Git', exact: true });
    await init.click();
    await expect(win.locator('#confirm-body')).toContainText(repo);
    await win.locator('#confirm-cancel').click();
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(false);
    const refused = await win.evaluate(root => window.husk.git.init(root, false), repo);
    expect(refused.ok).toBe(false);
    const outside = await win.evaluate(() => window.husk.folderChanges.begin('/tmp'));
    expect(outside.ok).toBe(false);
    fs.mkdirSync('/tmp/husk-non-git-changes', { recursive: true });
    await win.waitForTimeout(200);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.writeFileSync('/tmp/husk-non-git-changes/changes.png', Buffer.from(png, 'base64'));
    await init.click();
    await win.locator('#confirm-ok').click();
    await expect.poll(() => fs.existsSync(path.join(repo, '.git'))).toBe(true);
    expect(execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim()).toBe('main');
    expect(execFileSync('git', ['-C', repo, 'remote'], { encoding: 'utf8' }).trim()).toBe('');
    let commits = ''; try { commits = execFileSync('git', ['-C', repo, 'rev-list', '--all'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) {}
    expect(commits).toBe('');
    await expect(canvas.getByRole('button', { name: 'Review and commit' })).toBeVisible();
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('without Git on PATH, local diffs work and Git setup can be discovered without restarting Husk', async () => {
  const { homeDir, bin, repo } = makeHome({ nonGit: true });
  const { app, win } = await launch(homeDir, bin);
  try {
    // Remove Git from the actual Electron main process's lookup path. The
    // already-running fixture agent keeps its own environment and needs no Git.
    await app.evaluate((_electron, bin) => { global.savedGitPath = process.env.PATH; process.env.PATH = bin; }, bin);
    const missing = await win.evaluate(() => window.husk.git.available(true));
    expect(missing.available).toBe(false);
    expect(missing.error).toMatch(/not installed|PATH/);
    await win.evaluate(async () => { await refreshStats(); await refreshStatusline(); });
    const init = await win.evaluate(root => window.husk.git.init(root, true), repo);
    expect(init.code).toBe('git-missing');
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(false);
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('edit without git');
    await pane.locator('.chat-input').press('Enter');
    const permission = pane.locator('.chat-perm');
    await expect(permission).toBeVisible();
    fs.writeFileSync(path.join(repo, 'retry.js'), 'function retry() {\n  return wait(1000);\n}\n');
    await permission.locator('.chat-perm-btn', { hasText: /^Allow$/ }).click();
    await expect(pane.locator('.chat-changes-title')).toHaveText('1 file changed during this turn');
    await pane.locator('.chat-changes-row').click();
    const canvas = win.locator('#chat-canvas');
    await expect(canvas.locator('.cc-diff .sc-dl.is-add', { hasText: '1000' })).toHaveCount(1);
    await expect(canvas.getByRole('button', { name: 'Initialize Git', exact: true })).toHaveCount(0);
    await expect(canvas.getByRole('button', { name: 'Get Git', exact: true })).toBeVisible();
    await expect(canvas).toContainText('File changes are still tracked locally');
    await app.evaluate(({ shell }) => { global.openedGitUrl = ''; shell.openExternal = async url => { global.openedGitUrl = url; }; });
    await canvas.getByRole('button', { name: 'Get Git', exact: true }).click();
    expect(await app.evaluate(() => global.openedGitUrl)).toBe('https://git-scm.com/install/');
    await app.evaluate(({ shell }) => { shell.openExternal = async () => { throw new Error('No browser handler'); }; });
    await canvas.getByRole('button', { name: 'Get Git', exact: true }).click();
    await expect(canvas).toContainText('Could not open your browser');
    await canvas.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(canvas.getByRole('button', { name: 'Get Git', exact: true })).toBeVisible();
    await canvas.locator('.cc-tab', { hasText: 'Pull request' }).click();
    await expect(canvas).toContainText('Git is not available');
    await win.evaluate(() => setPage('source'));
    await expect(win.locator('#sc-list').getByRole('button', { name: 'Get Git', exact: true })).toBeVisible();
    fs.mkdirSync('/tmp/husk-git-qa', { recursive: true });
    await win.evaluate(() => setPage('chat'));
    await win.evaluate(() => window.ChatCanvas.open({ tab: 'changes' }));
    await expect(canvas.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
    await win.waitForTimeout(150);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
    fs.writeFileSync('/tmp/husk-git-qa/missing-git.png', Buffer.from(png, 'base64'));
    await app.evaluate(() => { process.env.PATH = global.savedGitPath; });
    await canvas.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(canvas.getByRole('button', { name: 'Initialize Git', exact: true })).toBeVisible();
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(false);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('damaged repository metadata is reported without offering to reinitialize it', async () => {
  const { homeDir, bin, repo } = makeHome({ nonGit: true });
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: missing-metadata\n');
  const { app, win } = await launch(homeDir, bin);
  try {
    const status = await win.evaluate(root => window.husk.git.status(root), repo);
    expect(status.ok).toBe(false);
    expect(status.code).toBe('git-repository-error');
    const init = await win.evaluate(root => window.husk.git.init(root, true), repo);
    expect(init.code).toBe('already-repository');
    expect(fs.readFileSync(path.join(repo, '.git'), 'utf8')).toBe('gitdir: missing-metadata\n');
    await win.evaluate(() => window.ChatCanvas.open({ tab: 'changes' }));
    const canvas = win.locator('#chat-canvas');
    await expect(canvas).toContainText('Could not read changes');
    await expect(canvas.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Initialize Git', exact: true })).toHaveCount(0);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('read-only and replaced working folders cannot be initialized', async () => {
  test.skip(process.platform === 'win32' || (process.getuid && process.getuid() === 0), 'POSIX permission check');
  const { homeDir, bin, repo } = makeHome({ nonGit: true });
  const { app, win } = await launch(homeDir, bin);
  try {
    fs.chmodSync(repo, 0o500);
    await win.evaluate(() => window.ChatCanvas.open({ tab: 'changes' }));
    const canvas = win.locator('#chat-canvas');
    await expect(canvas).toContainText('Choose a writable folder');
    await expect(canvas.getByRole('button', { name: 'Initialize Git', exact: true })).toHaveCount(0);
    const refused = await win.evaluate(root => window.husk.git.init(root, true), repo);
    expect(refused.code).toBe('folder-readonly');
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(false);
    fs.chmodSync(repo, 0o700);
    fs.renameSync(repo, repo + '-saved');
    fs.writeFileSync(repo, 'The working folder was replaced by a file.');
    const replaced = await win.evaluate(root => window.husk.git.init(root, true), repo);
    expect(replaced.ok).toBe(false);
    expect(replaced.error).toMatch(/directory|folder/);
    expect(fs.readFileSync(repo, 'utf8')).toBe('The working folder was replaced by a file.');
  } finally { if (fs.existsSync(repo) && fs.statSync(repo).isDirectory()) fs.chmodSync(repo, 0o700); await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

test('losing Git during a turn reports an unavailable comparison instead of a false file receipt', async () => {
  const { homeDir, bin, repo } = makeHome();
  const { app, win } = await launch(homeDir, bin);
  try {
    const pane = win.locator('.chat-pane.show');
    await pane.locator('.chat-input').fill('edit while git becomes unavailable');
    await pane.locator('.chat-input').press('Enter');
    const permission = pane.locator('.chat-perm');
    await expect(permission).toBeVisible();
    await app.evaluate((_electron, bin) => { process.env.PATH = bin; }, bin);
    await win.evaluate(() => window.husk.git.available(true));
    fs.writeFileSync(path.join(repo, 'retry.js'), 'function retry() {\n  return wait(900);\n}\n');
    await permission.locator('.chat-perm-btn', { hasText: /^Allow$/ }).click();
    await expect(pane).toContainText('Git became unavailable');
    await expect(pane.locator('.chat-changes')).toHaveCount(0);
    expect(fs.readFileSync(path.join(repo, 'retry.js'), 'utf8')).toContain('900');
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
  } finally { await app.close(); fs.rmSync(homeDir, { recursive: true, force: true }); }
});

const PNG_BEFORE = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=';
const PNG_AFTER = 'iVBORw0KGgoAAAANSUhEUgAAAPAAAAB4CAIAAABD1OhwAAAA+0lEQVR42u3SAQkAAAgEsQ9mMMMaxhoigyU4LtUDb0QCDA2GBkODoTE0GBoMDYYGQ2NoMDQYGgwNhsbQYGgwNBgaDI2hwdBgaDA0GBpDg6HB0GBoMDSGBkODocHQYGgMDYYGQ4OhMTQYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6HB0BgaDA2GBkNjaDA0GBoMDYbG0GBoMDQYGgyNocHQYGgwNBgaQ4OhwdBgaDA0hgZDg6HB0GBoDA2GBkODocHQGBoMDYYGQ2NoFTA0GBoMDYbG0GBouGUBwCjSQkLMRQcAAAAASUVORK5CYII=';

test('a changed image file is shown as a picture, and only when its bytes are an image', async () => {
  const { homeDir, bin, repo } = makeHome();
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'shot.png'), Buffer.from(PNG_BEFORE, 'base64'));
  fs.writeFileSync(path.join(repo, 'gone.png'), Buffer.from(PNG_BEFORE, 'base64'));
  git('add', '.'); git('commit', '-q', '-m', 'images');
  fs.writeFileSync(path.join(repo, 'shot.png'), Buffer.from(PNG_AFTER, 'base64'));
  fs.rmSync(path.join(repo, 'gone.png'));
  fs.writeFileSync(path.join(repo, 'page.png'), Buffer.concat([Buffer.alloc(8), Buffer.from('<!doctype html><p>text</p>')]));
  fs.mkdirSync(path.join(homeDir, 'elsewhere'));
  fs.writeFileSync(path.join(homeDir, 'elsewhere', 'in.png'), Buffer.from(PNG_AFTER, 'base64'));
  fs.symlinkSync(path.join(homeDir, 'elsewhere'), path.join(repo, 'linked'));
  fs.writeFileSync(path.join(homeDir, 'elsewhere.png'), Buffer.from(PNG_AFTER, 'base64'));
  fs.symlinkSync(path.join(homeDir, 'elsewhere.png'), path.join(repo, 'link.png'));
  const { app, win } = await launch(homeDir, bin);
  try {
    const canvas = win.locator('#chat-canvas');
    await win.locator('#btn-canvas').click();
    await expect(canvas).toBeVisible();
    const open = async (name) => {
      await canvas.locator('.cc-file', { hasText: name }).click();
      await expect(canvas.locator('.cc-dpath')).toHaveText(name);
      await expect(canvas.locator('.cc-diff .cc-note', { hasText: 'Reading the diff' })).toHaveCount(0);
    };
    await open('shot.png');
    const img = canvas.locator('.cc-diff .cc-image canvas');
    await expect(img).toBeVisible();
    await expect(canvas.locator('.cc-image-meta')).toContainText('240 × 120');
    // Painted from pixels: the right size and colour, and no image element in the panel.
    expect(await img.evaluate((el) => [el.width, el.height, ...el.getContext('2d').getImageData(5, 5, 1, 1).data])).toEqual([240, 120, 60, 120, 220, 255]);
    await expect(canvas.locator('img')).toHaveCount(0);
    const box = await win.evaluate(() => {
      const i = document.querySelector('.cc-image canvas').getBoundingClientRect();
      const d = document.querySelector('.cc-diff').getBoundingClientRect();
      return { inside: i.left >= d.left && i.right <= d.right };
    });
    expect(box.inside).toBe(true);
    if (process.env.HUSK_IMAGE_SHOT) await win.screenshot({ path: process.env.HUSK_IMAGE_SHOT });
    // Another file's picture is gone the moment the selection moves.
    await canvas.locator('.cc-file', { hasText: 'gone.png' }).click();
    expect(await canvas.locator('.cc-diff canvas').count()).toBe(0);
    for (const name of ['page.png', 'link.png', 'gone.png']) {
      await open(name);
      await expect(canvas.locator('.cc-diff canvas')).toHaveCount(0);
    }
    await open('shot.png');
    await expect(img).toBeVisible();
    const asked = await win.evaluate(async (root) => {
      const out = [];
      for (const rel of ['page.png', 'link.png', 'linked/in.png', 'gone.png', 'linked']) out.push((await window.husk.git.image(root, rel)).ok);
      out.push((await window.husk.git.image(root + '/..', 'elsewhere.png')).ok);
      const burst = await Promise.all(Array.from({ length: 6 }, () => window.husk.git.image(root, 'shot.png')));
      return { refused: out, burst: burst.map((r) => r.ok) };
    }, repo);
    expect(asked.refused).toEqual([false, false, false, false, false, false]);
    expect(asked.burst).toEqual([true, false, false, false, false, true]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
