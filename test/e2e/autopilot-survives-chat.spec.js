'use strict';

// An active autopilot run owns a dedicated PTY and worktree. Navigating to Chat
// and opening a chat session must not affect that run's lifecycle or live view.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'long-running-cli.js');

function makeProjectRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-proj-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email e2e@husk.test && git config user.name husk-e2e', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'e2e project\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

function launchWithProject(projectDir) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-ap-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    lastSeenVersion: pkgVersion,
    paiEnabled: false,
    voice: { enabled: false, name: 'en_US-amy-medium', rate: 1.0 },
    agentCommand: `node ${FIXTURE}`,
    projects: [{ id: 'p1', name: 'e2e-proj', path: projectDir }],
    activeProjectId: 'p1',
  }, null, 2));
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => document.body && document.body.dataset.rail);
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

test('an active autopilot run survives navigating to chat', async () => {
  test.setTimeout(120_000);
  const projectDir = makeProjectRepo();
  const app = await launchWithProject(projectDir);
  const win = await ready(app);

  // Record every run-terminating event so a failure names its reason.
  await win.evaluate(() => {
    window.__apEvents = [];
    window.husk.autopilot.onEnded((p) => window.__apEvents.push({ ev: 'ended', p }));
    window.husk.autopilot.onHalt((p) => window.__apEvents.push({ ev: 'halt', p }));
  });

  // Start the run and immediately exercise chat navigation before the
  // autopilot:started event is delivered.
  const started = await win.evaluate(async () => {
    const p = window.husk.autopilot.start({
      goal: 'e2e: keep working, never finish',
      caps: { minutes: 30, tokens: 0, dollars: 0 },
      snapshot: false,
    });
    // Do NOT await: navigate while the start is still in flight.
    setPage('chat');
    const tab = createTab();
    activateTab(tab.id);
    window.husk.pty.start({ cols: 100, rows: 30, sessionId: tab.id, resumeLast: false });
    return p;
  });
  expect(started && started.ok).toBe(true);
  const runId = started.runId;

  // The run's agent PTY must be up and streaming before we navigate away.
  await win.waitForFunction(async () => {
    const r = await window.husk.autopilot.list();
    return r && r.ok && r.runs.length === 1;
  }, null, { timeout: 15_000 });

  // Spy on the cancel IPC so a stray invocation is caught even if the run
  // has not fully torn down yet.
  await win.evaluate(() => {
    window.__cancelCalls = [];
    const orig = window.husk.autopilot.cancel;
    window.husk.autopilot.cancel = (d) => { window.__cancelCalls.push(d); return orig(d); };
  });

  // Hammer the interactions a user performs from chat: type + Enter into the
  // terminal, cycle pages, Tab-to-focus then Enter (which lands on whatever
  // control is focusable), and the mouse back/forward buttons. None of these
  // may end the run.
  await win.evaluate(async () => {
    const press = (key, target) => (target || document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    for (let i = 0; i < 5; i++) { press('a'); press('Enter'); }
    // Focus-walk with Tab then confirm-style Enter/Space several times.
    for (let i = 0; i < 12; i++) {
      const el = document.activeElement;
      press('Tab', el);
      press('Enter', document.activeElement);
      press(' ', document.activeElement);
    }
    // Mouse back/forward gestures.
    window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true }));
    // Page cycling.
    setPage('autopilot'); setPage('chat'); setPage('files'); setPage('chat');
  });

  // Give the chat session time to spawn, settle, and for any watchdog or
  // lifecycle fallout to land. The run must still be alive the whole time.
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const state = await win.evaluate(async () => ({
      list: await window.husk.autopilot.list(),
      events: window.__apEvents,
      cancelCalls: window.__cancelCalls,
      activeFlag: typeof autopilotActive !== 'undefined' ? autopilotActive : null,
    }));
    expect(state.cancelCalls, `stray cancel IPC after ${(i + 1) * 2}s: ${JSON.stringify(state.cancelCalls)}`).toEqual([]);
    expect(state.events, `run-terminating events after ${(i + 1) * 2}s: ${JSON.stringify(state.events)}`).toEqual([]);
    expect(state.list.runs.map((r) => r.runId)).toContain(runId);
  }

  // Back on the autopilot page the run must still render as live, and the
  // run's own card + lane (its live view) must still be present. A user
  // reads an empty autopilot page as "the run was destroyed".
  const uiLive = await win.evaluate(() => {
    setPage('autopilot');
    const cards = [...document.querySelectorAll('#aut-fleet-list .aut-agent-row[data-rid]')].map((r) => r.dataset.rid);
    const lanes = [...document.querySelectorAll('#aut-lanes .aut-lane')].map((l) => l.dataset.key);
    return {
      activeFlag: autopilotActive,
      liveShown: !document.querySelector('#aut-page-live').hidden,
      cardCount: cards.length,
      laneCount: lanes.length,
      activeRunsSize: (typeof activeRuns !== 'undefined') ? activeRuns.size : -1,
    };
  });
  expect(uiLive.activeFlag).toBe(true);
  expect(uiLive.liveShown).toBe(true);
  expect(uiLive.activeRunsSize, 'renderer lost the run from activeRuns').toBeGreaterThan(0);
  expect(uiLive.cardCount, 'run card missing after chat round-trip').toBeGreaterThan(0);
  expect(uiLive.laneCount, 'run lane missing after chat round-trip').toBeGreaterThan(0);

  await win.evaluate(async (rid) => window.husk.autopilot.cancel({ runId: rid }), runId);
  await app.close();
});
