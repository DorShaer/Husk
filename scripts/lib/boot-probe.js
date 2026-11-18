'use strict';

// Benchmark entry point for Electron. Records every main event loop stall over
// 20ms into globalThis.__huskLoopBlocks as { at, ms } since process start.
// With HUSK_BOOT_PROFILE set to a file path, also writes a CPU profile there
// when globalThis.__huskStopProfile() is called.
const { performance } = require('node:perf_hooks');
const Module = require('node:module');
const slowRequires = [];
const originalLoad = Module._load;
Module._load = function loadWithTiming(request, parent, isMain) {
  const startedAt = performance.now();
  try { return originalLoad.call(this, request, parent, isMain); }
  finally {
    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= 10) slowRequires.push({ request, parent: parent && parent.filename, elapsedMs: Math.round(elapsedMs) });
  }
};

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

const startupMarks = globalThis.__huskStartupMarks = [{ label: 'process-start', at: Number(process.hrtime.bigint() / 1000000n) }];
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
require('electron').app.once('ready', () => startupMarks.push({ label: 'electron-ready', at: Number(process.hrtime.bigint() / 1000000n) }));
require('electron').app.once('browser-window-created', (_event, win) => {
  win.webContents.once('dom-ready', () => {
    const mark = performance.now();
    const windowAt = Date.now();
    const listed = win.webContents.executeJavaScript(`(async () => {
      const t = performance.now();
      const [r] = await Promise.all([window.husk.sessions.list({}), window.husk.agents.detect()]);
      const all = await window.husk.sessions.list({ agent: 'claude', selectedOnly: true, limit: 20000 });
      return { ms: Math.round(performance.now() - t), count: r.sessions.length, claude: all.sessions.length, olderUnread: all.olderUnread };
    })()`);
    Promise.all([listed, new Promise(resolve => setTimeout(resolve, Number(process.env.HUSK_BOOT_SECONDS) * 1000))])
      .then(async ([sessions]) => {
        if (globalThis.__huskStopProfile) await globalThis.__huskStopProfile();
        require('node:fs').writeFileSync(process.env.HUSK_BOOT_RESULT, JSON.stringify({ mark, blocks, listed: sessions, windowAt, startupMarks: globalThis.__huskStartupMarks || [], slowRequires }));
        win.close();
      }).catch(err => { console.error(err); require('electron').app.exit(1); });
  });
});

require('../../src/main');
