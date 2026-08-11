'use strict';

// The agent command center: the overlay listing every background agent beside a
// live detail pane. These checks pin the load order (skeleton, rows, detail),
// the three-band grouping, both filter axes, keyboard reach, and the live feed
// read off the transcript. Each state is also photographed for visual review.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHOT_DIR = path.join(REPO_ROOT, 'test-results', 'agent-center');

const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// A fleet shaped like a real evening of work: one agent waiting on a human,
// two running, a spread of finished ones, across two projects.
function makeFleet(now, projects) {
  const [husk, dist] = projects;
  const mk = (shortId, sessionId, name, cwd, state, startedMin, pid) => ({
    kind: 'background', id: shortId, sessionId, name, cwd,
    state, status: state, startedAt: now - startedMin * 60_000, ...(pid ? { pid } : {}),
  });
  return [
    mk('agent-rev', '96cb2d85-26b1-4dc7-abb3-467de954ff69', 'Review security workflow hardening', husk, 'blocked', 46, 4021),
    mk('agent-pub', 'a1b2c3d4-1111-4dc7-abb3-000000000001', 'Fix publishing and improve agent map UX', husk, 'working', 12, 4022),
    mk('agent-npm', 'a1b2c3d4-2222-4dc7-abb3-000000000002', 'Audit Shai Hulud NPM advisory', husk, 'working', 3, 4023),
    mk('agent-unc', 'a1b2c3d4-3333-4dc7-abb3-000000000003', 'Review Husk uncommitted changes', husk, 'done', 60 * 29),
    mk('agent-pusha', 'a1b2c3d4-4444-4dc7-abb3-000000000004', 'Push uncommitted changes and tag', husk, 'done', 60 * 51),
    mk('agent-redes', 'a1b2c3d4-5555-4dc7-abb3-000000000005', 'Redesign Husk workflow page', husk, 'done', 60 * 78),
    mk('agent-heads', 'a1b2c3d4-6666-4dc7-abb3-000000000006', 'Investigate HeadsUp test flake', husk, 'done', 60 * 96),
    mk('agent-sym', 'a1b2c3d4-7777-4dc7-abb3-000000000007', 'Review symlink traversal security fix', husk, 'done', 60 * 120),
    mk('agent-resume', 'a1b2c3d4-8888-4dc7-abb3-000000000008', 'resume-background-agent-work', dist, 'done', 60 * 130),
  ];
}

function writeTranscript(homeDir, cwd, sessionId, name) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const t = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: `${name}. Work autonomously and report back.` }, timestamp: t(45), cwd, session_id: sessionId },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Starting with a scan of the workflow files to map what runs on release.' }] }, timestamp: t(44) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Read', input: { file_path: `${cwd}/.github/workflows/release.yml` } }] }, timestamp: t(43) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'secrets\\.' } }] }, timestamp: t(40) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'The release job exposes the npm token to the build step. Drafting a split so publish runs in its own job with least privilege.' }] }, timestamp: t(30) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/.github/workflows/release.yml` } }] }, timestamp: t(22) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'act -j release --dryrun' } }] }, timestamp: t(12) },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Dry run passes. I need permission to push the workflow change to a branch.' }] }, timestamp: t(2) },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeJob(homeDir, shortId, job) {
  const dir = path.join(homeDir, '.claude', 'jobs', shortId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ updatedAt: Date.now(), ...job }));
}

function makeHome({ empty = false } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-agent-center-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
  }));
  const husk = path.join(homeDir, 'code', 'husk');
  const dist = path.join(homeDir, 'code', 'dist');
  fs.mkdirSync(husk, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });

  const now = Date.now();
  const fleet = empty ? [] : makeFleet(now, [husk, dist]);
  for (const a of fleet) writeTranscript(homeDir, a.cwd, a.sessionId, a.name);
  if (!empty) {
    writeJob(homeDir, 'agent-rev', { state: 'blocked', needs: 'Permission to push the workflow change', detail: 'Waiting for approval to push to feature/release-hardening', intent: 'Harden the release workflow: split publish into a least-privilege job and pin third-party actions.', tokens: 48231 });
    writeJob(homeDir, 'agent-pub', { state: 'working', detail: 'Editing src/renderer/app.js, wiring the live feed', intent: 'Fix npm publish provenance and rework the agent map into a list view.', tokens: 22110 });
    writeJob(homeDir, 'agent-npm', { state: 'working', detail: 'Cross-checking lockfile against advisory list', intent: 'Audit dependencies against the Shai Hulud npm advisory.', tokens: 9040 });
    writeJob(homeDir, 'agent-unc', { state: 'done', detail: 'Reviewed 14 files; left notes in REVIEW.md', tokens: 61200 });
  }
  const agentsFile = path.join(homeDir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify(fleet));
  return { homeDir, agentsFile, husk, dist };
}

function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  const shim = path.join(fixtureBin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      FAKE_AGENTS_FILE: env.agentsFile,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
}

async function openCenter(app, { width = 1512, height = 950 } = {}) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, ...size });
  }, { width, height });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => openAgentMap());               // eslint-disable-line no-undef
  return win;
}

// The center opens on the spawn graph; the list checks below are about the list.
async function useList(win) {
  await win.click('[data-am-view="list"]');
}

async function shoot(win, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await win.screenshot({ path: path.join(SHOT_DIR, name) });
}

test('the center lists the fleet grouped by state, detail pane live', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openCenter(app);

  await win.waitForSelector('.am-node', { timeout: 15_000 });
  await useList(win);
  // The center opens on live work; the grouping below is about the whole fleet.
  await win.click('[data-am-filter="all"]');
  await win.waitForSelector('.am-row', { timeout: 15_000 });

  // Grouped: the human-blocking band leads, then running, then finished.
  const sections = await win.$$eval('.am-sect', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')));
  expect(sections).toEqual(['Needs you 1', 'Running 2', 'Finished 6']);
  expect(await win.locator('.am-row').count()).toBe(9);

  // Counts land on the filter chips.
  await expect(win.locator('#am-n-all')).toHaveText('9');
  await expect(win.locator('#am-n-live')).toHaveText('3');
  await expect(win.locator('#am-n-blocked')).toHaveText('1');
  await expect(win.locator('#am-n-running')).toHaveText('2');
  await expect(win.locator('#am-n-done')).toHaveText('6');

  // The blocked agent is auto-selected and its feed reads off the transcript.
  await expect(win.locator('.am-row.is-selected .am-row-name')).toHaveText('Review security workflow hardening');
  await expect(win.locator('#am-d-state')).toHaveText('Needs you');
  await win.waitForSelector('#am-d-feed li.k-tool', { timeout: 10_000 });
  const feedTools = await win.$$eval('#am-d-feed li.k-tool .fk', (els) => els.map((e) => e.textContent.trim()));
  expect(feedTools).toContain('Edit');
  await expect(win.locator('#am-d-facts')).toContainText('claude-opus-5');

  // A project chip appears only on rows away from the dominant project, so
  // the common case never repeats itself down the list.
  const chips = await win.$$eval('.am-row-proj', (els) => els.map((e) => e.textContent));
  expect(chips).toEqual(['dist']);

  await win.waitForTimeout(350);
  await shoot(win, 'center-dark.png');

  // Keyboard: arrows move the selection, the detail pane follows.
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.am-row.is-selected .am-row-name')).toHaveText('Audit Shai Hulud NPM advisory');
  await expect(win.locator('#am-d-state')).toHaveText('Running');

  // Filter to running only.
  await win.click('[data-am-filter="running"]');
  expect(await win.locator('.am-row').count()).toBe(2);
  await shoot(win, 'center-filter-running.png');

  // Search narrows and the blank state is worded when nothing matches.
  await win.click('[data-am-filter="all"]');
  await win.fill('#am-search-input', 'workflow');
  expect(await win.locator('.am-row').count()).toBe(2);
  await win.fill('#am-search-input', 'zzz-nothing');
  await expect(win.locator('#am-blank-t')).toHaveText('No matches');
  await shoot(win, 'center-no-match.png');
  await win.fill('#am-search-input', '');

  // Esc closes the overlay.
  await win.keyboard.press('Escape');
  await expect(win.locator('#agent-map')).toBeHidden();

  await app.close();
});

test('an empty machine says so instead of showing a void', async () => {
  const env = makeHome({ empty: true });
  const app = await launch(env);
  const win = await openCenter(app);
  await win.waitForSelector('#am-blank:not([hidden])', { timeout: 15_000 });
  await expect(win.locator('#am-blank-t')).toHaveText('No agents yet');

  // The illustration carries this state, so it has to actually arrive: a bad
  // path renders an empty box that still passes every other check here.
  const art = await win.evaluate(() => {
    const el = document.querySelector('#am-blank-art');
    if (!el) return { missing: true };
    return { hidden: el.hidden, src: el.getAttribute('src'),
      loaded: el.complete && el.naturalWidth > 0, w: el.naturalWidth };
  });
  expect(art.missing, 'the empty state has no illustration').toBeUndefined();
  expect(art.hidden, 'the illustration is hidden on an empty machine').toBe(false);
  expect(art.loaded, `the illustration did not load from ${art.src}`).toBe(true);
  // The plain glyph is the fallback for failures, not a second thing on screen.
  await expect(win.locator('#am-blank-icon')).toBeHidden();

  await win.waitForTimeout(250);
  await shoot(win, 'center-empty.png');
  await app.close();
});

test('the center holds in the light theme', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openCenter(app);
  await win.waitForSelector('.am-node', { timeout: 15_000 });
  await useList(win);
  await win.click('[data-am-filter="all"]');
  await win.waitForSelector('.am-row', { timeout: 15_000 });
  // Boot repaints the saved theme when its config load lands, which can revert
  // an early switch. Keep applying until the switch survives a full second.
  await win.waitForFunction(() => {
    if (document.body.dataset.theme !== 'light') {
      try { applyTheme('light'); } catch (_) {}          // eslint-disable-line no-undef
      window.__lightSince = 0;
      return false;
    }
    window.__lightSince = window.__lightSince || Date.now();
    return Date.now() - window.__lightSince > 1000;
  }, null, { timeout: 20_000, polling: 200 });
  await win.waitForSelector('#am-d-feed li', { timeout: 10_000 });
  await win.waitForTimeout(350);
  await shoot(win, 'center-light.png');
  await app.close();
});
