'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Pass `config` to seed the app's config on disk. A test that instead assigns to
// the renderer's cfg races the boot config load, which lands afterwards and puts
// the stored values back.
function launch(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2));
  }
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

test('AI tool selector sits at the bottom, above Preferences', async () => {
  const app = await launch();
  const win = await ready(app);
  const order = await win.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#rail *'));
    const idx = (sel) => items.indexOf(document.querySelector(sel));
    return {
      autopilot: idx('#rail-autopilot'),
      toolPill: idx('#rail-agent-pill'),
      prefs: idx('#btn-open-prefs'),
      betaText: document.querySelector('#rail-autopilot .rail-beta-tag')?.textContent || '',
      headerAutopilotExists: !!document.getElementById('btn-autopilot'),
    };
  });
  // Tool pill sits after the nav items and immediately before Preferences.
  expect(order.toolPill).toBeGreaterThan(order.autopilot);
  expect(order.prefs).toBeGreaterThan(order.toolPill);
  expect(order.betaText).toBe('BETA');
  expect(order.headerAutopilotExists).toBe(false);
  await app.close();
});

test('rail stacks above the pages column so tooltips are not hidden', async () => {
  const app = await launch();
  const win = await ready(app);
  const z = await win.evaluate(() => getComputedStyle(document.getElementById('rail')).zIndex);
  expect(z).toBe('40');
  await app.close();
});

test('autopilot wizard has an optional snapshot toggle and unlimited-cap hints', async () => {
  const app = await launch();
  const win = await ready(app);
  const info = await win.evaluate(() => {
    const toggle = document.getElementById('aut-snapshot-toggle');
    const hint = Array.from(document.querySelectorAll('#autopilot-start-modal .mig-hint'))
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

// The empty state carries an illustration: a graph of node cards plus the
// mascot cloned into its slot. Assert both, so neither half can quietly stop
// rendering and leave a bare block of text.
test('workflows empty state renders its illustration', async () => {
  const app = await launch();
  const win = await ready(app);
  const info = await win.evaluate(async () => {
    setPage('workflows');
    for (let i = 0; i < 40 && !document.querySelector('#wf-grid .empty-state'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const stage = document.querySelector('#wf-grid .empty-state .ek-stage');
    return {
      hasGraph: !!(stage && stage.querySelector('svg.ek-graph')),
      hasMascot: !!(stage && stage.querySelector('.ek-slot svg')),
      text: document.getElementById('wf-grid').textContent.replace(/\s+/g, ' ').trim(),
    };
  });
  expect(info.hasGraph).toBe(true);
  expect(info.hasMascot).toBe(true);
  expect(info.text).toContain('No workflows yet');
  await app.close();
});

test('orchestrator model picker uses provider catalog without overflowing', async () => {
  const app = await launch();
  const win = await ready(app);
  const info = await win.evaluate(async () => {
    cfg = {
      ...(cfg || {}),
      agentCommand: 'copilot',
      modelRouting: { copilot: { cheap: 'devuser:~ +0 -0Session: 0 AIC usedYou must be logged in to select a model. Use /login to authenticate.Plan: no limit, 18 agentsGPT-5.5 1.1M Context', smart: 'claude-sonnet-5' } },
    };
    orchCatalog = {
      loading: true,
      vendor: 'copilot',
      providerLabel: 'GitHub Copilot',
      command: 'copilot',
      flag: '--model',
      source: 'loading',
      sourceLabel: '',
      error: '',
      models: [],
    };
    document.getElementById('aut-orch-modal').hidden = false;
    bindOrchestratorConfig();
    const loadingState = {
      status: document.getElementById('aut-model-status').textContent,
      simpleDisabled: document.getElementById('aut-mr-simple').disabled,
      complexDisabled: document.getElementById('aut-mr-complex').disabled,
      saveDisabled: document.getElementById('aut-mr-save').disabled,
    };
    orchCatalog = {
      loading: false,
      vendor: 'copilot',
      providerLabel: 'GitHub Copilot',
      command: 'copilot',
      flag: '--model',
      source: 'slash-model',
      sourceLabel: 'Read from /model',
      error: '',
      models: [
        { value: 'gpt-5.5', label: 'GPT-5.5' },
        { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
        { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      ],
    };
    bindOrchestratorConfig();
    const modal = document.getElementById('aut-orch-modal');
    const card = modal.querySelector('.modal-card');
    const cardRect = card.getBoundingClientRect();
    const visibleControls = Array.from(card.querySelectorAll('select,input')).filter((el) => !el.hidden);
    const overflow = visibleControls.some((el) => {
      const r = el.getBoundingClientRect();
      return r.left < cardRect.left - 1 || r.right > cardRect.right + 1;
    });
    return {
      title: card.querySelector('.modal-title').textContent,
      provider: document.getElementById('aut-orch-vendor').textContent,
      command: document.getElementById('aut-model-command').textContent,
      status: document.getElementById('aut-model-status').textContent,
      loadingState,
      simpleValue: document.getElementById('aut-mr-simple').value,
      complexValue: document.getElementById('aut-mr-complex').value,
      simpleDisabled: document.getElementById('aut-mr-simple').disabled,
      complexDisabled: document.getElementById('aut-mr-complex').disabled,
      saveDisabled: document.getElementById('aut-mr-save').disabled,
      options: Array.from(document.getElementById('aut-mr-simple').options).map((o) => o.value),
      customValue: document.getElementById('aut-mr-simple-custom').value,
      overflow,
    };
  });
  expect(info.title).toContain('orchestrator models');
  expect(info.provider).toBe('GitHub Copilot');
  expect(info.command).toContain('--model');
  expect(info.loadingState.status).toContain('Checking available models');
  expect(info.loadingState.simpleDisabled).toBe(true);
  expect(info.loadingState.complexDisabled).toBe(true);
  expect(info.loadingState.saveDisabled).toBe(true);
  expect(info.status).toContain('Loaded 3 available models');
  expect(info.simpleValue).toBe('');
  expect(info.complexValue).toBe('claude-sonnet-5');
  expect(info.customValue).toBe('');
  expect(info.simpleDisabled).toBe(false);
  expect(info.complexDisabled).toBe(false);
  expect(info.saveDisabled).toBe(false);
  expect(info.options).toEqual(expect.arrayContaining(['gpt-5.5', 'gpt-5.4-mini', 'claude-sonnet-5']));
  expect(info.options.join(' ')).not.toContain('Session');
  expect(info.overflow).toBe(false);
  await app.close();
});

test('Ctrl+R reloads in place without starting a chat', async () => {
  const app = await launch();
  const win = await ready(app);
  const viewMenu = await app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const view = menu.items.find((item) => item.label === 'View');
    return view.submenu.items.map((item) => ({
      label: item.label,
      role: item.role || '',
      accelerator: item.accelerator || '',
    }));
  });
  expect(viewMenu.some((item) => item.role === 'reload')).toBe(false);
  expect(viewMenu.some((item) => item.label === 'Reload' && item.accelerator === 'CmdOrCtrl+R')).toBe(true);

  await win.evaluate(async () => {
    cfg = await window.husk.config.set({ skipWelcome: true });
    setPage('mcp');
    window.__huskReloadSentinel = 'before';
  });
  await win.addInitScript(() => {
    window.__huskPageTransitions = [];
    const attach = () => {
      if (!document.body) { requestAnimationFrame(attach); return; }
      const record = () => window.__huskPageTransitions.push(document.body.dataset.page || '');
      record();
      new MutationObserver(record).observe(document.body, { attributes: true, attributeFilter: ['data-page'] });
    };
    attach();
  });
  await app.evaluate(async ({ BrowserWindow }) => {
    // Ctrl+R on non-chat pages still reloads in place and must not create a chat.
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    for (let i = 0; i < 5; i++) wc.send('app:reload-shortcut');
  });
  await win.waitForFunction(() => window.__huskReloadSentinel !== 'before' && document.body && document.body.dataset.page === 'mcp', null, { timeout: 10_000 });
  const result = await win.evaluate(async () => {
    const live = await window.husk.pty.list();
    return {
      page: document.body.dataset.page,
      currentPage,
      transitions: window.__huskPageTransitions || [],
      tabCount: TABS.size,
      liveSessions: live && live.ok ? live.sessions.length : -1,
    };
  });
  expect(result.page).toBe('mcp');
  expect(result.currentPage).toBe('mcp');
  expect(result.transitions).not.toContain('chat');
  expect(result.tabCount).toBe(0);
  expect(result.liveSessions).toBe(0);
  await app.close();
});

test('appearance changes preview live and persist only on save', async () => {
  // Stored on disk, so the boot config load agrees with what the test expects
  // rather than overwriting it a moment later.
  const app = await launch({
    theme: 'midnight', accent: 'orange', railExpanded: true, firstRunDone: true,
  });
  const win = await ready(app);
  // Boot loads the config asynchronously. Wait for it, or the assertions below
  // run against whatever cfg held before it landed.
  await win.waitForFunction(() => cfg && cfg.theme === 'midnight');
  await win.evaluate(() => {
    const onboarding = document.getElementById('onboarding');
    if (onboarding) onboarding.hidden = true;
    bindPrefs();
    window.__appearanceReloads = 0;
    reloadRendererPreservingPlace = () => { window.__appearanceReloads += 1; };
  });

  // Changing the theme previews instantly: no dialog, nothing persisted, and
  // the unsaved-changes bar appears.
  await win.evaluate(() => {
    openPrefsModal();
    const sel = document.getElementById('pref-theme');
    sel.value = 'light';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const previewing = await win.evaluate(() => ({
    theme: document.body.dataset.theme,
    savedTheme: cfg.theme,
    barVisible: !document.getElementById('pref-appearance-actions').hidden,
    reloads: window.__appearanceReloads,
  }));
  expect(previewing.theme).toBe('light');
  expect(previewing.savedTheme).toBe('midnight');
  expect(previewing.barVisible).toBe(true);
  expect(previewing.reloads).toBe(0);

  // A second change must keep previewing (the old flow locked up here).
  await win.evaluate(() => {
    const sel = document.getElementById('pref-theme');
    sel.value = 'nord';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const second = await win.evaluate(() => document.body.dataset.theme);
  expect(second).toBe('nord');

  // Cancel restores the saved appearance and hides the bar.
  await win.evaluate(() => document.getElementById('pref-appearance-revert').click());
  const cancelled = await win.evaluate(() => ({
    theme: document.body.dataset.theme,
    savedTheme: cfg.theme,
    selectValue: document.getElementById('pref-theme').value,
    barVisible: !document.getElementById('pref-appearance-actions').hidden,
    reloads: window.__appearanceReloads,
  }));
  expect(cancelled.theme).toBe('midnight');
  expect(cancelled.savedTheme).toBe('midnight');
  expect(cancelled.selectValue).toBe('midnight');
  expect(cancelled.barVisible).toBe(false);
  expect(cancelled.reloads).toBe(0);

  // Save persists the previewed accent and refreshes the UI (non-chat page).
  await win.evaluate(() => {
    setPage('agents');
    document.querySelector('.accent-swatch[data-c="cyan"]').click();
  });
  await win.evaluate(() => document.getElementById('pref-appearance-save').click());
  await win.waitForFunction(() => window.__appearanceReloads === 1);
  const saved = await win.evaluate(() => ({
    accent: cfg.accent,
    reloads: window.__appearanceReloads,
  }));
  expect(saved.accent).toBe('cyan');
  expect(saved.reloads).toBe(1);
  await app.close();
});

test('copy from the terminal context menu keeps focus in the terminal', async () => {
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
    // Focus restoration is async (clipboard write then term.focus); poll for
    // it instead of sampling once, or a slow CI runner reads a stale target.
    for (let i = 0; i < 50; i++) {
      const ae = document.activeElement;
      if (ae && String(ae.className || '').includes('xterm-helper-textarea')) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const ae = document.activeElement;
    return ae ? (ae.className || ae.tagName) : 'none';
  });
  expect(String(focused)).toContain('xterm-helper-textarea');
  await app.close();
});

test('adding a context file types its path and nothing else', async () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-context-source-'));
  const sourcePath = path.join(sourceDir, 'cert.der');
  fs.writeFileSync(sourcePath, 'demo certificate');
  const app = await launch({ firstRunDone: true, agentCommand: 'bash --noprofile --norc', paiEnabled: false });
  const win = await ready(app);
  await win.evaluate(async () => {
    setPage('chat'); // eslint-disable-line no-undef
    try { await startPty(); } catch (_) {} // eslint-disable-line no-undef
    for (let i = 0; i < 100 && !term; i++) await new Promise((r) => setTimeout(r, 20)); // eslint-disable-line no-undef
  });
  const dest = await win.evaluate(async (p) => {
    const r = await attachContextSource(p, 'cert.der'); // eslint-disable-line no-undef
    return r && r.dest ? r.dest : '';
  }, sourcePath);
  expect(dest).toContain('cert.der');
  await win.waitForFunction(() => document.querySelector('#rail-context-list')?.textContent.includes('cert.der'));
  // The terminal wraps at its own width, so compare with whitespace stripped:
  // a path split across two rows is still the path that was typed.
  const flatten = (s) => String(s || '').replace(/\s+/g, '');
  await win.waitForFunction(
    (d) => (document.querySelector('#terminal .xterm-rows')?.innerText || '').replace(/\s+/g, '').includes(d),
    flatten(dest)
  );
  const state = await win.evaluate(() => ({
    rail: document.querySelector('#rail-context-list')?.textContent || '',
    terminal: document.querySelector('#terminal .xterm-rows')?.innerText || '',
  }));
  expect(state.rail).toContain('cert.der');
  // The path is the whole message: the user writes the request around it, and
  // nothing is submitted on their behalf.
  expect(flatten(state.terminal)).toContain(flatten(dest));
  expect(flatten(state.terminal)).not.toContain('Pleaseread');
  await app.close();
});

test('the start wizard cannot be dismissed while a run is launching', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(() => {
    openAutopilotStart();
    const modal = document.getElementById('autopilot-start-modal');
    // Simulate the mid-launch window.
    autopilotStarting = true;
    closeAutopilotStart();
    const blockedClose = !modal.hidden; // backdrop/close button path
    // Esc path
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const blockedEsc = !modal.hidden;
    // Once launch finishes the wizard closes normally again.
    autopilotStarting = false;
    closeAutopilotStart();
    const closesAfter = modal.hidden;
    return { blockedClose, blockedEsc, closesAfter };
  });
  expect(r.blockedClose).toBe(true);
  expect(r.blockedEsc).toBe(true);
  expect(r.closesAfter).toBe(true);
  await app.close();
});

test('a running autopilot session stays visible when revisiting the tab', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(async () => {
    autopilotActive = true;
    setPage('autopilot');
    const live1 = !document.getElementById('aut-page-live').hidden;
    // Navigate away and back; the running view must be restored, not the empty state.
    setPage('chat');
    setPage('autopilot');
    const live2 = !document.getElementById('aut-page-live').hidden;
    const empty2 = document.getElementById('aut-page-empty').hidden;
    const isLive = document.querySelector('.page-autopilot').classList.contains('is-live');
    // Cleanup: stop timers/pollers before the app closes.
    autopilotActive = false;
    paintAutopilotBanner();
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
    autopilotReview = true;
    autopilotReviewData = { sessionId: 's', workspaceRoot: '/w', summary: { ok: true, hasSnapshot: false } };
    paintAutopilotBanner();
    const reviewRevertHiddenNoSnap = document.getElementById('aut-review-revert').hidden;
    autopilotReviewData.summary.hasSnapshot = true;
    paintAutopilotBanner();
    const reviewRevertShownWithSnap = !document.getElementById('aut-review-revert').hidden;
    autopilotReview = false;
    autopilotReviewData = null;
    paintAutopilotBanner();

    // End-of-run modal button.
    const baseSum = { ok: true, summary: { status: 'ended', haltReason: 'natural' }, eventCount: 0, chain: { valid: true }, diff: [] };
    openAutopilotEndModal({ ...baseSum, hasSnapshot: false });
    const endRevertHiddenNoSnap = document.getElementById('aut-end-revert').hidden;
    openAutopilotEndModal({ ...baseSum, hasSnapshot: true });
    const endRevertShownWithSnap = !document.getElementById('aut-end-revert').hidden;
    closeAutopilotEndModal();
    return { reviewRevertHiddenNoSnap, reviewRevertShownWithSnap, endRevertHiddenNoSnap, endRevertShownWithSnap };
  });
  expect(r.reviewRevertHiddenNoSnap).toBe(true);
  expect(r.reviewRevertShownWithSnap).toBe(true);
  expect(r.endRevertHiddenNoSnap).toBe(true);
  expect(r.endRevertShownWithSnap).toBe(true);
  await app.close();
});

test('Autopilot review preserves original mission and marks idle runs incomplete', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(() => {
    setPage('autopilot');
    const summary = {
      ok: true,
      originalGoal: 'Bump dependencies safely',
      goal: "Integrate the team's parallel work: Bump dependencies safely",
      endReason: 'agent_idle',
      summary: {
        status: 'ended',
        haltReason: 'natural',
        haltDetail: { reason: 'agent_idle' },
        durationMs: 1000,
        meter: { totalTokens: 2100, dollars: 0.03, tokensPartial: true },
      },
      diff: [{ path: 'package-lock.json', status: 'modified' }],
      eventCount: 3,
      chain: { valid: true },
    };
    enterReviewMode({ sessionId: 's', workspaceRoot: '/w', summary, retained: true, runId: 'r' });
    const status = document.getElementById('aut-page-status');
    const tokenValue = document.getElementById('aut-page-val-tokens');
    const out = {
      mission: document.getElementById('aut-page-goal-text').textContent,
      statusText: document.getElementById('aut-page-status-text').textContent,
      statusIncomplete: status.classList.contains('is-incomplete'),
      tokenTitle: tokenValue.getAttribute('title') || '',
      conclusion: document.querySelector('.aut-conclusion-title')?.textContent || '',
    };
    autopilotReview = false;
    autopilotReviewData = null;
    paintAutopilotBanner();
    return out;
  });
  expect(r.mission).toBe('Bump dependencies safely');
  expect(r.statusText).toBe('Incomplete');
  expect(r.statusIncomplete).toBe(true);
  expect(r.tokenTitle).toContain('Partial token accounting');
  expect(r.conclusion).toContain('went idle');
  await app.close();
});

test('Autopilot integrator start keeps ended worker fleet totals', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(() => {
    activeRuns.clear();
    plannedAgents = [];
    activeRuns.set('worker-a', {
      groupId: 'g1',
      ended: true,
      budget: { totalTokens: 3200, dollars: 0.02 },
      startedAt: Date.now() - 5000,
    });
    activeRuns.set('worker-b', {
      groupId: 'g1',
      ended: true,
      budget: { totalTokens: 900, dollars: 0.01 },
      startedAt: Date.now() - 4000,
    });
    const sameGroupResets = shouldResetAutopilotForStarted({ groupId: 'g1', role: 'integrator' });
    const newRunResets = shouldResetAutopilotForStarted({ groupId: 'g2', role: 'other' });
    renderUsageStripLive();
    const tokensBefore = document.getElementById('aut-page-val-tokens').textContent;
    return { sameGroupResets, newRunResets, tokensBefore };
  });
  expect(r.sameGroupResets).toBe(false);
  expect(r.newRunResets).toBe(true);
  expect(r.tokensBefore).toContain('4.1k');
  await app.close();
});

test('Autopilot token source label does not flicker after partial accounting appears', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(() => {
    activeRuns.clear();
    plannedAgents = [];
    const run = {
      runId: 'r',
      groupId: 'g',
      ended: false,
      budget: { totalTokens: 1000, outputTokens: 1000, dollars: 0.01, tokensReported: true },
      startedAt: Date.now() - 1000,
    };
    activeRuns.set('r', run);
    renderUsageStripLive();
    const first = document.getElementById('aut-tb-src').textContent;
    run.budget = { totalTokens: 1200, outputTokens: 1200, dollars: 0.02, tokensPartial: true };
    run.tokensPartialSeen = true;
    renderUsageStripLive();
    const second = document.getElementById('aut-tb-src').textContent;
    run.budget = { totalTokens: 1300, outputTokens: 1300, dollars: 0.03, tokensReported: true };
    if (run.tokensPartialSeen) run.budget.tokensPartial = true;
    renderUsageStripLive();
    const third = document.getElementById('aut-tb-src').textContent;
    activeRuns.clear();
    return { first, second, third };
  });
  expect(r.first).toBe('approx · status line');
  expect(r.second).toBe('partial · output/cache only');
  expect(r.third).toBe('partial · output/cache only');
  await app.close();
});

test('window can shrink small enough to trigger responsive layout', async () => {
  const app = await launch();
  await ready(app);
  const min = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w.getMinimumSize(); // [width, height]
  });
  expect(min[0]).toBeLessThanOrEqual(760);
  await app.close();
});

test('Files opens on the pinned project, not the saved tree root', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-project-'));
  fs.writeFileSync(path.join(projectDir, 'inside-project.md'), '# demo\n');
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-other-'));
  fs.writeFileSync(path.join(otherDir, 'outside-project.txt'), 'x');
  const app = await launch({
    firstRunDone: true,
    treeRoot: otherDir,
    projects: [{ id: 'p1', name: 'Demo', path: projectDir, addedAt: '2026-07-25T00:00:00.000Z', lastUsedAt: null }],
    activeProjectId: 'p1',
  });
  const win = await ready(app);
  await win.waitForFunction(() => typeof projectsCache !== 'undefined' && projectsCache.length > 0); // eslint-disable-line no-undef
  await win.evaluate(() => setPage('files')); // eslint-disable-line no-undef
  await win.waitForFunction(
    (p) => (document.querySelector('#files-sub')?.textContent || '') === p,
    projectDir
  );
  const state = await win.evaluate(() => ({
    sub: document.querySelector('#files-sub')?.textContent || '',
    label: document.querySelector('#fx-open-folder-label')?.textContent || '',
    rows: document.querySelector('#fx-list')?.innerText || '',
  }));
  expect(state.sub).toBe(projectDir);
  expect(state.label).toBe(projectDir.split('/').pop());
  expect(state.rows).toContain('inside-project.md');
  expect(state.rows).not.toContain('outside-project.txt');
  await app.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});

test('leaving the project drops Files back to the configured tree root', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-project-'));
  fs.writeFileSync(path.join(projectDir, 'inside-project.md'), '# demo\n');
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-other-'));
  fs.writeFileSync(path.join(otherDir, 'outside-project.txt'), 'x');
  const app = await launch({
    firstRunDone: true,
    treeRoot: otherDir,
    projects: [{ id: 'p1', name: 'Demo', path: projectDir, addedAt: '2026-07-25T00:00:00.000Z', lastUsedAt: null }],
    activeProjectId: 'p1',
  });
  const win = await ready(app);
  await win.waitForFunction(() => typeof projectsCache !== 'undefined' && projectsCache.length > 0); // eslint-disable-line no-undef
  await win.evaluate(() => setPage('files')); // eslint-disable-line no-undef
  await win.waitForFunction((p) => (document.querySelector('#files-sub')?.textContent || '') === p, projectDir);
  await win.evaluate(async () => { await window.husk.projects.clearActive(); await refreshProjectsState(); }); // eslint-disable-line no-undef
  await win.waitForFunction((p) => (document.querySelector('#files-sub')?.textContent || '') === p, otherDir);
  const rows = await win.evaluate(() => document.querySelector('#fx-list')?.innerText || '');
  expect(rows).toContain('outside-project.txt');
  await app.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});
