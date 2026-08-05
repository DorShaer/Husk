'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseDiff, tokensFromLine, selectSpecs } = require('../../scripts/lib/test-impact');

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'impact-map.json'), 'utf8'));

// Build `git diff -U0` shaped text without shelling out to git.
function diff(files) {
  return Object.entries(files).map(([p, lines]) =>
    `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,0 +1,${lines.length} @@\n`
    + lines.map((l) => `+${l}`).join('\n')).join('\n') + '\n';
}

test('parseDiff keeps only changed lines, per file', () => {
  const text = [
    '--- a/src/renderer/styles.css',
    '+++ b/src/renderer/styles.css',
    '@@ -1,2 +1,2 @@',
    '-.ag-row { color: red; }',
    '+.ag-row { color: blue; }',
    ' .untouched { color: green; }',
  ].join('\n');
  const files = parseDiff(text);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/renderer/styles.css');
  assert.deepEqual(files[0].lines, ['.ag-row { color: red; }', '.ag-row { color: blue; }']);
});

test('tokens come out of every way this codebase names a thing', () => {
  assert.ok(tokensFromLine('.ag-row { }').has('ag'));
  assert.ok(tokensFromLine('<div class="wf-node">').has('wf'));
  assert.ok(tokensFromLine("$('#aut-lane')").has('aut'));
  assert.ok(tokensFromLine('<div data-page="agents">').has('page:agents'));
  assert.ok(tokensFromLine("ipcMain.handle('projects:inspect', ...)").has('ipc:projects'));
});

test('a stylesheet edit confined to one area selects only that area', () => {
  const r = selectSpecs(diff({ 'src/renderer/styles.css': ['.ag-row { padding: 8px; }'] }), MAP);
  assert.equal(r.full, false);
  assert.ok(r.specs.includes('agents-page.spec.js'));
  assert.ok(!r.specs.includes('workflow-run.spec.js'));
  // The broad smoke specs ride along with every selection.
  assert.ok(r.specs.includes('smoke.spec.js'));
});

test('a mapped library file selects its area without reading the diff body', () => {
  const r = selectSpecs(diff({ 'src/lib/project-mcp.js': ['const x = 1;'] }), MAP);
  assert.equal(r.full, false);
  assert.ok(r.specs.includes('project-mcp.spec.js'));
  assert.ok(r.specs.includes('mcp-shared.spec.js'));
  assert.ok(!r.specs.includes('workspaces.spec.js'));
});

test('an edited spec runs itself', () => {
  const r = selectSpecs(diff({ 'test/e2e/skills-page.spec.js': ['// tweak'] }), MAP);
  assert.equal(r.full, false);
  assert.ok(r.specs.includes('skills-page.spec.js'));
  assert.ok(!r.specs.includes('agents-page.spec.js'));
});

// The fallbacks are the safety story, so each one is pinned.

test('shared chrome runs everything', () => {
  // This is the exact shape of the change that restyled the whole app while
  // claiming to be an Agents page edit.
  const r = selectSpecs(diff({ 'src/renderer/styles.css': ['.ghost-btn:hover { border-color: var(--line-2); }'] }), MAP);
  assert.equal(r.full, true);
  assert.match(r.reasons.join(' '), /shared chrome/);
});

test('an unmapped file runs everything', () => {
  const r = selectSpecs(diff({ 'src/lib/brand-new-thing.js': ['module.exports = {};'] }), MAP);
  assert.equal(r.full, true);
  assert.match(r.reasons.join(' '), /no mapping/);
});

test('a scanned file whose diff says nothing runs everything', () => {
  const r = selectSpecs(diff({ 'src/renderer/app.js': ['const total = a + b;'] }), MAP);
  assert.equal(r.full, true);
  assert.match(r.reasons.join(' '), /no recognizable token/);
});

test('a token nobody claims runs everything', () => {
  const r = selectSpecs(diff({ 'src/renderer/styles.css': ['.zz-widget { color: red; }'] }), MAP);
  assert.equal(r.full, true);
  assert.match(r.reasons.join(' '), /unmapped/);
});

test('preload changes run everything', () => {
  const r = selectSpecs(diff({ 'src/preload.js': ['foo: () => 1,'] }), MAP);
  assert.equal(r.full, true);
});

test('editing the map itself runs everything', () => {
  const r = selectSpecs(diff({ 'test/impact-map.json': ['"tokens": []'] }), MAP);
  assert.equal(r.full, true);
});

test('test scaffolding outside the specs runs everything', () => {
  const r = selectSpecs(diff({ 'test/e2e/fixtures/fake-cli.js': ['process.exit(0);'] }), MAP);
  assert.equal(r.full, true);
});

test('a change spanning too many areas runs everything', () => {
  const r = selectSpecs(diff({
    'src/renderer/styles.css': ['.ag-row {}', '.wf-node {}', '.aut-lane {}', '.sk-rail {}'],
  }), MAP);
  assert.equal(r.full, true);
  assert.match(r.reasons.join(' '), /spans \d+ areas/);
});

test('a unit-only change selects nothing beyond the always-run specs', () => {
  const r = selectSpecs(diff({ 'test/unit/fuzzy.test.js': ['assert.ok(true);'] }), MAP);
  assert.equal(r.full, false);
  assert.deepEqual(r.specs, [...MAP.alwaysRun].sort());
});

test('an empty diff still runs the always-run specs', () => {
  const r = selectSpecs('', MAP);
  assert.equal(r.full, false);
  assert.deepEqual(r.specs, [...MAP.alwaysRun].sort());
});

// The map is only useful if it stays honest about what exists on disk.

test('every spec named in the map exists', () => {
  const onDisk = new Set(fs.readdirSync(path.join(__dirname, '..', 'e2e')).filter((f) => f.endsWith('.spec.js')));
  const named = new Set([...(MAP.alwaysRun || [])]);
  for (const def of Object.values(MAP.areas)) for (const s of def.specs) named.add(s);
  for (const s of named) assert.ok(onDisk.has(s), `map names a spec that does not exist: ${s}`);
});

test('every mapped path exists', () => {
  const repo = path.join(__dirname, '..', '..');
  for (const def of Object.values(MAP.areas)) {
    for (const p of def.paths || []) {
      assert.ok(fs.existsSync(path.join(repo, p)), `map names a path that does not exist: ${p}`);
    }
  }
  for (const p of MAP.fullSuiteWhenChanged || []) {
    if (p === 'package-lock.json' || p === 'test/impact-map.json') continue;
    assert.ok(fs.existsSync(path.join(repo, p)), `fullSuiteWhenChanged names a missing path: ${p}`);
  }
});

test('every spec on disk is reachable through the map', () => {
  const onDisk = fs.readdirSync(path.join(__dirname, '..', 'e2e')).filter((f) => f.endsWith('.spec.js'));
  const reachable = new Set([...(MAP.alwaysRun || [])]);
  for (const def of Object.values(MAP.areas)) for (const s of def.specs) reachable.add(s);
  const orphans = onDisk.filter((s) => !reachable.has(s));
  // An orphan can still run: editing it selects it, and any unmapped change
  // runs everything. It just means no source edit will ever pick it.
  assert.deepEqual(orphans, [], `specs no source change can select: ${orphans.join(', ')}`);
});
