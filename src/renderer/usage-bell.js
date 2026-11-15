'use strict';

// The usage bell: gathers readings from every source the app already has,
// asks the usage monitor for their states, and shows the result in the top
// bar, a panel and one keyed toast. Loaded after app.js, whose top-level
// names (cfg, TABS, notify, ...) it reads.
(function () {
  const M = window.HuskUsage;
  const bell = document.getElementById('usage-bell');
  const countEl = document.getElementById('usage-bell-count');
  const panel = document.getElementById('usage-panel');
  if (!M || !bell || !panel || !window.husk) return;

  const TOAST_KEY = 'usage-limit';
  // agent name -> Map(window -> { window, pct, resetsAt, at, reached, inferred, src })
  const plan = new Map();
  let daily = { tokens: 0, dollars: 0 };
  let last = null;
  let lastSig = '';
  const unread = new Set();
  const ALERTS_KEY = 'husk.usageAlerts';
  const alerts = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
    if (Array.isArray(saved)) for (const [id, alert] of saved.slice(-200)) {
      if (typeof id === 'string' && alert && M.STATES.includes(alert.state) && alert.at > Date.now() - 30 * 864e5) alerts.set(id, alert);
    }
  } catch (_) {}

  function saveAlerts() {
    try { localStorage.setItem(ALERTS_KEY, JSON.stringify([...alerts].slice(-200))); } catch (_) {}
  }

  function acknowledge(sourceId) {
    for (const s of last?.sources || []) {
      if (sourceId && s.id !== sourceId) continue;
      const alert = alerts.get(s.id);
      if (alert) alert.unread = false;
      unread.delete(s.id);
    }
    saveAlerts();
    paintBell();
  }

  function updateAlerts(next) {
    const crossed = [];
    let changed = false;
    unread.clear();
    for (const s of next.sources) {
      let alert = alerts.get(s.id);
      if (s.state === 'ok') {
        if (alert?.resetsAt > 0 && alert.resetsAt <= Date.now()) changed = alerts.delete(s.id) || changed;
        continue;
      }
      const newWindow = alert?.resetsAt > 0 && alert.resetsAt <= Date.now() && (!s.resetsAt || s.resetsAt > Date.now());
      if (!alert || newWindow) {
        alert = { state: s.state, resetsAt: s.resetsAt || 0, unread: true, at: Date.now() };
        alerts.set(s.id, alert);
        crossed.push(s);
        changed = true;
      } else if (alert.state !== s.state) {
        alert.state = s.state;
        changed = true;
      }
      if (!alert.resetsAt && s.resetsAt > 0) { alert.resetsAt = s.resetsAt; changed = true; }
      if (!panel.hidden && alert.unread) { alert.unread = false; changed = true; }
      if (alert.unread) unread.add(s.id);
    }
    if (changed) saveAlerts();
    return crossed;
  }

  const conf = () => (typeof cfg === 'object' && cfg) || {};
  const agentOf = (tab) => String(tabAgentCommand(tab) || '').trim().split(/\s+/)[0] || 'agent';
  const windowsOf = (agent) => { if (!plan.has(agent)) plan.set(agent, new Map()); return plan.get(agent); };
  const isReached = (agent) => Array.from(windowsOf(agent).values()).some((w) => w.reached && (!w.resetsAt || w.resetsAt > Date.now()));

  function readings(now) {
    const out = [];
    for (const [agent, windows] of plan) out.push(...M.planReadings(agent, Array.from(windows.values())));
    for (const tab of TABS.values()) {
      const u = tab.chatState && tab.chatState.usage;
      if (!u || !(Number(u.size) > 0)) continue;
      const id = `context:${tab.id}:${tab.chatState.sessionId || tab.agentId || tab.id}`;
      const legacy = 'context:' + tab.id;
      if (!alerts.has(id) && alerts.has(legacy)) {
        alerts.set(id, alerts.get(legacy)); alerts.delete(legacy); saveAlerts();
      }
      out.push({ id, kind: 'context', label: 'Context window', detail: displayTitle(tab), used: Number(u.used) || 0, limit: Number(u.size), unit: 'tokens', tabId: tab.id });
    }
    const c = conf();
    out.push(...M.budgetReadings(M.dailyCounter(daily, now), { tokens: c.usageBudgetTokens, dollars: c.usageBudgetDollars }, now));
    if (typeof activeRuns !== 'undefined') {
      for (const [key, run] of activeRuns) {
        const r = run && run.budget && run.budget.ratios;
        if (!r) continue;
        const cap = ['minutes', 'tokens', 'dollars'].reduce((a, b) => ((Number(r[b]) || 0) > (Number(r[a]) || 0) ? b : a));
        out.push({ id: 'autopilot:' + key, kind: 'autopilot', label: 'Autopilot run', detail: cap + ' cap', used: (Number(r[cap]) || 0) * 100, limit: 100, unit: 'percent', readOnly: true });
      }
    }
    return out;
  }

  function valueText(s) {
    if (s.inferred) return 'Inferred from an error message';
    if (s.unit === 'tokens') {
      const f = window.HuskChat && window.HuskChat._fmtTokens ? window.HuskChat._fmtTokens : String;
      return f(s.used) + ' / ' + f(s.limit);
    }
    if (s.unit === 'dollars') return '~$' + s.used.toFixed(2) + ' / $' + s.limit.toFixed(2);
    return Math.round(s.pct) + '%';
  }
  const resetText = (s) => (s.resetsAt ? 'Resets ' + fmtUntil(new Date(s.resetsAt).toISOString()) : '');

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function paintPanel() {
    const rows = last ? last.sources : [];
    panel.replaceChildren(el('div', 'usage-panel-title section-label', 'Usage limits'));
    if (!rows.length) panel.appendChild(el('div', 'usage-panel-empty', 'Nothing to show yet. A source appears here once a CLI reports usage or you set a budget.'));
    for (const s of rows) {
      const row = el('div', 'usage-row');
      row.dataset.state = s.state;
      row.dataset.kind = s.kind;
      const head = el('div', 'usage-row-head');
      const name = el('span', 'usage-row-name', s.label);
      if (s.detail) name.appendChild(el('span', 'usage-row-detail', s.detail));
      head.appendChild(name);
      head.appendChild(el('span', 'usage-row-value', valueText(s)));
      row.appendChild(head);
      const bar = el('div', 'sp-progress usage-row-bar');
      const fill = el('div', 'sp-progress-fill');
      fill.style.width = Math.min(100, s.reached ? 100 : s.pct) + '%';
      bar.appendChild(fill);
      row.appendChild(bar);
      const foot = [resetText(s), s.readOnly ? 'Set when the run was started' : ''].filter(Boolean).join(' · ');
      if (foot) row.appendChild(el('div', 'usage-row-foot', foot));
      panel.appendChild(row);
    }
    const prefs = el('button', 'tb-menu-item usage-panel-prefs', 'Usage preferences');
    prefs.type = 'button';
    prefs.addEventListener('click', () => { closePanel(); openPrefs('usage'); });
    panel.appendChild(prefs);
  }

  function paintBell() {
    const state = last ? last.overall : 'ok';
    const n = unread.size;
    bell.dataset.state = state;
    countEl.hidden = !n;
    countEl.textContent = n ? String(n) : '';
    const label = n ? `Usage limits: ${n} unread ${n === 1 ? 'notification' : 'notifications'}` : 'Usage limits';
    bell.title = label;
    bell.setAttribute('aria-label', label);
  }

  function chatTab(tabId) {
    const tab = TABS.get(tabId) || TABS.get(activeTabId);
    return tab && tab.mode === 'chat' && tab.chat ? tab : null;
  }

  function toastFor(s) {
    const title = s.kind === 'context' ? 'Context is getting full' : s.inferred ? 'Possible limit' : s.state === 'reached' ? 'Limit reached' : 'Usage warning';
    const msg = [s.label + (s.detail ? ' (' + s.detail + ')' : '') + ': ' + valueText(s), resetText(s)].filter(Boolean).join('. ');
    const card = notify(msg, { key: TOAST_KEY, kind: s.state === 'reached' ? 'error' : 'warn', title, ttl: 12000 });
    if (!card) return;
    const body = card.querySelector('.toast-body');
    if (!body) return;
    const old = body.querySelector('.usage-toast-actions');
    if (old) old.remove();
    const actions = el('div', 'usage-toast-actions');
    const add = (label, fn) => {
      const b = el('button', 'toast-action', label);
      b.type = 'button';
      b.addEventListener('click', () => { acknowledge(s.id); try { fn(); } catch (_) {} dismissNotif(card); });
      actions.appendChild(b);
    };
    const tab = chatTab(s.tabId);
    if (typeof window.huskMoveDiscussion === 'function' && tab) {
      add('Change vendor', () => {
        if (tab.id !== activeTabId) activateTab(tab.id);
        setPage('chat');
        window.huskMoveDiscussion(tab.id, tab.chat.el.querySelector('.chat-move-discussion') || bell);
      });
    }
    if (tab) add('Continue with another model', () => { if (tab.id !== activeTabId) activateTab(tab.id); setPage('chat'); setTimeout(() => tab.chat.openModelMenu(), 0); });
    add('Dismiss', () => {});
    const close = card.querySelector('.toast-close');
    if (close) close.onclick = () => acknowledge(s.id);
    body.appendChild(actions);
  }

  function refresh() {
    const c = conf();
    const next = M.evaluate(readings(Date.now()), { close: c.usageWarnPct, critical: c.usageCriticalPct }, Date.now());
    // An autopilot run reports its own halt, so its budget never raises a toast.
    const crossings = updateAlerts(next);
    const crossed = crossings.filter((s) => s.kind !== 'autopilot' && (s.kind !== 'plan' || s.detail === agentOf(TABS.get(activeTabId))));
    last = next;
    const sig = JSON.stringify(next.sources.map((s) => [s.id, s.state, Math.round(s.pct), s.used, s.limit, s.resetsAt, s.detail]));
    if (sig !== lastSig) {
      lastSig = sig;
      paintBell();
      if (!panel.hidden) paintPanel();
    }
    if (crossed.length) {
      const order = M.STATES;
      toastFor(crossed.reduce((a, b) => (order.indexOf(b.state) > order.indexOf(a.state) ? b : a)));
    }
    return next;
  }

  // ── sources fed from outside ──

  function onChatEvent(tab, ev) {
    if (!tab || !ev) return;
    const agent = agentOf(tab);
    const now = Date.now();
    if (ev.type === 'limit') {
      const windows = windowsOf(agent);
      windows.delete('plan');
      windows.delete('possible');
      for (const w of Array.isArray(ev.windows) ? ev.windows : []) windows.set(w.window, { window: w.window, pct: w.pct, resetsAt: w.resetsAt, at: now, src: 'cli' });
      if (ev.rejected) {
        const key = ev.window || 'plan';
        const cur = windows.get(key) || { window: key, pct: 0, at: now, src: 'cli' };
        const resetsAt = ev.resetsAt || cur.resetsAt || 0;
        windows.set(key, Object.assign({}, cur, { reached: true, resetsAt }));
      }
    } else if ((ev.type === 'error' || (ev.type === 'turn_end' && ev.isError)) && M.matchLimitPhrase(ev.text)) {
      if (!isReached(agent)) {
        windowsOf(agent).set('possible', { window: 'possible', pct: 0, resetsAt: 0, at: now, reached: true, inferred: true, src: 'cli' });
      }
    } else if (ev.type === 'turn_end' && !ev.isError) {
      windowsOf(agent).delete('possible');
    } else if (ev.type !== 'usage') return;
    refresh();
  }

  async function poll() {
    let r = null;
    try { r = await window.husk.usage.get(); } catch (_) {}
    if (!r) return;
    if (r.daily) daily = r.daily;
    for (const windows of plan.values()) {
      for (const [k, w] of windows) if (w.src === 'endpoint') windows.delete(k);
    }
    if (r.plan && r.plan.agent) {
      const windows = windowsOf(r.plan.agent);
      for (const w of r.plan.windows || []) {
        const cur = windows.get(w.window);
        // What the CLI said in chat stands until the endpoint has a newer sample.
        if (cur && cur.at > r.plan.at) continue;
        windows.set(w.window, { window: w.window, pct: w.pct, resetsAt: w.resetsAt, at: r.plan.at, src: 'endpoint', reached: !!(cur && cur.reached) });
      }
    }
    refresh();
  }

  // Null when Send may go ahead; otherwise a promise of the user's answer.
  function sendGate() {
    if (!conf().usageHardStop) return null;
    const hit = refresh().sources.filter((s) => s.kind === 'budget' && s.state === 'reached');
    if (!hit.length) return null;
    return openConfirmDialog({
      title: 'Daily budget reached',
      bodyHtml: `${escapeHtml(hit.map((s) => s.label + ': ' + valueText(s)).join('. '))}. It resets at local midnight. Send this message anyway?`,
      confirmLabel: 'Send anyway',
      cancelLabel: 'Cancel',
    });
  }

  // ── panel ──

  function closePanel() { panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); }
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!panel.hidden) { closePanel(); return; }
    refresh();
    paintPanel();
    panel.hidden = false;
    acknowledge();
    paintBell();
    bell.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', (e) => { if (!panel.hidden && !panel.contains(e.target) && !bell.contains(e.target)) closePanel(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closePanel(); });

  // ── preferences ──

  const $id = (id) => document.getElementById(id);
  function bindPrefs() {
    const c = conf();
    const t = M.normalizeThresholds({ close: c.usageWarnPct, critical: c.usageCriticalPct });
    if ($id('pref-usage-source')) $id('pref-usage-source').value = c.planUsageSource === 'cli' ? 'cli' : 'endpoint';
    if ($id('pref-usage-close')) $id('pref-usage-close').value = String(t.close);
    if ($id('pref-usage-critical')) $id('pref-usage-critical').value = String(t.critical);
    if ($id('pref-usage-tokens')) $id('pref-usage-tokens').value = c.usageBudgetTokens > 0 ? String(c.usageBudgetTokens) : '';
    if ($id('pref-usage-dollars')) $id('pref-usage-dollars').value = c.usageBudgetDollars > 0 ? String(c.usageBudgetDollars) : '';
    if ($id('pref-usage-hardstop')) $id('pref-usage-hardstop').checked = !!c.usageHardStop;
  }
  async function save(partial) {
    cfg = await window.husk.config.set(partial);
    bindPrefs();
    toast('Saved', 'success');
    await poll();
  }
  const onChange = (id, fn) => { const n = $id(id); if (n) n.addEventListener('change', (e) => { Promise.resolve(fn(e.target)).catch(() => {}); }); };
  onChange('pref-usage-source', (n) => save({ planUsageSource: n.value === 'cli' ? 'cli' : 'endpoint' }));
  onChange('pref-usage-hardstop', (n) => save({ usageHardStop: !!n.checked }));
  const threshold = (key) => (n) => {
    const c = conf();
    const want = Object.assign({ close: c.usageWarnPct, critical: c.usageCriticalPct }, { [key]: Number(n.value) });
    const got = M.normalizeThresholds(want);
    if (got[key] !== Number(n.value)) { bindPrefs(); toast('Enter a whole percent from 1 to 99, with the warning level below the critical level', 'error'); return null; }
    return save({ usageWarnPct: got.close, usageCriticalPct: got.critical });
  };
  onChange('pref-usage-close', threshold('close'));
  onChange('pref-usage-critical', threshold('critical'));
  const budget = (key) => (n) => {
    const raw = String(n.value || '').trim();
    const v = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(v) || v < 0) { bindPrefs(); toast('Enter a number, or leave it empty for no budget', 'error'); return null; }
    return save({ [key]: v });
  };
  onChange('pref-usage-tokens', budget('usageBudgetTokens'));
  onChange('pref-usage-dollars', budget('usageBudgetDollars'));

  if (window.husk.usage && window.husk.usage.onDaily) window.husk.usage.onDaily((d) => { if (d) { daily = d; refresh(); } });
  poll();
  setInterval(poll, 30000);
  // Context, autopilot ticks and reset times move without an event of their own.
  setInterval(refresh, 5000);

  window.HuskUsageBell = { onChatEvent, sendGate, bindPrefs, refresh, state: () => last };
})();
