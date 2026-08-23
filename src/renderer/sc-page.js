'use strict';

// Schedule: workflows that start on their own.
//
// The rules about when a schedule fires live in schedule.js and run in the main
// process. This page states them back in the same words, using the same
// function, so the sentence under the form and the sentence on the row can
// never disagree with each other or with the timer.
//
// A schedule name is whatever the user typed, so every string here reaches the
// DOM through WfxDom.el().

(function () {
  const WfxDom = (typeof window !== 'undefined' && window.WfxDom) || null;
  if (!WfxDom) {
    if (typeof console !== 'undefined') {
      console.error('sc-page: wfx-dom.js must load first; no schedule surface will render');
    }
    return;
  }
  const el = WfxDom.el;
  const byId = (id) => document.getElementById(id);

  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const state = {
    rows: [],
    workflows: [],
    status: 'idle',   // idle | loading | ready
    editing: null,    // the schedule being edited, or null for a new one
  };

  // ─── Formatting ───────────────────────────────────────────────────────────

  function until(ms) {
    if (!Number.isFinite(ms)) return 'never';
    const mins = Math.round((ms - Date.now()) / 60000);
    if (mins <= 0) return 'due now';
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `in ${days}d ${hours % 24}h`;
  }

  function ago(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return 'never run';
    const mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return 'ran just now';
    if (mins < 60) return `ran ${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `ran ${hours}h ago`;
    return `ran ${Math.floor(hours / 24)}d ago`;
  }

  const workflowName = (id) => {
    const w = state.workflows.find((x) => x && x.id === id);
    return w ? w.name : '';
  };

  // ─── Rows ─────────────────────────────────────────────────────────────────

  function row(s) {
    const target = workflowName(s.targetId);
    const facts = [el('span', { class: 'sc-recur' }, s.describe || '')];
    // A schedule pointing at a workflow that is gone would otherwise sit there
    // looking healthy and never start anything.
    facts.push(target
      ? el('span', { class: 'sc-meta' }, target)
      : el('span', { class: 'sc-warn' }, 'that workflow no longer exists'));
    if (s.cwd) facts.push(el('code', { class: 'sc-cwd' }, s.cwd));

    const when = s.enabled
      ? el('span', { class: 'sc-next' }, s.nextRunAt ? until(s.nextRunAt) : 'never')
      : el('span', { class: 'sc-meta' }, 'paused');

    const toggle = el('button', {
      class: s.enabled ? 'toggle on' : 'toggle',
      type: 'button',
      title: s.enabled ? 'Pause this schedule' : 'Resume this schedule',
    }, '');
    toggle.dataset.act = 'toggle';

    const mk = (act, label, cls) => {
      const b = el('button', { class: cls || 'ghost-btn', type: 'button' }, label);
      b.dataset.act = act;
      return b;
    };

    const node = el('div', { class: s.enabled ? 'sc-row' : 'sc-row is-paused' },
      el('div', { class: 'sc-row-main' },
        el('div', { class: 'sc-row-head' },
          el('span', { class: 'sc-name' }, s.name),
          when,
        ),
        el('div', { class: 'sc-row-meta' }, ...facts),
        el('div', { class: 'sc-row-meta' }, el('span', { class: 'sc-meta' }, ago(s.lastRunAt))),
      ),
      el('div', { class: 'sc-row-acts' },
        mk('run', 'Run now'),
        mk('edit', 'Edit'),
        mk('delete', 'Delete', 'ghost-btn ghost-btn-danger'),
        toggle,
      ));
    node.dataset.id = s.id;
    return node;
  }

  function paint() {
    const list = byId('sc-list');
    if (!list) return;
    list.replaceChildren();
    for (const s of state.rows) list.appendChild(row(s));

    const msg = byId('sc-state');
    if (msg) {
      msg.replaceChildren();
      if (state.status === 'loading') {
        msg.appendChild(el('div', { class: 'empty-state' }, el('div', { class: 'es-msg' }, 'Reading schedules...')));
      } else if (!state.rows.length) {
        msg.appendChild(el('div', { class: 'empty-state' },
          el('div', { class: 'es-msg' }, 'Nothing runs on its own yet'),
          el('div', { class: 'sc-meta' }, 'A schedule starts a workflow at a time you choose. Husk has to be running for it to fire.')));
      }
    }
    const sub = byId('sc-sub');
    if (sub) {
      const live = state.rows.filter((s) => s.enabled).length;
      sub.textContent = state.rows.length
        ? `${state.rows.length} schedule${state.rows.length === 1 ? '' : 's'}, ${live} active`
        : 'Workflows that start on their own';
    }
  }

  // ─── Loading ──────────────────────────────────────────────────────────────

  async function load() {
    state.status = 'loading';
    paint();
    const settle = (p) => Promise.resolve(p).then((r) => r, () => null);
    const [list, flows] = await Promise.all([
      settle(window.husk.schedules.list()),
      settle(window.husk.workflows.list()),
    ]);
    state.rows = (list && list.ok && list.schedules) || [];
    state.workflows = Array.isArray(flows) ? flows : [];
    state.status = 'ready';
    paint();
  }

  // ─── The form ─────────────────────────────────────────────────────────────

  // What the form currently says, in the shape the validator reads.
  function formValue() {
    const kind = byId('sc-kind').value;
    const days = [...document.querySelectorAll('#sc-days [data-day][aria-pressed="true"]')]
      .map((b) => Number(b.dataset.day));
    const out = {
      id: state.editing ? state.editing.id : '',
      name: byId('sc-name').value,
      kind,
      target: 'workflow',
      targetId: byId('sc-target').value,
      enabled: state.editing ? state.editing.enabled !== false : true,
    };
    if (kind === 'every') out.everyMinutes = Number(byId('sc-every').value);
    else { out.at = byId('sc-at').value; out.days = days; }
    return out;
  }

  function paintDays() {
    const host = byId('sc-days');
    if (!host) return;
    const kind = byId('sc-kind').value;
    const chosen = new Set([...host.querySelectorAll('[aria-pressed="true"]')].map((b) => Number(b.dataset.day)));
    host.replaceChildren();
    for (let d = 0; d < 7; d += 1) {
      const on = chosen.has(d);
      const b = el('button', { class: on ? 'sc-day is-on' : 'sc-day', type: 'button' }, DAY_SHORT[d]);
      b.dataset.day = String(d);
      b.setAttribute('aria-pressed', String(on));
      host.appendChild(b);
    }
    // Weekly means one day; daily means any set, and none of them means all.
    const hint = kind === 'weekly' ? 'pick one day' : 'leave empty for every day';
    host.appendChild(el('span', { class: 'sc-meta' }, hint));
  }

  // The same wording the row will carry, computed from the same function, so a
  // form can never promise something the row then describes differently.
  function paintPreview() {
    const host = byId('sc-preview');
    if (!host) return;
    host.replaceChildren();
    const words = window.husk.schedules.describe(formValue());
    host.appendChild(el('span', {}, words ? `Runs ${words}.` : 'Fill the fields above to see when this runs.'));
    if (words) host.appendChild(el('div', { class: 'sc-meta' }, 'Husk has to be running at that time.'));
  }

  function syncKind() {
    const kind = byId('sc-kind').value;
    byId('sc-row-every').hidden = kind !== 'every';
    byId('sc-row-at').hidden = kind === 'every';
    byId('sc-row-days').hidden = kind === 'every';
    paintDays();
    paintPreview();
  }

  function setError(message) {
    const host = byId('sc-error');
    if (!host) return;
    host.replaceChildren();
    host.hidden = !message;
    if (message) host.appendChild(el('span', {}, message));
  }

  function openForm(schedule) {
    state.editing = schedule || null;
    byId('sc-modal-title').textContent = schedule ? 'Edit schedule' : 'New schedule';
    byId('sc-name').value = schedule ? schedule.name : '';
    byId('sc-kind').value = schedule ? schedule.kind : 'every';
    byId('sc-every').value = schedule && schedule.everyMinutes ? schedule.everyMinutes : 60;
    byId('sc-at').value = (schedule && schedule.at) || '09:00';

    // An <option> is not in WfxDom's inert-tag allowlist and does not need to
    // be: its text is set as a text node and its value never reaches markup.
    const option = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      return o;
    };
    const target = byId('sc-target');
    target.replaceChildren();
    if (!state.workflows.length) target.appendChild(option('', 'No workflows saved yet'));
    for (const w of state.workflows) target.appendChild(option(w.id, w.name || w.id));
    if (schedule && schedule.targetId) target.value = schedule.targetId;

    // Paint the day buttons before restoring which were chosen, so the restore
    // has something to write onto.
    paintDays();
    const want = new Set((schedule && Array.isArray(schedule.days) ? schedule.days : []).map(Number));
    for (const b of document.querySelectorAll('#sc-days [data-day]')) {
      const on = want.has(Number(b.dataset.day));
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
    }
    syncKind();
    setError('');
    byId('sc-modal').hidden = false;
    setTimeout(() => { try { byId('sc-name').focus(); } catch (_) {} }, 30);
  }

  const closeForm = () => { byId('sc-modal').hidden = true; state.editing = null; };

  async function save() {
    const res = await window.husk.schedules.save(formValue());
    if (!res || !res.ok) { setError((res && res.message) || 'that schedule could not be saved'); return; }
    state.rows = res.schedules || [];
    closeForm();
    paint();
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function wire() {
    byId('sc-new')?.addEventListener('click', () => openForm(null));
    byId('sc-close')?.addEventListener('click', closeForm);
    byId('sc-cancel')?.addEventListener('click', closeForm);
    byId('sc-save')?.addEventListener('click', save);
    byId('sc-kind')?.addEventListener('change', syncKind);
    for (const id of ['sc-name', 'sc-every', 'sc-at', 'sc-target']) {
      byId(id)?.addEventListener('input', paintPreview);
    }

    byId('sc-days')?.addEventListener('click', (e) => {
      const b = e.target.closest('[data-day]');
      if (!b) return;
      const on = b.getAttribute('aria-pressed') !== 'true';
      // Weekly holds one day, so choosing another releases the last.
      if (on && byId('sc-kind').value === 'weekly') {
        for (const other of document.querySelectorAll('#sc-days [data-day]')) {
          other.setAttribute('aria-pressed', 'false');
          other.classList.remove('is-on');
        }
      }
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
      paintPreview();
    });

    byId('sc-list')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      const rowEl = e.target.closest('.sc-row');
      if (!btn || !rowEl) return;
      const id = rowEl.dataset.id;
      const s = state.rows.find((x) => x.id === id);
      if (!s) return;

      if (btn.dataset.act === 'edit') { openForm(s); return; }
      if (btn.dataset.act === 'toggle') {
        const res = await window.husk.schedules.save({ ...s, enabled: !s.enabled });
        if (res && res.ok) { state.rows = res.schedules || []; paint(); }
        return;
      }
      if (btn.dataset.act === 'run') {
        const res = await window.husk.schedules.runNow(id);
        if (typeof window.toast === 'function') {
          window.toast(res && res.ok ? `Started ${s.name}` : ((res && res.message) || 'it could not be started'),
            res && res.ok ? 'success' : 'error');
        }
        return;
      }
      if (btn.dataset.act === 'delete') {
        const ok = typeof window.openConfirmDialog === 'function'
          ? await window.openConfirmDialog({
            title: 'Delete schedule',
            bodyHtml: 'This stops it running on its own. The workflow itself is untouched.',
            confirmLabel: 'Delete',
          })
          : true;
        if (!ok) return;
        const res = await window.husk.schedules.remove(id);
        if (res && res.ok) { state.rows = res.schedules || []; paint(); }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();

  window.Schedule = { open: load, refresh: load, paint, openForm, state };
})();
