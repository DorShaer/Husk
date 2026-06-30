'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
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
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

test('AI tool selector sits at the bottom, above Preferences (issue 7)', async () => {
  const app = await launch();
  const win = await ready(app);
  const order = await win.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#rail *'));
    const idx = (sel) => items.indexOf(document.querySelector(sel));
    return {
      autonomy: idx('#rail-autonomy'),
      toolPill: idx('#rail-agent-pill'),
      prefs: idx('#btn-open-prefs'),
    };
  });
  // Tool pill is now after the nav items and immediately before Preferences.
  expect(order.toolPill).toBeGreaterThan(order.autonomy);
  expect(order.prefs).toBeGreaterThan(order.toolPill);
  await app.close();
});

test('rail stacks above the pages column so tooltips are not hidden (issue 6)', async () => {
  const app = await launch();
  const win = await ready(app);
  const z = await win.evaluate(() => getComputedStyle(document.getElementById('rail')).zIndex);
  expect(z).toBe('40');
  await app.close();
});

test('autonomy wizard has an optional snapshot toggle and unlimited-cap hints (issues 2, 8)', async () => {
  const app = await launch();
  const win = await ready(app);
  const info = await win.evaluate(() => {
    const toggle = document.getElementById('aut-snapshot-toggle');
    const hint = Array.from(document.querySelectorAll('#autonomy-start-modal .mig-hint'))
      .map((e) => e.textContent).join(' ');
    return {
      hasToggle: !!toggle,
      checkedByDefault: !!(toggle && toggle.checked),
      hint,
      capMinMin: document.getElementById('aut-cap-min').getAttribute('min'),
      capTokMin: document.getElementById('aut-cap-tok').getAttribute('min'),
      capUsdMin: document.getElementById('aut-cap-usd').getAttribute('min'),
    };
  });
  expect(info.hasToggle).toBe(true);
  expect(info.checkedByDefault).toBe(true);
  expect(info.hint.toLowerCase()).toContain('0 for unlimited');
  expect(info.capMinMin).toBe('0');
  expect(info.capTokMin).toBe('0');
  expect(info.capUsdMin).toBe('0');
  await app.close();
});

test('rapid theme toggling coalesces config writes and never throws (issue 3)', async () => {
  const app = await launch();
  const win = await ready(app);
  const result = await win.evaluate(async () => {
    // Spy on the persisted write so we can prove rapid clicks coalesce.
    let calls = 0;
    const orig = window.husk.config.set;
    window.husk.config.set = (patch) => { calls += 1; return orig(patch); };
    const start = document.body.dataset.theme;
    // The dark/light topbar toggle was removed; theme changes now go through the
    // Preferences theme select. Fire rapid changes to prove the writes coalesce.
    const sel = document.getElementById('pref-theme');
    for (let i = 0; i < 12; i++) { sel.value = (i % 2 === 0) ? 'light' : 'dark'; sel.dispatchEvent(new Event('change')); }
    const afterClicks = document.body.dataset.theme;
    await new Promise((r) => setTimeout(r, 400));
    window.husk.config.set = orig;
    return { start, afterClicks, calls, sel: document.getElementById('pref-theme').value };
  });
  // 12 fast clicks -> at most a couple of disk writes, not 12.
  expect(result.calls).toBeLessThanOrEqual(2);
  // UI stayed responsive and consistent.
  expect(['dark', 'light']).toContain(result.afterClicks);
  expect(result.sel).toBe(result.afterClicks);
  await app.close();
});

test('copy from the terminal context menu keeps focus in the terminal (issue 5)', async () => {
  const app = await launch();
  const win = await ready(app);
  const focused = await win.evaluate(async () => {
    setPage('chat');
    // Cold boot shows the welcome screen with no terminal yet; start the agent
    // so a tab (and its terminal) exists before exercising copy.
    try { await startPty(); } catch (_) {}
    for (let i = 0; i < 100 && !term; i++) await new Promise((r) => setTimeout(r, 20));
    try { term.write('hello selection'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 50));
    try { term.selectAll(); } catch (_) {}
    const copyBtn = document.querySelector('#terminal-ctx-menu [data-action="copy"]');
    copyBtn.click();
    await new Promise((r) => setTimeout(r, 50));
    const ae = document.activeElement;
    return ae ? (ae.className || ae.tagName) : 'none';
  });
  expect(String(focused)).toContain('xterm-helper-textarea');
  await app.close();
});

test('the start wizard cannot be dismissed while a run is launching (issue 1)', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(() => {
    openAutonomyStart();
    const modal = document.getElementById('autonomy-start-modal');
    // Simulate the mid-launch window.
    autonomyStarting = true;
    closeAutonomyStart();
    const blockedClose = !modal.hidden; // backdrop/close button path
    // Esc path
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const blockedEsc = !modal.hidden;
    // Once launch finishes the wizard closes normally again.
    autonomyStarting = false;
    closeAutonomyStart();
    const closesAfter = modal.hidden;
    return { blockedClose, blockedEsc, closesAfter };
  });
  expect(r.blockedClose).toBe(true);
  expect(r.blockedEsc).toBe(true);
  expect(r.closesAfter).toBe(true);
  await app.close();
});

test('a running autonomy session stays visible when revisiting the tab (issue 1)', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(async () => {
    autonomyActive = true;
    setPage('autonomy');
    const live1 = !document.getElementById('aut-page-live').hidden;
    // Navigate away and back; the running view must be restored, not the empty state.
    setPage('chat');
    setPage('autonomy');
    const live2 = !document.getElementById('aut-page-live').hidden;
    const empty2 = document.getElementById('aut-page-empty').hidden;
    const isLive = document.querySelector('.page-autonomy').classList.contains('is-live');
    // Cleanup: stop timers/pollers before the app closes.
    autonomyActive = false;
    paintAutonomyBanner();
    return { live1, live2, empty2, isLive };
  });
  expect(r.live1).toBe(true);
  expect(r.live2).toBe(true);
  expect(r.empty2).toBe(true);
  expect(r.isLive).toBe(true);
  await app.close();
});

test('Revert is hidden for runs with no snapshot, shown otherwise (review + end modal)', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(() => {
    // Review mode footer button.
    autonomyReview = true;
    autonomyReviewData = { sessionId: 's', workspaceRoot: '/w', summary: { ok: true, hasSnapshot: false } };
    paintAutonomyBanner();
    const reviewRevertHiddenNoSnap = document.getElementById('aut-review-revert').hidden;
    autonomyReviewData.summary.hasSnapshot = true;
    paintAutonomyBanner();
    const reviewRevertShownWithSnap = !document.getElementById('aut-review-revert').hidden;
    autonomyReview = false;
    autonomyReviewData = null;
    paintAutonomyBanner();

    // End-of-run modal button.
    const baseSum = { ok: true, summary: { status: 'ended', haltReason: 'natural' }, eventCount: 0, chain: { valid: true }, diff: [] };
    openAutonomyEndModal({ ...baseSum, hasSnapshot: false });
    const endRevertHiddenNoSnap = document.getElementById('aut-end-revert').hidden;
    openAutonomyEndModal({ ...baseSum, hasSnapshot: true });
    const endRevertShownWithSnap = !document.getElementById('aut-end-revert').hidden;
    closeAutonomyEndModal();
    return { reviewRevertHiddenNoSnap, reviewRevertShownWithSnap, endRevertHiddenNoSnap, endRevertShownWithSnap };
  });
  expect(r.reviewRevertHiddenNoSnap).toBe(true);
  expect(r.reviewRevertShownWithSnap).toBe(true);
  expect(r.endRevertHiddenNoSnap).toBe(true);
  expect(r.endRevertShownWithSnap).toBe(true);
  await app.close();
});

test('window can shrink small enough to trigger responsive layout (issue 4)', async () => {
  const app = await launch();
  await ready(app);
  const min = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w.getMinimumSize(); // [width, height]
  });
  expect(min[0]).toBeLessThanOrEqual(760);
  await app.close();
});
