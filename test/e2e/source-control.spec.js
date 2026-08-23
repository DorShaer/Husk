'use strict';

// The Source page, in the real window, against a real repository.
//
// Nothing here is mocked: every number the page prints came out of a git
// process the app spawned itself, and every assertion is checked back against
// the same repository on disk with the fixture's own git. What has to be true
// is not that the page renders, but that what it renders is what git says.
//
// Three of those rules get their own tests because they are the ones a future
// edit could quietly erode: staged-ness follows a fresh read rather than a
// click, a discard confirms before it acts and stays undoable afterwards, and a
// remote-derived number never appears without the moment it was measured.
//
// Two more rules are pinned here because they hold across the whole page: a
// path git reports is a name and never a pattern, and the diff pane keeps its
// own overflow so the window never scrolls sideways.
//
// Each test launches its own app against its own throwaway home and its own
// throwaway repository, so one test cannot see what another staged.

const { test, expect, _electron: electron } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { makeRepo, makeGlobRepo } = require('../helpers/git-repo');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function launch(config) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-e2e-'));
  const cfgDir = path.join(homeDir, '.config', 'husk');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    firstRunDone: true, skipWelcome: true, ...(config || {}),
  }, null, 2));
  return electron.launch({
    args: [path.join(REPO_ROOT, 'src', 'main.js'), '--no-sandbox'],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir, ELECTRON_DISABLE_SANDBOX: '1', HUSK_E2E: '1' },
    timeout: 30_000,
  });
}

async function ready(app) {
  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });
  return win;
}

// The mutating gate accepts a root only when it is one of the pinned projects,
// so the fixture is pinned and made active before the window opens.
function seed(dir, over) {
  const now = new Date().toISOString();
  return {
    agentCommand: 'node -e "setInterval(function(){},1000)"',
    paiEnabled: false,
    voice: { enabled: false },
    projects: [{ id: 'p-fixture', name: 'Fixture', path: dir, addedAt: now, lastUsedAt: now }],
    activeProjectId: 'p-fixture',
    ...(over || {}),
  };
}

// The app spawns its own git with no -c identity of its own, so a commit and a
// stash run from the page need one recorded inside the throwaway repository.
function identify(repo) {
  repo.git('config', 'user.email', 'test@example.com');
  repo.git('config', 'user.name', 'Test');
  repo.git('config', 'commit.gpgsign', 'false');
  return repo;
}

function fixture(prefix) {
  return identify(makeRepo(prefix));
}

// The wildmatch shape, with the same identity. Null on a filesystem that
// refuses bracket characters in a name.
function globFixture(prefix) {
  const repo = makeGlobRepo(prefix);
  return repo ? identify(repo) : null;
}

function plainDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

async function openSource(win, root) {
  await win.locator('.rail-item[data-page="source"]').click();
  await expect.poll(() => win.evaluate(() => (window.Sc ? window.Sc.state.root : null)), { timeout: 20_000 })
    .toBe(root);
  await expect.poll(() => win.evaluate(() => (window.Sc ? window.Sc.state.readAt > 0 : false)), { timeout: 20_000 })
    .toBe(true);
}

// The whole left column, the head and the honesty markers, in one round trip.
function read(win) {
  return win.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => [...document.querySelectorAll(s)];
    const text = (n) => (n ? n.textContent.trim() : null);
    const pill = q('#sc-changes-count');
    const warn = q('#sc-composer-warn');
    return {
      sub: text(q('#source-sub')),
      pageText: text(q('.page-source')),
      pill: pill && !pill.hidden ? text(pill) : null,
      head: all('.page-source .page-head-right button').map((b) => b.id),
      bands: all('#sc-list .sc-band').map((b) => ({
        kind: b.dataset.band,
        title: text(b.querySelector('.sc-band-title')),
        count: text(b.querySelector('.sc-band-count')),
        rows: [...b.querySelectorAll('.sc-row')].map((r) => r.dataset.path),
        stats: [...b.querySelectorAll('.sc-row-stat')].map((s) => text(s)),
      })),
      empty: text(q('#sc-list .sc-empty, #sc-list .empty-state')),
      tiles: all('#sc-ov-stats .sc-ov-stat').map((t) => ({
        n: text(t.querySelector('.sc-ov-stat-n')),
        label: text(t.querySelector('.sc-ov-stat-l')),
        title: t.title,
      })),
      provBands: all('.page-source .sc-prov-band').length,
      provMarks: all('#sc-list .sc-row-prov').length,
      reviewNote: warn && !warn.hidden ? text(warn) : null,
      hasComposer: !!q('#sc-composer'),
      commitLabel: text(q('#sc-commit')),
      commitDisabled: q('#sc-commit') ? q('#sc-commit').disabled : null,
      hasFetch: !!q('#sc-fetch'),
      hasRemote: !!q('#sc-remote'),
      cursor: q('#sc-list .sc-row.is-active-key') ? q('#sc-list .sc-row.is-active-key').dataset.path : null,
    };
  });
}

// The diff pane: its head, its hunk bands, its two gutters and its openers.
function readDiff(win) {
  return win.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const all = (s) => [...document.querySelectorAll(s)];
    const text = (n) => (n ? n.textContent.trim() : null);
    return {
      pathLabel: text(q('#sc-dpath')),
      stat: text(q('#sc-dstat')),
      badge: text(q('#sc-dbadge')),
      acts: all('#sc-detail .sc-dacts .sc-act').map((b) => b.id),
      hunks: all('#sc-diff .sc-hunk').map((h) => ({
        index: h.dataset.hunk,
        range: text(h.querySelector('.sc-hunk-range')),
        fn: text(h.querySelector('.sc-hunk-fn')),
        acts: [...h.querySelectorAll('.sc-hunk-acts button')].map((b) => b.textContent),
      })),
      expands: all('#sc-diff .sc-expand').map((b) => b.textContent),
      gutters: all('#sc-diff .sc-dl').map((l) => l.querySelectorAll('.sc-dl-no').length),
      lines: all('#sc-diff .sc-dl').map((l) => ({
        kind: l.className.replace('sc-dl ', ''),
        old: l.children[0].textContent,
        neu: l.children[1].textContent,
        sign: l.children[2].textContent,
        code: l.children[3].textContent,
      })),
    };
  });
}

function confirmCopy(win) {
  return win.evaluate(() => ({
    title: document.getElementById('confirm-title').textContent,
    body: document.getElementById('confirm-body').textContent,
    ok: document.getElementById('confirm-ok').textContent,
    cancel: document.getElementById('confirm-cancel').textContent,
  }));
}

test('the page paints its bands from a real repository, with the counts git reports', async () => {
  const { dir, git } = fixture('husk-sc-bands');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  const view = await read(win);

  // What git says, read straight from the fixture.
  const porcelain = git('status', '--porcelain=v1', '--untracked-files=all', '--renames').split('\n').filter(Boolean);
  expect(porcelain).toEqual([' M src/app.js', 'M  src/lib/util.js']);

  expect(view.bands.map((b) => b.kind)).toEqual(['staged', 'changed']);
  expect(view.bands[0].title).toBe('Staged');
  expect(view.bands[0].count).toBe('1');
  expect(view.bands[0].rows).toEqual(['src/lib/util.js']);
  expect(view.bands[0].stats).toEqual(['+5 -1']);
  expect(view.bands[1].title).toBe('Changed');
  expect(view.bands[1].count).toBe('1');
  expect(view.bands[1].rows).toEqual(['src/app.js']);
  expect(view.bands[1].stats).toEqual(['+2 -2']);

  // A file that is both staged and changed would be two rows and one change, so
  // the tab pill counts paths where the bands count sides.
  expect(view.pill).toBe('2');
  expect(view.commitLabel).toBe('Commit 1 staged file');

  // No retained run and no live session, so provenance renders nothing at all
  // rather than a chip reading unknown, and the review note stays away.
  expect(view.provBands).toBe(0);
  expect(view.provMarks).toBe(0);
  expect(view.reviewNote).toBe(null);

  // This repository has no remote, so the head carries no upstream clause and no
  // count that would need one.
  expect(view.sub).toBe(path.basename(dir) + ' · main · 2 changes');
  expect(view.hasRemote).toBe(false);
  await app.close();
});

test('space on the cursor row stages the file and the bands and counts follow git', async () => {
  const { dir, git } = fixture('husk-sc-stage');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  // A key press only counts once the list it walks is on the page and no dialog
  // owns the keyboard, so both are true before the first one.
  await expect.poll(() => win.evaluate(() => document.querySelectorAll('#sc-list .sc-row').length), { timeout: 15_000 })
    .toBe(2);
  await win.evaluate(() => { document.querySelectorAll('.modal:not([hidden])').forEach((m) => { m.hidden = true; }); });

  // The cursor walks the list in band order: the staged file, then the changed one.
  const cursor = () => win.evaluate(() => {
    const el = document.querySelector('#sc-list .sc-row.is-active-key');
    return el ? el.dataset.path : null;
  });
  await win.keyboard.press('ArrowDown');
  await expect.poll(cursor, { timeout: 10_000 }).toBe('src/lib/util.js');
  await win.keyboard.press('ArrowDown');
  await expect.poll(cursor, { timeout: 10_000 }).toBe('src/app.js');

  await win.keyboard.press('Space');

  // Staged-ness is a projection of the next read, so the row moves only once git
  // agrees, and the whole surface is read back in one go.
  await expect.poll(async () => (await read(win)).bands.map((b) => b.kind + ':' + b.count).join(' '), { timeout: 15_000 })
    .toBe('staged:2');

  const view = await read(win);
  expect(view.bands[0].rows).toEqual(['src/app.js', 'src/lib/util.js']);
  expect(view.pill).toBe('2');
  expect(view.commitLabel).toBe('Commit 2 staged files');

  const staged = git('diff', '--cached', '--name-only').trim().split('\n').sort();
  expect(staged).toEqual(['src/app.js', 'src/lib/util.js']);
  expect(git('diff', '--name-only').trim()).toBe('');
  await app.close();
});

test('the composer commits what is staged and the change list empties', async () => {
  const { dir, git } = fixture('husk-sc-commit');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  await win.locator('#sc-list .sc-band[data-band="changed"] .sc-row[data-path="src/app.js"] .sc-row-check').click();
  await expect.poll(async () => (await read(win)).commitLabel, { timeout: 15_000 }).toBe('Commit 2 staged files');

  await win.locator('#sc-subject').fill('feat(fixture): commit from the source page');
  await win.locator('#sc-body').fill('The body travels to git on stdin.');
  await expect.poll(() => win.evaluate(() => document.getElementById('sc-commit').disabled), { timeout: 5_000 })
    .toBe(false);
  await win.locator('#sc-commit').click();

  await expect.poll(async () => (await read(win)).bands.length, { timeout: 20_000 }).toBe(0);

  const view = await read(win);
  expect(view.empty).toContain('Nothing to commit.');
  expect(view.pill).toBe(null);
  expect(view.commitLabel).toBe('Stage something to commit');

  // git is the record of what happened, not the toast.
  expect(git('log', '-1', '--format=%s').trim()).toBe('feat(fixture): commit from the source page');
  expect(git('log', '-1', '--format=%b').trim()).toBe('The body travels to git on stdin.');
  expect(git('status', '--porcelain=v1').trim()).toBe('');

  // The sha the History tab shows is the sha git wrote.
  const sha = git('rev-parse', 'HEAD').trim();
  await win.locator('#sc-tab-history').click();
  await expect.poll(() => win.evaluate(() => {
    const row = document.querySelector('#sc-list .sc-crow');
    return row ? row.dataset.sha : null;
  }), { timeout: 15_000 }).toBe(sha);
  await app.close();
});

test('a diff opens with its hunks, its two gutters and its per-hunk actions', async () => {
  const { dir } = fixture('husk-sc-diff');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  await win.locator('#sc-list .sc-band[data-band="changed"] .sc-row[data-path="src/app.js"]').click();
  await expect.poll(() => win.evaluate(() => document.querySelectorAll('#sc-diff .sc-hunk').length), { timeout: 15_000 })
    .toBe(2);

  const diff = await readDiff(win);
  expect(diff.pathLabel).toBe('src/app.js');
  expect(diff.stat).toBe('+2 -2');
  expect(diff.badge).toBe('MODIFIED');

  // The range reads in the numbers a person reads, and the second band carries
  // git's own function context.
  expect(diff.hunks[0].range).toBe('@@ Lines 1-7');
  expect(diff.hunks[0].fn).toBe(null);
  expect(diff.hunks[1].range).toBe('@@ Lines 17-23');
  expect(diff.hunks[1].fn).toBe('in function delta() {');

  // A working-tree hunk can be staged or discarded; unstaging belongs to the
  // index side and is not offered here.
  expect(diff.hunks[0].acts).toEqual(['Stage hunk', 'Discard hunk']);
  expect(diff.hunks[1].acts).toEqual(['Stage hunk', 'Discard hunk']);

  // Every line carries both gutters, including the ones that exist on one side.
  expect(new Set(diff.gutters)).toEqual(new Set([2]));
  expect(diff.lines[0]).toEqual({ kind: 'is-ctx', old: '1', neu: '1', sign: '', code: "'use strict';" });
  expect(diff.lines[3]).toEqual({ kind: 'is-del', old: '4', neu: '', sign: '-', code: '  return 1;' });
  expect(diff.lines[4]).toEqual({ kind: 'is-add', old: '', neu: '4', sign: '+', code: '  return 11;' });
  expect(diff.lines[diff.lines.length - 1]).toEqual({
    kind: 'is-ctx', old: '23', neu: '23', sign: '',
    code: 'module.exports = { alpha, beta, gamma, delta, epsilon };',
  });

  // The nine unread lines between the two hunks are offered rather than hidden.
  expect(diff.expands.length).toBe(1);
  expect(diff.expands[0]).toContain('expand 9 lines');
  await app.close();
});

test('discard asks first, leaves the file alone when it is cancelled, and stays undoable', async () => {
  const { dir, git } = fixture('husk-sc-discard');
  const abs = path.join(dir, 'src', 'app.js');
  const dirty = fs.readFileSync(abs, 'utf8');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  await win.locator('#sc-list .sc-band[data-band="changed"] .sc-row[data-path="src/app.js"]').click();
  await expect.poll(() => win.evaluate(() => document.querySelectorAll('#sc-diff .sc-hunk').length), { timeout: 15_000 })
    .toBe(2);

  await win.locator('#sc-act-discard').click();
  await expect(win.locator('#confirm-modal')).toBeVisible();

  // The confirm names the count, the line counts and the path, and its button
  // states the consequence rather than saying OK.
  const copy = await confirmCopy(win);
  expect(copy.title).toBe('Discard 1 file?');
  expect(copy.body).toContain('1 tracked file goes to a stash you can restore.');
  expect(copy.body).toContain('That is +2 -2 lines.');
  expect(copy.body).toContain('src/app.js');
  expect(copy.ok).toBe('Discard 1 file');

  // Nothing has happened yet.
  expect(fs.readFileSync(abs, 'utf8')).toBe(dirty);
  await win.locator('#confirm-cancel').click();
  await expect(win.locator('#confirm-modal')).toBeHidden();
  expect(fs.readFileSync(abs, 'utf8')).toBe(dirty);
  expect(git('stash', 'list').trim()).toBe('');

  await win.locator('#sc-act-discard').click();
  await expect(win.locator('#confirm-modal')).toBeVisible();
  await win.locator('#confirm-ok').click();

  await expect.poll(() => fs.readFileSync(abs, 'utf8').includes('return 11;'), { timeout: 20_000 }).toBe(false);
  expect(git('stash', 'list').trim()).not.toBe('');

  // The change went to a stash, and the toast binds Undo to that exact stash.
  const undo = win.locator('#toast-stack .toast .toast-action', { hasText: 'Undo' });
  await expect(undo).toBeVisible();
  await expect(win.locator('#toast-stack .toast .toast-msg').first()).toContainText('set aside in stash');

  await undo.click();
  await expect.poll(() => fs.readFileSync(abs, 'utf8'), { timeout: 20_000 }).toBe(dirty);
  await app.close();
});

// The resting overview ends in a card that takes the height the others leave,
// so a repository with history never shows a half-empty pane.
test('the resting overview carries recent commits, sized by what it holds', async () => {
  test.setTimeout(90_000);
  const repo = fixture('husk-sc-recent');
  // The overview is the resting state, and rest means nothing to review. With
  // changes present the pane opens on the first of them instead.
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'chore(fixture): settle the tree');
  const app = await launch(seed(repo.dir));
  const win = await ready(app);
  await openSource(win, repo.dir);

  const view = await win.evaluate(() => {
    const host = document.getElementById('sc-ov-recent');
    const card = host ? host.querySelector('.sc-ov-card') : null;
    const ov = document.getElementById('sc-ov');
    const rows = card ? [...card.querySelectorAll('.sc-crow')] : [];
    return {
      hidden: !host || host.hidden,
      grows: !!(card && card.classList.contains('is-grow')),
      subjects: rows.map((r) => r.querySelector('.sc-crow-subject').textContent),
      shas: rows.map((r) => r.dataset.sha).filter(Boolean).length,
      // The rows box is taller than the rows need, which is what taking the
      // leftover height means: the pane ends in a panel, not in blank ground.
      // scrollHeight cannot answer this, since it never reports less than
      // clientHeight, so the rows are measured directly.
      slack: (() => {
        const box = card ? card.querySelector('.sc-ov-rows') : null;
        if (!box || !ov) return 0;
        const need = [...box.querySelectorAll('.sc-crow')]
          .reduce((n, r) => n + r.getBoundingClientRect().height, 0);
        return Math.round(box.clientHeight - need);
      })(),
      act: card ? card.querySelector('.sc-ov-card-head .ghost-btn').textContent : '',
    };
  });

  expect(view.hidden).toBe(false);
  // Sized by its rows. Stretching it to the pane floor was how the page hid
  // having nothing else to put there.
  expect(view.grows).toBe(false);
  expect(view.act).toBe('Show all');
  // Newest first, and every row carries the sha it opens.
  expect(view.subjects[0]).toBe('chore(fixture): settle the tree');
  expect(view.subjects).toContain('feat(lib): add the slug helper');
  expect(view.subjects).toContain('chore(fixture): add the first two files');
  expect(view.shas).toBe(view.subjects.length);
  // No leftover height inside the card: it ends where its rows end.
  expect(view.slack).toBeLessThan(24);

  // Show all is the History tab, so the card is a way in rather than a dead end.
  await win.locator('#sc-ov-recent .sc-ov-card-head .ghost-btn').click();
  await expect.poll(() => win.evaluate(() => (window.Sc ? window.Sc.state.tab : '')), { timeout: 15_000 })
    .toBe('history');
  await app.close();
});

// The pane at rest is the same object it is once a file is picked. A review desk
// exists to show a diff, so arriving at one with changes waiting shows the first
// of them rather than a summary of how many there are.
test('with changes waiting the pane opens on the first of them, not on a summary', async () => {
  const { dir } = fixture('husk-sc-autoopen');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  await expect.poll(() => win.evaluate(() => (window.Sc && window.Sc.state.diffModel ? window.Sc.state.diffModel.rel : null)), { timeout: 15_000 })
    .toBe('src/lib/util.js');

  const view = await win.evaluate(() => ({
    detailShown: !document.getElementById('sc-detail').hidden,
    overviewShown: !document.getElementById('sc-ov').hidden,
    lines: document.querySelectorAll('#sc-detail .sc-dl').length,
  }));
  expect(view.detailShown).toBe(true);
  expect(view.overviewShown).toBe(false);
  expect(view.lines).toBeGreaterThan(0);
  await app.close();
});

// Opening on the first change must never pull the pane off a file the reader
// chose, so it only ever fires from a resting pane.
test('opening on the first change does not override a file the reader picked', async () => {
  const { dir } = fixture('husk-sc-autoopen-respect');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);
  await expect.poll(() => win.evaluate(() => (window.Sc && window.Sc.state.diffModel ? 1 : 0)), { timeout: 15_000 }).toBe(1);

  await win.locator('.sc-row[data-path="src/app.js"]').click();
  await expect.poll(() => win.evaluate(() => window.Sc.state.diffModel.rel), { timeout: 15_000 }).toBe('src/app.js');

  // Several poll cycles later it is still the file that was clicked.
  await win.waitForTimeout(4000);
  expect(await win.evaluate(() => window.Sc.state.diffModel.rel)).toBe('src/app.js');
  await app.close();
});

// A repository with no commits has nothing to put in that card, so it does not
// render an empty one.
test('the recent card stays away when there is no history to put in it', async () => {
  const dir = plainDir('husk-sc-recent-unborn');
  execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', 'init', '-q'], { stdio: 'pipe' });
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  const hidden = await win.evaluate(() => {
    const host = document.getElementById('sc-ov-recent');
    return !host || host.hidden;
  });
  expect(hidden).toBe(true);
  await app.close();
});

test('a repository with no commits lands on its empty state rather than a broken page', async () => {
  const dir = plainDir('husk-sc-unborn');
  execFileSync('git', ['-C', dir, '-c', 'init.defaultBranch=main', 'init', '-q'], { stdio: 'pipe' });
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  const view = await read(win);
  expect(view.sub).toBe(path.basename(dir) + ' · main · no commits yet · 0 changes');
  expect(view.bands).toEqual([]);
  expect(view.empty).toContain('Nothing to commit. This repository has no commits yet.');
  expect(view.pageText).toContain('No commits yet. Your first commit will start the history here.');
  expect(view.hasComposer).toBe(true);
  expect(view.commitLabel).toBe('Stage something to commit');
  expect(view.commitDisabled).toBe(true);

  await win.locator('#sc-tab-history').click();
  await expect.poll(async () => (await read(win)).empty, { timeout: 15_000 })
    .toContain('No commits yet. The first commit will appear here.');
  await app.close();
});

test('a folder that is not a repository offers to initialize one and nothing else', async () => {
  const dir = plainDir('husk-sc-plain');
  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  const view = await read(win);
  expect(view.sub).toBe(dir + ' · not a git repository');
  expect(view.empty).toContain(dir + ' is not a git repository.');
  expect(view.empty).toContain('Source control turns on the moment this folder has one.');
  expect(view.empty).toContain('Initialize a repository here');
  expect(view.empty).toContain('Initialize runs git init and nothing else. No commit, no remote.');

  // A control that would be refused is absent from the document, not disabled.
  expect(view.hasFetch).toBe(false);
  expect(view.hasRemote).toBe(false);
  expect(view.hasComposer).toBe(false);
  expect(view.head).toEqual(['sc-scope', 'sc-refresh']);
  await app.close();
});

test('a repository that has never been fetched prints no behind count and stamps the ahead count', async () => {
  const { dir, git } = fixture('husk-sc-fresh');
  const bare = dir + '-remote.git';
  execFileSync('git', ['init', '--bare', '-b', 'main', '-q', bare], { stdio: 'pipe' });
  git('remote', 'add', 'origin', bare);
  git('push', '-q', '-u', 'origin', 'main');
  for (const n of ['one', 'two']) {
    fs.writeFileSync(path.join(dir, 'ahead-' + n + '.txt'), n + '\n');
    git('add', '--', 'ahead-' + n + '.txt');
    git('commit', '-qm', 'chore(fixture): commit ' + n, '--', 'ahead-' + n + '.txt');
  }
  expect(fs.existsSync(path.join(dir, '.git', 'FETCH_HEAD'))).toBe(false);

  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  const view = await read(win);
  expect(view.sub).toContain('2 ahead of origin/main, never fetched');

  // Every count on the page names when it was measured, and a count that has
  // never been measured is suppressed rather than printed as zero.
  expect(view.sub).toMatch(/\d+ ahead[^·]*(measured|never fetched)/);
  expect(view.pageText).not.toMatch(/\d+\s+behind/);
  expect(view.pageText).toContain('A behind count is not shown until a fetch has run.');
  await app.close();
});

// The bands, keyed by kind, with each band's paths in a stable order.
function bandRows(view) {
  return view.bands.map((b) => b.kind + ':' + b.rows.slice().sort().join(' ')).join(' | ');
}

test('a path that is also a glob is staged and discarded as the one file it names', async () => {
  // Boots Electron and drives four settle points against real git, so it runs
  // to the budget heavy specs in this suite use.
  test.setTimeout(90_000);
  const repo = globFixture('husk-sc-glob');
  test.skip(!repo, 'this filesystem does not keep bracket characters in a file name');
  const { dir, git, bracket, plain, base } = repo;
  const plainBytes = fs.readFileSync(path.join(dir, plain));
  const both = [bracket, plain].sort().join(' ');

  const app = await launch(seed(dir));
  const win = await ready(app);
  await openSource(win, dir);

  // Both files are modified and neither is staged, so anything that lands in
  // the index came from the click that follows.
  expect(bandRows(await read(win))).toBe('changed:' + both);

  await win.locator('#sc-list .sc-row[data-path="' + bracket + '"] .sc-row-check').click();
  await expect.poll(async () => bandRows(await read(win)), { timeout: 15_000 })
    .toBe('staged:' + bracket + ' | changed:' + plain);

  // git is the record. The named file is in the index and the file its name
  // would match as a pattern is still only in the working tree.
  expect(git('diff', '--cached', '--name-only').trim().split('\n')).toEqual([bracket]);
  expect(git('diff', '--name-only').trim().split('\n')).toEqual([plain]);

  // Back out of the index, then take the same path down the discard route.
  await win.locator('#sc-list .sc-row[data-path="' + bracket + '"] .sc-row-check').click();
  await expect.poll(async () => bandRows(await read(win)), { timeout: 15_000 }).toBe('changed:' + both);

  await win.locator('#sc-list .sc-row[data-path="' + bracket + '"]').click();
  await expect.poll(async () => (await readDiff(win)).pathLabel, { timeout: 15_000 }).toBe(bracket);

  await win.locator('#sc-act-discard').click();
  await expect(win.locator('#confirm-modal')).toBeVisible();
  const copy = await confirmCopy(win);
  expect(copy.title).toBe('Discard 1 file?');
  expect(copy.body).toContain(bracket);
  await win.locator('#confirm-ok').click();

  // One file went to the stash and the other kept every byte it had.
  await expect.poll(() => git('status', '--porcelain=v1').split('\n').filter(Boolean), { timeout: 20_000 })
    .toEqual([' M ' + plain]);
  expect(fs.readFileSync(path.join(dir, plain))).toEqual(plainBytes);
  expect(fs.readFileSync(path.join(dir, bracket), 'utf8')).toBe(base);
  expect(git('stash', 'show', '--name-only', 'stash@{0}').trim().split('\n')).toEqual([bracket]);
  await app.close();
});

// A tracked file whose path is long enough to outrun the pane, whose diff
// carries a line far wider than any window, and whose diff is longer than the
// pane is tall, so both axes of the overflow have something real in them.
const WIDE_REL = 'src/renderer/components/navigation/breadcrumbs/a-really-long-directory-name/'
  + 'an-exceptionally-long-file-name-that-no-narrow-pane-can-print-in-full.js';

function wideText(word) {
  const lines = ["'use strict';", '', "const banner = '" + word.repeat(120) + "';", ''];
  for (let i = 0; i < 80; i++) lines.push('const value' + i + " = '" + word + '-' + i + "';");
  lines.push('', 'module.exports = { banner };', '');
  return lines.join('\n');
}

function addWideFile(repo) {
  const abs = path.join(repo.dir, WIDE_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, wideText('abcde'));
  repo.git('add', '--', WIDE_REL);
  repo.git('commit', '-qm', 'chore(fixture): add the wide file');
  fs.writeFileSync(abs, wideText('vwxyz'));
  return WIDE_REL;
}

// Every box on the page, plus the one that is allowed to overflow.
function overflow(win) {
  return win.evaluate(() => {
    const over = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.scrollWidth - el.clientWidth : null;
    };
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { right: Math.round(r.right), bottom: Math.round(r.bottom) };
    };
    const wrap = document.getElementById('sc-diff-wrap');
    const grid = document.querySelector('.page-source .sc');
    return {
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
      page: over('.page-source'),
      grid: over('.page-source .sc'),
      nav: over('.sc-nav'),
      main: over('.sc-main'),
      detail: over('#sc-detail'),
      head: over('.sc-dhead'),
      wrapX: wrap.scrollWidth - wrap.clientWidth,
      wrapY: wrap.scrollHeight - wrap.clientHeight,
      wrapBox: rect('#sc-diff-wrap'),
      mainBox: rect('.sc-main'),
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      width: window.innerWidth,
    };
  });
}

test('the page keeps a wide diff and a long path inside the diff pane at any window width', async () => {
  // Boots Electron, writes a wide file and measures at two window widths.
  test.setTimeout(90_000);
  const repo = fixture('husk-sc-layout');
  const rel = addWideFile(repo);
  const app = await launch(seed(repo.dir));
  const win = await ready(app);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1280, 800); });
  await openSource(win, repo.dir);

  await win.locator('#sc-list .sc-row[data-path="' + rel + '"]').click();
  await expect.poll(() => win.evaluate(() => document.querySelectorAll('#sc-diff .sc-dl').length), { timeout: 15_000 })
    .toBeGreaterThan(0);

  const wide = await overflow(win);

  // The window is the outer boundary: nothing on the page pushes it sideways.
  expect(wide.doc, JSON.stringify(wide)).toBeLessThanOrEqual(0);
  expect(wide.body, JSON.stringify(wide)).toBeLessThanOrEqual(0);
  expect(wide.page, JSON.stringify(wide)).toBeLessThanOrEqual(1);
  expect(wide.grid, JSON.stringify(wide)).toBeLessThanOrEqual(1);
  expect(wide.nav, JSON.stringify(wide)).toBeLessThanOrEqual(1);
  expect(wide.main, JSON.stringify(wide)).toBeLessThanOrEqual(1);
  expect(wide.detail, JSON.stringify(wide)).toBeLessThanOrEqual(1);
  expect(wide.head, JSON.stringify(wide)).toBeLessThanOrEqual(1);

  // The diff pane is the box that carries both overflows, and it stays inside
  // the right column on both axes.
  expect(wide.wrapX, JSON.stringify(wide)).toBeGreaterThan(0);
  expect(wide.wrapY, JSON.stringify(wide)).toBeGreaterThan(0);
  expect(wide.wrapBox.right).toBeLessThanOrEqual(wide.mainBox.right + 1);
  expect(wide.wrapBox.bottom).toBeLessThanOrEqual(wide.mainBox.bottom + 1);
  expect(wide.columns).toBe(2);

  // Narrow enough for the single-column breakpoint, where the same rules hold.
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(760, 640); });
  await expect.poll(async () => (await overflow(win)).columns, { timeout: 10_000 }).toBe(1);

  const narrow = await overflow(win);
  expect(narrow.width).toBeLessThan(901);
  expect(narrow.doc, JSON.stringify(narrow)).toBeLessThanOrEqual(0);
  expect(narrow.body, JSON.stringify(narrow)).toBeLessThanOrEqual(0);
  expect(narrow.page, JSON.stringify(narrow)).toBeLessThanOrEqual(1);
  expect(narrow.grid, JSON.stringify(narrow)).toBeLessThanOrEqual(1);
  expect(narrow.nav, JSON.stringify(narrow)).toBeLessThanOrEqual(1);
  expect(narrow.main, JSON.stringify(narrow)).toBeLessThanOrEqual(1);
  expect(narrow.detail, JSON.stringify(narrow)).toBeLessThanOrEqual(1);
  expect(narrow.head, JSON.stringify(narrow)).toBeLessThanOrEqual(1);
  expect(narrow.wrapX, JSON.stringify(narrow)).toBeGreaterThan(0);
  expect(narrow.wrapY, JSON.stringify(narrow)).toBeGreaterThan(0);
  expect(narrow.wrapBox.right).toBeLessThanOrEqual(narrow.mainBox.right + 1);
  expect(narrow.wrapBox.bottom).toBeLessThanOrEqual(narrow.mainBox.bottom + 1);
  await app.close();
});
