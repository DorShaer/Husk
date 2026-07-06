'use strict';

// Guard against accidentally stopping an autopilot run via the keyboard.
// The Stop control opens a confirm dialog; the dialog binds a document-level
// keydown where Enter == confirm. If a single Enter both opens the dialog and
// then confirms it (keydown bleed-through), or if an Enter meant for the
// terminal reaches an open confirm, a live run dies without the user meaning
// to. This drives the real Stop button with the keyboard and asserts a lone
// Enter does not sail through to cancel.

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
    firstRunDone: true, skipWelcome: true, lastSeenVersion: pkgVersion, paiEnabled: false,
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

test('a lone Enter on the Stop button does not sail through the confirm and cancel the run', async () => {
  test.setTimeout(120_000);
  const projectDir = makeProjectRepo();
  const app = launchWithProject(projectDir);
  const win = await ready(await app);

  await win.evaluate(() => {
    window.__cancelCalls = [];
    const orig = window.husk.autopilot.cancel;
    window.husk.autopilot.cancel = (d) => { window.__cancelCalls.push(d); return orig(d); };
  });

  const started = await win.evaluate(async () => window.husk.autopilot.start({
    goal: 'e2e: keep working', caps: { minutes: 30, tokens: 0, dollars: 0 }, snapshot: false,
  }));
  expect(started && started.ok).toBe(true);
  const runId = started.runId;

  await win.waitForFunction(async () => {
    const r = await window.husk.autopilot.list();
    return r && r.ok && r.runs.length === 1;
  }, null, { timeout: 15_000 });

  // Land on the autopilot page where the Stop button is live, focus it, and
  // press Enter ONCE. This is the keydown that opens the confirm dialog; a
  // well-behaved dialog must not treat the same/immediately-following Enter as
  // the confirmation.
  await win.evaluate(() => {
    setPage('autopilot');
    const btn = document.querySelector('#aut-page-stop-top');
    if (btn) { btn.hidden = false; btn.focus(); }
  });
  await win.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 400));

  // A confirm dialog may now be open with its OK auto-focused. An Enter that
  // the user types into the terminal (or a reflexive second Enter) should be
  // the ONLY way to confirm; but we assert the run is NOT already cancelled
  // from the single Enter above.
  const afterOne = await win.evaluate(() => ({
    cancelCalls: window.__cancelCalls.slice(),
    confirmOpen: !document.getElementById('confirm-modal').hidden,
  }));
  expect(afterOne.cancelCalls, `single Enter cancelled the run: ${JSON.stringify(afterOne.cancelCalls)}`).toEqual([]);

  // Dismiss any open confirm and verify the run is still alive.
  await win.evaluate(() => {
    const m = document.getElementById('confirm-modal');
    if (m && !m.hidden) { const c = document.getElementById('confirm-cancel'); if (c) c.click(); }
  });
  const list = await win.evaluate(async () => window.husk.autopilot.list());
  expect(list.runs.map((r) => r.runId)).toContain(runId);

  await win.evaluate(async (rid) => window.husk.autopilot.cancel({ runId: rid }), runId);
  await (await app).close();
});
