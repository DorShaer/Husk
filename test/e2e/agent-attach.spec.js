'use strict';

// Reaching a background agent from the command center. A live agent is opened
// by attaching to it, and the fleet it is picked from spans every project, not
// only the directory the current chat happens to sit in.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const sanitize = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// One live agent in each of two projects, so a fleet scoped to one directory
// is visibly short of the other.
function makeFleet(now, husk, other) {
  const mk = (id, sessionId, name, cwd, state, pid) => ({
    kind: 'background', id, sessionId, name, cwd, state, status: state,
    startedAt: now - 5 * 60_000, ...(pid ? { pid } : {}),
  });
  return [
    mk('agent-here', '96cb2d85-26b1-4dc7-abb3-467de954ff69', 'Harden the release workflow', husk, 'blocked', 4021),
    mk('agent-away', 'a1b2c3d4-1111-4dc7-abb3-000000000001', 'Audit the scanner findings', other, 'working', 4022),
    mk('agent-past', 'a1b2c3d4-2222-4dc7-abb3-000000000002', 'Review uncommitted changes', husk, 'done'),
  ];
}

function writeTranscript(homeDir, cwd, sessionId, name) {
  const dir = path.join(homeDir, '.claude', 'projects', sanitize(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'user', message: { role: 'user', content: `${name}.` }, timestamp: new Date().toISOString(), cwd, session_id: sessionId },
  ];
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function makeHome() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-agent-attach-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, agentCommand: 'claude',
  }));
  const husk = path.join(homeDir, 'code', 'husk');
  const other = path.join(homeDir, 'code', 'scanner');
  fs.mkdirSync(husk, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  const fleet = makeFleet(Date.now(), husk, other);
  for (const a of fleet) writeTranscript(homeDir, a.cwd, a.sessionId, a.name);
  const agentsFile = path.join(homeDir, 'agents.json');
  fs.writeFileSync(agentsFile, JSON.stringify(fleet));
  const argvFile = path.join(homeDir, 'argv.log');
  fs.writeFileSync(argvFile, '');
  return { homeDir, agentsFile, argvFile, husk, other };
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
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });
}

async function openCenter(app, { chatCwd = '' } = {}) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  // A chat gives the main process a working directory. Anything that narrows
  // the fleet to it would hide the agents living anywhere else.
  if (chatCwd) {
    await win.evaluate((cwd) => window.husk.pty.start({ cols: 80, rows: 24, cwd, sessionId: 'seed' }), chatCwd);
    await win.waitForTimeout(700);
  }
  await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
  await win.evaluate(() => openAgentMap());               // eslint-disable-line no-undef
  await win.waitForFunction(() => agentMap.rows.length > 0, null, { timeout: 20_000 }); // eslint-disable-line no-undef
  return win;
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('the fleet spans every project, so an agent started elsewhere is still listed', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await openCenter(app, { chatCwd: env.husk });

    const listed = await win.evaluate(() => agentMap.rows.map((a) => a.id)); // eslint-disable-line no-undef
    expect(listed, 'an agent from another project was missing from the fleet').toContain('agent-away');
    expect(listed).toContain('agent-here');

    // The listing must not be narrowed to one directory, or the agents in
    // every other project become unreachable.
    const asked = lines(env.argvFile).filter((l) => l.startsWith('agents '));
    expect(asked.length, 'the app never asked for the agent list').toBeGreaterThan(0);
    for (const call of asked) {
      expect(call, `the fleet was scoped to one project: ${call}`).not.toContain('--cwd');
    }
  } finally {
    await app.close();
  }
});

test('a live agent is opened by attaching to it, by id', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await openCenter(app);

    await win.evaluate(() => amSelect('agent-here'));      // eslint-disable-line no-undef
    await win.waitForTimeout(300);

    const btn = await win.evaluate(() => {
      const b = document.querySelector('#am-d-open');
      return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
    });
    expect(btn, 'the open control was not rendered').not.toBeNull();
    expect(btn.disabled, 'a live agent could not be opened').toBe(false);
    expect(btn.text, 'an agent waiting on the user is answered, not merely opened').toBe('Respond');

    await win.click('#am-d-open');
    await win.waitForTimeout(2500);

    const attach = lines(env.argvFile).filter((l) => l.startsWith('attach '));
    expect(attach, 'opening a live agent did not attach to it').toContain('attach agent-here');

    // The fleet list is a list of every agent, so landing on it is landing
    // nowhere in particular.
    const picker = lines(env.argvFile).filter((l) => l === 'agents');
    expect(picker.length, 'opening an agent dropped the user on the agent list').toBe(0);
  } finally {
    await app.close();
  }
});

test('a finished agent resumes its own session instead of attaching', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await openCenter(app);

    await win.evaluate(() => amSelect('agent-past'));      // eslint-disable-line no-undef
    await win.waitForTimeout(300);

    const text = await win.evaluate(() => document.querySelector('#am-d-open').textContent.trim());
    expect(text).toBe('Open session');

    await win.click('#am-d-open');
    await win.waitForTimeout(2500);

    const resumed = lines(env.argvFile).filter((l) => l.includes('--resume'));
    expect(resumed.join('\n'), 'a finished agent did not resume its own session')
      .toContain('--resume a1b2c3d4-2222-4dc7-abb3-000000000002');
  } finally {
    await app.close();
  }
});

// Being done with an agent. A live one is stopped and keeps its conversation;
// one that has already ended is removed outright.
test('a live agent can be stopped from the panel that reports it', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await openCenter(app);

    await win.evaluate(() => amSelect('agent-here'));       // eslint-disable-line no-undef
    await win.waitForTimeout(300);

    const end = win.locator('#am-d-end');
    await expect(end, 'there is no way to end a live agent').toBeVisible();
    await expect(end).toHaveText('Stop');
    await expect(end).toBeEnabled();

    await end.click();
    await win.waitForTimeout(2000);

    const stopped = lines(env.argvFile).filter((l) => l.startsWith('stop '));
    expect(stopped, 'pressing Stop did not stop the agent').toContain('stop agent-here');
    // The panel says so rather than leaving the press unanswered.
    await expect(win.locator('#toast-stack')).toContainText('Stopped');
    // Stopping keeps the conversation, so nothing is removed on the way.
    expect(lines(env.argvFile).filter((l) => l.startsWith('rm ')).length,
      'stopping an agent deleted it instead').toBe(0);
  } finally {
    await app.close();
  }
});

test('an agent that has already ended offers removal instead of a stop', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await openCenter(app);

    await win.evaluate(() => amSelect('agent-past'));       // eslint-disable-line no-undef
    await win.waitForTimeout(300);

    const end = win.locator('#am-d-end');
    await expect(end).toHaveText('Delete');

    // Removal is not undoable, so it asks first, and answering no does nothing.
    await end.click();
    await win.waitForTimeout(400);
    await win.click('#confirm-cancel');
    await win.waitForTimeout(600);
    expect(lines(env.argvFile).filter((l) => l.startsWith('rm ')).length,
      'the agent was deleted although the confirmation was declined').toBe(0);

    await end.click();
    await win.waitForTimeout(400);
    await win.click('#confirm-ok');
    await win.waitForTimeout(2000);
    expect(lines(env.argvFile).filter((l) => l.startsWith('rm ')),
      'confirming did not remove the agent').toContain('rm agent-past');
  } finally {
    await app.close();
  }
});

// The pill, the center and the switcher are three windows onto one fleet. When
// they ask different questions they report different totals, and the number in
// the corner stops meaning anything.
const chipCount = (win) => win.evaluate(() => {
  const el = document.querySelector('#topbar-agents');
  return { hidden: el.hidden, n: Number((document.querySelector('#topbar-agents-count') || {}).textContent || 0) };
});

test('the pill, the center and the switcher agree about the fleet', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
    await win.waitForTimeout(2500);

    // Two of the three fixture agents are live, and that is what the pill counts.
    const chip = await chipCount(win);
    expect(chip.hidden, 'the pill hid itself although agents exist').toBe(false);

    await win.evaluate(() => openAgentMap());              // eslint-disable-line no-undef
    await win.waitForFunction(() => agentMap.rows.length > 0, null, { timeout: 20_000 }); // eslint-disable-line no-undef
    const center = await win.evaluate(() => ({            // eslint-disable-line no-undef
      total: agentMap.rows.length,                         // eslint-disable-line no-undef
      live: agentMap.rows.filter((a) => a.running).length, // eslint-disable-line no-undef
    }));
    expect(center.total, 'the center lost agents the fixture published').toBe(3);
    expect(chip.n, 'the pill counts a different set from the center').toBe(center.live);

    await win.evaluate(() => closeAgentMap());            // eslint-disable-line no-undef
    await win.waitForTimeout(300);
    await win.evaluate(() => openAgentSwitch());          // eslint-disable-line no-undef
    await win.waitForFunction(() => agentSwitch.rows.length > 0, null, { timeout: 20_000 }); // eslint-disable-line no-undef
    const switcher = await win.evaluate(() => agentSwitch.rows.length); // eslint-disable-line no-undef
    expect(switcher, 'the switcher sees a different fleet from the center').toBe(center.total);
  } finally {
    await app.close();
  }
});

test('with nothing live the pill reports the same total the center does', async () => {
  const env = makeHome();
  // Every agent finished: the pill has no live count to show and must not
  // invent one from whichever records the CLI still happens to return.
  const done = JSON.parse(fs.readFileSync(env.agentsFile, 'utf8'))
    .map((a) => ({ ...a, state: 'done', status: 'done', pid: undefined }));
  fs.writeFileSync(env.agentsFile, JSON.stringify(done));

  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
    await win.waitForTimeout(2500);

    const chip = await chipCount(win);
    await win.evaluate(() => openAgentMap());             // eslint-disable-line no-undef
    await win.waitForFunction(() => agentMap.rows.length > 0, null, { timeout: 20_000 }); // eslint-disable-line no-undef
    const total = await win.evaluate(() => agentMap.rows.length); // eslint-disable-line no-undef

    expect(total).toBe(3);
    expect(chip.n, 'the pill showed a number the center does not report').toBe(total);
  } finally {
    await app.close();
  }
});

test('the shortcut the pill advertises opens the pill', async () => {
  const env = makeHome();
  const app = await launch(env);
  try {
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => typeof openAgentMap === 'function', null, { timeout: 20_000 });
    await win.waitForTimeout(1500);

    await expect(win.locator('#topbar-agents')).toHaveAttribute('title', /Alt\+A/);
    // Alt combinations do not reach the page through the driver on Linux: the
    // window manager takes Alt for the menu bar and the second key never
    // arrives. The event the app listens for is raised directly instead.
    await win.evaluate(() => window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', altKey: true, bubbles: true })));
    await win.waitForTimeout(900);
    await expect(win.locator('#agent-map'), 'Alt+A opened something other than the center').not.toBeHidden();
  } finally {
    await app.close();
  }
});
