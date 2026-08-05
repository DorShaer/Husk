'use strict';

// The Agents page is one list under one band of chrome. These check that the
// roster renders at the right shape, that the two filter axes and the search
// box narrow it, that pinning survives a repaint and reaches config on disk,
// and that a library with nothing in it says so instead of showing a void.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// A roster shaped like a real one: custom agents, a shipped one, one installed
// from a repo, and one with no prompt of its own.
const PROFILES = [
  { id: 'p-anvil', name: 'Anvil', description: 'Long-context code generation.', systemPrompt: 'You are Anvil.', builtin: false },
  { id: 'p-cato', name: 'Cato', description: 'Read-only auditor.', systemPrompt: 'You are Cato.', builtin: false },
  { id: 'p-forge', name: 'Forge', description: 'Completeness-first implementation.', systemPrompt: 'You are Forge.', builtin: false },
  { id: 'p-scribe', name: 'Scribe', description: 'Turns notes into technical writing.', systemPrompt: '', builtin: false },
  { id: 'p-pike', name: 'Pike', description: 'Installed from a pack.', systemPrompt: 'You are Pike.', builtin: false, repoRoot: '/home/someone/packs/agents' },
  { id: 'p-review', name: 'Code Reviewer', description: 'Correctness and edge cases.', systemPrompt: 'You review code.', builtin: true },
];

function makeHome(extra = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-agents-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
    profiles: PROFILES, ...extra,
  }));
  return { homeDir, configPath: path.join(cfgDir, 'config.json') };
}

function launch(env) {
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
}

async function openAgents(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  // The panel drops the reader beside the list under 1000px and the legend
  // under 1100px, so the size is set here rather than inherited from the
  // runner and the page is checked at the shape it ships in.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1700, height: 1000 });
  });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => typeof setPage === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => setPage('agents'));                // eslint-disable-line no-undef
  await win.waitForSelector('.ag-row', { timeout: 15_000 });
  return win;
}

const names = (win) => win.$$eval('.ag-row .ag-name', (els) => els.map((e) => e.textContent.trim()));

test('the page renders the roster, alphabetical, with its marks', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openAgents(app);

  // Origin is a property of the agent, so a roster with more than one of them
  // is banded by origin and alphabetical inside each band.
  expect(await names(win)).toEqual(['Anvil', 'Cato', 'Forge', 'Scribe', 'Code Reviewer', 'Pike']);
  expect(await win.$$eval('.ag-group', (els) => els.map((e) => e.textContent.trim())))
    .toEqual(['custom4', 'built-in1', 'from repo1']);
  // The roster size is printed once, on the control that changes it.
  await expect(win.locator('#ag-origin .ag-facet[data-key="all"] .ag-facet-n')).toHaveText('6');
  await expect(win.locator('.page-agents .page-title')).toHaveText('Agents');

  // A shipped agent cannot be deleted and opens read-only. Its origin is
  // carried by the band it sits under, so the row does not repeat it.
  const builtin = win.locator('.ag-row[data-id="p-review"]');
  await expect(builtin.locator('.ag-tag')).toHaveCount(0);
  await expect(builtin.locator('[data-ag-act="del"]')).toHaveCount(0);
  await expect(builtin.locator('[data-ag-act="edit"]')).toHaveCount(1);

  // Behaviour that no other column shows is named in words, never in an
  // unlabeled glyph.
  await expect(win.locator('.ag-row[data-id="p-pike"] .ag-tag')).toHaveCount(0);
  await expect(win.locator('.ag-row[data-id="p-scribe"] .ag-tag')).toHaveText(['no prompt']);

  // One verb or two, the last glyph on every row lands on one right rail.
  const rail = await win.$$eval('.ag-row', (els) => [...new Set(els.map((r) => {
    const btns = [...r.querySelectorAll('.ag-act-btn')];
    return Math.round(btns[btns.length - 1].getBoundingClientRect().right);
  }))]);
  expect(rail).toHaveLength(1);

  // Every row is the same height, and the actions are laid out at rest rather
  // than revealed by a pointer.
  const heights = await win.$$eval('.ag-row', (els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().height)))]);
  expect(heights).toEqual([40]);

  // The name and the sentence beside it share one baseline on every row.
  const offsets = await win.$$eval('.ag-row', (els) => els.map((r) => {
    const mid = (el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
    return Math.round(Math.abs(mid(r.querySelector('.ag-name')) - mid(r.querySelector('.ag-desc'))));
  }));
  expect([...new Set(offsets)]).toEqual([0]);
  const actionsVisible = await win.$$eval('.ag-act-btn', (els) => els.every((e) => getComputedStyle(e).opacity === '1'));
  expect(actionsVisible).toBe(true);

  await app.close();
});

test('the two filter axes and the search box each narrow the list', async () => {
  const env = makeHome({ activeProfileIds: ['p-cato'], activeProfileId: 'p-cato' });
  const app = await launch(env);
  const win = await openAgents(app);

  // Origin.
  await win.click('#ag-origin .ag-facet[data-key="builtin"]');
  expect(await names(win)).toEqual(['Code Reviewer']);
  await expect(win.locator('#ag-count')).toHaveText('1 of 6');

  await win.click('#ag-origin .ag-facet[data-key="repo"]');
  expect(await names(win)).toEqual(['Pike']);

  await win.click('#ag-origin .ag-facet[data-key="all"]');
  expect(await names(win)).toHaveLength(6);

  // Pinned is a view, so it is only ever a facet. One chip, not two: unpinned
  // is the roster minus pinned. Clicking the chip that is on clears it.
  await expect(win.locator('#ag-state .ag-facet')).toHaveCount(1);
  await win.click('#ag-state .ag-facet[data-key="pinned"]');
  expect(await names(win)).toEqual(['Cato']);
  await win.click('#ag-state .ag-facet[data-key="pinned"]');
  expect(await names(win)).toHaveLength(6);

  // Text, over name and description together.
  await win.fill('#agents-search', 'auditor');
  expect(await names(win)).toEqual(['Cato']);
  await win.fill('#agents-search', 'anv');
  expect(await names(win)).toEqual(['Anvil']);

  // The axes compose rather than override each other.
  await win.fill('#agents-search', 'o');
  await win.click('#ag-origin .ag-facet[data-key="builtin"]');
  expect(await names(win)).toEqual(['Code Reviewer']);

  // Nothing matching says so, and offers the one action that helps. The
  // heading is not restated underneath it.
  await win.fill('#agents-search', 'zzzzz');
  await expect(win.locator('.ag-empty-title')).toHaveText('No match');
  await expect(win.locator('.ag-empty-msg')).toHaveCount(0);
  await expect(win.locator('[data-ag-empty="create"]')).toHaveText('New "zzzzz"');
  expect(await names(win)).toHaveLength(0);

  // A chip with nothing behind it greys rather than leaving, so the band keeps
  // the same set of controls while a query narrows the roster to nothing.
  const chips = await win.$$eval('#ag-origin .ag-facet', (els) => els.map((e) => [e.dataset.key, e.disabled]));
  expect(chips.filter(([, off]) => off).length).toBeGreaterThan(0);
  await expect(win.locator('#ag-bar-sep')).toBeVisible();

  await app.close();
});

test('pinning toggles on the same nodes and lands in config', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openAgents(app);

  const forge = win.locator('.ag-row[data-id="p-forge"]');
  await expect(forge).not.toHaveClass(/is-pinned/);
  // Nothing is pinned, so the axis offers no chip that would return nothing.
  await expect(win.locator('#ag-state .ag-facet')).toHaveCount(0);

  await forge.locator('.ag-pin').click();
  await expect(forge.locator('.ag-pin')).toHaveAttribute('aria-pressed', 'true');
  await expect(forge).toHaveClass(/is-pinned/);
  await expect(win.locator('#ag-state .ag-facet[data-key="pinned"] .ag-facet-n')).toHaveText('1');
  // Pinning has exactly one visible effect in the product, and it is this.
  await expect(win.locator('#chat-sub')).toContainText('Forge');

  // A pin repaints counts, never the list, so the row keeps its identity.
  await win.click('.ag-row[data-id="p-anvil"] .ag-pin');
  await expect(win.locator('#ag-state .ag-facet[data-key="pinned"] .ag-facet-n')).toHaveText('2');
  // The header lists them in the order they were pinned, not alphabetically.
  await expect(win.locator('#chat-sub')).toContainText('Forge, Anvil');

  // The master checkbox is the whole shown scope in one write.
  await win.click('#ag-master');
  await expect(win.locator('.ag-row.is-pinned')).toHaveCount(6);
  await win.click('#ag-master');
  await expect(win.locator('.ag-row.is-pinned')).toHaveCount(0);

  await forge.locator('.ag-pin').click();
  await expect(forge).toHaveClass(/is-pinned/);

  // Leaving and re-entering the page reads the pinned set back off disk.
  await win.evaluate(() => setPage('chat'));                  // eslint-disable-line no-undef
  await win.evaluate(() => setPage('agents'));                // eslint-disable-line no-undef
  await win.waitForSelector('.ag-row.is-pinned');
  expect(await win.$$eval('.ag-row.is-pinned .ag-name', (els) => els.map((e) => e.textContent.trim()))).toEqual(['Forge']);

  await app.close();
  const written = JSON.parse(fs.readFileSync(env.configPath, 'utf8'));
  expect(written.activeProfileIds).toEqual(['p-forge']);
  expect(written.activeProfileId).toBe('p-forge');
});

test('a library with nothing in it says so', async () => {
  // profiles:list falls back to the shipped agents whenever the stored roster
  // is empty, so the zero-agent state is driven through the renderer that
  // paints it rather than through a config that cannot express it.
  const env = makeHome();
  const app = await launch(env);
  const win = await openAgents(app);

  await win.evaluate(() => { profilesCache = []; paintAgents(); });   // eslint-disable-line no-undef
  await expect(win.locator('.ag-empty-title')).toHaveText('No agents yet');
  // A heading and the one action. The routes a sentence would name are the
  // buttons already on the toolbar above it.
  await expect(win.locator('.ag-empty-msg')).toHaveCount(0);
  await expect(win.locator('[data-ag-empty="new"]')).toHaveText('New agent');
  await expect(win.locator('.ag-row')).toHaveCount(0);
  // Nothing to group and nothing to filter, so the origin axis leaves.
  await expect(win.locator('#ag-origin .ag-facet')).toHaveCount(0);

  // The message starts where the first row would, not floating in the middle.
  const offset = await win.evaluate(() => {
    const list = document.querySelector('.ag-list');
    const title = document.querySelector('.ag-empty-title');
    return Math.round(title.getBoundingClientRect().top - list.getBoundingClientRect().top);
  });
  expect(offset).toBeLessThan(60);

  // The one action opens the editor rather than dead-ending.
  await win.click('[data-ag-empty="new"]');
  await expect(win.locator('#agent-modal')).toBeVisible();
  await expect(win.locator('#agent-modal-title')).toHaveText('New agent');

  await app.close();
});

test('the keyboard reaches every filter, opens, and pins', async () => {
  const env = makeHome({ activeProfileIds: ['p-anvil'], activeProfileId: 'p-anvil' });
  const app = await launch(env);
  const win = await openAgents(app);

  // Each axis owns exactly one tab stop and the arrows reach the rest of it.
  const stops = await win.$$eval('.ag-facet', (els) => els.filter((e) => e.tabIndex === 0).length);
  expect(stops).toBe(2);

  await win.evaluate(() => document.querySelector('#ag-origin .ag-facet[tabindex="0"]').focus());
  await win.keyboard.press('ArrowRight');
  await expect(win.locator('#ag-origin .ag-facet.is-active')).toHaveAttribute('data-key', 'custom');
  expect(await win.evaluate(() => document.activeElement.dataset.key)).toBe('custom');
  await win.keyboard.press('End');
  expect(await win.evaluate(() => document.activeElement.dataset.key)).toBe('repo');
  await win.evaluate(() => { agOrigin = 'all'; paintAgents(); });      // eslint-disable-line no-undef

  // Space pins what the caret is on; the caret survives a pinned row.
  await win.click('.ag-row[data-id="p-cato"] .ag-name');
  await win.keyboard.press(' ');
  await expect(win.locator('.ag-row[data-id="p-cato"]')).toHaveClass(/is-pinned/);
  await expect(win.locator('.ag-row[data-id="p-cato"]')).toHaveClass(/is-cursor/);
  // The caret is a leading bar painted into the border box, so it runs the
  // full height of the row, and it is readable without the pixels.
  await expect(win.locator('.ag-row[data-id="p-cato"]')).toHaveAttribute('aria-current', 'true');
  const bar = await win.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.ag-row.is-cursor'));
    return { layers: cs.backgroundImage.split('linear-gradient').length - 1, size: cs.backgroundSize, origin: cs.backgroundOrigin };
  });
  expect(bar.layers).toBe(2);
  expect(bar.size.startsWith('2px')).toBe(true);
  expect(bar.origin).toContain('border-box');

  // Enter opens what the caret is on.
  await win.keyboard.press('Enter');
  await expect(win.locator('#agent-modal')).toBeVisible();
  await expect(win.locator('#agent-modal-title')).not.toHaveText('New agent');

  await app.close();
});

test('the reader shows the prompt of the agent under the caret', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openAgents(app);

  await expect(win.locator('#ag-detail .ag-dt-name')).toHaveText('Anvil');
  await expect(win.locator('#ag-detail .ag-dt-prompt')).toHaveText('You are Anvil.');

  await win.click('.ag-row[data-id="p-forge"] .ag-name');
  await expect(win.locator('#ag-detail .ag-dt-name')).toHaveText('Forge');
  await expect(win.locator('#ag-detail .ag-dt-prompt')).toHaveText('You are Forge.');

  // An agent with no prompt says so rather than showing an empty pane.
  await win.click('.ag-row[data-id="p-scribe"] .ag-name');
  await expect(win.locator('#ag-detail .ag-dt-none')).toHaveText('No prompt of its own.');

  // A search that matches nothing says so in the reader and leaves the two
  // columns exactly where they were, so no keystroke resizes the page.
  const wide = await win.evaluate(() => Math.round(document.querySelector('.ag').getBoundingClientRect().width));
  await win.fill('#agents-search', 'zzzzz');
  await expect(win.locator('#ag-detail')).toBeVisible();
  await expect(win.locator('#ag-detail .ag-dt-none')).toHaveText('No agent selected');
  await expect(win.locator('#ag-split')).not.toHaveClass(/is-solo/);
  const still = await win.evaluate(() => Math.round(document.querySelector('.ag').getBoundingClientRect().width));
  expect(still).toBe(wide);

  // With no row to act on, the legend names the two bindings that are the way
  // back to one rather than going blank.
  const keys = await win.$$eval('.ag-foot .ag-key', (els) => els.map((e) => e.textContent.trim()));
  expect(keys).toEqual(['Escclear', 'Nnew']);

  await app.close();
});

test('the reader carries what the row has no column for', async () => {
  const env = makeHome({ activeProfileIds: ['p-pike'], activeProfileId: 'p-pike' });
  const app = await launch(env);
  const win = await openAgents(app);

  await win.click('.ag-row[data-id="p-pike"] .ag-name');
  const cells = await win.$$eval('#ag-detail .ag-dt-cell', (els) => els.map((e) => [
    e.querySelector('dt').textContent.trim(), e.querySelector('dd').textContent.trim(),
  ]));
  // Every cell answers something the row has no column for. Pinned and the
  // size of the prompt are both readable on screen already, so neither is
  // printed here.
  expect(cells).toEqual([
    ['Origin', 'From a repo'],
    ['Auto-select', 'Off'],
    ['Source', '~/packs/agents'],
  ]);
  // The row prints the sentence in full, so the pane does not print it twice.
  await expect(win.locator('#ag-detail .ag-dt-desc')).toHaveCount(0);

  // The verbs the row carries are on the record the reader is already reading,
  // and pinning from the pane is a toggle rather than a printed value.
  await expect(win.locator('#ag-detail [data-ag-dt-act="pin"]')).toHaveAttribute('aria-pressed', 'true');
  await win.click('#ag-detail [data-ag-dt-act="pin"]');
  await expect(win.locator('#ag-detail [data-ag-dt-act="pin"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(win.locator('.ag-row[data-id="p-pike"]')).not.toHaveClass(/is-pinned/);

  await expect(win.locator('#ag-detail [data-ag-dt-act="edit"]')).toHaveCount(1);
  await win.click('#ag-detail [data-ag-dt-act="edit"]');
  await expect(win.locator('#agent-modal')).toBeVisible();

  await app.close();
});

test('the collection fills the page and clips at the fold', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openAgents(app);

  // No ruled filler under the last row. The list runs to the page floor and
  // the legend sits on it, so nothing on this page is a short slab with bare
  // canvas under it.
  await expect(win.locator('.ag-fill')).toHaveCount(0);
  const fill = await win.evaluate(() => {
    const page = document.querySelector('.page-agents');
    const floor = page.getBoundingClientRect().bottom - parseFloat(getComputedStyle(page).paddingBottom);
    const foot = document.querySelector('.ag-foot').getBoundingClientRect();
    const detail = document.querySelector('.ag-detail').getBoundingClientRect();
    return {
      underLegend: Math.round(floor - foot.bottom),
      underReader: Math.round(floor - detail.bottom),
    };
  });
  expect(fill.underLegend).toBeLessThanOrEqual(2);
  expect(fill.underReader).toBeLessThanOrEqual(2);

  // Every shortcut the list answers is named under it.
  await expect(win.locator('.ag-foot .ag-key')).toHaveCount(6);

  // A roster taller than the window clips its last row at the fold rather than
  // running off the page. The width stays inside the smallest screen this runs
  // on, since a request wider than the display is clamped and the roster would
  // never reach past the fold to be clipped.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1100, height: 380 });
  });
  // Wait for the overflow itself rather than for a fixed delay: the window
  // manager decides when the new bounds land.
  await win.waitForFunction(() => {
    const l = document.querySelector('.ag-list');
    return !!l && l.scrollHeight > l.clientHeight + 1;
  }, null, { timeout: 10_000 });
  const fold = await win.evaluate(() => {
    const page = document.querySelector('.page-agents');
    const floor = page.getBoundingClientRect().bottom - parseFloat(getComputedStyle(page).paddingBottom);
    const list = document.querySelector('.ag-list');
    return {
      clips: list.scrollHeight > list.clientHeight + 1,
      over: Math.round(document.querySelector('.ag').getBoundingClientRect().bottom - floor),
    };
  });
  expect(fold.clips).toBe(true);
  expect(fold.over).toBeLessThanOrEqual(2);

  await app.close();
});

test('a filter click leaves the keyboard where it can keep filtering', async () => {
  const env = makeHome();
  const app = await launch(env);
  const win = await openAgents(app);

  // The chip that was clicked is destroyed by the repaint, so the band hands
  // focus back to the chip that replaced it and the arrows still traverse it.
  await win.click('#ag-origin .ag-facet[data-key="custom"]');
  expect(await win.evaluate(() => document.activeElement.dataset.key)).toBe('custom');
  await win.keyboard.press('ArrowRight');
  expect(await win.evaluate(() => document.activeElement.dataset.key)).toBe('builtin');
  expect(await names(win)).toEqual(['Code Reviewer']);

  await app.close();
});
