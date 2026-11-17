'use strict';

// Benchmark entry point for Electron. Records every main event loop stall over
// 20ms into globalThis.__huskLoopBlocks as { at, ms } since process start.
// With HUSK_BOOT_PROFILE set to a file path, also writes a CPU profile there
// when globalThis.__huskStopProfile() is called.
const { performance } = require('node:perf_hooks');

const TICK_MS = 5;
const blocks = [];
globalThis.__huskLoopBlocks = blocks;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const gap = now - last - TICK_MS;
  if (gap > 20) blocks.push({ at: Math.round(now), ms: Math.round(gap) });
  last = now;
}, TICK_MS).unref();

const out = process.env.HUSK_BOOT_PROFILE;
if (out) {
  const inspector = require('node:inspector');
  const session = new inspector.Session();
  session.connect();
  session.post('Profiler.enable');
  session.post('Profiler.setSamplingInterval', { interval: 1000 });
  session.post('Profiler.start');
  globalThis.__huskStopProfile = () => new Promise((resolve) => {
    session.post('Profiler.stop', (err, res) => {
      const zeroUs = Number(process.hrtime.bigint() / 1000n) - performance.now() * 1000;
      if (!err) require('node:fs').writeFileSync(out, JSON.stringify({ zeroUs, blocks, profile: res.profile }));
      resolve(!err);
    });
  });
}

// Capture the window milestone on the same clock as the event-loop samples.
require('electron').app.once('browser-window-created', (_event, win) => {
  win.webContents.once('dom-ready', () => {
    const mark = performance.now();
    setTimeout(async () => {
      if (globalThis.__huskStopProfile) await globalThis.__huskStopProfile();
      const fs = require('node:fs');
      const file = process.env.HUSK_BOOT_RESULT;
      fs.writeFileSync(file + '.tmp', JSON.stringify({ mark, blocks }));
      fs.renameSync(file + '.tmp', file);
    }, Number(process.env.HUSK_BOOT_SECONDS) * 1000);
  });
});
