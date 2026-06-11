'use strict';

// Regression: on a short window the rail's bottom group (tool selector +
// Preferences) and the status panel footer (check for updates) must stay
// visible, with the rail middle and status content scrolling. The root cause
// was #main using an implicit auto grid row that grew to the tallest column
// and pushed everyone's bottom past the viewport.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('short window keeps the rail bottom and status footer visible (issue 4)', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  // Without firstRunDone, boot() blocks on the welcome wizard (no agent CLI
  // on CI runners), leaving the status panel empty and stealing clicks.
  fs.writeFileSync(path.join(homeDir, '.config', 'husk', 'config.json'), JSON.stringify({ firstRunDone: true }));
  const app = await electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1100, 620); });
  await win.waitForTimeout(200);

  const info = await win.evaluate(() => {
    // Make the rail tall so it would overflow without the fix.
    const rec = document.getElementById('rail-recent');
    const list = document.getElementById('rail-recent-list');
    if (rec) rec.hidden = false;
    if (list) {
      list.replaceChildren();
      for (let i = 0; i < 12; i++) {
        const b = document.createElement('button');
        b.className = 'rail-sub-item';
        b.textContent = 'Recent chat number ' + i;
        list.appendChild(b);
      }
    }
    document.body.dataset.rail = 'expanded';
    const vh = window.innerHeight;
    const bottom = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().bottom) : null; };
    const scrollEl = document.querySelector('.rail-scroll');
    const spContent = document.getElementById('sp-content');
    return {
      vh,
      prefsBottom: bottom('.rail-item[data-page="preferences"]'),
      toolBottom: bottom('#rail-agent-pill'),
      spFootBottom: bottom('.sp-foot'),
      railScrollable: scrollEl ? scrollEl.scrollHeight > scrollEl.clientHeight : false,
      spScrollable: spContent ? spContent.scrollHeight > spContent.clientHeight : false,
    };
  });

  // Bottom-pinned controls fit inside the window (allow a 1px rounding slack).
  expect(info.prefsBottom).toBeLessThanOrEqual(info.vh + 1);
  expect(info.toolBottom).toBeLessThanOrEqual(info.vh + 1);
  expect(info.spFootBottom).toBeLessThanOrEqual(info.vh + 1);
  // The overflow goes to the scroll regions, not off the window.
  expect(info.railScrollable).toBe(true);
  expect(info.spScrollable).toBe(true);
  await app.close();
});
