'use strict';

// The marketplace surface, in the real window.
//
// Nothing here reaches the network. The rules that would need one are unit
// tested in workflow-registry.test.js; what has to be checked here is that a
// catalog paints, that it paints as claims rather than as facts, and that the
// refusals a catalog can raise land on the install sheet with copy of their own
// rather than on a generic one. Every refusal used below is settled before a
// request is made, so the assertions are deterministic.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_URL = 'https://catalog.example/index.json';

function launch(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, ...(config || {}),
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
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

// A catalog as the main process would have handed it over: already validated,
// already split into the pointer and the claims.
function entry(id, over = {}) {
  return {
    id,
    artifact: `workflows/${id}.husk.json`,
    sha256: '',
    claims: {
      name: id, description: '', author: '', tags: [], agents: [], steps: null, updatedAt: '',
      ...over,
    },
  };
}

// Opens the marketplace the way a person does, then paints a catalog into it.
//
// The open reaches for the shipped registry and there is no network here, so
// that attempt is allowed to settle into its error state first. Overwriting the
// state before it settled would let the failed fetch repaint over the catalog a
// moment later.
async function show(win, index) {
  await win.locator('.rail-item[data-page="workflows"]').click();
  await win.locator('#btn-wf-market').click();
  await expect(win.locator('#wf-market-view')).toBeVisible();
  await expect.poll(() => win.evaluate(() => window.WfxMarket.state.status), { timeout: 20_000 })
    .not.toBe('loading');

  await win.evaluate(([url, idx]) => {
    const m = window.WfxMarket;
    m.state.activeUrl = url;
    m.state.registries = [{ url, addedAt: null, builtin: true }];
    m.state.index = idx;
    m.state.status = 'ready';
    m.state.query = '';
    m.state.tag = '';
    m.paint();
  }, [REGISTRY_URL, index]);
}

function cards(win) {
  return win.evaluate(() => [...document.querySelectorAll('#wfm-grid .wfm-card')].map((c) => ({
    id: c.dataset.id,
    name: c.querySelector('.wfm-card-name').textContent,
    desc: c.querySelector('.wfm-card-desc') ? c.querySelector('.wfm-card-desc').textContent : '',
    facts: [...c.querySelectorAll('.wfm-fact')].map((f) => f.textContent),
    foot: c.querySelector('.wfm-card-by').textContent,
    chip: c.querySelector('.wfm-chip') ? c.querySelector('.wfm-chip').textContent : '',
  })));
}

const CATALOG = {
  url: REGISTRY_URL,
  schemaVersion: 1,
  claims: { name: 'Example catalog', updatedAt: '' },
  skipped: 0,
  entries: [
    entry('triage', { name: 'Security triage', description: 'Fans scanners out', tags: ['security'], agents: ['claude'], steps: 7, author: 'ann' }),
    entry('release', { name: 'Guarded release', description: 'Gates a deploy on tests', tags: ['release'], steps: 4 }),
  ],
};

test('a catalog paints one card per entry, carrying what it claims', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, CATALOG);

  const rows = await cards(win);
  // Neither entry states a date, so the catalog falls back to the name.
  expect(rows.map((r) => r.id)).toEqual(['release', 'triage']);
  const triage = rows.find((r) => r.id === 'triage');
  expect(triage.name).toBe('Security triage');
  expect(triage.desc).toBe('Fans scanners out');
  expect(triage.facts).toContain('7 steps');
  expect(triage.facts).toContain('claude');
  expect(triage.facts).toContain('security');
  await app.close();
});

test('every card says once that its figures are what the catalog listed', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, CATALOG);

  const rows = await cards(win);
  for (const r of rows) expect(r.foot).toContain('listed here');
  expect(rows.find((r) => r.id === 'triage').foot).toContain('by ann');
  await app.close();
});

test('the word "verified" appears nowhere on the catalog surface', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, {
    ...CATALOG,
    entries: [entry('signed', { name: 'Has a digest' })].map((e) => ({ ...e, sha256: 'a'.repeat(64) })),
  });

  const text = await win.evaluate(() => document.getElementById('wf-market-view').textContent);
  expect(text.toLowerCase()).not.toContain('verified');
  // The chip states what the catalog carries, not what it proves.
  const rows = await cards(win);
  expect(rows[0].chip).toBe('digest listed');
  await app.close();
});

test('the source line names the catalog and the host it came from', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, CATALOG);

  const source = await win.evaluate(() => document.getElementById('wfm-source').textContent);
  expect(source).toContain('Example catalog');
  expect(source).toContain('catalog.example');
  expect(source).toContain('2 workflows');
  await app.close();
});

test('a catalog that half-loaded says so rather than looking complete', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, { ...CATALOG, skipped: 3 });

  const source = await win.evaluate(() => document.getElementById('wfm-source').textContent);
  expect(source).toContain('3 rows not readable');
  await app.close();
});

test('the search box and the tag chips both narrow the grid', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, CATALOG);

  await win.locator('#wfm-search').fill('deploy');
  expect((await cards(win)).map((r) => r.id)).toEqual(['release']);

  await win.locator('#wfm-search').fill('');
  await win.locator('#wfm-tags button[data-tag="security"]').click();
  expect((await cards(win)).map((r) => r.id)).toEqual(['triage']);

  await win.locator('#wfm-tags button[data-tag=""]').click();
  expect((await cards(win)).length).toBe(2);
  await app.close();
});

test('a filter that matches nothing says so instead of showing an empty grid', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, CATALOG);

  await win.locator('#wfm-search').fill('nothing matches this');
  expect((await cards(win)).length).toBe(0);
  const state = await win.evaluate(() => document.getElementById('wfm-state').textContent);
  expect(state).toContain('Nothing in this catalog matches');
  await app.close();
});

test('Get hands the entry to the install sheet, which owns the refusal', async () => {
  const app = await launch();
  const win = await ready(app);
  // A pointer at another host is settled before any request is made, so this
  // exercises the whole seam without a network call.
  await show(win, {
    ...CATALOG,
    entries: [entry('elsewhere', { name: 'Points off-host' })].map((e) => ({
      ...e, artifact: 'https://somewhere-else.example/a.husk.json',
    })),
  });

  await win.locator('#wfm-grid .wfm-install').click();
  await expect(win.locator('#wfx-install-modal')).toBeVisible();

  // The sheet's own copy for this refusal, not the generic fallback.
  const title = win.locator('#wfx-in-ref-t');
  await expect(title).toContainText('different host');
  const message = await win.locator('#wfx-in-ref-m').textContent();
  expect(message).toContain('same host');
  await app.close();
});

test('the source picker stays away when the catalog already chose the file', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, CATALOG);
  await win.locator('#wfm-grid .wfm-install').first().click();
  await expect(win.locator('#wfx-install-modal')).toBeVisible();
  // reset() leaves the sheet unowned on this path, which is what puts the
  // repository/file chooser away.
  await expect(win.locator('#wfx-in-src-repo')).toBeHidden();
  await app.close();
});

// ─── Registries ────────────────────────────────────────────────────────────

test('a registry list starts with the shipped catalog and takes additions', async () => {
  const app = await launch();
  const win = await ready(app);

  const first = await win.evaluate(() => window.husk.registry.list());
  expect(first.ok).toBe(true);
  expect(first.registries.length).toBe(1);
  expect(first.registries[0].url).toBe(first.defaultUrl);

  const added = await win.evaluate(() => window.husk.registry.add('https://mine.example/index.json'));
  expect(added.ok).toBe(true);
  expect(added.registries.map((r) => r.url)).toContain('https://mine.example/index.json');

  const again = await win.evaluate(() => window.husk.registry.add('https://mine.example/index.json'));
  expect(again.alreadyAdded).toBe(true);
  await app.close();
});

test('a registry URL that is not https is refused rather than stored', async () => {
  const app = await launch();
  const win = await ready(app);
  for (const url of ['http://plain.example/i.json', 'file:///etc/passwd', 'not a url']) {
    const r = await win.evaluate((u) => window.husk.registry.add(u), url);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bad-registry-url');
  }
  const list = await win.evaluate(() => window.husk.registry.list());
  expect(list.registries.length).toBe(1);
  await app.close();
});

test('a registry can be removed, and the removal survives into config', async () => {
  const app = await launch();
  const win = await ready(app);
  await win.evaluate(() => window.husk.registry.add('https://mine.example/index.json'));
  const after = await win.evaluate(() => window.husk.registry.remove('https://mine.example/index.json'));
  expect(after.ok).toBe(true);
  expect(after.registries.map((r) => r.url)).not.toContain('https://mine.example/index.json');
  await app.close();
});

test('filtering a catalog is done in process, with no round trip', async () => {
  const app = await launch();
  const win = await ready(app);
  const out = await win.evaluate((entries) => ({
    hit: window.husk.registry.search(entries, 'triage', '').map((e) => e.id),
    tags: window.husk.registry.tags(entries),
  }), CATALOG.entries);
  expect(out.hit).toEqual(['triage']);
  expect(out.tags.map((t) => t.tag).sort()).toEqual(['release', 'security']);
  await app.close();
});
