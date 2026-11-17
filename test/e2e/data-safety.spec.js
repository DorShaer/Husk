'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Snapshot = require('../../src/lib/autonomy/snapshot');
const ConfigStore = require('../../src/lib/config-store');
const ROOT = path.resolve(__dirname, '../..');

async function start(home) {
  return electron.launch({ args: [path.join(ROOT, 'src/main.js'), '--no-sandbox'], cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, HUSK_E2E: '1', ELECTRON_DISABLE_SANDBOX: '1' } });
}

function seedConfig(home, extra = {}) {
  const dir = path.join(home, '.config/husk');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  ConfigStore.saveConfigFile(file, JSON.stringify({ firstRunDone: true, welcomeVersion: 2, tourVersion: 2,
    lastSeenVersion: '9.9.9', theme: 'light', accent: 'indigo', ...extra }));
  return file;
}

async function capture(app, file) {
  const win = await app.firstWindow();
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await win.waitForTimeout(150);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
}

test('corrupt settings preserve the original, recover the backup, and explain recovery', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-data-recover-'));
  const file = seedConfig(home);
  fs.writeFileSync(file, '{"firstRunDone":');
  let app;
  try {
    app = await start(home);
    const win = await app.firstWindow();
    await expect(win.getByText(/Husk could not read your settings, so it loaded the last good copy/)).toBeVisible();
    await expect(win.locator('.toast-action', { hasText: 'Open folder' })).toBeVisible();
    const kept = fs.readdirSync(path.dirname(file)).find((name) => name.startsWith('config.json.corrupt-'));
    expect(fs.readFileSync(path.join(path.dirname(file), kept), 'utf8')).toBe('{"firstRunDone":');
    expect((await win.evaluate(() => window.husk.config.get())).theme).toBe('light');
    await capture(app, '/tmp/husk-config-recovery.png');
  } finally {
    if (app) await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Apply lists conflicts, defaults to keeping yours, and retains skipped work', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-data-apply-'));
  const project = path.join(home, 'project');
  const worktree = path.join(home, 'worktree');
  fs.mkdirSync(project); fs.mkdirSync(worktree);
  seedConfig(home, { projects: [{ id: 'p1', name: 'Project', path: project }], activeProjectId: 'p1' });
  let app;
  try {
    app = await start(home);
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    const storage = path.join(userData, 'autonomy');
    const names = ['keep.txt', 'take.txt', 'skip.txt', 'clean.txt'];
    for (const name of names) { fs.writeFileSync(path.join(worktree, name), 'base'); fs.writeFileSync(path.join(project, name), 'base'); }
    expect(Snapshot.captureSnapshot(worktree, storage, 'auto-conflicts').ok).toBe(true);
    for (const name of names) fs.writeFileSync(path.join(worktree, name), 'run');
    for (const name of names.slice(0, 3)) fs.writeFileSync(path.join(project, name), 'mine');
    const changes = names.map((p) => ({ path: p, status: 'modified' }));
    const entry = { runId: 'conflicts', sessionId: 'auto-conflicts', workspaceRoot: project, worktreePath: worktree, changes };
    fs.writeFileSync(path.join(userData, 'autopilot-retained.json'), JSON.stringify({ conflicts: entry }));
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof enterReviewMode === 'function' && document.body && document.body.dataset.rail);
    await win.evaluate(({ project, changes }) => {
      document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
      setPage('autopilot');
      enterReviewMode({ sessionId: 'auto-conflicts', workspaceRoot: project, retained: true, runId: 'conflicts', summary: { diff: changes, summary: { status: 'done' } } });
    }, { project, changes });
    await win.locator('#aut-review-apply').click();
    await expect(win.locator('#confirm-title')).toHaveText('Review files changed in your project');
    await expect(win.locator('.apply-conflict')).toHaveCount(3);
    await expect(win.locator('#confirm-ok')).not.toHaveClass(/btn-danger/);
    await expect(win.locator('.confirm-icon')).toBeHidden();
    for (let i = 0; i < 3; i++) await expect(win.locator(`#apply-conflict-${i}`)).toHaveValue('mine');
    await win.getByLabel('Resolution for take.txt').selectOption('theirs');
    await win.getByLabel('Resolution for skip.txt').selectOption('skip');
    await capture(app, '/tmp/husk-apply-conflicts.png');
    await win.locator('#confirm-ok').click();
    await expect.poll(() => fs.readFileSync(path.join(project, 'take.txt'), 'utf8')).toBe('run');
    expect(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(project, 'skip.txt'), 'utf8')).toBe('mine');
    expect(fs.readFileSync(path.join(project, 'clean.txt'), 'utf8')).toBe('run');
    expect(fs.existsSync(path.join(storage, 'sessions/auto-conflicts-preapply/snapshot.json'))).toBe(true);
    const retained = JSON.parse(fs.readFileSync(path.join(userData, 'autopilot-retained.json')));
    expect(retained.conflicts.changes).toEqual([{ path: 'skip.txt', status: 'modified' }]);
    await win.locator('#aut-review-apply').click();
    await expect(win.locator('.apply-conflict')).toHaveCount(1);
    await win.locator('#confirm-ok').click();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(userData, 'autopilot-retained.json')))).toEqual({});
    expect(fs.readFileSync(path.join(project, 'skip.txt'), 'utf8')).toBe('mine');
    expect((await win.evaluate(() => window.husk.autopilot.applyRun({ runId: 'conflicts' }))).ok).toBe(false);
    fs.writeFileSync(path.join(userData, 'autopilot-retained.json'), JSON.stringify({ moved: { ...entry, runId: 'moved' } }));
    fs.renameSync(project, project + '-moved');
    const moved = await win.evaluate(() => window.husk.autopilot.applyRun({ runId: 'moved', resolutions: { 'keep.txt': 'theirs' } }));
    expect(moved.ok).toBe(false);
    expect(moved.error).toContain('no longer there');
    expect(fs.existsSync(project)).toBe(false);
    expect(fs.readFileSync(path.join(project + '-moved', 'keep.txt'), 'utf8')).toBe('mine');
  } finally {
    if (app) await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
