'use strict';

// The Schedule page, in the real window.
//
// When a schedule fires is unit tested in schedule.test.js. What has to be
// checked here is the round trip: a schedule made in the form reaches config in
// the shape the timer reads, the row says the same sentence the form promised,
// and a schedule whose target is gone says so rather than looking healthy.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WORKFLOWS = [
  { id: 'w1', name: 'Guarded release', description: '', graph: { nodes: [{ id: 'n0', name: 'Plan', prompt: 'x' }], edges: [] } },
  { id: 'w2', name: 'Docs sweep', description: '', graph: { nodes: [{ id: 'n0', name: 'Walk', prompt: 'x' }], edges: [] } },
];

function launch(schedules) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'workflows.json'), JSON.stringify(WORKFLOWS, null, 2));
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, ...(schedules ? { schedules } : {}),
  }, null, 2));
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
  await win.locator('.rail-item[data-page="schedule"]').click();
  await expect(win.locator('.page-schedule')).toBeVisible();
  await expect.poll(() => win.evaluate(() => window.Schedule.state.status), { timeout: 20_000 }).toBe('ready');
  return win;
}

const readConfig = (homeDir) => JSON.parse(fs.readFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), 'utf8'));

const rows = (win) => win.evaluate(() => [...document.querySelectorAll('#sch-list .sch-row')].map((r) => ({
  id: r.dataset.id,
  name: r.querySelector('.sch-name').textContent,
  recur: r.querySelector('.sch-recur').textContent,
  text: r.textContent,
  paused: r.classList.contains('is-paused'),
})));

test('nothing scheduled says so, and says Husk has to be running', async () => {
  const { app: launched } = launch();
  const app = await launched;
  const win = await ready(app);
  const text = await win.evaluate(() => document.getElementById('sch-state').textContent);
  expect(text).toContain('Nothing runs on its own yet');
  expect(text).toContain('Husk has to be running');
  await app.close();
});

test('a schedule made in the form reaches config in the shape the timer reads', async () => {
  const { homeDir, app: launched } = launch();
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sch-new').click();
  await win.locator('#sch-name').fill('Nightly sweep');
  await win.locator('#sch-target').selectOption('w2');
  await win.locator('#sch-kind').selectOption('daily');
  await win.locator('#sch-at').fill('02:00');
  await win.locator('#sch-save').click();
  await win.waitForTimeout(400);

  const stored = readConfig(homeDir).schedules;
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    id: 'sch-1', name: 'Nightly sweep', kind: 'daily', target: 'workflow', targetId: 'w2', at: '02:00', enabled: true,
  });
  expect((await rows(win))[0].recur).toBe('every day at 02:00');
  await app.close();
});

test('the form previews the same sentence the row will carry', async () => {
  const { app: launched } = launch();
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sch-new').click();
  await win.locator('#sch-name').fill('Weekday check');
  await win.locator('#sch-kind').selectOption('daily');
  await win.locator('#sch-at').fill('09:00');
  for (const d of ['1', '2', '3', '4', '5']) await win.locator(`#sch-days [data-day="${d}"]`).click();
  const preview = await win.locator('#sch-preview').textContent();
  expect(preview).toContain('Mon, Tue, Wed, Thu, Fri at 09:00');

  await win.locator('#sch-save').click();
  await win.waitForTimeout(400);
  expect((await rows(win))[0].recur).toBe('Mon, Tue, Wed, Thu, Fri at 09:00');
  await app.close();
});

test('a weekly schedule holds one day, so picking another releases the last', async () => {
  const { homeDir, app: launched } = launch();
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sch-new').click();
  await win.locator('#sch-name').fill('Friday wrap');
  await win.locator('#sch-kind').selectOption('weekly');
  await win.locator('#sch-days [data-day="1"]').click();
  await win.locator('#sch-days [data-day="5"]').click();
  const pressed = await win.evaluate(() =>
    [...document.querySelectorAll('#sch-days [data-day][aria-pressed="true"]')].map((b) => b.dataset.day));
  expect(pressed).toEqual(['5']);

  await win.locator('#sch-save').click();
  await win.waitForTimeout(400);
  expect(readConfig(homeDir).schedules[0].days).toEqual([5]);
  await app.close();
});

test('a schedule the validator refuses says which field, and saves nothing', async () => {
  const { homeDir, app: launched } = launch();
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sch-new').click();
  // No name.
  await win.locator('#sch-save').click();
  await expect(win.locator('#sch-error')).toBeVisible();
  expect(await win.locator('#sch-error').textContent()).toContain('name');

  // An interval below the floor.
  await win.locator('#sch-name').fill('Too eager');
  await win.locator('#sch-every').fill('1');
  await win.locator('#sch-save').click();
  await expect(win.locator('#sch-error')).toBeVisible();
  expect(await win.locator('#sch-error').textContent()).toContain('5 minutes');

  expect(readConfig(homeDir).schedules || []).toEqual([]);
  await app.close();
});

test('pausing a schedule keeps it but stops its clock', async () => {
  const { homeDir, app: launched } = launch([
    { id: 'sch-1', name: 'Hourly', kind: 'every', target: 'workflow', targetId: 'w1', everyMinutes: 60, enabled: true },
  ]);
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sch-list .sch-row [data-act="toggle"]').click();
  await win.waitForTimeout(400);
  expect(readConfig(homeDir).schedules[0].enabled).toBe(false);
  expect((await rows(win))[0].paused).toBe(true);
  expect((await rows(win))[0].text).toContain('paused');
  await app.close();
});

test('a schedule pointing at a workflow that is gone says so', async () => {
  const { app: launched } = launch([
    { id: 'sch-1', name: 'Orphan', kind: 'every', target: 'workflow', targetId: 'deleted', everyMinutes: 120, enabled: true },
  ]);
  const app = await launched;
  const win = await ready(app);
  expect((await rows(win))[0].text).toContain('that workflow no longer exists');
  await app.close();
});

test('editing keeps the id and the run history', async () => {
  const { homeDir, app: launched } = launch([
    { id: 'sch-1', name: 'Old name', kind: 'every', target: 'workflow', targetId: 'w1', everyMinutes: 60, enabled: true, lastRunAt: '2026-08-01T00:00:00.000Z' },
  ]);
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sch-list .sch-row [data-act="edit"]').click();
  await win.locator('#sch-name').fill('New name');
  await win.locator('#sch-save').click();
  await win.waitForTimeout(400);

  const stored = readConfig(homeDir).schedules;
  expect(stored).toHaveLength(1);
  expect(stored[0].id).toBe('sch-1');
  expect(stored[0].name).toBe('New name');
  expect(stored[0].lastRunAt).toBe('2026-08-01T00:00:00.000Z');
  await app.close();
});

test('deleting a schedule removes it and leaves the workflow alone', async () => {
  const { homeDir, app: launched } = launch([
    { id: 'sch-1', name: 'Gone soon', kind: 'every', target: 'workflow', targetId: 'w1', everyMinutes: 60, enabled: true },
  ]);
  const app = await launched;
  const win = await ready(app);

  await win.locator('#sch-list .sch-row [data-act="delete"]').click();
  await expect(win.locator('#confirm-modal')).toBeVisible();
  await win.locator('#confirm-ok').click();
  await win.waitForTimeout(400);

  expect(readConfig(homeDir).schedules).toEqual([]);
  expect((await rows(win)).length).toBe(0);
  // The workflow itself is untouched.
  const flows = await win.evaluate(() => window.husk.workflows.list());
  expect(flows.map((w) => w.id)).toContain('w1');
  await app.close();
});
