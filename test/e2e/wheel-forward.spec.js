'use strict';

// Wheel-forwarding end-to-end: a full-screen agent (copilot) runs in the
// alternate screen and turns mouse reporting on so it can scroll its own
// transcript. Husk strips that reporting from xterm so drag-to-select stays
// local, then forwards ONLY the wheel to the agent. This drives a real wheel
// over the terminal and asserts the SGR scroll sequence reaches the agent.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'mouse-echo.js');

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-wheel-'));
  const cfgDir = path.join(dir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    agentCommand: `node ${FIXTURE}`,
    paiEnabled: false,
    voice: { enabled: false },
    skipWelcome: true,
    firstRunDone: true,
  }));
  return dir;
}

test('wheel over the terminal is forwarded to an agent with mouse reporting on', async () => {
  const homeDir = makeHome();
  const capture = path.join(homeDir, 'wheel.bin');
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      WHEEL_CAPTURE: capture,
    },
    timeout: 30_000,
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => document.body && document.body.dataset.rail);

  // Go to chat and spawn the fixture agent.
  await win.evaluate(() => { setPage('chat'); }); // eslint-disable-line no-undef
  await win.waitForTimeout(150);
  await win.evaluate(() => window.husk.pty.start({ cols: 100, rows: 30 }));

  // Wait until the agent's "ready" output has rendered (so mouse reporting has
  // been seen and propagated to the renderer).
  await win.locator('.xterm-screen').waitFor({ state: 'visible', timeout: 10_000 });
  await win.waitForFunction(() => /ready/.test(document.querySelector('.xterm-screen')?.innerText || ''), null, { timeout: 10_000 });

  // Drive a real wheel-down over the terminal.
  await win.locator('.xterm-screen').hover();
  await win.mouse.wheel(0, 120);
  await win.mouse.wheel(0, 120);
  await win.waitForTimeout(400);

  await app.close();

  const got = fs.existsSync(capture) ? fs.readFileSync(capture, 'latin1') : '';
  // SGR wheel-down is button 65 (up is 64): ESC [ < 6[45] ; col ; row M
  expect(/\x1b\[<6[45];\d+;\d+M/.test(got)).toBe(true);
});
