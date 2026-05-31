'use strict';

// Recap voice: read the agent's spoken-summary line from the rendered grid and
// speak it cleanly, once per turn.
//
// A full-screen agent (copilot) streams its reply while redrawing the screen
// with cursor positioning, which interleaves UI chrome (status bar, prompt)
// into the raw byte stream. Reading the byte stream therefore used to speak the
// recap WITH chrome bleed ("~ / commands ? help ... nice to meet you"). The fix
// reads the rendered grid, where each line is on its own clean row. This drives
// a fixture that paints recap + chrome on separate rows (interleaved in the
// byte stream) and asserts the spoken text is the clean recap, exactly once.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'recap-echo.js');
const CLEAN_RECAP = 'Nice to meet you too, happy to help with anything you need.';

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-recap-'));
  const cfgDir = path.join(dir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    agentCommand: `node ${FIXTURE}`,
    paiEnabled: false,
    voice: { enabled: true, name: 'en_US-amy-medium', rate: 1.0 },
    recap: true,
    firstRunDone: true,
    skipWelcome: true,
  }));
  return dir;
}

test('recap is read from the grid, cleanly (no chrome), exactly once', async () => {
  const homeDir = makeHome();
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
    },
    timeout: 30_000,
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  // Wait until boot has loaded the voice-enabled cfg into the renderer.
  await win.waitForFunction(() => {
    try { return typeof cfg !== 'undefined' && cfg && cfg.voice && cfg.voice.enabled === true; } // eslint-disable-line no-undef
    catch (_) { return false; }
  }, null, { timeout: 15_000 });

  // Record what would be spoken, arm a user turn, and spawn the fixture agent.
  await win.evaluate(() => {
    window.__spoken = [];
    window.speak = (t) => window.__spoken.push(t); // eslint-disable-line no-undef
    resetSpeechState(); // eslint-disable-line no-undef
    armRecap();         // eslint-disable-line no-undef
    setPage('chat');    // eslint-disable-line no-undef
  });
  await win.evaluate(() => window.husk.pty.start({ cols: 100, rows: 30 }));

  // Wait past the settle window AND past the fixture's 3s redraw, so a second
  // read would have happened if the guard were broken.
  await win.waitForTimeout(5000);

  const spoken = await win.evaluate(() => window.__spoken);
  await app.close();

  expect(spoken).toEqual([CLEAN_RECAP]);
});
