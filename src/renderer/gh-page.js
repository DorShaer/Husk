'use strict';

// The GitHub page: pull requests and issues for the folder you are working in.
//
// Every string drawn here came from GitHub, which means it came from whoever
// opened the pull request. Titles, branch names, label text and logins are all
// user content, so they reach the DOM through WfxDom.el() and nothing in this
// file builds markup from a template literal.
//
// The repository is never configured. It is whichever one the current folder
// sits in, read by gh from that folder's remote, so the page follows the
// workspace the way Files does and there is no stored repo to go stale.
//
// Filtering is local. The list arrives once per state change, and typing in the
// box narrows what is already in hand rather than asking GitHub again: a
// keystroke must not be a network request, and a rate limit must not be
// something a search box can spend.

(function () {
  const WfxDom = (typeof window !== 'undefined' && window.WfxDom) || null;
  if (!WfxDom) {
    if (typeof console !== 'undefined') {
      console.error('gh-page: wfx-dom.js must load first; no GitHub surface will render');
    }
    return;
  }
  const el = WfxDom.el;
  const byId = (id) => document.getElementById(id);

  // ─── State ────────────────────────────────────────────────────────────────
  const state = {
    kind: 'pulls',          // pulls | issues
    listState: 'open',
    query: '',
    label: '',
    rows: [],
    repo: null,
    selected: null,         // row number
    status: 'idle',         // idle | loading | ready | error
    error: null,
    fetchedAt: 0,
  };

  // ─── Formatting ───────────────────────────────────────────────────────────

  function ago(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return '';
    const mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? '' : 's'} ago`;
  }

  // A label carries its own colour from GitHub. The value is already narrowed
  // to six hex digits by the reader, so it is safe to put in a style; anything
  // that did not survive that check gets the neutral chip instead.
  function labelChip(l, extraClass) {
    const node = el('span', { class: extraClass ? `gh-label ${extraClass}` : 'gh-label' }, l.name);
    if (l.color) {
      node.style.setProperty('--label-color', `#${l.color}`);
      node.classList.add('has-color');
    }
    return node;
  }

  // One word for a row's checks, and the count behind it.
  function checksChip(checks) {
    if (!checks || !checks.total) return null;
    const word = checks.state === 'failing'
      ? `${checks.failed} failing`
      : checks.state === 'pending'
        ? `${checks.pending} running`
        : `${checks.passed} passed`;
    return el('span', { class: `gh-checks is-${checks.state}` }, word);
  }

  function stateChip(row) {
    if (state.kind === 'issues') {
      return el('span', { class: `gh-pill is-${row.state.toLowerCase()}` }, row.state === 'OPEN' ? 'Open' : 'Closed');
    }
    if (row.isDraft) return el('span', { class: 'gh-pill is-draft' }, 'Draft');
    const word = row.state === 'MERGED' ? 'Merged' : row.state === 'CLOSED' ? 'Closed' : 'Open';
    return el('span', { class: `gh-pill is-${row.state.toLowerCase()}` }, word);
  }

  // ─── Rows ─────────────────────────────────────────────────────────────────

  function listRow(row) {
    const head = el('div', { class: 'gh-row-head' },
      el('span', { class: 'gh-num' }, `#${row.number}`),
      el('span', { class: 'gh-row-title' }, row.title),
    );

    const metaBits = [stateChip(row)];
    if (row.author) metaBits.push(el('span', { class: 'gh-meta' }, row.author));
    const when = ago(row.updatedAt);
    if (when) metaBits.push(el('span', { class: 'gh-meta' }, when));
    if (state.kind === 'pulls') {
      const checks = checksChip(row.checks);
      if (checks) metaBits.push(checks);
      if (row.changedFiles) {
        metaBits.push(el('span', { class: 'gh-meta is-diff' }, `${row.changedFiles} file${row.changedFiles === 1 ? '' : 's'}`));
        metaBits.push(el('span', { class: 'gh-add' }, `+${row.additions}`));
        metaBits.push(el('span', { class: 'gh-del' }, `-${row.deletions}`));
      }
    } else if (row.comments) {
      metaBits.push(el('span', { class: 'gh-meta' }, `${row.comments} comment${row.comments === 1 ? '' : 's'}`));
    }

    const kids = [head, el('div', { class: 'gh-row-meta' }, ...metaBits)];
    if (row.labels.length) {
      kids.push(el('div', { class: 'gh-row-labels' }, ...row.labels.slice(0, 5).map((l) => labelChip(l))));
    }

    const node = el('div', {
      class: state.selected === row.number ? 'gh-row is-current' : 'gh-row',
      role: 'option',
      tabindex: '-1',
    }, ...kids);
    node.dataset.number = String(row.number);
    return node;
  }

  // ─── Detail ───────────────────────────────────────────────────────────────

  function field(label, ...value) {
    return el('div', { class: 'gh-field' },
      el('div', { class: 'gh-field-label' }, label),
      el('div', { class: 'gh-field-value' }, ...value),
    );
  }

  function detail(row) {
    if (!row) {
      return el('div', { class: 'empty-state' },
        el('div', { class: 'es-msg' }, state.rows.length ? 'Pick a row to see it here' : ''));
    }

    const kids = [
      el('div', { class: 'gh-d-head' },
        el('div', { class: 'gh-d-title' }, row.title),
        el('div', { class: 'gh-d-sub' }, stateChip(row), el('span', { class: 'gh-num' }, `#${row.number}`),
          row.author ? el('span', { class: 'gh-meta' }, `opened by ${row.author}`) : null),
      ),
    ];

    if (state.kind === 'pulls') {
      kids.push(field('Branches', el('code', {}, row.head || '?'), el('span', { class: 'gh-arrow' }, ' into '), el('code', {}, row.base || '?')));
      kids.push(field('Changes',
        el('span', { class: 'gh-meta' }, `${row.changedFiles} file${row.changedFiles === 1 ? '' : 's'}`),
        el('span', { class: 'gh-add' }, ` +${row.additions}`),
        el('span', { class: 'gh-del' }, ` -${row.deletions}`)));

      const c = row.checks;
      kids.push(field('Checks', c && c.total
        ? el('span', {}, `${c.passed} passed, ${c.failed} failed, ${c.pending} running, ${c.total} total`)
        : el('span', { class: 'gh-meta' }, 'no checks ran')));

      // An empty review decision is not an approval, and the copy says which.
      kids.push(field('Review', row.reviewDecision
        ? el('span', {}, row.reviewDecision.replace(/_/g, ' ').toLowerCase())
        : el('span', { class: 'gh-meta' }, 'nobody has reviewed yet')));

      if (row.mergeable) kids.push(field('Mergeable', el('span', {}, row.mergeable.toLowerCase())));
    } else if (row.assignees && row.assignees.length) {
      kids.push(field('Assignees', el('span', {}, row.assignees.join(', '))));
    }

    if (row.labels.length) {
      kids.push(field('Labels', el('span', { class: 'gh-d-labels' }, ...row.labels.map((l) => labelChip(l)))));
    }
    kids.push(field('Updated', el('span', {}, ago(row.updatedAt) || '?')));

    // The one action. Husk does not review, merge or comment here: the browser
    // already does all three, and half a review surface is worse than none.
    const open = el('button', { class: 'card-cta', type: 'button' }, 'Open on GitHub');
    open.dataset.url = row.url;
    kids.push(el('div', { class: 'gh-d-actions' }, open));

    return el('div', { class: 'gh-d' }, ...kids);
  }

  // ─── Painting ─────────────────────────────────────────────────────────────

  function visibleRows() {
    let rows = window.husk.github.filter(state.rows, state.query);
    if (state.label) rows = rows.filter((r) => r.labels.some((l) => l.name === state.label));
    return rows;
  }

  function paintLabels() {
    const host = byId('gh-labels');
    if (!host) return;
    host.replaceChildren();
    const counts = window.husk.github.labels(state.rows);
    if (!counts.length) return;
    const chip = (name, count, on) => {
      const b = el('button', { class: on ? 'gh-label-chip is-on' : 'gh-label-chip', type: 'button' },
        count === null ? name : `${name} ${count}`);
      b.dataset.label = name === 'All' ? '' : name;
      return b;
    };
    host.appendChild(chip('All', null, !state.label));
    for (const l of counts.slice(0, 10)) host.appendChild(chip(l.name, l.count, state.label === l.name));
  }

  function paintRepo() {
    const host = byId('gh-repo');
    if (!host) return;
    host.replaceChildren();
    if (!state.repo) { host.hidden = true; return; }
    host.hidden = false;
    host.appendChild(el('span', { class: 'gh-repo-name' }, state.repo.nameWithOwner));
    if (state.repo.isPrivate) host.appendChild(el('span', { class: 'gh-repo-private' }, 'private'));
  }

  // Loading, refused, or nothing at all when the list has rows in it.
  function paintStatus(shown) {
    const host = byId('gh-state-msg');
    if (!host) return;
    host.replaceChildren();
    if (state.status === 'loading') {
      host.appendChild(el('div', { class: 'empty-state' }, el('div', { class: 'es-msg' }, 'Asking gh...')));
      return;
    }
    if (state.status === 'error') {
      const e = state.error || {};
      const kids = [
        el('div', { class: 'es-icon' }, '!'),
        el('div', { class: 'es-msg' }, e.message || 'GitHub could not be read'),
      ];
      // Each failure has a different thing for the reader to do, so each one
      // says its own next step rather than sharing a generic sentence.
      const advice = {
        'gh-missing': 'Install the GitHub CLI and open this page again. Husk stores no token of its own; it borrows the login gh already has.',
        'gh-not-authenticated': 'Run gh auth login in a terminal, then press Refresh.',
        'not-a-repository': 'Open a project that is inside a git repository.',
        'no-remote': 'Add a GitHub remote to this repository, then press Refresh.',
        'repo-not-found': 'The account gh is logged in as cannot see that repository.',
        'rate-limited': 'Wait for the limit to reset, then press Refresh.',
      }[e.code];
      if (advice) kids.push(el('div', { class: 'gh-advice' }, advice));
      if (e.detail) kids.push(el('div', { class: 'gh-detail-line' }, e.detail));
      host.appendChild(el('div', { class: 'empty-state' }, ...kids));
      return;
    }
    if (state.status === 'ready' && !shown) {
      const filtered = !!(state.query || state.label);
      host.appendChild(el('div', { class: 'empty-state' }, el('div', { class: 'es-msg' },
        filtered ? 'Nothing here matches' : `No ${state.kind === 'pulls' ? 'pull requests' : 'issues'} in that state`)));
    }
  }

  function paint() {
    const list = byId('gh-list');
    if (!list) return;
    const rows = visibleRows();

    // A selection that filtering removed drops rather than pointing at a row
    // nobody can see.
    if (state.selected !== null && !rows.some((r) => r.number === state.selected)) {
      state.selected = rows.length ? rows[0].number : null;
    }

    list.replaceChildren();
    for (const row of rows) list.appendChild(listRow(row));

    const pane = byId('gh-detail');
    if (pane) {
      pane.replaceChildren();
      pane.appendChild(detail(rows.find((r) => r.number === state.selected) || null));
    }

    paintRepo();
    paintLabels();
    paintStatus(rows.length);

    // With nothing to list, the two panes would still claim the height and push
    // the message that explains why to the bottom of the page. The message is
    // the content in that state, so it takes the space instead.
    const panes = byId('gh-panes');
    if (panes) panes.hidden = state.status !== 'ready' || !rows.length;

    const sub = byId('gh-sub');
    if (sub) {
      sub.textContent = state.status === 'ready'
        ? `${rows.length} of ${state.rows.length} ${state.kind === 'pulls' ? 'pull requests' : 'issues'}`
        : 'Pull requests and issues for the folder you are working in';
    }
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  let epoch = 0;

  async function load({ force = false } = {}) {
    if (!force && state.status === 'ready' && Date.now() - state.fetchedAt < 30000) { paint(); return; }
    const mine = ++epoch;
    state.status = 'loading';
    state.error = null;
    paint();

    const api = window.husk.github;
    // The repository name is its own call and its own failure. A list that
    // cannot load still leaves the reader knowing which repository was asked.
    api.repo().then((r) => {
      if (mine !== epoch) return;
      state.repo = r && r.ok ? r.repo : null;
      paintRepo();
    }).catch(() => {});

    let res;
    const opts = { state: state.listState, limit: 100 };
    try {
      res = state.kind === 'pulls' ? await api.pulls(opts) : await api.issues(opts);
    } catch (err) {
      res = { ok: false, code: 'gh-failed', message: (err && err.message) || 'gh could not be reached', detail: null };
    }
    if (mine !== epoch) return;

    if (!res || !res.ok) {
      state.status = 'error';
      state.error = res || {};
      state.rows = [];
      state.selected = null;
    } else {
      state.status = 'ready';
      state.rows = res.rows || [];
      state.fetchedAt = Date.now();
      if (state.selected === null && state.rows.length) state.selected = state.rows[0].number;
    }
    paint();
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function setKind(kind) {
    if (state.kind === kind) return;
    state.kind = kind;
    state.rows = [];
    state.selected = null;
    state.label = '';
    // Issues have no merged state, so a state gh would refuse is corrected here
    // rather than sent and bounced.
    if (kind === 'issues' && state.listState === 'merged') state.listState = 'open';
    const sel = byId('gh-state');
    if (sel) {
      sel.value = state.listState;
      const merged = sel.querySelector('option[value="merged"]');
      if (merged) merged.hidden = kind === 'issues';
    }
    byId('gh-tab-pulls').classList.toggle('is-on', kind === 'pulls');
    byId('gh-tab-issues').classList.toggle('is-on', kind === 'issues');
    byId('gh-tab-pulls').setAttribute('aria-selected', String(kind === 'pulls'));
    byId('gh-tab-issues').setAttribute('aria-selected', String(kind === 'issues'));
    load({ force: true });
  }

  function wire() {
    byId('gh-tab-pulls')?.addEventListener('click', () => setKind('pulls'));
    byId('gh-tab-issues')?.addEventListener('click', () => setKind('issues'));
    byId('gh-refresh')?.addEventListener('click', () => load({ force: true }));

    byId('gh-state')?.addEventListener('change', (e) => {
      state.listState = e.target.value;
      state.selected = null;
      load({ force: true });
    });

    byId('gh-search')?.addEventListener('input', (e) => { state.query = e.target.value; paint(); });

    byId('gh-labels')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-label]');
      if (!btn) return;
      state.label = btn.dataset.label;
      paint();
    });

    byId('gh-list')?.addEventListener('click', (e) => {
      const row = e.target.closest('.gh-row');
      if (!row) return;
      state.selected = Number(row.dataset.number);
      paint();
    });

    // The list is one control: arrows walk it and Enter opens what is under
    // the cursor, so a reader never has to reach for the pointer.
    byId('gh-list')?.addEventListener('keydown', (e) => {
      const rows = visibleRows();
      if (!rows.length) return;
      const at = rows.findIndex((r) => r.number === state.selected);
      if (e.key === 'ArrowDown') { e.preventDefault(); state.selected = rows[Math.min(rows.length - 1, at + 1)].number; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); state.selected = rows[Math.max(0, at - 1)].number; paint(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows.find((r) => r.number === state.selected);
        if (row && row.url) window.husk.urls.openExternal(row.url);
      }
    });

    byId('gh-detail')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-url]');
      if (btn && btn.dataset.url) window.husk.urls.openExternal(btn.dataset.url);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();

  window.Gh = {
    open: () => load({}),
    refresh: () => load({ force: true }),
    paint,
    state,
  };
})();
