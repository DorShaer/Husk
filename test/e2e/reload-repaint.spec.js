'use strict';

// A renderer reload keeps the main-process PTYs alive and rebuilds the tabs
// around them. The reloaded terminal starts empty and a PTY stream carries no
// history to fill it, so the only thing that can put the conversation back is
// the agent redrawing. A full-screen agent redraws on SIGWINCH, and the kernel
// raises that only when the size actually changes, so reattaching at the size
// the PTY already has leaves the pane blank until something else forces it.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// A stand-in for a full-screen agent: clears and repaints on every SIGWINCH,
// exactly as a TUI running in the alternate screen does. It numbers each paint,
// so a test can tell a fresh redraw from whatever the buffer already held.
function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-repaint-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const inner = path.join(root, 'fake-tui.js');
  fs.writeFileSync(inner, [
    "for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(s, () => process.exit(0));",
    'let n = 0;',
    "const size = () => process.stdout.columns + 'x' + process.stdout.rows;",
    "const paint = () => { n++; process.stdout.write('\\x1b[2J\\x1b[HPAINT-' + n + ' ' + size() + '\\r\\n'); };",
    'paint();',
    "process.on('SIGWINCH', paint);",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  const exe = path.join(bin, 'faketui');
  fs.writeFileSync(exe, `#!/bin/sh\nexec node ${JSON.stringify(inner)} "$@"\n`);
  fs.chmodSync(exe, 0o755);

  fs.writeFileSync(path.join(home, '.config', 'husk', 'config.json'), JSON.stringify({
    firstRunDone: true,
    skipWelcome: true,
    paiEnabled: false,
    voice: { enabled: false },
    agentCommand: exe,
    agentCwd: project,
  }));
  return { root, home, exe };
}

// First three rows of the active tab's terminal, which is where the stand-in
// paints its marker.
function topRows(win) {
  return win.evaluate(() => {
    const tab = [...TABS.values()][0];   // eslint-disable-line no-undef
    if (!tab) return 'NO TAB';
    let out = '';
    for (let i = 0; i < 3; i++) {
      const line = tab.term.buffer.active.getLine(i);
      if (line) out += line.translateToString(true).trim();
    }
    return out;
  });
}

test('reattaching a live session makes a full-screen agent repaint', async () => {
  const env = makeEnv();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);

  // pty:start answers with the session id itself, not a wrapper object.
  const sessionId = await win.evaluate(() => window.husk.pty.start({ cols: 100, rows: 30 }));
  await win.waitForFunction(() => {
    const tab = [...TABS.values()][0];   // eslint-disable-line no-undef
    if (!tab) return false;
    const line = tab.term.buffer.active.getLine(0);
    return !!line && /PAINT-\d+/.test(line.translateToString(true));
  }, null, { timeout: 15_000 });

  // The paint count at this point depends on how many times the window settled
  // during boot, which differs between a desktop and a CI screen. What matters
  // is that reattaching adds one, so the count is read rather than assumed.
  const paintCount = async () => {
    const t = await topRows(win);
    const m = /PAINT-(\d+)/.exec(t);
    return m ? Number(m[1]) : 0;
  };
  const before = await paintCount();
  expect(before, await topRows(win)).toBeGreaterThan(0);

  // Reattach at exactly the size the PTY already has, which is what a reloaded
  // renderer asks for. The agent has to paint again for the pane to fill.
  // The renderer reattaches at the terminal's own size, which is the case that
  // matters: the PTY is already there, so nothing changes and nothing repaints.
  const reattached = await win.evaluate((sid) => {
    const t = [...TABS.values()][0].term;   // eslint-disable-line no-undef
    return window.husk.pty.reattach({ sessionId: sid, cols: t.cols, rows: t.rows, activate: true });
  }, sessionId);
  expect(reattached.ok, JSON.stringify(reattached)).toBe(true);

  await win.waitForFunction((n) => {
    const line = [...TABS.values()][0].term.buffer.active.getLine(0);   // eslint-disable-line no-undef
    if (!line) return false;
    const m = /PAINT-(\d+)/.exec(line.translateToString(true));
    return !!m && Number(m[1]) > n;
  }, before, { timeout: 10_000 });

  // The repaint is not bought by leaving a wrong size behind. Each paint clears
  // the screen first, so what survives is the agent's most recent view of its
  // own size, and that has to agree with the terminal showing it.
  await win.waitForFunction(() => {
    const t = [...TABS.values()][0].term;   // eslint-disable-line no-undef
    const b = t.buffer.active;
    let all = '';
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) all += l.translateToString(true).trim(); }
    return all.includes(`${t.cols}x${t.rows}`);
  }, null, { timeout: 10_000 });

  await app.close();
  fs.rmSync(env.root, { recursive: true, force: true });
});
