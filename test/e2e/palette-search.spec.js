'use strict';

// The command palette answers a noun as well as a verb. These run in the real
// window because the palette's rows are built from the live page caches and the
// preload ranker, and neither exists in a DOM shim.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Seeds config and the prompt library on disk. Assigning to the renderer's
// caches instead would race the boot load, which lands afterwards and puts the
// stored values back.
function launch({ config, prompts } = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  if (config) fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(config, null, 2));
  if (prompts) {
    const promptDir = path.join(cfgDir, 'prompts');
    fs.mkdirSync(promptDir, { recursive: true });
    for (const [name, body] of Object.entries(prompts)) {
      fs.writeFileSync(path.join(promptDir, `${name}.md`), body);
    }
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

// Opens the palette and types, then waits for the background refresh of the
// lists to land: the first paint draws whatever the pages had cached, which on
// a cold boot is nothing.
async function search(win, query) {
  await win.evaluate(() => document.getElementById('btn-palette').click());
  const input = win.locator('#palette-input');
  await expect(input).toBeVisible();
  if (query) await input.fill(query);
  return input;
}

// Label, section and selected state of every row on screen, in paint order.
function readRows(win) {
  return win.evaluate(() => {
    const out = [];
    let section = '';
    for (const li of document.querySelectorAll('#palette-list > li')) {
      if (li.classList.contains('palette-section')) { section = li.textContent; continue; }
      if (!li.classList.contains('palette-row')) continue;
      out.push({
        section,
        label: li.querySelector('.pi-label').textContent,
        sub: li.querySelector('.pi-sub') ? li.querySelector('.pi-sub').textContent : '',
        active: li.classList.contains('active'),
        idx: Number(li.dataset.idx),
      });
    }
    return out;
  });
}

test('an empty query is the action list, under its own heading', async () => {
  const app = await launch();
  const win = await ready(app);
  await search(win, '');

  const rows = await readRows(win);
  expect(rows.length).toBeGreaterThan(5);
  expect(new Set(rows.map((r) => r.section))).toEqual(new Set(['Actions']));
  // Exactly one row carries the selection, and it is the first.
  expect(rows.filter((r) => r.active).map((r) => r.idx)).toEqual([0]);
  await app.close();
});

test('a project is found by name and its row opens the Projects page', async () => {
  const app = await launch({
    config: {
      firstRunDone: true,
      skipWelcome: true,
      projects: [{ id: 'p-quark', name: 'quarkfold', path: '/tmp/quarkfold', addedAt: 1, lastUsedAt: 1 }],
    },
  });
  const win = await ready(app);
  await search(win, 'quarkfold');

  await expect
    .poll(async () => (await readRows(win)).some((r) => r.section === 'Projects' && r.label === 'quarkfold'))
    .toBe(true);

  const rows = await readRows(win);
  // The name was typed in full, so the thing itself leads the actions.
  expect(rows[0]).toMatchObject({ section: 'Projects', label: 'quarkfold', active: true });

  await win.locator('#palette-input').press('Enter');
  await expect.poll(() => win.evaluate(() => document.body.dataset.page)).toBe('projects');
  await expect(win.locator('#palette')).toBeHidden();
  await app.close();
});

test('a prompt is found by its description, not only by its name', async () => {
  const app = await launch({
    config: { firstRunDone: true, skipWelcome: true },
    prompts: {
      'release-notes': '---\ndescription: Draft the changelog for a tagged build\n---\n\nWrite notes.\n',
    },
  });
  const win = await ready(app);
  await search(win, 'changelog');

  await expect
    .poll(async () => (await readRows(win)).some((r) => r.section === 'Prompts'))
    .toBe(true);

  const hit = (await readRows(win)).find((r) => r.section === 'Prompts');
  expect(hit.label).toBe('release-notes');
  expect(hit.sub).toContain('changelog');
  await app.close();
});

test('one query reaches two different surfaces at once', async () => {
  const app = await launch({
    config: {
      firstRunDone: true,
      skipWelcome: true,
      projects: [{ id: 'p-a', name: 'agentless', path: '/tmp/agentless', addedAt: 1, lastUsedAt: 1 }],
    },
  });
  const win = await ready(app);
  await search(win, 'agent');

  await expect
    .poll(async () => new Set((await readRows(win)).map((r) => r.section)).size)
    .toBeGreaterThan(1);

  const sections = new Set((await readRows(win)).map((r) => r.section));
  expect(sections.has('Projects')).toBe(true);
  expect(sections.has('Actions')).toBe(true);
  await app.close();
});

test('arrows walk rows only, and never land on a heading', async () => {
  const app = await launch({
    config: {
      firstRunDone: true,
      skipWelcome: true,
      projects: [{ id: 'p-a', name: 'agentless', path: '/tmp/agentless', addedAt: 1, lastUsedAt: 1 }],
    },
  });
  const win = await ready(app);
  const input = await search(win, 'agent');
  await expect
    .poll(async () => new Set((await readRows(win)).map((r) => r.section)).size)
    .toBeGreaterThan(1);

  const total = (await readRows(win)).length;
  expect(total).toBeGreaterThan(2);

  for (let i = 1; i < total; i++) {
    await input.press('ArrowDown');
    const rows = await readRows(win);
    // Exactly one row is selected, and it is the one the count says it is.
    expect(rows.filter((r) => r.active).map((r) => r.idx)).toEqual([i]);
  }
  // Past the end the selection stops rather than wrapping onto nothing.
  await input.press('ArrowDown');
  expect((await readRows(win)).filter((r) => r.active).map((r) => r.idx)).toEqual([total - 1]);
  await app.close();
});

test('Enter runs the row that is highlighted, not the one at that index in the unfiltered list', async () => {
  const app = await launch({
    config: {
      firstRunDone: true,
      skipWelcome: true,
      projects: [{ id: 'p-a', name: 'agentless', path: '/tmp/agentless', addedAt: 1, lastUsedAt: 1 }],
    },
  });
  const win = await ready(app);
  // "agent" reaches the project and the action list at once, so there is a
  // second row to walk onto.
  const input = await search(win, 'agent');
  await expect
    .poll(async () => (await readRows(win)).length)
    .toBeGreaterThan(1);
  expect((await readRows(win))[0].section).toBe('Projects');

  // Walk off the one Projects row, then read back what is highlighted before
  // running it. Only one project is seeded, so the second row is never Projects.
  await input.press('ArrowDown');
  const active = (await readRows(win)).find((r) => r.active);
  expect(active.section).not.toBe('Projects');

  await input.press('Enter');
  await expect(win.locator('#palette')).toBeHidden();
  // Landing on Projects here would mean Enter ran the row at that index in some
  // other list than the one on screen, which is exactly the drift being guarded.
  const page = await win.evaluate(() => document.body.dataset.page);
  expect(page).not.toBe('projects');
  await app.close();
});
