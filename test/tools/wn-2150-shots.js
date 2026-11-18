#!/usr/bin/env node
'use strict';

// Screenshot harness for the 2.15.0 What's New slides.
//
//   node test/tools/wn-2150-shots.js [outDir]
//
// Uses the synthetic profile from docs-shots.js and the deterministic Codex
// app-server fixture, rendered at a fixed 2x scale so each slide stays sharp
// when the What's New frame shows it smaller than the window. No data from the
// maintainer's home or real CLI account is used.
//
// This harness writes the conversation and Glass slides. The Agents
// slide comes from polish-shots.js (--scene fleet --scale 2) and the changes
// slide from the chat-canvas e2e test (HUSK_SHOT_DIR), so each image comes from
// the same state its own test exercises.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('playwright');
const { makeHome } = require('./docs-shots');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'src', 'renderer', 'assets'));
const CODEX_FIXTURE = path.join(ROOT, 'test', 'e2e', 'fixtures', 'fake-codex-app-server.js');
const SCALE = 2;
const WIDTH = 1600;
const HEIGHT = 980;
const REPLY = 'Retries now back off exponentially and cap at thirty seconds. The checkout tests cover the timeout path.';

function configure(env, theme) {
  const configPath = path.join(env.homeDir, '.config', 'husk', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  Object.assign(config, { agentCommand: 'codex', theme, accent: 'indigo', railExpanded: false, statusCollapsed: true, sessionsCollapsed: false });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const shim = path.join(env.bin, 'codex');
  fs.writeFileSync(shim, `#!/bin/sh
if [ "$1" = app-server ]; then exec "${process.execPath}" "${CODEX_FIXTURE}" "$@"; fi
if [ "$1" = --version ]; then echo 'codex 0.1.0'; exit 0; fi
sleep 900
`);
  fs.chmodSync(shim, 0o755);
}

function launch(env) {
  return electron.launch({
    args: [ROOT, '--no-sandbox', `--force-device-scale-factor=${SCALE}`],
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: env.homeDir,
      USERPROFILE: env.homeDir,
      TZ: 'UTC',
      PATH: `${env.bin}:${process.env.PATH}`,
      ELECTRON_DISABLE_SANDBOX: '1',
      HUSK_E2E: '1',
      HUSK_E2E_REPLY: REPLY,
    },
    timeout: 40_000,
  });
}

// Capture pixels sit at CSS rect * devicePixelRatio, so a crop is taken from the
// full frame at that scale.
async function capture(app, win, name, selector, pad = 0) {
  fs.mkdirSync(OUT, { recursive: true });
  await win.mouse.move(1, 1);
  await win.waitForTimeout(500);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'));
  const full = path.join(OUT, `.full-${name}`);
  fs.writeFileSync(full, Buffer.from(png, 'base64'));
  const out = path.join(OUT, name);
  if (!selector) { fs.renameSync(full, out); }
  else {
    const r = await win.evaluate(({ sel, p }) => {
      const els = sel.map((s) => document.querySelector(s)).filter(Boolean);
      const rs = els.map((e) => e.getBoundingClientRect());
      const x = Math.max(0, Math.min(...rs.map((b) => b.left)) - p);
      const y = Math.max(0, Math.min(...rs.map((b) => b.top)) - p);
      const right = Math.min(innerWidth, Math.max(...rs.map((b) => b.right)) + p);
      const bottom = Math.min(innerHeight, Math.max(...rs.map((b) => b.bottom)) + p);
      const k = window.devicePixelRatio || 1;
      return { x: x * k, y: y * k, w: (right - x) * k, h: (bottom - y) * k };
    }, { sel: [].concat(selector), p: pad });
    execFileSync('convert', [full, '-crop', `${Math.round(r.w)}x${Math.round(r.h)}+${Math.round(r.x)}+${Math.round(r.y)}`, '+repage', out]);
    fs.unlinkSync(full);
  }
  console.log(`  ${name}`);
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: s.w, height: s.h }), { w: WIDTH, h: HEIGHT });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => window.husk.ui.zoomSet(0));
  await win.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
  await win.waitForFunction(() => {
    const input = document.querySelector('.chat-pane.show .chat-input');
    return input && !/Starting/.test(input.placeholder);
  }, null, { timeout: 30_000 });
  await win.waitForTimeout(800);
  await fit(app, win);
  return win;
}

// The app restores its own window size while it boots and renders at its own
// baseline zoom, so the window is sized twice, in window units scaled by that
// zoom, and the check reads the CSS size the page actually got.
async function fit(app, win, width = WIDTH, height = HEIGHT) {
  for (let i = 0; i < 2; i++) {
    await app.evaluate(({ BrowserWindow }, s) => {
      const w = BrowserWindow.getAllWindows()[0];
      const z = w.webContents.getZoomFactor() || 1;
      w.unmaximize();
      w.setBounds({ x: 0, y: 0, width: Math.round(s.w * z), height: Math.round(s.h * z) });
    }, { w: width, h: height });
    await win.waitForTimeout(700);
  }
  const size = await win.evaluate(() => [innerWidth, innerHeight]);
  if (Math.abs(size[0] - width) > 40) throw new Error(`window is ${size.join('x')} CSS px, expected about ${width}x${height}; run under xvfb-run -s "-screen 0 3840x2400x24"`);
}

async function converse(win) {
  const pane = win.locator('.chat-pane.show');
  await pane.locator('.chat-input').fill('Add exponential backoff to the checkout retry');
  await pane.locator('.chat-input').press('Enter');
  const allow = pane.locator('.chat-perm-btn', { hasText: /^Allow$/ });
  await allow.waitFor({ state: 'visible', timeout: 15_000 });
  await allow.click();
  await pane.locator('.chat-meta-line', { hasText: 'Done' }).first().waitFor({ timeout: 15_000 });
}

async function main() {
  const env = makeHome();
  configure(env, 'light');
  let app;
  try {
    app = await launch(env);
    const win = await ready(app);
    await converse(win);

    // A conversation close to its context limit offers to compact in place.
    // A shorter window keeps the thread and the composer together in frame.
    await fit(app, win, WIDTH, 700);
    await win.evaluate(() => {
      const tab = TABS.get(activeTabId);
      tab.chat.apply({ type: 'usage', used: 183000, size: 200000 }); tab.chat.flush(); window.HuskUsageBell.refresh();
    });
    await win.locator('.toast:not(.is-out)').getByRole('button', { name: 'Compact conversation', exact: true }).waitFor({ timeout: 10_000 });
    await capture(app, win, 'wn-2150-continue.png', ['.chat-main', '.toast:not(.is-out)'], 0);
    await win.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await fit(app, win);

    // Glass: the light clear-glass theme, whole window, with the context
    // warning from the scene above settled.
    await win.evaluate(() => {
      const tab = TABS.get(activeTabId);
      tab.chat.apply({ type: 'usage', used: 24000, size: 200000 }); tab.chat.flush(); window.HuskUsageBell.refresh();
      document.querySelectorAll('.toast').forEach((t) => t.remove());
    });
    await win.evaluate(async () => {
      await window.husk.config.set({ theme: 'glass', statusCollapsed: false });
      applyTheme('glass');
    });
    await win.waitForTimeout(900);
    await capture(app, win, 'wn-2150-glass.png');
  } finally {
    if (app) await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    fs.rmSync(env.homeDir, { recursive: true, force: true });
    fs.rmSync(env.bin, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
