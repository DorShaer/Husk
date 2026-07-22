'use strict';

// The Projects board and the per-project workspace view.
//
// Seeds a home with two pinned folders, one a git repo with uncommitted
// changes and one a plain directory, and asserts the board groups them,
// that clicking a row opens the workspace instead of restarting the agent,
// and that the workspace view degrades cleanly for the non-git folder.

const { test, expect, _electron: electron } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-ws-'));
  const cfgDir = path.join(dir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

  // A git repo with one commit and one dirty file.
  const gitDir = path.join(dir, 'repo-alpha');
  fs.mkdirSync(gitDir);
  const git = (...args) => execFileSync('git', ['-C', gitDir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(gitDir, 'README.md'), 'alpha\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(gitDir, 'wip.js'), 'const wip = 1;\n');

  // A plain folder, no git, no history.
  const plainDir = path.join(dir, 'notes-plain');
  fs.mkdirSync(plainDir);

  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    agentCommand: 'node -e "setInterval(function(){},1000)"',
    paiEnabled: false,
    firstRunDone: true,
    skipWelcome: true,
    projects: [
      { id: 'p-alpha', name: 'Alpha', path: gitDir, addedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() },
      { id: 'p-plain', name: 'Plain', path: plainDir, addedAt: new Date().toISOString(), lastUsedAt: null },
    ],
  }));
  return dir;
}

async function launchApp() {
  const homeDir = makeHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

async function openBoard(win) {
  await win.evaluate(() => setPage('projects')); // eslint-disable-line no-undef
  await win.waitForSelector('#projects-board .ws-row', { timeout: 15_000 });
}

test('the board groups a dirty repo as Active and an idle folder as Quiet', async () => {
  const { app, win } = await launchApp();
  await openBoard(win);
  // Derived state arrives on the second paint; wait for the git chip.
  await win.waitForSelector('#projects-board .ws-stat', { timeout: 15_000 });
  const info = await win.evaluate(() => ({
    rows: [...document.querySelectorAll('#projects-board .ws-row .ws-row-title')].map((n) => n.textContent.trim()),
    chips: [...document.querySelectorAll('#projects-board .ws-chip')].map((n) => n.textContent.trim()),
    stats: [...document.querySelectorAll('#projects-board .ws-stat')].map((n) => n.textContent.trim()),
    heads: [...document.querySelectorAll('#projects-board .ws-sec-head')].map((n) => n.textContent.trim()),
  }));
  expect(info.rows.join(' ')).toContain('Alpha');
  expect(info.chips.join(' ')).toContain('Plain');
  expect(info.stats.join(' ')).toContain('main');
  expect(info.stats.join(' ')).toContain('1 uncommitted');
  expect(info.heads.join(' ')).toMatch(/Active/);
  expect(info.heads.join(' ')).toMatch(/Quiet/);
  await app.close();
});

test('clicking a row opens the workspace in place; launching stays a button', async () => {
  const { app, win } = await launchApp();
  await openBoard(win);
  await win.click('#projects-board .ws-row');
  await win.waitForSelector('#project-workspace:not([hidden])', { timeout: 10_000 });
  const info = await win.evaluate(() => ({
    onProjectsPage: !document.querySelector('.page-projects').hidden,
    boardHidden: document.getElementById('projects-board').hidden,
    title: document.querySelector('#project-workspace .ws-title').textContent.trim(),
    hasLaunch: !!document.getElementById('ws-launch'),
    panelHeads: [...document.querySelectorAll('#project-workspace .ws-panel-head')].map((n) => n.textContent.trim()),
  }));
  // The view changed, the page and the agent did not.
  expect(info.onProjectsPage).toBe(true);
  expect(info.boardHidden).toBe(true);
  expect(info.title).toContain('Alpha');
  expect(info.hasLaunch).toBe(true);
  expect(info.panelHeads).toContain('Open loops');
  expect(info.panelHeads).toContain('Recent sessions');
  // The dirty tree surfaces as an open loop.
  const loops = await win.evaluate(() => document.querySelector('#project-workspace .ws-panel').textContent);
  expect(loops).toContain('1 uncommitted change');
  // Back returns to the board.
  await win.click('#ws-back');
  await win.waitForSelector('#projects-board:not([hidden])', { timeout: 10_000 });
  await app.close();
});

test('a non-git folder degrades to a plain workspace, not an error', async () => {
  const { app, win } = await launchApp();
  await openBoard(win);
  await win.waitForSelector('#projects-board .ws-chip', { timeout: 15_000 });
  await win.click('#projects-board .ws-chip');
  await win.waitForSelector('#project-workspace:not([hidden])', { timeout: 10_000 });
  const info = await win.evaluate(() => ({
    title: document.querySelector('#project-workspace .ws-title').textContent.trim(),
    details: document.querySelector('#project-workspace .ws-details').textContent,
    loops: document.querySelector('#project-workspace .ws-panel').textContent,
    sessions: document.getElementById('ws-sessions-list').textContent,
  }));
  expect(info.title).toContain('Plain');
  expect(info.details).toContain('not a git repository');
  expect(info.loops).toContain('Nothing waiting on you here');
  await app.close();
});
