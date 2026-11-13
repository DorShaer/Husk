#!/usr/bin/env node
'use strict';

// Screenshot harness for the 2.14.0 What's New slides.
//
//   node test/tools/wn-2140-shots.js [outDir]
//
// Uses the synthetic profile from docs-shots.js and the deterministic Codex
// app-server fixture. No data from the maintainer's home or real CLI account is
// used. By default, captures land directly in the renderer asset directory.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeHome, launch } = require('./docs-shots');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'src', 'renderer', 'assets'));
const CODEX_FIXTURE = path.join(ROOT, 'test', 'e2e', 'fixtures', 'fake-codex-app-server.js');

function configure(env) {
  const configPath = path.join(env.homeDir, '.config', 'husk', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  Object.assign(config, { agentCommand: 'codex', theme: 'light', accent: 'indigo', railExpanded: true, statusCollapsed: false, statusPane: 'work', paiEnabled: false });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const shim = path.join(env.bin, 'codex');
  fs.writeFileSync(shim, `#!/bin/sh
if [ "$1" = app-server ]; then export HUSK_E2E_REPLY='The canary release pauses for the violet health check. Roll it back if the check fails.'; exec "${process.execPath}" "${CODEX_FIXTURE}" "$@"; fi
if [ "$1" = --version ]; then echo 'codex 0.1.0'; exit 0; fi
printf 'Codex CLI  ·  demo-app\n\n› '
IFS= read -r cmd
case "$cmd" in
  /mcp) printf '\nMCP servers\n\nName       Status\nfilesystem enabled\ngithub     enabled\nplaywright enabled\n' ;;
  /login) printf '\nSign in to Codex\n\nContinue in your browser to connect your account.\n' ;;
  *) printf '\nCommand complete.\n' ;;
esac
sleep 900
`);
  fs.chmodSync(shim, 0o755);
}

async function main() {
  const env = makeHome();
  configure(env);
  const sharedSkill = path.join(env.homeDir, '.agents', 'skills', 'cross-agent-review');
  fs.mkdirSync(sharedSkill, { recursive: true });
  fs.writeFileSync(path.join(sharedSkill, 'SKILL.md'), '---\nname: cross-agent-review\ndescription: Reviews a change for correctness, edge cases and clarity.\n---\n\n# Review a change\n\nCheck the implementation and its tests before it ships.\n');
  let app;
  const written = [];
  const capture = async (win, name, maxWidth = null) => {
    fs.mkdirSync(OUT, { recursive: true });
    const [width, height] = await win.evaluate(() => [window.innerWidth, window.innerHeight]);
    await win.screenshot({ path: path.join(OUT, name), animations: 'disabled', clip: { x: 0, y: 0, width: maxWidth ? Math.min(width, maxWidth) : width, height } });
    written.push(name);
    console.log(`  ${name}`);
  };
  const page = async (win, name) => {
    await win.evaluate((p) => setPage(p), name);
    await win.waitForTimeout(1400);
  };

  try {
    app = await launch(env);
    const win = await app.firstWindow({ timeout: 30_000 });
    await win.waitForLoadState('domcontentloaded');
    await win.evaluate(() => window.husk.ui.zoomSet(0));
    const display = await win.evaluate(() => ({ width: screen.availWidth, height: screen.availHeight }));
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setBounds({
      x: 0, y: 0, width: Math.min(1760, size.width - 24), height: Math.min(1040, size.height - 48),
    }), display);
    await win.waitForFunction(() => window.husk && window.husk.brain && window.Brain && document.querySelector('.chat-stage'));
    await win.waitForFunction(() => {
      const input = document.querySelector('.chat-pane.show .chat-input');
      return input && !/Starting/.test(input.placeholder);
    }, null, { timeout: 30_000 });
    await win.waitForTimeout(1200);

    // Seed related memories through Husk's real Brain API, in the throwaway HOME.
    await win.evaluate(async () => {
      await window.husk.brain.addNote({ text: 'Violet releases follow the canary rollback plan.', global: true });
      await window.husk.brain.addNote({ text: 'Canary rollback starts when health checks fail.', global: true });
      await window.husk.brain.addNote({ text: 'Review the dashboard before deployment.', global: true });
    });
    await page(win, 'brain');
    await win.waitForFunction(() => document.querySelectorAll('#br-network .br-neuron').length >= 3);
    await win.waitForTimeout(600);
    await capture(win, 'wn-2140-brain.png');

    await page(win, 'skills');
    await win.locator('.sk-row[data-name="cross-agent-review"]').waitFor({ state: 'visible' });
    await capture(win, 'wn-2140-skills.png');

    // The Chat highlight image is captured by the chat-canvas e2e fixture, so
    // the screenshot and the tested canvas always come from the same state.

    await page(win, 'prefs');
    await win.evaluate(() => showPrefsSection('appearance'));
    await capture(win, 'wn-2140-appearance.png');

  } finally {
    if (app) await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 8000))]);
  }

  // The Agents command center uses the background-agent fixture in
  // polish-shots; the regular Agents page is for saved specialist profiles.
  const agentOut = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-wn-2140-agents-'));
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'polish-shots.js'), agentOut, '--theme', 'light', '--scene', 'fleet', '--select', 'root-a'], { cwd: ROOT, stdio: 'inherit' });
    const agentShot = path.join(OUT, 'wn-2140-agents.png');
    fs.mkdirSync(OUT, { recursive: true });
    fs.copyFileSync(path.join(agentOut, 'list-all-fleet.png'), agentShot);
    written.push(path.basename(agentShot));
  } finally {
    fs.rmSync(agentOut, { recursive: true, force: true });
  }

  console.log(`\n${written.length} screenshots written to ${OUT}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
