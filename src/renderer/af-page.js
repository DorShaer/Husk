'use strict';

// Artifacts: one page for what your runs left behind.
//
// Husk already records two kinds of run in two stores, and until now each was
// only reachable from the page that made it. This reads both and shows them as
// one ledger, so "what did that run actually do" is one place rather than two.
//
// It invents no store and writes nothing. Every row is something already on
// disk, and every figure on it was measured by whoever wrote it. A run that
// never reported tokens shows a dash, not a zero: this page would rather say
// nothing than say a number nobody measured.
//
// Everything drawn here is agent output, so every string reaches the DOM
// through WfxDom.el() and nothing is built from a template literal.

(function () {
  const WfxDom = (typeof window !== 'undefined' && window.WfxDom) || null;
  if (!WfxDom) {
    if (typeof console !== 'undefined') {
      console.error('af-page: wfx-dom.js must load first; no artifacts surface will render');
    }
    return;
  }
  const el = WfxDom.el;
  const byId = (id) => document.getElementById(id);

  const state = {
    rows: [],
    source: '',
    outcome: '',
    query: '',
    selected: '',       // row key
    status: 'idle',     // idle | loading | ready
    fetchedAt: 0,
  };

  // ─── Formatting ───────────────────────────────────────────────────────────

  // A figure nobody measured is a dash. The dash is the point: it is the one
  // mark on this page that means "not recorded" rather than "zero".
  const DASH = '–';

  function count(n) {
    if (n === null || n === undefined) return DASH;
    return String(n);
  }

  function tokens(n) {
    if (n === null || n === undefined) return DASH;
    if (n < 1000) return String(n);
    if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
    return `${(n / 1000000).toFixed(1)}M`;
  }

  function money(n) {
    if (n === null || n === undefined) return DASH;
    return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
  }

  function duration(ms) {
    if (ms === null || ms === undefined) return DASH;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }

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
    return `${Math.floor(days / 365)} year${Math.floor(days / 365) === 1 ? '' : 's'} ago`;
  }

  const outcomePill = (row) => el('span', { class: `af-pill is-${row.outcome}` }, row.outcome);
  const sourcePill = (row) => el('span', { class: 'af-source' }, row.source === 'workflow' ? 'workflow' : 'autopilot');

  // ─── Rows ─────────────────────────────────────────────────────────────────

  function listRow(row) {
    const facts = [outcomePill(row), sourcePill(row)];
    const when = ago(row.endedAt || row.startedAt);
    if (when) facts.push(el('span', { class: 'af-meta' }, when));
    if (row.ms !== null) facts.push(el('span', { class: 'af-meta' }, duration(row.ms)));
    if (row.steps !== null) facts.push(el('span', { class: 'af-meta' }, `${row.steps} step${row.steps === 1 ? '' : 's'}`));
    if (row.files !== null) facts.push(el('span', { class: 'af-meta' }, `${row.files} file${row.files === 1 ? '' : 's'}`));
    if (row.tokens !== null) facts.push(el('span', { class: 'af-meta' }, `${tokens(row.tokens)} tok`));
    if (row.dollars !== null) facts.push(el('span', { class: 'af-meta' }, money(row.dollars)));

    const node = el('div', {
      class: state.selected === row.key ? 'af-row is-current' : 'af-row',
      role: 'option',
      tabindex: '-1',
    },
    el('div', { class: 'af-row-title' }, row.title),
    el('div', { class: 'af-row-meta' }, ...facts));
    node.dataset.key = row.key;
    return node;
  }

  // ─── Detail ───────────────────────────────────────────────────────────────

  function field(label, ...value) {
    return el('div', { class: 'af-field' },
      el('div', { class: 'af-field-label' }, label),
      el('div', { class: 'af-field-value' }, ...value));
  }

  // A workflow run's steps, with the tail of each one's scrollback behind a
  // disclosure. The log is the artifact worth keeping; the timings are the
  // index into it.
  function stepBlock(st) {
    const head = el('summary', { class: 'af-step-head' },
      el('span', { class: `af-step-dot is-${String(st.status || 'unknown')}` }, ''),
      el('span', { class: 'af-step-name' }, String(st.name || 'Step')),
      el('span', { class: 'af-meta' }, duration(Number.isFinite(st.ms) ? st.ms : null)),
      st.timedOut ? el('span', { class: 'af-warn' }, 'timed out') : null,
    );
    const entries = Array.isArray(st.entries) ? st.entries : [];
    const kids = [head];
    if (entries.length) {
      // The scrollback is joined as text, never as markup, and lands in a <pre>
      // through a text node.
      kids.push(el('pre', { class: 'af-log' }, entries.map((e) => String(e && e.text || '')).join('')));
      if (st.truncated) kids.push(el('div', { class: 'af-meta' }, 'the front of this log was dropped when the run was recorded'));
    } else {
      kids.push(el('div', { class: 'af-meta af-log-none' }, 'no scrollback survived for this step'));
    }
    return el('details', { class: 'af-step' }, ...kids);
  }

  function detail(row) {
    if (!row) {
      return el('div', { class: 'empty-state' }, el('div', { class: 'es-msg' }, state.rows.length ? 'Pick a run to see it here' : ''));
    }
    const kids = [
      el('div', { class: 'af-d-head' },
        el('div', { class: 'af-d-title' }, row.title),
        el('div', { class: 'af-d-sub' }, outcomePill(row), sourcePill(row),
          el('span', { class: 'af-meta' }, ago(row.endedAt || row.startedAt) || 'no date recorded')),
      ),
      field('Took', el('span', {}, duration(row.ms))),
    ];

    if (row.agent) kids.push(field('Agent', el('code', {}, row.agent)));
    if (row.workspace) kids.push(field('Folder', el('code', {}, row.workspace)));
    if (row.failedStep) kids.push(field('Failed at', el('span', { class: 'af-warn' }, row.failedStep)));

    // Money and tokens answer one question, so they share a field. Which half
    // is missing is said in words rather than left as a dash beside a number,
    // because a dash next to a real figure reads as part of it.
    const hasTokens = row.tokens !== null;
    const hasMoney = row.dollars !== null;
    const spent = [];
    if (hasTokens) spent.push(`${tokens(row.tokens)} tokens`);
    if (hasMoney) spent.push(money(row.dollars));
    kids.push(field('Cost',
      el('span', {}, spent.length ? spent.join(' · ') : 'not recorded'),
      (!hasTokens || !hasMoney)
        ? el('div', { class: 'af-meta' }, !hasTokens && !hasMoney
          ? 'this run reported neither; only some agents report usage'
          : (hasTokens ? 'no cost figure was recorded' : 'no token count was recorded'))
        : null));

    if (row.files !== null) kids.push(field('Files touched', el('span', {}, count(row.files))));

    const steps = row.source === 'workflow' && row.detail && Array.isArray(row.detail.steps) ? row.detail.steps : [];
    if (steps.length) {
      kids.push(el('div', { class: 'af-steps' },
        el('div', { class: 'af-field-label' }, `Steps (${steps.length})`),
        ...steps.map(stepBlock)));
      if (!row.hasLog) {
        kids.push(el('div', { class: 'af-meta' }, 'Husk keeps the scrollback of recent runs only, so this one is a summary.'));
      }
    }

    if (row.source === 'autopilot') {
      const open = el('button', { class: 'card-cta', type: 'button' }, 'Open in Autopilot');
      open.dataset.session = row.id;
      kids.push(el('div', { class: 'af-d-actions' }, open));
    }
    return el('div', { class: 'af-d' }, ...kids);
  }

  // ─── Painting ─────────────────────────────────────────────────────────────

  const visible = () => window.husk.artifacts.filter(state.rows, {
    query: state.query, source: state.source, outcome: state.outcome,
  });

  function paintFigures(rows) {
    const host = byId('af-figures');
    if (!host) return;
    host.replaceChildren();
    if (!rows.length) { host.hidden = true; return; }
    host.hidden = false;
    const s = window.husk.artifacts.summarise(rows);
    const fig = (value, label, note) => el('div', { class: 'af-figure' },
      el('div', { class: 'af-figure-value' }, value),
      el('div', { class: 'af-figure-label' }, label),
      note ? el('div', { class: 'af-figure-note' }, note) : null);

    host.appendChild(fig(String(s.runs), s.runs === 1 ? 'run' : 'runs', ''));
    host.appendChild(fig(String(s.done), 'done', s.failed ? `${s.failed} failed` : ''));
    host.appendChild(fig(duration(s.ms), 'spent', s.msRows < s.runs ? `over ${s.msRows} of ${s.runs}` : ''));
    // A total measured over some of the rows says so, because otherwise it
    // reads as the total for all of them.
    host.appendChild(fig(tokens(s.tokens), 'tokens', s.tokenRows ? `over ${s.tokenRows} of ${s.runs}` : 'none reported'));
    host.appendChild(fig(money(s.dollars), 'cost', s.dollarRows ? `over ${s.dollarRows} of ${s.runs}` : 'none reported'));
  }

  function paintState(shown) {
    const host = byId('af-state');
    if (!host) return;
    host.replaceChildren();
    if (state.status === 'loading') {
      host.appendChild(el('div', { class: 'empty-state' }, el('div', { class: 'es-msg' }, 'Reading what is on disk...')));
      return;
    }
    if (state.status === 'ready' && !shown) {
      const filtered = !!(state.query || state.source || state.outcome);
      host.appendChild(el('div', { class: 'empty-state' },
        el('div', { class: 'es-msg' }, filtered ? 'Nothing here matches' : 'Nothing has run yet'),
        filtered ? null : el('div', { class: 'af-meta' }, 'Run a workflow or an autopilot job and it lands here.')));
    }
  }

  function paint() {
    const list = byId('af-list');
    if (!list) return;
    const rows = visible();
    if (state.selected && !rows.some((r) => r.key === state.selected)) {
      state.selected = rows.length ? rows[0].key : '';
    }

    list.replaceChildren();
    for (const row of rows) list.appendChild(listRow(row));

    const pane = byId('af-detail');
    if (pane) {
      pane.replaceChildren();
      pane.appendChild(detail(rows.find((r) => r.key === state.selected) || null));
    }

    paintFigures(rows);
    paintState(rows.length);
    const panes = byId('af-panes');
    if (panes) panes.hidden = state.status !== 'ready' || !rows.length;

    const sub = byId('af-sub');
    if (sub) {
      sub.textContent = state.status === 'ready'
        ? `${rows.length} of ${state.rows.length} run${state.rows.length === 1 ? '' : 's'}`
        : 'What your runs left behind';
    }
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  let epoch = 0;

  async function load({ force = false } = {}) {
    if (!force && state.status === 'ready' && Date.now() - state.fetchedAt < 15000) { paint(); return; }
    const mine = ++epoch;
    state.status = 'loading';
    paint();

    // Both stores are read at once, and one that cannot answer costs its own
    // rows rather than the whole page.
    const settle = (p) => Promise.resolve(p).then((r) => r, () => null);
    const [wf, ap] = await Promise.all([
      settle(window.husk.workflows.runs()),
      settle(window.husk.autopilot.history({})),
    ]);
    if (mine !== epoch) return;

    state.rows = window.husk.artifacts.build(
      (wf && wf.ok && wf.runs) || [],
      (ap && ap.ok && (ap.runs || ap.sessions)) || [],
    );
    state.status = 'ready';
    state.fetchedAt = Date.now();
    if (!state.selected && state.rows.length) state.selected = state.rows[0].key;
    paint();
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function setSource(src) {
    state.source = src;
    for (const [id, value] of [['af-src-all', ''], ['af-src-workflow', 'workflow'], ['af-src-autopilot', 'autopilot']]) {
      const b = byId(id);
      if (!b) continue;
      b.classList.toggle('is-on', value === src);
      b.setAttribute('aria-selected', String(value === src));
    }
    paint();
  }

  function wire() {
    byId('af-src-all')?.addEventListener('click', () => setSource(''));
    byId('af-src-workflow')?.addEventListener('click', () => setSource('workflow'));
    byId('af-src-autopilot')?.addEventListener('click', () => setSource('autopilot'));
    byId('af-refresh')?.addEventListener('click', () => load({ force: true }));
    byId('af-outcome')?.addEventListener('change', (e) => { state.outcome = e.target.value; paint(); });
    byId('af-search')?.addEventListener('input', (e) => { state.query = e.target.value; paint(); });

    byId('af-list')?.addEventListener('click', (e) => {
      const row = e.target.closest('.af-row');
      if (!row) return;
      state.selected = row.dataset.key;
      paint();
    });

    byId('af-list')?.addEventListener('keydown', (e) => {
      const rows = visible();
      if (!rows.length) return;
      const at = rows.findIndex((r) => r.key === state.selected);
      if (e.key === 'ArrowDown') { e.preventDefault(); state.selected = rows[Math.min(rows.length - 1, at + 1)].key; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); state.selected = rows[Math.max(0, at - 1)].key; paint(); }
    });

    byId('af-detail')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-session]');
      if (btn && typeof window.afOpenAutopilot === 'function') window.afOpenAutopilot(btn.dataset.session);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();

  window.Af = {
    open: () => load({}),
    refresh: () => load({ force: true }),
    paint,
    state,
  };
})();
