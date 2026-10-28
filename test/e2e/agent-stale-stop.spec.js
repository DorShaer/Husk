'use strict';

// An agent the CLI still lists as live but can no longer reach: one left
// waiting on the user weeks ago whose worker has since exited. Pressing Stop
// on it cannot succeed, and before this it answered with the CLI's own words
// (dash and all) and an invitation to try again forever. Now it offers the
// way out, which is deleting the agent, and the words on screen are Husk's.
//
// The search field in the same header is covered here too: the dark family's
// black input well was painting a block behind its placeholder.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-agent-stale-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude', theme: 'dark',
  }));
  const proj = path.join(homeDir, 'code', 'suite');
  fs.mkdirSync(proj, { recursive: true });
  const sessionId = '6798a198-5978-47b0-8a31-e91adc95c989';
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(proj));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'user', message: { role: 'user', content: 'run the crawler here and get all the new pages' },
    timestamp: new Date(Date.now() - 58 * 86_400_000).toISOString(), cwd: proj, session_id: sessionId,
  }) + '\n');
  // No pid: the worker is gone, which is the whole situation under test.
  const fleet = [{
    kind: 'background', id: '6798a198', sessionId, name: 'Run crawler for new pages', cwd: proj,
    state: 'blocked', status: 'blocked', startedAt: Date.now() - 58 * 86_400_000,
  }];
  const agentsFile = path.join(homeDir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify(fleet));
  const argvFile = path.join(homeDir, 'argv.log');
  fs.writeFileSync(argvFile, '');
  return { homeDir, agentsFile, argvFile };
}

function launch(env) {
  const fixtureBin = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-fake-bin-'));
  const shim = path.join(fixtureBin, 'claude');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-claude-agents.js')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      PATH: `${fixtureBin}:${process.env.PATH}`,
      FAKE_AGENTS_FILE: env.agentsFile,
      FAKE_AGENTS_ARGV: env.argvFile,
      FAKE_STALE_STOP: '1',
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('a stop the CLI cannot confirm offers deletion instead, in words without a dash', async () => {
  test.setTimeout(90_000);
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
    await win.evaluate(() => openAgentMap());               // eslint-disable-line no-undef
    await win.waitForFunction(() => agentMap.rows.length > 0, null, { timeout: 20_000 }); // eslint-disable-line no-undef
    await win.evaluate(() => amSelect('6798a198'));          // eslint-disable-line no-undef
    await win.waitForTimeout(300);

    const end = win.locator('#am-d-end');
    await expect(end).toHaveText('Stop');
    await end.click();

    // One retry after the pause the CLI asks for, then the offer.
    await win.waitForFunction(() => !document.getElementById('confirm-modal').hidden, null, { timeout: 20_000 });
    const stops = lines(env.argvFile).filter((l) => l.startsWith('stop '));
    expect(stops.length, 'a stop that cannot be confirmed is tried twice, not once and not forever').toBe(2);
    await expect(win.locator('#confirm-title')).toContainText('cannot be stopped');
    await expect(win.locator('#confirm-body')).toContainText('Run crawler for new pages');
    const onScreen = await win.evaluate(() => document.getElementById('confirm-modal').textContent + (document.getElementById('toast-stack') || {}).textContent);
    expect(onScreen, 'the CLI\'s dash reached the screen').not.toMatch(/[—–]/);
    expect(onScreen).not.toMatch(/background service/);

    // Declining leaves everything as it was.
    await win.click('#confirm-cancel');
    await win.waitForTimeout(400);
    expect(lines(env.argvFile).filter((l) => l.startsWith('rm ')).length).toBe(0);
    await expect(end).toHaveText('Stop');
    await expect(end).toBeEnabled();

    // Accepting removes the agent and says so.
    await end.click();
    await win.waitForFunction(() => !document.getElementById('confirm-modal').hidden, null, { timeout: 20_000 });
    await win.click('#confirm-ok');
    await expect(win.locator('#toast-stack')).toContainText('Deleted Run crawler for new pages', { timeout: 10_000 });
    expect(lines(env.argvFile).filter((l) => l.startsWith('rm '))).toContain('rm 6798a198');
    const toasts = await win.evaluate(() => (document.getElementById('toast-stack') || {}).textContent || '');
    expect(toasts).not.toMatch(/[—–]/);
  } finally {
    await app.close();
  }
});

test('the search field in the agents header has no well of its own in dark mode', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
    await win.evaluate(() => openAgentMap());               // eslint-disable-line no-undef
    await win.waitForSelector('#am-search-input', { timeout: 10_000 });
    const mode = await win.evaluate(() => document.body.dataset.mode);
    expect(mode).toBe('dark');
    const read = () => win.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('am-search-input'));
      return { bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow };
    });
    expect(await read()).toEqual({ bg: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' });
    await win.focus('#am-search-input');
    expect(await read()).toEqual({ bg: 'rgba(0, 0, 0, 0)', border: '0px', shadow: 'none' });
  } finally {
    await app.close();
  }
});
