'use strict';

// Memory and stability profile of the real Electron app. Each phase drives a
// churn loop (navigation, themes, tabs, terminal flood, list repaints) and
// samples process memory and renderer DOM/heap before and after. The test
// fails only on hard problems (crash, runaway growth, leaked tabs); everything
// else lands in a metrics report written to test-results/perf-report.json for
// human analysis.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FLOOD_CLI = path.join(__dirname, 'fixtures', 'flood-cli.js');
const LONG_CLI = path.join(REPO_ROOT, 'test', 'e2e', 'fixtures', 'long-running-cli.js');
const REPORT_PATH = path.join(REPO_ROOT, 'test-results', 'perf-report.json');

const PAGES = ['chat', 'agents', 'workflows', 'autopilot', 'projects', 'prompts', 'skills', 'sessions', 'files', 'mcp', 'plugins'];
const THEMES = ['midnight', 'dark', 'tokyo-night', 'catppuccin', 'rose-pine', 'gruvbox', 'nord', 'dracula', 'light', 'sepia'];

function makeIsolatedHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-perf-'));
  fs.mkdirSync(path.join(dir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    agentCommand: `node ${LONG_CLI}`,
    agentName: 'PerfAgent',
    theme: 'midnight',
    accent: 'orange',
  }, null, 2));
  return dir;
}

// One combined sample: per-process memory from the main process plus renderer
// heap and DOM shape. Waits briefly first so pending rAF/interval work from
// the churn loop settles before measuring.
async function sample(app, win, label) {
  await win.waitForTimeout(1500);
  const procs = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({
    type: m.type,
    pid: m.pid,
    workingSetKB: m.memory.workingSetSize,
    cpuPercent: Number(m.cpu.percentCPUUsage.toFixed(1)),
  })));
  const renderer = await win.evaluate(() => {
    if (typeof window.gc === 'function') { try { window.gc(); } catch (_) {} }
    const mem = performance.memory || {};
    return {
      jsHeapUsedMB: Number(((mem.usedJSHeapSize || 0) / 1048576).toFixed(1)),
      domNodes: document.getElementsByTagName('*').length,
      tabs: (typeof TABS !== 'undefined') ? TABS.size : -1,
      detachedTerms: document.querySelectorAll('.terminal-instance').length,
    };
  });
  const totalWssMB = Number((procs.reduce((s, p) => s + p.workingSetKB, 0) / 1024).toFixed(0));
  return { label, at: Date.now(), totalWssMB, procs, renderer };
}

function mb(kb) { return Number((kb / 1024).toFixed(0)); }

test('memory and stability profile', async () => {
  const homeDir = makeIsolatedHome();
  const consoleErrors = [];
  const app = await electron.launch({
    args: [
      path.join(REPO_ROOT, 'src', 'main.js'),
      '--no-sandbox',
      // Let the harness force GC before heap samples so trends are real
      // allocations, not collector lag.
      '--js-flags=--expose-gc',
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
  app.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => document.body && document.body.dataset.rail);
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.waitForTimeout(4000); // boot settle: first PTY spawn, initial polls

  const samples = [];
  samples.push(await sample(app, win, 'baseline'));

  // ── Phase 1: page navigation churn ────────────────────────────────────────
  for (let cycle = 0; cycle < 15; cycle++) {
    for (const p of PAGES) {
      await win.evaluate((name) => setPage(name), p);
      await win.waitForTimeout(25);
    }
  }
  await win.evaluate(() => setPage('chat'));
  samples.push(await sample(app, win, 'after nav churn (15 cycles x 11 pages)'));

  // ── Phase 2: theme churn ─────────────────────────────────────────────────
  for (let round = 0; round < 3; round++) {
    for (const t of THEMES) {
      await win.evaluate((theme) => applyTheme(theme), t);
      await win.waitForTimeout(30);
    }
  }
  await win.evaluate(() => applyTheme('midnight'));
  samples.push(await sample(app, win, 'after theme churn (3 rounds x 10 themes)'));

  // ── Phase 3: chat tab churn (PTY spawn + xterm dispose) ──────────────────
  const command = `node ${LONG_CLI}`;
  for (let i = 0; i < 12; i++) {
    const tabId = await win.evaluate(async (cmd) => {
      const tab = await openNewChatTab({ command: cmd, skipContext: true, silent: true });
      return tab ? tab.id : null;
    }, command);
    expect(tabId).toBeTruthy();
    await win.waitForTimeout(350);
    await win.evaluate((id) => closeTab(id), tabId);
    await win.waitForTimeout(250);
  }
  const tabsLeft = await win.evaluate(() => TABS.size);
  expect(tabsLeft, 'tab churn must not leak tabs').toBe(1);
  samples.push(await sample(app, win, 'after tab churn (12 open/close)'));

  // ── Phase 4: terminal output flood ───────────────────────────────────────
  const floodTabId = await win.evaluate(async (cmd) => {
    const tab = await openNewChatTab({ command: cmd, skipContext: true, silent: true });
    return tab ? tab.id : null;
  }, `node ${FLOOD_CLI}`);
  expect(floodTabId).toBeTruthy();
  await win.waitForTimeout(600);
  for (let burst = 0; burst < 4; burst++) {
    await win.evaluate((id) => window.husk.pty.write('\r', id), floodTabId);
    await win.waitForTimeout(2500);
  }
  const buffer = await win.evaluate((id) => {
    const tab = TABS.get(id);
    if (!tab || !tab.term) return null;
    const b = tab.term.buffer.active;
    return { lines: b.length, scrollbackCap: tab.term.options.scrollback || 1000 };
  }, floodTabId);
  samples.push(await sample(app, win, 'after output flood (4 bursts x 5000 lines)'));
  expect(buffer, 'flood tab must still be alive').toBeTruthy();
  // xterm must cap its buffer at scrollback + viewport, not retain the flood.
  expect(buffer.lines).toBeLessThanOrEqual(buffer.scrollbackCap + 100);
  await win.evaluate((id) => closeTab(id), floodTabId);
  await win.waitForTimeout(300);

  // ── Phase 5: sidebar list repaint churn ──────────────────────────────────
  for (let i = 0; i < 30; i++) {
    await win.evaluate(async () => { await refreshRecentList(); renderTabStrip(); });
    await win.waitForTimeout(20);
  }
  samples.push(await sample(app, win, 'after list repaint churn (30x)'));

  // ── Phase 6: idle stability ──────────────────────────────────────────────
  await win.waitForTimeout(10_000); // background intervals keep running
  samples.push(await sample(app, win, 'after 10s idle'));

  // ── Report ───────────────────────────────────────────────────────────────
  const gcAvailable = await win.evaluate(() => typeof window.gc === 'function');
  const report = {
    generatedAt: new Date().toISOString(),
    gcForced: gcAvailable,
    consoleErrors: consoleErrors.slice(0, 40),
    samples,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // Console table for quick reading in CI output.
  // eslint-disable-next-line no-console
  console.log('\nphase | total WSS MB | js heap MB | DOM nodes | tabs');
  for (const s of samples) {
    // eslint-disable-next-line no-console
    console.log(`${s.label} | ${s.totalWssMB} | ${s.renderer.jsHeapUsedMB} | ${s.renderer.domNodes} | ${s.renderer.tabs}`);
  }

  // ── Hard assertions: crash-level regressions only ────────────────────────
  const base = samples[0];
  const last = samples[samples.length - 1];
  // Renderer DOM returns near baseline once the churn ends.
  expect(last.renderer.domNodes).toBeLessThanOrEqual(base.renderer.domNodes * 1.5 + 500);
  // Renderer JS heap stays bounded, with slack for caches, fonts and xterm pools.
  expect(last.renderer.jsHeapUsedMB).toBeLessThanOrEqual(base.renderer.jsHeapUsedMB * 3 + 60);
  // Whole-app working set stays bounded across every process.
  expect(last.totalWssMB).toBeLessThanOrEqual(base.totalWssMB * 2 + 300);
  // The window must still be responsive.
  const alive = await win.evaluate(() => document.body.dataset.page || 'ok');
  expect(alive).toBeTruthy();

  await app.close();
});
