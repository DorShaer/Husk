'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readBoundedFile } = require('../../src/lib/bounded-file');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-bounded-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'file'); fs.writeFileSync(file, 'content');
  return { dir, file };
}
test('reads only regular files within the byte limit', (t) => {
  const { dir, file } = fixture(t);
  assert.equal(readBoundedFile(file, 7).toString(), 'content');
  assert.throws(() => readBoundedFile(file, 6), /byte limit/);
  assert.throws(() => readBoundedFile(dir, 7), /regular file/);
  fs.writeFileSync(file, ''); assert.equal(readBoundedFile(file, 0).length, 0);
});
test('refuses a link as the selected file', { skip: process.platform === 'win32' }, (t) => {
  const { dir, file } = fixture(t); const link = path.join(dir, 'link');
  fs.symlinkSync(file, link); assert.throws(() => readBoundedFile(link, 100), /regular file/);
});
test('refuses a different file opened after the initial stat', (t) => {
  const { file } = fixture(t);
  const proxy = Object.create(fs);
  proxy.openSync = (...args) => {
    fs.writeFileSync(file + '-new', 'different'); fs.renameSync(file + '-new', file);
    return fs.openSync(...args);
  };
  assert.throws(() => readBoundedFile(file, 100, proxy), /changed while opening/);
});
test('refuses growth after the descriptor size check', (t) => {
  const { file } = fixture(t);
  const proxy = Object.create(fs);
  proxy.readSync = (...args) => { fs.appendFileSync(file, 'more'); return fs.readSync(...args); };
  assert.throws(() => readBoundedFile(file, 100, proxy), /changed while reading/);
});
