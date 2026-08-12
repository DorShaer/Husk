'use strict';

// The chat terminal's canvas colours belong to the Husk theme, not to the
// agent running inside it. An agent that assumes it owns the window sets the
// terminal's default background at startup (copilot emits OSC 11;#0D1117
// after probing with OSC 11;?), which painted the canvas the agent's colour
// on first launch — and only there, because a reload reattaches without
// replaying scrollback, so the set never reached the fresh terminal.
//
// The contract: a colour *set* from the agent is swallowed; a pure `?` query
// falls through to xterm, whose answer carries the theme's real colours.
// The answer is how an agent decides it is on a light or a dark background,
// so swallowing queries would break agent theme detection.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch() {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

test('an OSC colour set from the agent does not repaint the canvas, and a query is still answered', async () => {
  const app = await launch();
  try {
    const win = await ready(app);
    const res = await win.evaluate(async () => {
      setPage('chat');
      const tab = createTab();
      activateTab(tab.id);
      const bgOf = () => tab.term._core._themeService.colors.background.css.toLowerCase();
      const before = bgOf();

      // Colour sets, as copilot emits them at startup: background, then
      // foreground. Neither may move the canvas off the theme.
      await new Promise((r) => tab.term.write('\x1b]11;#0D1117\x07', r));
      await new Promise((r) => tab.term.write('\x1b]10;#F0F6FC\x07', r));
      const afterSet = bgOf();

      // A pure query. xterm's answer goes out through onData, the same path
      // keystrokes take to the agent; it must arrive and carry a colour.
      let reply = '';
      tab.term.onData((d) => { reply += d; });
      await new Promise((r) => tab.term.write('\x1b]11;?\x07', r));
      await new Promise((r) => setTimeout(r, 100));

      return { before, afterSet, reply };
    });

    expect(res.afterSet).toBe(res.before);
    expect(res.reply).toContain(']11;rgb:');
  } finally {
    await app.close();
  }
});
