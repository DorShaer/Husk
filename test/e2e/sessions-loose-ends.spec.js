'use strict';

// Sessions roster edges: more history than one load holds, a session whose
// folder was deleted, and a CLI whose transcript Husk cannot read.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { seedClaude } = require('../helpers/session-fixture');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function launch(seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const project = path.join(home, 'project');
  fs.mkdirSync(path.join(home, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(home, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, resumeLastOnLaunch: false, agentCommand: 'claude', agentCwd: project,
  }));
  seed(home, project);
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => window.husk && typeof sxPaint === 'function');
  await win.evaluate(() => { document.querySelectorAll('.modal,#whatsnew').forEach((m) => { m.hidden = true; }); });
  return { app, win, home };
}

async function openSessions(win) {
  await win.evaluate(async () => {
    setPage('sessions');
    sxPausePoll(true);
    sx.chips = { project: false, live: false, needs: false, work: false };
    await sxLoad({ firstPaint: false });
  });
}

test('a history past one load says how much is hidden and Show older loads it', async () => {
  const { app, win, home } = await launch((h, project) => seedClaude(h, { count: 305, sizes: 'tiny', cwdFor: () => project }));
  try {
    await openSessions(win);
    await expect(win.locator('#sessions-sub .sx-older-unread')).toHaveText('Up to 5 older sessions are not loaded');
    expect(await win.evaluate(() => sx.cache.length)).toBe(300);
    await win.locator('#sx-show-older').click();
    await expect(win.locator('#sx-show-older')).toHaveCount(0);
    expect(await win.evaluate(() => sx.cache.length)).toBe(305);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('a session whose folder is gone is grouped under its own heading', async () => {
  const { app, win, home } = await launch((h, project) => {
    const gone = path.join(project, 'deleted-worktree');
    seedClaude(h, { count: 2, sizes: 'tiny', cwdFor: (i) => (i ? gone : project) });
  });
  try {
    await openSessions(win);
    await expect(win.locator('#sx-list .sx-g-name', { hasText: 'Folder no longer exists' })).toHaveCount(1);
    const missing = await win.evaluate(() => sx.cache.filter((s) => s.cwdMissing).map((s) => s.originalCwd));
    expect(missing).toEqual([path.join(home, 'project', 'deleted-worktree')]);
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('peek reads any CLI Husk can and says so plainly where it cannot', async () => {
  const copilotId = 'c0000001-0000-4000-8000-000000000000';
  const { app, win, home } = await launch((h) => {
    const dir = path.join(h, '.copilot', 'session-state', copilotId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `id: ${copilotId}\ncwd: ${h}\n`);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [
      { type: 'user.message', timestamp: new Date().toISOString(), data: { content: 'tidy the readme' } },
      { type: 'assistant.message', timestamp: new Date().toISOString(), data: { content: 'Tidied.' } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  });
  try {
    const copilot = await win.evaluate((id) => window.husk.bgAgents.peek({ agent: 'copilot', sessionId: id }), copilotId);
    expect(copilot.entries.map((e) => [e.kind, e.text])).toEqual([['user', 'tidy the readme'], ['assistant', 'Tidied.']]);
    expect(copilot.noPreview).toBeFalsy();

    await win.evaluate(async () => {
      setPage('sessions');
      sxPausePoll(true);
      await sxLoad({ firstPaint: false });
      Object.assign(sx, { loaded: true, supported: true, error: '', agent: 'gemini', currentCwd: '', chips: { project: false, live: false, needs: false, work: false } });
      sx.cache = [{ id: 'gem-session-1', agent: 'gemini', title: 'A gemini chat', projectPath: '/p', originalCwd: '/p', path: '/p/g.jsonl', mtime: Date.now() }];
      sx.detailId = 'gem-session-1';
      sx.detailTab = 'activity';
      sxPaint();
      await sxPeek('gem-session-1');
    });
    await expect(win.locator('#sx-d-body .sx-d-note')).toHaveText('No live preview for this CLI');
  } finally { await app.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
