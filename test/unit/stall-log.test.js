'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createStallLog } = require('../../src/lib/stall-log');

function memFs() {
  const files = {};
  return {
    files,
    statSync: (f) => (f in files ? { size: files[f].length } : undefined),
    appendFileSync: (f, s) => { files[f] = (files[f] || '') + s; },
    writeFileSync: (f, s) => { files[f] = s; },
  };
}

test('an IPC handler with a long synchronous part is named in the log', () => {
  const fs = memFs();
  let clock = 1000;
  const log = createStallLog({ fs, file: 'x', now: () => clock, startedAt: 0 });
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  log.wrapIpc(ipcMain);
  ipcMain.handle('sessions:list', () => { clock += 900; return 'ok'; });
  ipcMain.handle('fast', () => { clock += 5; return 'ok'; });
  assert.equal(handlers['sessions:list'](), 'ok');
  handlers.fast();
  assert.match(fs.files.x, /ipc sessions:list blocked main 900ms/);
  assert.doesNotMatch(fs.files.x, /fast/);
});

test('a blocked main loop is logged with its length', () => {
  const fs = memFs();
  let clock = 0;
  let tick;
  const log = createStallLog({ fs, file: 'x', now: () => clock, startedAt: 0 });
  log.monitorLoop((fn) => { tick = fn; return null; });
  clock = 50; tick();
  clock = 1100; tick();
  assert.match(fs.files.x, /main loop blocked 1000ms/);
});

test('a throwing handler still rethrows', () => {
  const log = createStallLog({ fs: memFs(), file: 'x', now: () => 0 });
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
  log.wrapIpc(ipcMain);
  ipcMain.handle('bad', () => { throw new Error('boom'); });
  assert.throws(() => handlers.bad(), /boom/);
});
