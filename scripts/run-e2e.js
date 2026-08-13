#!/usr/bin/env node
'use strict';

// Runs a Playwright config with a display. Electron needs one on every platform,
// so Linux gets a virtual framebuffer and the desktop is never borrowed.
// Set HUSK_E2E_HEADED=1 to watch a run on the real display instead.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The package exports map hides the cli subpath, so take the file npm links as its bin.
const CLI = [
  path.join(__dirname, '..', 'node_modules', '@playwright', 'test', 'cli.js'),
  path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js'),
].find((p) => fs.existsSync(p));
const SCREEN = '-screen 0 1280x800x24';

if (!CLI) {
  console.error('@playwright/test is not installed. Run npm install first.');
  process.exit(1);
}

const [config, ...rest] = process.argv.slice(2);
if (!config) {
  console.error('usage: run-e2e.js <playwright config path> [playwright args]');
  process.exit(2);
}

const args = ['test', '--config', config, ...rest];
const headed = process.env.HUSK_E2E_HEADED === '1';
const virtualise = process.platform === 'linux' && !headed;

let cmd = process.execPath;
let argv = [CLI, ...args];

if (virtualise) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    if (!process.env.DISPLAY) {
      console.error('xvfb-run is missing and no DISPLAY is set, so Electron has nowhere to draw.');
      console.error('Install it with: sudo apt-get install -y xvfb');
      console.error('Or run against your own display with: HUSK_E2E_HEADED=1 npm run test:e2e');
      process.exit(1);
    }
    console.warn('xvfb-run is missing, falling back to DISPLAY=' + process.env.DISPLAY);
  } else {
    cmd = 'xvfb-run';
    argv = ['--auto-servernum', `--server-args=${SCREEN}`, process.execPath, CLI, ...args];
  }
}

// A borrowed DISPLAY would pull the windows onto the desktop and out of the framebuffer.
const env = { ...process.env };
if (cmd === 'xvfb-run') delete env.DISPLAY;

const run = spawnSync(cmd, argv, { stdio: 'inherit', env });
if (run.error) {
  console.error(run.error.message);
  process.exit(1);
}
process.exit(run.status === null ? 1 : run.status);
