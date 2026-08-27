'use strict';

// Folder grouping for the Sessions roster.
//
// The other two groupings derive their headings from the sessions themselves.
// This one derives them from what the user said, which changes the rules: a
// folder outlives its contents, keeps the order it was made in, and is never
// invented on the reader's behalf.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sv = require('../../src/lib/session-view');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 7, 16, 12, 0, 0).getTime();

function mk(id, ago, extra = {}) {
  return {
    id,
    title: `session ${id}`,
    projectPath: '/code/husk',
    originalCwd: '/code/husk',
    path: `/projects/${id}.jsonl`,
    mtime: NOW - ago,
    startedMs: NOW - ago - HOUR,
    sizeBytes: 1024,
    named: false,
    firstMessage: '',
    prdSlug: '',
    prdPath: '',
    prdPhase: '',
    ...extra,
  };
}

const FOLDERS = [{ id: 'f1', name: 'In review' }, { id: 'f2', name: 'Shipped' }];

const ctx = (over = {}) => ({
  now: NOW,
  currentCwd: '/code/husk',
  groupBy: 'folder',
  chips: {},
  olderOpen: false,
  bySession: new Map(),
  byParent: new Map(),
  folders: FOLDERS,
  folderOf: { a: 'f1', b: 'f1', c: 'f2' },
  ...over,
});

test('sessions land in the folder they were filed under', () => {
  const list = [mk('a', MIN), mk('b', 2 * MIN), mk('c', 3 * MIN)];
  const { groups } = sv.buildView(list, ctx());
  assert.deepEqual(groups.map((g) => g.name), ['In review', 'Shipped']);
  assert.deepEqual(groups[0].rows.map((e) => e.s.id), ['a', 'b']);
  assert.deepEqual(groups[1].rows.map((e) => e.s.id), ['c']);
});

test('folders keep the order the user put them in, not a data order', () => {
  // "Shipped" holds the newest session. Project and day grouping would float it
  // to the top; a filing scheme must not reorder itself under the reader.
  const list = [mk('a', HOUR), mk('c', MIN)];
  const { groups } = sv.buildView(list, ctx());
  assert.deepEqual(groups.map((g) => g.name), ['In review', 'Shipped']);
});

test('an empty folder still renders, because it is a place to drop into', () => {
  const { groups } = sv.buildView([mk('a', MIN)], ctx());
  assert.deepEqual(groups.map((g) => g.name), ['In review', 'Shipped']);
  assert.equal(groups[1].rows.length, 0);
});

test('everything unfiled collects at the end', () => {
  const list = [mk('a', MIN), mk('z', 2 * MIN)];
  const { groups } = sv.buildView(list, ctx());
  const last = groups[groups.length - 1];
  assert.equal(last.name, 'Unfiled');
  assert.deepEqual(last.rows.map((e) => e.s.id), ['z']);
});

test('with nothing unfiled there is no Unfiled heading', () => {
  const { groups } = sv.buildView([mk('a', MIN)], ctx());
  assert.equal(groups.some((g) => g.name === 'Unfiled'), false);
});

test('a session filed under a folder that no longer exists is unfiled', () => {
  const { groups } = sv.buildView([mk('a', MIN)], ctx({ folderOf: { a: 'deleted-folder' } }));
  const unfiled = groups.find((g) => g.name === 'Unfiled');
  assert.deepEqual(unfiled.rows.map((e) => e.s.id), ['a']);
});

test('no folders at all is one Unfiled group rather than an empty page', () => {
  const { groups } = sv.buildView([mk('a', MIN)], ctx({ folders: [], folderOf: {} }));
  assert.deepEqual(groups.map((g) => g.name), ['Unfiled']);
});

test('a folder without a usable name still has a heading', () => {
  const { groups } = sv.buildView([mk('a', MIN)], ctx({
    folders: [{ id: 'f1', name: '   ' }], folderOf: { a: 'f1' },
  }));
  assert.equal(groups[0].name, 'Folder');
});

test('a folder row with no id is dropped rather than shown nameless', () => {
  const { groups } = sv.buildView([mk('a', MIN)], ctx({
    folders: [{ name: 'no id' }, { id: 'f1', name: 'Real' }], folderOf: { a: 'f1' },
  }));
  assert.deepEqual(groups.map((g) => g.name), ['Real']);
});

test('no folder is invented for wherever the user happens to be', () => {
  // Project grouping adds a ghost group for the current directory. Folders are
  // the user's own headings, so none is added on their behalf.
  const { groups } = sv.buildView([], ctx({ folders: [], folderOf: {} }));
  assert.deepEqual(groups, []);
});

test('every group carries the folder id it stands for', () => {
  const { groups } = sv.buildView([mk('a', MIN), mk('z', MIN)], ctx());
  assert.equal(groups[0].kind, 'folder');
  assert.equal(groups[0].folderId, 'f1');
  // Unfiled is a description rather than a folder, so it names no id.
  assert.equal(groups[groups.length - 1].folderId, '');
});

test('the older drawer files its sessions the same way', () => {
  const list = [mk('a', MIN), mk('old', 30 * DAY)];
  const { groups } = sv.buildView(list, ctx({ folderOf: { a: 'f1', old: 'f1' }, olderOpen: true }));
  const older = groups.filter((g) => g.older);
  assert.equal(older.length > 0, true);
  assert.equal(older.some((g) => g.rows.some((e) => e.s.id === 'old')), true);
});

test('a search still flattens to results, as it does under every grouping', () => {
  const list = [mk('a', MIN, { title: 'parser work' }), mk('c', 2 * MIN)];
  const { groups, flat } = sv.buildView(list, ctx({ query: 'parser', fuzzyMatch: null }));
  assert.equal(flat, true);
  assert.deepEqual(groups.map((g) => g.kind), ['results']);
});

test('a malformed folder list is ignored rather than thrown over', () => {
  for (const folders of [null, undefined, 'nope', [null, 42]]) {
    const { groups } = sv.buildView([mk('a', MIN)], ctx({ folders, folderOf: {} }));
    assert.deepEqual(groups.map((g) => g.name), ['Unfiled']);
  }
});

test('a malformed assignment map leaves everything unfiled', () => {
  for (const folderOf of [null, 'nope', 42]) {
    const { groups } = sv.buildView([mk('a', MIN)], ctx({ folderOf }));
    const unfiled = groups.find((g) => g.name === 'Unfiled');
    assert.deepEqual(unfiled.rows.map((e) => e.s.id), ['a']);
  }
});
