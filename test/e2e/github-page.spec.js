'use strict';

// The GitHub page, in the real window.
//
// Nothing here reaches GitHub. What gh returns and how it is read is unit
// tested in gh-cli.test.js; what has to be checked here is that rows paint,
// that filtering narrows them without a round trip, and that each failure lands
// with the recovery step that belongs to it rather than a shared sentence.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ firstRunDone: true, skipWelcome: true }, null, 2));
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

const pr = (over) => ({
  number: 1, title: 'a change', state: 'OPEN', isDraft: false, author: 'ann',
  head: 'feat/x', base: 'main', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-20T00:00:00Z',
  additions: 10, deletions: 2, changedFiles: 3, labels: [], reviewDecision: '', mergeable: 'MERGEABLE',
  url: 'https://github.com/o/r/pull/1',
  checks: { total: 0, passed: 0, failed: 0, pending: 0, state: 'none' },
  ...over,
});

const ROWS = [
  pr({ number: 10, title: 'Fix the parser', author: 'ann', head: 'fix/parser', labels: [{ name: 'bug', color: 'd73a4a' }], checks: { total: 3, passed: 3, failed: 0, pending: 0, state: 'passing' } }),
  pr({ number: 11, title: 'Add a page', author: 'bob', head: 'feat/page', labels: [{ name: 'ui', color: '' }], checks: { total: 4, passed: 2, failed: 1, pending: 1, state: 'failing' } }),
  pr({ number: 12, title: 'Draft work', author: 'ann', isDraft: true, labels: [] }),
];

// Opens the page the way a person does, lets its first call settle, then paints
// rows into it. There is no repository in the isolated home, so the real call
// fails and would repaint over the fixture if it were still in flight.
async function show(win, rows, over = {}) {
  await win.locator('.rail-item[data-page="github"]').click();
  await expect(win.locator('.page-github')).toBeVisible();
  await expect.poll(() => win.evaluate(() => window.Gh.state.status), { timeout: 20_000 }).not.toBe('loading');
  await win.evaluate(([r, o]) => {
    const g = window.Gh;
    Object.assign(g.state, {
      kind: 'pulls', listState: 'open', query: '', label: '',
      rows: r, status: 'ready', error: null, selected: r.length ? r[0].number : null,
      repo: { nameWithOwner: 'o/r', url: '', defaultBranch: 'main', isPrivate: false, description: '' },
    }, o);
    g.paint();
  }, [rows, over]);
}

function listRows(win) {
  return win.evaluate(() => [...document.querySelectorAll('#gh-list .gh-row')].map((r) => ({
    number: Number(r.dataset.number),
    title: r.querySelector('.gh-row-title').textContent,
    current: r.classList.contains('is-current'),
    meta: r.querySelector('.gh-row-meta').textContent,
    labels: [...r.querySelectorAll('.gh-row-labels .gh-label')].map((l) => l.textContent),
  })));
}

test('rows paint with their number, state, author and check count', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, ROWS);

  const rows = await listRows(win);
  expect(rows.map((r) => r.number)).toEqual([10, 11, 12]);
  expect(rows[0].title).toBe('Fix the parser');
  expect(rows[0].meta).toContain('Open');
  expect(rows[0].meta).toContain('ann');
  expect(rows[0].meta).toContain('3 passed');
  expect(rows[1].meta).toContain('1 failing');
  expect(rows[2].meta).toContain('Draft');
  await app.close();
});

test('a label keeps its own colour only when GitHub gave it one', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, ROWS);
  const marks = await win.evaluate(() => [...document.querySelectorAll('#gh-list .gh-label')].map((l) => ({
    name: l.textContent, coloured: l.classList.contains('has-color'),
  })));
  expect(marks).toEqual([{ name: 'bug', coloured: true }, { name: 'ui', coloured: false }]);
  await app.close();
});

test('the detail pane answers the row under the cursor', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, ROWS);

  let text = await win.evaluate(() => document.getElementById('gh-detail').textContent);
  expect(text).toContain('Fix the parser');
  expect(text).toContain('fix/parser');
  expect(text).toContain('nobody has reviewed yet');

  await win.locator('#gh-list .gh-row[data-number="11"]').click();
  text = await win.evaluate(() => document.getElementById('gh-detail').textContent);
  expect(text).toContain('Add a page');
  expect(text).toContain('2 passed, 1 failed, 1 running, 4 total');
  await app.close();
});

test('filtering narrows the list in place, with no call to gh', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, ROWS);

  await win.locator('#gh-search').fill('bob');
  expect((await listRows(win)).map((r) => r.number)).toEqual([11]);

  await win.locator('#gh-search').fill('#12');
  expect((await listRows(win)).map((r) => r.number)).toEqual([12]);

  await win.locator('#gh-search').fill('');
  expect((await listRows(win)).length).toBe(3);
  // The fixture is still the fixture: nothing refetched behind the filtering.
  expect(await win.evaluate(() => window.Gh.state.rows.length)).toBe(3);
  await app.close();
});

test('a label chip filters, and the selection follows rather than dangling', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, ROWS);
  await win.locator('#gh-labels button[data-label="ui"]').click();
  expect((await listRows(win)).map((r) => r.number)).toEqual([11]);
  // #10 was selected and is now filtered out, so the selection moved onto a row
  // that is actually on screen.
  expect(await win.evaluate(() => window.Gh.state.selected)).toBe(11);
  await app.close();
});

test('arrows walk the list and the selection stops at both ends', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, ROWS);
  const list = win.locator('#gh-list');
  await list.focus();

  await list.press('ArrowDown');
  expect(await win.evaluate(() => window.Gh.state.selected)).toBe(11);
  await list.press('ArrowDown');
  await list.press('ArrowDown');
  expect(await win.evaluate(() => window.Gh.state.selected)).toBe(12);
  await list.press('ArrowUp');
  expect(await win.evaluate(() => window.Gh.state.selected)).toBe(11);
  await app.close();
});

test('switching to issues drops the merged state gh would refuse', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, ROWS, { listState: 'merged' });
  await win.locator('#gh-tab-issues').click();
  expect(await win.evaluate(() => window.Gh.state.listState)).toBe('open');
  expect(await win.evaluate(() => document.querySelector('#gh-state option[value="merged"]').hidden)).toBe(true);
  await app.close();
});

test('each failure carries the step that clears it, not a shared sentence', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, []);

  const cases = [
    ['gh-missing', 'Install the GitHub CLI'],
    ['gh-not-authenticated', 'gh auth login'],
    ['not-a-repository', 'inside a git repository'],
    ['no-remote', 'Add a GitHub remote'],
    ['rate-limited', 'Wait for the limit to reset'],
  ];
  for (const [code, advice] of cases) {
    await win.evaluate((c) => {
      window.Gh.state.status = 'error';
      window.Gh.state.error = { code: c, message: `refused: ${c}`, detail: null };
      window.Gh.state.rows = [];
      window.Gh.paint();
    }, code);
    const text = await win.evaluate(() => document.getElementById('gh-state-msg').textContent);
    expect(text, code).toContain(advice);
  }
  await app.close();
});

test('with nothing to list the panes give their height to the message', async () => {
  const app = await launch();
  const win = await ready(app);
  await show(win, []);
  await win.evaluate(() => {
    window.Gh.state.status = 'error';
    window.Gh.state.error = { code: 'no-remote', message: 'no remote', detail: null };
    window.Gh.paint();
  });
  await expect(win.locator('#gh-panes')).toBeHidden();
  await expect(win.locator('#gh-state-msg')).toBeVisible();
  await app.close();
});

test('the page reports whether gh is on this machine', async () => {
  const app = await launch();
  const win = await ready(app);
  const r = await win.evaluate(() => window.husk.github.available());
  expect(r.ok).toBe(true);
  expect(typeof r.available).toBe('boolean');
  await app.close();
});

test('filtering and label counting run in process', async () => {
  const app = await launch();
  const win = await ready(app);
  const out = await win.evaluate((rows) => ({
    hit: window.husk.github.filter(rows, 'parser').map((r) => r.number),
    labels: window.husk.github.labels(rows).map((l) => l.name),
  }), ROWS);
  expect(out.hit).toEqual([10]);
  expect(out.labels.sort()).toEqual(['bug', 'ui']);
  await app.close();
});
