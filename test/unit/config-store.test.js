'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeAtomic, saveConfigFile, loadConfigFile } = require('../../src/lib/config-store');

let dir;
let file;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-cfgstore-'));
  file = path.join(dir, 'config.json');
});
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

const fixedNow = () => new Date('2026-11-17T10:20:30.456Z');

test('missing file loads as a new install', () => {
  assert.deepEqual(loadConfigFile(file), { data: null, recovery: null });
});

test('save writes the file and a backup with mode 0600 and leaves no temp files', () => {
  saveConfigFile(file, JSON.stringify({ a: 1 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), { a: 1 });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(file + '.bak').mode & 0o777, 0o600);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak']);
  assert.deepEqual(loadConfigFile(file), { data: { a: 1 }, recovery: null });
});

test('save over an existing 0644 file keeps it 0600', { skip: process.platform === 'win32' }, () => {
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  saveConfigFile(file, '{"b":2}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a crash between write and rename leaves the old file intact', () => {
  saveConfigFile(file, JSON.stringify({ v: 'old' }));
  const crashing = { ...fs, renameSync: () => { throw new Error('power cut'); } };
  assert.throws(() => writeAtomic(file, JSON.stringify({ v: 'new' }), { fs: crashing }), /power cut/);
  assert.deepEqual(loadConfigFile(file).data, { v: 'old' });
  // A real crash leaves the temp file behind; it does not affect the load.
  fs.writeFileSync(path.join(dir, '.config.json.1.dead.tmp'), '{"v":"ha');
  assert.deepEqual(loadConfigFile(file), { data: { v: 'old' }, recovery: null });
});

test('a crash mid-write of the temp file leaves the old file intact', () => {
  saveConfigFile(file, JSON.stringify({ v: 'old' }));
  const crashing = { ...fs, fsyncSync: () => { throw new Error('disk gone'); } };
  assert.throws(() => writeAtomic(file, JSON.stringify({ v: 'new' }), { fs: crashing }));
  assert.deepEqual(loadConfigFile(file).data, { v: 'old' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'config.json.bak']);
});

test('a half-written file is kept aside and the backup is loaded and restored', () => {
  saveConfigFile(file, JSON.stringify({ firstRunDone: true, projects: [1] }));
  const torn = '{"firstRunDone": true, "projects": [ {"id":';
  fs.writeFileSync(file, torn);
  const r = loadConfigFile(file, { now: fixedNow });
  assert.deepEqual(r.data, { firstRunDone: true, projects: [1] });
  assert.equal(r.recovery.from, 'backup');
  assert.equal(r.recovery.corruptPath, file + '.corrupt-2026-11-17T10-20-30-456Z');
  assert.equal(fs.readFileSync(r.recovery.corruptPath, 'utf8'), torn);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { firstRunDone: true, projects: [1] });
});

test('with no usable backup it starts from defaults and still keeps the original', () => {
  fs.writeFileSync(file, 'not json at all');
  fs.writeFileSync(file + '.bak', '[1,2]');
  const r = loadConfigFile(file, { now: fixedNow });
  assert.equal(r.data, null);
  assert.equal(r.recovery.from, 'defaults');
  assert.equal(fs.readFileSync(r.recovery.corruptPath, 'utf8'), 'not json at all');
  assert.equal(fs.existsSync(file), false);
  // A later save never touches the kept copy.
  saveConfigFile(file, '{"fresh":true}');
  assert.equal(fs.readFileSync(r.recovery.corruptPath, 'utf8'), 'not json at all');
});

test('a second failure in the same instant gets its own kept copy', () => {
  fs.writeFileSync(file, 'x');
  const a = loadConfigFile(file, { now: fixedNow }).recovery.corruptPath;
  fs.writeFileSync(file, 'y');
  const b = loadConfigFile(file, { now: fixedNow }).recovery.corruptPath;
  assert.notEqual(a, b);
  assert.equal(fs.readFileSync(a, 'utf8'), 'x');
  assert.equal(fs.readFileSync(b, 'utf8'), 'y');
});

test('null, arrays and empty files count as unreadable', () => {
  for (const bad of ['null', '[]', '']) {
    fs.writeFileSync(file, bad);
    const r = loadConfigFile(file);
    assert.equal(r.data, null);
    assert.ok(r.recovery);
  }
});


test('a failed preservation leaves the unreadable file in place and refuses recovery', () => {
  fs.writeFileSync(file, 'bad json');
  const denied = { ...fs, renameSync: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } };
  assert.throws(() => loadConfigFile(file, { fs: denied }), /permission denied/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'bad json');
});
