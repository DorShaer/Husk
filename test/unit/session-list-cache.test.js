'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFileFactsCache } = require('../../src/lib/session-cache');
const { lastLineMatch, turnLineMs } = require('../../src/lib/session-activity');
const { claudeTranscripts, listClaudeTranscripts, drainPaced, realPath } = require('../../src/lib/session-scan');
const { inCurrentProject, buildView } = require('../../src/lib/session-view');
const { peekFromEvents } = require('../../src/lib/session-peek');
const { seedClaude } = require('../helpers/session-fixture');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-list-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('file facts persist across instances and survive only while the file holds', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'cfg', 'session-cache.json');
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, 'x\n');
  fs.writeFileSync(b, 'y\n');
  const one = createFileFactsCache({ file });
  await one.load();
  one.fill(one.reads(a, fs.statSync(a)), 'title', () => 'A');
  one.fill(one.reads(b, fs.statSync(b)), 'title', () => 'B');
  fs.rmSync(b);
  assert.equal(await one.save(), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['session-cache.json']);

  const two = createFileFactsCache({ file });
  await two.load();
  assert.equal(two.size(), 1);
  let computed = 0;
  assert.equal(two.fill(two.reads(a, fs.statSync(a)), 'title', () => { computed++; return 'again'; }), 'A');
  assert.equal(computed, 0);
  assert.equal(await two.save(), false);

  fs.appendFileSync(a, 'more\n');
  assert.equal(two.reads(a, fs.statSync(a)).title, undefined);
});

test('a corrupt or foreign cache file is ignored', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'session-cache.json');
  for (const text of ['{not json', '[]', JSON.stringify({ v: 99, entries: {} }), JSON.stringify({ v: 1, entries: { x: 5 } })]) {
    fs.writeFileSync(file, text);
    const c = createFileFactsCache({ file });
    await c.load();
    assert.equal(c.size(), 0);
  }
});

test('the cache is bounded and keeps carried fields when a file only grew', (t) => {
  const dir = tmp(t);
  const c = createFileFactsCache({ file: path.join(dir, 'c.json'), max: 3, carry: ['end'] });
  for (let i = 0; i < 5; i++) c.reads(`/k${i}`, { size: 1, mtimeMs: i });
  assert.equal(c.size(), 3);
  const e = c.reads('/grow', { size: 10, mtimeMs: 1 });
  e.end = 10; e.other = 1;
  const grown = c.reads('/grow', { size: 20, mtimeMs: 2 });
  assert.equal(grown.end, 10);
  assert.equal(grown.other, undefined);
  assert.equal(c.reads('/grow', { size: 5, mtimeMs: 3 }).end, undefined);
});

function open(t, text) {
  const file = path.join(tmp(t), 'f.jsonl');
  fs.writeFileSync(file, text);
  const fd = fs.openSync(file, 'r');
  t.after(() => fs.closeSync(fd));
  return { fd, size: Buffer.byteLength(text) };
}
const title = (line) => { try { const o = JSON.parse(line); return o.type === 'ai-title' ? o.aiTitle : null; } catch (_) { return null; } };
const line = (o) => JSON.stringify(o) + '\n';

test('the newest marked line is found across chunk boundaries and long lines', (t) => {
  const text = line({ type: 'ai-title', aiTitle: 'first' })
    + line({ type: 'user', timestamp: '2026-11-01T00:00:00Z', message: { content: 'x'.repeat(5000) } })
    + line({ type: 'ai-title', aiTitle: 'second' })
    + line({ type: 'assistant', timestamp: '2026-11-02T00:00:00Z', message: { content: 'y'.repeat(3000) } })
    + line({ type: 'api-request', timestamp: '2026-11-09T00:00:00Z' })
    + '{"type":"ai-title","aiTitle":"partial';
  const { fd, size } = open(t, text);
  for (const chunk of [7, 64, 1000, 1 << 20]) {
    const r = lastLineMatch(fs, fd, size, '"ai-title"', title, 0, chunk);
    assert.equal(r.value, 'second', `chunk ${chunk}`);
    assert.equal(r.end, text.lastIndexOf('\n') + 1);
    assert.equal(lastLineMatch(fs, fd, size, '"timestamp"', turnLineMs, 0, chunk).value, Date.parse('2026-11-02T00:00:00Z'));
  }
  // A search resumed past the old end sees only the new lines.
  const later = lastLineMatch(fs, fd, size, '"ai-title"', title, text.lastIndexOf('\n') + 1);
  assert.equal(later.value, null);
});

test('a file without the marker or without a newline reports nothing', (t) => {
  const a = open(t, line({ type: 'user' }).repeat(50));
  assert.deepEqual(lastLineMatch(fs, a.fd, a.size, '"ai-title"', title, 0, 16), { value: null, end: a.size });
  const b = open(t, '{"type":"ai-title","aiTitle":"x"}');
  assert.equal(lastLineMatch(fs, b.fd, b.size, '"ai-title"', title, 0, 8).value, null);
});

test('2500 transcripts: filters before the cap, counts what is left, and yields', async (t) => {
  const home = tmp(t);
  seedClaude(home, { count: 2500, sizes: 'tiny' });
  const root = path.join(home, '.claude', 'projects');
  // Every tenth chat is a print run, dropped before it can take a place.
  const accept = ({ id }) => Number(id.slice(0, 8)) % 10 !== 0;
  const listed = listClaudeTranscripts(root, { accept });
  assert.equal(listed.length, 300);
  assert.ok(listed.every(accept));
  assert.equal(listed[0].id.slice(0, 8), '00002499');
  assert.equal(listed.older, 2500 - 333);

  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const paced = await drainPaced(claudeTranscripts(root, { cap: 5000, accept }), 1);
  clearInterval(timer);
  assert.equal(paced.length, 2250);
  assert.equal(paced.older, 0);
  assert.ok(ticks > 0, 'the walk handed the event loop back');
});

test('a symlinked project and a subfolder session both match their project', (t) => {
  const home = tmp(t);
  const project = path.join(home, 'work', 'proj');
  const sub = path.join(project, 'packages', 'core');
  const alias = path.join(home, 'alias');
  fs.mkdirSync(sub, { recursive: true });
  fs.symlinkSync(project, alias, 'dir');
  const cwds = [alias, sub, path.join(home, 'work', 'proj-other')];
  seedClaude(home, { count: 3, sizes: 'tiny', cwdFor: (i) => cwds[i] });
  const listed = listClaudeTranscripts(path.join(home, '.claude', 'projects'));
  const current = realPath(alias);
  const matched = listed.filter((c) => inCurrentProject({ realCwd: realPath(c.scan.originalCwd) }, current));
  assert.deepEqual(matched.map((c) => c.scan.originalCwd).sort(), [alias, sub].sort());
});

test('a session whose folder is gone gets its own bucket', () => {
  const now = Date.now();
  const s = (id, extra) => ({ id, title: id, mtime: now, originalCwd: '/w/proj', ...extra });
  const view = buildView([s('a'), s('b', { cwdMissing: true, originalCwd: '/w/proj/gone' })], {
    now, groupBy: 'project', chips: { project: true }, currentCwd: '/w/proj',
  });
  const names = view.groups.map((g) => [g.name, g.rows.map((r) => r.s.id)]);
  assert.deepEqual(names, [['proj', ['a']], ['Folder no longer exists', ['b']]]);
});

test('the peek feed reads normalized chat events from any CLI', () => {
  const r = peekFromEvents([
    { type: 'session', model: 'm1' },
    { type: 'user', text: 'fix   the bug', at: 5 },
    { type: 'text', text: 'Look' }, { type: 'text', text: 'ing now' },
    { type: 'tool', id: 't', title: 'Read', detail: 'src/a.js' },
    { type: 'tool', id: 't', status: 'done', output: 'x' },
    { type: 'text_final', text: 'Done' },
  ]);
  assert.equal(r.model, 'm1');
  assert.deepEqual(r.entries.map((e) => [e.kind, e.tool || '', e.text]), [
    ['user', '', 'fix the bug'], ['assistant', '', 'Looking now'], ['tool', 'Read', 'src/a.js'], ['assistant', '', 'Done'],
  ]);
  assert.equal(r.entries[0].ts, 5);
  assert.equal(peekFromEvents([]).empty, true);
});
