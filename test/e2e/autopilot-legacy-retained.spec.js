'use strict';

// Runs retained by an older Husk can carry fields the app no longer reads (a
// shared comparison id across sibling runs). Each one must still list as an
// ordinary run in Autopilot history and Artifacts, open in review, and apply
// or discard through the normal retained-run path.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const Audit = require('../../src/lib/autonomy/audit');
const Snapshot = require('../../src/lib/autonomy/snapshot');

function launch(projectDir) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-legacy-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, lastSeenVersion: pkgVersion,
    projects: [{ id: 'p1', name: 'legacy-proj', path: projectDir }],
    activeProjectId: 'p1',
  }, null, 2));
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

// One finished run as the engine leaves it: a snapshot of its worktree taken
// before the edit, an audit log, and the edited worktree.
function seedRun({ storageRoot, sessionId, runId, projectDir, worktree, text }) {
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'base\n');
  const snap = Snapshot.captureSnapshot(worktree, storageRoot, sessionId);
  if (!snap.ok) throw new Error(snap.error);
  fs.writeFileSync(path.join(worktree, 'a.txt'), text);
  const log = Audit.createAuditLog(storageRoot, sessionId).writer;
  log.append({ kind: 'run_identity', payload: { workspaceRoot: projectDir, runId, agent: 'claude' } });
  log.append({ kind: 'start_run', payload: { goal: 'Tidy the readme' } });
  log.append({ kind: 'run_summary', payload: { status: 'done', endedAt: new Date().toISOString(), diff: [{ path: 'a.txt', status: 'modified' }] } });
  return {
    runId, sessionId, raceId: 'legacy-group-1', goal: 'Tidy the readme', agent: 'claude',
    workspaceRoot: projectDir, worktreePath: worktree, changes: [{ path: 'a.txt', status: 'modified' }],
  };
}

test('a legacy retained run lists, opens, applies and discards as an ordinary run', async () => {
  test.setTimeout(120_000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-legacy-ws-'));
  const projectDir = path.join(tmp, 'project');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'base\n');

  const app = await launch(projectDir);
  try {
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
    const storageRoot = path.join(userData, 'autonomy');
    const a = seedRun({ storageRoot, sessionId: 'auto-legacy-a', runId: 'run-a', projectDir, worktree: path.join(tmp, 'wt-a'), text: 'from A\n' });
    const b = seedRun({ storageRoot, sessionId: 'auto-legacy-b', runId: 'run-b', projectDir, worktree: path.join(tmp, 'wt-b'), text: 'from B\n' });
    fs.writeFileSync(path.join(userData, 'autopilot-retained.json'), JSON.stringify({ 'run-a': a, 'run-b': b }, null, 2));

    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => document.body && document.body.dataset.rail);
    await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

    // History: two separate ordinary runs, each flagged retained.
    const hist = await win.evaluate(() => window.husk.autopilot.history({}));
    const mine = hist.runs.filter((r) => r.sessionId.startsWith('auto-legacy-'));
    expect(mine.map((r) => r.sessionId).sort()).toEqual(['auto-legacy-a', 'auto-legacy-b']);
    expect(mine.every((r) => r.retained && r.memberCount === 1)).toBe(true);

    // Artifacts: both rows present.
    await win.locator('.rail-item[data-page="artifacts"]').click();
    await expect.poll(() => win.evaluate(() => window.Af.state.rows.filter((r) => r.source === 'autopilot').length), { timeout: 20_000 }).toBe(2);

    // Autopilot history: open A, Apply lands its file.
    await win.locator('.rail-item[data-page="autopilot"]').click();
    const rowA = win.locator('#aut-recent .aut-recent-row[data-session="run:auto-legacy-a"]');
    await expect(rowA).toBeVisible({ timeout: 20_000 });
    await rowA.click();
    await expect(win.locator('#aut-review-apply')).toBeVisible({ timeout: 20_000 });
    await expect(win.locator('#aut-review-discard')).toBeVisible();
    await win.locator('#aut-review-apply').click();
    await win.locator('#confirm-ok').click();
    await expect.poll(() => fs.readFileSync(path.join(projectDir, 'a.txt'), 'utf8')).toBe('from A\n');
    expect(fs.existsSync(a.worktreePath)).toBe(false);

    // B survives A's apply and discards on its own.
    const left = JSON.parse(fs.readFileSync(path.join(userData, 'autopilot-retained.json'), 'utf8'));
    expect(Object.keys(left)).toEqual(['run-b']);
    const rowB = win.locator('#aut-recent .aut-recent-row[data-session="run:auto-legacy-b"]');
    await expect(rowB).toBeVisible({ timeout: 20_000 });
    await rowB.click();
    await expect(win.locator('#aut-review-discard')).toBeVisible({ timeout: 20_000 });
    await win.locator('#aut-review-discard').click();
    await win.locator('#confirm-ok').click();
    await expect.poll(() => fs.existsSync(b.worktreePath)).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, 'a.txt'), 'utf8')).toBe('from A\n');
    expect(JSON.parse(fs.readFileSync(path.join(userData, 'autopilot-retained.json'), 'utf8'))).toEqual({});
  } finally {
    await app.close();
  }
});
