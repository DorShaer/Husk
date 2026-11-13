'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const start = source.indexOf("ipcMain.handle('brain:addFiles'");
const end = source.indexOf("ipcMain.handle('brain:remove'", start);
const limit = require('../../src/lib/brain').FILE_MAX_BYTES;

function importer(t, { content = 'Original runbook', afterStat } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-brain-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runbook.md');
  fs.writeFileSync(file, content);
  const learned = [];
  const handles = new Set();
  const io = Object.create(fs);
  io.openSync = (...args) => { const fd = fs.openSync(...args); handles.add(fd); return fd; };
  io.closeSync = (fd) => { handles.delete(fd); fs.closeSync(fd); };
  let checked = false;
  const inspect = (stat) => {
    if (!checked && afterStat) { checked = true; afterStat(file); }
    return stat;
  };
  io.statSync = (p) => inspect(fs.statSync(p));
  io.fstatSync = (fd) => inspect(fs.fstatSync(fd));
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle(_name, fn) { handler = fn; } },
    fs: io, path, Buffer, BRAIN_FILE_MAX_BYTES: limit, mainWindow: null,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) },
    chatCwd: () => dir, brainActivity: () => {},
    brain: { addFile(args) { learned.push(args); return { ok: true, node: { id: 'note' }, chunks: 1 }; } },
  });
  return { file, learned, handles, run: () => handler(null, {}) };
}

test('Brain imports the opened file when its path changes during the read', async (t) => {
  const imp = importer(t, { afterStat(file) {
    fs.renameSync(file, file + '.original');
    fs.writeFileSync(file, 'Replacement contents');
  } });
  const result = await imp.run();
  assert.equal(result.added.length, 1);
  assert.equal(imp.learned[0].content, 'Original runbook');
  assert.equal(imp.handles.size, 0);
});

test('Brain bounds a file that grows after its size was checked', async (t) => {
  const imp = importer(t, { afterStat(file) { fs.appendFileSync(file, Buffer.alloc(limit)); } });
  const result = await imp.run();
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /too large/);
  assert.equal(imp.learned.length, 0);
  assert.equal(imp.handles.size, 0);
});

test('Brain rejects an oversized file and closes its handle', async (t) => {
  const imp = importer(t, { content: Buffer.alloc(limit + 1) });
  const result = await imp.run();
  assert.equal(result.failed.length, 1);
  assert.equal(imp.learned.length, 0);
  assert.equal(imp.handles.size, 0);
});

test('Brain rejects directories selected as files', async (t) => {
  const imp = importer(t);
  fs.unlinkSync(imp.file);
  fs.mkdirSync(imp.file);
  const result = await imp.run();
  assert.equal(result.failed.length, 1);
  assert.equal(imp.learned.length, 0);
  assert.equal(imp.handles.size, 0);
});
