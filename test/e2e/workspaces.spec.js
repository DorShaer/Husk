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
    stats: [...document.querySelectorAll('#projects-board .ws-stat')].map((n) => n.textContent.trim()),
    groups: [...document.querySelectorAll('#projects-board .ws-group')].map((n) => n.textContent.trim()),
    header: (document.querySelector('#projects-board .ws-thead') || {}).textContent || '',
  }));
  expect(info.rows.join(' ')).toContain('Alpha');
  expect(info.rows.join(' ')).toContain('Plain');
  expect(info.stats.join(' ')).toContain('main');
  expect(info.stats.join(' ')).toContain('1 uncommitted');
  expect(info.groups.join(' ')).toMatch(/Active/);
  expect(info.groups.join(' ')).toMatch(/Quiet/);
  expect(info.header).toContain('Branch');
  await app.close();
});

test('clicking a row opens the workspace in place; launching stays a button', async () => {
  const { app, win } = await launchApp();
  await openBoard(win);
  await win.click('#projects-board .ws-row');
  await win.waitForSelector('#project-workspace:not([hidden])', { timeout: 10_000 });
  const info = await win.evaluate(() => ({
    onProjectsPage: !document.querySelector('.page-projects').hidden,
    workspaceMode: document.querySelector('.page-projects').classList.contains('is-workspace-open'),
    pageHeadHidden: document.querySelector('.page-projects .page-head').hidden,
    boardHidden: document.getElementById('projects-board').hidden,
    workspaceOffset: Math.round(document.getElementById('project-workspace').getBoundingClientRect().top - document.querySelector('.page-projects').getBoundingClientRect().top),
    title: document.querySelector('#project-workspace .ws-title').textContent.trim(),
    hasLaunch: !!document.getElementById('ws-launch'),
    panelHeads: [...document.querySelectorAll('#project-workspace .ws-panel-head')].map((n) => n.textContent.trim()),
  }));
  // The view changed, the page and the agent did not.
  expect(info.onProjectsPage).toBe(true);
  expect(info.workspaceMode).toBe(true);
  expect(info.pageHeadHidden).toBe(true);
  expect(info.workspaceOffset).toBeLessThan(32);
  expect(info.boardHidden).toBe(true);
  expect(info.title).toContain('Alpha');
  expect(info.hasLaunch).toBe(true);
  expect(info.panelHeads).toContain('Open loops');
  expect(info.panelHeads).toContain('Recent sessions');
  expect(info.panelHeads).toContain('Autopilot runs');
  expect(info.panelHeads).toContain('MCP servers in this folder');
  // The board filter has no meaning inside one project.
  const filterHidden = await win.evaluate(() => document.getElementById('projects-search').hidden);
  expect(filterHidden).toBe(true);
  // The dirty tree surfaces as an open loop.
  const loops = await win.evaluate(() => document.querySelector('#project-workspace .ws-panel').textContent);
  expect(loops).toContain('1 uncommitted change');
  // Back returns to the board, and the filter comes back with it.
  await win.click('#ws-back');
  await win.waitForSelector('#projects-board:not([hidden])', { timeout: 10_000 });
  const filterBack = await win.evaluate(() => document.getElementById('projects-search').hidden);
  expect(filterBack).toBe(false);
  await app.close();
});

test('a non-git folder degrades to a plain workspace, not an error', async () => {
  const { app, win } = await launchApp();
  await openBoard(win);
  await win.waitForSelector('#projects-board .ws-group', { timeout: 15_000 });
  await win.click('#projects-board .ws-row[data-id="p-plain"]');
  await win.waitForSelector('#project-workspace:not([hidden])', { timeout: 10_000 });
  const info = await win.evaluate(() => ({
    title: document.querySelector('#project-workspace .ws-title').textContent.trim(),
    details: document.querySelector('#project-workspace .ws-details').textContent,
    panelHeads: [...document.querySelectorAll('#project-workspace .ws-panel-head')].map((n) => n.textContent.trim()),
    loopsTile: document.querySelectorAll('#project-workspace .ws-tile-value')[1].textContent.trim(),
    crumb: document.querySelector('#project-workspace .ws-crumbs').textContent.replace(/\s+/g, ' ').trim(),
  }));
  expect(info.title).toContain('Plain');
  expect(info.details).toContain('Not a git repository');
  // A clean folder earns no loops panel; the tile already says all clear.
  expect(info.panelHeads).not.toContain('Open loops');
  expect(info.loopsTile).toBe('0');
  expect(info.crumb).toContain('Projects');
  expect(info.crumb).toContain('Plain');
  await app.close();
});

test('the active project offers no launch button, and Add project hides in a workspace', async () => {
  const { app, win } = await launchApp();
  await openBoard(win);
  await win.evaluate(async () => {
    await window.husk.projects.setActive('p-alpha'); // eslint-disable-line no-undef
    await renderProjects(); // eslint-disable-line no-undef
  });
  await win.waitForSelector('#projects-board .ws-row', { timeout: 10_000 });
  const board = await win.evaluate(() => ({
    activeRowButtons: [...document.querySelectorAll('#projects-board .ws-row[data-id="p-alpha"] .ws-launch')].length,
    otherRowButtons: [...document.querySelectorAll('#projects-board .ws-row[data-id="p-plain"] .ws-launch')].length,
  }));
  expect(board.activeRowButtons).toBe(0);
  expect(board.otherRowButtons).toBe(1);
  await win.click('#projects-board .ws-row[data-id="p-alpha"]');
  await win.waitForSelector('#project-workspace:not([hidden])', { timeout: 10_000 });
  const ws = await win.evaluate(() => ({
    hasLaunch: !!document.getElementById('ws-launch'),
    addHidden: document.getElementById('btn-projects-new').hidden,
  }));
  expect(ws.hasLaunch).toBe(false);
  expect(ws.addHidden).toBe(true);
  await win.click('#ws-back');
  await win.waitForSelector('#projects-board:not([hidden])', { timeout: 10_000 });
  const addBack = await win.evaluate(() => document.getElementById('btn-projects-new').hidden);
  expect(addBack).toBe(false);
  await app.close();
});
