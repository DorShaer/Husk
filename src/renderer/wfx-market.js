'use strict';

// The marketplace surface: browsing catalogs of workflows other people publish.
//
// Everything painted here came off somebody else's machine, so every string
// reaches the DOM through WfxDom.el() and nothing in this file builds markup
// from a template literal. That is the same rule the install sheet already
// keeps, for the same reason: a catalog is a file a stranger wrote.
//
// The surface is deliberately thin. It finds a workflow and hands it to the
// install sheet that already exists, which runs the same validator, the same
// preflight and the same consent gate a file picked off disk runs. A registry
// buys discovery. It does not buy trust, and this file never spends any.
//
// Two words are used exactly, and neither of them is "verified":
//
//   "listed here"   the catalog said it, and nothing has checked it
//   "matches"       this machine hashed the bytes and they are the bytes the
//                   catalog named, which rules out the file moving underneath
//                   a catalog nobody updated, and says nothing about who wrote
//                   either of them
//
// An entry whose bytes contradict its listed digest never reaches this file:
// main.js refuses it, because contradicted evidence is worse than none.

(function () {
  const WfxDom = (typeof window !== 'undefined' && window.WfxDom) || null;
  if (!WfxDom) {
    if (typeof console !== 'undefined') {
      console.error('wfx-market: wfx-dom.js must load first; no marketplace surface will render');
    }
    return;
  }
  const el = WfxDom.el;

  const byId = (id) => document.getElementById(id);

  // ─── State ────────────────────────────────────────────────────────────────
  // One catalog at a time. Registries are fetched in order and the first that
  // answers is the one on screen, because a merged catalog would have to
  // resolve two publishers claiming the same id and there is no honest way to
  // do that without saying which host each row came from anyway.
  const state = {
    registries: [],
    activeUrl: '',
    index: null,
    query: '',
    tag: '',
    status: 'idle',   // idle | loading | ready | error
    error: null,
    fetchedAt: 0,
  };

  // ─── Formatting ───────────────────────────────────────────────────────────

  // A date the catalog stated. Unparseable text yields nothing rather than
  // "Invalid Date": a claim that cannot be read is not shown as one that can.
  function whenText(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    if (days < 365) return plural(Math.floor(days / 30), 'month');
    return plural(Math.floor(days / 365), 'year');
  }

  // The host a catalog is served from, which is the thing worth naming about it.
  function hostOf(url) {
    try { return new URL(String(url)).host; } catch (_) { return String(url || '').slice(0, 60); }
  }

  // ─── Cards ────────────────────────────────────────────────────────────────

  // One row of the catalog. Every figure on it is a claim, and the card says so
  // once, in the strip along its bottom, rather than hedging every number.
  function card(entry) {
    const c = entry.claims;
    const parts = [];

    parts.push(el('div', { class: 'wfm-card-head' },
      el('div', { class: 'wfm-card-name' }, c.name),
      entry.sha256 ? el('span', { class: 'wfm-chip is-attested', title: 'This catalog states a digest for this file. Husk checks the bytes against it before reading them.' }, 'digest listed') : null,
    ));

    if (c.description) parts.push(el('div', { class: 'wfm-card-desc' }, c.description));

    const facts = [];
    if (c.steps !== null) facts.push(el('span', { class: 'wfm-fact' }, `${c.steps} step${c.steps === 1 ? '' : 's'}`));
    for (const a of c.agents) facts.push(el('span', { class: 'wfm-fact is-agent' }, a));
    for (const t of c.tags) facts.push(el('span', { class: 'wfm-fact is-tag' }, t));
    if (facts.length) parts.push(el('div', { class: 'wfm-card-facts' }, ...facts));

    const by = [];
    if (c.author) by.push(`by ${c.author}`);
    const when = whenText(c.updatedAt);
    if (when) by.push(`updated ${when}`);
    parts.push(el('div', { class: 'wfm-card-foot' },
      el('span', { class: 'wfm-card-by' }, by.length ? `${by.join(' · ')} · listed here` : 'listed here'),
    ));

    const btn = el('button', { class: 'card-cta wfm-install', type: 'button' }, 'Get');
    btn.dataset.id = entry.id;
    parts.push(el('div', { class: 'wfm-card-actions' }, btn));

    const node = el('div', { class: 'wfm-card' }, ...parts);
    node.dataset.id = entry.id;
    return node;
  }

  // ─── Painting ─────────────────────────────────────────────────────────────

  function paintTags() {
    const host = byId('wfm-tags');
    if (!host) return;
    host.replaceChildren();
    if (!state.index) return;
    const counts = window.husk.registry.tags(state.index.entries);
    if (!counts.length) return;

    const chip = (label, value, n) => {
      const b = el('button', {
        class: state.tag === value ? 'wfm-tag is-on' : 'wfm-tag',
        type: 'button',
      }, n === null ? label : `${label} ${n}`);
      b.dataset.tag = value;
      return b;
    };
    host.appendChild(chip('All', '', null));
    for (const { tag, count } of counts.slice(0, 12)) host.appendChild(chip(tag, tag, count));
  }

  function paintSource() {
    const host = byId('wfm-source');
    if (!host) return;
    host.replaceChildren();
    if (!state.index) { host.hidden = true; return; }
    host.hidden = false;

    const bits = [];
    const name = state.index.claims.name;
    bits.push(el('span', { class: 'wfm-source-name' }, name || hostOf(state.activeUrl)));
    bits.push(el('span', { class: 'wfm-source-host' }, hostOf(state.activeUrl)));
    bits.push(el('span', { class: 'wfm-source-count' },
      `${state.index.entries.length} workflow${state.index.entries.length === 1 ? '' : 's'}`));
    // A catalog that half-loaded says so rather than looking complete.
    if (state.index.skipped > 0) {
      bits.push(el('span', { class: 'wfm-source-skipped', title: 'Rows this build could not read: a newer format, a missing name, or a duplicate id.' },
        `${state.index.skipped} row${state.index.skipped === 1 ? '' : 's'} not readable`));
    }
    host.appendChild(el('div', { class: 'wfm-source-row' }, ...bits));
  }

  // The one pane that is not a grid: loading, empty, refused, or nothing at all
  // when the grid has cards in it.
  function paintState(shown) {
    const host = byId('wfm-state');
    if (!host) return;
    host.replaceChildren();

    if (state.status === 'loading') {
      host.appendChild(el('div', { class: 'empty-state' },
        el('div', { class: 'es-msg' }, 'Reading the catalog...')));
      return;
    }
    if (state.status === 'error') {
      const e = state.error || {};
      host.appendChild(el('div', { class: 'empty-state' },
        el('div', { class: 'es-icon' }, '!'),
        el('div', { class: 'es-msg' }, e.message || 'That catalog could not be read'),
        e.detail ? el('div', { class: 'wfm-state-detail' }, e.detail) : null,
        el('div', { class: 'wfm-state-detail' }, hostOf(state.activeUrl)),
      ));
      return;
    }
    if (state.status === 'ready' && !shown) {
      const filtered = !!(state.query || state.tag);
      host.appendChild(el('div', { class: 'empty-state' },
        el('div', { class: 'es-msg' }, filtered ? 'Nothing in this catalog matches' : 'This catalog is empty'),
      ));
    }
  }

  function paint() {
    const grid = byId('wfm-grid');
    if (!grid) return;

    const entries = state.index
      ? window.husk.registry.search(state.index.entries, state.query, state.tag)
      : [];
    grid.replaceChildren();
    for (const entry of entries) grid.appendChild(card(entry));

    paintSource();
    paintTags();
    paintState(entries.length);
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  async function loadRegistries() {
    try {
      const r = await window.husk.registry.list();
      state.registries = (r && r.registries) || [];
    } catch (_) { state.registries = []; }
    if (!state.activeUrl || !state.registries.some((x) => x.url === state.activeUrl)) {
      state.activeUrl = state.registries.length ? state.registries[0].url : '';
    }
  }

  async function load({ force = false } = {}) {
    await loadRegistries();
    if (!state.activeUrl) {
      state.status = 'error';
      state.index = null;
      state.error = { message: 'No registry is configured', detail: 'Add one from the Registries button.' };
      paint();
      return;
    }
    // A catalog read a minute ago is the catalog: refetching on every visit
    // would mean a request per navigation for a file that changes daily.
    if (!force && state.index && Date.now() - state.fetchedAt < 60000) { paint(); return; }

    state.status = 'loading';
    state.error = null;
    paint();

    let res;
    try { res = await window.husk.registry.fetch(state.activeUrl); }
    catch (err) { res = { ok: false, message: (err && err.message) || 'the catalog could not be read' }; }

    if (!res || !res.ok) {
      state.status = 'error';
      state.index = null;
      state.error = res || { message: 'the catalog could not be read' };
    } else {
      state.status = 'ready';
      state.index = res.index;
      state.fetchedAt = Date.now();
    }
    paint();
  }

  // ─── Installing ───────────────────────────────────────────────────────────

  // Hands the entry to the install sheet, which does the reading. Nothing is
  // fetched here and nothing is written: the sheet owns the read, the refusal
  // copy, the directory picker, the preflight table and the consent gate, and
  // it owns them for a catalog exactly as it does for a file off disk.
  function get(id) {
    if (!state.index) return;
    const entry = state.index.entries.find((e) => e.id === id);
    if (!entry) return;
    const sheet = window.WfxInstall;
    if (!sheet || typeof sheet.openFromRegistry !== 'function') {
      if (typeof console !== 'undefined') console.error('wfx-market: the install sheet is not loaded');
      return;
    }
    sheet.openFromRegistry(state.activeUrl, entry);
  }

  // ─── Registry manager ─────────────────────────────────────────────────────

  function paintRegistries() {
    const host = byId('wfm-reg-list');
    if (!host) return;
    host.replaceChildren();
    for (const r of state.registries) {
      const row = el('div', { class: r.url === state.activeUrl ? 'wfm-reg-row is-on' : 'wfm-reg-row' },
        el('div', { class: 'wfm-reg-main' },
          el('div', { class: 'wfm-reg-host' }, hostOf(r.url)),
          el('div', { class: 'wfm-reg-url' }, r.url),
        ),
      );
      const use = el('button', { class: 'ghost-btn', type: 'button' }, r.url === state.activeUrl ? 'Showing' : 'Show');
      use.dataset.use = r.url;
      use.disabled = r.url === state.activeUrl;
      const drop = el('button', { class: 'ghost-btn ghost-btn-danger', type: 'button' }, 'Remove');
      drop.dataset.remove = r.url;
      row.appendChild(el('div', { class: 'wfm-reg-actions' }, use, drop));
      host.appendChild(row);
    }
    if (!state.registries.length) {
      host.appendChild(el('div', { class: 'wfm-reg-empty' }, 'No registries. Add one below.'));
    }
  }

  function regError(message) {
    const host = byId('wfm-reg-error');
    if (!host) return;
    host.replaceChildren();
    host.hidden = !message;
    if (message) host.appendChild(el('span', {}, message));
  }

  async function openRegistries() {
    await loadRegistries();
    paintRegistries();
    regError('');
    const modal = byId('wfm-registries-modal');
    if (modal) modal.hidden = false;
  }

  function closeRegistries() {
    const modal = byId('wfm-registries-modal');
    if (modal) modal.hidden = true;
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function wire() {
    const search = byId('wfm-search');
    if (search) {
      search.addEventListener('input', () => { state.query = search.value; paint(); });
    }
    const tags = byId('wfm-tags');
    if (tags) {
      tags.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tag]');
        if (!btn) return;
        state.tag = btn.dataset.tag;
        paint();
      });
    }
    const grid = byId('wfm-grid');
    if (grid) {
      grid.addEventListener('click', (e) => {
        const btn = e.target.closest('.wfm-install');
        if (btn && btn.dataset.id) get(btn.dataset.id);
      });
    }
    const refresh = byId('btn-wfm-refresh');
    if (refresh) refresh.addEventListener('click', () => load({ force: true }));

    const regs = byId('btn-wfm-registries');
    if (regs) regs.addEventListener('click', openRegistries);
    const close = byId('wfm-reg-close');
    if (close) close.addEventListener('click', closeRegistries);

    const list = byId('wfm-reg-list');
    if (list) {
      list.addEventListener('click', async (e) => {
        const use = e.target.closest('[data-use]');
        if (use) {
          state.activeUrl = use.dataset.use;
          state.index = null;
          state.fetchedAt = 0;
          closeRegistries();
          await load({ force: true });
          return;
        }
        const drop = e.target.closest('[data-remove]');
        if (!drop) return;
        const res = await window.husk.registry.remove(drop.dataset.remove);
        if (!res || !res.ok) { regError((res && res.message) || 'that could not be removed'); return; }
        state.registries = res.registries || [];
        if (!state.registries.some((r) => r.url === state.activeUrl)) {
          state.activeUrl = state.registries.length ? state.registries[0].url : '';
          state.index = null;
          state.fetchedAt = 0;
        }
        paintRegistries();
        paint();
      });
    }

    const add = byId('wfm-reg-add');
    const url = byId('wfm-reg-url');
    const doAdd = async () => {
      const res = await window.husk.registry.add(url ? url.value : '');
      if (!res || !res.ok) { regError((res && res.message) || 'that URL could not be added'); return; }
      regError('');
      if (url) url.value = '';
      state.registries = res.registries || [];
      paintRegistries();
    };
    if (add) add.addEventListener('click', doAdd);
    if (url) url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();

  window.WfxMarket = {
    open: () => load({}),
    refresh: () => load({ force: true }),
    // Redraw from whatever is in state. Separate from load() because painting a
    // catalog already in hand and going to fetch one are different acts, and
    // only one of them needs the network.
    paint,
    state,
  };
})();
