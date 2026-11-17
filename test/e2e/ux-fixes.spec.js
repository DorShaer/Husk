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

test('the rail ends with Preferences and carries no new-chat tool pill', async () => {
  const app = await launch();
  const win = await ready(app);
  const order = await win.evaluate(() => {
    const items = Array.from(document.querySelectorAll('#rail *'));
    const idx = (sel) => { const el = document.querySelector(sel); return el ? items.indexOf(el) : -1; };
    return {
      terminal: idx('.rail-item[data-page="terminal"]'),
      prefs: idx('#btn-open-prefs'),
      hasToolPill: !!document.querySelector('#rail-agent-pill'),
      autopilotText: (document.querySelector('#rail-autopilot')?.textContent || '').trim(),
      headerAutopilotExists: !!document.getElementById('btn-autopilot'),
    };
  });
  // The rail no longer carries the new-chat pill; Preferences stays last.
  expect(order.hasToolPill).toBe(false);
  expect(order.prefs).toBeGreaterThan(order.terminal);
  // The row is its name alone, with no maturity tag beside it.
  expect(order.autopilotText).toBe('Autopilot');
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

// With nothing saved, the page is still the whole feature: a hero carrying the
// animated graph, a gallery of runnable patterns, and no empty
// "your workflows" section in the way. Assert each half, so none of them can
// quietly stop rendering and leave a bare block of text.
test('workflows hub renders its hero, illustration and pattern gallery', async () => {
  const app = await launch();
  const win = await ready(app);
  const info = await win.evaluate(async () => {
    setPage('workflows');
    for (let i = 0; i < 40 && !document.querySelector('.wfx-pattern'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const art = document.querySelector('.wfx-hero-art');
    return {
      hasGraph: !!(art && art.querySelector('svg.wfx-dag')),
      // The graph is made only of things a workflow is made of. The mascot has
      // a role on Autopilot, where he is flying the plane; inside a node card
      // he only made that node's type ambiguous.
      hasMascot: !!(art && art.querySelector('.hk')),
      patterns: document.querySelectorAll('.wfx-pattern').length,
      patternShapes: document.querySelectorAll('.wfx-pattern-shape svg.wf-mini').length,
      concepts: document.querySelectorAll('.wfx-concept').length,
      mineHidden: document.getElementById('wfx-mine-section').hidden,
      runsHidden: document.getElementById('wfx-runs-section').hidden,
      text: document.querySelector('.wfx-hero').textContent.replace(/\s+/g, ' ').trim(),
      graphText: art ? art.textContent.replace(/\s+/g, ' ').trim() : '',
    };
  });
  expect(info.hasGraph).toBe(true);
  expect(info.hasMascot).toBe(false);
  expect(info.patterns).toBeGreaterThanOrEqual(6);
  expect(info.patternShapes).toBe(info.patterns);   // every pattern draws its own topology
  expect(info.concepts).toBe(4);
  expect(info.mineHidden).toBe(true);
  expect(info.runsHidden).toBe(true);
  expect(info.text).toContain('AGENTIC WORKFLOWS');
  expect(info.graphText).toContain('DAST');
  await app.close();
});

test('job model picker separates vendors, preserves pins, keeps half-set routing honest and fits the window', async () => {
  const app = await launch({ firstRunDone: true, skipWelcome: true, agentCommand: 'true' });
  const win = await ready(app);
  await win.waitForFunction(() => !!cfg);
  const info = await win.evaluate(() => {
    cfg = { ...cfg, agentCommand: 'copilot', taskRouting: undefined,
      modelRouting: { copilot: { cheap: 'invalid status text', smart: 'claude-sonnet-5' } } };
    orchDraft = null;
    orchAgents = [{ command: 'copilot', label: 'GitHub Copilot' }, { command: 'codex', label: 'Codex' }];
    orchCatalogs.set('copilot', { loading: true, models: [] });
    document.getElementById('aut-orch-modal').hidden = false;
    bindOrchestratorConfig();
    const loading = {
      simpleVendor: document.getElementById('aut-vendor-simple').value,
      complexVendor: document.getElementById('aut-vendor-complex').value,
      status: document.getElementById('aut-model-status-complex').textContent,
      automaticAvailable: Array.from(document.getElementById('aut-mr-complex').options).some(o => o.value === ''),
      vendorAuto: Array.from(document.getElementById('aut-vendor-simple').options).some(o => o.value === 'auto'),
      simpleStatus: document.getElementById('aut-model-status-simple').textContent,
      complexModelHidden: document.getElementById('aut-mr-complex').hidden,
      complexSetupShown: !document.getElementById('aut-setup-complex').hidden,
    };
    orchDraft.cheap = { vendor: 'codex', model: 'gpt-test' };
    orchCatalogs.set('codex', { loaded: true, models: [{ value: 'gpt-test', label: 'GPT test' }] });
    orchCatalogs.set('copilot', { loaded: true, models: [{ value: 'claude-sonnet-5', label: 'Sonnet' }] });
    bindOrchestratorConfig();
    const card = document.querySelector('#aut-orch-modal .modal-card');
    const rect = card.getBoundingClientRect();
    const overflow = Array.from(card.querySelectorAll('select,input')).filter(el => !el.hidden).some(el => {
      const r = el.getBoundingClientRect(); return r.left < rect.left - 1 || r.right > rect.right + 1;
    });
    return { loading, overflow, fitsHeight: rect.top >= 0 && rect.bottom <= innerHeight, title: card.querySelector('.modal-title').textContent,
      simple: document.getElementById('aut-mr-simple').value,
      complex: document.getElementById('aut-mr-complex').value,
      plannerDisabled: document.getElementById('aut-mr-planner').disabled,
      defaultCommand: cfg.agentCommand,
    };
  });
  // No CLI is picked on the user's behalf: an unset job type waits for a choice.
  expect(info.loading.simpleVendor).toBe('');
  expect(info.loading.vendorAuto).toBe(true);
  expect(info.loading.complexVendor).toBe('copilot');
  expect(info.loading.status).toContain('Loading');
  expect(info.loading.complexModelHidden).toBe(false);
  expect(info.loading.complexSetupShown).toBe(false);
  expect(info.loading.automaticAvailable).toBe(true);
  expect(info.title).toBe('Configure job models');
  expect(info.simple).toBe('gpt-test');
  expect(info.complex).toBe('');
  expect(info.plannerDisabled).toBe(true);
  expect(info.defaultCommand).toBe('copilot');
  expect(info.overflow).toBe(false);
  expect(info.fitsHeight).toBe(true);
  await win.screenshot({ path: test.info().outputPath('job-model-routing.png'), animations: 'disabled' });
  await win.locator('#aut-mr-save').click();
  await expect(win.locator('#aut-orch-modal')).toBeHidden();
  const saved = await win.evaluate(() => cfg.taskRouting);
  expect(saved.cheap).toEqual({ vendor: 'codex', model: 'gpt-test' });
  expect(saved.smart).toEqual({ vendor: 'copilot', model: '' });
  expect(saved.planner).toEqual({ vendor: '', model: '' });
  await app.close();
});

test('vendor model responses cannot replace another vendor selection', async () => {
  const app = await launch({ firstRunDone: true, skipWelcome: true, agentCommand: 'true' });
  const win = await ready(app);
  await win.waitForFunction(() => !!cfg);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('models:list');
    ipcMain.handle('models:list', async (_event, { command }) => {
      await new Promise(resolve => setTimeout(resolve, command === 'codex' ? 350 : 20));
      return { models: [{ value: command + '-test', label: command + ' test' }] };
    });
  });
  await win.evaluate(() => {
    cfg = { ...cfg, taskRouting: {} }; orchDraft = null; orchCatalogs.clear();
    orchAgents = [{ command: 'codex', label: 'Codex' }, { command: 'claude', label: 'Claude' }];
    document.getElementById('aut-orch-modal').hidden = false; bindOrchestratorConfig();
  });
  await win.locator('#aut-vendor-simple').selectOption('codex');
  await win.locator('#aut-vendor-simple').selectOption('claude');
  await expect(win.locator('#aut-mr-simple option[value="claude-test"]')).toHaveCount(1);
  await win.waitForFunction(() => orchCatalogs.get('codex')?.loaded);
  await expect(win.locator('#aut-mr-simple option[value="codex-test"]')).toHaveCount(0);
  await win.locator('#aut-mr-simple').selectOption('claude-test');
  await win.locator('#aut-vendor-simple').selectOption('');
  await expect(win.locator('#aut-mr-simple')).toBeDisabled();
  expect(await win.evaluate(() => orchDraft.cheap)).toEqual({ vendor: '', model: '' });
  await app.close();
});

test('a CLI with no saved models shows Not routed with zero tier controls, and routing is set up from its own catalog', async () => {
  const app = await launch({ firstRunDone: true, skipWelcome: true, agentCommand: 'true',
    taskRouting: { cheap: { vendor: 'codex', model: '' }, smart: { vendor: 'claude', model: '' }, planner: { vendor: 'auto', model: '' }, integrator: { vendor: 'auto', model: '' } } });
  const win = await ready(app);
  await win.waitForFunction(() => !!cfg);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agents:detect');
    ipcMain.handle('agents:detect', () => ({ agents: [{ command: 'claude', label: 'Claude', available: true }, { command: 'codex', label: 'Codex', available: true }] }));
    global.liveCatalog = true;
    ipcMain.removeHandler('models:list');
    ipcMain.handle('models:list', (_e, opts) => (global.liveCatalog && opts.refresh
      ? { models: [{ value: 'm-small', label: 'Small' }, { value: 'm-large', label: 'Large' }], live: ['m-small', 'm-large'], readAt: 4242 }
      : { models: [], live: [], error: 'Codex did not list its models.' }));
  });
  await win.evaluate(() => openOrchestratorModal());
  const codexRow = win.locator('#aut-cli-routing .aut-cli-row[data-vendor="codex"]');
  await expect(codexRow).toHaveAttribute('data-state', 'unrouted');
  await expect(codexRow).toContainText('This CLI uses its own default model for every task.');
  await expect(codexRow.locator('select, input')).toHaveCount(0);
  await expect(codexRow.locator('button')).toHaveText(['Set up routing']);
  await expect(win.locator('#aut-cli-routing .aut-cli-row[data-vendor="claude"]')).toContainText('Simple jobs run on haiku, complex jobs on opus');
  // Model selection is available even before vendor defaults are configured.
  await expect(win.locator('#aut-mr-simple')).toBeVisible();
  await expect(win.locator('#aut-model-status-simple')).toContainText('Codex did not list its models');
  await expect(win.locator('#aut-setup-simple')).toBeHidden();
  await expect(win.locator('#aut-mr-complex')).toBeVisible();

  await win.locator('#aut-cli-advanced > summary').click();
  await codexRow.locator('button', { hasText: 'Set up routing' }).click();
  await expect(win.locator('#aut-cli-pick-cheap option')).toHaveCount(3);
  await win.locator('#aut-cli-pick-cheap').selectOption('m-small');
  await win.locator('#aut-cli-pick-smart').selectOption('m-large');
  await win.locator('#aut-cli-pick-use').click();
  await expect(codexRow).toHaveAttribute('data-state', 'routed');
  await expect(win.locator('#aut-mr-simple')).toBeVisible();
  await win.locator('#aut-mr-save').click();
  await expect(win.locator('#aut-orch-modal')).toBeHidden();
  expect(await win.evaluate(() => cfg.modelRouting.codex)).toEqual({ cheap: 'm-small', smart: 'm-large', seenAt: 4242 });

  // A catalog that cannot be read still allows a typed id, stored without a catalog time.
  await app.evaluate(() => { global.liveCatalog = false; });
  await win.evaluate(() => openOrchestratorModal());
  await win.locator('#aut-cli-advanced').evaluate(el => { el.open = true; });
  await codexRow.locator('button', { hasText: 'Change' }).click();
  await expect(win.locator('.aut-cli-picker .aut-routing-status')).toContainText('enter a model id instead');
  await win.locator('#aut-cli-pick-mode').click();
  await win.locator('#aut-cli-pick-cheap').fill('typed small');
  await win.locator('#aut-cli-pick-smart').fill('typed-large');
  await win.locator('#aut-cli-pick-use').click();
  await expect(codexRow).toHaveAttribute('data-state', 'routed');
  await expect(codexRow).toContainText('m-small');
  await win.locator('#aut-cli-pick-cheap').fill('typed-small');
  await win.locator('#aut-cli-pick-smart').fill('typed-large');
  await win.locator('#aut-cli-pick-use').click();
  await win.locator('#aut-mr-save').click();
  expect(await win.evaluate(() => cfg.modelRouting.codex)).toEqual({ cheap: 'typed-small', smart: 'typed-large', seenAt: null });
  await app.close();
});

test('Autopilot launch passes a job vendor override without changing new-chat defaults', async () => {
  const app = await launch({ firstRunDone: true, skipWelcome: true, agentCommand: 'true' });
  const win = await ready(app);
  await win.waitForFunction(() => !!cfg);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agents:detect');
    ipcMain.handle('agents:detect', () => ({ agents: [{ command: 'codex', label: 'Codex', available: true }] }));
    ipcMain.removeHandler('models:list');
    ipcMain.handle('models:list', () => ({ models: [{ value: 'gpt-test', label: 'GPT test' }] }));
    ipcMain.removeHandler('autopilot:start');
    ipcMain.handle('autopilot:start', (_event, payload) => { global.routingTestPayload = payload; return { ok: false, error: 'Fixture captured' }; });
  });
  await win.evaluate(() => {
    activeProjectId = 'fixture'; projectsCache = [{ id: 'fixture', name: 'Fixture', path: '/tmp' }];
    autopilotStartMode = 'solo'; openAutopilotStart();
  });
  await expect(win.locator('#aut-run-vendor option[value="codex"]')).toHaveCount(1);
  await win.locator('#aut-run-vendor').selectOption('codex');
  await expect(win.locator('#aut-run-model option[value="gpt-test"]')).toHaveCount(1);
  await win.locator('#aut-run-model').selectOption('gpt-test');
  await win.locator('#aut-goal').fill('Verify routing fixture');
  await win.locator('#aut-snapshot-toggle').evaluate(el => { el.checked = false; });
  await win.locator('#aut-start-go').click();
  await expect.poll(() => app.evaluate(() => global.routingTestPayload?.routing)).toEqual({ vendor: 'codex', model: 'gpt-test' });
  expect(await win.evaluate(() => cfg.agentCommand)).toBe('true');
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
    openPrefs();
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
  // The copy menu belongs to Terminal view; config.chatView is the only pin now.
  const app = await launch({ firstRunDone: true, chatView: 'terminal' });
  const win = await ready(app);
  await win.waitForFunction(() => typeof cfg !== 'undefined' && !!cfg); // eslint-disable-line no-undef
  const focused = await win.evaluate(async () => {
    setPage('chat');
    // Cold boot shows the welcome screen with no terminal yet; start the agent
    // so a tab (and its terminal) exists before exercising copy. The copy menu
    try { await startPty(); } catch (_) {}
    for (let i = 0; i < 100 && !term; i++) await new Promise((r) => setTimeout(r, 20));
    try { term.write('hello selection'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 50));
    try { term.selectAll(); } catch (_) {}
    // A late-arriving modal (what's new, trust) would take focus and fake a
    // failure; the test is about the copy menu, not the modals.
    document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
    try { term.focus(); } catch (_) {}
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
  const app = await launch({ firstRunDone: true, agentCommand: 'bash --noprofile --norc' });
  const win = await ready(app);
  // A tab started before boot loads the config takes the default agent, not
  // this test's shell.
  await win.waitForFunction(() => typeof cfg !== 'undefined' && !!cfg); // eslint-disable-line no-undef
  await win.evaluate(async () => {
    setPage('chat'); // eslint-disable-line no-undef
    await startPty(); // eslint-disable-line no-undef
  });
  // Read the terminal through xterm's buffer rather than its DOM. The buffer
  // fills as bytes are parsed; the rows only fill when the renderer paints,
  // which a loaded machine can defer indefinitely.
  await win.evaluate(() => {
    window.__termText = () => { // eslint-disable-line no-undef
      const b = term && term.buffer && term.buffer.active; // eslint-disable-line no-undef
      if (!b) return '';
      let s = '';
      for (let i = 0; i < b.length; i++) s += (b.getLine(i)?.translateToString(true) || '') + '\n';
      return s;
    };
  });
  // Wait for a live tab, then for the shell to say something. Bytes written
  // into a PTY whose shell has not started yet are simply dropped, so a fixed
  // delay here turns into a timeout on a slow machine.
  await win.waitForFunction(() => typeof TABS !== 'undefined' && TABS.size > 0 && !!term); // eslint-disable-line no-undef
  await win.waitForFunction(() => window.__termText().trim().length > 0);
  const dest = await win.evaluate(async (p) => {
    const r = await attachContextSource(p, 'cert.der'); // eslint-disable-line no-undef
    return r && r.dest ? r.dest : '';
  }, sourcePath);
  expect(dest).toContain('cert.der');
  await win.waitForFunction(() => document.querySelector('#sp-pane-work')?.textContent.includes('cert.der'));
  // The terminal wraps at its own width, so compare with whitespace stripped:
  // a path split across two rows is still the path that was typed.
  const flatten = (s) => String(s || '').replace(/\s+/g, '');
  await win.waitForFunction(
    (d) => window.__termText().replace(/\s+/g, '').includes(d),
    flatten(dest)
  );
  const state = await win.evaluate(() => ({
    pane: document.querySelector('#sp-pane-work')?.textContent || '',
    terminal: window.__termText(),
  }));
  expect(state.pane).toContain('cert.der');
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
    (p) => (document.querySelector('#btn-files-open')?.title || '') === p,
    projectDir
  );
  const state = await win.evaluate(() => ({
    sub: document.querySelector('#btn-files-open')?.title || '',
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
  await win.waitForFunction((p) => (document.querySelector('#btn-files-open')?.title || '') === p, projectDir);
  await win.evaluate(async () => { await window.husk.projects.clearActive(); await refreshProjectsState(); }); // eslint-disable-line no-undef
  await win.waitForFunction((p) => (document.querySelector('#btn-files-open')?.title || '') === p, otherDir);
  const rows = await win.evaluate(() => document.querySelector('#fx-list')?.innerText || '');
  expect(rows).toContain('outside-project.txt');
  await app.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(otherDir, { recursive: true, force: true });
});
