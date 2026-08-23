'use strict';

// The source page: state, IPC, repaint, keyboard.
//
// This is the only file that talks to window.husk.git, and it holds three rules
// as mechanism rather than as copy.
//
//   1. Staged-ness is a projection of the last status read. There is no local
//      flag anywhere here that remembers a click. A stage action fires the IPC,
//      re-reads, and repaints from the new snapshot; a failed re-read leaves the
//      row showing its old true state and says so.
//   2. A repaint replaces every number from one snapshot. There is no partial
//      update path, so a count, a stat and a badge can never come from two
//      different reads.
//   3. A remote-derived number is rendered with the moment it was measured, and
//      a repository that has never been fetched suppresses its behind count.
//
// Every node comes from window.ScDom. This file writes text and attributes and
// builds no markup.
//
// It loads before app.js, so toast, toastAction, openConfirmDialog, escapeHtml,
// setPage, fxCurrentRoot and fxOpenFile are read at call time and guarded.

(function () {
  const Dom = (typeof window !== 'undefined' && window.ScDom) || null;
  if (!Dom) {
    if (typeof console !== 'undefined') console.error('sc-page: sc-dom.js must load first; the source page will not render');
    return;
  }

  const byId = (id) => document.getElementById(id);
  const git = () => (window.husk && window.husk.git) || null;
  const txt = () => (window.husk && window.husk.text) || null;

  // ─── App globals, read at call time ───────────────────────────────────────

  function say(msg, kind) {
    if (typeof window.toast === 'function') window.toast(msg, kind || '');
  }

  function sayWith(msg, label, onAction, kind) {
    if (typeof window.toastAction === 'function') window.toastAction(msg, label, onAction, kind || 'success');
    else say(msg, kind);
  }

  function esc(s) {
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // A destructive act with no dialog available does not happen.
  function confirmAct(opts) {
    if (typeof window.openConfirmDialog !== 'function') return Promise.resolve(false);
    return window.openConfirmDialog(opts);
  }

  function goPage(name) {
    if (typeof window.setPage === 'function') window.setPage(name);
  }

  function projectRoot() {
    if (typeof window.fxCurrentRoot === 'function') {
      const r = window.fxCurrentRoot();
      return typeof r === 'string' && r ? r : null;
    }
    return null;
  }

  // ─── Small pure helpers ───────────────────────────────────────────────────

  function baseOf(p) {
    const s = String(p || '');
    const cut = s.lastIndexOf('/');
    return cut >= 0 ? s.slice(cut + 1) : s;
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  function count(n, one, many) {
    return String(n) + ' ' + plural(n, one, many);
  }

  // The path as the user writes it, with the home folder as a tilde.
  function tildify(p) {
    const s = String(p || '');
    if (home && s.indexOf(home) === 0) return '~' + s.slice(home.length);
    return s;
  }

  const LANG_BY_EXT = Object.freeze({
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', css: 'css', html: 'html', htm: 'html',
    md: 'markdown', markdown: 'markdown',
    py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell',
  });

  function langFor(rel) {
    const name = baseOf(rel);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return LANG_BY_EXT[name.slice(dot + 1).toLowerCase()] || null;
  }

  // The three index functions the cursor runs on, kept pure so the arithmetic
  // can be read on its own.
  function clampIndex(i, n) {
    if (n <= 0) return -1;
    if (!Number.isInteger(i) || i < 0) return 0;
    return Math.min(i, n - 1);
  }

  function stepIndex(i, delta, n) {
    if (n <= 0) return -1;
    if (!Number.isInteger(i) || i < 0) return delta > 0 ? 0 : n - 1;
    return Math.min(n - 1, Math.max(0, i + delta));
  }

  function stepPane(chain, current, delta) {
    if (!chain.length) return current;
    const at = chain.indexOf(current);
    if (at === -1) return chain[0];
    return chain[Math.min(chain.length - 1, Math.max(0, at + delta))];
  }

  // Log records and attribution both come from window.husk.text, which runs the
  // same modules the unit tests cover. Attribution crosses the bridge as a plain
  // object keyed by path, so a claim is read behind an own-property guard.

  function ownClaim(claims, rel) {
    if (!claims || typeof claims !== 'object') return null;
    return Object.prototype.hasOwnProperty.call(claims, rel) ? claims[rel] : null;
  }

  function underRoot(outer, inner) {
    if (typeof outer !== 'string' || typeof inner !== 'string' || !outer || !inner) return false;
    const a = outer.replace(/\/+$/, '');
    const b = inner.replace(/\/+$/, '');
    return a === b || b.indexOf(a + '/') === 0;
  }

  // A commit's ref names arrive as a list, and the head of a card wants a line.
  function refsLine(rec) {
    if (!rec) return '';
    if (Array.isArray(rec.refs)) return rec.refs.join(', ');
    return typeof rec.refs === 'string' ? rec.refs : '';
  }

  // ─── State ────────────────────────────────────────────────────────────────
  //
  // Plain and exposed, so a test can read every number the page is showing and
  // drive the page the way a person does.

  const state = {
    scope: 'project',     // 'project' | 'run'
    root: null,
    runId: null,
    repo: null,           // the last git:repo snapshot
    entries: [],          // one row per porcelain entry, from that same snapshot
    bands: [],            // [{ kind, rows }] as painted
    tab: 'changes',       // 'changes' | 'history'
    query: '',
    selected: [],         // keys of the rows acted on together
    diffModel: null,      // { rel, side, band, context, wrap, files, note }
    cursor: { pane: 'list', index: -1 },
    readAt: 0,
    stale: false,
  };

  // Everything that is not part of the page's answer lives here, so state stays
  // the shape a test reads.
  const ui = {
    wired: false,
    opened: false,
    home: '',
    projects: [],
    runs: [],
    sessions: [],
    history: [],
    historyMore: false,
    commit: null,         // { record, files } for the open history commit
    branches: null,
    watching: false,
    watchTried: false,
    readFailed: false,
    truncated: false,
    fetchError: '',
    fetchErrorAt: 0,
    amendPublished: false,
    inFlight: false,
    queued: false,
    mutating: false,
    pollTimer: null,
    changedTimer: null,
    anchor: -1,
    acts: [],
    actsHome: null,
    headBtns: [],
    headHome: null,
    composer: null,
    composerHome: null,
    applySheet: null,
    diffFiles: null,
    diffWrap: null,
    popKind: '',
    popFoot: null,
  };

  let home = '';

  // ─── Scope ────────────────────────────────────────────────────────────────

  // The desk points at one of two things: the pinned project, or a retained run
  // worktree. The scope decides whether staging and committing exist at all,
  // because a run's worktree is taken through Apply and never committed here.
  function resolveScope() {
    if (state.scope === 'run' && state.runId) {
      const run = ui.runs.find((r) => r && r.runId === state.runId);
      if (run && run.worktreePath) { state.root = run.worktreePath; return; }
      state.scope = 'project';
      state.runId = null;
    }
    state.root = projectRoot();
  }

  function activeRun() {
    if (state.scope !== 'run') return null;
    return ui.runs.find((r) => r && r.runId === state.runId) || null;
  }

  function isProject(root) {
    if (!root) return false;
    const want = String(root).replace(/\/+$/, '');
    return ui.projects.some((p) => p && typeof p.path === 'string' && p.path.replace(/\/+$/, '') === want);
  }

  // Mutating controls exist only where a mutating call would be accepted: the
  // pinned project's own tree. A folder opened for a look, and a run's worktree,
  // are read-only surfaces and their controls are absent rather than dead.
  function canMutate() {
    return state.scope === 'project' && !!state.repo && state.repo.isRepo === true && isProject(state.root);
  }

  function isVisible() {
    return document.body.dataset.page === 'source';
  }

  // ─── Reading ──────────────────────────────────────────────────────────────

  function sideFor(band) {
    if (band === 'staged') return 'index';
    if (band === 'untracked') return 'untracked';
    return 'worktree';
  }

  function rowKey(band, rel) {
    return band + ':' + rel;
  }

  // One snapshot, one repaint. Every figure the page shows afterwards came out
  // of this call, so nothing on screen is ever a mix of two reads.
  async function readAll() {
    if (!git()) return;
    // A read asked for while one is running is not dropped: it is remembered and
    // run once the first lands, so a mutating call always ends on a fresh read.
    if (ui.inFlight) { ui.queued = true; return; }
    ui.inFlight = true;
    try { await readOnce(); } finally { ui.inFlight = false; }
    if (ui.queued) { ui.queued = false; await readAll(); }
  }

  // A read that did not land says so once, and the page keeps the numbers of
  // the last read that did.
  function failedRead(msg) {
    if (!ui.readFailed) say(msg, 'error');
    ui.readFailed = true;
  }

  async function readOnce() {
    const api = git();
    state.stale = true;
    paintStale();
    // A read lands only when a whole snapshot arrived. Half a snapshot is not a
    // snapshot: the previous values and their stamp stay, marked as not fresh.
    let landed = false;

    try {
      await loadContext();
      resolveScope();
      const root = state.root;
      if (!root) {
        state.repo = null;
        state.entries = [];
        state.bands = [];
        ui.truncated = false;
        state.readAt = Date.now();
        landed = true;
        return;
      }

      const [repo, status] = await Promise.all([api.repo(root), api.status(root)]);
      if (!repo || repo.ok !== true) {
        failedRead('Could not read this repository');
        return;
      }
      if (repo.isRepo === true && (!status || status.ok !== true)) {
        failedRead('Could not read what changed in this repository');
        return;
      }
      state.repo = repo;
      state.readAt = repo.readAt || Date.now();
      // A fetch that ran after the failure was recorded answers it, wherever it
      // was run from.
      if (ui.fetchError && typeof repo.fetchedAtMs === 'number' && repo.fetchedAtMs > ui.fetchErrorAt) clearFetchError();

      if (repo.isRepo !== true) {
        state.entries = [];
        state.bands = [];
        ui.truncated = false;
        landed = true;
        return;
      }
      state.entries = mergeEntries(status);
      state.bands = groupBands(state.entries);
      // The status read names its own cap, so the page states that the list
      // stops rather than printing the cap as the answer.
      ui.truncated = !!status.truncated;
      // The resting overview carries recent commits, so history rides the same
      // read the counts come from and both sides of the page describe one
      // snapshot.
      await loadHistory();
      landed = true;
    } finally {
      if (landed) ui.readFailed = false;
      else failedRead('Could not read this repository');
      state.stale = !landed;
      reconcileDiffModel();
      paintAll();
    }
  }

  // The retained runs and the live sessions the attribution rule is measured
  // against, plus the project list the mutating controls are gated on.
  async function loadContext() {
    const husk = window.husk || {};
    if (husk.projects && typeof husk.projects.list === 'function') {
      try {
        const r = await husk.projects.list();
        if (r && r.ok && Array.isArray(r.projects)) ui.projects = r.projects;
      } catch (_) {}
    }
    if (husk.autopilot && typeof husk.autopilot.retained === 'function') {
      try {
        const r = await husk.autopilot.retained();
        if (r && r.ok && Array.isArray(r.runs)) ui.runs = r.runs;
      } catch (_) {}
    }
    if (husk.bgAgents && typeof husk.bgAgents.list === 'function') {
      try {
        const r = await husk.bgAgents.list({ allProjects: true });
        const chats = (r && Array.isArray(r.chats)) ? r.chats : [];
        const agents = (r && Array.isArray(r.agents)) ? r.agents.filter((a) => a && a.running) : [];
        ui.sessions = chats.concat(agents)
          .filter((s) => s && s.cwd && s.startedAt)
          .map((s) => ({ cwd: String(s.cwd), startedAt: Number(s.startedAt) }));
      } catch (_) { ui.sessions = []; }
    }
  }

  // Porcelain plus numstat plus attribution, folded into one row per file per
  // side. A file that is both staged and changed is two rows, because git holds
  // two different versions of it and one row could only lie about one of them.
  function mergeEntries(status) {
    const api = txt();
    const parsed = api && typeof api.parseGitStatus === 'function' ? api.parseGitStatus(status.porcelain || '') : [];
    const mtimes = status.mtimes || {};
    const stagedStat = new Map();
    const unstagedStat = new Map();
    for (const f of ((status.numstat && status.numstat.staged) || [])) stagedStat.set(f.path, f);
    for (const f of ((status.numstat && status.numstat.unstaged) || [])) unstagedStat.set(f.path, f);

    // A run's file list names paths inside that run's own worktree, so it can
    // attribute only the entries read out of that worktree. The project's tree
    // is a different tree, and there time is all Husk knows.
    const runs = state.scope === 'run'
      ? ui.runs.filter((r) => r && r.runId === state.runId)
      : [];
    const claims = api && typeof api.attributeChanges === 'function' ? api.attributeChanges({
      entries: parsed.map((e) => ({ rel: e.path, mtimeMs: typeof mtimes[e.path] === 'number' ? mtimes[e.path] : null })),
      runs,
      sessions: ui.sessions,
      root: state.scope === 'run' ? (activeRun() || {}).workspaceRoot || state.root : state.root,
      now: Date.now(),
    }) : {};

    const rows = [];
    for (const e of parsed) {
      if (e.status === 'ignored') continue;
      const prov = ownClaim(claims, e.path);
      const push = (band, stat) => {
        rows.push({
          path: e.path,
          oldPath: e.oldPath || null,
          status: e.status,
          staged: band === 'staged',
          band,
          side: sideFor(band),
          key: rowKey(band, e.path),
          adds: stat ? stat.adds : 0,
          dels: stat ? stat.dels : 0,
          binary: stat ? !!stat.binary : false,
          mtimeMs: typeof mtimes[e.path] === 'number' ? mtimes[e.path] : null,
          prov,
        });
      };
      if (state.scope === 'run') { push('run', unstagedStat.get(e.path) || stagedStat.get(e.path)); continue; }
      if (e.status === 'conflicted') { push('conflicts', unstagedStat.get(e.path)); continue; }
      if (e.status === 'untracked') { push('untracked', null); continue; }
      if (e.staged) push('staged', stagedStat.get(e.path));
      if (e.unstaged) push('changed', unstagedStat.get(e.path));
    }
    return rows;
  }

  const BAND_ORDER = ['conflicts', 'staged', 'changed', 'untracked', 'run'];

  function groupBands(rows) {
    const out = [];
    for (const kind of BAND_ORDER) {
      const inBand = rows.filter((r) => r.band === kind);
      if (inBand.length) out.push({ kind, rows: inBand });
    }
    return out;
  }

  function matches(row) {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return row.path.toLowerCase().indexOf(q) !== -1;
  }

  function visibleBands() {
    const out = [];
    for (const band of state.bands) {
      const rows = band.rows.filter(matches);
      if (rows.length) out.push({ kind: band.kind, rows });
    }
    return out;
  }

  function stagedRows() {
    return state.entries.filter((r) => r.band === 'staged');
  }

  async function loadHistory() {
    const api = git();
    if (!api || !state.root) return;
    const r = await api.log(state.root, { limit: 50, skip: 0 });
    if (!r || r.ok !== true) { ui.history = []; ui.historyMore = false; return; }
    const text = txt();
    ui.history = text && typeof text.parseLog === 'function' ? text.parseLog(r.records) : [];
    ui.historyMore = !!r.hasMore;
  }

  // ─── Painting ─────────────────────────────────────────────────────────────

  function paintStale() {
    const sub = byId('source-sub');
    const stats = byId('sc-ov-stats');
    const last = state.readAt ? 'last read ' + Dom.ago(state.readAt) : 'not read yet';
    for (const el of [sub, stats]) {
      if (!el) continue;
      el.classList.toggle('is-stale', state.stale);
      if (ui.readFailed) el.title = 'this read failed, ' + last;
      else if (state.stale) el.title = 'reading, ' + last;
      else if (state.readAt) el.title = 'read ' + Dom.ago(state.readAt);
    }
  }

  function paintAll() {
    paintHead();
    paintActs();
    paintList();
    paintMain();
    paintComposer();
    paintStale();
  }

  // The row the open file renders from is the one the last read holds. A commit
  // file has no working-tree row, so it renders from the descriptor it was
  // opened with, which is the only row that ever describes it.
  function openRow() {
    const model = state.diffModel;
    if (!model) return null;
    if (model.side === 'commit') return model.row || null;
    return state.entries.find((r) => r.key === model.key) || null;
  }

  // The open file is a projection of the last read too. When the row it was
  // opened from is not in the newest snapshot, the pane follows the row that
  // now holds that path, and closes when git holds no row for it at all.
  function reconcileDiffModel() {
    const model = state.diffModel;
    if (!model || model.side === 'commit') return;
    if (state.entries.some((r) => r.key === model.key)) return;
    const held = state.entries.filter((r) => r.path === model.rel)
      .sort((a, b) => BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band));
    if (!held.length) { closeFile(); return; }
    loadDiff(held[0], { keep: true });
  }

  // The three mutating file actions belong to the scope, not to the open file,
  // so they leave the document the moment the scope cannot accept them.
  function paintActs() {
    const model = state.diffModel;
    const row = openRow();
    const live = !!model && model.side !== 'commit' && !!row && canMutate();
    const staged = !!row && row.staged;
    presentRow(ui.actsHome, ui.acts.map((btn) => {
      let want = true;
      if (btn.id === 'sc-act-stage') want = live && !staged;
      if (btn.id === 'sc-act-unstage') want = live && staged;
      if (btn.id === 'sc-act-discard') want = live && !staged;
      return { el: btn, want };
    }));
  }

  // Presence rather than disabling: a control that would be refused is not on
  // the page at all, and a control that is wanted is both in the document and
  // visible. The wanted controls end in the order they are listed, and one
  // already in place is left where it is so a repaint keeps its focus.
  function presentRow(host, items) {
    if (!host) return;
    let placed = null;
    for (const item of items) {
      const el = item && item.el;
      if (!el) continue;
      if (!item.want) {
        el.hidden = true;
        if (el.parentNode) el.parentNode.removeChild(el);
        continue;
      }
      el.hidden = false;
      const at = placed ? placed.nextSibling : host.firstChild;
      if (el !== at) host.insertBefore(el, at);
      placed = el;
    }
  }

  function upstreamClause(repo) {
    if (!repo.upstream || typeof repo.ahead !== 'number') return '';
    // A count measured against the copy of the remote ref on this machine names
    // when that copy was taken, every time it is shown.
    const stamp = repo.hasFetched && repo.fetchedAtMs ? 'measured ' + Dom.ago(repo.fetchedAtMs) : 'never fetched';
    const counts = typeof repo.behind === 'number'
      ? repo.ahead + ' ahead, ' + repo.behind + ' behind ' + repo.upstream
      : repo.ahead + ' ahead of ' + repo.upstream;
    return counts + ', ' + stamp;
  }

  // A file that is both staged and changed is two rows and one change, so the
  // head counts paths and the bands count sides.
  function changedFiles() {
    return new Set(state.entries.map((r) => r.path)).size;
  }

  // What the list is showing, when the read that produced it stopped at its cap.
  function countClause(one, many) {
    const n = changedFiles();
    if (!ui.truncated) return count(n, one, many);
    return 'the first ' + count(n, one, many) + ', more are not listed';
  }

  // A failed read names the read the numbers on screen came from.
  function readClause() {
    if (!ui.readFailed) return '';
    return state.readAt ? 'last read ' + Dom.ago(state.readAt) : 'could not be read';
  }

  function subSentence() {
    const repo = state.repo;
    if (!state.root) return 'No folder is open.';
    if (!repo) {
      const failed = readClause();
      return tildify(state.root) + (failed ? ' · ' + failed : '');
    }
    if (repo.isRepo !== true) return tildify(state.root) + ' · not a git repository';

    if (state.scope === 'run') {
      const run = activeRun() || {};
      const bits = ['agent run ' + (state.runId || '')];
      if (repo.headShortSha) bits.push('based on ' + repo.headShortSha);
      bits.push(countClause('file', 'files'));
      if (run.endedAt) bits.push('ended ' + Dom.ago(Date.parse(run.endedAt)));
      const failed = readClause();
      if (failed) bits.push(failed);
      return bits.join(' · ');
    }

    const bits = [baseOf(repo.toplevel || state.root)];
    if (repo.unborn) {
      bits.push(repo.branch || 'main');
      bits.push('no commits yet');
    } else {
      bits.push(repo.branch || (repo.headShortSha ? 'detached at ' + repo.headShortSha : 'detached'));
      const up = upstreamClause(repo);
      if (up) bits.push(up);
    }
    if (repo.state && repo.state !== 'clean') bits.push(repo.state);
    bits.push(countClause('change', 'changes'));
    if (ui.fetchError) bits.push(ui.fetchError);
    const failed = readClause();
    if (failed) bits.push(failed);
    return bits.join(' · ');
  }

  function paintHead() {
    const sub = byId('source-sub');
    if (sub) sub.textContent = subSentence();

    const repo = state.repo;
    const isRepo = !!repo && repo.isRepo === true;
    const host = ui.headHome;

    const scopeLabel = byId('sc-scope-label');
    if (scopeLabel) {
      scopeLabel.textContent = state.scope === 'run'
        ? 'Run: ' + (state.runId || '')
        : 'Project: ' + baseOf(state.root || '');
    }
    const branchLabel = byId('sc-branch-label');
    if (branchLabel && repo) {
      branchLabel.textContent = repo.branch || repo.headShortSha || 'Branch';
    }

    // Canonical order is re-established every paint, so removing and restoring a
    // control never leaves the head shuffled.
    presentRow(host, ui.headBtns.map((btn) => {
      let want = true;
      if (btn.id === 'sc-branch') want = isRepo && state.scope === 'project';
      if (btn.id === 'sc-fetch') want = isRepo && !!repo.remoteUrl && state.scope === 'project';
      if (btn.id === 'sc-remote') want = isRepo && !!repo.webUrl;
      return { el: btn, want };
    }));
    const remote = byId('sc-remote');
    if (remote && repo && repo.webUrl) remote.title = 'Open ' + repo.webUrl;

    const refresh = byId('sc-refresh');
    if (refresh) {
      refresh.title = ui.watchTried && !ui.watching
        ? 'live updates are off for this folder, so this page re-reads when you focus the window'
        : 'Re-read this repository';
      refresh.dataset.live = ui.watching ? 'on' : 'off';
    }

    const tabChanges = byId('sc-tab-changes');
    const tabHistory = byId('sc-tab-history');
    if (tabChanges) {
      tabChanges.classList.toggle('is-active', state.tab === 'changes');
      tabChanges.setAttribute('aria-pressed', state.tab === 'changes' ? 'true' : 'false');
    }
    if (tabHistory) {
      tabHistory.classList.toggle('is-active', state.tab === 'history');
      tabHistory.setAttribute('aria-pressed', state.tab === 'history' ? 'true' : 'false');
    }
    const pill = byId('sc-changes-count');
    if (pill) {
      const n = changedFiles();
      pill.textContent = String(n);
      pill.hidden = n === 0;
    }
  }

  function bandActs(kind) {
    const acts = { onToggle: toggleBand };
    if (!canMutate()) return acts;
    if (kind === 'staged') acts.onUnstageAll = (k) => stagePaths(bandPaths(k), false);
    if (kind === 'changed' || kind === 'untracked') {
      acts.onStageAll = (k) => stagePaths(bandPaths(k), true);
      acts.onDiscardAll = (k) => discardRows(bandRows(k));
    }
    return acts;
  }

  // Bulk acts operate on what the band is showing, so a filter narrows them the
  // same way it narrows the list.
  function bandRows(kind) {
    const band = visibleBands().find((b) => b.kind === kind);
    return band ? band.rows : [];
  }

  function bandPaths(kind) {
    return bandRows(kind).map((r) => r.path);
  }

  function toggleBand(kind) {
    const list = byId('sc-list');
    const el = list ? list.querySelector('.sc-band[data-band="' + kind + '"]') : null;
    if (!el) return;
    el.classList.toggle('is-open');
    collapsed[kind] = !el.classList.contains('is-open');
    setCursor(null);
  }

  const collapsed = Object.create(null);

  function paintList() {
    const list = byId('sc-list');
    if (!list) return;
    const scrollTop = list.scrollTop;
    list.replaceChildren();

    if (state.tab === 'history') { paintHistoryList(list); list.scrollTop = scrollTop; return; }

    const repo = state.repo;
    if (!state.root) {
      list.appendChild(Dom.emptyEl('branch', 'No folder is open.', null, { compact: true }));
      return;
    }
    if (repo && repo.isRepo !== true) {
      list.appendChild(Dom.emptyEl('branch', [
        tildify(state.root) + ' is not a git repository.',
        'Source control turns on the moment this folder has one.',
      ], [
        { label: 'Initialize a repository here', primary: true, onClick: initRepo },
        { label: 'Open another folder', onClick: () => goPage('files') },
      ], { note: 'Initialize runs git init and nothing else. No commit, no remote.' }));
      return;
    }

    const bands = visibleBands();
    if (!bands.length) {
      if (state.query.trim()) {
        list.appendChild(Dom.emptyEl(null, 'No changed file matches "' + state.query.trim() + '".',
          { label: 'Clear filter', onClick: clearFilter }, { compact: true }));
      } else if (repo && repo.unborn) {
        list.appendChild(Dom.emptyEl('check', 'Nothing to commit. This repository has no commits yet.', null, { compact: true }));
      } else {
        const head = repo && repo.headShortSha ? repo.headShortSha : '';
        list.appendChild(Dom.emptyEl('check', [
          'Nothing to commit.',
          head ? 'The last commit was ' + head + ', ' + Dom.ago(repo.headAtMs) + '.' : '',
        ], { label: 'See recent commits', onClick: () => setTab('history') }, { compact: true }));
      }
      list.scrollTop = scrollTop;
      return;
    }

    if (state.scope === 'project' && !isProject(state.root)) {
      list.appendChild(Dom.emptyEl(null, 'This folder is not one of your projects, so Source is read-only here.',
        { label: 'Add it as a project', onClick: () => goPage('projects') }, { compact: true }));
    }

    // The cap belongs beside the rows it cut, and it names what the bulk acts
    // above it can reach.
    if (ui.truncated) {
      list.appendChild(Dom.emptyEl(null, '', null, {
        compact: true,
        note: 'This read stopped at the first ' + count(changedFiles(), 'file', 'files')
          + ', so the list is not the whole tree and a band action here acts on what is listed.',
      }));
    }

    for (const band of bands) {
      const el = Dom.bandEl(band.kind, band.rows.length, Object.assign(bandActs(band.kind), { open: !collapsed[band.kind] }));
      for (const row of band.rows) {
        el.appendChild(Dom.fileRowEl(row, {
          selected: state.selected.indexOf(row.key) !== -1,
          onOpen: (e) => openFile(row, e),
          onToggleStage: canMutate() ? () => stagePaths([row.path], !row.staged) : null,
        }));
      }
      list.appendChild(el);
    }
    list.scrollTop = scrollTop;
    restoreCursor();
  }

  function paintHistoryList(list) {
    if (!ui.history.length) {
      list.appendChild(Dom.emptyEl('clock', state.repo && state.repo.unborn
        ? 'No commits yet. The first commit will appear here.'
        : 'No commits to show.', null, { compact: true }));
      return;
    }
    // The band counts what it holds, so the filter narrows the count and the
    // rows together and an empty result says so.
    const q = state.query.trim().toLowerCase();
    const shown = q ? ui.history.filter((rec) => String(rec.subject || '').toLowerCase().indexOf(q) !== -1) : ui.history;
    if (!shown.length) {
      list.appendChild(Dom.emptyEl(null, 'No commit matches "' + state.query.trim() + '".',
        { label: 'Clear filter', onClick: clearFilter }, { compact: true }));
      return;
    }
    const band = Dom.bandEl('history', shown.length, { open: true });
    for (const rec of shown) {
      band.appendChild(Dom.commitRowEl(Object.assign({}, rec, { refs: refsLine(rec) }), {
        selected: !!ui.commit && ui.commit.record && ui.commit.record.sha === rec.sha,
        onOpen: () => openCommit(rec),
      }));
    }
    list.appendChild(band);
  }

  // ─── Right pane ───────────────────────────────────────────────────────────

  function showPane(which) {
    const ov = byId('sc-ov');
    const detail = byId('sc-detail');
    const commit = byId('sc-commit-detail');
    if (ov) ov.hidden = which !== 'ov';
    if (detail) detail.hidden = which !== 'detail';
    if (commit) commit.hidden = which !== 'commit';
  }

  function paintMain() {
    paintActs();
    if (state.diffModel) { showPane('detail'); paintDetail(); return; }
    if (ui.commit) { showPane('commit'); paintCommitDetail(); return; }
    showPane('ov');
    paintOverview();
  }

  function paintOverview() {
    const repo = state.repo;
    const stats = byId('sc-ov-stats');
    if (stats) {
      stats.replaceChildren();
      const adds = state.entries.reduce((n, r) => n + (r.adds || 0), 0);
      const dels = state.entries.reduce((n, r) => n + (r.dels || 0), 0);
      const files = changedFiles();
      // Three tiles counted off the same read, so a read that stopped at its cap
      // says so on all three.
      const capped = ui.truncated ? 'this read stopped at its cap, so more files are not counted' : '';
      for (const tile of [
        Dom.statTileEl(files, plural(files, 'file', 'files')),
        Dom.statTileEl(adds, 'added', 'add'),
        Dom.statTileEl(dels, 'removed', 'del'),
      ]) {
        if (capped) tile.title = capped;
        stats.appendChild(tile);
      }
      if (repo && typeof repo.ahead === 'number') {
        const tile = Dom.statTileEl(repo.ahead, 'ahead');
        tile.title = repo.hasFetched && repo.fetchedAtMs
          ? 'measured ' + Dom.ago(repo.fetchedAtMs)
          : 'never fetched';
        stats.appendChild(tile);
      }
    }

    const runsHost = byId('sc-ov-runs');
    if (runsHost) {
      runsHost.replaceChildren();
      const waiting = ui.runs.filter((r) => r && r.workspaceRoot && underRoot(r.workspaceRoot, projectRoot() || ''));
      // With no retained runs the card does not render at all, so a repository
      // with no agent activity has no agent-shaped hole in it.
      runsHost.hidden = waiting.length === 0 || state.scope === 'run';
      if (!runsHost.hidden) {
        const rows = waiting.map((run) => Dom.runRowEl({
          id: run.runId,
          goal: run.goal || run.subgoal || '',
          files: (run.changes || []).length,
          endedAt: run.endedAt ? Date.parse(run.endedAt) : null,
        }, {
          onReview: () => pivotToRun(run.runId),
          onDiscard: () => discardRun(run),
        }));
        runsHost.appendChild(Dom.ovCardEl('Awaiting review', rows, count(waiting.length, 'run', 'runs')));
      }
    }

    const branchHost = byId('sc-ov-branch');
    if (branchHost) {
      branchHost.replaceChildren();
      if (repo && repo.isRepo === true) branchHost.appendChild(branchCard(repo));
    }

    // Recent history, which every repository with a commit can fill. It takes
    // the space the other cards leave, so the pane reads as a panel rather than
    // as two cards above an empty half.
    const recentHost = byId('sc-ov-recent');
    if (recentHost) {
      recentHost.replaceChildren();
      const commits = ui.history.slice(0, 20);
      const show = !!(repo && repo.isRepo === true && !repo.unborn && commits.length);
      recentHost.hidden = !show;
      if (show) {
        const rows = commits.map((c) => Dom.commitRowEl(
          Object.assign({}, c, { refs: refsLine(c) }),
          { onOpen: () => openCommit(c) },
        ));
        const card = Dom.ovCardEl('Recent', rows, {
          label: 'Show all',
          onClick: () => setTab('history'),
        });
        card.classList.add('is-grow');
        recentHost.appendChild(card);
      }
    }
  }

  function branchCard(repo) {
    const rows = [];
    if (repo.unborn) {
      rows.push(Dom.emptyEl(null, 'No commits yet. Your first commit will start the history here.', null, { compact: true }));
      return Dom.ovCardEl('Branch', rows);
    }
    const line = repo.upstream
      ? upstreamClause(repo)
      : 'no remote. Add one from the terminal.';
    rows.push(Dom.runRowEl({ id: repo.branch || repo.headShortSha, goal: line }, {}));
    rows.push(Dom.commitRowEl({
      shortSha: repo.headShortSha || '',
      subject: repo.headSubject || '',
      author: repo.headAuthor || '',
      dateMs: repo.headAtMs,
    }, {}));
    const note = repo.remoteUrl && !repo.hasFetched
      ? 'Ahead and behind are counted against the copy of the remote ref on this machine. A behind count is not shown until a fetch has run.'
      : '';
    if (note) rows.push(Dom.emptyEl(null, '', null, { compact: true, note }));
    return Dom.ovCardEl('Branch', rows);
  }

  const BADGE_STATE = Object.freeze({
    added: 'success', deleted: 'error', conflicted: 'error',
    untracked: 'warning', renamed: 'muted', copied: 'muted',
    modified: 'muted', 'type-changed': 'muted',
  });

  function paintDetail() {
    const model = state.diffModel;
    if (!model) return;
    const row = openRow();

    const pathEl = byId('sc-dpath');
    if (pathEl) pathEl.textContent = model.rel;
    // The head element is already the stat box, so the builder's children move
    // into it rather than a second box nesting inside it.
    const stat = byId('sc-dstat');
    if (stat) {
      if (!row) stat.replaceChildren();
      else {
        const built = Dom.statEl(row.binary ? null : row.adds, row.binary ? null : row.dels);
        stat.replaceChildren(...built.childNodes);
      }
    }
    const badge = byId('sc-dbadge');
    if (badge) {
      const status = row ? row.status : '';
      badge.textContent = String(status).toUpperCase();
      badge.dataset.state = BADGE_STATE[status] || 'muted';
      badge.hidden = !row;
    }

    const wrap = byId('sc-act-wrap');
    if (wrap) {
      wrap.classList.toggle('is-on', !!model.wrap);
      wrap.setAttribute('aria-pressed', model.wrap ? 'true' : 'false');
    }

    const prov = byId('sc-prov');
    if (prov) {
      prov.replaceChildren();
      const band = row && row.prov ? Dom.provBandEl(row.prov) : null;
      prov.hidden = !band;
      if (band) prov.appendChild(band);
    }

    // The diff is rebuilt only when the parsed model or the wrap changes, so a
    // three-second re-read never throws away the scroll position or the cursor.
    if (ui.diffFiles !== model.files || ui.diffWrap !== model.wrap) {
      ui.diffFiles = model.files;
      ui.diffWrap = model.wrap;
      paintDiff(model, row);
    }

    const note = byId('sc-note');
    if (note) {
      note.textContent = model.note || '';
      note.hidden = !model.note;
    }
  }

  // The one file a diff model describes, chosen by the path the model names so
  // it stays the same file the main process builds a patch from. A rename
  // carries the old path on one side, so both are checked.
  function modelFile(model) {
    const files = (model && model.files) || [];
    if (!model || typeof model.rel !== 'string') return null;
    return files.find((f) => f && (f.newPath === model.rel || f.oldPath === model.rel)) || null;
  }

  function paintDiff(model, row) {
    const host = byId('sc-diff');
    if (!host) return;
    const wrapEl = byId('sc-diff-wrap');
    const top = wrapEl ? wrapEl.scrollTop : 0;
    host.replaceChildren();
    host.dataset.wrap = model.wrap ? 'on' : 'off';

    if (model.tooLarge) {
      host.appendChild(Dom.tooBigEl({
        lines: model.tooLarge,
        onStageAll: canMutate() && row && !row.staged ? () => stagePaths([model.rel], true) : null,
        onOpen: () => openInFiles(model.rel),
      }));
      return;
    }

    const file = modelFile(model);
    if (!file) {
      host.appendChild(Dom.emptyEl(null, 'There is nothing to show for this file.', null, { compact: true }));
      return;
    }
    if (file.isBinary) {
      host.appendChild(Dom.binaryEl());
      return;
    }
    if (!file.hunks || !file.hunks.length) {
      host.appendChild(Dom.emptyEl(null, 'No differences in this file on this side.', null, { compact: true }));
      return;
    }

    const lang = langFor(model.rel);
    // A file git has no earlier version of is marked once, above its hunks.
    if (row && (row.status === 'added' || row.status === 'untracked')) host.appendChild(Dom.newFileEl());
    let prev = null;
    for (let i = 0; i < file.hunks.length; i++) {
      const hunk = file.hunks[i];
      const gap = prev ? hunk.oldStart - (prev.oldStart + prev.oldLines) : hunk.oldStart - 1;
      const opener = Dom.expandRowEl('up', gap, expandContext);
      if (opener) host.appendChild(opener);
      host.appendChild(Dom.hunkBandEl(hunk, {
        index: i,
        onStage: canMutate() && model.side === 'worktree' ? (idx) => hunkAct(idx, 'stage') : null,
        onUnstage: canMutate() && model.side === 'index' ? (idx) => hunkAct(idx, 'unstage') : null,
        onDiscard: canMutate() && model.side === 'worktree' ? (idx) => discardHunk(idx) : null,
      }));
      for (const line of hunk.lines) host.appendChild(Dom.lineEl(line, { lang }));
      prev = hunk;
    }
    if (wrapEl) wrapEl.scrollTop = top;
    restoreCursor();
  }

  function paintCommitDetail() {
    const host = byId('sc-commit-detail');
    if (!host || !ui.commit) return;
    host.replaceChildren();
    const rec = ui.commit.record;
    const rows = [
      Dom.runRowEl({ id: rec.shortSha, goal: rec.subject, endedAt: rec.dateMs }, {}),
      Dom.runRowEl({ id: rec.author, goal: rec.body ? rec.body.trim() : '' }, {}),
    ];
    host.appendChild(Dom.ovCardEl('Commit', rows, refsLine(rec)));

    const fileRows = (ui.commit.files || []).map((f) => Dom.fileRowEl({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status === 'R' ? 'renamed' : 'modified',
      adds: f.adds,
      dels: f.dels,
    }, {
      onOpen: () => openCommitFile(rec.sha, f.path),
    }));
    host.appendChild(Dom.ovCardEl('Files', fileRows, count(fileRows.length, 'file', 'files')));
  }

  // ─── Composer ─────────────────────────────────────────────────────────────

  // Inside a run's worktree the composer is replaced, not disabled: the work
  // leaves through Apply or it is discarded, and neither is a commit.
  function paintApplySheet() {
    if (ui.applySheet && ui.applySheet.parentNode) ui.applySheet.parentNode.removeChild(ui.applySheet);
    ui.applySheet = null;
    if (state.scope !== 'run' || !ui.composerHome) return;
    const run = activeRun();
    if (!run) return;
    const files = (run.changes || []).length;
    ui.applySheet = Dom.emptyEl(null, 'Apply this run', [
      { label: 'Apply all ' + files, primary: true, onClick: applyRun },
      { label: 'Discard the run', danger: true, onClick: () => discardRun(run) },
    ], {
      compact: true,
      note: 'Staging and committing are not offered inside a run\'s worktree. Take the run through Apply, or discard it.',
    });
    ui.composerHome.appendChild(ui.applySheet);
  }

  function paintComposer() {
    paintApplySheet();
    const composer = ui.composer;
    if (!composer || !ui.composerHome) return;
    const want = canMutate() && !!state.repo && state.repo.isRepo === true;
    if (!want) {
      if (composer.parentNode) composer.parentNode.removeChild(composer);
      return;
    }
    if (!composer.parentNode) ui.composerHome.appendChild(composer);

    const subject = byId('sc-subject');
    const counter = byId('sc-subject-count');
    const amend = byId('sc-amend');
    const amendLabel = byId('sc-amend-label');
    const btn = byId('sc-commit');
    const warn = byId('sc-composer-warn');
    const staged = stagedRows();
    const isAmend = !!amend && amend.checked;

    if (counter && subject) {
      const n = subject.value.length;
      counter.hidden = n <= 50;
      counter.textContent = String(n);
      counter.dataset.state = n > 72 ? 'warning' : '';
    }
    if (amendLabel) {
      amendLabel.textContent = state.repo && state.repo.headShortSha
        ? 'Amend ' + state.repo.headShortSha
        : 'Amend';
    }
    if (amend) amend.disabled = !state.repo || state.repo.unborn === true;

    if (btn) {
      const hasSubject = !!subject && subject.value.trim().length > 0;
      if (isAmend) {
        btn.textContent = 'Amend ' + ((state.repo && state.repo.headShortSha) || '');
        btn.disabled = !hasSubject;
      } else if (!staged.length) {
        btn.textContent = 'Stage something to commit';
        btn.disabled = true;
      } else {
        btn.textContent = 'Commit ' + count(staged.length, 'staged file', 'staged files');
        btn.disabled = !hasSubject;
      }
    }

    if (warn) {
      const lines = [];
      // The review note counts staged files whose mtime moved after a session
      // this machine can see started. It is a nudge, never a gate.
      const recent = staged.filter((r) => r.prov && r.prov.tier !== 'none').length;
      if (recent > 0) {
        lines.push(recent + ' of ' + count(staged.length, 'staged file', 'staged files')
          + ' changed after this chat started. Read the diffs before this becomes a commit.');
      }
      if (isAmend && ui.amendPublished && state.repo) {
        lines.push(state.repo.headShortSha + ' is already on ' + (state.repo.upstream || 'its upstream branch')
          + '. Amending it needs a force push, which Husk does not do.');
      }
      warn.textContent = lines.join(' ');
      warn.hidden = lines.length === 0;
    }
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  // A mutating call pauses the poll, then re-reads. Nothing on screen moves
  // until that read lands, so a row can never show a state git has not confirmed.
  async function mutate(run) {
    if (ui.mutating) return null;
    ui.mutating = true;
    try {
      return await run();
    } finally {
      ui.mutating = false;
      await readAll();
    }
  }

  function refuse(res, fallback) {
    const msg = res && res.error ? res.error : fallback;
    say(msg, 'error');
  }

  async function stagePaths(paths, on) {
    const api = git();
    if (!api || !paths.length || !canMutate()) return;
    await mutate(async () => {
      const res = on ? await api.stage(state.root, paths) : await api.unstage(state.root, paths);
      if (!res || res.ok !== true) refuse(res, on ? 'could not stage those files' : 'could not unstage those files');
      return res;
    });
  }

  async function hunkAct(index, action) {
    const api = git();
    const model = state.diffModel;
    if (!api || !model || !canMutate()) return;
    await mutate(async () => {
      const res = await api.hunk(state.root, {
        rel: model.rel, side: model.side, hunkIndex: index, action, context: model.context,
      });
      if (!res || res.ok !== true) {
        if (res && res.code === 'stale-diff') say('This diff moved since it was read, so the pane re-read it', 'warn');
        else refuse(res, 'could not apply that hunk');
      }
      return res;
    });
    if (state.diffModel) await loadDiff(state.diffModel.row, { keep: true });
  }

  async function discardHunk(index) {
    const model = state.diffModel;
    if (!model || !canMutate()) return;
    const target = modelFile(model);
    const hunk = target && target.hunks[index];
    if (!hunk) return;
    const start = hunk.newLines > 0 ? hunk.newStart : hunk.oldStart;
    const ok = await confirmAct({
      title: 'Discard this hunk?',
      bodyHtml: '<p>The hunk at line ' + start + ' in <strong>' + esc(model.rel) + '</strong> goes to a stash you can restore.</p>'
        + '<p>It is ' + esc(hunkStat(hunk)) + '.</p>',
      confirmLabel: 'Discard this hunk',
    });
    if (!ok) return;
    const api = git();
    await mutate(async () => {
      const res = await api.hunk(state.root, {
        rel: model.rel, side: model.side, hunkIndex: index, action: 'discard', context: model.context, confirm: true,
      });
      if (!res || res.ok !== true) refuse(res, 'could not discard that hunk');
      else say('Hunk set aside in a stash', 'success');
      return res;
    });
    if (state.diffModel) await loadDiff(state.diffModel.row, { keep: true });
  }

  function hunkStat(hunk) {
    let adds = 0;
    let dels = 0;
    for (const l of hunk.lines) {
      if (l.kind === 'add') adds++;
      else if (l.kind === 'del') dels++;
    }
    return '+' + adds + ' -' + dels + ' ' + plural(adds + dels, 'line', 'lines');
  }

  // Tracked changes go to a stash the Undo binds to; untracked files go to the
  // OS trash. The two are different acts, so each is its own named call.
  async function discardRows(rows) {
    if (!rows || !rows.length || !canMutate()) return;
    const api = git();
    const tracked = rows.filter((r) => r.status !== 'untracked').map((r) => r.path);
    const untracked = rows.filter((r) => r.status === 'untracked').map((r) => r.path);
    const uniqueTracked = [...new Set(tracked)];
    const uniqueUntracked = [...new Set(untracked)];
    const total = uniqueTracked.length + uniqueUntracked.length;
    if (!total) return;

    const adds = rows.reduce((n, r) => n + (r.adds || 0), 0);
    const dels = rows.reduce((n, r) => n + (r.dels || 0), 0);
    const shown = [...uniqueTracked, ...uniqueUntracked].slice(0, 5);
    const rest = total - shown.length;

    const what = [];
    if (uniqueTracked.length) {
      what.push(count(uniqueTracked.length, 'tracked file', 'tracked files')
        + plural(uniqueTracked.length, ' goes', ' go') + ' to a stash you can restore');
    }
    if (uniqueUntracked.length) {
      what.push(count(uniqueUntracked.length, 'untracked file', 'untracked files')
        + plural(uniqueUntracked.length, ' goes', ' go') + ' to the trash, where the desktop can recover it');
    }

    // A stash takes both sides of a path, so a discard that lands on one side
    // names the version on the other side that goes in with it.
    const alsoTaken = state.entries.filter((r) => r.band !== 'untracked'
      && uniqueTracked.indexOf(r.path) !== -1 && rows.indexOf(r) === -1);
    const alsoPaths = [...new Set(alsoTaken.map((r) => r.path))];
    const alsoAdds = alsoTaken.reduce((n, r) => n + (r.adds || 0), 0);
    const alsoDels = alsoTaken.reduce((n, r) => n + (r.dels || 0), 0);
    const alsoHtml = alsoPaths.length
      ? '<p>' + count(alsoPaths.length, 'file', 'files') + ' here also '
        + plural(alsoPaths.length, 'has', 'have') + ' a version on the other side, and the same stash takes '
        + plural(alsoPaths.length, 'it', 'them') + ' too. That is +' + alsoAdds + ' -' + alsoDels + ' more '
        + plural(alsoAdds + alsoDels, 'line', 'lines') + '.</p>'
      : '';

    const ok = await confirmAct({
      title: 'Discard ' + count(total, 'file', 'files') + '?',
      bodyHtml: '<p>' + esc(what.join(', and ')) + '.</p>'
        + '<p>That is +' + adds + ' -' + dels + ' ' + plural(adds + dels, 'line', 'lines') + '.</p>'
        + alsoHtml
        + '<p>' + shown.map((p) => esc(p)).join('<br>') + (rest > 0 ? '<br>and ' + rest + ' more' : '') + '</p>',
      confirmLabel: 'Discard ' + count(total, 'file', 'files'),
    });
    if (!ok) return;

    let stashRef = null;
    let trashed = 0;
    await mutate(async () => {
      if (uniqueTracked.length) {
        const res = await api.discard(state.root, { paths: uniqueTracked, mode: 'tracked', confirm: true });
        if (!res || res.ok !== true) { refuse(res, 'could not discard those changes'); return res; }
        stashRef = res.stashRef || null;
      }
      if (uniqueUntracked.length) {
        const res = await api.discard(state.root, { paths: uniqueUntracked, mode: 'untracked', confirm: true });
        if (!res || res.ok !== true) { refuse(res, 'could not move those files to the trash'); return res; }
        trashed = res.trashed || 0;
        for (const f of (res.failed || [])) say(baseOf(f.path) + ': ' + f.reason, 'error');
      }
      return null;
    });

    const parts = [];
    if (stashRef) parts.push(count(uniqueTracked.length, 'file', 'files') + ' set aside in stash ' + stashRef);
    if (trashed) parts.push(count(trashed, 'file', 'files') + ' moved to the trash');
    if (!parts.length) return;
    // Undo binds to the exact stash this discard made, so it restores what was
    // taken rather than whatever now sits on top of the stack.
    if (stashRef) sayWith(parts.join(' · '), 'Undo', () => popStash(stashRef), 'success');
    else say(parts.join(' · '), 'success');
  }

  async function popStash(ref) {
    const api = git();
    if (!api || !ref) return;
    await mutate(async () => {
      const res = await api.stashPop(state.root, ref);
      if (!res || res.ok !== true) refuse(res, 'could not restore that stash');
      else say('Restored from stash ' + ref, 'success');
      return res;
    });
  }

  async function commit(opts) {
    const api = git();
    const subject = byId('sc-subject');
    const body = byId('sc-body');
    const amend = byId('sc-amend');
    if (!api || !subject || !canMutate()) return;
    const subjectText = subject.value.trim();
    if (!subjectText) {
      say('A commit needs a subject', 'error');
      subject.focus();
      return;
    }
    const payload = {
      subject: subjectText,
      body: body ? body.value : '',
      amend: !!(amend && amend.checked),
      confirmedPublished: !!(opts && opts.confirmedPublished),
    };
    const res = await mutate(async () => api.commit(state.root, payload));
    if (!res) return;
    if (res.ok === true) {
      subject.value = '';
      if (body) { body.value = ''; growBody(); }
      if (amend) amend.checked = false;
      ui.amendPublished = false;
      say('Committed ' + res.shortSha + ' ' + res.subject, 'success');
      paintComposer();
      return;
    }
    if (res.code === 'amend-published') {
      ui.amendPublished = true;
      paintComposer();
      const ok = await confirmAct({
        title: 'Amend a published commit?',
        bodyHtml: '<p><strong>' + esc(state.repo.headShortSha || '') + '</strong> is already on '
          + esc(state.repo.upstream || 'its upstream branch') + '.</p>'
          + '<p>Amending it rewrites a commit the remote already has. Landing that needs a force push, which Husk does not do.</p>',
        confirmLabel: 'Amend it anyway',
      });
      if (ok) await commit({ confirmedPublished: true });
      return;
    }
    refuse(res, 'could not create the commit');
  }

  // The clause and the stamp it was measured against are one fact.
  function clearFetchError() {
    ui.fetchError = '';
    ui.fetchErrorAt = 0;
  }

  async function fetchRemote() {
    const api = git();
    if (!api || !state.repo || !state.repo.remoteUrl) return;
    const btn = byId('sc-fetch');
    if (btn) btn.disabled = true;
    state.stale = true;
    paintStale();
    let res = null;
    try { res = await api.fetch(state.root, null); } catch (_) { res = null; }
    if (btn) btn.disabled = false;
    state.stale = false;
    if (!res || res.ok !== true) {
      // The counts keep their previous values and their previous stamp.
      const name = state.repo.upstream ? state.repo.upstream.split('/')[0] : 'the remote';
      ui.fetchError = 'could not reach ' + name;
      // The clause belongs to the copy of the remote ref this failure was
      // measured against, so a later fetch retires it.
      ui.fetchErrorAt = typeof state.repo.fetchedAtMs === 'number' ? state.repo.fetchedAtMs : 0;
      paintHead();
      paintStale();
      if (res && res.code === 'auth-required') {
        sayWith('This remote needs credentials Husk does not hold', 'Type the command', () => typeFetchCommand(), 'error');
      } else {
        refuse(res, 'could not fetch');
      }
      return;
    }
    clearFetchError();
    await readAll();
  }

  // A path reaches the shell as one word, whatever characters are in it.
  function shQuote(p) {
    return "'" + String(p === null || p === undefined ? '' : p).replace(/'/g, "'\\''") + "'";
  }

  // Husk hands the command over rather than pretending it can authenticate.
  function typeFetchCommand() {
    const pty = window.husk && window.husk.pty;
    if (!pty || typeof pty.write !== 'function' || !state.root) return;
    goPage('chat');
    pty.write('git -C ' + shQuote(state.root) + ' fetch --prune --no-tags origin');
  }

  async function openRemote() {
    const api = git();
    if (!api) return;
    const model = state.diffModel;
    const opts = model && state.repo && state.repo.branch
      ? { kind: 'file', ref: state.repo.branch, rel: model.rel, line: 0 }
      : { kind: 'repo' };
    const res = await api.openRemote(state.root, opts);
    if (!res || res.ok !== true) { refuse(res, 'Husk cannot turn that remote into a web address'); return; }
    let url = null;
    try { url = new URL(res.url); } catch (_) { url = null; }
    if (!url || url.protocol !== 'https:') { say('That remote does not resolve to an https address', 'error'); return; }
    if (window.husk && window.husk.urls) window.husk.urls.openExternal(res.url);
  }

  async function initRepo() {
    const api = git();
    if (!api || !state.root) return;
    const ok = await confirmAct({
      title: 'Initialize a repository?',
      bodyHtml: '<p>This runs <code>git init</code> in <strong>' + esc(state.root) + '</strong>.</p>'
        + '<p>No commit is made and no remote is added.</p>',
      confirmLabel: 'Initialize a repository',
    });
    if (!ok) return;
    const res = await mutate(async () => api.init(state.root, true));
    if (!res || res.ok !== true) refuse(res, 'could not initialize a repository here');
    else say('Initialized a repository in ' + tildify(res.toplevel), 'success');
  }

  async function switchBranch(name) {
    const api = git();
    if (!api || !canMutate()) return;
    closePop();
    const res = await mutate(async () => api.switch(state.root, name));
    if (!res) return;
    if (res.ok === true) { say('Switched to ' + res.branch, 'success'); return; }
    if (res.code === 'checked-out-elsewhere') { say(res.error + ' (' + res.detail + ')', 'error'); return; }
    if (res.code === 'would-overwrite') {
      const files = (res.conflicts || []).slice(0, 5);
      say('Switching would overwrite changes in ' + (files.length ? files.join(', ') : 'the working tree'), 'error');
      return;
    }
    refuse(res, 'could not switch branches');
  }

  // The refusals src/lib/git-ref.js makes, run as the field is typed. Main runs
  // them again on the way to git; these exist so the row can say why before a
  // name is ever sent.
  const BRANCH_BAD_CHARS = /[ ~^?*[\\]/;
  const BRANCH_HEX = /^[0-9a-fA-F]{7,64}$/;

  function byteLength(v) {
    try { return new TextEncoder().encode(v).length; } catch (_) { return v.length; }
  }

  function hasControl(v) {
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) return true;
    }
    return false;
  }

  // A reason the name cannot be a branch, or null when it can.
  function branchNameRefusal(name) {
    const v = typeof name === 'string' ? name : '';
    if (!v) return 'must not be empty';
    if (byteLength(v) > 255) return 'is longer than 255 bytes';
    if (hasControl(v)) return 'contains a control character';
    if (v.charCodeAt(0) === 0x2d) return 'starts with a dash, which git reads as an option';
    if (v === '@') return 'is a bare at sign, which git reads as a position';
    if (v.indexOf('@{') !== -1) return 'contains a reflog expression';
    if (v.indexOf('..') !== -1) return 'contains a range expression';
    if (v.indexOf(':') !== -1) return 'contains a colon';
    if (v.indexOf('//') !== -1) return 'contains an empty path part';
    if (v.charAt(0) === '/' || v.charAt(v.length - 1) === '/') return 'starts or ends with a slash';
    if (v.charAt(0) === '.' || v.charAt(v.length - 1) === '.') return 'starts or ends with a dot';
    if (/\.lock$/.test(v)) return 'ends with a suffix git reserves';
    if (BRANCH_BAD_CHARS.test(v)) return 'contains a character git does not allow in a name';
    if (v === 'HEAD') return 'is a position, not a branch name';
    if (BRANCH_HEX.test(v)) return 'is a commit id, not a branch name';
    return null;
  }

  function setNewMessage(row, text) {
    if (!row) return;
    const line = text || '';
    if (typeof row.setMessage === 'function') row.setMessage(line);
    row.classList.toggle('is-invalid', !!line);
  }

  async function createBranch(row, name) {
    const api = git();
    const v = typeof name === 'string' ? name.trim() : '';
    if (!api || !canMutate()) return;
    const reason = branchNameRefusal(v);
    if (reason) { setNewMessage(row, 'That name ' + reason + '.'); return; }
    setNewMessage(row, '');
    const res = await mutate(async () => api.createBranch(state.root, v, 'HEAD', false));
    if (!res) return;
    if (res.ok !== true) { setNewMessage(row, res.error || 'could not create that branch'); return; }
    say('Created ' + res.name + (res.sha ? ' at ' + res.sha : ''), 'success');
    if (ui.popKind === 'branch') await paintBranchPop();
  }

  // Deleting is two calls at most. The first is git's own -d, and force is a
  // second call behind a second confirmation that names the commits going with
  // the branch.
  async function deleteBranch(b) {
    const api = git();
    const name = b && typeof b.name === 'string' ? b.name : '';
    if (!api || !name || !canMutate()) return;

    const ok = await confirmAct({
      title: 'Delete branch ' + name + '?',
      bodyHtml: '<p>This deletes the local branch <strong>' + esc(name) + '</strong>'
        + (b.sha ? ' at <strong>' + esc(b.sha) + '</strong>' : '') + '.</p>'
        + (b.subject ? '<p>Its last commit is ' + esc(b.subject) + '.</p>' : '')
        + '<p>The working tree does not change and the branch on the remote is left alone. '
        + 'Git refuses this while the branch holds commits no other branch has.</p>',
      confirmLabel: 'Delete ' + name,
    });
    if (!ok) return;

    const res = await mutate(async () => api.deleteBranch(state.root, { branch: name, confirm: true }));
    if (!res) return;
    if (res.ok === true) {
      say('Deleted ' + res.branch, 'success');
      if (ui.popKind === 'branch') await paintBranchPop();
      return;
    }
    if (res.code !== 'unmerged' || !b.sha) { refuse(res, 'could not delete that branch'); return; }

    const commits = Array.isArray(res.unmerged) ? res.unmerged : [];
    const shown = commits.slice(0, 5);
    const rest = commits.length - shown.length;
    const more = rest > 0
      ? '<br>' + (commits.length >= 20 ? 'and at least ' + rest + ' more' : 'and ' + rest + ' more')
      : '';
    const forced = await confirmAct({
      title: 'Delete ' + name + ' and its commits?',
      bodyHtml: '<p><strong>' + esc(name) + '</strong> has commits no other branch holds. '
        + 'Deleting it is how those commits are lost, and Husk cannot bring them back.</p>'
        + '<p>' + shown.map((c) => esc(String(c.shortSha || '') + ' ' + String(c.subject || ''))).join('<br>') + more + '</p>',
      confirmLabel: 'Delete ' + name + ' and its commits',
    });
    if (!forced) return;

    const res2 = await mutate(async () => api.deleteBranch(state.root, {
      branch: name, force: true, expectSha: b.sha, confirm: true,
    }));
    if (!res2) return;
    if (res2.ok !== true) { refuse(res2, 'could not delete that branch'); return; }
    say('Deleted ' + res2.branch, 'success');
    if (ui.popKind === 'branch') await paintBranchPop();
  }

  async function discardRun(run) {
    const husk = window.husk || {};
    if (!husk.autopilot || typeof husk.autopilot.discardRun !== 'function') return;
    const files = (run.changes || []).length;
    const ok = await confirmAct({
      title: 'Discard run ' + run.runId + '?',
      bodyHtml: '<p>This removes the run worktree and the ' + count(files, 'file', 'files') + ' in it.</p>'
        + (run.goal ? '<p>Goal: ' + esc(run.goal) + '</p>' : ''),
      confirmLabel: 'Discard ' + count(files, 'file', 'files'),
    });
    if (!ok) return;
    const res = await husk.autopilot.discardRun({ runId: run.runId });
    if (!res || res.ok !== true) { refuse(res, 'could not discard that run'); return; }
    if (state.runId === run.runId) { state.scope = 'project'; state.runId = null; }
    say('Discarded run ' + run.runId, 'success');
    await readAll();
  }

  async function applyRun() {
    const husk = window.husk || {};
    const run = activeRun();
    if (!run || !husk.autopilot || typeof husk.autopilot.applyRun !== 'function') return;
    const files = (run.changes || []).length;
    const ok = await confirmAct({
      title: 'Apply run ' + run.runId + '?',
      bodyHtml: '<p>This copies ' + count(files, 'file', 'files') + ' from the run worktree into '
        + esc(baseOf(run.workspaceRoot || '')) + '.</p>'
        + '<p>Each of those files is replaced by the run\'s version of it, whatever the project holds now. '
        + 'The run worktree is removed afterwards.</p>',
      confirmLabel: 'Apply ' + count(files, 'file', 'files'),
    });
    if (!ok) return;
    const res = await husk.autopilot.applyRun({ runId: run.runId });
    if (!res || res.ok !== true) { refuse(res, 'could not apply that run'); return; }
    state.scope = 'project';
    state.runId = null;
    say('Applied run ' + run.runId, 'success');
    await readAll();
  }

  // ─── Selection and the diff ───────────────────────────────────────────────

  function openInFiles(rel) {
    goPage('files');
    if (typeof window.fxOpenFile === 'function') window.fxOpenFile(rel, '');
  }

  async function openFile(row, ev) {
    if (ev && ev.shiftKey) { extendTo(row); return; }
    state.selected = [row.key];
    ui.anchor = flatRows().findIndex((r) => r.key === row.key);
    ui.commit = null;
    await loadDiff(row, {});
  }

  function flatRows() {
    const out = [];
    for (const band of visibleBands()) {
      if (collapsed[band.kind]) continue;
      for (const row of band.rows) out.push(row);
    }
    return out;
  }

  function extendTo(row) {
    const rows = flatRows();
    const to = rows.findIndex((r) => r.key === row.key);
    if (to === -1) return;
    const from = ui.anchor >= 0 ? ui.anchor : to;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    state.selected = rows.slice(lo, hi + 1).map((r) => r.key);
    paintList();
  }

  async function loadDiff(row, opts) {
    const api = git();
    if (!api || !row) return;
    const keep = !!(opts && opts.keep);
    const context = keep && state.diffModel ? state.diffModel.context : 3;
    const wrap = keep && state.diffModel ? state.diffModel.wrap : false;
    const res = await api.diff(state.root, { rel: row.path, side: row.side, context });
    const model = {
      rel: row.path,
      key: row.key,
      row,
      side: row.side,
      context,
      wrap,
      files: [],
      tooLarge: 0,
      note: '',
    };
    if (!res || res.ok !== true) {
      if (res && res.error === 'diff too large') model.tooLarge = res.lines || 0;
      else model.note = 'Husk could not read this diff.';
    } else {
      const api2 = txt();
      const parsed = api2 && typeof api2.parseDiff === 'function' ? api2.parseDiff(res.diff) : { files: [] };
      model.files = parsed.files || [];
      model.context = res.context;
    }
    if (row.status === 'deleted') model.note = 'This file was deleted. Staging the deletion records the removal.';
    else if (row.band === 'staged' && !state.entries.some((r) => r.path === row.path && r.band === 'changed')) {
      model.note = 'Every change in this file is staged.';
    }
    state.diffModel = model;
    state.cursor = { pane: 'list', index: state.cursor.index };
    paintMain();
  }

  // -U is symmetric, so more context is read for the whole file rather than for
  // one gap. The pane re-reads from git instead of guessing at the missing lines.
  async function expandContext(dir, n) {
    const model = state.diffModel;
    if (!model) return;
    const grow = n === null ? 2000 : Math.min(200, Math.max(1, n));
    model.context = Math.min(2000, model.context + grow);
    const api = git();
    const res = await api.diff(state.root, { rel: model.rel, side: model.side, context: model.context });
    if (res && res.ok === true) {
      const api2 = txt();
      const parsed = api2 && typeof api2.parseDiff === 'function' ? api2.parseDiff(res.diff) : { files: [] };
      model.files = parsed.files || [];
      model.context = res.context;
    }
    paintMain();
  }

  async function openCommit(rec) {
    const api = git();
    if (!api) return;
    state.diffModel = null;
    const res = await api.show(state.root, rec.sha);
    const text = txt();
    const shown = res && res.ok === true && text && typeof text.parseLog === 'function'
      ? text.parseLog(res.record)
      : [];
    ui.commit = res && res.ok === true
      ? { record: shown[0] || rec, files: res.files || [] }
      : { record: rec, files: [] };
    paintList();
    paintMain();
  }

  async function openCommitFile(sha, rel) {
    const api = git();
    if (!api) return;
    const res = await api.diff(state.root, { rel, side: 'commit', sha, context: 3 });
    const model = {
      rel, key: 'commit:' + rel, row: { path: rel, status: 'modified', band: 'commit', side: 'commit', adds: 0, dels: 0 },
      side: 'commit', context: 3, wrap: false, files: [], tooLarge: 0, note: '',
    };
    if (res && res.ok === true) {
      const api2 = txt();
      const parsed = api2 && typeof api2.parseDiff === 'function' ? api2.parseDiff(res.diff) : { files: [] };
      model.files = parsed.files || [];
    } else if (res && res.error === 'diff too large') {
      model.tooLarge = res.lines || 0;
    }
    state.diffModel = model;
    paintMain();
  }

  function closeFile() {
    state.diffModel = null;
    ui.commit = null;
    state.cursor = { pane: 'list', index: state.cursor.index };
    paintMain();
  }

  function setTab(tab) {
    state.tab = tab;
    state.diffModel = null;
    ui.commit = null;
    state.cursor = { pane: 'list', index: -1 };
    if (tab === 'history' && !ui.history.length) { loadHistory().then(paintAll); return; }
    paintAll();
  }

  function clearFilter() {
    const search = byId('sc-search');
    if (search) search.value = '';
    state.query = '';
    paintList();
  }

  // ─── Scope and branch popovers ────────────────────────────────────────────

  // The popover is rebuilt on every open. Its footer is the element the markup
  // declares, so it is held and put back rather than made again.
  function clearPop() {
    const pop = byId('sc-branch-pop');
    if (!pop) return null;
    pop.replaceChildren();
    if (ui.popFoot) ui.popFoot.replaceChildren();
    return pop;
  }

  function closePop() {
    const pop = clearPop();
    if (pop) pop.hidden = true;
    ui.popKind = '';
    const scope = byId('sc-scope');
    const branch = byId('sc-branch');
    if (scope) scope.setAttribute('aria-expanded', 'false');
    if (branch) branch.setAttribute('aria-expanded', 'false');
  }

  function placePop(anchor) {
    const pop = byId('sc-branch-pop');
    const page = anchor.closest('.page');
    if (!pop || !page) return;
    const a = anchor.getBoundingClientRect();
    const p = page.getBoundingClientRect();
    pop.style.top = (a.bottom - p.top + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(a.left - p.left, p.width - 300)) + 'px';
  }

  // The scope rows reuse the branch row builder: same shape, same keyboard, and
  // one popover element for both lists.
  function openScopePop() {
    const pop = byId('sc-branch-pop');
    const anchor = byId('sc-scope');
    if (!pop || !anchor) return;
    if (ui.popKind === 'scope') { closePop(); return; }
    closePop();
    pop.setAttribute('aria-label', 'Scope');
    clearPop();
    const root = projectRoot();
    pop.appendChild(Dom.branchRowEl({
      name: 'Project: ' + baseOf(root || ''),
      isHead: state.scope === 'project',
      subject: root || '',
    }, { onPick: () => { closePop(); pivotToProject(); } }));
    const waiting = ui.runs.filter((r) => r && r.workspaceRoot && underRoot(r.workspaceRoot, root || ''));
    for (const run of waiting) {
      pop.appendChild(Dom.branchRowEl({
        name: 'Run: ' + run.runId,
        isHead: state.scope === 'run' && state.runId === run.runId,
        dateMs: run.endedAt ? Date.parse(run.endedAt) : null,
        subject: run.goal || '',
      }, { onPick: () => { closePop(); pivotToRun(run.runId); } }));
    }
    pop.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    ui.popKind = 'scope';
    placePop(anchor);
  }

  // The create row validates as it is typed and refuses on the row, so a name
  // git would reject never becomes a call.
  function wireBranchNew(row) {
    const input = row.querySelector('#sc-branch-new');
    const go = row.querySelector('#sc-branch-new-go');
    if (!input) return;
    const sync = () => {
      const v = input.value.trim();
      const reason = v ? branchNameRefusal(v) : null;
      setNewMessage(row, reason ? 'That name ' + reason + '.' : '');
      if (go) go.disabled = !v || !!reason;
    };
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Escape') return;
      closePop();
      const anchor = byId('sc-branch');
      if (anchor) anchor.focus();
    });
    sync();
  }

  // Every branch list is painted from a fresh read, including the one after a
  // create or a delete, so the rows are what git holds rather than what was
  // just asked for.
  async function paintBranchPop() {
    const pop = byId('sc-branch-pop');
    const api = git();
    if (!pop || !api || !state.root) return false;
    const res = await api.branches(state.root);
    if (!res || res.ok !== true) { refuse(res, 'could not read the branches'); return false; }
    ui.branches = res;
    clearPop();

    const mutable = canMutate();
    // The freshness contract reaches the popover too: a row states when its
    // ahead and behind counts were measured, and suppresses the behind count
    // until a fetch has run.
    const measured = {
      hasFetched: state.repo ? state.repo.hasFetched : false,
      fetchedAtMs: state.repo ? state.repo.fetchedAtMs : 0,
    };
    for (const b of res.local) {
      pop.appendChild(Dom.branchRowEl(b, Object.assign({
        onPick: (br) => switchBranch(br.name),
        onDelete: mutable ? (br) => deleteBranch(br) : null,
      }, measured)));
    }
    for (const b of res.remote.slice(0, 40)) {
      pop.appendChild(Dom.branchRowEl(Object.assign({}, b, { worktreePath: null }), Object.assign({}, measured)));
    }
    if (mutable && ui.popFoot) {
      const row = Dom.branchNewRowEl({ onCreate: (name) => createBranch(row, name) });
      wireBranchNew(row);
      ui.popFoot.replaceChildren(row);
      pop.appendChild(ui.popFoot);
    }
    return true;
  }

  async function openBranchPop() {
    const pop = byId('sc-branch-pop');
    const anchor = byId('sc-branch');
    const api = git();
    if (!pop || !anchor || !api || !state.repo || state.repo.isRepo !== true) return;
    if (ui.popKind === 'branch') { closePop(); return; }
    closePop();
    pop.setAttribute('aria-label', 'Branches');
    const painted = await paintBranchPop();
    if (!painted) return;
    pop.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    ui.popKind = 'branch';
    placePop(anchor);
  }

  // A pivot points the desk at a different tree, so every clause the previous
  // tree earned goes with it.
  async function pivotToRun(runId) {
    state.scope = 'run';
    state.runId = runId;
    state.selected = [];
    state.diffModel = null;
    ui.commit = null;
    ui.history = [];
    clearFetchError();
    await restart();
  }

  async function pivotToProject() {
    state.scope = 'project';
    state.runId = null;
    state.selected = [];
    state.diffModel = null;
    ui.commit = null;
    ui.history = [];
    clearFetchError();
    await restart();
  }

  // ─── Cursor ───────────────────────────────────────────────────────────────

  function paneChain() {
    return state.diffModel ? ['list', 'diff'] : ['list', 'ov0', 'ov1'];
  }

  function paneHost(pane) {
    if (pane === 'list') return byId('sc-list');
    if (pane === 'diff') return byId('sc-diff');
    if (pane === 'ov0') return byId('sc-ov-runs');
    if (pane === 'ov1') return byId('sc-ov-branch');
    return null;
  }

  // Rows are read back out of the document, so a row inside a collapsed band is
  // skipped rather than silently selected.
  function paneRows(pane) {
    const host = paneHost(pane);
    if (!host) return [];
    const sel = pane === 'diff' ? '.sc-hunk' : '.sc-row, .sc-crow, .sc-run-row';
    return [...host.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
  }

  function clearCursor() {
    const page = byId('sc');
    if (!page) return;
    page.querySelectorAll('.is-active-key').forEach((el) => el.classList.remove('is-active-key'));
  }

  // The cursor is the focus: one highlight, a roving tabindex over its pane, and
  // focus moved with it so Tab and the arrows drive the same row.
  function setCursor(el, pane, opts) {
    clearCursor();
    if (!el) { state.cursor = { pane: pane || state.cursor.pane, index: -1 }; return; }
    const which = pane || state.cursor.pane;
    const rows = paneRows(which);
    for (const row of rows) row.tabIndex = -1;
    el.classList.add('is-active-key');
    el.tabIndex = 0;
    state.cursor = { pane: which, index: rows.indexOf(el) };
    if (opts && opts.focus === false) return;
    try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {}
    try { el.focus({ preventScroll: true }); } catch (_) {}
  }

  // A repaint puts the cursor back where it was. It only takes focus back when
  // focus was already on a row, so a repaint cannot pull the caret out of the
  // composer or the filter.
  function restoreCursor() {
    if (state.cursor.index === -1) return;
    const rows = paneRows(state.cursor.pane);
    const at = clampIndex(state.cursor.index, rows.length);
    if (at === -1) { state.cursor.index = -1; return; }
    const active = document.activeElement;
    const onRow = !!active && !!active.closest && !!active.closest('.sc-row, .sc-crow, .sc-run-row, .sc-hunk');
    setCursor(rows[at], state.cursor.pane, { focus: onRow });
  }

  function moveCursor(delta, extend) {
    const rows = paneRows(state.cursor.pane);
    if (!rows.length) return;
    const at = stepIndex(state.cursor.index, delta, rows.length);
    setCursor(rows[at], state.cursor.pane);
    if (extend && state.cursor.pane === 'list') {
      const row = cursorRow();
      if (row) extendTo(row);
    }
  }

  function movePane(delta) {
    const chain = paneChain();
    let pane = state.cursor.pane;
    for (let i = 0; i < chain.length; i++) {
      const next = stepPane(chain, pane, delta);
      if (next === pane) return;
      pane = next;
      if (paneRows(pane).length) { setCursor(paneRows(pane)[0], pane); return; }
    }
  }

  function cursorEl() {
    const rows = paneRows(state.cursor.pane);
    const at = clampIndex(state.cursor.index, rows.length);
    return at === -1 ? null : rows[at];
  }

  function cursorRow() {
    const el = cursorEl();
    if (!el || !el.dataset.path) return null;
    const band = el.closest('.sc-band');
    const key = rowKey(band ? band.dataset.band : '', el.dataset.path);
    return state.entries.find((r) => r.key === key) || null;
  }

  function cursorHunkIndex() {
    const el = cursorEl();
    if (!el || state.cursor.pane !== 'diff') return -1;
    const n = Number(el.dataset.hunk);
    return Number.isInteger(n) ? n : -1;
  }

  // A range acted on together is the selection; anything else is the one row
  // under the cursor, so a stale selection can never be what gets discarded.
  function selectedRows() {
    const row = cursorRow();
    if (row && state.selected.indexOf(row.key) !== -1) {
      return state.entries.filter((r) => state.selected.indexOf(r.key) !== -1);
    }
    return row ? [row] : [];
  }

  function jumpHunk(delta) {
    const rows = paneRows('diff');
    if (!rows.length) return;
    const at = state.cursor.pane === 'diff' ? stepIndex(state.cursor.index, delta, rows.length) : 0;
    setCursor(rows[at], 'diff');
  }

  // ─── Keyboard ─────────────────────────────────────────────────────────────

  function inVisibleField(t) {
    if (!t || !t.closest) return false;
    const isText = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
    if (!isText) return false;
    return !!t.closest('.page:not([hidden]), .modal:not([hidden]), #palette:not([hidden]), #topbar');
  }

  // A control that answers a key itself keeps it: a button or select on this
  // page, outside the row and hunk panes, activates on Enter and Space on its
  // own and the page reads neither key over it.
  function ownsKey(t) {
    if (!t || !t.closest) return false;
    if (t.tagName !== 'BUTTON' && t.tagName !== 'SELECT') return false;
    return !!t.closest('.page-source') && !t.closest('#sc-list, #sc-diff');
  }

  function onKey(e) {
    if (!isVisible()) return;
    const t = e.target;
    // A dialog owns the keyboard for as long as it is up, so the page behind it
    // reads no key at all.
    if (document.querySelector('.modal:not([hidden])')) return;

    // Commit reaches from anywhere on the page, including both composer fields.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      commit({});
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (inVisibleField(t) || ownsKey(t)) return;

    const key = e.key;
    if (key === 'ArrowDown' || key === 'j') { e.preventDefault(); moveCursor(1, e.shiftKey); return; }
    if (key === 'ArrowUp' || key === 'k') { e.preventDefault(); moveCursor(-1, e.shiftKey); return; }
    if (key === 'ArrowRight') { e.preventDefault(); movePane(1); return; }
    if (key === 'ArrowLeft') { e.preventDefault(); movePane(-1); return; }
    if (key === 'Enter') { e.preventDefault(); activate(); return; }
    if (key === 'Escape') { e.preventDefault(); onEscape(); return; }
    if (key === ' ') {
      e.preventDefault();
      const row = cursorRow();
      if (row && canMutate()) stagePaths([row.path], !row.staged);
      return;
    }
    if (key === 'a') {
      e.preventDefault();
      const el = cursorEl();
      const band = el ? el.closest('.sc-band') : null;
      if (band && canMutate()) stagePaths(bandPaths(band.dataset.band), band.dataset.band !== 'staged');
      return;
    }
    if (key === 's' || key === 'u') {
      const idx = cursorHunkIndex();
      const side = state.diffModel ? state.diffModel.side : '';
      if (idx === -1) return;
      e.preventDefault();
      if (key === 's' && side === 'worktree') hunkAct(idx, 'stage');
      else if (key === 'u' && side === 'index') hunkAct(idx, 'unstage');
      return;
    }
    if (key === 'd') {
      e.preventDefault();
      const idx = cursorHunkIndex();
      if (idx !== -1) discardHunk(idx);
      else discardRows(selectedRows());
      return;
    }
    if (key === 'x') {
      e.preventDefault();
      expandContext('up', 20);
      return;
    }
    if (key === '[' || key === 'p') { e.preventDefault(); jumpHunk(-1); return; }
    if (key === ']' || key === 'n') { e.preventDefault(); jumpHunk(1); return; }
    if (key === 'c') {
      e.preventDefault();
      const subject = byId('sc-subject');
      if (subject && subject.parentNode) subject.focus();
      return;
    }
    if (key === 'b') { e.preventDefault(); openBranchPop(); return; }
    if (key === 'y') { e.preventDefault(); copySha(); return; }
    if (key === '/') {
      e.preventDefault();
      const search = byId('sc-search');
      if (search) { search.focus(); search.select(); }
    }
  }

  function activate() {
    if (state.cursor.pane === 'diff') {
      const idx = cursorHunkIndex();
      const side = state.diffModel ? state.diffModel.side : '';
      if (idx !== -1 && canMutate() && (side === 'worktree' || side === 'index')) {
        hunkAct(idx, side === 'index' ? 'unstage' : 'stage');
      }
      return;
    }
    const el = cursorEl();
    if (el && el.dataset.sha) {
      const rec = ui.history.find((r) => r.sha === el.dataset.sha);
      if (rec) openCommit(rec);
      return;
    }
    const row = cursorRow();
    if (row) openFile(row, null);
  }

  function onEscape() {
    if (ui.popKind) { closePop(); return; }
    if (state.cursor.index !== -1) { setCursor(null); return; }
    if (state.diffModel || ui.commit) closeFile();
  }

  function copySha() {
    const el = cursorEl();
    const sha = el && el.dataset.sha ? el.dataset.sha : (ui.commit && ui.commit.record ? ui.commit.record.sha : '');
    if (!sha || !navigator.clipboard) return;
    navigator.clipboard.writeText(sha).then(() => say('Copied ' + sha.slice(0, 12), 'success')).catch(() => {});
  }

  // ─── Freshness ────────────────────────────────────────────────────────────

  function pollInterval() {
    return document.hasFocus() ? 3000 : 15000;
  }

  function schedulePoll() {
    if (ui.pollTimer) clearTimeout(ui.pollTimer);
    ui.pollTimer = setTimeout(pollTick, pollInterval());
  }

  // The watcher is an accelerator; this poll is the correctness floor. It skips
  // its turn while a read or a mutating call is in flight rather than queueing.
  async function pollTick() {
    if (!isVisible() || !ui.opened) { stopPoll(); stopWatch(); return; }
    if (!ui.inFlight && !ui.mutating) await readAll();
    schedulePoll();
  }

  function stopPoll() {
    if (ui.pollTimer) clearTimeout(ui.pollTimer);
    ui.pollTimer = null;
  }

  async function startWatch() {
    const api = git();
    if (!api || !state.root) return;
    ui.watchTried = true;
    try {
      const res = await api.watch(state.root);
      ui.watching = !!(res && res.ok === true && res.watching);
    } catch (_) { ui.watching = false; }
  }

  async function stopWatch() {
    const api = git();
    ui.watching = false;
    if (!api) return;
    try { await api.unwatch(state.root); } catch (_) {}
  }

  function onChanged() {
    if (!ui.opened || !isVisible()) return;
    if (ui.changedTimer) return;
    ui.changedTimer = setTimeout(() => {
      ui.changedTimer = null;
      if (!ui.inFlight && !ui.mutating) readAll();
    }, 120);
  }

  async function restart() {
    await stopWatch();
    resolveScope();
    await readAll();
    await startWatch();
    paintHead();
    schedulePoll();
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function growBody() {
    const body = byId('sc-body');
    if (!body) return;
    body.style.height = 'auto';
    body.style.height = Math.min(168, body.scrollHeight) + 'px';
  }

  function wire() {
    if (ui.wired) return;
    ui.wired = true;

    ui.composer = byId('sc-composer');
    ui.composerHome = ui.composer ? ui.composer.parentNode : null;
    ui.acts = ['sc-act-stage', 'sc-act-unstage', 'sc-act-discard', 'sc-act-files', 'sc-act-wrap']
      .map(byId).filter(Boolean);
    // The host is read once: a control that is out of the DOM has no parent to
    // ask, and every paint re-appends in this order so the row never shuffles.
    ui.actsHome = ui.acts.length ? ui.acts[0].parentNode : null;
    ui.headBtns = ['sc-scope', 'sc-branch', 'sc-fetch', 'sc-refresh', 'sc-remote']
      .map(byId).filter(Boolean);
    ui.headHome = ui.headBtns.length ? ui.headBtns[0].parentNode : null;
    // Held once: the popover empties itself on every open and this footer is
    // put back into it for the branch list.
    ui.popFoot = byId('sc-branch-pop-foot');

    const search = byId('sc-search');
    if (search) {
      search.addEventListener('input', () => { state.query = search.value; paintList(); });
      search.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { if (search.value) clearFilter(); else search.blur(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); search.blur(); moveCursor(1, false); }
        else if (e.key === 'Enter') { e.preventDefault(); search.blur(); activate(); }
      });
      const kbd = byId('sc-search-kbd');
      if (kbd) {
        search.addEventListener('focus', () => { kbd.hidden = true; });
        search.addEventListener('blur', () => { kbd.hidden = false; });
      }
    }

    const tabChanges = byId('sc-tab-changes');
    if (tabChanges) tabChanges.addEventListener('click', () => setTab('changes'));
    const tabHistory = byId('sc-tab-history');
    if (tabHistory) tabHistory.addEventListener('click', () => setTab('history'));

    const scope = byId('sc-scope');
    if (scope) scope.addEventListener('click', openScopePop);
    const branch = byId('sc-branch');
    if (branch) branch.addEventListener('click', openBranchPop);
    const fetchBtn = byId('sc-fetch');
    if (fetchBtn) fetchBtn.addEventListener('click', fetchRemote);
    const refresh = byId('sc-refresh');
    if (refresh) refresh.addEventListener('click', () => { clearFetchError(); readAll(); });
    const remote = byId('sc-remote');
    if (remote) remote.addEventListener('click', openRemote);

    const stage = byId('sc-act-stage');
    if (stage) stage.addEventListener('click', () => { const m = state.diffModel; if (m) stagePaths([m.rel], true); });
    const unstage = byId('sc-act-unstage');
    if (unstage) unstage.addEventListener('click', () => { const m = state.diffModel; if (m) stagePaths([m.rel], false); });
    const discard = byId('sc-act-discard');
    // The act discards the row the last read holds for this file.
    if (discard) discard.addEventListener('click', () => { const row = openRow(); if (row) discardRows([row]); });
    const files = byId('sc-act-files');
    if (files) files.addEventListener('click', () => { const m = state.diffModel; if (m) openInFiles(m.rel); });
    const wrapBtn = byId('sc-act-wrap');
    if (wrapBtn) wrapBtn.addEventListener('click', () => {
      if (!state.diffModel) return;
      state.diffModel.wrap = !state.diffModel.wrap;
      paintDetail();
    });

    const subject = byId('sc-subject');
    if (subject) {
      subject.addEventListener('input', paintComposer);
      subject.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) return;
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); const body = byId('sc-body'); if (body) body.focus(); }
      });
    }
    const body = byId('sc-body');
    if (body) {
      body.addEventListener('input', () => { growBody(); });
      body.addEventListener('keydown', (e) => { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); });
    }
    const amend = byId('sc-amend');
    if (amend) amend.addEventListener('change', () => { ui.amendPublished = false; paintComposer(); });
    const commitBtn = byId('sc-commit');
    if (commitBtn) commitBtn.addEventListener('click', () => commit({}));

    // Tab moves focus without going through setCursor, so mirror it back by
    // class alone, which cannot recurse.
    document.addEventListener('focusin', (e) => {
      if (!isVisible()) return;
      const row = e.target && e.target.closest ? e.target.closest('.sc-row, .sc-crow, .sc-run-row, .sc-hunk') : null;
      if (!row || row.classList.contains('is-active-key')) return;
      clearCursor();
      row.classList.add('is-active-key');
      const host = paneChain().find((pane) => {
        const el = paneHost(pane);
        return !!el && el.contains(row);
      }) || 'list';
      state.cursor = { pane: host, index: paneRows(host).indexOf(row) };
    });

    document.addEventListener('keydown', onKey);
    document.addEventListener('click', (e) => {
      if (!ui.popKind) return;
      const pop = byId('sc-branch-pop');
      if (pop && !pop.contains(e.target) && !e.target.closest('#sc-scope, #sc-branch')) closePop();
    });
    window.addEventListener('focus', () => { if (ui.opened && isVisible()) readAll(); });

    const api = git();
    if (api && typeof api.onChanged === 'function') api.onChanged(onChanged);
  }

  // ─── Exports ──────────────────────────────────────────────────────────────

  async function open() {
    wire();
    ui.opened = true;
    if (!home && window.husk && window.husk.fs && typeof window.husk.fs.home === 'function') {
      try { home = await window.husk.fs.home(); } catch (_) { home = ''; }
      ui.home = home;
    }
    await restart();
  }

  async function close() {
    ui.opened = false;
    stopPoll();
    closePop();
    await stopWatch();
  }

  // A project pin moves both developer pages together. This runs on every pin
  // regardless of which page is showing, so it costs nothing when Source is not
  // the page on screen.
  function syncToWorkspace() {
    if (!ui.opened) return;
    if (state.scope !== 'project') return;
    const next = projectRoot();
    if (next === state.root) return;
    state.selected = [];
    state.diffModel = null;
    ui.commit = null;
    ui.history = [];
    clearFetchError();
    restart();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();

  window.Sc = {
    open,
    close,
    refresh: () => readAll(),
    syncToWorkspace,
    state,
  };
})();
