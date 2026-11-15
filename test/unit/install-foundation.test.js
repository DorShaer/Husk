'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerFoundation } = require('../../src/lib/install-foundation');

function setup(t, { mutateScan = false, onReview } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-foundation-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'stage-path');
  const scanner = path.join(root, 'scanner');
  fs.writeFileSync(scanner, `#!${process.execPath}\nconst fs=require('fs'),path=require('path');const args=process.argv;const dir=args[args.indexOf('--artifact')+1];fs.writeFileSync(${JSON.stringify(log)},dir);${mutateScan ? "fs.appendFileSync(path.join(dir,'mcp.json'),'changed');" : ''}fs.writeFileSync(args[args.indexOf('--output')+1],JSON.stringify({vulnerabilities:[]}));\n`, { mode: 0o755 });
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const sender = new EventEmitter();
  let reviewed = 0;
  sender.send = (_channel, details) => { reviewed++; onReview?.({ details, sender, handlers, stage: fs.readFileSync(log, 'utf8') }); };
  const foundation = registerFoundation({ ipcMain, dialog: {}, window: () => ({ isDestroyed: () => false, webContents: sender }), configDir: root, getConfig: () => ({ scannerPath: scanner }), setConfig: () => {}, installers: new Map() });
  let installed = 0;
  const install = async (payload = { items: [{ id: 'one', command: 'node', args: ['server.js'] }] }) => foundation.reviewInstall('mcp:addMany', payload, () => { installed++; return { ok: true }; }, { sender });
  return { install, sender, handlers, get reviewed() { return reviewed; }, get installed() { return installed; }, stage: () => fs.readFileSync(log, 'utf8') };
}

test('changed staged content is refused before review', { skip: process.platform === 'win32' }, async (t) => {
  const f = setup(t, { mutateScan: true });
  const result = await f.install();
  assert.equal(result.ok, false); assert.match(result.error, /changed during scanning/);
  assert.equal(f.reviewed, 0); assert.equal(f.installed, 0);
  assert.equal(fs.existsSync(f.stage()), false);
});
test('approval does not install content changed during review', { skip: process.platform === 'win32' }, async (t) => {
  const f = setup(t, { onReview: ({ stage, handlers, sender, details }) => {
    fs.appendFileSync(path.join(stage, 'mcp.json'), 'changed');
    handlers.get('installReview:answer')({ sender }, { id: details.id, approved: true });
  } });
  const result = await f.install();
  assert.equal(result.ok, false); assert.match(result.error, /changed during review/);
  assert.equal(f.installed, 0); assert.equal(fs.existsSync(f.stage()), false);
});
test('navigation cancels pending review and removes staged files', { skip: process.platform === 'win32' }, async (t) => {
  const f = setup(t, { onReview: ({ sender }) => sender.emit('did-start-navigation', {}, 'file:///app', false, true) });
  const result = await f.install();
  assert.equal(result.canceled, true); assert.equal(f.installed, 0);
  assert.equal(fs.existsSync(f.stage()), false); assert.equal(f.sender.listenerCount('destroyed'), 0);
});
test('only the requesting window can approve and every MCP entry is staged', { skip: process.platform === 'win32' }, async (t) => {
  const f = setup(t, { onReview: ({ details, handlers, sender }) => {
    const staged = JSON.parse(details.files[0].text).mcpServers;
    assert.equal(Object.keys(staged).length, 2);
    assert.equal(Object.values(staged)[0].command, 'first');
    assert.equal(Object.values(staged)[1].command, 'second');
    assert.equal(handlers.get('installReview:answer')({ sender: {} }, { id: details.id, approved: true }).ok, false);
    handlers.get('installReview:answer')({ sender }, { id: details.id, approved: true });
  } });
  const result = await f.install({ items: [{ id: 'same', command: 'first' }, { id: 'same', command: 'second' }] });
  assert.equal(result.ok, true); assert.equal(f.installed, 1);
  assert.equal(f.sender.listenerCount('did-start-navigation'), 0);
});
