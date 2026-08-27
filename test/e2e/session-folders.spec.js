'use strict';

// Session folders, in the real window.
//
// The grouping itself is unit tested in session-folders.test.js. What has to be
// checked here is the round trip: a folder made in the UI reaches config, a
// session filed into it lands under that heading, and deleting the folder
// unfiles rather than deletes.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SESSION_A = '11111111-2222-3333-4444-555555555555';
const SESSION_B = '22222222-3333-4444-5555-666666666666';

// A roster with nothing in it shows its empty state rather than any headings,
// so every test here needs at least one session on disk. sessions:list skips
// user-only files as queue receipts, so each fixture carries an assistant turn.
function seedSession(homeDir, id, cwd) {
  const proj = path.join(homeDir, '.claude', 'projects', `-${cwd.replace(/\//g, '-')}`);
  fs.mkdirSync(proj, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: new Date().toISOString(), cwd, type: 'user', message: { content: `work on ${id}` } }),
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  ];
  fs.writeFileSync(path.join(proj, `${id}.jsonl`), lines.join('\n') + '\n');
}

function launch(config, sessions = [SESSION_A]) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, ...(config || {}),
  }, null, 2));
  for (const id of sessions) seedSession(homeDir, id, '/home/test/proj');
  return { homeDir, app: electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  }) };
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await win.locator('.rail-item[data-page="sessions"]').click();
  await expect(win.locator('.page-sessions')).toBeVisible();
  return win;
}

// Picks the folder grouping the way a person does, through the menu.
async function groupByFolder(win) {
  await win.locator('#sx-menu-btn').click();
  await win.locator('#sx-menu [data-group="folder"]').click();
  await win.waitForTimeout(200);
}

const readConfig = (homeDir) => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8'));

// Headings on screen, in order.
const headings = (win) => win.evaluate(() =>
  [...document.querySelectorAll('#sx-list .sx-group')].map((g) => ({
    name: g.querySelector('.sx-g-name').textContent,
    count: g.querySelector('.sx-g-n').textContent,
    hasActions: !g.querySelector('.sx-g-acts').hidden,
  })));

test('a folder made from the menu reaches config and the page starts using it', async () => {
  const { homeDir, app: launched } = launch();
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sx-menu-btn').click();
  await win.locator('#sx-menu [data-act="new-folder"]').click();
  await expect(win.locator('#text-modal')).toBeVisible();
  await win.locator('#text-input').fill('In review');
  await win.locator('#text-ok').click();

  await win.waitForTimeout(400);
  const stored = readConfig(homeDir);
  expect(stored.sessionFolders).toEqual([{ id: 'sf-1', name: 'In review' }]);
  // Making a folder is a statement about how to read the page, so the page
  // switches to reading it that way.
  await expect(win.locator('#sx-menu-btn')).toBeVisible();
  const names = (await headings(win)).map((h) => h.name);
  expect(names).toContain('In review');
  await app.close();
});

test('an empty folder still renders, and carries its own controls', async () => {
  const { app: launched } = launch({ sessionFolders: [{ id: 'sf-1', name: 'In review' }], sessionFolderOf: {} });
  const app = await launched;
  const win = await ready(app);
  await groupByFolder(win);

  const rows = await headings(win);
  const folder = rows.find((h) => h.name === 'In review');
  expect(folder).toBeTruthy();
  expect(folder.count).toBe('');
  expect(folder.hasActions).toBe(true);
  await app.close();
});

test('a derived heading carries no folder controls', async () => {
  const { app: launched } = launch();
  const app = await launched;
  const win = await ready(app);
  // Project grouping is the default; none of its headings is the user's to edit.
  const rows = await headings(win);
  for (const h of rows) expect(h.hasActions).toBe(false);
  await app.close();
});

test('renaming a folder keeps its id, so nothing filed under it is orphaned', async () => {
  const { homeDir, app: launched } = launch({
    sessionFolders: [{ id: 'sf-1', name: 'In review' }],
    sessionFolderOf: { [SESSION_A]: 'sf-1' },
  });
  const app = await launched;
  const win = await ready(app);
  await groupByFolder(win);

  await win.locator('#sx-list .sx-group .sx-g-act[data-fact="rename"]').first().click();
  await expect(win.locator('#text-modal')).toBeVisible();
  await win.locator('#text-input').fill('Shipped');
  await win.locator('#text-ok').click();
  await win.waitForTimeout(400);

  const stored = readConfig(homeDir);
  expect(stored.sessionFolders).toEqual([{ id: 'sf-1', name: 'Shipped' }]);
  expect(stored.sessionFolderOf).toEqual({ [SESSION_A]: 'sf-1' });
  await app.close();
});

test('deleting a folder unfiles what was in it and names the count first', async () => {
  const { homeDir, app: launched } = launch({
    sessionFolders: [{ id: 'sf-1', name: 'In review' }],
    sessionFolderOf: { [SESSION_A]: 'sf-1', [SESSION_B]: 'sf-1' },
  }, [SESSION_A, SESSION_B]);
  const app = await launched;
  const win = await ready(app);
  await groupByFolder(win);

  await win.locator('#sx-list .sx-group .sx-g-act[data-fact="delete"]').first().click();
  await expect(win.locator('#confirm-modal')).toBeVisible();
  const body = await win.locator('#confirm-body').textContent();
  expect(body).toContain('2 sessions');
  expect(body).toContain('nothing is deleted from disk');
  await win.locator('#confirm-ok').click();
  await win.waitForTimeout(400);

  const stored = readConfig(homeDir);
  expect(stored.sessionFolders).toEqual([]);
  expect(stored.sessionFolderOf).toEqual({});
  await app.close();
});

test('cancelling the name dialog makes no folder', async () => {
  const { homeDir, app: launched } = launch();
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sx-menu-btn').click();
  await win.locator('#sx-menu [data-act="new-folder"]').click();
  await win.locator('#text-input').fill('Nope');
  await win.locator('#text-cancel').click();
  await win.waitForTimeout(300);

  expect(readConfig(homeDir).sessionFolders || []).toEqual([]);
  await app.close();
});

test('a name of only whitespace makes no folder', async () => {
  const { homeDir, app: launched } = launch();
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sx-menu-btn').click();
  await win.locator('#sx-menu [data-act="new-folder"]').click();
  await win.locator('#text-input').fill('    ');
  await win.locator('#text-ok').click();
  await win.waitForTimeout(300);

  expect(readConfig(homeDir).sessionFolders || []).toEqual([]);
  await app.close();
});

test('the grouping choice is offered alongside day and project', async () => {
  const { app: launched } = launch();
  const app = await launched;
  const win = await ready(app);
  await win.locator('#sx-menu-btn').click();
  const groups = await win.evaluate(() =>
    [...document.querySelectorAll('#sx-menu [data-group]')].map((b) => b.dataset.group));
  expect(groups).toEqual(['project', 'day', 'folder']);
  await app.close();
});
