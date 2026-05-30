'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readJsonFile, readJsonFileStrict, writeJsonFile } = require('../../src/lib/mcp/common');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-mcp-common-'));
  return path.join(dir, 'config.json');
}

// ─── readJsonFileStrict ────────────────────────────────────────────────────

test('readJsonFileStrict: missing file is a clean empty config', () => {
  const r = readJsonFileStrict(tmpFile());
  assert.equal(r.ok, true);
  assert.equal(r.missing, true);
  assert.deepEqual(r.data, {});
});

test('readJsonFileStrict: valid file parses', () => {
  const p = tmpFile();
  fs.writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
  const r = readJsonFileStrict(p);
  assert.equal(r.ok, true);
  assert.equal(r.data.mcpServers.a.command, 'x');
});

test('readJsonFileStrict: a corrupt existing file is an error, not empty', () => {
  const p = tmpFile();
  fs.writeFileSync(p, '{ this is not json');
  const r = readJsonFileStrict(p);
  assert.equal(r.ok, false);
  // The lenient reader would silently return {} here, which is exactly
  // the path that lets a mutating op overwrite a config it could not read.
  assert.deepEqual(readJsonFile(p), {});
});

// ─── writeJsonFile (atomic) ──────────────────────────────────────────────────

test('writeJsonFile: writes valid parseable JSON', () => {
  const p = tmpFile();
  assert.equal(writeJsonFile(p, { mcpServers: { a: 1 } }), true);
  const back = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(back, { mcpServers: { a: 1 } });
});

test('writeJsonFile: leaves no temp file behind on success', () => {
  const p = tmpFile();
  writeJsonFile(p, { ok: true });
  const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeJsonFile: preserves the original when the target dir is unwritable', () => {
  const p = tmpFile();
  fs.writeFileSync(p, JSON.stringify({ original: true }));
  // Point at a path whose parent does not exist: the write must fail
  // cleanly and never produce a half-written file.
  const bad = path.join(p, 'nope', 'config.json');
  assert.equal(writeJsonFile(bad, { changed: true }), false);
  // Original untouched.
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { original: true });
});
