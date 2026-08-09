'use strict';

// On a short window the rail bottom group and status footer remain visible.
// The rail's middle section scrolls; the status body scales its content to fit,
// so every section stays on screen and nothing is clipped.
//
// The fit tracks window height only, so the status panel's painted content
// grows with every zoom step.

const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('short window keeps the rail bottom and status footer visible', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  // firstRunDone carries boot() past the welcome wizard, which needs an agent
  // CLI that CI runners do not have.
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

  // The status panel fills in over IPC after boot, so wait for its sections to
  // exist before shrinking the window around them.
  await win.waitForFunction(() => {
    const fit = document.getElementById('sp-fit');
    return !!fit && fit.children.length > 0 && fit.scrollHeight > 0;
  }, null, { timeout: 15_000 });

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1100, 620); });

  // Fill the rail so its middle section has to scroll, then wait for the layout
  // and the status panel's fit pass (driven by a ResizeObserver) to settle.
  await win.evaluate(() => {
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
  });
  await win.waitForFunction(() => {
    const scrollEl = document.querySelector('.rail-scroll');
    const box = document.getElementById('sp-content');
    const fit = document.getElementById('sp-fit');
    if (!scrollEl || !box || !fit) return false;
    // The rail overflows, and the status content has been fitted to its box.
    const fitted = fit.getBoundingClientRect().height <= box.clientHeight + 1;
    return scrollEl.scrollHeight > scrollEl.clientHeight && fitted;
  }, null, { timeout: 10_000 });

  const info = await win.evaluate(() => {
    const bottom = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().bottom) : null; };
    const scrollEl = document.querySelector('.rail-scroll');
    const box = document.getElementById('sp-content');
    const fit = document.getElementById('sp-fit');
    const foot = document.querySelector('.sp-foot');
    return {
      vh: window.innerHeight,
      prefsBottom: bottom('#btn-open-prefs'),
      toolBottom: bottom('#rail-agent-pill'),
      spFootBottom: bottom('.sp-foot'),
      railScrollable: scrollEl.scrollHeight > scrollEl.clientHeight,
      // The status body clips its overflow and scales #sp-fit, so the check is
      // that the rendered content fits.
      fitHeight: Math.round(fit.getBoundingClientRect().height),
      boxHeight: box.clientHeight,
      fitBottom: Math.round(fit.getBoundingClientRect().bottom),
      footTop: foot ? Math.round(foot.getBoundingClientRect().top) : null,
      sectionCount: fit.children.length,
    };
  });

  // Bottom-pinned controls fit inside the window (allow a 1px rounding slack).
  expect(info.prefsBottom).toBeLessThanOrEqual(info.vh + 1);
  expect(info.toolBottom).toBeLessThanOrEqual(info.vh + 1);
  expect(info.spFootBottom).toBeLessThanOrEqual(info.vh + 1);
  // The rail sends its overflow to its scroll region rather than off the window.
  expect(info.railScrollable).toBe(true);
  // The status panel really has sections to lay out, and every one of them is
  // visible: the fitted content stays inside its box and above the footer.
  expect(info.sectionCount).toBeGreaterThan(0);
  expect(info.fitHeight).toBeLessThanOrEqual(info.boxHeight + 1);
  expect(info.fitBottom).toBeLessThanOrEqual(info.footTop + 1);

  await app.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('zooming in enlarges the status panel content', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
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
  await win.waitForFunction(() => {
    const fit = document.getElementById('sp-fit');
    return !!fit && fit.children.length > 0 && fit.scrollHeight > 0;
  }, null, { timeout: 15_000 });

  // devicePixelRatio carries the zoom, so multiplying the CSS height by it
  // gives the size on screen.
  const paintedHeight = () => win.evaluate(() => {
    const fit = document.getElementById('sp-fit');
    return fit.getBoundingClientRect().height * window.devicePixelRatio;
  });

  const painted = [await paintedHeight()];
  for (let step = 0; step < 4; step++) {
    await win.evaluate(() => window.husk.ui.zoomIn());
    // The fit pass runs off a ResizeObserver, so wait for it to settle.
    await win.waitForTimeout(400);
    painted.push(await paintedHeight());
  }

  // Every step paints strictly larger than the one before it.
  for (let i = 1; i < painted.length; i++) {
    expect(painted[i], `zoom step ${i} must paint larger than step ${i - 1}: ${JSON.stringify(painted)}`)
      .toBeGreaterThan(painted[i - 1]);
  }

  await app.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

test('the status rows keep both edges at any fit scale', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  fs.mkdirSync(path.join(homeDir, '.config', 'husk'), { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
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
  await win.waitForFunction(() => {
    const fit = document.getElementById('sp-fit');
    return !!fit && fit.children.length > 0 && fit.scrollHeight > 0;
  }, null, { timeout: 15_000 });

  // The gutter either side of a row, measured against the scrolling box.
  const gaps = () => win.evaluate(() => {
    const box = document.getElementById('sp-content');
    const fit = document.getElementById('sp-fit');
    const row = fit.querySelector('.sp-row');
    if (!row) return null;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const t = getComputedStyle(fit).transform;
    return {
      left: Math.round(r.left - b.left),
      right: Math.round(b.right - r.right),
      scale: t === 'none' ? 1 : +parseFloat(t.split('(')[1].split(',')[0]).toFixed(2),
    };
  });

  // Two window heights, both inside the smallest screen this runs on. The rows
  // reach the same two edges at either height.
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1100, 760); });
  await win.waitForTimeout(700);
  const tall = await gaps();
  expect(Math.abs(tall.left - tall.right), JSON.stringify(tall)).toBeLessThanOrEqual(1);

  // Short enough that the fit has more work to do, at whatever scale comes out.
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1100, 460); });
  await win.waitForTimeout(900);
  const short = await gaps();
  expect(Math.abs(short.left - short.right), JSON.stringify(short)).toBeLessThanOrEqual(1);
  expect(Math.abs(short.left - tall.left), JSON.stringify({ tall, short })).toBeLessThanOrEqual(1);

  await app.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});
