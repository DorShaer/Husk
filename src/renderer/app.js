// Husk renderer orchestrator.
// Pages: chat, skills, sessions, files, preferences.
// Includes: command palette, theme toggle, drag overlay, status panel.

const $ = (s) => document.querySelector(s);
// Optional root scopes the query (onboarding passes its own overlay).
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// ─── Notifications ─────────────────────────────────────────────────────────
// A top-center stack of independent cards. Each slides in, auto-dismisses
// (errors linger longer), pauses on hover, and can be dismissed by hand.
// Newest sits on top and the stack is capped.
const NOTIF_MAX = 4;
const NOTIF_TTL = { error: 6500, warn: 5500, success: 4000, info: 4000, '': 4000 };
// Icon path sets (stroke, 24x24 viewBox), built with createElementNS.
const NOTIF_ICONS = {
  success: [['path', 'M20 6 9 17l-5-5']],
  error: [['circle', '12 12 9'], ['path', 'M12 8v4'], ['path', 'M12 16h.01']],
  warn: [['path', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'], ['path', 'M12 9v4'], ['path', 'M12 17h.01']],
  info: [['circle', '12 12 9'], ['path', 'M12 11v5'], ['path', 'M12 8h.01']],
  done: [['path', 'M22 11.08V12a10 10 0 1 1-5.93-9.14'], ['path', 'M22 4 12 14.01l-3-3']],
};
function notifSvg(name) {
  const spec = NOTIF_ICONS[name] || NOTIF_ICONS.info;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, data] of spec) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (tag === 'circle') { const [cx, cy, r] = data.split(' '); el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r); }
    else el.setAttribute('d', data);
    svg.appendChild(el);
  }
  return svg;
}
// Live cards that own a `key`. A repeat notification under the same key edits
// that card in place instead of stacking another one.
const keyedNotifs = new Map();
function dismissNotif(card) {
  if (!card || card._dismissing) return;
  card._dismissing = true;
  if (card._timer) clearTimeout(card._timer);
  if (card._key && keyedNotifs.get(card._key) === card) keyedNotifs.delete(card._key);
  card.classList.add('is-out');
  setTimeout(() => { try { card.remove(); } catch (_) {} }, 200);
}
// Core entry. opts: { title, kind, prominent, ttl, key }
function notify(message, opts = {}) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const kind = opts.kind || '';
  const iconName = opts.icon || (opts.prominent ? 'done' : (kind || 'info'));
  const existing = opts.key ? keyedNotifs.get(opts.key) : null;
  if (existing && !existing._dismissing && existing.isConnected) {
    return updateNotif(existing, message, { ...opts, kind, iconName });
  }
  const card = document.createElement('div');
  card.className = 'toast is-enter' + (kind ? ' ' + kind : '') + (opts.prominent ? ' is-prominent' : '');
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.appendChild(notifSvg(iconName));
  const body = document.createElement('div');
  body.className = 'toast-body';
  if (opts.title) {
    const t = document.createElement('div');
    t.className = 'toast-title';
    t.textContent = opts.title;
    body.appendChild(t);
  }
  const m = document.createElement('div');
  m.className = 'toast-msg';
  m.textContent = message;
  body.appendChild(m);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => dismissNotif(card));
  card.appendChild(icon);
  card.appendChild(body);
  card.appendChild(close);
  // Newest on top.
  stack.insertBefore(card, stack.firstChild);
  // Remove the entrance class so the card transitions in. The timeout backs
  // up rAF, which does not run in a background window.
  const reveal = () => card.classList.remove('is-enter');
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 60);
  // Cap the stack: dismiss the oldest live cards beyond the limit. Cards
  // animate out asynchronously, so iterate a snapshot of the live ones.
  const live = Array.from(stack.children).filter((c) => !c._dismissing);
  for (let i = NOTIF_MAX; i < live.length; i++) dismissNotif(live[i]);
  // Auto-dismiss with hover-to-pause. The ttl lives on the card so an in-place
  // update can restart the countdown with its own value.
  card._ttl = opts.ttl || NOTIF_TTL[kind] || NOTIF_TTL[''];
  const arm = () => { card._timer = setTimeout(() => dismissNotif(card), card._ttl); };
  card._arm = arm;
  arm();
  card.addEventListener('mouseenter', () => { if (card._timer) clearTimeout(card._timer); });
  card.addEventListener('mouseleave', () => { if (!card._dismissing) arm(); });
  if (opts.key) { card._key = opts.key; keyedNotifs.set(opts.key, card); }
  return card;
}
// Re-use a keyed card: swap the text, kind and icon, restart the countdown,
// and pulse once in place.
function updateNotif(card, message, opts) {
  const msg = card.querySelector('.toast-msg');
  if (msg) msg.textContent = message;
  const title = card.querySelector('.toast-title');
  if (title && opts.title) title.textContent = opts.title;
  for (const k of ['success', 'error', 'warn', 'info']) card.classList.toggle(k, opts.kind === k);
  const icon = card.querySelector('.toast-icon');
  if (icon) { icon.replaceChildren(notifSvg(opts.iconName)); }
  card._ttl = opts.ttl || NOTIF_TTL[opts.kind] || NOTIF_TTL[''];
  if (card._timer) clearTimeout(card._timer);
  if (!card.matches(':hover')) card._arm();
  card.classList.remove('is-bump');
  void card.offsetWidth;
  card.classList.add('is-bump');
  return card;
}
// Back-compatible API used across the renderer.
function toast(msg, kind = '') { notify(msg, { kind }); }
// Toast with a single action button. Used when the message alone is a dead
// end and the next action is explicit (e.g. missing agent binary -> open setup).
function toastAction(msg, actionLabel, onAction, kind = 'error') {
  const card = notify(msg, { kind, ttl: 30000 });
  if (!card) return;
  const body = card.querySelector('.toast-body');
  if (!body) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  btn.addEventListener('click', () => { try { onAction(); } catch (_) {} dismissNotif(card); });
  body.appendChild(btn);
}
// Skill, plugin and MCP changes reach a session only when it starts, so the
// notice that asks for a restart carries the restart action itself.
function toastRestart(message, kind = 'success') {
  toastAction(`${message} · restart the agent to apply`, 'Restart agent', async () => {
    setPage('chat');
    await restartPty();
  }, kind);
}
// Run-completion notification: a prominent card with a title.
function runEndBanner(msg, kind = '') {
  // Map the run outcome to a notification style.
  const k = kind === 'budget' ? 'warn' : (kind === 'stopped' ? '' : 'success');
  notify(msg, { kind: k, prominent: true, title: 'Autopilot run', icon: kind === 'budget' ? 'warn' : 'done', ttl: 6000 });
}

// ─── Confirm dialog ─────────────────────────────────────────────────────────
// Reusable destructive-action confirmation modal that names what is about to
// be deleted. Resolves true on confirm, false on cancel/escape/backdrop.
function openConfirmDialog({ title = 'Are you sure?', bodyHtml = '', confirmLabel = 'Delete', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const bodyEl = document.getElementById('confirm-body');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    if (!modal || !titleEl || !bodyEl || !okBtn || !cancelBtn) {
      // Fallback for when the modal elements are not in the DOM yet.
      // window.confirm shows plain text, so reduce bodyHtml to its text
      // nodes through an inert DOMParser document first.
      const parsed = new DOMParser().parseFromString(String(bodyHtml || ''), 'text/html');
      const plain = (parsed.body && parsed.body.textContent) || '';
      resolve(window.confirm(title + '\n\n' + plain));
      return;
    }
    titleEl.textContent = title;
    // eslint-disable-next-line no-unsanitized/property -- callers must escape interpolations.
    bodyEl.innerHTML = bodyHtml;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    // Focus returns to the caller's element once the dialog resolves.
    const prev = document.activeElement;
    modal.hidden = false;
    // Cancel starts focused; Enter confirms once the user tabs to it.
    setTimeout(() => { try { cancelBtn.focus(); } catch (_) {} }, 30);

    const cleanup = (result) => {
      modal.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        try { prev.focus({ preventScroll: true }); } catch (_) {}
      }
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { cleanup(false); return; }
      // Tab cycles between the two buttons.
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const stops = [cancelBtn, okBtn];
      const i = stops.indexOf(document.activeElement);
      const step = e.shiftKey ? stops.length - 1 : 1;
      stops[((i < 0 ? 0 : i) + step) % stops.length].focus();
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ─── Sanity ──────────────────────────────────────────────────────────────────────
window.addEventListener('error', (e) => {
  console.error('UNCAUGHT', e.message, e.filename, e.lineno);
  toast(`Error: ${e.message}`, 'error');
});

if (typeof Terminal === 'undefined' || typeof window.husk === 'undefined') {
  document.body.insertAdjacentHTML('afterbegin',
    '<div style="position:fixed;inset:0;background:#0c0a09;color:#fb7185;padding:24px;font-family:monospace;z-index:9999">Init failure: xterm or husk API not loaded.</div>');
  throw new Error('init failure');
}

// ─── State ───────────────────────────────────────────────────────────────────────
let cfg = null;
let huskHome = '~';
let lastStats = null;
// Last non-empty context-window reading, kept so the Usage panel never flickers
// the block out on a transient poll (see refreshStatusline).
let lastGoodCtx = null;
const RELOAD_STATE_KEY = 'husk:reload-state';
const ROUTE_STATE_KEY = 'husk:route-state';
const VALID_PAGES = new Set(['chat', 'agents', 'workflows', 'autopilot', 'projects', 'prompts', 'skills', 'sessions', 'files', 'mcp', 'plugins', 'prefs']);
let bootingFromReloadState = null;

function normalizePageName(name) {
  return VALID_PAGES.has(name) ? name : 'chat';
}

function readStoredState(key, remove = false) {
  try {
    const raw = sessionStorage.getItem(key) || localStorage.getItem(key);
    if (remove) {
      try { sessionStorage.removeItem(key); } catch (_) {}
      try { localStorage.removeItem(key); } catch (_) {}
    }
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state || Date.now() - Number(state.ts || 0) > 60_000) return null;
    state.page = normalizePageName(state.page);
    return state;
  } catch (_) { return null; }
}

function writeStoredState(key, state) {
  try {
    const restorePage = bootingFromReloadState && bootingFromReloadState.page;
    const page = normalizePageName(restorePage || currentPage);
    const tabId = restorePage ? (bootingFromReloadState.activeTabId || activeTabId) : activeTabId;
    const payload = JSON.stringify({
      page,
      activeTabId: tabId,
      ts: Date.now(),
      suppressAutoChat: !!(state && state.suppressAutoChat),
    });
    sessionStorage.setItem(key, payload);
    localStorage.setItem(key, payload);
    if (key === ROUTE_STATE_KEY && window.husk && window.husk.ui && window.husk.ui.setRouteState) {
      window.husk.ui.setRouteState({ page, activeTabId: tabId }).catch(() => {});
    }
  } catch (_) {}
}

function saveRouteState() { writeStoredState(ROUTE_STATE_KEY, { suppressAutoChat: false }); }
function saveReloadState() { writeStoredState(RELOAD_STATE_KEY, { suppressAutoChat: true }); }

function takeReloadState() {
  return readStoredState(RELOAD_STATE_KEY, true);
}

function reloadRendererPreservingPlace() {
  saveReloadState();
  window.location.reload();
}

const initialRouteState = readStoredState(RELOAD_STATE_KEY, false) || readStoredState(ROUTE_STATE_KEY, false);
let currentPage = normalizePageName((initialRouteState && initialRouteState.page) || 'chat');
let chatHasInput = false;

// The context pane speaks about a chat session: its folder, its working tree,
// the files handed to it. Only the chat has one, so every other page takes that
// width for its own content.
const CONTEXT_PANE_PAGES = new Set(['chat']);

function applyPageShell(name) {
  const page = normalizePageName(name);
  document.body.dataset.page = page;
  document.body.dataset.contextPane = CONTEXT_PANE_PAGES.has(page) ? 'on' : 'off';
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== page; });
  $$('.rail-item').forEach((it) => it.classList.toggle('active', it.dataset.page === page));
}
applyPageShell(currentPage);

// ─── Tabs: one PTY-backed terminal per chat tab, all live in parallel ────────
// Each tab owns its own xterm instance + FitAddon + DOM pane, keyed by the
// sessionId shared with the main process. Only the active pane is shown; the
// rest keep running and retain full scrollback. `term` / `fitAddon` point at
// the active tab, which is what the terminal-bound handlers below operate on.
const TABS = new Map();
let activeTabId = null;
let tabSeq = 0;
let term = null;
let fitAddon = null;

// Route URL clicks through the OS browser via shell.openExternal, behind
// Husk's confirm dialog so the user sees the destination first. Covers both
// WebLinksAddon plain-text URLs and OSC 8 hyperlinks via linkHandler. Returns
// truthy immediately so xterm's own fallback stays out of it; the confirm
// resolves asynchronously.
function openTerminalLink(_event, uri) {
  if (typeof uri === 'string' && /^https?:\/\//i.test(uri)) {
    openConfirmDialog({
      title: 'Open link in your browser?',
      bodyHtml: `Husk is about to open this URL in your default browser:<br/><br/><code style="word-break:break-all;">${escapeHtml(uri)}</code><br/><br/>Only open links you trust.`,
      confirmLabel: 'Open link',
      cancelLabel: 'Cancel',
    }).then((ok) => {
      if (!ok) return;
      try { window.husk.urls.openExternal(uri); } catch (_) {}
    });
  }
  return true;
}

function newTabId() { return 't' + (++tabSeq) + '_' + Date.now().toString(36); }

// Spin up a fresh terminal pane + xterm instance for a new chat tab. Does not
// start the PTY (caller does) or activate it (caller does).
function createTab(idOverride) {
  // idOverride reattaches a reloaded tab to an existing main-process PTY that
  // was created under this exact id before the reload.
  const id = idOverride || newTabId();
  const el = document.createElement('div');
  el.className = 'term-pane';
  el.dataset.sessionId = id;
  $('#terminal').appendChild(el);
  const t = new Terminal({
    cursorBlink: true,
    // When the terminal is not focused, draw no cursor instead of xterm's
    // default hollow outline block, which reads as a stray artifact.
    cursorInactiveStyle: 'none',
    fontFamily: '"JetBrains Mono", "Fira Code", "Menlo", "Consolas", monospace',
    fontSize: 13,
    theme: themeForXterm(),
    minimumContrastRatio: contrastForXterm(),
  });
  const fa = new FitAddon.FitAddon();
  t.loadAddon(fa);
  t.loadAddon(new WebLinksAddon.WebLinksAddon(openTerminalLink));
  t.options.linkHandler = { activate: openTerminalLink };
  guardTermColors(t);
  t.open(el);
  const tab = {
    id, term: t, fitAddon: fa, el,
    mouseOn: false, chatHasInput: false, restarting: false,
    // exited flips when this tab's agent process ends, and back when one starts
    // in its place. command is the line that started it, which is where a
    // pinned model is named.
    exited: false,
    command: null,
    // title is the auto-derived name (agent session title, else this default).
    // customTitle, when set, is the user's rename and wins over title.
    // agentId links this tab to its claude session once resolved.
    title: `Chat ${TABS.size + 1}`,
    customTitle: null,
    // titleEarned flips once the session's generated name is adopted;
    // promptSent marks the first submitted prompt, which is when the name
    // starts brewing (between the two the tab shows a thinking indicator).
    titleEarned: false,
    promptSent: false,
    agentId: null,
    resumeAttempt: null,
    writeBuf: '', flushScheduled: false,
  };
  // Keystrokes typed in this tab go to its own session.
  t.onData((d) => {
    tab.chatHasInput = true;
    chatHasInput = true;
    $('#chat-empty').classList.remove('show');
    if (/[\r\n]/.test(d)) {
      armRecap();
      if (!tab.promptSent) { tab.promptSent = true; renderTabStrip(); }
    }
    window.husk.pty.write(d, id);
    t.scrollToBottom();
  });
  t.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key || '').toLowerCase() === 'r') {
      refreshFromShortcut();
      return false;
    }
    const meta = isMac ? e.metaKey : (e.ctrlKey && e.shiftKey);
    if (meta && (e.key === 'c' || e.key === 'C')) {
      if (t.hasSelection()) { copyTerminalSelection(); return false; }
    }
    return true;
  });
  TABS.set(id, tab);
  return tab;
}

// Show one tab, hide the rest, and re-point the active-tab pointers so the
// shared handlers operate on it.
function activateTab(id) {
  const tab = TABS.get(id);
  if (!tab) return;
  // Drop the cached context reading so the next poll shows the newly-focused
  // session's window, never the previous tab's stale number.
  if (activeTabId !== id) lastGoodCtx = null;
  activeTabId = id;
  term = tab.term;
  fitAddon = tab.fitAddon;
  agentMouseOn = !!tab.mouseOn;
  chatHasInput = tab.chatHasInput;
  for (const t of TABS.values()) t.el.classList.toggle('show', t.id === id);
  renderTabStrip();
  fitNow();
  try { term.focus(); } catch (_) {}
  // Refresh the status panel for the newly focused tab. Switch the main
  // process's active session first so stats:get resolves this tab's
  // transcript, then fetch and render fresh stats.
  Promise.resolve(window.husk.pty.setActive(id))
    .then(() => refreshStats())
    .then(() => refreshStatusline())
    .then(() => refreshTopbarAgents())
    .catch(() => {});
}

// The tab already showing a session, when there is one.
//
// A session is one conversation with one transcript, so opening it twice is not
// two views of it: it is two readers, and the CLI refuses the second for the
// same reason a background agent's session cannot be resumed. What the user
// gets from a second press is either a refusal or a pair of tabs that disagree,
// and what they wanted was the one they already have.
//
// A provisional id is the resolver's guess at which session a fresh chat turned
// into, and it is revised. Matching on one would focus a tab that turns out to
// be a different conversation, so only a settled id counts as identity.
function tabForSession(sessionId) {
  const id = String(sessionId || '');
  if (!id) return null;
  for (const t of TABS.values()) {
    if (t.agentId === id && !t.agentIdProvisional) return t;
  }
  return null;
}

// Focus rather than open, when the session is already on screen. Returns
// whether it handled the request, so a caller can go on to open it if not.
//
// A tab whose agent has exited still counts. It is the same conversation, it
// still holds the scrollback the user is looking for, and it carries Restart;
// opening a second one beside it would leave two tabs claiming one session.
function focusOpenSession(sessionId) {
  const tab = tabForSession(sessionId);
  if (!tab) return false;
  closeDetail();
  setPage('chat');
  activateTab(tab.id);
  toast('That chat is already open', 'success');
  return true;
}

// Wheel forwarding for full-screen agents. A TUI running in the alternate
// screen keeps no terminal scrollback and turns mouse reporting on to scroll
// its own transcript, so when reporting is on the wheel is forwarded to it and
// otherwise xterm scrolls its own scrollback. Capture phase + passive:false to
// run ahead of xterm and preventDefault.
let agentMouseOn = false;
window.husk.pty.onMouseMode((sessionId, on) => {
  const tab = TABS.get(sessionId);
  if (tab) tab.mouseOn = !!on;
  if (sessionId === activeTabId) agentMouseOn = !!on;
});
$('#terminal').addEventListener('wheel', (e) => {
  if (!agentMouseOn || !term) return;
  const tab = TABS.get(activeTabId);
  const screen = tab && tab.el.querySelector('.xterm-screen');
  if (!screen) return;
  const rect = screen.getBoundingClientRect();
  const cw = rect.width / term.cols || 1;
  const ch = rect.height / term.rows || 1;
  let col = Math.floor((e.clientX - rect.left) / cw) + 1;
  let row = Math.floor((e.clientY - rect.top) / ch) + 1;
  col = Math.min(Math.max(col, 1), term.cols);
  row = Math.min(Math.max(row, 1), term.rows);
  window.husk.pty.wheel({ deltaY: e.deltaY, deltaMode: e.deltaMode, col, row }, activeTabId);
  e.preventDefault();
  e.stopPropagation();
}, { capture: true, passive: false });

// Auto-scroll while drag-selecting. xterm scrolls the viewport only once the
// pointer leaves the screen element, so a band at each edge re-sends the move
// with a clamped Y and xterm runs its own drag-scroll, which extends the
// selection as it goes. A TUI that draws its own viewport keeps no terminal
// scrollback, so there the wheel is forwarded to the agent instead.
const DRAG_EDGE_PX = 24;
const DRAG_EDGE_MS = 60;
let selDragging = false;
let selSynthetic = false;
let selEdge = null;          // { x, y, dir } while the pointer sits in an edge band
let selEdgeTimer = null;

function selEdgeStop() {
  if (selEdgeTimer) { clearInterval(selEdgeTimer); selEdgeTimer = null; }
  selEdge = null;
}

// One scroll step, repeated on a timer so holding still keeps scrolling: a
// stationary pointer fires no further mousemove of its own.
function selEdgeTick() {
  if (!selDragging || !selEdge) { selEdgeStop(); return; }
  const tab = TABS.get(activeTabId);
  const screen = tab && tab.el.querySelector('.xterm-screen');
  if (!screen || !term) return;
  const r = screen.getBoundingClientRect();
  // Prefer xterm's own scroller whenever it has somewhere to go, since only
  // xterm grows the selection as it scrolls. The alternate screen holds no
  // scrollback, so there the agent is the only thing that can move.
  const buf = term.buffer.active;
  const xtermCanScroll = buf.type === 'normal'
    && (selEdge.dir < 0 ? buf.viewportY > 0 : buf.viewportY < buf.baseY);
  if (!xtermCanScroll && agentMouseOn) {
    // Agent owns the viewport: hand it wheel input on the same path the
    // wheel listener above uses.
    const cw = r.width / term.cols || 1;
    const ch = r.height / term.rows || 1;
    let col = Math.floor((selEdge.x - r.left) / cw) + 1;
    let row = Math.floor((selEdge.y - r.top) / ch) + 1;
    col = Math.min(Math.max(col, 1), term.cols);
    row = Math.min(Math.max(row, 1), term.rows);
    window.husk.pty.wheel({ deltaY: selEdge.dir * 120, deltaMode: 0, col, row }, activeTabId);
    return;
  }
  // Already past the edge: xterm scrolls on its own there.
  if (selEdge.y < r.top || selEdge.y > r.bottom) return;
  // xterm's drag-scroll amount is zero for a pointer inside the screen, so
  // feed it one that reads as outside and the selection keeps growing.
  const outsideY = selEdge.dir < 0
    ? r.top - 1 - (DRAG_EDGE_PX - (selEdge.y - r.top))
    : r.bottom + 1 + (DRAG_EDGE_PX - (r.bottom - selEdge.y));
  selSynthetic = true;
  try {
    screen.ownerDocument.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: selEdge.x, clientY: outsideY, buttons: 1, detail: 1,
    }));
  } finally { selSynthetic = false; }
}

// Capture phase, so the drag registers even if the event stops bubbling.
$('#terminal').addEventListener('mousedown', (e) => { if (e.button === 0) selDragging = true; }, true);
window.addEventListener('mouseup', () => { selDragging = false; selEdgeStop(); });
document.addEventListener('mousemove', (e) => {
  if (!selDragging || selSynthetic) return;
  const tab = TABS.get(activeTabId);
  const screen = tab && tab.el.querySelector('.xterm-screen');
  if (!screen) { selEdgeStop(); return; }
  const r = screen.getBoundingClientRect();
  const y = e.clientY;
  // Open-ended bands: anything at or beyond each edge keeps scrolling, so a
  // drag that overshoots the terminal still counts.
  let dir = 0;
  if (y < r.top + DRAG_EDGE_PX) dir = -1;
  else if (y > r.bottom - DRAG_EDGE_PX) dir = 1;
  if (!dir) { selEdgeStop(); return; }
  selEdge = { x: e.clientX, y, dir };
  if (!selEdgeTimer) selEdgeTimer = setInterval(selEdgeTick, DRAG_EDGE_MS);
});

// An agent that assumes it owns the window may set the terminal's default
// colours at startup: copilot probes with OSC 10;? / 11;? and then *sets* its
// own palette (e.g. OSC 11;#0D1117), which painted the canvas dark-on-light
// until the next reload dropped the scrollback. The canvas colours belong to
// the Husk theme, so colour sets are swallowed while pure `?` queries fall
// through to xterm, whose answer carries the theme's real colours, and that
// answer is how the agent detects light or dark.
function guardTermColors(t) {
  const queryOnly = (data) => String(data).split(';').every((p) => p.trim() === '?');
  for (const code of [10, 11, 12]) {
    try { t.parser.registerOscHandler(code, (data) => !queryOnly(data)); } catch (_) {}
  }
}

function themeForXterm() {
  // Canvas background/foreground come from the active theme's --term-bg /
  // --term-fg tokens, and the ANSI set is the light or dark one depending on
  // --term-light. Read after body[data-theme] is set.
  const cs = getComputedStyle(document.body);
  const accent = cs.getPropertyValue('--accent').trim() || '#ff7847';
  const isLight = cs.getPropertyValue('--term-light').trim() === '1';
  const bg = cs.getPropertyValue('--term-bg').trim() || (isLight ? '#ffffff' : '#0c0a09');
  const fg = cs.getPropertyValue('--term-fg').trim() || (isLight ? '#1f2328' : '#e6e9ef');
  const ansi = isLight
    ? {
        // Dark, saturated colors readable on a light background; brightBlack
        // lands as a mid grey so agent hint text stays legible.
        selectionBackground: '#cfe3ff',
        black: '#1f2328', red: '#cf222e', green: '#116329', yellow: '#7d4e00',
        blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
        brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
        brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#8250df',
        brightCyan: '#1b7c83', brightWhite: '#1f2328',
      }
    : {
        selectionBackground: '#3a342c',
        black: '#0c0a09', red: '#fb7185', green: '#4ade80', yellow: '#fbbf24',
        blue: '#818cf8', magenta: '#a78bfa', cyan: '#67e8f9', white: '#e6e9ef',
        brightBlack: '#475063', brightRed: '#fda4af', brightGreen: '#86efac',
        brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#c4b5fd',
        brightCyan: '#a5f3fc', brightWhite: '#f1f5f9',
      };
  return { background: bg, foreground: fg, cursor: accent, cursorAccent: bg, ...ansi };
}

// Minimum contrast ratio for xterm. An agent CLI emits 256-colour and
// truecolour codes chosen for a dark background, so on a light terminal xterm
// re-tones any foreground below this ratio against the real background. Dark
// themes keep xterm's default of 1, which leaves colours untouched.
function contrastForXterm() {
  return getComputedStyle(document.body).getPropertyValue('--term-light').trim() === '1' ? 4.5 : 1;
}

function fitNow() {
  if (currentPage !== 'chat') return;
  if (!fitAddon || !term) return;
  // Skip while the terminal is not laid out yet: fitting against a zero-size
  // box yields a degenerate resize.
  const host = term.element;
  if (host && (host.clientWidth === 0 || host.clientHeight === 0)) return;
  try {
    fitAddon.fit();
    const { cols, rows } = term;
    if (!cols || !rows) return;
    const tab = TABS.get(activeTabId);
    // Only resize the PTY when the geometry actually changed. A redundant
    // resize makes the agent's TUI redraw and drop unsent input-line text.
    if (tab && tab._cols === cols && tab._rows === rows) return;
    if (tab) { tab._cols = cols; tab._rows = rows; }
    window.husk.pty.resize({ cols, rows }, activeTabId);
  } catch (_) {}
}
// Refit on resize. A trailing debounce coalesces the rapid resize burst
// from a window drag into one fit so the terminal reflow stays smooth.
window.addEventListener('resize', debounce(fitNow, 80));
// Refit whenever the terminal container changes size, not only on a window
// 'resize', so sidebar toggles and post-paint layout settling stay covered.
try {
  const _termFitObserver = new ResizeObserver(debounce(fitNow, 80));
  const _termEl = $('#terminal');
  if (_termEl) _termFitObserver.observe(_termEl);
} catch (_) {}

// Copy / paste affordances for the embedded terminal.
//   - Right-click opens a small Copy / Paste / Select all menu.
//   - Ctrl+Shift+C (macOS: Cmd+C) copies the selection.
//   - Paste is native: xterm listens for the browser `paste` event on its
//     hidden textarea and routes the clipboard through onData, so no custom
//     key handler calls term.paste(). Ctrl+C stays SIGINT.
const isMac = (navigator.userAgentData && navigator.userAgentData.platform === 'macOS') ||
              /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
// Mark the platform so CSS can clear the macOS traffic-light controls, which
// overlay the top-left of the window under the hiddenInset title bar.
if (isMac) document.documentElement.setAttribute('data-platform', 'mac');

// The command macOS users run to clear the quarantine flag on the app.
const MAC_TRUST_CMD = 'xattr -dr com.apple.quarantine /Applications/Husk.app';

// Manual update command per install type, shown when the in-app update cannot
// complete. Keyed by package type so the command matches how Husk was installed.
const MANUAL_UPDATE_CMD = {
  deb: 'sudo apt update && sudo apt install --only-upgrade husk',
  rpm: 'sudo dnf upgrade husk',
};

// What's new highlights, keyed by version. Shown once per version (after an
// update, and at the end of the first-run flow). Bullets are trusted static
// strings; the <strong> lead-ins are intentional markup.
const WHATS_NEW = {
  '2.11.1': {
    items: [
      {
        title: 'Steadier file handling',
        body: 'Husk now opens a file once and works from that handle, so what it checked and what it reads are always the same file. This covers the statusline script, workflow files and their run logs, agent transcripts, and the folders Autopilot captures and restores.',
      },
      {
        title: 'Guides that stay in the frame',
        body: 'The workflow canvas guide keeps to the canvas on a short window instead of spilling over the toolbar.',
      },
    ],
  },
  '2.11.0': {
    items: [
      {
        title: 'A workflow travels as one file',
        body: 'Export writes the graph, what it needs, and its run history into a single file you can hand to anyone. Facts the file cannot prove are labelled as the author\u2019s claims, never dressed up as more.',
        media: 'assets/wn-2110-export.png',
        mediaAlt: 'The Export sheet over the workflows grid, showing the step graph and what travels in the file',
      },
      {
        title: 'Install a workflow you were handed',
        body: 'Open the file or fetch it from a repository URL. Husk recomputes the fingerprint, lists what the workflow expects to find, and a stranger\u2019s workflow stops at "Read this before it runs": nothing runs until you have read it.',
        media: 'assets/wn-2110-install.png',
        mediaAlt: 'The Install sheet reading a fetched workflow file: recomputed fingerprint, step graph and receipts',
      },
      {
        title: 'Receipts instead of promises',
        body: 'A shared workflow carries its record: how many runs, and whether the numbers match the log it shipped with. A receipt that contradicts itself is refused, not annotated.',
        media: 'assets/wn-2110-receipts.png',
        mediaAlt: 'The receipts record for an installed workflow: 31 runs, median duration, and the checks against this machine',
      },
      {
        title: 'Background agents on one board',
        body: 'Every agent across every project, filtered by Live, Running, Needs you and Finished, drawn as a spawn graph. Open one mid-run, stop it without losing its conversation, or delete a finished one with its worktree.',
        media: 'assets/wn-2110-agents.png',
        mediaAlt: 'The Agents board drawing a spawn graph, with one agent waiting on a human and its activity feed open',
      },
      {
        title: 'MCP servers install from a URL',
        body: 'Paste a repository URL and fetch, instead of cloning first. Per-project server choices now survive a restart, and Husk is stricter about what anything may execute, write or replace on your machine.',
        media: 'assets/wn-2110-mcp.png',
        mediaAlt: 'Install MCP servers from repo: a GitHub URL fetched and three servers found and listed',
      },
      {
        title: 'Kiro CLI is now supported in Husk',
        body: 'Kiro now appears beside Claude, Copilot, Codex, Aider and Gemini. Start a Kiro chat from the agent switcher, use Kiro in workflow steps and Autopilot runs, and pass model pins through Kiro\u2019s --model flag.',
        media: 'assets/wn-2110-kiro.png',
        mediaAlt: 'The Husk Chat page with Kiro CLI selected in the agent switcher',
      },
    ],
  },
  '2.10.2': {
    items: [
      {
        title: 'MCP servers you choose per project',
        body: 'Pick which servers each project runs. Anything you do not set follows the global list, so a project you never touch behaves exactly as it did before.',
      },
      {
        title: 'The Agents page is a roster',
        body: 'Grouped, searchable and filterable, with a reader pane for the system prompt. Arrows move the caret, Enter opens, Space pins.',
      },
      {
        title: 'Edit a prompt after writing it',
        body: 'Change a prompt in the pane you read it in. Renaming moves the file, and a name already in use is refused rather than overwriting.',
      },
      {
        title: 'Autopilot keeps the run log',
        body: 'Agent output survives the run ending, navigating away and restarting the app. Finished agents carry a View log action.',
      },
    ],
  },
  '2.10.1': {
    items: [
      {
        title: 'Agents a chat starts are visible',
        body: 'A chat can send agents off to work on their own. The topbar now says how many are running and how many are waiting on you, so you find them without knowing they exist.',
      },
      {
        title: 'Open an agent and keep talking',
        body: 'Press Alt+A, pick an agent, and land in its conversation. Running agents attach, finished ones resume, and the switcher tells them apart by what each is doing right now.',
      },
      {
        title: 'Agents sit under the chat that started them',
        body: 'The Sessions list groups them under their chat instead of listing them beside it, so one conversation is one row again.',
      },
      {
        title: 'The status panel names the right model',
        body: 'It reads the model you selected rather than guessing from whichever transcript was newest, so a resumed chat no longer reports a model it is not running.',
      },
    ],
  },
  '2.10.0': {
    items: [
      {
        title: 'Workflows start from a pattern',
        body: 'The page opens on the shapes that keep showing up in agent systems, wired and ready to edit. Fan work out to three reviewers, gate a release on the literal test output, or route to one specialist.',
        media: 'assets/wn-2100-workflows.png',
      },
      {
        title: 'The canvas explains itself',
        body: 'Every step opens a proper composer: a prompt editor that wraps, its own settings, and room to widen when you need it. A legend on the canvas says how to remove a node or a connection, so nothing is a guess.',
        media: 'assets/wn-2100-editor.png',
      },
      {
        title: 'Every project gets a workspace',
        body: 'Pin a folder and the board shows its branch, uncommitted work, sessions and runs at a glance. Open one and the whole picture is there in place, so you stop guessing which folder the agent is standing in.',
        media: 'assets/wn-2100-projects.png',
      },
      {
        title: 'Skills browse by source',
        body: 'Pick a folder on the left to see only its skills. Switch one on, or a whole source at once. Recently added shows what just arrived, and Import brings in a skill you already have, straight from disk.',
        media: 'assets/wn-2100-skills.png',
      },
      {
        title: 'Files follow the project you are in',
        body: 'The file tree opens on the project the agent is working in rather than a saved root, and Sessions lists only your real conversations instead of every background job that ever ran.',
        media: 'assets/wn-2100-files.png',
      },
    ],
  },
  '2.9.0': {
    media: 'assets/whatsnew-workflows.png',
    mediaAlt: 'A workflow of Plan, Implement, Review and Ship steps on the graph canvas',
    items: [
      "<strong>Workflows come alive as they run.</strong> Chain steps on the canvas, hit Run, and watch each one light up and pass the baton down the graph, live from the first run.",
      "<strong>Every step keeps its own terminal.</strong> Click any node to read exactly what that step did, during the run or long after it finishes.",
      "<strong>Sessions list only your real chats.</strong> Background work no longer clutters Recent and Sessions with look-alike entries, so one conversation is one row.",
      "<strong>One-line Windows install shows its work.</strong> The installer now reports download progress and tells you when the Setup window is waiting for you.",
    ],
  },
  '2.8.9': {
    items: [
      "<strong>Meet Kernel.</strong> Husk has a face. The pod cracks open on the welcome tour and the seed inside looks back at you. Poke it and see what happens.",
      "<strong>Install in one line, on any machine.</strong> The installer was rebuilt end to end for Linux, macOS and Windows, and Install updates from inside Husk now really does install and restart.",
      "<strong>Every agent shows its real model.</strong> The Autopilot lineup names the model each agent actually ran, with per-agent time, tokens, cost, and cache split.",
      "<strong>Pick models like a dispatcher.</strong> A Configure wizard sets Simple and Complex models per CLI, and the run log explains every routing decision. Trivial jobs stop going to the expensive model.",
      "<strong>Runs that stall end themselves.</strong> A progress governor halts idle or looping agents before they burn through your budget.",
      "<strong>Chats name themselves again.</strong> Titles land promptly, and Gemini sessions now carry history, naming and resume alongside the rest.",
      "<strong>Themes you can try on.</strong> A new install opens in light, every theme previews live in Preferences, and the old one no longer flashes at startup.",
      "<strong>Bug fixes.</strong> Agents installed through nvm are found, the icon is sharp at every size, light mode is readable, and a team run is one history entry.",
    ],
  },
  '2.8.8': {
    items: [
      "<strong>Install in one line.</strong> A single command sets Husk up on Linux and macOS, with checksums verified.",
      "<strong>apt install husk.</strong> Debian and Ubuntu can install from a signed repository and stay current with apt upgrade.",
      "<strong>Gemini support.</strong> Husk now runs the Gemini CLI alongside claude, copilot, codex, and aider.",
      "<strong>A status panel that fits your agent.</strong> Usage and model rows adapt to whichever agent you run, with readable model names.",
      "<strong>Windows startup fixed.</strong> Agents installed as a command shim now launch reliably.",
    ],
  },
  '2.8.7': {
    items: [
      "<strong>Autopilot mission control.</strong> Watch every agent think and act in its own live lane, with a fleet status strip and a readable run log.",
      "<strong>A usage meter you can trust.</strong> Time, tokens and spend show real consumption from the first second of a run.",
      "<strong>Run history you can manage.</strong> Open any past run, review its diffs at full width, and bulk-select runs to delete.",
      "<strong>Back and forward everywhere.</strong> Move between pages with the mouse back and forward buttons or Alt and the arrow keys, and close any dialog with Esc.",
      "<strong>Linux launch fixed.</strong> The Debian and Fedora packages now start correctly.",
    ],
  },
  '2.8.4': {
    items: [
      "<strong>A redesigned workspace.</strong> Collapsible labeled sidebar, a framed chat surface, and a calmer overall layout.",
      "<strong>Six themes.</strong> Dark, Light, Midnight, Nord, Dracula and Sepia, each with a matching terminal.",
      "<strong>A guided first run.</strong> Pick your CLI and your look in a quick welcome tour.",
      "<strong>One session per conversation.</strong> Continuing a chat no longer splits it into many entries.",
      "<strong>Trust this folder.</strong> One click lets the agent apply your saved permissions.",
    ],
  },
};
function whatsNewFor(version) {
  // Exact match only. A packaged release reports its real version; running
  // from source reports Electron's version, which has no entry here.
  return WHATS_NEW[version] || null;
}
// Highest version key in WHATS_NEW, for showing release notes on demand when
// the running version has no entry of its own.
function latestWhatsNewVersion() {
  const bySemver = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
    return 0;
  };
  return Object.keys(WHATS_NEW).sort(bySemver).pop() || '';
}
// Older entries are a flat list of strings with a bold lead-in. Both shapes
// render as slides, so replaying an old version still works.
function wnSlides(entry) {
  return (entry.items || []).map((item) => {
    if (typeof item !== 'string') return item;
    const m = /^<strong>(.*?)<\/strong>\s*(.*)$/s.exec(item);
    return m ? { title: m[1].replace(/\.$/, ''), body: m[2] } : { title: '', body: item };
  });
}
function showWhatsNew(version) {
  return new Promise((resolve) => {
    const entry = whatsNewFor(version);
    const page = $('#whatsnew');
    if (!entry || !page) { resolve(); return; }
    const slides = wnSlides(entry);
    if (!slides.length) { resolve(); return; }

    const stage = $('#wn-stage');
    const dots = $('#wn-dots');
    const backBtn = $('#wn-back');
    const skipBtn = $('#wn-skip');
    // eslint-disable-next-line no-unsanitized/property -- Slide copy is trusted static text.
    stage.innerHTML = slides.map((sl, i) => `
      <section class="ob-step wn-step" data-step="${i}"${i ? ' hidden' : ''}>
        <div class="wn-step-head">
          <div class="wn-eyebrow">Version ${escapeHtml(version)} · ${i + 1} of ${slides.length}</div>
          <h2 class="wn-title">${sl.title || "What's new in Husk"}</h2>
          <p class="wn-body">${sl.body || ''}</p>
        </div>
        ${sl.media ? `<img class="wn-shot" src="${escapeAttr(sl.media)}" alt="${escapeAttr(sl.mediaAlt || sl.title || '')}" />` : ''}
        <button class="btn-primary ob-cta wn-next" type="button" data-next="${i}">
          ${i === slides.length - 1 ? 'Start using Husk' : 'Next'} <span class="ob-nav-arrow">&#8594;</span>
        </button>
      </section>`).join('');
    // eslint-disable-next-line no-unsanitized/property -- Static markup, count only.
    dots.innerHTML = slides.map(() => '<span class="ob-dot"></span>').join('');
    const steps = $$('.wn-step', page);
    const dotEls = $$('.ob-dot', dots);

    const ac = new AbortController();
    const on = (el, ev, fn) => el && el.addEventListener(ev, fn, { signal: ac.signal });
    let step = 0;
    const show = (i) => {
      step = Math.max(0, Math.min(steps.length - 1, i));
      page.dataset.step = String(step);
      steps.forEach((sec, idx) => { sec.hidden = idx !== step; });
      dotEls.forEach((d, idx) => d.classList.toggle('active', idx === step));
      backBtn.hidden = step === 0;
      // The last slide's own button finishes, so Skip is hidden there.
      skipBtn.hidden = step === steps.length - 1;
      stage.scrollTop = 0;
    };
    const done = () => {
      ac.abort();
      page.hidden = true;
      resolve();
    };
    on(stage, 'click', (e) => {
      const btn = e.target.closest('.wn-next');
      if (!btn) return;
      if (step >= steps.length - 1) done(); else show(step + 1);
    });
    on(backBtn, 'click', () => show(step - 1));
    on(skipBtn, 'click', done);
    on(window, 'keydown', (e) => {
      if (page.hidden) return;
      if (e.key === 'Escape') done();
      else if (e.key === 'ArrowRight') show(step + 1);
      else if (e.key === 'ArrowLeft') show(step - 1);
    });

    page.hidden = false;
    show(0);
  });
}
async function copyTerminalSelection() {
  const text = term.getSelection();
  if (!text) return false;
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
}
async function pasteIntoTerminal() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
    return true;
  } catch (_) { return false; }
}
{
  const terminalEl = $('#terminal');
  const menu = document.createElement('div');
  menu.id = 'terminal-ctx-menu';
  menu.className = 'ctx-menu';
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" data-action="copy">Copy</button>
    <button type="button" data-action="paste">Paste</button>
    <button type="button" data-action="select-all">Select all</button>
  `;
  document.body.appendChild(menu);
  function hideMenu() { menu.hidden = true; }
  function showMenu(x, y) {
    menu.hidden = false;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 6) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - h - 6) + 'px';
    const copyBtn = menu.querySelector('[data-action="copy"]');
    if (copyBtn) copyBtn.disabled = !term.hasSelection();
  }
  terminalEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY);
  });
  menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    hideMenu();
    if (btn.dataset.action === 'copy') await copyTerminalSelection();
    else if (btn.dataset.action === 'paste') await pasteIntoTerminal();
    else if (btn.dataset.action === 'select-all') term.selectAll();
    // Return focus to the terminal after the menu action runs.
    try { term.focus(); } catch (_) {}
  });
  window.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (e.target.closest('#terminal-ctx-menu')) return;
    hideMenu();
  });
  window.addEventListener('keydown', (e) => {
    if (!menu.hidden && e.key === 'Escape') hideMenu();
  });
  window.addEventListener('blur', hideMenu);
}
// Small trailing debounce: coalesce rapid calls (search keystrokes) so
// an expensive repaint runs once the user pauses, not per character.
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

// Coalesce rapid preference writes. Each window.husk.config.set is a
// synchronous disk write, so apply the change optimistically to the local cfg
// and the DOM, then write the merged patch once the clicks settle.
let _pendingCfgPatch = null;
const _flushCfgPatch = debounce(async () => {
  const patch = _pendingCfgPatch; _pendingCfgPatch = null;
  if (!patch) return;
  try { cfg = await window.husk.config.set(patch); } catch (_) {}
}, 180);
function persistConfig(patch) {
  _pendingCfgPatch = Object.assign(_pendingCfgPatch || {}, patch);
  cfg = Object.assign({}, cfg, patch);
  _flushCfgPatch();
}

function appearanceSnapshot() {
  return {
    theme: cfg.theme || 'midnight',
    accent: cfg.accent || 'orange',
    railExpanded: cfg.railExpanded !== false,
  };
}
function restoreAppearanceSnapshot(snap) {
  applyTheme(snap.theme);
  applyAccent(snap.accent);
  document.body.dataset.rail = snap.railExpanded ? 'expanded' : 'collapsed';
  syncRailToggleTitle();
  bindPrefs();
  setTimeout(fitNow, 120);
}
// Appearance changes preview live and stay unsaved until the user commits.
// Each theme/accent/rail change applies to the DOM and accumulates in
// pendingAppearance; Save persists the merged patch, Revert restores.
let pendingAppearance = null;
function syncAppearanceActionsBar() {
  const el = $('#pref-appearance-actions');
  if (el) el.hidden = !pendingAppearance;
}
function previewAppearance(patch) {
  pendingAppearance = Object.assign(pendingAppearance || {}, patch);
  if ('theme' in patch) applyTheme(patch.theme);
  if ('accent' in patch) applyAccent(patch.accent);
  if ('railExpanded' in patch) {
    document.body.dataset.rail = patch.railExpanded ? 'expanded' : 'collapsed';
    syncRailToggleTitle();
    setTimeout(fitNow, 120);
  }
  // A preview that lands back on every saved value is not pending anymore.
  const saved = appearanceSnapshot();
  if (Object.keys(pendingAppearance).every((k) => pendingAppearance[k] === saved[k])) {
    pendingAppearance = null;
  }
  syncAppearanceActionsBar();
}
function revertAppearancePreview() {
  if (!pendingAppearance) return;
  pendingAppearance = null;
  restoreAppearanceSnapshot(appearanceSnapshot());
  syncAppearanceActionsBar();
}
async function saveAppearancePreview() {
  if (!pendingAppearance) return;
  const patch = pendingAppearance;
  pendingAppearance = null;
  try {
    cfg = await window.husk.config.set(patch);
    // A theme reaches every surface, so the saved appearance lands with a full
    // renderer reload that returns to the page it was saved from.
    reloadRendererPreservingPlace();
    return;
  } catch (err) {
    restoreAppearanceSnapshot(appearanceSnapshot());
    toast(`Could not save appearance: ${(err && err.message) || err}`, 'error');
  }
  bindPrefs();
  syncAppearanceActionsBar();
}

// Coalesce a tab's PTY output into one xterm write per animation frame, so a
// burst of chunks costs a single write, scroll and speech scan. Each tab owns
// its own buffer.
function _flushTabWrite(tab) {
  tab.flushScheduled = false;
  if (!tab.writeBuf) return;
  const data = tab.writeBuf;
  tab.writeBuf = '';
  const t = tab.term;
  // Follow the tail only when the viewport is already pinned to the bottom,
  // so reading further up survives a streaming agent. In the alt screen
  // viewportY and baseY are both 0, which keeps it pinned.
  const buf = t.buffer.active;
  const wasAtBottom = buf.viewportY >= buf.baseY;
  t.write(data, () => { if (wasAtBottom) t.scrollToBottom(); });
  // Only the focused tab drives voice, so background agents stay silent.
  if (tab.id === activeTabId) detectAndSpeak();
}

function stripTerminalControls(s) {
  return String(s || '')
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function resumeRejectedOutput(text) {
  const t = stripTerminalControls(text);
  return /No session, task, or name matched/i.test(t)
    || /No conversation found with session ID/i.test(t)
    || /No conversation found/i.test(t);
}

// A different refusal with a different fix. The session exists and is healthy;
// a background agent is holding it, so the CLI will not open a second reader on
// the same transcript. The command that opens a session is chosen against the
// live agent list before it is spawned, so reaching this means the agent
// claimed the session in the moment between the two, and the answer is the
// branch the CLI itself names rather than a closed tab.
function resumeHeldByAgentOutput(text) {
  const t = stripTerminalControls(text);
  return /is currently running as a background agent/i.test(t)
    || (/--fork-session/.test(t) && /background agent/i.test(t));
}

async function closeRejectedResumeTab(tab) {
  if (!tab || !tab.resumeAttempt || tab.resumeAttempt.failureHandled) return;
  tab.resumeAttempt.failureHandled = true;
  tab.restarting = true;
  tab.writeBuf = '';
  const agent = tab.resumeAttempt.agent || 'session';
  const id = tab.resumeAttempt.id ? ` ${String(tab.resumeAttempt.id).slice(0, 8)}` : '';
  const header = tab.resumeAttempt.previousHeader || null;
  if (header && Object.prototype.hasOwnProperty.call(header, 'subBase')) setChatSubBase(header.subBase);
  toast(`${agent}${id} is not resumable yet; refreshed sessions`, 'error');
  await closeTab(tab.id);
  try { await refreshRecentList(); } catch (err) { console.warn('recent refresh after rejected resume failed', err); }
  if (currentPage === 'sessions') {
    try { await renderSessions(); } catch (err) { console.warn('sessions refresh after rejected resume failed', err); }
  }
}

// The session is alive and busy, so the tab closes and the two commands that do
// work are offered by name. Nothing is retried automatically: attaching joins
// running work and forking starts a copy, and which of those somebody wants is
// not a thing to guess on their behalf.
async function closeHeldResumeTab(tab) {
  if (!tab || !tab.resumeAttempt || tab.resumeAttempt.failureHandled) return;
  tab.resumeAttempt.failureHandled = true;
  tab.restarting = true;
  tab.writeBuf = '';
  const d = { id: tab.resumeAttempt.id, project: tab.resumeAttempt.cwd || '', owner: tab.resumeAttempt.agent };
  const header = tab.resumeAttempt.previousHeader || null;
  if (header && Object.prototype.hasOwnProperty.call(header, 'subBase')) setChatSubBase(header.subBase);
  await closeTab(tab.id);
  if (typeof toastAction === 'function') {
    toastAction('An agent is running that session', 'Attach to it',
      () => resumeSessionInChat(d), 'error');
  } else {
    toast('An agent is running that session', 'error');
  }
  try { await refreshRecentList(); } catch (err) { console.warn('recent refresh after held resume failed', err); }
  if (currentPage === 'sessions') {
    try { await renderSessions(); } catch (err) { console.warn('sessions refresh after held resume failed', err); }
  }
}

function captureResumeFailure(tab, data) {
  if (!tab || !tab.resumeAttempt || tab.resumeAttempt.failureHandled) return false;
  const age = Date.now() - (tab.resumeAttempt.startedAt || 0);
  if (age > 20000) { tab.resumeAttempt = null; return false; }
  tab.resumeAttempt.tail = ((tab.resumeAttempt.tail || '') + String(data || '')).slice(-4096);
  if (resumeHeldByAgentOutput(tab.resumeAttempt.tail)) {
    closeHeldResumeTab(tab).catch((err) => console.warn('closing held resume tab failed', err));
    return true;
  }
  if (!resumeRejectedOutput(tab.resumeAttempt.tail)) return false;
  closeRejectedResumeTab(tab).catch((err) => console.warn('closing rejected resume tab failed', err));
  return true;
}

window.husk.pty.onData((sessionId, d) => {
  const tab = TABS.get(sessionId) || (!sessionId ? TABS.get(activeTabId) : null);
  if (!tab || tab.restarting) return;
  if (captureResumeFailure(tab, d)) return;
  if (tab.id === activeTabId && !chatHasInput) {
    chatHasInput = true;
    $('#chat-empty').classList.remove('show');
  }
  tab.chatHasInput = true;
  tab.writeBuf += d;
  if (!tab.flushScheduled) { tab.flushScheduled = true; requestAnimationFrame(() => _flushTabWrite(tab)); }
});
window.husk.pty.onExit((sessionId, code) => {
  const tab = TABS.get(sessionId);
  // Skip the exit notice while this tab's PTY is being torn down on purpose.
  if (!tab || tab.restarting) return;
  tab.exited = true;
  refreshShellStatusBar();
  if (code === 127) {
    // 127 = shell could not find the agent binary; route the user to setup.
    const cmd = (cfg && cfg.agentCommand || 'the agent').split(/\s+/)[0];
    tab.term.writeln(`\r\n\x1b[38;2;244;63;94m[${cmd} was not found on this system]\x1b[0m`);
    tab.term.writeln(`\x1b[38;2;106;115;133mInstall it or pick a different CLI from the setup wizard.\x1b[0m`);
    toastAction(`${cmd} is not installed`, 'Open setup', () => runOnboarding({ replay: true }));
    return;
  }
  tab.term.writeln(`\r\n\x1b[38;2;106;115;133m[agent exited code ${code}; click ↻ Restart]\x1b[0m`);
});

function announceInTerminal(msg) {
  if (term) term.writeln(`\r\n\x1b[38;2;103;232;249m▸ ${msg}\x1b[0m`);
}

// Rebuild the open chats after a renderer reload, where the main-process PTYs
// are still alive. A resumable agent session is reopened with its resume form
// in a fresh PTY, which re-renders the full history; everything else keeps its
// live process and reattaches. Returns true if any chat was restored.
async function reattachSessions() {
  let live;
  try { live = await window.husk.pty.list(); } catch (_) { live = null; }
  if (!live || !live.ok || !Array.isArray(live.sessions) || !live.sessions.length) return false;
  $('#chat-empty').classList.remove('show');
  const agent = (cfg && cfg.agentCommand ? cfg.agentCommand : 'claude').trim().split(/\s+/)[0].toLowerCase();
  let activeTab = null;
  for (const sess of live.sessions) {
    let tab = null;
    // Close-and-resume only when the active agent has a resume form;
    // otherwise the live PTY is kept and reattached below.
    let resumeCmd = null;
    // Resume only when the transcript still exists, so a session that was
    // never written stays where it is.
    if (sess.claudeSessionId && sess.resumable) {
      try {
        const r = await window.husk.sessions.resumeCommand({ agent, id: sess.claudeSessionId, cwd: sess.cwd || '' });
        if (r && r.ok && r.command) resumeCmd = r.command;
      } catch (_) { /* no resume form for this agent: keep the live PTY below */ }
    }
    if (resumeCmd) {
      // Resume the conversation in a fresh PTY; drop the orphaned old one.
      try { await window.husk.pty.close(sess.sessionId); } catch (_) {}
      tab = await openNewChatTab({ command: resumeCmd, cwd: sess.cwd || null, skipContext: true });
      if (tab) {
        tab.agentId = sess.claudeSessionId;
        try {
          const res = await window.husk.sessions.resolveLiveTitle({ knownAgentId: sess.claudeSessionId });
          if (res && res.ok && res.title) {
            if (res.custom) tab.customTitle = res.title; else tab.title = res.title;
            tab.titleEarned = true;
          }
        } catch (_) {}
      }
    } else {
      // No resumable session id: keep the live process and reattach to it.
      tab = createTab(sess.sessionId);
      tab.chatHasInput = true;
      activateTab(tab.id);
      try { tab.fitAddon.fit(); } catch (_) {}
      try { await window.husk.pty.reattach({ sessionId: tab.id, cols: tab.term.cols || 100, rows: tab.term.rows || 30, activate: true }); } catch (_) {}
    }
    if (tab && (sess.active || !activeTab)) activeTab = tab;
  }
  if (activeTab) activateTab(activeTab.id);
  renderTabStrip();
  return true;
}

async function startPty() {
  // First tab + its session.
  const tab = createTab();
  activateTab(tab.id);
  fitAddon.fit();
  const { cols, rows } = term;
  // Auto-select: if nothing is active and a profile has autoSelect enabled, activate it.
  if (!getActiveProfileIds().length) {
    const autoProfile = profilesCache.find((p) => p.autoSelect);
    if (autoProfile) {
      await activateProfile(autoProfile.id);
      toast(`Agent auto-selected: ${autoProfile.name}`, '');
    }
  }
  // Launch always opens a fresh chat rather than resuming the last discussion.
  // Reopening a specific past conversation is an explicit action from the
  // Sessions list, not something the app does automatically on startup.
  tab.command = (cfg && cfg.agentCommand) || null;
  tab.exited = false;
  await window.husk.pty.start({ cols, rows, sessionId: tab.id, resumeLast: false });
  refreshShellStatusBar();
  term.focus();
  maybeShowTrustBanner();
  // Inject ai-suggested workflow context so the AI knows what workflows exist
  try {
    const wfCtx = await window.husk.workflows.getSessionContext();
    if (wfCtx) {
      setTimeout(() => {
        try { window.husk.pty.write(wfCtx + '\n', tab.id); } catch (_) {}
      }, 800);
    }
  } catch (_) {}
  // Snapshot which MCPs were enabled at launch so the MCP page can split
  // them into Loaded vs Pending, and the welcome screen can show what's live.
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
}

// Open a brand-new chat in its own tab, leaving every existing tab's agent
// running. Backs the "+ New Chat" action.
async function openNewChatTab(opts = {}) {
  const tab = createTab();
  if (opts.resumeAttempt) {
    tab.resumeAttempt = {
      agent: String(opts.resumeAttempt.agent || ''),
      id: String(opts.resumeAttempt.id || ''),
      // Carried so a refusal can rebuild the request it came from and offer the
      // command that would have worked, in the directory the session lives in.
      cwd: String(opts.resumeAttempt.cwd || ''),
      previousHeader: opts.resumeAttempt.previousHeader || null,
      startedAt: Date.now(),
      tail: '',
      failureHandled: false,
    };
  }
  activateTab(tab.id);
  fitAddon.fit();
  const { cols, rows } = tab.term;
  chatHasInput = false;
  resetSpeechState();
  clearSessionContext();
  tab.command = opts.command || (cfg && cfg.agentCommand) || null;
  tab.exited = false;
  await window.husk.pty.start({ cols, rows, command: opts.command || null, cwd: opts.cwd || null, sessionId: tab.id });
  refreshShellStatusBar();
  tab.term.focus();
  maybeShowTrustBanner();
  // skipWelcome: the caller is about to write into this chat, so painting the
  // welcome screen for a frame and pulling it straight back reads as a glitch.
  if (!(cfg && cfg.skipWelcome) && !opts.skipWelcome) $('#chat-empty').classList.add('show');
  // Do not inject the workflow-context primer into a resumed conversation: it
  // would land as a stray message mid-chat. Only fresh chats get it.
  if (!opts.skipContext) {
    try {
      const wfCtx = await window.husk.workflows.getSessionContext();
      if (wfCtx) setTimeout(() => { try { window.husk.pty.write(wfCtx + '\n', tab.id); } catch (_) {} }, 800);
    } catch (_) {}
  }
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
  renderTabStrip();
  return tab;
}

// Restart the agent in the ACTIVE tab, in place (same tab, same session id).
async function restartPty(opts = {}) {
  const tab = TABS.get(activeTabId);
  if (!tab) return;
  tab.restarting = true;
  fitAddon.fit();
  const { cols, rows } = tab.term;
  chatHasInput = false;
  tab.chatHasInput = false;
  resetSpeechState();
  clearSessionContext();
  // First wipe so any earlier scrollback is gone before kill output starts.
  try { tab.term.reset(); } catch (_) { try { tab.term.clear(); } catch (_) {} }
  tab.command = opts.command || (cfg && cfg.agentCommand) || null;
  tab.exited = false;
  await window.husk.pty.restart({ cols, rows, command: opts.command || null, cwd: opts.cwd || null, sessionId: tab.id });
  // Quiet window that lets the closing PTY drain its tail notice into the
  // suppressed handlers before output is re-enabled.
  await new Promise((r) => setTimeout(r, 200));
  // Second wipe, so the new PTY's banner starts on a clean canvas.
  try { tab.term.reset(); } catch (_) {}
  tab.restarting = false;
  refreshShellStatusBar();
  // Respect the "Don't show this on next launch" toggle on restart too.
  if (!(cfg && cfg.skipWelcome)) $('#chat-empty').classList.add('show');
  tab.term.focus();
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
  if (!opts.silent) toast('New session', 'success');
}

let lastShortcutReloadAt = 0;
function reloadFromShortcut() {
  const now = Date.now();
  if (now - lastShortcutReloadAt < 750) return;
  lastShortcutReloadAt = now;
  reloadRendererPreservingPlace();
}
function refreshFromShortcut() {
  const now = Date.now();
  if (now - lastShortcutReloadAt < 750) return;
  lastShortcutReloadAt = now;
  if (currentPage === 'chat') restartPty();
  else reloadRendererPreservingPlace();
}
function markReloadInPlace() {
  saveReloadState();
}
if (window.husk.shortcuts && window.husk.shortcuts.onReload) {
  window.husk.shortcuts.onReload(refreshFromShortcut);
}
if (window.husk.shortcuts && window.husk.shortcuts.onReloadInPlace) {
  window.husk.shortcuts.onReloadInPlace(markReloadInPlace);
}
if (window.husk.shortcuts && window.husk.shortcuts.onRestartAgent) {
  window.husk.shortcuts.onRestartAgent(() => { restartPty(); });
}

// Close one chat tab and reap its agent. Closing the last one opens a fresh
// chat behind it, as a new session with a new name.
async function closeTab(id) {
  const tab = TABS.get(id);
  if (!tab) return;
  try { await window.husk.pty.close(id); } catch (_) {}
  try { tab.term.dispose(); } catch (_) {}
  try { tab.el.remove(); } catch (_) {}
  TABS.delete(id);
  if (TABS.size === 0) { await openNewChatTab(); return; }
  if (activeTabId === id) {
    const next = TABS.keys().next();
    if (!next.done) activateTab(next.value);
  } else {
    renderTabStrip();
  }
}

// The name shown for a tab: the user's rename if set, else the generic
// per-tab default ("Chat 1", "Chat 2", ...).
function displayTitle(tab) {
  return (tab.customTitle || tab.title || '').trim() || 'Chat';
}

// ── Session-title presentation helpers ───────────────────────────────────────
// While a conversation waits for its generated name, titles show a breathing
// three-dot indicator; when the name lands it types in character by character.
// Used by the chat tab pill and the Recent chats rail so both stay in step.

// Placeholder titles carry no information; the UI treats them as "no name yet".
function sessionTitleUsable(title) {
  const t = String(title || '').trim();
  if (!t || t === '(empty)') return false;
  const lower = t.toLowerCase();
  if (lower.startsWith('new ') && lower.endsWith(' chat')) return false;
  if (lower === 'chat') return false;
  if (lower.startsWith('chat ') && /^\d+$/.test(lower.slice(5))) return false;
  return true;
}

const THINKING_DOTS_HTML = '<span class="title-thinking"><span></span><span></span><span></span></span>';
function showThinkingDots(el) {
  if (!el) return;
  if (el._twTimer) { clearInterval(el._twTimer); el._twTimer = null; }
  // eslint-disable-next-line no-unsanitized/property -- static indicator markup
  el.innerHTML = THINKING_DOTS_HTML;
}

// Type `full` into `el` character by character. A repaint during the
// animation simply shows the full text.
function typewriterTo(el, full, msPerChar = 30) {
  if (!el) return;
  if (el._twTimer) clearInterval(el._twTimer);
  const text = String(full || '');
  let i = 0;
  el.textContent = '';
  el._twTimer = setInterval(() => {
    i += 1;
    el.textContent = text.slice(0, i);
    if (i >= text.length) { clearInterval(el._twTimer); el._twTimer = null; }
  }, msPerChar);
}

// Swap a tab's label for an inline input so the user can rename the chat.
// Commit on Enter or blur; cancel on Escape. A custom name is persisted by
// agent session id (once the tab is linked) so it survives restarts.
function beginRename(tab, labelEl) {
  if (!tab || !labelEl || labelEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-tab-rename';
  input.value = displayTitle(tab);
  input.maxLength = 80;
  labelEl.textContent = '';
  labelEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const name = input.value.replace(/\s+/g, ' ').trim();
      tab.customTitle = name || null;
      if (tab.agentId) {
        try { window.husk.sessions.rename({ agentId: tab.agentId, name: name || '' }); } catch (_) {}
      }
    }
    renderTabStrip();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

// Confirm, then close a chat tab. Closing the only remaining chat leaves a
// fresh chat in its place, so the prompt reflects that.
async function confirmCloseTab(id) {
  const tab = TABS.get(id);
  if (!tab) return;
  const ok = await openConfirmDialog({
    title: 'Close this chat?',
    bodyHtml: `Are you sure you want to close <strong>${escapeHtml(displayTitle(tab))}</strong>? Its agent will be stopped.`,
    confirmLabel: 'Close chat',
    cancelLabel: 'Cancel',
  });
  if (ok) closeTab(id);
}

// SVG glyphs for the tab controls. Block-level SVGs (not emoji) so they sit on
// the same line as the label and align consistently across platforms.
const TAB_EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const TAB_CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const TAB_NEW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';

// Render the tab strip. One pill per chat, always visible so every chat (even
// the first) has a clickable label, a hover rename icon, and a close button.
function renderTabStrip() {
  const strip = document.getElementById('tab-strip');
  if (!strip) return;
  const tabs = [...TABS.values()];
  strip.innerHTML = '';
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-tab' + (t.id === activeTabId ? ' active' : '');
    btn.dataset.tab = t.id;
    const name = displayTitle(t);
    btn.title = name;
    const label = document.createElement('span');
    label.className = 'chat-tab-label';
    if (!t.customTitle && !t.titleEarned && t.promptSent) {
      // Name is brewing: breathing dots instead of the "Chat N" placeholder.
      showThinkingDots(label);
    } else {
      label.textContent = name;
    }
    btn.appendChild(label);
    const edit = document.createElement('span');
    edit.className = 'chat-tab-edit';
    edit.dataset.edit = t.id;
    edit.title = 'Rename chat';
    // eslint-disable-next-line no-unsanitized/property -- static SVG markup
    edit.innerHTML = TAB_EDIT_SVG;
    btn.appendChild(edit);
    const x = document.createElement('span');
    x.className = 'chat-tab-close';
    x.dataset.close = t.id;
    x.title = 'Close chat';
    // eslint-disable-next-line no-unsanitized/property -- static SVG markup
    x.innerHTML = TAB_CLOSE_SVG;
    btn.appendChild(x);
    strip.appendChild(btn);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chat-tab-new';
  add.title = 'New chat';
  add.setAttribute('aria-label', 'New chat');
  // eslint-disable-next-line no-unsanitized/property -- static SVG markup
  add.innerHTML = TAB_NEW_SVG;
  add.addEventListener('click', () => { openNewChatTab(); });
  strip.appendChild(add);
  strip.classList.toggle('multi', tabs.length >= 1);
  // The strip scrolls once the tabs outrun the head, so the focused chat is
  // brought back into view after every render.
  const active = strip.querySelector('.chat-tab.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Link each tab to the agent session it spawned, so a saved custom name can be
// restored and future renames persisted. A tab is probed while it has no
// session and while the session it landed on is still provisional, so it can
// move across to the real session once that appears.
async function linkTabs() {
  const pending = [...TABS.values()].filter((t) => !t.agentId || t.agentIdProvisional);
  if (!pending.length) return;
  const claimed = [...TABS.values()]
    .filter((t) => t.agentId && !t.agentIdProvisional)
    .map((t) => t.agentId);
  let changed = false;
  for (const tab of pending) {
    try {
      const res = await window.husk.sessions.resolveLiveTitle({ huskSessionId: tab.id, excludeAgentIds: claimed });
      if (!res || !res.ok || !res.agentId) continue;
      if (tab.agentId && tab.agentId !== res.agentId) changed = true;
      tab.agentId = res.agentId;
      tab.agentIdProvisional = !!res.provisional;
      if (!res.provisional) claimed.push(res.agentId);
      if (tab.customTitle) {
        // A rename made before linking had nowhere to persist; save it now.
        try { window.husk.sessions.rename({ agentId: res.agentId, name: tab.customTitle }); } catch (_) {}
      } else if (res.custom && res.title) {
        tab.customTitle = res.title; tab.titleEarned = true; changed = true;
      } else if (res.named && res.title && sessionTitleUsable(res.title)) {
        adoptTabTitle(tab, res.title);
      }
    } catch (_) {}
  }
  if (changed) renderTabStrip();
}
setInterval(linkTabs, 3000);

// Adopt a generated session name for a tab: state, then a full repaint, then
// the typewriter reveal over the freshly painted label.
function adoptTabTitle(tab, title) {
  const clean = String(title || '').trim();
  if (!clean) return;
  const firstEarn = !tab.titleEarned;
  tab.title = clean;
  tab.titleEarned = true;
  renderTabStrip();
  if (firstEarn && !tab.customTitle) {
    try { typewriterTo(document.querySelector(`#tab-strip [data-tab="${tab.id}"] .chat-tab-label`), clean); } catch (_) {}
  }
  // Keep the rail's Recent list in step without waiting for its slow poll.
  try { refreshRecentList(); } catch (_) {}
}

// Keep each tab's label in step with its session's title, so the tab matches
// the Sessions and Recent lists. A user rename (customTitle) wins and opts the
// tab out. The first earned name types itself in; later refinements swap
// silently through the repaint inside adoptTabTitle.
async function syncTabTitles() {
  for (const tab of TABS.values()) {
    if (!tab.agentId || tab.customTitle) continue;
    try {
      const res = await window.husk.sessions.resolveLiveTitle({ knownAgentId: tab.agentId });
      if (!res || !res.ok) continue;
      // Tracked every poll: while the bound session is provisional, linkTabs
      // keeps looking for the real one.
      tab.agentIdProvisional = !!res.provisional;
      if (!res.title) continue;
      if (res.custom) {
        tab.customTitle = res.title; tab.titleEarned = true; renderTabStrip();
        continue;
      }
      // Only a name the CLI generated counts, so the dots keep breathing
      // until one arrives.
      if (!res.named || !sessionTitleUsable(res.title)) continue;
      const clean = String(res.title).trim();
      if (clean !== tab.title || !tab.titleEarned) adoptTabTitle(tab, clean);
    } catch (_) {}
  }
}
setInterval(syncTabTitles, 5000);

// Delegated handling for the tab strip: rename on the pencil, close (with
// confirm) on the ×, otherwise switch focus to the clicked tab.
{
  const strip = document.getElementById('tab-strip');
  if (strip) {
    strip.addEventListener('click', (e) => {
      const editEl = e.target.closest('[data-edit]');
      if (editEl) {
        e.stopPropagation();
        const btn = editEl.closest('[data-tab]');
        const labelEl = btn && btn.querySelector('.chat-tab-label');
        if (labelEl) beginRename(TABS.get(editEl.dataset.edit), labelEl);
        return;
      }
      const closeEl = e.target.closest('[data-close]');
      if (closeEl) { e.stopPropagation(); confirmCloseTab(closeEl.dataset.close); return; }
      const tabEl = e.target.closest('[data-tab]');
      if (tabEl && tabEl.dataset.tab !== activeTabId) activateTab(tabEl.dataset.tab);
    });
  }
}

// ─── Theme + accent ─────────────────────────────────────────────────────────────
function retintAllTabs() {
  const theme = themeForXterm();
  const contrast = contrastForXterm();
  for (const t of TABS.values()) {
    try { t.term.options.theme = theme; t.term.options.minimumContrastRatio = contrast; } catch (_) {}
  }
  try { if (wfTerm) { wfTerm.options.theme = theme; wfTerm.options.minimumContrastRatio = contrast; } } catch (_) {}
}
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  // Light/dark family flag, derived from the theme's --term-light token. The
  // frosted chrome treatment is gated on data-mode, not data-theme, so a new
  // theme picks its side automatically from that token.
  const isLight = getComputedStyle(document.body).getPropertyValue('--term-light').trim() === '1';
  document.body.dataset.mode = isLight ? 'light' : 'dark';
  retintAllTabs();
}
function applyAccent(accent) {
  const valid = ['orange', 'cyan', 'indigo', 'emerald', 'rose'];
  const a = valid.includes(accent) ? accent : 'orange';
  document.body.dataset.accent = a;
  retintAllTabs();
  $$('.accent-swatch').forEach((sw) => sw.classList.toggle('selected', sw.dataset.c === a));
}

// ─── Router ──────────────────────────────────────────────────────────────────────
// Page visit history: every page change is a navigation entry, so the mouse
// back/forward buttons and Alt+arrows walk pages. Programmatic back/forward
// passes _nav so it does not re-record itself.
let pageHistory = [];
let pageForwardStack = [];
// The search field shows the chord this platform actually uses.
{
  const key = document.getElementById('btn-palette-key');
  if (key && !/mac/i.test(navigator.platform)) key.textContent = 'Ctrl K';
}

function setPage(name, opts = {}) {
  name = normalizePageName(name);
  // An uncommitted appearance preview belongs to Preferences, so leaving the
  // page puts the saved theme, accent and rail back.
  if (currentPage === 'prefs' && name !== 'prefs') revertAppearancePreview();
  if (!opts._nav && currentPage && currentPage !== name) {
    pageHistory.push(currentPage);
    if (pageHistory.length > 64) pageHistory.shift();
    pageForwardStack = [];
  }
  currentPage = name;
  saveRouteState();
  applyPageShell(name);
  wsSyncRailSuppression();
  if (name === 'chat') { renderChatsPanelSessions(); setTimeout(fitNow, 30); if (term) term.focus(); }
  if (name === 'agents') renderAgents();
  if (name === 'workflows') renderWorkflows();
  if (name === 'autopilot') renderAutopilotPage();
  if (name === 'projects') renderProjects();
  if (name === 'prompts') renderPrompts();
  if (name === 'skills') renderSkills();
  if (name === 'sessions') renderSessions();
  if (name === 'files') {
    const root = fxCurrentRoot();
    fxSetOpenFolderLabel(root);
    $('#files-hidden').checked = !!(cfg && cfg.showHidden);
    fxLoad(root);
  }
  if (name === 'mcp') renderMcp();
  if (name === 'plugins') renderPlugins();
  if (name === 'prefs') { bindPrefs(); paintPrefsVersion(); }
}

// Every rail item names the page it opens.
$$('.rail-item').forEach((b) => b.addEventListener('click', () => { if (b.dataset.page) setPage(b.dataset.page); }));
// Sidebar collapse/expand toggle: switches between the labeled rail (names) and
// the icon-only rail. Persists the choice and refits the terminal.
$('#rail-toggle')?.addEventListener('click', async () => {
  const expanded = document.body.dataset.rail !== 'expanded';
  document.body.dataset.rail = expanded ? 'expanded' : 'collapsed';
  syncRailToggleTitle();
  try { cfg = await window.husk.config.set({ railExpanded: expanded }); } catch (_) {}
  setTimeout(fitNow, 120);
});

// Untrusted-folder banner, shown for Claude while the workspace folder is not
// trusted. Trust is set only by the explicit one-click action.
async function maybeShowTrustBanner() {
  const banner = $('#trust-banner');
  if (!banner) return;
  if (agentKindCache !== 'claude') { banner.hidden = true; return; }
  try {
    const r = await window.husk.claudeTrust.status();
    banner.hidden = !!(r && r.trusted);
  } catch (_) { banner.hidden = true; }
}
$('#btn-trust-folder')?.addEventListener('click', async () => {
  const r = await window.husk.claudeTrust.accept();
  if (r && r.ok) {
    $('#trust-banner').hidden = true;
    toast('Folder trusted · reloading agent', 'success');
    await restartPty({ silent: true });
  } else {
    toast(`Could not trust folder: ${(r && r.error) || 'unknown error'}`, 'error');
  }
});
$('#btn-trust-dismiss')?.addEventListener('click', () => { const b = $('#trust-banner'); if (b) b.hidden = true; });
// The collapsed rail draws its own tooltip from aria-label, so move each
// item's `title` across and drop it.
$$('.rail-item').forEach((b) => {
  const t = b.getAttribute('title');
  if (t) { if (!b.getAttribute('aria-label')) b.setAttribute('aria-label', t); b.removeAttribute('title'); }
});

// Rail expand/collapse
function syncRailToggleTitle() {
  const t = $('#rail-toggle');
  if (!t) return;
  t.title = document.body.dataset.rail === 'expanded' ? 'Collapse sidebar' : 'Expand sidebar';
}
function syncStatusToggleTitle() {
  const t = $('#sp-toggle');
  if (!t) return;
  t.title = document.body.dataset.status === 'collapsed' ? 'Expand status panel' : 'Collapse status panel';
}
// Rail is permanently icon-only.

async function toggleStatusPanel() {
  const collapsed = document.body.dataset.status === 'collapsed';
  document.body.dataset.status = collapsed ? 'expanded' : 'collapsed';
  syncStatusToggleTitle();
  cfg = await window.husk.config.set({ statusCollapsed: !collapsed });
  setTimeout(fitNow, 200);
}
// The in-panel chevron collapses; the top-bar button collapses too and is the
// way back once the panel is hidden entirely.
const spToggle = $('#sp-toggle');
if (spToggle) spToggle.addEventListener('click', toggleStatusPanel);
const topStatusToggle = $('#btn-status-toggle');
if (topStatusToggle) topStatusToggle.addEventListener('click', toggleStatusPanel);

// ─── Stats + status bar ──────────────────────────────────────────────────────────
async function refreshStats() {
  try {
    const s = await window.husk.stats.get();
    lastStats = s;
    // The Skills subtitle is owned by applyPromptsLabels so labels stay
    // agent-aware while the count remains current.
    applyPromptsLabels();
    // Sessions subheader is a hint until renderSessions reads the active
    // agent's sessions and takes ownership of the line.
    if (!sessionsSubOwned) {
      $('#sessions-sub').textContent = 'Click a session to preview, Resume to continue';
    }
  } catch (err) { console.warn('stats error', err); }
}

// ─── Status panel (semantic HTML, fed by stats:get) ────────────────────────────
function ratingColor(r) {
  if (r == null || isNaN(r)) return 'var(--text-3)';
  if (r >= 8) return 'var(--emerald)';
  if (r >= 6) return 'var(--accent-2)';
  if (r >= 4) return 'var(--amber)';
  return 'var(--rose)';
}
function fmtPct(n) { return Math.round(Number(n) || 0) + '%'; }
// Format an ISO 8601 instant as "in 1h 23m" / "in 3d 5h" / "now".
// Falls back to the raw string only if the input cannot be parsed at all.
function fmtUntil(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!isFinite(t)) return iso;
  const ms = t - Date.now();
  if (ms <= 0) return 'now';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}
function fmtThousands(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return String(v);
}
function fmtMs(ms) {
  const v = Number(ms) || 0;
  if (v <= 0) return '';
  if (v >= 60000) return `${Math.round(v / 6000) / 10}m`;
  if (v >= 1000) return `${Math.round(v / 100) / 10}s`;
  return `${Math.round(v)}ms`;
}
// Compact token count for the context readout: 330K, 1M, 1.5M.
function fmtCtx(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) { const m = v / 1000000; return (Number.isInteger(m) ? m : m.toFixed(1)) + 'M'; }
  if (v >= 1000) return Math.round(v / 1000) + 'K';
  return String(v);
}
function sparkHTML(values, timestamps) {
  if (!values || !values.length) return '<div class="sp-spark"></div>';
  const max = 10;
  const bars = values.map((v) => {
    const h = Math.max(8, Math.min(100, Math.round((v / max) * 100)));
    return `<div class="sp-spark-bar" style="height:${h}%; background:${ratingColor(v)};"></div>`;
  }).join('');
  // Stocks-style x-axis: oldest, middle, newest dates under the bars. Dedupe
  // so a same-day batch shows one date centered, not "6/9 6/9 6/9".
  let axis = '';
  if (timestamps && timestamps.length) {
    const fmtD = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };
    const first = fmtD(timestamps[0]);
    const last = fmtD(timestamps[timestamps.length - 1]);
    const mid = fmtD(timestamps[Math.floor(timestamps.length / 2)]);
    const labels = [first];
    if (mid !== first && mid !== last) labels.push(mid);
    if (last !== first) labels.push(last);
    const single = labels.length === 1 ? ' sp-spark-dates-single' : '';
    axis = `<div class="sp-spark-dates${single}">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
  }
  return `<div class="sp-spark">${bars}</div>${axis}`;
}
// No-op: retained so existing call sites stay valid.
function spInfo(_tip) { return ''; }

// ─── Context meter ─────────────────────────────────────────────────────────────
// Bucket colour ramp across the bar: the theme's own emerald, through its amber,
// to its rose. `pos` is a 0-100 position ALONG the bar, so the bar reads calm on
// the left and alarming on the right.
function ctxBucketColor(pos) {
  const p = Math.max(0, Math.min(100, pos));
  return p <= 50
    ? `color-mix(in srgb, var(--amber) ${Math.round(p * 2)}%, var(--emerald))`
    : `color-mix(in srgb, var(--rose) ${Math.round((p - 50) * 2)}%, var(--amber))`;
}
// Friendly model name for the status readout, derived from the model id.
// Strips the tier suffix and vendor prefix, then splits the rest into family
// and version. A bare alias renders capitalized and gains its version once the
// session resolves the full id. Date stamps (6+ digits) are dropped.
function prettyModelLabel(raw) {
  const id = String(raw || '').replace(/\[[^\]]*\]/g, '').replace(/^claude-/, '');
  if (!id) return '';
  const parts = id.split('-');
  const family = parts[0];
  const ver = [];
  const tail = [];
  for (const p of parts.slice(1)) {
    if (/^\d{6,}$/.test(p)) continue;              // date stamp
    else if (/^\d{1,2}$/.test(p) && !tail.length) ver.push(p);
    else tail.push(p);
  }
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
  const famDisp = /^gpt$/i.test(family) ? 'GPT' : cap(family);
  return [famDisp, ver.join('.'), tail.map(cap).join(' ')].filter(Boolean).join(' ');
}

// Build the discrete block meter. Filled cells take their gradient color from
// their own position along the bar; trailing cells are the dim empty marker.
function ctxBarHTML(pct, buckets = 26) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round(p / 100 * buckets);
  let cells = '';
  for (let i = 1; i <= buckets; i++) {
    cells += i <= filled
      ? `<div class="sp-ctxbar-cell" style="background:${ctxBucketColor(i / buckets * 100)};"></div>`
      : '<div class="sp-ctxbar-cell sp-ctxbar-empty"></div>';
  }
  return `<div class="sp-ctxbar">${cells}</div>`;
}
// Percentage label color, matching the statusline thresholds.
function ctxPctColor(pct) {
  const p = Number(pct) || 0;
  if (p >= 80) return 'var(--rose)';
  if (p >= 60) return 'var(--amber)';
  if (p >= 40) return 'var(--warn)';
  return 'var(--emerald)';
}

// ─── Shell status bar ────────────────────────────────────────────────────────
// One line under every page: the active tool, the folder it runs in, the model
// this chat runs, and whether its agent is still there. Reads the same stats
// poll the status panel reads, and falls back to the configured tool and folder
// before the first poll lands.

// The model a launch command pins, for the CLIs that take one as a flag.
function modelFromCommand(cmd) {
  const m = String(cmd || '').match(/--model[=\s]+("[^"]+"|'[^']+'|[^\s-]\S*)/);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

// Paths read home-relative, the way a shell writes them.
function homeRelativePath(p) {
  const full = String(p || '');
  const home = String(huskHome || '');
  if (!home || home === '~' || !full.startsWith(home)) return full;
  const rest = full.slice(home.length);
  if (!rest) return '~';
  return (rest.startsWith('/') || rest.startsWith('\\')) ? '~' + rest : full;
}

// Whether the chat this window is pointed at still has an agent behind it.
function shellSessionState() {
  const tab = TABS.get(activeTabId);
  if (!tab) return { key: 'none', word: 'no session', title: 'No chat is open' };
  if (tab.exited) return { key: 'exited', word: 'agent exited', title: 'The agent for this chat has exited; Restart starts a new one' };
  return { key: 'live', word: 'connected', title: 'Husk is attached to the agent running this chat' };
}

function refreshShellStatusBar() {
  const agentEl = $('#sb-agent');
  if (!agentEl) return;
  const s = lastStats || {};
  const u = s.usage || {};
  const project = projectsCache.find((p) => p.id === activeProjectId);
  const tab = TABS.get(activeTabId);

  const tool = (chatSubBase && chatSubBase.tool)
    || s.agent
    || ((cfg && cfg.agentCommand) ? cfg.agentCommand.trim().split(/\s+/)[0] : 'agent');
  const dir = (chatSubBase && chatSubBase.dir)
    || (project ? project.path : null)
    || ((s.workspace && s.workspace.cwd) || (cfg && cfg.agentCwd) || huskHome || '~');
  // The session's own reading first, then the model the command that started
  // this chat named. Neither knows one, so neither does the bar.
  const model = (u.session && u.session.modelLabel)
    || prettyModelLabel((u.session && u.session.model) || '')
    || modelFromCommand((tab && tab.command) || (cfg && cfg.agentCommand) || '');

  // The rail names the configured tool a row above, so the bar carries it only
  // when this chat is running something else.
  const configured = (cfg && cfg.agentCommand) ? cfg.agentCommand.trim().split(/\s+/)[0] : '';
  const showTool = !!tool && tool !== configured;
  agentEl.textContent = tool;
  const agentItem = $('#sb-agent-item');
  if (agentItem) agentItem.hidden = !showTool;
  const agentSep = $('#sb-agent-sep');
  if (agentSep) agentSep.hidden = !showTool;
  const cwdEl = $('#sb-cwd');
  if (cwdEl) { cwdEl.textContent = homeRelativePath(dir); cwdEl.title = dir; }
  const modelEl = $('#sb-model');
  if (modelEl) modelEl.textContent = model;
  const modelItem = $('#sb-model-item');
  if (modelItem) modelItem.hidden = !model;
  const modelSep = $('#sb-model-sep');
  if (modelSep) modelSep.hidden = !model;

  const state = shellSessionState();
  const stateEl = $('#sb-state');
  if (stateEl) stateEl.textContent = state.word;
  const stateItem = $('#sb-state-item');
  if (stateItem) { stateItem.dataset.state = state.key; stateItem.title = state.title; }
}

async function refreshStatusline() {
  refreshShellStatusBar();
  refreshArtifactPane();
  if (!lastStats) return;
  const s = lastStats;
  const here = (s.location && s.location.city) || '';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Timezone comes from Intl locally, and stands in as the headline whenever
  // geolocation did not resolve to a city.
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
  // Pretty fallback: "Europe/London" -> "London", "America/New_York" -> "New York".
  const tzPretty = tz.includes('/') ? tz.split('/').pop().replace(/_/g, ' ') : tz;
  const headline = here || tzPretty || '';
  const weatherStr = s.weather && s.weather.temp
    ? `${s.weather.temp}°C${s.weather.condition ? ' · ' + s.weather.condition : ''}`
    : '';
  const u = s.usage || {};
  const L = s.learning || {};
  // Stabilize the context reading: cache the last good one and fall back to it
  // when a mid-turn poll returns no session or ctxTokens===0. The next good
  // poll overwrites it, and activateTab() clears it on a session switch.
  if (u.session && u.session.ctxTokens > 0) lastGoodCtx = u.session;
  // Context window is a Claude-session figure; for any other agent, do not
  // fall back to a Claude session's cached ctx.
  const ctx = agentKindCache !== 'claude'
    ? null
    : ((u.session && u.session.ctxTokens > 0) ? u.session : lastGoodCtx);
  // The active model, read from the active agent's own session transcript and
  // empty when no model is known, which hides the row. The CLI's own name for
  // the model wins once the catalog has been read, with the id-derived name as
  // the fallback until then.
  const modelId = (u.session && u.session.model)
    || (agentKindCache === 'claude' && ctx && ctx.model) || '';
  const modelLabel = (u.session && u.session.modelLabel)
    || (agentKindCache === 'claude' && ctx && ctx.modelLabel)
    || prettyModelLabel(modelId);
  // The active agent CLI (claude, codex, copilot, ...) and its version, so the
  // Build section reflects whichever agent is selected, not a fixed one.
  const agentLabel = (s.agent || 'claude').replace(/^\w/, (c) => c.toUpperCase());
  const isCopilotAgent = String(s.agent || '').toLowerCase() === 'copilot';
  // Workspace + git: vendor-neutral, the most glanceable state for a coding
  // session. Branch with ahead/behind arrows and a dirty-file count.
  const ws = s.workspace || {};
  const g = ws.git || {};
  const abParts = [];
  if (g.ahead) abParts.push(`↑${g.ahead}`);
  if (g.behind) abParts.push(`↓${g.behind}`);
  const branchLabel = `${g.branch || 'detached'}${abParts.length ? ' ' + abParts.join(' ') : ''}`;
  const mcp = s.mcp || {};

  const html = `
    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">◷</span><span>Location &amp; Time</span></div>
      <div class="sp-section-body">
        ${headline ? `<div><strong>${escapeHtml(headline)}</strong></div>` : ''}
        <div class="sp-row"><span class="sp-muted">Time ${spInfo('Your current local time.')}</span><span class="sp-mono">${time}</span></div>
        ${weatherStr ? `<div class="sp-row"><span class="sp-muted">Weather ${spInfo('Current weather at your detected location.')}</span><span class="sp-mono">${escapeHtml(weatherStr)}</span></div>` : ''}
      </div>
    </div>

    ${ws.name ? `
    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">◫</span><span>Workspace</span></div>
      <div class="sp-section-body">
        <div class="sp-row sp-clickable" data-open="files"><span class="sp-muted">Project ${spInfo('The active project directory. Click to open the Files page.')}</span><span class="sp-mono sp-accent" title="${escapeHtml(ws.cwd || '')}">${escapeHtml(ws.name)}</span></div>
        ${g.isRepo ? `
        <div class="sp-row"><span class="sp-muted">Branch ${spInfo('Current git branch, with commits ahead of / behind the upstream.')}</span><span class="sp-mono" title="${escapeHtml(branchLabel)}">${escapeHtml(branchLabel)}</span></div>
        <div class="sp-row"><span class="sp-muted">Uncommitted changes ${spInfo('Uncommitted changes in the working tree (staged, unstaged, and untracked).')}</span><span class="sp-mono ${g.dirty > 0 ? 'sp-accent' : 'sp-muted'}">${g.dirty > 0 ? escapeHtml(g.dirty) + (g.dirty === 1 ? ' file' : ' files') : 'clean'}</span></div>
        ` : `<div class="sp-row sp-tiny sp-muted">Not a git repository.</div>`}
      </div>
    </div>` : ''}

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">▣</span><span>Build</span></div>
      <div class="sp-section-body">
        <div class="sp-row"><span class="sp-muted">${escapeHtml(agentLabel)} ${spInfo('Installed CLI version of the active agent.')}</span><span class="sp-mono">${escapeHtml(s.agentVersion || 'unknown')}</span></div>
        ${modelLabel ? `<div class="sp-row"><span class="sp-muted">Model ${spInfo('The AI model the active session is running.')}</span><span class="sp-mono sp-accent" title="${escapeHtml(modelId)}">${escapeHtml(modelLabel)}</span></div>` : ''}
        <div class="sp-row"><span class="sp-muted">Husk ${spInfo('Installed Husk app version.')}</span><span class="sp-mono">${escapeHtml(s.huskVer || '0.2')}</span></div>
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">⌬</span><span>Tools</span></div>
      <div class="sp-section-body">
        <div class="sp-row sp-clickable" data-open="skills"><span class="sp-muted">Skills ${spInfo(agentKindCache === 'claude' ? 'Skills in the shared library; auto-loaded by the agent. Click to open.' : 'Skills in the shared library; use Use on the Skills page to inject one into the chat. Click to open.')}</span><span class="sp-mono sp-accent">${escapeHtml(s.skills)}</span></div>
        <div class="sp-row sp-clickable" data-open="workflows"><span class="sp-muted">Workflows ${spInfo('Saved Husk workflows. Click to open.')}</span><span class="sp-mono sp-accent">${escapeHtml(s.workflows)}</span></div>
        ${s.hooksApplicable ? `<div class="sp-row sp-clickable" data-open="hooks"><span class="sp-muted">Hooks ${spInfo('Hooks the agent runs at lifecycle events. Click to open.')}</span><span class="sp-mono sp-accent">${escapeHtml(s.hooks)}</span></div>` : ''}
        ${mcp.supported ? `<div class="sp-row sp-clickable" data-open="mcp"><span class="sp-muted">MCP ${spInfo('MCP servers running for the active agent, out of the total configured. Click to open the MCP page.')}</span><span class="sp-mono sp-accent">${escapeHtml(mcp.enabled)}${mcp.count > mcp.enabled ? `<span class="sp-muted"> / ${escapeHtml(mcp.count)}</span>` : ''}</span></div>` : ''}
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">⏱</span><span>Usage</span></div>
      <div class="sp-section-body">
        ${(ctx && ctx.ctxWindow > 0) ? `
        <div class="sp-row"><span class="sp-muted">Context Window ${spInfo('Tokens currently held in the model context window versus the model capacity. This is what fills up during a conversation and triggers compaction.')}</span></div>
        <div class="sp-row sp-ctx-head" title="Context window used">
          <span class="sp-mono" style="color:${ctxPctColor(ctx.ctxPct)}; font-weight:600;">${fmtPct(ctx.ctxPct)}</span>
          <span class="sp-mono sp-muted">${escapeHtml(fmtCtx(ctx.ctxTokens))} / ${escapeHtml(fmtCtx(ctx.ctxWindow))}</span>
        </div>
        ${ctxBarHTML(ctx.ctxPct)}
        <div class="sp-divider"></div>
        ` : ''}
        ${agentKindCache === 'claude' ? (u.cache_present ? `
        <div class="sp-row"><span class="sp-muted">5 Hours Limit ${spInfo('Share of your rolling 5-hour usage allowance consumed.')}</span><span class="sp-mono">${fmtPct(u.h5_pct)}</span></div>
        <div class="sp-progress"><div class="sp-progress-fill" style="width:${Math.min(100, u.h5_pct||0)}%"></div></div>
        ${u.h5_reset ? `<div class="sp-row"><span class="sp-muted">Resets ${spInfo('When the 5-hour usage window resets.')}</span><span class="sp-mono" title="${escapeHtml(u.h5_reset)}">${escapeHtml(fmtUntil(u.h5_reset))}</span></div>` : ''}
        <div class="sp-row" style="margin-top:6px;"><span class="sp-muted">Weekly Limit ${spInfo('Share of your weekly usage allowance consumed.')}</span><span class="sp-mono">${fmtPct(u.week_pct)}</span></div>
        <div class="sp-progress"><div class="sp-progress-fill" style="width:${Math.min(100, u.week_pct||0)}%"></div></div>
        ${u.week_reset ? `<div class="sp-row"><span class="sp-muted">Resets ${spInfo('When the weekly usage window resets.')}</span><span class="sp-mono" title="${escapeHtml(u.week_reset)}">${escapeHtml(fmtUntil(u.week_reset))}</span></div>` : ''}
        ` : `
        <div class="sp-row"><span class="sp-muted">5h / Weekly</span><span class="sp-mono sp-muted">warming up…</span></div>
        <div class="sp-row sp-tiny sp-muted">First sample takes a few seconds after launch, then refreshes automatically.</div>
        `) : (u.agentSession ? `
        <div class="sp-row"><span class="sp-muted">${escapeHtml(u.agentSession.label)} ${spInfo('Session usage reported by your CLI in its own status line.')}</span><span class="sp-mono sp-accent">${escapeHtml(fmtThousands(u.agentSession.value))}</span></div>
        ` : `
        <div class="sp-row sp-tiny sp-muted">${isCopilotAgent ? 'Copilot does not expose plan-limit percentages; showing session usage from its event log.' : 'Plan usage limits appear here when your CLI reports them.'}</div>
        `)}
        ${u.session ? `
        <div class="sp-divider"></div>
        <div class="sp-row"><span class="sp-muted">Session turns ${spInfo('Number of user and assistant messages exchanged in this session.')}</span><span class="sp-mono sp-accent">${escapeHtml(u.session.turns)}</span></div>
        ${u.session.partialTokens ? '' : `<div class="sp-row"><span class="sp-muted">Session tokens ${spInfo('Estimated total tokens processed across this whole session (cumulative odometer, not the current context window).')}</span><span class="sp-mono sp-accent">~${escapeHtml(fmtThousands(u.session.tokens))}</span></div>`}
        ${isCopilotAgent ? `
        ${u.session.currentTokens ? `<div class="sp-row"><span class="sp-muted">Current tokens ${spInfo('Copilot-reported current token footprint for this session.')}</span><span class="sp-mono sp-accent">${escapeHtml(fmtThousands(u.session.currentTokens))}</span></div>` : ''}
        ${u.session.conversationTokens ? `<div class="sp-row"><span class="sp-muted">Conversation tokens ${spInfo('Copilot-reported conversation tokens at last shutdown checkpoint.')}</span><span class="sp-mono">${escapeHtml(fmtThousands(u.session.conversationTokens))}</span></div>` : ''}
        ${u.session.outputTokens ? `<div class="sp-row"><span class="sp-muted">Output tokens ${spInfo('Assistant output tokens recorded by Copilot.')}</span><span class="sp-mono">${escapeHtml(fmtThousands(u.session.outputTokens))}</span></div>` : ''}
        ${u.session.reasoningTokens ? `<div class="sp-row"><span class="sp-muted">Reasoning tokens ${spInfo('Reasoning tokens recorded by Copilot for supported models.')}</span><span class="sp-mono">${escapeHtml(fmtThousands(u.session.reasoningTokens))}</span></div>` : ''}
        ${u.session.cacheReadTokens || u.session.cacheWriteTokens ? `<div class="sp-row"><span class="sp-muted">Cache read/write ${spInfo('Prompt-cache tokens recorded by Copilot.')}</span><span class="sp-mono">${escapeHtml(fmtThousands(u.session.cacheReadTokens || 0))} / ${escapeHtml(fmtThousands(u.session.cacheWriteTokens || 0))}</span></div>` : ''}
        ${u.session.systemTokens || u.session.toolDefinitionsTokens ? `<div class="sp-row"><span class="sp-muted">System/tools ${spInfo('System prompt and tool-definition token footprint Copilot reports.')}</span><span class="sp-mono">${escapeHtml(fmtThousands(u.session.systemTokens || 0))} / ${escapeHtml(fmtThousands(u.session.toolDefinitionsTokens || 0))}</span></div>` : ''}
        ${u.session.premiumRequests ? `<div class="sp-row"><span class="sp-muted">Premium requests ${spInfo('Premium request count reported by Copilot.')}</span><span class="sp-mono sp-accent">${escapeHtml(fmtThousands(u.session.premiumRequests))}</span></div>` : ''}
        ${u.session.apiDurationMs ? `<div class="sp-row"><span class="sp-muted">API time ${spInfo('Total API duration reported by Copilot.')}</span><span class="sp-mono">${escapeHtml(fmtMs(u.session.apiDurationMs))}</span></div>` : ''}
        ` : ''}
        ` : ''}
        ${(u.api_cost || u.extra_used || u.session_cost) ? `
        <div class="sp-divider"></div>
        ${u.api_cost ? `<div class="sp-row"><span class="sp-muted">API ${spInfo('API dollars spent this session.')}</span><span class="sp-mono">$${escapeHtml(u.api_cost)}</span></div>` : ''}
        ${u.extra_limit ? `<div class="sp-row"><span class="sp-muted">Extra ${spInfo('Extra usage dollars used versus your limit.')}</span><span class="sp-mono">$${escapeHtml(u.extra_used)}/$${escapeHtml(u.extra_limit)}</span></div>` : ''}
        ${u.session_cost ? `<div class="sp-row"><span class="sp-muted">Session $ ${spInfo('Estimated cost of this session.')}</span><span class="sp-mono">${escapeHtml(String(u.session_cost))}</span></div>` : ''}
        ` : ''}
      </div>
    </div>

    ${agentKindCache === 'claude' ? `
    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">◎</span><span>Memory</span></div>
      <div class="sp-section-body">
        <div class="sp-row sp-clickable" data-open="sessions"><span class="sp-muted">Sessions ${spInfo('Work sessions recorded in memory. Click to view.')}</span><span class="sp-mono sp-accent">${s.sessions}</span></div>
        <div class="sp-row sp-clickable" data-open="ratings"><span class="sp-muted">Ratings ${spInfo('Session ratings you have given. Click to open.')}</span><span class="sp-mono sp-accent">${s.ratings}</span></div>
        <div class="sp-row sp-clickable" data-open="work"><span class="sp-muted">Work ${spInfo('Active work projects tracked in memory. Click to open.')}</span><span class="sp-mono sp-accent">${s.sessions}</span></div>
        <div class="sp-row sp-clickable" data-open="research"><span class="sp-muted">Research ${spInfo('Research entries stored in memory. Click to open.')}</span><span class="sp-mono sp-accent">${s.research}</span></div>
      </div>
    </div>` : ''}
    ${agentKindCache === 'claude' ? `
    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">✿</span><span>Learning</span></div>
      <div class="sp-section-body">
        ${L.latest != null ? `<div class="sp-row"><span class="sp-muted">Latest ${spInfo('Your most recent session rating (and its source).')}</span><span class="sp-mono" style="color:${ratingColor(L.latest)}; font-weight:600;">${L.latest} · ${escapeHtml(L.latestSource||'auto')}</span></div>` : ''}
        ${L.avg1h != null ? `<div class="sp-row"><span class="sp-muted">1h ${spInfo('Average rating over the last hour.')}</span><span class="sp-mono" style="color:${ratingColor(L.avg1h)};">${L.avg1h}</span></div>` : ''}
        ${L.avg1d != null ? `<div class="sp-row"><span class="sp-muted">1d ${spInfo('Average rating over the last day.')}</span><span class="sp-mono" style="color:${ratingColor(L.avg1d)};">${L.avg1d}</span></div>` : ''}
        ${L.avg1w != null ? `<div class="sp-row"><span class="sp-muted">1w ${spInfo('Average rating over the last week.')}</span><span class="sp-mono" style="color:${ratingColor(L.avg1w)};">${L.avg1w}</span></div>` : ''}
        ${L.avg1mo != null ? `<div class="sp-row"><span class="sp-muted">1mo ${spInfo('Average rating over the last month.')}</span><span class="sp-mono" style="color:${ratingColor(L.avg1mo)};">${L.avg1mo}</span></div>` : ''}
        ${L.recent && L.recent.length ? sparkHTML(L.recent, L.recentTs) : ''}
        ${(L.latest == null && L.avg1h == null && L.avg1d == null && L.avg1w == null && L.avg1mo == null) ? `<div class="sp-row sp-tiny sp-muted">No ratings yet · sessions you rate will land here.</div>` : ''}
      </div>
    </div>` : ''}
  `;

  // eslint-disable-next-line no-unsanitized/property -- Template content is escaped or trusted static markup.
  $('#sp-content').innerHTML = `<div class="sp-fit" id="sp-fit">${html}</div>`;
  fitStatusContent();
  // Wire click-to-open shortcuts
  $$('#sp-content [data-open]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = el.dataset.open;
      if (t === 'skills') window.husk.fs.open(s.skillsDir);
      else if (t === 'workflows') window.husk.fs.open(s.workflowsDir);
      else if (t === 'hooks') window.husk.fs.open(s.hooksDir);
      else if (t === 'sessions') setPage('sessions');
      else if (t === 'work') window.husk.fs.open(s.sessionsDir);
      else if (t === 'research') window.husk.fs.open(s.researchDir);
      else if (t === 'ratings') window.husk.fs.open(s.memoryDir + '/LEARNING/SIGNALS');
      else if (t === 'files') setPage('files');
      else if (t === 'mcp') setPage('mcp');
    });
  });
}

// Chromium's zoom level maps to a 1.2^level scale factor, which converts a
// CSS-pixel measurement back to what it spans at Husk's base zoom.
const ZOOM_STEP_BASE = 1.2;
function userZoomRatio() {
  const ui = window.husk && window.husk.ui;
  if (!ui || typeof ui.zoomGet !== 'function' || typeof ui.zoomBase !== 'number') return 1;
  try { return Math.pow(ZOOM_STEP_BASE, ui.zoomGet() - ui.zoomBase); } catch (_) { return 1; }
}

// Scale the status stack down when it is taller than the space between the
// head and foot border lines, so every section stays visible at any window
// height. The budget is the panel's height at base zoom, which keeps the
// user's zoom intact.
function fitStatusContent() {
  const box = $('#sp-content');
  const fit = $('#sp-fit');
  if (!box || !fit) return;
  fit.style.transform = '';
  fit.style.marginBottom = '';
  fit.style.width = '';
  const cs = getComputedStyle(box);
  const avail = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (avail <= 0) return; // panel collapsed or not laid out yet
  const need = fit.scrollHeight;
  const budget = avail * userZoomRatio();
  if (need <= budget) return;
  const scale = budget / need;
  // Widening the wrapper by the same factor it is scaled by keeps the painted
  // width at the panel's, so the shrink reads as vertical only.
  fit.style.width = `${100 / scale}%`;
  fit.style.transform = `scale(${scale})`;
  // A transform leaves the layout box at full height, so pull the freed space
  // back and #sp-content's scroll height matches what is painted.
  fit.style.marginBottom = `${-(need * (1 - scale))}px`;
}

// Re-fit whenever the panel itself resizes (window resize, collapse/expand).
const spFitObserver = new ResizeObserver(() => fitStatusContent());
if ($('#sp-content')) spFitObserver.observe($('#sp-content'));

// ─── Context pane ────────────────────────────────────────────────────────────
// The right column is a tabbed pane. Context holds what the session is pointed
// at: the folder, its working tree, and the files handed to the agent. Status
// holds the app readout. Panes keep their layout box while inactive, so their
// content is measured and fitted before it is shown.
let spPane = 'work';
// Last working tree read, keyed by folder. Re-read only when the dirty count
// moves, so the poll costs one process spawn per actual change.
let workTree = { root: null, isRepo: false, files: [], dirty: -1 };
const WORK_TREE_MAX = 12;
const WORK_CONTEXT_MAX = 8;

// Badge hue per working-tree state, drawn from the shared state tokens.
const WORK_STATE = {
  added: 'success',
  untracked: 'success',
  modified: 'warning',
  'type-changed': 'warning',
  renamed: 'running',
  copied: 'running',
  deleted: 'error',
  conflicted: 'error',
};

// Trim a path to its last three segments so a deep one still ends in the part
// that names it.
const WORK_PATH_SEGMENTS = 3;
function shortPath(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  if (parts.length <= WORK_PATH_SEGMENTS) return String(p || '');
  return '…/' + parts.slice(-WORK_PATH_SEGMENTS).join('/');
}

function setStatusPane(name) {
  spPane = name === 'status' ? 'status' : 'work';
  $$('.sp-tab').forEach((t) => {
    const on = t.dataset.pane === spPane;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('.sp-pane').forEach((p) => p.classList.toggle('is-active', p.dataset.pane === spPane));
  if (spPane === 'work') refreshWorkPane(true);
  else fitStatusContent();
  try { window.husk.config.set({ statusPane: spPane }); } catch (_) {}
}
$$('.sp-tab').forEach((t) => t.addEventListener('click', () => setStatusPane(t.dataset.pane)));

// The names pinned to this chat, as one phrase.
function pinnedAgentLabel() {
  const active = getActiveProfileIds()
    .map((id) => profilesCache.find((p) => p.id === id))
    .filter(Boolean);
  if (!active.length) return '';
  if (active.length === 1) return active[0].name;
  if (active.length === 2) return `${active[0].name}, ${active[1].name}`;
  // Past two names, the count stands in for them.
  return `${active.length} agents pinned`;
}

// The folder this session works in, and its display name.
function workRoot() {
  const project = projectsCache.find((p) => p.id === activeProjectId);
  const ws = (lastStats && lastStats.workspace) || {};
  const path = (chatSubBase && chatSubBase.dir) || (project ? project.path : '') || ws.cwd || (cfg && cfg.agentCwd) || huskHome || '';
  const name = (project && project.name) || ws.name || (path ? path.split('/').filter(Boolean).pop() : '');
  return { path, name };
}

async function readWorkTree(root, dirty) {
  if (!root) { workTree = { root: null, isRepo: false, files: [], dirty: -1 }; return; }
  try {
    const r = await window.husk.fs.gitStatus(root);
    if (!r || !r.ok) { workTree = { root, isRepo: false, files: [], dirty }; return; }
    const files = r.isRepo ? window.husk.text.parseGitStatus(r.porcelain) : [];
    workTree = { root, isRepo: !!r.isRepo, files: files.filter((f) => f.status !== 'ignored'), dirty };
  } catch (_) {
    workTree = { root, isRepo: false, files: [], dirty };
  }
}

const FILE_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
const FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
const DROP_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function workPaneHTML() {
  const { path, name } = workRoot();
  const ws = (lastStats && lastStats.workspace) || {};
  const g = ws.git || {};
  const pinned = pinnedAgentLabel();
  const ahead = [];
  if (g.ahead) ahead.push(`↑${g.ahead}`);
  if (g.behind) ahead.push(`↓${g.behind}`);
  const branch = g.isRepo ? `${g.branch || 'detached'}${ahead.length ? ' ' + ahead.join(' ') : ''}` : '';

  const meta = [
    name ? (branch
      ? `<span class="pill is-mono" data-state="muted">${escapeHtml(branch)}</span>`
      : '<span class="pill" data-state="muted">Not a repository</span>') : '',
    pinned ? `<span class="pill" data-state="running">${escapeHtml(pinned)}</span>` : '',
  ].filter(Boolean).join('');
  const project = (name
    ? `<div class="sp-work-name">${FOLDER_ICON_SVG}<span title="${escapeAttr(path)}">${escapeHtml(name)}</span></div>
       ${path ? `<div class="sp-work-path" title="${escapeAttr(path)}">${escapeHtml(path)}</div>` : ''}`
    : `<div class="sp-work-empty">${FOLDER_ICON_SVG}No folder open yet</div>`)
    + (meta ? `<div class="sp-work-meta">${meta}</div>` : '');

  const changed = workTree.files.slice(0, WORK_TREE_MAX);
  const changes = !workTree.isRepo
    ? `<div class="sp-work-empty">${FILE_ICON_SVG}Not a repository, so no changes are tracked</div>`
    : (changed.length
      ? changed.map((f) => `
        <div class="sp-work-row is-clickable" data-change="${escapeAttr(f.path)}" title="${escapeAttr(f.path)} · ${escapeAttr(f.status)} · click to hand it to the agent">
          <span class="sp-work-badge" data-state="${escapeAttr(WORK_STATE[f.status] || 'muted')}">${escapeHtml(window.husk.text.gitBadge(f.status))}</span>
          <span class="sp-work-file is-path">${escapeHtml(shortPath(f.path))}</span>
        </div>`).join('')
        + (workTree.files.length > changed.length
          ? `<div class="sp-work-more">${workTree.files.length - changed.length} more not shown</div>` : '')
      : `<div class="sp-work-empty">${FILE_ICON_SVG}Working tree clean</div>`);

  const shared = sessionContext.slice(0, WORK_CONTEXT_MAX);
  const context = shared.length
    ? shared.map((f) => `
      <div class="sp-work-row is-clickable" data-share="${escapeAttr(f.path)}" data-name="${escapeAttr(f.name)}" title="${escapeAttr(f.name)}, click to share it again">
        ${FILE_ICON_SVG}
        <span class="sp-work-file">${escapeHtml(f.name)}</span>
        <button class="sp-work-drop" data-drop="${escapeAttr(f.path)}" type="button" title="Remove from this session" aria-label="Remove from this session">${DROP_ICON_SVG}</button>
      </div>`).join('')
      + (sessionContext.length > shared.length
        ? `<div class="sp-work-more">${sessionContext.length - shared.length} more not shown</div>` : '')
    : `<div class="sp-work-empty">${FILE_ICON_SVG}No files shared yet</div>`;

  return `
    <div class="sp-work">
      <section class="sp-work-group">
        <div class="section-label sp-work-head"><span>Project</span></div>
        ${project}
      </section>
      <section class="sp-work-group">
        <div class="section-label sp-work-head"><span>Changes</span>${workTree.isRepo ? `<span class="section-label-count">${workTree.files.length}</span>` : ''}</div>
        ${changes}
      </section>
      <section class="sp-work-group">
        <div class="section-label sp-work-head"><span>In context</span><span class="section-label-count">${sessionContext.length}</span></div>
        ${context}
      </section>
    </div>`;
}

function paintWorkPane() {
  const pane = $('#sp-pane-work');
  if (!pane) return;
  // eslint-disable-next-line no-unsanitized/property -- Every interpolated field is escaped or static markup.
  pane.innerHTML = workPaneHTML();
  pane.querySelectorAll('[data-share]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const drop = e.target.closest('[data-drop]');
      if (drop) {
        removeFromSessionContext(drop.dataset.drop);
        window.husk.context.remove(drop.dataset.drop).catch(() => {});
        toast(`Removed: ${el.dataset.name}`, 'success');
        return;
      }
      attachFileToChat(el.dataset.share);
    });
  });
  pane.querySelectorAll('[data-change]').forEach((el) => {
    el.addEventListener('click', () => {
      if (!workTree.root) return;
      attachFileToChat(`${workTree.root}/${el.dataset.change}`);
    });
  });
}

// Repaint the Context pane. The working tree is re-read only when the dirty
// count reported by the poll moves, or when the pane is opened.
async function refreshWorkPane(force = false) {
  if (!$('#sp-pane-work')) return;
  if (spPane !== 'work') return;
  const { path } = workRoot();
  const ws = (lastStats && lastStats.workspace) || {};
  const dirty = (ws.git && typeof ws.git.dirty === 'number') ? ws.git.dirty : -1;
  if (force || path !== workTree.root || dirty !== workTree.dirty) {
    await readWorkTree(path, dirty);
  }
  paintWorkPane();
}

// Both panes read the same poll, so one call keeps whichever is open current.
function refreshArtifactPane() {
  refreshWorkPane().catch(() => {});
}

// ─── Projects page ─────────────────────────────────────────────────────────────
let projectsCache = [];
let activeProjectId = null;

// ─── Projects: board + per-project workspace ─────────────────────────────────
// A project is a folder context. Clicking a row opens its workspace; the
// agent launches only from the explicit button.
let projectStates = {};   // derived per-project signal, keyed by id
let projectGroups = null; // { needsYou, active, quiet } id lists from main
let wsOpenId = null;      // non-null while a workspace view is open
let wsStateError = null;  // last projects:state failure, rendered by paintBoard

async function renderProjects() {
  const board = $('#projects-board');
  if (!board) return;
  const res = await window.husk.projects.list();
  if (!res || !res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    board.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${escapeHtml((res && res.error) || 'Unknown error')}</div></div>`;
    return;
  }
  projectsCache = res.projects || [];
  activeProjectId = res.activeProjectId || null;
  if (wsOpenId && !projectsCache.some((p) => p.id === wsOpenId)) wsOpenId = null;
  // Paint immediately from the cheap list, then enrich once derived state
  // lands. The page never waits on a git call.
  paintProjectsSurface();
  wsStateError = null;
  try {
    const st = await window.husk.projects.state();
    if (st && st.ok) {
      projectStates = st.states || {};
      projectGroups = st.groups || null;
    } else {
      wsStateError = (st && st.error) || 'the call returned no data';
    }
  } catch (err) {
    wsStateError = (err && err.message) || String(err);
  }
  if (wsStateError) console.warn('[projects] derived state unavailable:', wsStateError);
  paintProjectsSurface();
}

// Home-relative display form of a project path. The full path stays in the
// title attribute.
function wsShortPath(p) {
  const s = String(p || '');
  const h = String(huskHome || '');
  return h && h !== '~' && s.startsWith(h) ? '~' + s.slice(h.length) : s;
}

function fmtRelTime(iso) {
  if (!iso && iso !== 0) return 'never';
  // Accept ISO strings AND epoch-ms numbers (run_summary stamps endedAt
  // as Date.now()).
  const t = (typeof iso === 'number' || /^\d{10,}$/.test(String(iso).trim()))
    ? Number(iso)
    : Date.parse(iso);
  if (!isFinite(t)) return String(iso);
  const ms = Date.now() - t;
  if (ms < 0) return 'now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

function wsStateOf(id) {
  const st = projectStates[id] || {};
  if (!st.live && id === activeProjectId && TABS.size > 0) return { ...st, live: true };
  return st;
}

// Most recent thing that happened here: a session transcript or a launch.
function wsActivityMs(p) {
  const st = wsStateOf(p.id);
  return Math.max(st.lastSessionMs || 0, Date.parse(p.lastUsedAt || '') || 0) || null;
}

// Board or workspace, one entry point so every caller repaints the right one.
// The filter input scopes the board list and hides inside a workspace.
function wsSyncRailSuppression() {
  const rail = document.getElementById('rail-recent');
  if (rail) rail.classList.toggle('ws-suppressed', currentPage === 'projects' && !!wsOpenId);
}

function paintProjectsSurface() {
  const board = $('#projects-board');
  const ws = $('#project-workspace');
  if (!board || !ws) return;
  const search = $('#projects-search');
  if (search) search.hidden = !!wsOpenId;
  const addBtn = $('#btn-projects-new');
  if (addBtn) addBtn.hidden = !!wsOpenId;
  // Inside a workspace the breadcrumb and project hero replace the list header,
  // so the empty page header must not reserve vertical space.
  const page = document.querySelector('.page-projects');
  if (page) page.classList.toggle('is-workspace-open', !!wsOpenId);
  const head = document.querySelector('.page-projects .page-head');
  if (head) head.hidden = !!wsOpenId;
  wsSyncRailSuppression();
  if (wsOpenId) { board.hidden = true; ws.hidden = false; paintWorkspace(wsOpenId); return; }
  ws.hidden = true;
  board.hidden = false;
  paintBoard(search ? search.value || '' : '');
}

const WS_BRANCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="8" r="2.6"/><path d="M6 8.6v6.8M18 10.6c0 4-4.5 3.4-9 5"/></svg>';
const WS_TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const WS_PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

// Git chip for one project, shared by board rows and the workspace header.
function wsBranchChip(st) {
  if (!st.branch) return '';
  const ab = `${st.ahead ? ` <span class="ws-ab" title="commits ahead of upstream">&uarr;${Number(st.ahead)}</span>` : ''}${st.behind ? ` <span class="ws-ab" title="commits behind upstream">&darr;${Number(st.behind)}</span>` : ''}`;
  return `<span class="ws-stat" title="git branch">${WS_BRANCH_SVG}<span class="ws-stat-txt">${escapeHtml(st.branch)}</span>${ab}</span>`;
}

// Working-state chips (dirty, conflicts, runs to review, missing folder).
function wsWorkChips(p) {
  const st = wsStateOf(p.id);
  const chips = [];
  if (st.conflicts) chips.push(`<span class="ws-stat is-warn">${Number(st.conflicts)} conflicted</span>`);
  else if (st.dirty) chips.push(`<span class="ws-stat is-dirty">${Number(st.dirty)} uncommitted</span>`);
  if (st.retainedCount) chips.push(`<span class="ws-stat is-attn">${Number(st.retainedCount)} to review</span>`);
  if (projectGroups && st.available === false) chips.push('<span class="ws-stat is-warn">folder missing</span>');
  return chips.join('');
}

// One table row. The full path lives in the tooltip and the cell shows the
// home-relative form; empty cells carry a dim placeholder. The action column
// holds "Open" to launch into the folder, or "Current" when the agent is
// already there.
function wsRowHtml(p, attn) {
  const st = wsStateOf(p.id);
  const isActive = p.id === activeProjectId;
  const pending = !projectGroups;
  const branchCell = wsBranchChip(st) || (pending ? '<span class="ws-skel ws-skel-cell"></span>' : '<span class="ws-cell-dim">&middot;</span>');
  const statusCell = wsWorkChips(p) || (pending ? '<span class="ws-skel ws-skel-cell"></span>' : `<span class="ws-cell-dim">${st.isGit ? 'Clean' : '&middot;'}</span>`);
  return `
    <div class="ws-row${isActive ? ' is-active' : ''}${attn ? ' is-attn' : ''}" data-id="${escapeHtml(p.id)}" tabindex="0" role="button" aria-label="Open workspace ${escapeHtml(p.name)}">
      <div class="ws-col-name">${st.live ? '<span class="tv-dot" title="agent live"></span>' : ''}<span class="ws-row-title">${escapeHtml(p.name)}</span></div>
      <div class="ws-col-path" title="${escapeHtml(p.path)}">${escapeHtml(wsShortPath(p.path))}</div>
      <div class="ws-col-git">${branchCell}</div>
      <div class="ws-col-state">${statusCell}</div>
      <div class="ws-col-time">${escapeHtml(fmtRelTime(wsActivityMs(p)))}</div>
      <div class="ws-col-actions">
        ${isActive ? '<span class="ws-current" title="The agent already runs in this folder">Current</span>' : `<button class="ghost-btn ws-launch" data-id="${escapeHtml(p.id)}" title="Launch the agent in this folder">Open</button>`}
        <button class="card-delete project-delete" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Delete project" aria-label="Delete project">${WS_TRASH_SVG}</button>
      </div>
    </div>`;
}

function paintBoard(filter) {
  const board = $('#projects-board');
  if (!board) return;
  const q = (filter || '').toLowerCase().trim();
  const match = (p) => !q || (p.name + ' ' + p.path).toLowerCase().includes(q);
  if (!projectsCache.length) {
    // eslint-disable-next-line no-unsanitized/property -- Static markup.
    board.innerHTML = `<div class="empty-state"><div class="es-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg></div><div class="es-title">No projects yet</div><div class="es-msg">Pin a folder so the agent can launch into it with one click, and this board can tell you what is going on inside it.</div><button type="button" class="ghost-btn" id="projects-empty-add">Add project</button></div>`;
    const addBtn = $('#projects-empty-add');
    if (addBtn) addBtn.addEventListener('click', () => { const b = $('#btn-projects-new'); if (b) b.click(); });
    return;
  }
  const groups = projectGroups || { needsYou: [], active: projectsCache.map((p) => p.id), quiet: [] };
  const byId = new Map(projectsCache.map((p) => [p.id, p]));
  const pick = (idList) => idList.map((id) => byId.get(id)).filter(Boolean).filter(match);
  const needs = pick(groups.needsYou);
  const act = pick(groups.active);
  const quiet = pick(groups.quiet);
  if (!needs.length && !act.length && !quiet.length) {
    // eslint-disable-next-line no-unsanitized/property -- escapeHtml on the query.
    board.innerHTML = `<div class="empty-state"><div class="es-msg">No projects match "${escapeHtml(q)}"</div></div>`;
    return;
  }
  // One continuous table: a header row, then the groups as separator rows.
  // Separators appear only when more than one group is non-empty.
  const nonEmpty = [needs, act, quiet].filter((g) => g.length).length;
  const groupRow = (label, n) => (nonEmpty > 1 ? `<div class="ws-group"><span>${label}</span><span class="ws-sec-count">${n}</span></div>` : '');
  // The failure note is painted with the table so it survives every repaint.
  const stateNote = wsStateError
    ? `<div class="ws-state-note">Live project state is unavailable, so branch and status are blank. Error: ${escapeHtml(wsStateError)}</div>`
    : '';
  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
  board.innerHTML = `${stateNote}
    <div class="ws-table">
      <div class="ws-thead"><span>Project</span><span>Path</span><span>Branch</span><span>Status</span><span class="ws-th-right">Activity</span><span></span></div>
      ${needs.length ? groupRow('Needs you', needs.length) + needs.map((p) => wsRowHtml(p, true)).join('') : ''}
      ${act.length ? groupRow(projectGroups ? 'Active' : 'Projects', act.length) + act.map((p) => wsRowHtml(p, false)).join('') : ''}
      ${quiet.length ? groupRow('Quiet', quiet.length) + quiet.map((p) => wsRowHtml(p, false)).join('') : ''}
      <button type="button" class="ws-addrow" title="Pin another folder">${WS_PLUS_SVG}Add project</button>
      <div class="ws-fill" aria-hidden="true"></div>
    </div>`;
  // The add row mirrors the header button so there is one modal and one code
  // path behind both entry points.
  const addRow = board.querySelector('.ws-addrow');
  if (addRow) addRow.addEventListener('click', () => { const b = $('#btn-projects-new'); if (b) b.click(); });
  board.querySelectorAll('.ws-launch').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openProject(e.currentTarget.dataset.id); }));
  board.querySelectorAll('.project-delete').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProject(e.currentTarget.dataset.id, e.currentTarget.dataset.name); }));
  board.querySelectorAll('.ws-row').forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.closest('.ws-row-actions')) return;
    openWorkspaceView(row.dataset.id);
  }));
}

function openWorkspaceView(id) {
  if (!id) return;
  wsOpenId = id;
  // Fire and forget: the stamp feeds a future since-you-were-here digest and
  // must never hold up opening the view.
  try { window.husk.projects.markViewed(id); } catch (_) {}
  paintProjectsSurface();
}

function closeWorkspaceView() {
  wsOpenId = null;
  paintProjectsSurface();
}

function paintWorkspace(id) {
  const ws = $('#project-workspace');
  const p = projectsCache.find((x) => x.id === id);
  if (!ws || !p) { wsOpenId = null; paintProjectsSurface(); return; }
  const st = wsStateOf(id);
  const isActive = p.id === activeProjectId;
  const missing = projectGroups && st.available === false;

  const loops = [];
  if (st.retainedCount) {
    loops.push(`<div class="ws-loop"><div class="ws-loop-text"><strong>${Number(st.retainedCount)} autopilot run${st.retainedCount === 1 ? '' : 's'} waiting for review</strong><span>finished work stays parked in a worktree until you apply or discard it</span></div><button class="ghost-btn" id="ws-review-runs">Review</button></div>`);
  }
  if (st.conflicts) {
    loops.push(`<div class="ws-loop is-warn"><div class="ws-loop-text"><strong>${Number(st.conflicts)} conflicted file${st.conflicts === 1 ? '' : 's'}</strong><span>a merge is blocked until these are resolved</span></div></div>`);
  }
  if (st.dirty && !st.conflicts) {
    loops.push(`<div class="ws-loop"><div class="ws-loop-text"><strong>${Number(st.dirty)} uncommitted change${st.dirty === 1 ? '' : 's'}${st.branch ? ` on ${escapeHtml(st.branch)}` : ''}</strong><span>${isActive ? 'review them on the Files page' : 'launch here to review them on the Files page'}</span></div>${isActive ? '<button class="ghost-btn" id="ws-open-files">Files</button>' : ''}</div>`);
  }
  const loopsPanel = loops.length ? `
        <section class="ws-panel">
          <div class="ws-panel-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/></svg>Open loops</div>
          ${loops.join('')}
        </section>` : '';

  const details = [
    ['Path', `<span class="ws-mono" title="${escapeHtml(p.path)}">${escapeHtml(wsShortPath(p.path))}</span>`],
    ['Git', st.isGit ? `${escapeHtml(st.branch || 'repository')}` : (projectGroups ? 'Not a git repository' : '<span class="ws-skel"></span>')],
    ['Added', escapeHtml(fmtRelTime(p.addedAt))],
    ['Last launched', escapeHtml(fmtRelTime(p.lastUsedAt))],
  ].map(([k, v]) => `<div class="ws-detail"><span class="ws-detail-k">${k}</span><span class="ws-detail-v">${v}</span></div>`).join('');

  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
  ws.innerHTML = `
    <nav class="ws-crumbs" aria-label="Breadcrumb"><button class="ws-crumb" id="ws-back">Projects</button><span class="ws-crumb-sep">/</span><span class="ws-crumb-here">${escapeHtml(p.name)}</span></nav>
    ${missing ? `<div class="ws-missing"><strong>This folder no longer exists.</strong> The path may be renamed, moved, or on a disconnected drive. Remove the project, or restore the folder and come back.<button class="ghost-btn" id="ws-remove-missing">Remove project</button></div>` : ''}
    <div class="ws-hero">
      <div class="ws-hero-main">
        <div class="ws-title">${escapeHtml(p.name)}${isActive ? `<span class="project-card-pill${st.live ? ' pill-live' : ''}">${st.live ? 'Live' : 'Active'}</span>` : ''}</div>
        <div class="ws-hero-meta"><span class="ws-hero-path" title="${escapeHtml(p.path)}">${escapeHtml(wsShortPath(p.path))}</span>${st.branch ? wsBranchChip(st) : ''}</div>
      </div>
      <div class="ws-title-actions">
        ${isActive ? '<button class="ghost-btn" id="ws-leave" title="Close this project; the agent runs in your home folder">Exit project</button>' : ''}
        ${(missing || isActive) ? '' : `<button class="btn-primary" id="ws-launch">Launch<svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>`}
      </div>
    </div>
    <div class="ws-tiles">
      <div class="ws-tile${st.conflicts ? ' is-attn' : ''}">
        <span class="ws-tile-ic${(st.conflicts || st.dirty) ? ' is-warn-ic' : ''}">${WS_BRANCH_SVG}</span>
        <div class="ws-tile-body">
          <div class="ws-tile-label">Branch</div>
          <div class="ws-tile-value ws-tile-ellipsis" title="${escapeHtml(st.branch || '')}">${!projectGroups ? '<span class="ws-skel ws-skel-value"></span>' : (st.branch ? escapeHtml(st.branch) : (st.isGit ? 'repository' : 'No repo'))}</div>
          <div class="ws-tile-sub${st.conflicts ? ' is-warn' : (st.dirty ? ' is-dirty' : '')}">${!projectGroups ? 'Checking&hellip;' : (st.conflicts ? `${Number(st.conflicts)} conflicted` : (st.dirty ? `${Number(st.dirty)} uncommitted` : (st.isGit ? 'Working tree clean' : 'Plain folder')))}</div>
        </div>
      </div>
      <div class="ws-tile${loops.length ? ' is-attn' : ''}">
        <span class="ws-tile-ic${loops.length ? ' is-warn-ic' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/></svg></span>
        <div class="ws-tile-body">
          <div class="ws-tile-label">Open loops</div>
          <div class="ws-tile-value">${loops.length}</div>
          <div class="ws-tile-sub${loops.length ? ' is-warn' : ''}">${loops.length ? 'Waiting on you' : 'All clear'}</div>
        </div>
      </div>
      <div class="ws-tile">
        <span class="ws-tile-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 1 1-3.1-6.3"/><path d="M21 4v5h-5"/><path d="M12 8v4l3 2"/></svg></span>
        <div class="ws-tile-body">
          <div class="ws-tile-label">Sessions</div>
          <div class="ws-tile-value" id="ws-tile-sessions">&hellip;</div>
          <div class="ws-tile-sub">In this folder</div>
        </div>
      </div>
      <div class="ws-tile">
        <span class="ws-tile-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3l-8 10h6l-2 8 8-10h-6z"/></svg></span>
        <div class="ws-tile-body">
          <div class="ws-tile-label">Last activity</div>
          <div class="ws-tile-value" id="ws-tile-activity">${escapeHtml(fmtRelTime(wsActivityMs(p)))}</div>
        </div>
      </div>
    </div>
    <div class="ws-cols">
      <div class="ws-col-l">${loopsPanel}
        <section class="ws-panel">
          <div class="ws-panel-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 1 1-3.1-6.3"/><path d="M21 4v5h-5"/><path d="M12 8v4l3 2"/></svg>Recent sessions</div>
          <div id="ws-sessions-list"><div class="ws-empty">Loading&hellip;</div></div>
        </section>
      </div>
      <div class="ws-col-r">
        <section class="ws-panel">
          <div class="ws-panel-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>Details</div>
          <div class="ws-details">${details}<div class="ws-detail" id="ws-commit-row" hidden><span class="ws-detail-k">Last commit</span><span class="ws-detail-v" id="ws-commit-v"></span></div></div>
        </section>
        <section class="ws-panel">
          <div class="ws-panel-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 3l-8 10h6l-2 8 8-10h-6z"/></svg>Autopilot runs</div>
          <div id="ws-runs"><div class="ws-empty">Loading&hellip;</div></div>
        </section>
        <section class="ws-panel">
          <div class="ws-panel-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7 11l10-4M7 13l10 4"/></svg>MCP servers in this folder</div>
          <div id="ws-mcp"><div class="ws-empty">Loading&hellip;</div></div>
        </section>
        <section class="ws-panel">
          <div class="ws-panel-head"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>Danger zone</div>
          <div class="ws-danger"><span class="ws-danger-hint">Removes it from Husk; the folder itself is not touched.</span><button class="ghost-btn ghost-btn-danger" id="ws-delete">${WS_TRASH_SVG} Delete project</button></div>
        </section>
      </div>
    </div>`;

  $('#ws-back').addEventListener('click', closeWorkspaceView);
  const launch = $('#ws-launch');
  if (launch) launch.addEventListener('click', () => openProject(p.id));
  const leave = $('#ws-leave');
  if (leave) leave.addEventListener('click', () => clearActiveProject());
  const review = $('#ws-review-runs');
  if (review) review.addEventListener('click', () => setPage('autopilot'));
  const filesBtn = $('#ws-open-files');
  if (filesBtn) filesBtn.addEventListener('click', () => setPage('files'));
  const del = $('#ws-delete');
  if (del) del.addEventListener('click', () => deleteProject(p.id, p.name));
  const removeMissing = $('#ws-remove-missing');
  if (removeMissing) removeMissing.addEventListener('click', () => deleteProject(p.id, p.name));
  wsFillSessions(p);
  wsFillInspect(p);
}

// Right-rail extras: latest commit, run history and folder-scoped MCP servers.
// Each panel fills independently and degrades to its own empty line.
async function wsFillInspect(p) {
  let ins = null;
  let hist = null;
  try { ins = await window.husk.projects.inspect(p.id); } catch (_) {}
  try { hist = await window.husk.autopilot.history({ workspaceRoot: p.path }); } catch (_) {}
  if (wsOpenId !== p.id) return;

  const commitRow = $('#ws-commit-row');
  if (commitRow && ins && ins.ok && ins.lastCommit) {
    commitRow.hidden = false;
    const v = $('#ws-commit-v');
    if (v) v.textContent = `${ins.lastCommit.subject} (${fmtRelTime(ins.lastCommit.ms)})`;
  }

  const runsEl = $('#ws-runs');
  if (runsEl) {
    const runs = ((hist && hist.runs) || []).slice(0, 5);
    if (!runs.length) {
      // eslint-disable-next-line no-unsanitized/property -- Static markup.
      runsEl.innerHTML = '<div class="ws-empty">No Autopilot runs in this folder yet.</div><button class="ghost-btn ws-cta" id="ws-cta-autopilot">Run Autopilot</button>';
      const cta = $('#ws-cta-autopilot');
      if (cta) cta.addEventListener('click', () => setPage('autopilot'));
    } else {
      // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
      runsEl.innerHTML = runs.map((r) => {
        const cost = [];
        if (r.dollars) cost.push(`$${Number(r.dollars).toFixed(2)}`);
        if (r.tokens) cost.push(`${formatTokens(Number(r.tokens))} tokens`);
        return `
        <div class="ws-run">
          <div class="ws-run-main">
            <div class="ws-run-goal" title="${escapeHtml(r.goal || '')}">${escapeHtml(r.goal || '(no goal recorded)')}</div>
            <div class="ws-run-meta">${escapeHtml(fmtRelTime(r.endedAt))}${cost.length ? ' &middot; ' + escapeHtml(cost.join(' + ')) : ''}${r.status && r.status !== 'unknown' ? ` &middot; ${escapeHtml(r.status)}` : ''}</div>
          </div>
        </div>`;
      }).join('');
    }
    const more = ((hist && hist.runs) || []).length > 5;
    if (more) {
      const link = document.createElement('button');
      link.className = 'ghost-btn ws-runs-all';
      link.textContent = 'All runs';
      link.addEventListener('click', () => setPage('autopilot'));
      runsEl.appendChild(link);
    }
  }

  const mcpEl = $('#ws-mcp');
  if (mcpEl) {
    // Lists the resolved set the agent gets in this folder rather than one
    // storage location.
    const rows = (ins && ins.ok && ins.mcpRows) || [];
    const excluded = (ins && ins.ok && ins.mcpExcluded) || [];
    mcpEl.classList.toggle('is-empty', !rows.length);
    let html = rows.length
      ? `<div class="ws-mcp-list">${rows.map((r) => `<span class="ws-stat${r.source === 'project' ? ' ws-stat-project' : ''}" title="${r.source === 'project' ? 'Turned on for this project' : 'Inherited from the global list'}">${escapeHtml(r.id)}</span>`).join(' ')}</div>`
      : '<div class="ws-empty">No MCP servers run in this folder.</div>';
    if (excluded.length) {
      html += `<div class="ws-mcp-off">Off here: ${excluded.map((id) => escapeHtml(id)).join(', ')}</div>`;
    }
    html += `<button class="ghost-btn ws-cta" id="ws-cta-mcp">${rows.length || excluded.length ? 'Manage servers' : 'Add server'}</button>`;
    // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
    mcpEl.innerHTML = html;
    const cta = $('#ws-cta-mcp');
    if (cta) cta.addEventListener('click', async () => {
      // Land on the scope the user was just looking at, not the global list.
      if (ins && ins.mcpSupported && p && p.id === activeProjectId) mcpScope = 'project';
      setPage('mcp');
    });
  }
}

// The sessions panel fills in after the view paints; a slow transcript scan
// must not block the workspace opening.
async function wsFillSessions(p) {
  let res = null;
  try { res = await window.husk.sessions.list(); } catch (_) {}
  // The user may have navigated away while the list loaded.
  if (wsOpenId !== p.id) return;
  const list = $('#ws-sessions-list');
  if (!list) return;
  const norm = (s) => String(s || '').replace(/\/+$/, '');
  const here = norm(p.path);
  const matches = ((res && res.sessions) || [])
    .filter((s) => [s.projectPath, s.originalCwd, s.cwd].some((v) => v && norm(v) === here))
    .sort((a, b) => (b.mtime || b.startedMs || 0) - (a.mtime || a.startedMs || 0));
  const rows = matches.slice(0, 8);
  // The sessions tile shares this fetch. It counts every session in this
  // folder; the list below shows only the newest few.
  const tile = $('#ws-tile-sessions');
  if (tile) tile.textContent = String(matches.length);
  if (matches.length) {
    const newestMs = matches[0].mtime || matches[0].startedMs || 0;
    if (newestMs > (wsActivityMs(p) || 0)) {
      const act = $('#ws-tile-activity');
      if (act) act.textContent = fmtRelTime(newestMs);
    }
  }
  if (!rows.length) {
    // eslint-disable-next-line no-unsanitized/property -- Static markup.
    list.innerHTML = '<div class="ws-empty">No sessions in this folder yet.</div>';
    return;
  }
  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
  list.innerHTML = rows.map((s) => `
    <div class="ws-sess" role="button" tabindex="0" aria-label="Resume session: ${escapeHtml(s.title || 'untitled')}">
      <div class="ws-sess-main">
        <div class="ws-sess-title" title="${escapeHtml(s.title || '')}">${escapeHtml(s.title || '(untitled)')}</div>
        <div class="ws-sess-meta">${escapeHtml(fmtRelTime(s.mtime || s.startedMs))}</div>
      </div>
      <span class="ws-link-btn" aria-hidden="true">Resume<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></span>
    </div>`).join('');
  list.querySelectorAll('.ws-sess').forEach((row, i) => {
    const go = () => resumeSessionInChat({ id: rows[i].id, project: p.path, owner: rows[i].owner });
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

async function openProject(id) {
  if (!id) return;
  const res = await window.husk.projects.setActive(id);
  if (!res || !res.ok) return;
  activeProjectId = id;
  await refreshProjectsState();
  // Pass the project's path explicitly to restartPty so the new PTY lands in
  // the right cwd regardless of when setActive's config write settles.
  const project = (res.project && res.project.path) ? res.project : (projectsCache.find((p) => p.id === id) || {});
  await restartPty({ cwd: project.path || null });
  setPage('chat');
}

// Leave the active project: clear the selection so the agent runs in the
// default cwd again, and restart the PTY so the change takes effect.
async function clearActiveProject() {
  if (!activeProjectId) return;
  const res = await window.husk.projects.clearActive();
  if (!res || !res.ok) { toast((res && res.error) || 'Could not leave project', 'error'); return; }
  activeProjectId = null;
  await refreshProjectsState();
  await restartPty({ cwd: null });
  toast('Left project; the agent runs in your home folder', 'success');
}

async function refreshProjectsState() {
  // Re-pull list so lastUsedAt freshens, then update topbar chip + grid + cfg cache.
  const res = await window.husk.projects.list();
  if (!res || !res.ok) return;
  const prevActiveId = activeProjectId;
  projectsCache = res.projects || [];
  activeProjectId = res.activeProjectId || null;
  updateActiveProjectChip();
  if (currentPage === 'projects') paintProjectsSurface();
  // Reread config since the agent cwd may have changed.
  try { cfg = await window.husk.config.get(); } catch (_) {}
  // The workspace moved, so Files moves with it.
  if (activeProjectId !== prevActiveId) fxSyncToWorkspace();
  updateAgentPill && updateAgentPill();
  const cmdShort = (cfg.agentCommand || 'agent').split(/\s+/)[0];
  const active = projectsCache.find((p) => p.id === activeProjectId);
  const cwdLabel = active ? active.path : (cfg.agentCwd || huskHome);
  setChatSubBase({ tool: cmdShort, dir: cwdLabel });
}

function updateActiveProjectChip() {
  const chip = document.getElementById('topbar-project');
  const label = document.getElementById('topbar-project-name');
  if (!chip || !label) return;
  const active = projectsCache.find((p) => p.id === activeProjectId);
  if (!active) { chip.hidden = true; label.textContent = ''; return; }
  chip.hidden = false;
  label.textContent = active.name;
  chip.title = `Active project: ${active.name}\n${active.path}\nClick to manage projects`;
}

async function deleteProject(id, name) {
  if (!id) return;
  const confirmed = await openConfirmDialog({
    title: 'Delete project?',
    bodyHtml: `Remove <strong>${escapeHtml(name || 'this project')}</strong> from Husk. The folder on disk is not touched, only Husk's pin is removed.`,
    confirmLabel: 'Delete project',
  });
  if (!confirmed) return;
  const res = await window.husk.projects.delete(id);
  if (!res || !res.ok) {
    const t = document.getElementById('toast');
    if (t) { t.textContent = (res && res.error) || 'Could not delete project'; t.hidden = false; setTimeout(() => { t.hidden = true; }, 3500); }
    return;
  }
  await refreshProjectsState();
}

// Wire Projects page controls + Add Project modal.
{
  const search = document.getElementById('projects-search');
  if (search) search.addEventListener('input', debounce(() => { if (!wsOpenId) paintBoard(search.value); }, 120));
  // Derived state ages while the window is unfocused, so refresh on focus.
  window.addEventListener('focus', () => { if (currentPage === 'projects') renderProjects(); });

  const newBtn = document.getElementById('btn-projects-new');
  const modal = document.getElementById('new-project-modal');
  const nameEl = document.getElementById('npj-name');
  const pathEl = document.getElementById('npj-path');
  const pickEl = document.getElementById('npj-pick');
  const cancelBtn = document.getElementById('npj-cancel');
  const createBtn = document.getElementById('npj-create');
  // Named openProjectModal / closeProjectModal so the block-scoped function
  // declarations stay clear of the global window.open / window.close.
  function openProjectModal() {
    if (!modal) return;
    if (nameEl) nameEl.value = '';
    if (pathEl) { pathEl.value = ''; pathEl.classList.remove('field-invalid'); }
    modal.hidden = false;
    setTimeout(() => { try { nameEl && nameEl.focus(); } catch (_) {} }, 30);
  }
  function closeProjectModal() { if (modal) modal.hidden = true; }
  async function submit() {
    let name = (nameEl && nameEl.value || '').trim();
    const projPath = (pathEl && pathEl.value || '').trim();
    // Folder is required; the name is optional and derived from the path.
    if (pathEl) pathEl.classList.remove('field-invalid');
    if (!projPath) {
      if (pathEl) { pathEl.classList.add('field-invalid'); pathEl.focus(); }
      toast('Folder is required', 'error');
      return;
    }
    if (!name) name = projPath.split('/').filter(Boolean).pop() || 'project';
    const res = await window.husk.projects.create({ name, path: projPath });
    if (!res || !res.ok) {
      toast((res && res.error) || 'Could not add project', 'error');
      return;
    }
    closeProjectModal();
    await refreshProjectsState();
    if (currentPage === 'projects') await renderProjects();
  }
  if (newBtn) newBtn.addEventListener('click', openProjectModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeProjectModal);
  if (createBtn) createBtn.addEventListener('click', submit);
  if (pickEl) pickEl.addEventListener('click', async () => {
    try { const picked = await window.husk.dialog2.pickDir(); if (picked && pathEl) { pathEl.value = picked; pathEl.classList.remove('field-invalid'); } } catch (_) {}
  });
  if (pathEl) pathEl.addEventListener('input', () => pathEl.classList.remove('field-invalid'));
  // Close only via Cancel or Escape; a backdrop click must not discard the form.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) closeProjectModal();
  });

  // Topbar chip click navigates to Projects page.
  const chip = document.getElementById('topbar-project');
  if (chip) chip.addEventListener('click', () => setPage('projects'));
}

// ─── Workflows page ────────────────────────────────────────────────────────────

let workflowsCache = [];
let editingWorkflowId = null;
let activeRunId = null;
let wfEditor = null;          // Drawflow instance (created lazily, reused)
let wfSelectedNodeId = null;  // currently selected canvas node id

// Resolve a workflow graph to a linear ordered step list. Mirrors the
// main-process graphToOrderedSteps so the run view renders the same order.
function wfGraphOrder(graph) {
  const g = (graph && typeof graph === 'object') ? graph : { nodes: [], edges: [] };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasIncoming = new Set(edges.map((e) => e.to));
  let cur = nodes.find((n) => !hasIncoming.has(n.id)) || nodes[0];
  const order = [];
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    order.push(cur);
    const edge = edges.find((e) => e.from === cur.id);
    cur = edge ? byId.get(edge.to) : null;
  }
  return order;
}

// Sub-view switcher
function wfShowView(name) {
  $('#wf-list-view').hidden = name !== 'list';
  $('#wf-builder-view').hidden = name !== 'builder';
  $('#wf-run-view').hidden = name !== 'run';
}

async function renderWorkflows() {
  const grid = $('#wf-grid');
  if (!grid) return;
  workflowsCache = await window.husk.workflows.list();
  try {
    const res = await window.husk.workflows.runs();
    wfRunsCache = (res && res.ok && res.runs) || [];
  } catch (_) { wfRunsCache = []; }
  await wfRefreshSidecars();
  await wfRefreshReceipts();
  // A run in flight owns this page, so opening Workflows while one is going
  // lands back in the run view.
  if (activeRunId) { wfShowView('run'); return; }
  const adopted = await wfReattachRun();
  if (adopted) return;
  wfShowView('list');
  paintWorkflowList();
  wfPaintLiveBand(null);
}

let wfRunsCache = [];

// Where a workflow came from, keyed on its local id. One row per workflow that
// arrived as a file: the artifact it was installed from, the directory it is
// bound to, and whether its prompts have been read and agreed to. Fetched once
// per paint of the page and read synchronously while the grid is built, so the
// grid paints in one pass. Every use of this cache here is cosmetic.
let wfSidecarsCache = {};

async function wfRefreshSidecars() {
  const api = window.husk && window.husk.workflows;
  if (!api || typeof api.sidecars !== 'function') { wfSidecarsCache = {}; return; }
  try {
    const res = await api.sidecars();
    wfSidecarsCache = (res && res.ok && res.sidecars) || {};
  } catch (_) { wfSidecarsCache = {}; }
}

function wfSidecarFor(id) {
  const row = wfSidecarsCache[id];
  return (row && typeof row === 'object') ? row : null;
}

// What this machine has measured about each workflow: runs, median duration,
// outcomes, tokens, aggregated in the main process against the fingerprint of
// the graph as it stands now. Keyed on workflow id, fetched once per paint
// alongside the sidecars, and read by the receipts strip on a card.
let wfReceiptsCache = {};

async function wfRefreshReceipts() {
  const api = window.husk && window.husk.workflows;
  if (!api || typeof api.receipts !== 'function') { wfReceiptsCache = {}; return; }
  try {
    const res = await api.receipts();
    wfReceiptsCache = (res && res.ok && res.aggregates) || {};
  } catch (_) { wfReceiptsCache = {}; }
}

function wfAggregateFor(id) {
  const agg = wfReceiptsCache[id];
  return (agg && typeof agg === 'object') ? agg : null;
}

// ─── Reading a workflow at a glance ──────────────────────────────────────────

function wfRunsFor(id) { return wfRunsCache.filter((r) => r.workflowId === id); }

function wfRelTime(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function wfDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// The flow's own shape, drawn small, with its steps named. The preview works
// out the cell the graph in hand gets on the surface it is going to, fits the
// names into it, and takes one of two shapes:
//
//   labelled  a grid of named pills, in columns by reading order. The viewBox
//             is the surface's own pixel box, so a taller window magnifies it.
//   compact   a normalised scatter at a fixed 250 by 74, for a graph whose
//             cells cannot hold a word. The names stay on the element as its
//             accessible name.
//
// Step statuses map through WF_MINI_STATUS to one of five literals, names reach
// the DOM through WfxDom.text(), and a window without that module draws the
// compact shape. Node count is capped, and a graph past the cap gets the same
// placeholder an empty one gets.
const WF_MINI_STATUS = ['done', 'failed', 'skipped', 'cancelled', 'running'];
const WF_MINI_NODE_CAP = 512;
const WF_MINI_NS = 'http://www.w3.org/2000/svg';
const WF_MINI_ELLIPSIS = '…';
// Longest step name the fitter measures.
const WF_MINI_NAME_CAP = 96;
// How many names go into the accessible name before it stops reading as a
// label.
const WF_MINI_SPOKEN_NAMES = 12;

// The pixel box each surface gives this drawing, written as the smallest box it
// can ever be. A caller holding the host element passes its real width too, and
// then these are the fallback. Heights are declared rather than measured, since
// .wf-mini has no height until it is in the document.
const WF_MINI_SURFACES = {
  card: { w: 250, h: 74 },
  pattern: { w: 264, h: 62 },
  // The sheets take the modal column's width and the middle of the height
  // clamp, so the drawing fills the band at ordinary window sizes.
  panel: { w: 560, h: 88 },
};

// The labelled layout, in the surface's pixels. maxNodeW and maxNodeH cap the
// pill size, so a two-step flow spreads out instead of growing slabs.
// minLabelChars counts the ellipsis.
const WF_MINI_LABEL = {
  // padY stays thin, since the drawing already sits inside a padded frame.
  padX: 8, padY: 4, gapX: 14, gapY: 4,
  maxNodeW: 132, maxNodeH: 30, textPad: 5,
  minTextW: 22, minNodeH: 14, minLabelChars: 5,
  fontMin: 9, fontMax: 13, fontOfHeight: 0.55,
};

// The compact layout keeps these numbers literally: the stylesheet's rule on
// .wfx-pane .wf-mini works out the sheet's scale from this viewBox.
const WF_MINI_COMPACT = { w: 250, h: 74, pad: 12, nodeW: 26, nodeH: 13 };

function wfMiniNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Rounds numeric attributes to a tenth of a pixel at the single place they are
// set, so path data stays short.
function wfMiniSvg(tag, attrs) {
  const node = document.createElementNS(WF_MINI_NS, tag);
  for (const name of Object.keys(attrs)) {
    const value = attrs[name];
    if (value === null || value === undefined) continue;
    node.setAttribute(name, typeof value === 'number' ? String(Math.round(value * 10) / 10) : String(value));
  }
  return node;
}

function wfMiniRound(value) { return Math.round(value * 10) / 10; }

// The scrubbed form of a step name, or null when this window has no scrubber to
// run it through. Null tells the caller to draw the unlabelled shape.
function wfMiniName(node, index) {
  const kit = window.WfxDom;
  if (!kit || typeof kit.text !== 'function') return null;
  const raw = String((node && node.name) || '').trim() || `Step ${index + 1}`;
  try {
    return kit.text(raw.length > WF_MINI_NAME_CAP ? raw.slice(0, WF_MINI_NAME_CAP) : raw).data;
  } catch (_) { return null; }
}

// SVG has no text-overflow, so a label is cut before it is drawn and the cut
// measures real glyph widths through a 2d context set to the same font. The
// ruler runs at ten times the drawn size, which keeps sub-pixel precision on
// platforms that round small measurements.
let wfMiniRuler = null;
const WF_MINI_RULER_ZOOM = 10;

function wfMiniMeasurer(fontPx) {
  if (wfMiniRuler === null) {
    try { wfMiniRuler = document.createElement('canvas').getContext('2d') || false; }
    catch (_) { wfMiniRuler = false; }
  }
  let family = 'sans-serif';
  try { family = getComputedStyle(document.body).fontFamily || family; } catch (_) { /* the body is always there in practice */ }
  const ctx = wfMiniRuler || null;
  // Read per call rather than cached, so the preview follows a font the user
  // changes in preferences.
  if (ctx) ctx.font = `600 ${fontPx * WF_MINI_RULER_ZOOM}px ${family}`;
  return (value) => (ctx
    ? ctx.measureText(value).width / WF_MINI_RULER_ZOOM
    // Without a canvas, estimate a full em per character, which is what an
    // ideograph costs and roughly twice a lowercase Latin letter.
    : Array.from(value).length * fontPx);
}

function wfMiniFit(name, maxWidth, measure) {
  if (measure(name) <= maxWidth) return name;
  // Code points, not code units, so a cut never lands between the halves of a
  // surrogate pair and leaves half an emoji in the label.
  const chars = Array.from(name);
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join('')}${WF_MINI_ELLIPSIS}`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const head = chars.slice(0, lo).join('').replace(/\s+$/, '');
  return head ? `${head}${WF_MINI_ELLIPSIS}` : WF_MINI_ELLIPSIS;
}

// Columns by x, rows by y within a column. Snapping to columns trades the exact
// arrangement for pills wide enough to hold a word, and keeps what the
// arrangement said: what runs before what, and what fans out from where. The
// tolerance is a fraction of the graph's own width, so the same shape drawn at
// any scale clusters the same way.
function wfMiniColumns(nodes) {
  const xs = nodes.map((n) => wfMiniNum(n.x));
  const bounds = xs.reduce(
    (acc, x) => ({ min: Math.min(acc.min, x), max: Math.max(acc.max, x) }),
    { min: Infinity, max: -Infinity },
  );
  const tolerance = Math.max(1, (bounds.max - bounds.min) * 0.06);
  const order = nodes.map((n, i) => i).sort((a, b) => (xs[a] - xs[b]) || (a - b));
  const columns = [];
  let anchor = null;
  for (const i of order) {
    // Measured from the column's first member, so a long ramp of steps does
    // not collapse into one column a tolerance at a time.
    if (anchor === null || xs[i] - anchor > tolerance) { columns.push([]); anchor = xs[i]; }
    columns[columns.length - 1].push(i);
  }
  for (const column of columns) {
    column.sort((a, b) => (wfMiniNum(nodes[a].y) - wfMiniNum(nodes[b].y)) || (a - b));
  }
  return columns;
}

// One edge, drawn between two pills of the same size. A forward edge leaves the
// right face and arrives at the left one; anything else leaves the bottom and
// arrives at the top, which keeps the curve clear of the pills between them.
function wfMiniLink(from, to, width, height, taken) {
  const forward = to.x >= from.x + width;
  let d;
  if (forward) {
    const x1 = wfMiniRound(from.x + width);
    const y1 = wfMiniRound(from.y + height / 2);
    const x2 = wfMiniRound(to.x);
    const y2 = wfMiniRound(to.y + height / 2);
    const mx = wfMiniRound((x1 + x2) / 2);
    d = `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  } else {
    const x1 = wfMiniRound(from.x + width / 2);
    const y1 = wfMiniRound(from.y + height);
    const x2 = wfMiniRound(to.x + width / 2);
    const y2 = wfMiniRound(to.y);
    const my = wfMiniRound((y1 + y2) / 2);
    d = `M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
  }
  return wfMiniSvg('path', { d, class: taken ? 'wf-mini-edge is-taken' : 'wf-mini-edge' });
}

function wfMiniFrame(width, height) {
  return wfMiniSvg('svg', {
    class: 'wf-mini',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    // The drawing carries meaning, so it takes an image role and the
    // accessible name set below.
    role: 'img',
  });
}

function wfMiniPill(x, y, width, height, status) {
  return wfMiniSvg('rect', {
    x, y, width, height, rx: 4,
    class: status ? `wf-mini-node is-${status}` : 'wf-mini-node',
  });
}

function wfMiniStageStatus(column, statuses) {
  const values = column.map((i) => statuses[i]).filter(Boolean);
  if (values.includes('failed')) return 'failed';
  if (values.includes('running')) return 'running';
  if (values.includes('cancelled')) return 'cancelled';
  if (values.length && values.every((s) => s === 'done' || s === 'skipped')) return 'done';
  return '';
}

function wfMiniDenseCardNeeded(nodes, edges) {
  if (nodes.length >= 16 || edges.length >= 24) return true;
  const columns = wfMiniRanks(nodes, edges);
  const widest = columns.reduce((most, col) => Math.max(most, col.length), 0);
  return widest >= 6;
}

// A card is a summary surface, not a graph editor. Once a workflow is too big
// for individual pills to read, show a workflow signature: the journey across
// stages, one pronounced fan-out hub, and the few structural numbers that make
// the shape scannable at card size.
function wfMiniSignatureCard(nodes, edges, statuses) {
  const columns = wfMiniRanks(nodes, edges);
  const stages = columns.length || 1;
  const widest = columns.reduce((most, col) => Math.max(most, col.length), 0);
  const widestIndex = Math.max(0, columns.findIndex((col) => col.length === widest));
  const box = document.createElement('div');
  box.className = 'wf-signature';
  box.setAttribute('role', 'img');

  const hero = document.createElement('div');
  hero.className = 'wf-signature-hero';
  const total = document.createElement('strong');
  total.textContent = String(nodes.length);
  const totalLabel = document.createElement('span');
  totalLabel.textContent = 'steps';
  hero.append(total, totalLabel);
  box.appendChild(hero);

  const rail = document.createElement('div');
  rail.className = 'wf-signature-route';
  rail.style.setProperty('--stages', String(stages));
  columns.forEach((column, i) => {
    const stage = document.createElement('span');
    const status = wfMiniStageStatus(column, statuses);
    stage.className = [
      'wf-signature-dot',
      column.length > 1 ? 'is-fan' : '',
      i === widestIndex && widest > 1 ? 'is-hub' : '',
      status ? `is-${status}` : '',
    ].filter(Boolean).join(' ');
    stage.style.setProperty('--fan', String(column.length));
    stage.title = `Stage ${i + 1}: ${column.length} step${column.length === 1 ? '' : 's'}`;
    if (i === widestIndex && widest > 1) {
      const count = document.createElement('b');
      count.textContent = String(column.length);
      stage.appendChild(count);
    }
    rail.appendChild(stage);
  });
  box.appendChild(rail);

  const facts = document.createElement('div');
  facts.className = 'wf-signature-facts';
  const entries = [
    [String(stages), 'stages'],
    [`${widest}-way`, 'fan-out'],
    [String(edges.length), 'links'],
  ];
  for (const [value, label] of entries) {
    const item = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = value;
    const small = document.createElement('small');
    small.textContent = label;
    item.append(strong, small);
    facts.appendChild(item);
  }
  box.appendChild(facts);
  box.setAttribute('aria-label',
    `${nodes.length} steps across ${stages} stages; widest stage has ${widest} steps; ${edges.length} links`);
  return box;
}

// Returns the labelled drawing, or null when this graph cannot have one on this
// surface. Labels are fitted first and counted second: a label counts when the
// whole name survived or when minLabelChars of it did, and the drawing is
// labelled when most of them count.
function wfMiniLabelled(nodes, edges, statuses, names, surface) {
  const g = WF_MINI_LABEL;
  const columns = wfMiniColumns(nodes);
  const rows = columns.reduce((most, column) => Math.max(most, column.length), 0);
  const cellW = (surface.w - g.padX * 2) / columns.length;
  const cellH = (surface.h - g.padY * 2) / rows;
  const nodeW = Math.min(cellW - g.gapX, g.maxNodeW);
  const nodeH = Math.min(cellH - g.gapY, g.maxNodeH);
  const textW = nodeW - g.textPad * 2;
  // Floors below which a pill cannot hold type at fontMin, or hold a word at
  // all.
  if (textW < g.minTextW || nodeH < g.minNodeH) return null;

  const font = Math.min(g.fontMax, Math.max(g.fontMin, nodeH * g.fontOfHeight));
  const measure = wfMiniMeasurer(font);
  const labels = names.map((name) => wfMiniFit(name, textW, measure));
  const readable = labels.filter((label, i) => label === names[i]
    || Array.from(label).length >= g.minLabelChars).length;
  if (readable * 2 < labels.length) return null;

  const kit = window.WfxDom;
  const place = [];
  columns.forEach((column, c) => {
    const x = g.padX + c * cellW + (cellW - nodeW) / 2;
    // A short column centers against the tallest one, so a fan-out reads as a
    // fan rather than a staircase.
    const offset = (rows - column.length) / 2;
    column.forEach((i, r) => {
      place[i] = { x, y: g.padY + (r + offset) * cellH + (cellH - nodeH) / 2 };
    });
  });

  const svg = wfMiniFrame(surface.w, surface.h);
  for (const edge of edges) {
    svg.appendChild(wfMiniLink(place[edge.from], place[edge.to], nodeW, nodeH,
      wfMiniTaken(statuses, edge)));
  }
  labels.forEach((text, i) => {
    const at = place[i];
    svg.appendChild(wfMiniPill(at.x, at.y, nodeW, nodeH, statuses[i]));
    const label = wfMiniSvg('text', {
      x: at.x + nodeW / 2,
      y: at.y + nodeH / 2,
      class: 'wf-mini-label',
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      // Presentation attributes: the size is computed per graph and the fill
      // follows the surface's own text colour. A stylesheet rule on
      // .wf-mini-label overrides either.
      'font-size': font,
      'font-weight': 600,
      fill: 'currentColor',
      'unicode-bidi': 'isolate',
    });
    label.appendChild(kit.text(text));
    svg.appendChild(label);
  });
  return svg;
}

// The unlabelled drawing, built out of elements. Coordinates are the authored
// ones normalised into the box, so the arrangement is kept exactly as drawn,
// but only while it draws readably. When pills at those positions would sit on
// top of one another (a big graph in a small frame) the drawing falls back to
// the graph's own columns, the same layering Arrange writes, scaled to fit:
// a clump of stacked bricks is drawn as the train it actually is.
function wfMiniCompact(nodes, edges, statuses, boxOverride) {
  const g = boxOverride
    ? { ...WF_MINI_COMPACT, w: boxOverride.w, h: boxOverride.h }
    : WF_MINI_COMPACT;
  const bounds = nodes.reduce((acc, n) => {
    const x = wfMiniNum(n && n.x); const y = wfMiniNum(n && n.y);
    return {
      minX: Math.min(acc.minX, x), maxX: Math.max(acc.maxX, x),
      minY: Math.min(acc.minY, y), maxY: Math.max(acc.maxY, y),
    };
  }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const flatY = (bounds.maxY - bounds.minY) < 1;
  // Single row or column flows would otherwise squash into a line.
  const spanX = (bounds.maxX - bounds.minX) < 1 ? 1 : (bounds.maxX - bounds.minX);
  const spanY = flatY ? 1 : (bounds.maxY - bounds.minY);
  const place = nodes.map((n) => ({
    x: g.pad + ((wfMiniNum(n.x) - bounds.minX) / spanX) * (g.w - g.pad * 2 - g.nodeW),
    y: flatY
      ? (g.h - g.nodeH) / 2
      : g.pad + ((wfMiniNum(n.y) - bounds.minY) / spanY) * (g.h - g.pad * 2 - g.nodeH),
  }));

  if (wfMiniOverlaps(place, g.nodeW, g.nodeH)) {
    return wfMiniGrid(nodes, edges, statuses, g);
  }

  const svg = wfMiniFrame(g.w, g.h);
  for (const edge of edges) {
    svg.appendChild(wfMiniLink(place[edge.from], place[edge.to], g.nodeW, g.nodeH,
      wfMiniTaken(statuses, edge)));
  }
  place.forEach((at, i) => {
    svg.appendChild(wfMiniPill(at.x, at.y, g.nodeW, g.nodeH, statuses[i]));
  });
  return svg;
}

// Whether any two pills of one size collide. A shared edge is not a collision:
// the slack keeps pills that merely touch out of the count.
function wfMiniOverlaps(place, width, height) {
  const SLACK = 1;
  for (let a = 0; a < place.length; a += 1) {
    for (let b = a + 1; b < place.length; b += 1) {
      if (Math.abs(place[a].x - place[b].x) < width - SLACK
        && Math.abs(place[a].y - place[b].y) < height - SLACK) return true;
    }
  }
  return false;
}

// Columns by graph depth, indices in and indices out. Mirrors the layering
// half of the main process's layoutGraph so the thumbnail a dense workflow
// falls back to shows the same columns Arrange would write on the canvas.
function wfMiniRanks(nodes, edges) {
  const n = nodes.length;
  const preds = Array.from({ length: n }, () => []);
  const succs = Array.from({ length: n }, () => []);
  const indegree = new Array(n).fill(0);
  for (const e of edges) {
    if (e.from === e.to) continue;
    preds[e.to].push(e.from);
    succs[e.from].push(e.to);
    indegree[e.to] += 1;
  }
  const rank = new Array(n).fill(-1);
  const queue = [];
  for (let i = 0; i < n; i += 1) { if (!indegree[i]) { rank[i] = 0; queue.push(i); } }
  while (queue.length) {
    const i = queue.shift();
    for (const t of succs[i]) {
      rank[t] = Math.max(rank[t], rank[i] + 1);
      indegree[t] -= 1;
      if (!indegree[t]) queue.push(t);
    }
  }
  // Cycle members: one column right of their deepest ranked predecessor.
  for (let i = 0; i < n; i += 1) {
    if (rank[i] !== -1) continue;
    const ranked = preds[i].filter((p) => rank[p] !== -1);
    rank[i] = ranked.length ? Math.max(...ranked.map((p) => rank[p])) + 1 : 0;
  }
  const columns = [];
  for (let i = 0; i < n; i += 1) {
    if (!columns[rank[i]]) columns[rank[i]] = [];
    columns[rank[i]].push(i);
  }
  // Order each column by predecessor barycentre so fans stay together.
  const rowOf = new Map();
  (columns[0] || []).forEach((i, r) => rowOf.set(i, r));
  for (let c = 1; c < columns.length; c += 1) {
    const keyed = (columns[c] || []).map((i) => {
      const rows = preds[i].map((p) => rowOf.get(p)).filter((v) => v !== undefined);
      return { i, bary: rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity };
    });
    keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
    keyed.forEach((k, r) => rowOf.set(k.i, r));
    columns[c] = keyed.map((k) => k.i);
  }
  return columns.filter((column) => column && column.length);
}

// The fallback drawing for a graph too dense for its authored placement:
// pills on the rank grid, sized to what the frame can hold without overlap.
function wfMiniGrid(nodes, edges, statuses, g) {
  const columns = wfMiniRanks(nodes, edges);
  if (!columns.length) return wfMiniFrame(g.w, g.h);
  const rows = columns.reduce((most, column) => Math.max(most, column.length), 0);
  const cellW = (g.w - g.pad * 2) / columns.length;
  const cellH = (g.h - g.pad * 2) / rows;
  const nodeW = Math.max(6, Math.min(g.nodeW, cellW - 3));
  const nodeH = Math.max(3, Math.min(g.nodeH, cellH - 2));
  const place = [];
  columns.forEach((column, c) => {
    const x = g.pad + c * cellW + (cellW - nodeW) / 2;
    // A short column centers against the tallest one, so a fan reads as a fan.
    const offset = (rows - column.length) / 2;
    column.forEach((i, r) => {
      place[i] = { x, y: g.pad + (r + offset) * cellH + (cellH - nodeH) / 2 };
    });
  });
  const svg = wfMiniFrame(g.w, g.h);
  svg.classList.add('is-dense');
  for (const edge of edges) {
    svg.appendChild(wfMiniLink(place[edge.from], place[edge.to], nodeW, nodeH,
      wfMiniTaken(statuses, edge)));
  }
  place.forEach((at, i) => {
    svg.appendChild(wfMiniPill(at.x, at.y, nodeW, nodeH, statuses[i]));
  });
  return svg;
}

// An edge counts as taken when both ends ran, so the test is membership in the
// run vocabulary rather than the presence of any mark. A skipped end means the
// run went down another branch.
function wfMiniTaken(statuses, edge) {
  const from = statuses[edge.from];
  const to = statuses[edge.to];
  return WF_MINI_STATUS.includes(from) && from !== 'skipped'
    && WF_MINI_STATUS.includes(to) && to !== 'skipped';
}

function wfMiniPlaceholder(message) {
  const box = document.createElement('div');
  box.className = 'wf-mini is-empty';
  const text = document.createElement('span');
  text.textContent = message;
  box.appendChild(text);
  return box;
}

// The accessible name: the step names in full, for anyone not looking at the
// picture.
function wfMiniSpeak(svg, names, count) {
  const heading = `${count} step${count === 1 ? '' : 's'}`;
  const usable = names.filter((name) => typeof name === 'string' && name);
  if (!usable.length) { svg.setAttribute('aria-label', heading); return; }
  const spoken = usable.slice(0, WF_MINI_SPOKEN_NAMES);
  const rest = usable.length - spoken.length;
  svg.setAttribute('aria-label',
    `${heading}: ${spoken.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`);
}

// surface names one of WF_MINI_SURFACES and says how much room the caller is
// giving this; an unknown one is treated as a card. width is the host's real
// width in CSS pixels and only ever widens. marks is an optional Set of node
// ids to draw as needing attention, and a run outcome wins over a mark.
function wfMiniGraph(graph, lastRun, surface, width, marks) {
  const floor = WF_MINI_SURFACES[surface] || WF_MINI_SURFACES.card;
  const measured = Number(width);
  const box = {
    w: Number.isFinite(measured) && measured > floor.w ? measured : floor.w,
    h: floor.h,
  };
  const declared = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  const nodes = [];
  const at = new Map();
  for (const node of declared) {
    if (!node || typeof node !== 'object') continue;
    const id = (typeof node.id === 'string' || typeof node.id === 'number') ? String(node.id) : null;
    // On a duplicate id the first node keeps it and the second is left out, so
    // an edge naming that id resolves to one node.
    if (id === null || at.has(id)) continue;
    at.set(id, nodes.length);
    nodes.push(node);
  }
  if (!nodes.length) return wfMiniPlaceholder('no steps yet');
  if (nodes.length > WF_MINI_NODE_CAP) return wfMiniPlaceholder('graph too large to preview');

  const edges = [];
  for (const edge of ((graph && Array.isArray(graph.edges)) ? graph.edges : [])) {
    if (!edge) continue;
    const from = at.get(String(edge.from));
    const to = at.get(String(edge.to));
    if (from === undefined || to === undefined) continue;
    edges.push({ from, to });
  }

  const statuses = nodes.map(() => '');
  if (lastRun) {
    for (const step of (lastRun.steps || [])) {
      const index = step ? at.get(String(step.nodeId)) : undefined;
      if (index !== undefined && WF_MINI_STATUS.includes(step.status)) statuses[index] = step.status;
    }
  }

  if (marks instanceof Set && marks.size) {
    nodes.forEach((node, i) => {
      if (!statuses[i] && marks.has(String(node.id))) statuses[i] = 'unbound';
    });
  }

  const names = nodes.map(wfMiniName);
  if (surface === 'card' && wfMiniDenseCardNeeded(nodes, edges)) {
    const card = wfMiniSignatureCard(nodes, edges, statuses);
    wfMiniSpeak(card, names, nodes.length);
    return card;
  }
  // Names are drawn on the sheets and nowhere else: the panel is wide enough to
  // read them, while a card or pattern thumbnail would clip every one. The
  // accessible name below is unconditional, so the names are announced on every
  // surface.
  const labelled = (surface === 'panel' && names.every((name) => name !== null))
    ? wfMiniLabelled(nodes, edges, statuses, names, box)
    : null;
  // The sheet's fallback draws on the sheet's own box: a dense graph forced
  // through the card's 250px viewBox would waste the band it actually has.
  const svg = labelled || wfMiniCompact(nodes, edges, statuses, surface === 'panel' ? box : null);
  wfMiniSpeak(svg, names, nodes.length);
  return svg;
}

// The last few outcomes, oldest to newest, drawn beside the sentence that names
// the last one. The strip starts at two runs, where it begins to show a trend.
function wfHistoryDots(runs) {
  if (runs.length < 2) return '';
  const recent = runs.slice(0, 8).reverse();
  return `<span class="wf-dots">${recent.map((r) =>
    `<i class="wf-dot is-${escapeAttr(r.status)}" title="${escapeAttr(`${r.status} · ${wfRelTime(r.finishedAt)}`)}"></i>`
  ).join('')}</span>`;
}

function wfAgentsUsed(graph) {
  const set = new Set();
  ((graph && graph.nodes) || []).forEach((n) => {
    const c = (n.agentCommand || (cfg && cfg.agentCommand) || 'claude').trim().split(/\s+/)[0];
    if (c) set.add(c);
  });
  return [...set];
}

// Status and when, on every outcome. Duration lives in the receipts strip
// above, so all three outcomes carry the same two facts and the row keeps to
// one line on a narrow card.
function wfLastRunPill(runs) {
  if (!runs.length) return '';
  const r = runs[0];
  if (r.status === 'done') {
    return `<span class="wf-lr is-done"><i></i>Passed<span class="wf-lr-sep">&middot;</span>${escapeHtml(wfRelTime(r.finishedAt))}</span>`;
  }
  if (r.status === 'failed') {
    const where = r.failedStep ? ` at "${r.failedStep}"` : '';
    return `<span class="wf-lr is-failed"><i></i>Failed${escapeHtml(where)}<span class="wf-lr-sep">&middot;</span>${escapeHtml(wfRelTime(r.finishedAt))}</span>`;
  }
  return `<span class="wf-lr is-stopped"><i></i>Stopped<span class="wf-lr-sep">&middot;</span>${escapeHtml(wfRelTime(r.finishedAt))}</span>`;
}

// ─── Patterns ────────────────────────────────────────────────────────────────
// Topologies worth copying, each one a real graph. Clicking a card saves the
// flow and opens the builder with working nodes, edges and prompts. Every
// pattern runs on the engine as it stands: fan-out, join, agent-picked branches
// and conditional edges. Nothing loops, since a node runs once per run.

function wfPatternGraph(spec) {
  const ids = {};
  const rand = () => Math.random().toString(36).slice(2, 8);
  const nodes = spec.nodes.map((n) => {
    const id = `node-${Date.now()}-${rand()}`;
    ids[n.key] = id;
    return {
      id,
      name: n.name,
      agentCommand: wfDefaultAgentCommand(),
      model: null,
      branchMode: n.branchMode === 'ai' ? 'ai' : 'parallel',
      prompt: n.prompt,
      passContext: n.passContext || 'full',
      x: n.x,
      y: n.y,
    };
  });
  const edges = spec.edges.map(([from, to, condition]) => ({
    id: `edge-${Date.now()}-${rand()}`,
    from: ids[from],
    to: ids[to],
    condition: condition || { type: 'always', value: '' },
  }));
  return { nodes, edges };
}

const WF_ICONS = {
  chain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 14.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7"/><path d="M14.5 9.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7"/></svg>',
  fan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="12" r="2"/><circle cx="20" cy="5" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="20" cy="19" r="2"/><path d="M6 12h12M6 11l12-5M6 13l12 5"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h5l4-6h9"/><path d="M12 18h9"/><path d="M8 12l4 6"/><path d="M18 3l3 3-3 3"/><path d="M18 15l3 3-3 3"/></svg>',
  grade: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4"/><path d="M8 12l3 3 9-9"/></svg>',
  vote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.3 5.5 6 .5-4.6 3.9 1.4 5.8L12 15.6 6.9 18.7l1.4-5.8L3.7 9l6-.5z"/></svg>',
  ship: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>',
};

const WF_PATTERNS = [
  {
    id: 'chain',
    title: 'Prompt chain',
    icon: WF_ICONS.chain,
    blurb: 'The plainest useful shape. Each step narrows the work for the next, so the model that writes code never has to also decide what the work is.',
    trait: 'sequential · 3',
    build: () => ({
      name: 'Plan, build, verify',
      description: 'A linear chain: decide what to do, do it, then check it held.',
      graph: wfPatternGraph({
        nodes: [
          { key: 'plan', name: 'Plan', x: 60, y: 200, prompt: 'Read the task and the files it touches. Write a short, concrete plan: which files change, in what order, and what could break. Name the check that will prove it worked. Do not write any code yet.' },
          { key: 'build', name: 'Build', x: 400, y: 200, prompt: 'Carry out the plan above exactly. Make the smallest change that satisfies it. Do not refactor anything the plan did not name. Report the files you touched.' },
          { key: 'verify', name: 'Verify', x: 740, y: 200, passContext: 'last50', prompt: 'Run the project test suite and type checker against the change described above. Report what passed, what failed with the exact error, and anything the plan promised that is not actually in the code.' },
        ],
        edges: [['plan', 'build'], ['build', 'verify']],
      }),
    }),
  },
  {
    id: 'fanout',
    title: 'Parallel review',
    icon: WF_ICONS.fan,
    blurb: 'One brief, three reviewers running at the same time, one merge. Separate lenses catch what a single pass blurs together, and they cost you no extra wall clock.',
    trait: 'fan-out + join · 5',
    build: () => ({
      name: 'Three-lens review',
      description: 'Fan the same diff out to three reviewers, then merge their findings.',
      graph: wfPatternGraph({
        nodes: [
          { key: 'brief', name: 'Brief', x: 60, y: 260, prompt: 'Summarise the current diff: what changed, which files, and what the change is trying to do. Keep it under fifteen lines. The reviewers after this step read only your summary and the code, so leave nothing important out.' },
          { key: 'correct', name: 'Correctness', x: 400, y: 60, prompt: 'Review the change for correctness only. Look for off-by-one errors, wrong conditionals, unhandled null or error paths, and behaviour that differs from what the summary claims. For each finding give file, line, and the input that breaks it. If you find nothing, say so plainly.' },
          { key: 'security', name: 'Security', x: 400, y: 260, prompt: 'Review the change for security only. Look for unvalidated input reaching a sink, path traversal, injection, secrets in source, missing authorization checks, and unsafe deserialization. For each finding give file, line, and the concrete abuse case. If you find nothing, say so plainly.' },
          { key: 'perf', name: 'Performance', x: 400, y: 460, prompt: 'Review the change for performance only. Look for work inside loops that belongs outside, repeated file or network reads, unbounded growth, and blocking calls on a hot path. For each finding give file, line, and the size of input at which it starts to hurt. If you find nothing, say so plainly.' },
          { key: 'merge', name: 'Merge', x: 740, y: 260, prompt: 'Three independent reviews of the same change are above, each from one lens. Merge them into a single list. Drop duplicates, keep the sharpest wording of each finding, and order by severity. End with the one change you would make first.' },
        ],
        edges: [['brief', 'correct'], ['brief', 'security'], ['brief', 'perf'], ['correct', 'merge'], ['security', 'merge'], ['perf', 'merge']],
      }),
    }),
  },
  {
    id: 'router',
    title: 'Router',
    icon: WF_ICONS.route,
    blurb: 'A cheap first step reads the request and names the branch, then exactly one specialist runs. Classification and execution stop fighting over the same prompt.',
    trait: 'routed branch · 4',
    build: () => ({
      name: 'Triage and dispatch',
      description: 'Classify the incoming request, then run only the specialist it needs.',
      graph: wfPatternGraph({
        nodes: [
          { key: 'triage', name: 'Triage', x: 60, y: 260, branchMode: 'ai', prompt: 'Read the request and decide what kind of work it is: a defect to fix, a feature to add, or documentation to write. State the category and one sentence of reasoning, then restate the request in the terms the specialist will need.' },
          { key: 'bug', name: 'Bug fix', x: 400, y: 60, prompt: 'Treat this as a defect. Reproduce it first and quote the failure. Then find the root cause, fix it at the point the bad state enters the system, and add a regression test that fails without your fix.' },
          { key: 'feature', name: 'Feature', x: 400, y: 260, prompt: 'Treat this as new behaviour. List the files that need to change and the public surface you are adding. Implement it in the style of the surrounding code, then add tests for the happy path and one failure path.' },
          { key: 'docs', name: 'Docs', x: 400, y: 460, prompt: 'Treat this as a documentation task. Find where this subject is already described and update it in place rather than adding a second version. Match the existing tone and heading structure. Do not document behaviour you have not read in the code.' },
        ],
        edges: [['triage', 'bug'], ['triage', 'feature'], ['triage', 'docs']],
      }),
    }),
  },
  {
    id: 'evaluator',
    title: 'Evaluator and optimizer',
    icon: WF_ICONS.grade,
    blurb: 'Write, then grade, then take the path the grade earned. A weak draft gets rewritten from the critique; a strong one only gets tightened. Both land in the same sign-off.',
    trait: 'graded branch · 5',
    build: () => ({
      name: 'Draft, grade, sign off',
      description: 'Grade the draft, rewrite or tighten it accordingly, then sign it off.',
      graph: wfPatternGraph({
        nodes: [
          { key: 'draft', name: 'Draft', x: 60, y: 260, prompt: 'Produce a first version of the requested work. Prefer completeness over polish at this stage: it is going to be graded and revised. State any assumption you had to make.' },
          { key: 'grade', name: 'Grade', x: 400, y: 260, branchMode: 'ai', prompt: 'Grade the draft above against the original request. Score it out of ten on correctness, completeness and clarity, and list every concrete defect with the fix it needs. Be harsh: an unearned pass costs more than a harsh fail. If the total is eight or above, route to Tighten. Otherwise route to Rewrite.' },
          { key: 'rewrite', name: 'Rewrite', x: 740, y: 100, prompt: 'The critique above found real problems. Rewrite the draft from scratch using the critique as the specification. Do not defend the original. Address every listed defect and say which ones you could not resolve and why.' },
          { key: 'tighten', name: 'Tighten', x: 740, y: 420, prompt: 'The draft above passed. Do not restructure it. Fix only what the critique named, cut anything that repeats itself, and leave the argument and structure alone.' },
          { key: 'signoff', name: 'Sign off', x: 1080, y: 260, passContext: 'last50', prompt: 'Read the final version above against the original request, one requirement at a time. For each, say met or not met and quote the line that proves it. End with a single verdict: ready, or the shortest list of what still blocks it.' },
        ],
        edges: [['draft', 'grade'], ['grade', 'rewrite'], ['grade', 'tighten'], ['rewrite', 'signoff'], ['tighten', 'signoff']],
      }),
    }),
  },
  {
    id: 'ensemble',
    title: 'Ensemble vote',
    icon: WF_ICONS.vote,
    blurb: 'Three independent attempts at the same problem, then a judge that never saw them being written. Point each lane at a different agent or model and the disagreement itself becomes the signal.',
    trait: 'vote + judge · 4',
    build: () => ({
      name: 'Three attempts, one judge',
      description: 'Solve the same problem three ways in parallel, then pick the best.',
      graph: wfPatternGraph({
        nodes: [
          { key: 'a', name: 'Attempt A', x: 60, y: 60, passContext: 'none', prompt: 'Solve the problem the most direct way you can. Optimise for the smallest change that works. Show the full solution and name its main weakness.' },
          { key: 'b', name: 'Attempt B', x: 60, y: 260, passContext: 'none', prompt: 'Solve the problem the most robust way you can. Assume the inputs are hostile and the caller will get it wrong. Show the full solution and name what it costs in complexity.' },
          { key: 'c', name: 'Attempt C', x: 60, y: 460, passContext: 'none', prompt: 'Solve the problem the way that leaves the codebase easiest to change next year. Optimise for the reader. Show the full solution and name what you traded away to get there.' },
          { key: 'judge', name: 'Judge', x: 460, y: 260, prompt: 'Three independent solutions to the same problem are above. Score each on correctness, robustness and readability. Pick a winner and say why in two sentences. Then write the final version: the winner, with any clearly better idea from the other two grafted in.' },
        ],
        edges: [['a', 'judge'], ['b', 'judge'], ['c', 'judge']],
      }),
    }),
  },
  {
    id: 'guarded',
    title: 'Guarded release',
    icon: WF_ICONS.ship,
    blurb: 'The one shape where you want a machine reading the output, not a model. The edge out of the test step matches on the failure text, so a red suite can never reach the release notes.',
    trait: 'conditional edges · 4',
    build: () => ({
      name: 'Test, then release',
      description: 'Route on the literal test output: fix on red, write release notes on green.',
      graph: wfPatternGraph({
        nodes: [
          { key: 'test', name: 'Run tests', x: 60, y: 260, prompt: 'Run the full test suite and the type checker. Do not fix anything. Report the raw result. If anything at all failed, the last line of your response must be exactly SUITE_RED. If everything passed, the last line must be exactly SUITE_GREEN.' },
          { key: 'fix', name: 'Fix failures', x: 400, y: 100, prompt: 'The suite is red. Take the failures above one at a time. For each, decide whether the code or the test is wrong, fix that, and re-run the single failing test before moving on. Never delete or skip a test to make it pass.' },
          { key: 'notes', name: 'Release notes', x: 400, y: 420, prompt: 'The suite is green. Read the commits since the last tag and draft release notes grouped into features, fixes and breaking changes. Write them to a file. Do not tag and do not push.' },
          { key: 'report', name: 'Report', x: 740, y: 260, passContext: 'last50', prompt: 'Summarise what this run did in under ten lines: what the suite said, which path was taken, and what a human needs to look at before shipping.' },
        ],
        edges: [
          ['test', 'fix', { type: 'contains', value: 'SUITE_RED' }],
          ['test', 'notes', { type: 'otherwise', value: '' }],
          ['fix', 'report'],
          ['notes', 'report'],
        ],
      }),
    }),
  },
];

async function wfCreateFromPattern(pattern) {
  const spec = pattern.build();
  // Give the copy a distinct name when the pattern has been used before, so a
  // second "Router" does not read as a duplicate of the first.
  const taken = new Set(workflowsCache.map((w) => w.name));
  let name = spec.name;
  for (let i = 2; taken.has(name); i++) name = `${spec.name} ${i}`;
  const created = await window.husk.workflows.create({ ...spec, name, trigger: 'manual' });
  workflowsCache = await window.husk.workflows.list();
  toast(`${pattern.title} added. Edit the steps, then run it.`, 'success');
  openWorkflowBuilder(created && created.id);
}

function wfPaintPatterns() {
  const grid = $('#wfx-pattern-grid');
  if (!grid || grid.childElementCount) return;   // static: build once per session
  for (const p of WF_PATTERNS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'wfx-pattern';
    // eslint-disable-next-line no-unsanitized/property -- inline SVG and copy from a static constant, no user input
    card.innerHTML = `
      <div class="wfx-pattern-top">
        <div class="wfx-pattern-icon">${p.icon}</div>
        <div class="wfx-pattern-title">${escapeHtml(p.title)}</div>
      </div>
      <div class="wfx-pattern-shape"></div>
      <div class="wfx-pattern-body">${escapeHtml(p.blurb)}</div>
      <div class="wfx-pattern-foot">
        <span>${escapeHtml(p.trait)}</span>
        <span class="wfx-pattern-use">Use this<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg></span>
      </div>`;
    // The thumbnail is appended as elements, since the builder returns them and
    // puts step names in as text. The card goes into the grid first so the
    // shape can be drawn at the width the track actually gives it.
    card.addEventListener('click', () => wfCreateFromPattern(p));
    grid.appendChild(card);
    const shape = card.querySelector('.wfx-pattern-shape');
    if (shape) shape.appendChild(wfMiniGraph(p.build().graph, null, 'pattern', shape.clientWidth));
  }
}

// The last handful of runs across every flow, so the page answers "has this
// been working" without opening a single card.
function wfPaintRecentRuns() {
  const host = $('#wfx-runs');
  const section = $('#wfx-runs-section');
  const sub = $('#wfx-runs-sub');
  if (!host || !section) return;
  const runs = wfRunsCache.slice(0, 8);
  section.hidden = !runs.length;
  if (!runs.length) return;
  if (sub) sub.textContent = `last ${runs.length} of ${wfRunsCache.length}`;
  while (host.firstChild) host.removeChild(host.firstChild);
  for (const r of runs) {
    const wf = workflowsCache.find((w) => w.id === r.workflowId);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `wfx-run-row is-${r.status}`;
    const label = r.status === 'done' ? 'Passed' : (r.status === 'failed' ? 'Failed' : 'Stopped');
    const detail = r.status === 'failed' && r.failedStep
      ? `stopped at "${r.failedStep}" · ${wfDur(r.ms)}`
      : `${wfDur(r.ms)}`;
    // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
    row.innerHTML = `
      <span class="wfx-run-icon"></span>
      <span>
        <span class="wfx-run-name">${escapeHtml((wf && wf.name) || r.workflowName || 'Deleted workflow')}</span>
        <span class="wfx-run-sub">${escapeHtml(detail)}</span>
      </span>
      <span class="wfx-run-when">${escapeHtml(wfRelTime(r.finishedAt))}</span>
      <span class="wfx-run-pill">${escapeHtml(label)}</span>`;
    if (wf) row.addEventListener('click', () => wfOpenRun(wf.id, r));
    else row.disabled = true;
    host.appendChild(row);
  }
}

function paintWorkflowList() {
  const grid = $('#wf-grid');
  if (!grid) return;

  wfPaintPatterns();
  wfPaintRecentRuns();

  // The figures report on runs, so they stand only once a run exists.
  const week = wfRunsCache.filter((r) => Date.now() - new Date(r.finishedAt).getTime() < 7 * 864e5);
  const passed = week.filter((r) => r.status === 'done').length;
  const setStat = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
  const durations = wfRunsCache.map((r) => r.ms || 0).filter(Boolean).sort((a, b) => a - b);
  setStat('#wfx-stat-flows', String(workflowsCache.length));
  setStat('#wfx-stat-runs', String(week.length));
  setStat('#wfx-stat-pass', week.length ? `${Math.round((passed / week.length) * 100)}%` : 'n/a');
  setStat('#wfx-stat-median', durations.length ? wfDur(durations[Math.floor(durations.length / 2)]) : 'n/a');
  const figures = $('#wfx-figures');
  if (figures) figures.hidden = !wfRunsCache.length;

  // Nothing saved yet: the patterns gallery is the call to action, so the
  // "your workflows" section stays out of the way entirely.
  const mine = $('#wfx-mine-section');
  const mineSub = $('#wfx-mine-sub');
  if (mine) mine.hidden = !workflowsCache.length;
  if (mineSub) {
    mineSub.textContent = workflowsCache.length === 1
      ? '1 flow saved in this workspace'
      : `${workflowsCache.length} flows saved in this workspace`;
  }
  if (!workflowsCache.length) { grid.replaceChildren(); return; }

  // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
  grid.innerHTML = workflowsCache.map((w) => {
    const runs = wfRunsFor(w.id);
    const n = ((w.graph && w.graph.nodes) || []).length;
    const edgeCount = ((w.graph && w.graph.edges) || []).length;
    const denseCard = n >= 16 || edgeCount >= 24;
    const agents = wfAgentsUsed(w.graph);
    return `
      <div class="wf-card" data-id="${escapeAttr(w.id)}">
        <div class="wf-card-head">
          <div class="wf-card-title">${escapeHtml(w.name)}</div>
          <button class="wf-card-menu" data-menu="${escapeAttr(w.id)}" title="More" aria-label="More actions">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
          </button>
        </div>
        <div class="wf-card-desc">${escapeHtml(w.description || '')}</div>
        <div class="wf-card-graph"${runs.length ? ` data-open-run="${escapeAttr(w.id)}" title="Open the last run"` : ''}></div>
        <div class="wf-card-status">
          <span class="wf-card-when">${runs.length
            ? `<button class="wf-lr-btn" data-open-run="${escapeAttr(w.id)}" title="Open the last run">${wfLastRunPill(runs)}</button>`
            : '<span class="wf-lr is-never"><i></i>Never run</span>'}${wfHistoryDots(runs)}</span>
          <div class="wf-card-tags">
            ${agents.map((a) => `<span class="wf-tag">${escapeHtml(a)}</span>`).join('')}
            ${denseCard ? '' : `<span class="wf-tag is-quiet">${n} step${n !== 1 ? 's' : ''}</span>`}
            ${w.trigger === 'ai-suggested' ? '<span class="wf-tag is-ai">AI</span>' : ''}
          </div>
        </div>
        <div class="wf-card-actions">
          <button class="ghost-link wf-edit-btn" data-id="${escapeAttr(w.id)}">Edit</button>
          ${runs.length ? `<button class="ghost-link wf-last-btn" data-open-run="${escapeAttr(w.id)}">Last run</button>` : ''}
          <button class="card-cta wf-run-btn" data-id="${escapeAttr(w.id)}">Run<svg class="card-cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
        </div>
      </div>`;
  // The trailing tracks of the row would otherwise be empty background, so the
  // grid ends on the action that belongs there. No data-id, so the shared
  // .wf-card click handler opens the builder on a blank graph.
  }).join('') + `
      <button type="button" class="wf-card wf-ghost-card">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        <span>New workflow</span>
        <small>start from a blank graph</small>
      </button>`;

  // The graph previews, in the same synchronous pass that wrote the grid. The
  // drawing carries the step names, so it is appended as elements and every
  // name reaches the DOM as a text node.
  grid.querySelectorAll('.wf-card[data-id]').forEach((card) => {
    const w = workflowsCache.find((x) => x.id === card.dataset.id);
    const host = card.querySelector('.wf-card-graph');
    if (!w || !host) return;
    host.appendChild(wfMiniGraph(w.graph, wfRunsFor(w.id)[0], 'card', host.clientWidth));
  });

  // The receipts strip, one per saved card, inserted in the same synchronous
  // pass that wrote the grid. It goes above .wf-card-status, whose auto
  // margin-top absorbs a taller strip so the row stays aligned. Appended as
  // elements, and renderReceiptStrip returns one for every input, so each card
  // gets the same block in the same place.
  const strip = window.WfxArtifactUi && window.WfxArtifactUi.renderReceiptStrip;
  if (typeof strip === 'function') {
    grid.querySelectorAll('.wf-card[data-id]').forEach((card) => {
      const w = workflowsCache.find((x) => x.id === card.dataset.id);
      if (!w) return;
      const sidecar = wfSidecarFor(w.id);
      const status = card.querySelector('.wf-card-status');
      if (!status) return;
      // A workflow with no runs gets no strip, since the status line beside it
      // already says so. The strip appears as soon as a run exists.
      if (!wfRunsFor(w.id).length) return;
      card.insertBefore(strip({
        workflowId: w.id,
        workflowName: w.name,
        artifact: sidecar ? sidecar.artifact : null,
        // Runs that happened on this machine, against this graph. A locally
        // authored workflow has nothing else, and for an imported one this is
        // the reader's own evidence rather than the author's claim.
        aggregate: wfAggregateFor(w.id),
        // This machine's own finding about the log the author shipped. The
        // main process recomputes it on every sidecar read, so it is passed
        // straight through.
        chainCheck: (sidecar && sidecar.chainCheck) || null,
        // The record behind the chip is the imported file. A workflow written
        // here has none, so the strip draws the tier as a label.
        onOpen: (sidecar && sidecar.artifact) ? ((id) => wfOpenReceiptRecord(id)) : null,
      }), status);
    });
  }

  grid.querySelectorAll('.wf-run-btn').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation(); runWorkflow(e.currentTarget.dataset.id);
  }));
  grid.querySelectorAll('.wf-edit-btn').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation(); openWorkflowBuilder(e.currentTarget.dataset.id);
  }));
  grid.querySelectorAll('.wf-card-menu').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation(); wfOpenCardMenu(e.currentTarget, e.currentTarget.dataset.menu);
  }));
  grid.querySelectorAll('[data-open-run]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = e.currentTarget.dataset.openRun;
    const runs = wfRunsFor(id);
    if (runs.length) wfOpenRun(id, runs[0]);
  }));
  grid.querySelectorAll('.wf-card').forEach((card) => card.addEventListener('click', () => {
    openWorkflowBuilder(card.dataset.id);
  }));
}

// Duplicate / export / delete, in a popover on the card.
function wfOpenCardMenu(anchor, id) {
  document.querySelectorAll('.wf-menu-pop').forEach((m) => m.remove());
  const w = workflowsCache.find((x) => x.id === id);
  if (!w) return;
  const pop = document.createElement('div');
  pop.className = 'wf-menu-pop';
  pop.innerHTML = `
    <button data-act="duplicate">Duplicate</button>
    <button data-act="export">Export…</button>
    <button data-act="delete" class="is-danger">Delete</button>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;

  const close = () => pop.remove();
  pop.querySelector('[data-act="duplicate"]').addEventListener('click', async () => {
    close();
    // The main process copies the record, since it is the only side that can
    // copy the sidecar along with it.
    const res = await window.husk.workflows.duplicate(w.id);
    if (!res || !res.ok) { toast((res && res.error) || 'Could not duplicate this workflow', 'error'); return; }
    await renderWorkflows();
    toast(res.sidecar && res.sidecar.origin === 'imported'
      ? 'Workflow duplicated. The copy needs its own confirmation before it runs.'
      : 'Workflow duplicated', 'success');
  });
  // Publishing opens its own sheet, where what gets written, where it lands and
  // whether the run log travels with it are all chosen. The direct call is the
  // fallback when that module did not load, on the same channel with the log
  // left off.
  pop.querySelector('[data-act="export"]').addEventListener('click', async () => {
    // Read before close() removes the menu.
    const returnFocusTo = anchor;
    close();
    if (window.WfxPublish && typeof window.WfxPublish.open === 'function') {
      // onChanged carries a workflow the sheet edited back into workflowsCache,
      // which is what the builder opens from.
      window.WfxPublish.open(w, { returnFocusTo, onChanged: renderWorkflows });
      return;
    }
    const res = await window.husk.workflows.export({ workflowId: id });
    if (res && res.ok) { toast('Workflow exported', 'success'); return; }
    if (res && res.cancelled) return;
    toast((res && res.message) || 'Could not export this workflow', 'error');
  });
  pop.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    close();
    const ok = await openConfirmDialog({
      title: 'Delete this workflow?',
      bodyHtml: `<strong>${escapeHtml(w.name)}</strong> will be removed. Its run history is kept.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    await window.husk.workflows.delete(id);
    workflowsCache = workflowsCache.filter((x) => x.id !== id);
    paintWorkflowList();
    toast('Workflow deleted', 'success');
  });
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
}

// A run in flight is never lost: it is announced on the list too, with a way
// straight back into it.
function wfPaintLiveBand(run) {
  const band = $('#wf-live-band');
  if (!band) return;
  if (!run) { band.hidden = true; return; }
  const w = workflowsCache.find((x) => x.id === run.workflowId);
  const total = w ? wfAllNodes(w.graph).length : 0;
  const done = Object.values(run.stepStates || {}).filter((s) => s.status !== 'pending' && s.status !== 'running').length;
  const nameEl = band.querySelector('.wf-band-name');
  const metaEl = band.querySelector('.wf-band-meta');
  if (nameEl) nameEl.textContent = (w && w.name) || 'Workflow';
  if (metaEl) metaEl.textContent = `step ${Math.min(done + 1, total || 1)} of ${total || 1}`;
  band.hidden = false;
}

// ─── Canvas builder (Drawflow) ──────────────────────────────────────────────

// Options for a step's agent picker. Every option is a real command; a step
// with none yet preselects the resolved default.
function buildAgentOptions(currentVal) {
  const installed = (agentsCache || []).filter((a) => a.available);
  if (!installed.length) return `<option value="" disabled selected>No agent CLI installed</option>`;
  const chosen = currentVal || wfDefaultAgentCommand();
  const opts = [];
  // A step written against an agent this machine does not have keeps its own
  // value, listed at the top and selected, so the stored command survives an
  // edit made here.
  if (chosen && !installed.some((a) => a.command === chosen)) {
    opts.push(`<option value="${escapeHtml(chosen)}" selected>${escapeHtml(chosen)} · not installed here</option>`);
  }
  installed.forEach((a) => {
    const sel = (a.command === chosen) ? ' selected' : '';
    opts.push(`<option value="${escapeHtml(a.command)}"${sel}>${escapeHtml(a.label || a.command)}</option>`);
  });
  return opts.join('');
}

// HTML for one canvas node. Drawflow renders this; we update it in place
// when the config panel changes a node, since Drawflow does not re-render.
function wfNodeHtml(data) {
  const badge = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;
  return `<div class="wf-cv-node">
    <div class="wf-cv-node-top">
      <div class="wf-cv-node-badge">${badge}</div>
      <div class="wf-cv-node-name">${escapeHtml(data.name || 'Step')}</div>
    </div>
    <div class="wf-cv-node-meta">${escapeHtml(data.model ? `${data.agentCommand || 'no agent'} \u00b7 ${data.model}` : (data.agentCommand || 'no agent'))}</div>
  </div>`;
}

// Create the Drawflow editor once, reuse it (clear between opens) so its
// container listeners are not duplicated.
// Edge conditions keyed by `${fromDfId}->${toDfId}`. Drawflow connections
// cannot carry custom data, so conditions live here and merge in on export.
const wfEdgeConditions = {};
let wfSelectedEdge = null;
function wfEdgeKey(from, to) { return `${from}->${to}`; }

// A connection's endpoints live in the class list of its <svg>, which is the
// only place Drawflow records them:
//   connection · node_in_node-<in> · node_out_node-<out> · output_N · input_N
function wfConnectionParts(svg) {
  const classes = [...svg.classList];
  const inClass = classes.find((c) => c.startsWith('node_in_node-'));
  const outClass = classes.find((c) => c.startsWith('node_out_node-'));
  if (!inClass || !outClass) return null;
  return {
    inputId: inClass.slice('node_in_node-'.length),
    outputId: outClass.slice('node_out_node-'.length),
    outputPort: classes.find((c) => /^output_\d+$/.test(c)) || 'output_1',
    inputPort: classes.find((c) => /^input_\d+$/.test(c)) || 'input_1',
  };
}

// An unfinished Drawflow connection keeps its <svg> in the DOM with no endpoint
// classes, which draws as a line joined to nothing. Releasing a drag over
// anything that is not a step leaves one, so sweep after every release.
function wfSweepDanglingConnections() {
  const cont = $('#wf-canvas');
  if (!cont) return 0;
  let removed = 0;
  cont.querySelectorAll('svg.connection').forEach((svg) => {
    const classes = [...svg.classList];
    const joined = classes.some((c) => c.startsWith('node_in_node-'))
      && classes.some((c) => c.startsWith('node_out_node-'));
    if (!joined) { svg.remove(); removed += 1; }
  });
  return removed;
}

// Drawflow fires connectionRemoved from here, which is what drops the edge's
// stored condition, so this is the single path for removing a connection.
function wfRemoveConnectionEl(svg) {
  if (!wfEditor || !svg) return false;
  const parts = wfConnectionParts(svg);
  if (!parts) return false;
  wfEditor.removeSingleConnection(parts.outputId, parts.inputId, parts.outputPort, parts.inputPort);
  if (wfEditor.connection_selected && !wfEditor.connection_selected.isConnected) {
    wfEditor.connection_selected = null;
  }
  hideEdgePanel();
  return true;
}

function wfEnsureEditor() {
  if (wfEditor) {
    wfEditor.clear();
    Object.keys(wfEdgeConditions).forEach((k) => delete wfEdgeConditions[k]);
    return;
  }
  const container = $('#wf-canvas');
  if (!container || typeof Drawflow === 'undefined') return;
  wfEditor = new Drawflow(container);
  wfEditor.reroute = true;
  // Ctrl+scroll re-tiers the cards as the zoom crosses the threshold.
  wfEditor.on('zoom', (z) => wfApplyZoomTier(container, z));
  // Dropping a connection anywhere on the target node's body connects it to
  // that node's input. Each step has a single input, so first-input is the
  // right target.
  wfEditor.force_first_input = true;
  wfEditor.start();
  // Drawflow opens a delete popover on right-click. Suppress it: a node is
  // removed from its config panel, and the popover renders as a stray black box.
  const cont = $('#wf-canvas');
  if (cont) cont.addEventListener('contextmenu', (e) => e.preventDefault());
  // Open the config modal only on a real click: mousedown then mouseup on the
  // same node without dragging, so repositioning a node leaves it closed.
  // Drawflow keeps owning selection and drag.
  let wfDownNodeEl = null, wfDownX = 0, wfDownY = 0, wfNodeMoved = false;
  if (cont) {
    // Touching the canvas hands the keyboard back to it, so Delete reaches the
    // selected connection rather than the focused field.
    cont.addEventListener('mousedown', () => {
      const active = document.activeElement;
      if (!active || active === document.body) return;
      const tag = active.tagName;
      if ((tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') && !cont.contains(active)) active.blur();
    }, true);
    cont.addEventListener('mousedown', (e) => {
      const nodeEl = e.target.closest ? e.target.closest('.drawflow-node') : null;
      // Ignore the connector dots so starting a connection never opens the modal.
      if (!nodeEl || (e.target.closest && e.target.closest('.input, .output'))) { wfDownNodeEl = null; return; }
      wfDownNodeEl = nodeEl; wfDownX = e.clientX; wfDownY = e.clientY; wfNodeMoved = false;
    });
    cont.addEventListener('mousemove', (e) => {
      if (wfDownNodeEl && (Math.abs(e.clientX - wfDownX) > 4 || Math.abs(e.clientY - wfDownY) > 4)) wfNodeMoved = true;
    });
    cont.addEventListener('mouseup', () => {
      const el = wfDownNodeEl; wfDownNodeEl = null;
      if (el && !wfNodeMoved && el.id) showNodePanel(el.id.slice(5));
    });
  }
  // Double-click a line to remove it, in the capture phase so Drawflow's own
  // dblclick does not drop a reroute point instead. Double-clicking an existing
  // reroute point still reaches Drawflow's handler and removes that point.
  if (cont) {
    cont.addEventListener('dblclick', (e) => {
      const target = e.target;
      if (!target || !target.closest) return;
      if (target.classList && target.classList.contains('point')) return;
      const svg = target.closest('svg.connection');
      if (!svg) return;
      e.preventDefault();
      e.stopPropagation();
      if (wfRemoveConnectionEl(svg)) toast('Connection removed', 'success');
    }, true);
  }
  // Drawflow owns the release, so the sweep runs on the frame after it.
  if (cont) {
    cont.addEventListener('pointerup', () => {
      requestAnimationFrame(wfSweepDanglingConnections);
    });
  }
  wfEditor.on('nodeSelected', () => { hideEdgePanel(); });
  wfEditor.on('nodeUnselected', () => hideNodePanel());
  wfEditor.on('nodeRemoved', () => hideNodePanel());
  wfEditor.on('connectionSelected', (c) => { hideNodePanel(); showEdgePanel(c); });
  wfEditor.on('connectionUnselected', () => hideEdgePanel());
  wfEditor.on('connectionRemoved', (c) => { delete wfEdgeConditions[wfEdgeKey(c.output_id, c.input_id)]; });
}

function wfAddCanvasNode(data, x, y) {
  if (!wfEditor) return;
  const nodeData = {
    huskId: (data && data.huskId) || wfNewNodeId(),
    name: (data && data.name) || 'New Step',
    model: (data && data.model) || '',
    branchMode: (data && data.branchMode) || 'parallel',
    agentCommand: (data && data.agentCommand) || wfDefaultAgentCommand(),
    prompt: (data && data.prompt) || '',
    passContext: (data && data.passContext) || 'full',
  };
  const px = Number.isFinite(x) ? x : 60 + Math.round(Math.random() * 60);
  const py = Number.isFinite(y) ? y : 60 + Math.round(Math.random() * 60);
  wfEditor.addNode('step', 1, 1, px, py, 'wf-cv', nodeData, wfNodeHtml(nodeData));
}

function wfNewNodeId() {
  return `wfn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// A stored node coordinate, or the default for a node that has none. Zero is a
// real position and has to survive: the artifact format anchors every published
// layout on the origin, so an imported graph always contains a node at x=0 and
// a node at y=0.
const WF_NODE_FALLBACK_XY = 60;
function wfCoord(value) {
  return Number.isFinite(value) ? value : WF_NODE_FALLBACK_XY;
}

function wfLoadGraph(graph) {
  if (!wfEditor) return;
  const idMap = {};
  (graph.nodes || []).forEach((n) => {
    const data = {
      huskId: n.id || wfNewNodeId(),
      name: n.name || 'Step',
      agentCommand: n.agentCommand || '',
      model: n.model || '',
      branchMode: n.branchMode || 'parallel',
      prompt: n.prompt || '',
      passContext: n.passContext || 'full',
    };
    idMap[n.id] = wfEditor.addNode('step', 1, 1, wfCoord(n.x), wfCoord(n.y), 'wf-cv', data, wfNodeHtml(data));
  });
  (graph.edges || []).forEach((e) => {
    const from = idMap[e.from];
    const to = idMap[e.to];
    if (from != null && to != null) {
      try { wfEditor.addConnection(from, to, 'output_1', 'input_1'); } catch (_) {}
      wfEdgeConditions[wfEdgeKey(from, to)] = e.condition || { type: 'always', value: '' };
    }
  });
}

function wfExportGraph() {
  if (!wfEditor) return { nodes: [], edges: [] };
  const dump = wfEditor.export();
  const data = (dump && dump.drawflow && dump.drawflow.Home && dump.drawflow.Home.data) || {};
  const nodes = [];
  const edges = [];
  // Drawflow's id is a render detail; the husk id is what everything else keys on.
  const stable = {};
  Object.keys(data).forEach((id) => {
    stable[id] = ((data[id] || {}).data || {}).huskId || wfNewNodeId();
  });
  Object.keys(data).forEach((id) => {
    const n = data[id];
    const d = n.data || {};
    nodes.push({
      id: stable[id],
      name: d.name || 'Step',
      agentCommand: d.agentCommand || null,
      model: d.model || null,
      branchMode: d.branchMode === 'ai' ? 'ai' : 'parallel',
      prompt: d.prompt || '',
      passContext: d.passContext || 'full',
      x: n.pos_x, y: n.pos_y,
    });
    Object.keys(n.outputs || {}).forEach((ok) => {
      ((n.outputs[ok] || {}).connections || []).forEach((c) => {
        const cond = wfEdgeConditions[wfEdgeKey(id, c.node)] || { type: 'always', value: '' };
        edges.push({
          id: `edge-${stable[id]}-${stable[c.node]}`,
          from: stable[id],
          to: stable[c.node],
          condition: cond,
        });
      });
    });
  });
  return { nodes, edges };
}

function showNodePanel(id) {
  if (!wfEditor) return;
  wfSelectedNodeId = id;
  const node = wfEditor.getNodeFromId(id);
  const d = (node && node.data) || {};
  $('#wf-np-name').value = d.name || '';
  // eslint-disable-next-line no-unsanitized/property -- option values escaped in buildAgentOptions
  $('#wf-np-agent').innerHTML = buildAgentOptions(d.agentCommand || '');
  $('#wf-np-context').value = d.passContext || 'full';
  $('#wf-np-prompt').value = d.prompt || '';
  wfClearGenState();
  const branchSel = $('#wf-np-branch');
  if (branchSel) branchSel.value = d.branchMode === 'ai' ? 'ai' : 'parallel';
  const outCount = wfEditor.export ? wfCountOutgoing(id) : 0;
  const branchRow = $('#wf-np-branch-row');
  if (branchRow) branchRow.hidden = outCount < 2;
  // Width first, while the panel is still display:none, so restoring a wide
  // panel lands at its size instead of animating out to it on every open.
  wfRestoreDrawerWidth();
  $('#wf-node-panel').hidden = false;
  // Now the editor has a real width, so the mirror can measure against it.
  wfUpdateGutter();
  wfLoadNodeModels(d.agentCommand || '', d.model || '');
}

// Outgoing edges from a Drawflow node, so the branch-mode control only appears
// where it means something (2+ next steps).
function wfCountOutgoing(dfId) {
  try {
    const node = wfEditor.getNodeFromId(dfId);
    const outs = (node && node.outputs) || {};
    return Object.values(outs).reduce((n, o) => n + (((o || {}).connections || []).length), 0);
  } catch (_) { return 0; }
}

// A step's model dropdown. Loads the chosen agent's real catalog, the same
// source the Autopilot page uses, so a node can run gemini while the next runs
// claude opus. Cached per vendor so switching nodes does not re-probe.
const wfModelCache = new Map();   // command -> catalog
let wfModelSeq = 0;

function wfAgentCommandForPanel() {
  const chosen = ($('#wf-np-agent') || {}).value || '';
  return (chosen || (cfg && cfg.agentCommand) || 'claude').trim().split(/\s+/)[0];
}

// The agent a new step is given: the configured one when installed, else the
// first installed one, else the empty string. Always a bare basename.
function wfDefaultAgentCommand() {
  const installed = (agentsCache || []).filter((a) => a && a.available && a.command);
  if (!installed.length) return '';
  const configured = (cfg && cfg.agentCommand ? String(cfg.agentCommand) : '').trim().split(/\s+/)[0];
  if (configured && installed.some((a) => a.command === configured)) return configured;
  return String(installed[0].command);
}

function wfPaintModelOptions(catalog, pinned) {
  const sel = $('#wf-np-model');
  const custom = $('#wf-np-model-custom');
  const hint = $('#wf-np-model-hint');
  if (!sel) return;
  const models = (catalog && catalog.models) || [];
  const opts = ['<option value="">Default</option>'];
  let matched = !pinned;
  models.forEach((m) => {
    // Catalog entries come as {value,label}, {id,...}, or a bare string.
    const id = typeof m === 'string' ? m : (m.value || m.id || m.name || '');
    const label = typeof m === 'string' ? m : (m.label || m.value || m.id || m.name || '');
    if (!id) return;
    if (id === pinned) matched = true;
    opts.push(`<option value="${escapeAttr(id)}"${id === pinned ? ' selected' : ''}>${escapeHtml(label)}</option>`);
  });
  opts.push(`<option value="__custom__"${!matched && pinned ? ' selected' : ''}>Custom...</option>`);
  // eslint-disable-next-line no-unsanitized/property -- ids/labels escaped above
  sel.innerHTML = opts.join('');
  if (!matched && pinned && custom) { custom.hidden = false; custom.value = pinned; }
  else if (custom) { custom.hidden = true; custom.value = ''; }
  if (hint) {
    if (catalog && catalog.error) hint.textContent = catalog.error;
    else if (catalog && !catalog.supported) hint.textContent = `${catalog.providerLabel || 'This agent'} does not expose a model flag; the default is used.`;
    else if (models.length) hint.textContent = `${models.length} model${models.length === 1 ? '' : 's'} from ${catalog.sourceLabel || catalog.providerLabel || 'the CLI'}`;
    else hint.textContent = '';
  }
}

async function wfLoadNodeModels(command, pinned, opts = {}) {
  const sel = $('#wf-np-model');
  const hint = $('#wf-np-model-hint');
  if (!sel) return;
  const cmd = (command || (cfg && cfg.agentCommand) || 'claude').trim().split(/\s+/)[0];
  const seq = ++wfModelSeq;

  if (!opts.refresh && wfModelCache.has(cmd)) {
    wfPaintModelOptions(wfModelCache.get(cmd), pinned);
    return;
  }
  // eslint-disable-next-line no-unsanitized/property -- static
  sel.innerHTML = '<option value="">Loading...</option>';
  if (hint) hint.textContent = `Reading ${cmd}'s models...`;
  let catalog = null;
  try { catalog = await window.husk.models.list({ command: cmd, refresh: !!opts.refresh, fast: !opts.refresh }); } catch (_) {}
  if (seq !== wfModelSeq) return;   // a newer load won
  catalog = catalog || { models: [], supported: false };
  wfModelCache.set(cmd, catalog);
  wfPaintModelOptions(catalog, pinned);
}

function hideNodePanel() {
  wfSelectedNodeId = null;
  const panel = $('#wf-node-panel');
  if (panel) panel.hidden = true;
  wfClearGenState();
  wfDeselectNode();
}

function showEdgePanel(conn) {
  if (!conn) return;
  wfSelectedEdge = { from: conn.output_id, to: conn.input_id };
  const cond = wfEdgeConditions[wfEdgeKey(conn.output_id, conn.input_id)] || { type: 'always', value: '' };
  $('#wf-ec-type').value = cond.type || 'always';
  $('#wf-ec-value').value = cond.value || '';
  wfUpdateEdgeValueRow();
  $('#wf-edge-panel').hidden = false;
}

function hideEdgePanel() {
  wfSelectedEdge = null;
  const p = $('#wf-edge-panel');
  if (p) p.hidden = true;
}

function wfUpdateEdgeValueRow() {
  const type = $('#wf-ec-type').value;
  const show = type === 'contains' || type === 'regex';
  const row = $('#wf-ec-value-row');
  const label = $('#wf-ec-value-label');
  const input = $('#wf-ec-value');
  if (row) row.hidden = !show;
  if (label) label.textContent = type === 'regex' ? 'Regex pattern' : 'Text to look for';
  if (input) input.placeholder = type === 'regex' ? 'e.g. ^(yes|true)' : 'e.g. YES';
}

function wfSyncEdgePanel() {
  if (!wfSelectedEdge) return;
  wfEdgeConditions[wfEdgeKey(wfSelectedEdge.from, wfSelectedEdge.to)] = {
    type: $('#wf-ec-type').value || 'always',
    value: $('#wf-ec-value').value || '',
  };
  wfUpdateEdgeValueRow();
}

function wfSyncPanelToNode() {
  if (!wfEditor || wfSelectedNodeId == null) return;
  // updateNodeDataFromId replaces the node's data wholesale, so carry the
  // stable id through and the step keeps its run history.
  let existing = {};
  try { existing = (wfEditor.getNodeFromId(wfSelectedNodeId) || {}).data || {}; } catch (_) {}
  const modelSel = ($('#wf-np-model') || {}).value || '';
  const model = modelSel === '__custom__'
    ? (($('#wf-np-model-custom') || {}).value || '').trim()
    : (modelSel === 'Loading...' ? '' : modelSel);
  const data = {
    huskId: existing.huskId || wfNewNodeId(),
    // Cut by character, not code unit.
    name: Array.from($('#wf-np-name').value || 'Step').slice(0, 64).join(''),
    agentCommand: $('#wf-np-agent').value || '',
    model: model || '',
    branchMode: (($('#wf-np-branch') || {}).value === 'ai') ? 'ai' : 'parallel',
    prompt: $('#wf-np-prompt').value || '',
    passContext: $('#wf-np-context').value || 'full',
  };
  wfEditor.updateNodeDataFromId(wfSelectedNodeId, data);
  const nameEl = document.querySelector(`#wf-canvas [id="node-${wfSelectedNodeId}"] .wf-cv-node-name`);
  const metaEl = document.querySelector(`#wf-canvas [id="node-${wfSelectedNodeId}"] .wf-cv-node-meta`);
  if (nameEl) nameEl.textContent = data.name;
  // The node's own label names its agent and model, so the graph shows the
  // mix at a glance without opening anything.
  if (metaEl) metaEl.textContent = wfNodeAgentLabel(data);
}

// The label under a step: its agent and model, or "no agent".
function wfNodeAgentLabel(d) {
  const agent = (d.agentCommand || 'no agent');
  return d.model ? `${agent} \u00b7 ${d.model}` : agent;
}

function wfSyncNameCount() {
  const inp = $('#wf-name-input');
  const count = $('#wf-name-count');
  if (!inp || !count) return;
  const max = parseInt(inp.getAttribute('maxlength'), 10) || 80;
  const len = (inp.value || '').length;
  count.textContent = `${len}/${max}`;
  count.classList.toggle('near-limit', len >= max * 0.9);
}

let wfBuilderReady = false;

function openWorkflowBuilder(editId) {
  wfBuilderReady = false;
  editingWorkflowId = editId || null;
  const existing = editId ? workflowsCache.find((w) => w.id === editId) : null;
  if ($('#wf-name-input')) $('#wf-name-input').value = existing ? existing.name : '';
  wfSyncNameCount();
  if ($('#wf-trigger-select')) $('#wf-trigger-select').value = existing ? (existing.trigger || 'manual') : 'manual';
  wfShowView('builder');
  wfRestoreLegend();
  hideNodePanel();
  hideEdgePanel();
  // Drawflow needs the container visible and sized before start(), so force the
  // layout and build it now rather than deferring on a timer.
  const host = $('#wf-canvas');
  if (host) void host.offsetWidth;
  wfEnsureEditor();
  const graph = (existing && existing.graph) ? existing.graph : { nodes: [], edges: [] };
  wfLoadGraph(graph);
  if (!graph.nodes || !graph.nodes.length) wfAddCanvasNode(null, 80, 80);
  // Frame the whole flow on open, the way the run view does.
  wfFitEditor(wfEditor, '#wf-canvas', graph);
  try { $('#wf-name-input').focus(); } catch (_) {}
  wfBuilderReady = true;
}

// Returns the saved workflow's id. `stay` keeps the builder open (Run saves and
// then runs, rather than bouncing the user back to the list first).
async function saveWorkflow(opts = {}) {
  if (!wfEditor || !wfBuilderReady) { toast('The canvas is not ready yet', 'error'); return null; }
  const name = (($('#wf-name-input') || {}).value || '').trim();
  if (!name) { toast('Workflow needs a name', 'error'); return null; }
  const graph = wfExportGraph();
  if (!graph.nodes.length) { toast('Add at least one node', 'error'); return null; }
  const trigger = (($('#wf-trigger-select') || {}).value) || 'manual';
  const payload = { name, graph, trigger };
  let id = editingWorkflowId;
  if (editingWorkflowId) {
    payload.id = editingWorkflowId;
    await window.husk.workflows.update(payload);
  } else {
    const res = await window.husk.workflows.create(payload);
    id = (res && (res.id || (res.workflow && res.workflow.id))) || null;
    if (id) editingWorkflowId = id;
  }
  workflowsCache = await window.husk.workflows.list();
  if (!id) {
    // create() may not hand the id back; find it by name as a fallback.
    const found = workflowsCache.find((w) => w.name === name);
    id = found ? found.id : null;
  }
  if (opts.stay) return id;
  wfShowView('list');
  paintWorkflowList();
  return id;
}

// Run view
const wfStepTimers = {};   // nodeId -> { interval, startedAt }
let wfLastRunningNode = null;

function wfClearTimers() {
  Object.values(wfStepTimers).forEach((t) => { try { clearInterval(t.interval); } catch (_) {} });
  Object.keys(wfStepTimers).forEach((k) => delete wfStepTimers[k]);
}

// Every graph node in execution-ish order: BFS from the start node following
// all edges, then any unreachable nodes appended. Branching means not all of
// these will run; the run view shows the whole graph and lights up the path.
function wfAllNodes(graph) {
  const g = (graph && typeof graph === 'object') ? graph : { nodes: [], edges: [] };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hasIncoming = new Set(edges.map((e) => e.to));
  const start = nodes.find((n) => !hasIncoming.has(n.id)) || nodes[0];
  const order = [];
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    order.push(n);
    edges.filter((e) => e.from === n.id).forEach((e) => {
      const t = byId.get(e.to);
      if (t && !seen.has(t.id)) queue.push(t);
    });
  }
  nodes.forEach((n) => { if (!seen.has(n.id)) order.push(n); });
  return order;
}

function wfActIcon(kind) {
  if (kind === 'tool') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z"/></svg>`;
  if (kind === 'text') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>`;
  if (kind === 'error') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>`;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/></svg>`;
}

function wfSetProgress(done, total, pctOverride) {
  const fill = $('#wf-progress-fill');
  const label = $('#wf-progress-label');
  const pct = pctOverride != null ? pctOverride : (total ? Math.round((done / total) * 100) : 0);
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${done} step${done !== 1 ? 's' : ''} run`;
}

let wfActiveRun = { total: 0, done: 0 };

// ─── Live run: the flow, played out on its own graph ─────────────────────────
// The run is watched on the same canvas the flow was drawn on. A node lights up
// while it runs, edges fire as they are taken, and clicking any node opens its
// terminal. The terminal is a view onto a buffer held in the main process, so
// opening it late still shows everything, and closing it stops nothing.

let wfRunEditor = null;        // read-only Drawflow for the run canvas
let wfRunDfId = {};            // husk node id -> drawflow node id
let wfRunGraph = null;
let wfRunWorkflow = null;
let wfNodeStatus = {};         // husk node id -> pending|running|done|failed|cancelled|skipped
let wfNodeStartedAt = {};
let wfNodeLive = {};           // husk node id -> what the step is doing right now

function wfRunNodeEl(nodeId) {
  const df = wfRunDfId[nodeId];
  // Scoped to the run canvas: the builder's Drawflow numbers its nodes from 1
  // too, so when a run starts from the builder the document holds two elements
  // per id and a global lookup would paint the run onto the hidden builder.
  return df ? document.querySelector(`#wf-run-canvas [id="node-${df}"]`) : null;
}

// Read-only canvas: the same graph, not editable. Drawflow's own selection
// events are unreliable in fixed mode, so node clicks are wired by hand.
function wfBuildRunCanvas(workflow) {
  const container = $('#wf-run-canvas');
  if (!container || typeof Drawflow === 'undefined') return;
  if (wfRunEditor) { try { wfRunEditor.clear(); } catch (_) {} }
  else {
    wfRunEditor = new Drawflow(container);
    wfRunEditor.reroute = true;
    wfRunEditor.on('zoom', (z) => wfApplyZoomTier(container, z));
    wfRunEditor.start();
    wfRunEditor.editor_mode = 'fixed';
  }
  wfRunDfId = {};
  const graph = workflow.graph || { nodes: [], edges: [] };
  wfRunGraph = graph;

  // The badge is the step's place in the run, so it comes from a walk of the
  // graph rather than the order of graph.nodes, which a published artifact
  // sorts by step hash. orderedSteps is the same traversal the install sheet
  // numbers with, borrowed so the two surfaces stay in step; wfAllNodes is the
  // fallback when that module did not load.
  const walk = (window.WfxArtifactUi && typeof window.WfxArtifactUi.orderedSteps === 'function')
    ? window.WfxArtifactUi.orderedSteps(graph)
    : wfAllNodes(graph);
  const stepNumber = new Map(walk.map((node, i) => [node.id, i + 1]));

  (graph.nodes || []).forEach((n, i) => {
    const html = `
      <div class="wf-rn">
        <div class="wf-rn-top">
          <span class="wf-rn-idx">${stepNumber.get(n.id) || i + 1}</span>
          <span class="wf-rn-name">${escapeHtml(n.name || 'Step')}</span>
          <span class="wf-rn-timer" data-timer="${escapeAttr(n.id)}"></span>
        </div>
        <div class="wf-rn-foot">
          <span class="wf-rn-dot"></span>
          <span class="wf-rn-live" data-live="${escapeAttr(n.id)}">Pending</span>
          <span class="wf-rn-open" title="Open this step's terminal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6M12 19h8"/></svg>
          </span>
        </div>
      </div>`;
    // wfCoord treats 0 as a coordinate. Publishing re-anchors the layout on
    // the origin, so an imported graph holds a node at x=0 and one at y=0.
    const dfId = wfRunEditor.addNode(
      'step', 1, 1, wfCoord(n.x), wfCoord(n.y), 'wf-rn-node', { huskId: n.id }, html,
    );
    wfRunDfId[n.id] = dfId;
  });

  (graph.edges || []).forEach((e) => {
    const a = wfRunDfId[e.from];
    const b = wfRunDfId[e.to];
    if (a && b) { try { wfRunEditor.addConnection(a, b, 'output_1', 'input_1'); } catch (_) {} }
  });

  // Clicking anywhere on a node opens its terminal.
  (graph.nodes || []).forEach((n) => {
    const el = wfRunNodeEl(n.id);
    if (el) el.addEventListener('click', () => wfOpenTerm(n.id));
  });

  wfNodeStatus = {};
  wfNodeStartedAt = {};
  wfNodeLive = {};
  (graph.nodes || []).forEach((n) => wfSetNodeState(n.id, 'pending'));
  wfFitRunCanvas(graph);
}

// Frame the whole graph. A flow laid out wider than the canvas would otherwise
// run off the edge, and the step you care about could be the one you cannot see.
let wfFitPending = 0;
window.addEventListener('resize', () => {
  if (wfFitPending) cancelAnimationFrame(wfFitPending);
  wfFitPending = requestAnimationFrame(() => { wfFitPending = 0; wfFitRunCanvas(wfRunGraph); });
});

function wfFitRunCanvas(graph) { wfFitEditor(wfRunEditor, '#wf-run-canvas', graph); }

// Frame a whole graph inside its canvas. Shared by the builder and the run view
// so a flow is laid out the same way in both.
function wfFitEditor(editor, hostSel, graph) {
  const host = $(hostSel);
  const pre = host && host.querySelector('.drawflow');
  const nodes = (graph && graph.nodes) || [];
  if (!editor || !host || !pre || !nodes.length) return;
  const NODE_W = 216;
  const NODE_H = 64;
  const PAD = 28;
  // The same reading of a coordinate the canvases place nodes with, so the
  // frame is drawn around where the nodes actually are.
  const xs = nodes.map((n) => wfCoord(n.x));
  const ys = nodes.map((n) => wfCoord(n.y));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = (Math.max(...xs) + NODE_W) - minX;
  const h = (Math.max(...ys) + NODE_H) - minY;
  const bw = host.clientWidth - PAD * 2;
  const bh = host.clientHeight - PAD * 2;
  if (bw <= 0 || bh <= 0) return;
  const zoom = Math.min(1, bw / w, bh / h);
  // Centre what is left over, so a small flow sits in the middle rather than
  // hugging the corner.
  const x = PAD + (bw - w * zoom) / 2 - minX * zoom;
  const y = PAD + (bh - h * zoom) / 2 - minY * zoom;
  editor.zoom = zoom;
  editor.zoom_last_value = zoom;
  editor.canvas_x = x;
  editor.canvas_y = y;
  pre.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  // The fit writes the zoom directly, past zoom_refresh, so the tier that
  // depends on it is told by hand.
  wfApplyZoomTier(host, zoom);
}

// Semantic zoom. Below the threshold a step card drops its agent line and
// badge and shows one bold centred name, the same call the grid thumbnails
// made at 250px: at this size the arrangement carries the information and
// small text is noise. The tier rides on the canvas container so the run
// canvas shares it.
const WF_ZOOM_FAR = 0.72;
function wfApplyZoomTier(host, zoom) {
  if (!host) return;
  const tier = zoom < WF_ZOOM_FAR ? 'far' : 'near';
  if (host.dataset.zoomTier === tier) return;
  host.dataset.zoomTier = tier;
  // The cards change height across the tier, so every connection is redrawn
  // against its endpoints' new geometry, on the frame after the style lands.
  const editor = host.id === 'wf-run-canvas' ? wfRunEditor : wfEditor;
  if (!editor) return;
  requestAnimationFrame(() => {
    try {
      const data = editor.drawflow.drawflow.Home.data || {};
      Object.keys(data).forEach((dfId) => editor.updateConnectionNodes(`node-${dfId}`));
    } catch (_) { /* a cleared editor has no nodes to redraw */ }
  });
}

// Rewrite every step's position from the graph's own shape: columns by depth,
// parallel branches stacked, columns centred. The layout is computed in the
// main process by the same module the run engine reads graphs with; only
// x and y come back, and nothing is saved until the user saves.
async function wfAutoArrange() {
  if (!wfEditor) return;
  const graph = wfExportGraph();
  if (!graph.nodes.length) return;
  let res = null;
  try { res = await window.husk.workflows.layout(graph); } catch (_) {}
  if (!res || !res.ok || !res.graph || !res.graph.nodes.length) {
    toast('Could not arrange this graph', 'error');
    return;
  }
  const data = wfEditor.drawflow.drawflow.Home.data;
  const dfByHusk = {};
  Object.keys(data).forEach((dfId) => {
    dfByHusk[((data[dfId] || {}).data || {}).huskId] = dfId;
  });
  for (const n of res.graph.nodes) {
    const dfId = dfByHusk[n.id];
    if (dfId === undefined) continue;
    data[dfId].pos_x = n.x;
    data[dfId].pos_y = n.y;
    const el = document.querySelector(`#wf-canvas [id="node-${dfId}"]`);
    if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
    // Connections follow their endpoints only when told.
    try { wfEditor.updateConnectionNodes(`node-${dfId}`); } catch (_) {}
  }
  wfFitEditor(wfEditor, '#wf-canvas', res.graph);
  toast(`Arranged ${res.graph.nodes.length} steps`, 'success');
}

// The one line a step shows on the canvas: the tool it is running, or its last
// word. Truncated hard, because a node is not a log.
function wfSetNodeLive(nodeId, text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) return;
  wfNodeLive[nodeId] = line;
  const el = wfRunNodeEl(nodeId);
  const live = el && el.querySelector(`[data-live="${CSS.escape(nodeId)}"]`);
  if (live && wfNodeStatus[nodeId] === 'running') {
    live.textContent = line.length > 42 ? `${line.slice(0, 41)}\u2026` : line;
  }
}

const WF_STATE_LABEL = {
  pending: 'Pending', running: 'Running', done: 'Done',
  failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped',
};

function wfSetNodeState(nodeId, state) {
  wfNodeStatus[nodeId] = state;
  const el = wfRunNodeEl(nodeId);
  if (!el) return;
  ['pending', 'running', 'done', 'failed', 'cancelled', 'skipped']
    .forEach((s) => el.classList.toggle(`is-${s}`, s === state));
  const live = el.querySelector(`[data-live="${CSS.escape(nodeId)}"]`);
  if (live && state !== 'running') live.textContent = WF_STATE_LABEL[state] || state;
  if (live && state === 'running' && !wfNodeLive[nodeId]) live.textContent = 'Starting...';
  if (wfTermNodeId === nodeId) wfRenderTermStatus();
  wfRenderTermTabs();
}

// The edge that was just taken. The dash animation runs on the connection's own
// path, so the pulse follows whatever curve Drawflow drew, reroutes included.
function wfPulseEdge(from, to) {
  const a = wfRunDfId[from];
  const b = wfRunDfId[to];
  if (!a || !b) return;
  // Drawflow tags each connection with the node ids it joins, prefixed:
  // class="connection node_in_node-2 node_out_node-1 ...".
  const conn = document.querySelector(
    `#wf-run-canvas .connection.node_out_node-${a}.node_in_node-${b}`,
  );
  if (!conn) return;
  conn.classList.add('is-taken');
  conn.classList.remove('is-firing');
  void conn.getBoundingClientRect();
  conn.classList.add('is-firing');
  setTimeout(() => conn.classList.remove('is-firing'), 1200);
}

// ─── The step terminal ───────────────────────────────────────────────────────

let wfTerm = null;
let wfTermFit = null;
let wfTermNodeId = null;
let wfTermSeq = 0;             // highest entry seq written, so live appends never repeat
let wfTermOpenToken = 0;       // guards against a slow open writing into a newer one
let wfTermLoading = false;
let wfTermQueue = [];          // live entries that land while the buffer is replaying

function wfEnsureTerm() {
  if (wfTerm) return wfTerm;
  const host = $('#wf-term-body');
  if (!host || typeof Terminal === 'undefined') return null;
  wfTerm = new Terminal({
    fontSize: 12,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    convertEol: true,
    cursorStyle: 'bar',
    cursorBlink: false,
    disableStdin: true,
    scrollback: 5000,
    theme: themeForXterm(),
    minimumContrastRatio: contrastForXterm(),
    allowTransparency: true,
  });
  try {
    wfTermFit = new FitAddon.FitAddon();
    wfTerm.loadAddon(wfTermFit);
  } catch (_) { wfTermFit = null; }
  guardTermColors(wfTerm);
  wfTerm.open(host);
  try { if (wfTermFit) wfTermFit.fit(); } catch (_) {}
  window.addEventListener('resize', () => { try { if (wfTermFit && !$('#wf-term').hidden) wfTermFit.fit(); } catch (_) {} });
  return wfTerm;
}

// One activity entry, dressed the way a terminal would show it. The agent's own
// text is left alone; the scaffolding around it (tool calls, status, errors) is
// what gets colour, so the output still reads as the agent's.
function wfTermLine(entry) {
  const raw = String(entry.text || '');
  if (entry.kind === 'tool' && /localhost:\d+\/notify/.test(raw)) return '';
  const text = raw.replace(/\r?\n/g, '\r\n');
  if (entry.kind === 'tool') return `\x1b[36m  ⏵ ${text}\x1b[0m\r\n`;
  if (entry.kind === 'error') return `\x1b[31m  ✖ ${text}\x1b[0m\r\n`;
  if (entry.kind === 'status') return `\x1b[90m  · ${text}\x1b[0m\r\n`;
  return `${text}\r\n`;
}

function wfRenderTermStatus() {
  const el = $('#wf-term-status');
  if (!el || !wfTermNodeId) return;
  const st = wfNodeStatus[wfTermNodeId] || 'pending';
  const started = wfNodeStartedAt[wfTermNodeId];
  const secs = started ? Math.floor((Date.now() - started) / 1000) : null;
  const node = (wfRunGraph && (wfRunGraph.nodes || []).find((n) => n.id === wfTermNodeId)) || {};
  const cmd = (node.agentCommand || (cfg && cfg.agentCommand) || 'claude').trim().split(/\s+/)[0];
  const bits = [`<span class="wf-ts-dot is-${st}"></span>${WF_STATE_LABEL[st] || st}`, `<code>${escapeHtml(cmd)}</code>`];
  if (secs !== null && st === 'running') bits.push(`${secs}s`);
  // eslint-disable-next-line no-unsanitized/property -- all interpolations escaped
  el.innerHTML = bits.join('<span class="wf-ts-sep">&middot;</span>');
}

function wfRenderTermTabs() {
  const wrap = $('#wf-term-tabs');
  if (!wrap || !wfRunGraph) return;
  wrap.innerHTML = '';
  (wfRunGraph.nodes || []).forEach((n) => {
    const st = wfNodeStatus[n.id] || 'pending';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `wf-term-tab is-${st}` + (n.id === wfTermNodeId ? ' active' : '');
    b.textContent = n.name || 'Step';
    b.title = n.name || 'Step';
    b.addEventListener('click', () => wfOpenTerm(n.id, { manual: true }));
    wrap.appendChild(b);
    // Follow mode can move the terminal to a step whose tab has scrolled out of
    // reach, so bring the active one back into view.
    if (n.id === wfTermNodeId) {
      requestAnimationFrame(() => { try { b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {} });
    }
  });
}

// Open (or switch) the terminal onto one node. Replays that node's buffer from
// the main process first, then follows it live.
async function wfOpenTerm(nodeId, opts = {}) {
  const drawer = $('#wf-term');
  const term = wfEnsureTerm();
  if (!drawer || !term) return;
  if (opts.manual) {
    // Picking a step by hand means you want that step, not whatever runs next.
    const follow = $('#wf-term-follow');
    if (follow && follow.checked && nodeId !== wfRunCurrentNode) follow.checked = false;
  }

  // Opening is async and can be superseded mid-flight, so a token keeps the
  // newest open the one that paints.
  const token = ++wfTermOpenToken;
  wfTermNodeId = nodeId;
  wfTermLoading = true;
  wfTermQueue = [];
  drawer.hidden = false;
  document.querySelectorAll('#wf-run-canvas .wf-rn-node').forEach((el) => el.classList.remove('is-open'));
  const el = wfRunNodeEl(nodeId);
  if (el) el.classList.add('is-open');

  term.reset();
  wfTermSeq = 0;
  const runId = activeRunId || wfLastRunId;
  const res = runId ? await window.husk.workflows.nodeLog(runId, nodeId) : null;
  if (token !== wfTermOpenToken) return;   // a newer open owns the terminal now

  if (res && res.ok) {
    if (res.dropped) term.write(`\x1b[90m  · ${res.dropped} earlier lines trimmed\x1b[0m\r\n`);
    (res.entries || []).forEach((e) => {
      term.write(wfTermLine(e));
      if (e.seq && e.seq > wfTermSeq) wfTermSeq = e.seq;
    });
    if (!res.entries || !res.entries.length) {
      term.write('\x1b[90m  waiting for this step to start...\x1b[0m\r\n');
    }
  }
  // Anything the agent emitted while the buffer was in transit, in order and
  // exactly once.
  wfTermQueue.forEach((q) => {
    if (q.nodeId !== nodeId) return;
    if (q.seq && q.seq <= wfTermSeq) return;
    if (q.seq) wfTermSeq = q.seq;
    term.write(wfTermLine(q));
  });
  wfTermQueue = [];
  wfTermLoading = false;

  try { if (wfTermFit) wfTermFit.fit(); } catch (_) {}
  term.scrollToBottom();
  wfRenderTermStatus();
  wfRenderTermTabs();
  const hint = $('#wf-run-hint');
  if (hint) hint.hidden = true;
  // The canvas just lost height to the terminal. Refit after the layout settles.
  requestAnimationFrame(() => wfFitRunCanvas(wfRunGraph));
}

function wfCloseTerm() {
  const drawer = $('#wf-term');
  wfTermOpenToken += 1;   // an open still in flight must not reopen this
  wfTermLoading = false;
  wfTermQueue = [];
  if (drawer) drawer.hidden = true;
  document.querySelectorAll('#wf-run-canvas .wf-rn-node').forEach((el) => el.classList.remove('is-open'));
  wfTermNodeId = null;
  wfRenderTermTabs();
  requestAnimationFrame(() => wfFitRunCanvas(wfRunGraph));   // it got its height back
}

// ─── Run lifecycle ───────────────────────────────────────────────────────────

let wfRunCurrentNode = null;
let wfLastRunId = null;

function wfResetRunUi(workflow) {
  wfClearTimers();
  wfRunWorkflow = workflow;
  const againBtn = $('#btn-run-again');
  if (againBtn) againBtn.hidden = true;
  const nameEl = $('#wf-run-name');
  const badge = $('#wf-run-status-badge');
  const stopBtn = $('#btn-stop-wf');
  if (nameEl) nameEl.textContent = workflow.name;
  if (badge) { badge.textContent = 'Running'; badge.className = 'wf-run-status-badge'; }
  if (stopBtn) stopBtn.hidden = false;
  // Whatever the last run was bound to says nothing about this one.
  wfSetRunCwd(null);
  wfCloseTerm();
  wfShowView('run');
  const hint = $('#wf-run-hint');
  if (hint) { hint.hidden = false; hint.textContent = 'Click a step to watch its terminal'; }
  wfBuildRunCanvas(workflow);
  const total = wfAllNodes(workflow.graph).length;
  wfActiveRun = { total, done: 0 };
  wfSetProgress(0, total);
}

// The directory this run is bound to, named in the run header before the first
// step spawns. A workflow that came from a file runs where the reader picked;
// one authored here answers null and the line stays hidden.
function wfSetRunCwd(cwd) {
  const meta = document.querySelector('#wf-run-view .wf-run-meta');
  if (!meta) return;
  let row = document.getElementById('wf-run-cwd');
  if (!cwd) { if (row) row.hidden = true; return; }
  if (!row) {
    row = document.createElement('span');
    row.id = 'wf-run-cwd';
    row.className = 'wf-tag is-quiet';
    meta.appendChild(row);
  }
  row.textContent = cwd;
  row.title = `Every step of this run spawns in ${cwd}`;
  row.hidden = false;
}

async function runWorkflow(workflowId, opts) {
  const given = (opts && typeof opts === 'object') ? opts : {};
  const workflow = workflowsCache.find((w) => w.id === workflowId) || given.workflow || null;
  if (!workflow) return;
  // Only refuse if the backend actually has a live run. A stale activeRunId
  // left over from a run this window did not see finish must never wedge Run.
  if (activeRunId) {
    let live = null;
    try { const r = await window.husk.workflows.activeRun(); live = r && r.ok ? r.run : null; } catch (_) {}
    if (live) { toast('A workflow is already running', 'info'); wfShowView('run'); return; }
    activeRunId = null;
  }
  // WfxArtifactUi.runWorkflow is how this page starts a workflow. It reads the
  // install record, opens the consent gate when the record calls for one,
  // writes consentedAt after the reader agrees, and then calls workflows:run.
  // The main process applies the same rule on its own side.
  const ui = window.WfxArtifactUi;
  const sidecar = wfSidecarFor(workflowId);
  const gated = !!(ui && typeof ui.needsConsent === 'function' && ui.needsConsent(sidecar));
  // The run view waits behind the gate, so the reader is not looking at a graph
  // that reads as a run in flight while they are still deciding.
  const bound = given.cwd || (sidecar && sidecar.boundCwd) || null;
  // The binding is known from the install record before the call is made, so it
  // is on screen while the run starts. res.cwd is what the main process
  // resolved, and it overwrites this when it lands.
  if (!gated) { wfResetRunUi(workflow); wfSetRunCwd(bound); }
  const res = (ui && typeof ui.runWorkflow === 'function')
    ? await ui.runWorkflow(workflowId, { cwd: given.cwd || '', workflow })
    : await window.husk.workflows.run(workflowId, given.cwd ? { cwd: given.cwd } : {});
  // A cancelled gate is an answer, not a failure. It has no error text worth
  // showing, and the reader is already looking at the list they pressed Run on.
  if (res && res.cancelled) {
    if (!gated) { wfShowView('list'); paintWorkflowList(); }
    return;
  }
  if (!res || !res.ok) {
    toast((res && res.error) || 'Could not start workflow', 'error');
    // The main process may be running something this window lost track of, so
    // adopt it rather than dropping the user on a list that says nothing.
    const adopted = await wfReattachRun();
    if (!adopted) { wfShowView('list'); paintWorkflowList(); }
    return;
  }
  if (gated) {
    wfResetRunUi(workflow);
    // consentedAt has just been written, so the cached row would otherwise ask
    // the same question again on the next press.
    wfRefreshSidecars();
  }
  wfSetRunCwd((typeof res.cwd === 'string' && res.cwd) ? res.cwd : bound);
  activeRunId = res.runId;
  wfLastRunId = res.runId;
}

// The last run, put back on the graph exactly as it ended. The step terminals
// read from the stored scrollback, so this survives a restart.
async function wfOpenRun(workflowId, run) {
  const workflow = workflowsCache.find((w) => w.id === workflowId);
  if (!workflow || !run) return;
  if (activeRunId) { toast('A workflow is running; watch it instead', 'info'); wfShowView('run'); return; }
  wfClearTimers();
  wfRunWorkflow = workflow;
  activeRunId = null;
  wfLastRunId = run.id;
  wfRunCurrentNode = null;

  const nameEl = $('#wf-run-name');
  const stopBtn = $('#btn-stop-wf');
  const againBtn = $('#btn-run-again');
  if (nameEl) nameEl.textContent = workflow.name;
  if (stopBtn) stopBtn.hidden = true;
  if (againBtn) { againBtn.hidden = false; againBtn.dataset.id = workflowId; }
  // Run history does not record where a run happened, so a replay says
  // nothing about the directory rather than repeating today's binding as if
  // it were the one that run used.
  wfSetRunCwd(null);
  wfCloseTerm();
  wfShowView('run');
  wfBuildRunCanvas(workflow);

  const known = new Set(((workflow.graph && workflow.graph.nodes) || []).map((n) => n.id));
  const matched = (run.steps || []).filter((st) => known.has(st.nodeId));
  matched.forEach((st) => {
    wfNodeStatus[st.nodeId] = st.status;
    wfSetNodeState(st.nodeId, st.status);
  });
  (run.edgesTaken || []).forEach((e) => wfPulseEdge(e.from, e.to));
  if ((run.steps || []).length && !matched.length) {
    toast('This run was recorded before the flow was changed, so its steps no longer line up', 'info');
  }
  (run.steps || []).forEach((st) => {
    const el = wfRunNodeEl(st.nodeId);
    const t = el && el.querySelector(`[data-timer="${CSS.escape(st.nodeId)}"]`);
    if (t && st.ms) t.textContent = wfDur(st.ms);
  });

  const total = wfAllNodes(workflow.graph).length;
  const done = (run.steps || []).filter((st) => st.status !== 'pending' && st.status !== 'skipped').length;
  wfActiveRun = { total, done };
  wfSetProgress(done, total, 100);

  const badge = $('#wf-run-status-badge');
  if (badge) {
    const cls = run.status === 'done' ? 'is-done' : run.status === 'stopped' ? 'is-stopped' : 'is-failed';
    const lbl = run.status === 'done' ? 'Completed' : run.status === 'stopped' ? 'Stopped' : 'Failed';
    badge.textContent = `${lbl} \u00b7 ${wfRelTime(run.finishedAt)}`;
    badge.className = `wf-run-status-badge ${cls}`;
  }
  const hint = $('#wf-run-hint');
  if (hint) { hint.hidden = false; hint.textContent = 'Last run. Click a step to read its terminal.'; }
}

// A run keeps executing in the main process across a renderer reload, so on
// boot we adopt whatever is still in flight instead of leaving it unwatched.
async function wfReattachRun() {
  let res = null;
  try { res = await window.husk.workflows.activeRun(); } catch (_) { return false; }
  if (!res || !res.ok || !res.run) return false;
  const run = res.run;
  const workflow = workflowsCache.find((w) => w.id === run.workflowId);
  if (!workflow) return false;
  wfResetRunUi(workflow);
  activeRunId = run.id;
  wfLastRunId = run.id;
  (run.startedNodes || []).forEach((s) => { wfNodeStartedAt[s.nodeId] = s.at; });
  Object.entries(run.stepStates || {}).forEach(([id, s]) => wfSetNodeState(id, s.status));
  (run.edgesTaken || []).forEach((e) => wfPulseEdge(e.from, e.to));
  const done = Object.values(run.stepStates || {}).filter((s) => s.status !== 'running' && s.status !== 'pending').length;
  wfActiveRun.done = done;
  wfSetProgress(done, wfActiveRun.total);
  if (run.currentNodeId) {
    wfRunCurrentNode = run.currentNodeId;
    wfStartNodeTimer(run.currentNodeId, wfNodeStartedAt[run.currentNodeId] || Date.now());
  }
  toast('Rejoined a workflow already running', 'info');
  return true;
}

function wfStartNodeTimer(nodeId, startedAt) {
  wfNodeStartedAt[nodeId] = startedAt;
  const el = wfRunNodeEl(nodeId);
  const timerEl = el && el.querySelector(`[data-timer="${CSS.escape(nodeId)}"]`);
  const tick = () => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    if (timerEl) timerEl.textContent = `${s}s`;
    if (wfTermNodeId === nodeId) wfRenderTermStatus();
  };
  tick();
  wfStepTimers[nodeId] = { interval: setInterval(tick, 1000), startedAt };
}

// ─── Run events ──────────────────────────────────────────────────────────────

let wfAdopting = false;
async function wfAdoptIfStray(runId) {
  if (activeRunId || wfAdopting) return;
  wfAdopting = true;
  try { await wfReattachRun(); } finally { wfAdopting = false; }
}

window.husk.workflows.onNodeStart((d) => {
  // A run we are not watching is still a run: pick it up rather than showing a
  // graph that never moves until the user reloads.
  if (!activeRunId) { wfAdoptIfStray(d.runId); return; }
  if (d.runId !== activeRunId) return;
  wfRunCurrentNode = d.nodeId;
  wfSetNodeState(d.nodeId, 'running');
  wfStartNodeTimer(d.nodeId, Date.now());
  const el = wfRunNodeEl(d.nodeId);
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  // Follow mode: the terminal rides along with the run.
  const follow = $('#wf-term-follow');
  if (!$('#wf-term').hidden && follow && follow.checked) wfOpenTerm(d.nodeId);
});

window.husk.workflows.onNodeActivity((d) => {
  if (d.runId !== activeRunId) return;
  wfSetNodeLive(d.nodeId, d.text);
  if (d.nodeId !== wfTermNodeId || !wfTerm || $('#wf-term').hidden) return;
  // While the buffer is still being replayed, hold the line rather than racing
  // it into the terminal out of order.
  if (wfTermLoading) { wfTermQueue.push({ nodeId: d.nodeId, kind: d.kind, text: d.text, seq: d.seq }); return; }
  if (d.seq && d.seq <= wfTermSeq) return;
  if (d.seq) wfTermSeq = d.seq;
  wfTerm.write(wfTermLine({ kind: d.kind, text: d.text }));
});

window.husk.workflows.onNodeDone((d) => {
  if (d.runId !== activeRunId) return;
  wfSetNodeState(d.nodeId, d.status || 'done');
  const t = wfStepTimers[d.nodeId];
  if (t) {
    clearInterval(t.interval);
    const el = wfRunNodeEl(d.nodeId);
    const timerEl = el && el.querySelector(`[data-timer="${CSS.escape(d.nodeId)}"]`);
    if (timerEl) timerEl.textContent = `${Math.floor((Date.now() - t.startedAt) / 1000)}s`;
    delete wfStepTimers[d.nodeId];
  }
  if (wfRunCurrentNode === d.nodeId) wfRunCurrentNode = null;
  wfActiveRun.done += 1;
  wfSetProgress(wfActiveRun.done, wfActiveRun.total);
});

window.husk.workflows.onEdgeTaken((d) => {
  if (d.runId !== activeRunId) return;
  wfPulseEdge(d.from, d.to);
});

window.husk.workflows.onRunDone((d) => {
  if (d.runId !== activeRunId) return;
  activeRunId = null;
  wfRunCurrentNode = null;
  wfClearTimers();
  // Anything the taken path never reached was skipped by a branch.
  Object.keys(wfRunDfId).forEach((id) => {
    if ((wfNodeStatus[id] || 'pending') === 'pending') wfSetNodeState(id, 'skipped');
  });
  wfSetProgress(wfActiveRun.done, wfActiveRun.total, 100);
  const badge = $('#wf-run-status-badge');
  const stopBtn = $('#btn-stop-wf');
  if (stopBtn) stopBtn.hidden = true;
  if (badge) {
    const cls = d.status === 'done' ? 'is-done' : d.status === 'stopped' ? 'is-stopped' : 'is-failed';
    const lbl = d.status === 'done' ? 'Completed' : d.status === 'stopped' ? 'Stopped' : 'Failed';
    badge.textContent = lbl;
    badge.className = `wf-run-status-badge ${cls}`;
  }
  if (wfTermNodeId) wfRenderTermStatus();
  // The run just became history, so pull it in and refresh the receipts
  // aggregate with it; the card behind this view is correct on the way back.
  Promise.all([
    window.husk.workflows.runs().then((res) => {
      wfRunsCache = (res && res.ok && res.runs) || wfRunsCache;
    }),
    wfRefreshReceipts(),
  ]).then(() => {
    if (!$('#wf-list-view').hidden) paintWorkflowList();
  }).catch(() => {});
});

// ─── Terminal controls ───────────────────────────────────────────────────────

$('#wf-term-close') && $('#wf-term-close').addEventListener('click', wfCloseTerm);

$('#wf-term-copy') && $('#wf-term-copy').addEventListener('click', async () => {
  if (!wfTermNodeId) return;
  const res = await window.husk.workflows.nodeLog(activeRunId || wfLastRunId, wfTermNodeId);
  if (!res || !res.ok) return;
  const text = (res.entries || []).map((e) => e.text).join('\n');
  try { await navigator.clipboard.writeText(text); toast('Step output copied', 'success'); } catch (_) {}
});

// The step's result, dropped into a real chat so the work can be carried on by
// hand. Written without a newline: it is a starting point, not a submission.
$('#wf-term-tochat') && $('#wf-term-tochat').addEventListener('click', async () => {
  if (!wfTermNodeId) return;
  const res = await window.husk.workflows.nodeLog(activeRunId || wfLastRunId, wfTermNodeId);
  const body = (res && res.ok && (res.output || (res.entries || []).map((e) => e.text).join('\n'))) || '';
  if (!body.trim()) { toast('This step has no output yet', 'info'); return; }
  const node = (wfRunGraph.nodes || []).find((n) => n.id === wfTermNodeId) || {};
  setPage('chat');
  $('#chat-empty').classList.remove('show');
  const tab = await openNewChatTab({ skipWelcome: true });
  const primer = `Here is the output of the workflow step "${node.name || 'Step'}":\n\n${body}`;
  // Bracketed paste: the agent's TUI reads a bare newline as "send", so the
  // text is wrapped and lands in the prompt as one editable block. Control
  // characters other than tab and newline are stripped first, which keeps the
  // block readable and inside its wrapper.
  const pasteSafe = (s) => window.husk.text.stripControls(s);
  const paste = `\x1b[200~${pasteSafe(primer)}\x1b[201~`;
  const deliver = (attempt = 0) => {
    try { window.husk.pty.write(paste, tab.id); } catch (_) {
      if (attempt < 3) { setTimeout(() => deliver(attempt + 1), 600); return; }
    }
    toast('Step output pasted into a new chat', 'success');
  };
  // The agent needs a moment to draw its prompt before it can accept a paste.
  setTimeout(() => deliver(), 1200);
});


// Button wiring
$('#btn-new-workflow') && $('#btn-new-workflow').addEventListener('click', () => openWorkflowBuilder(null));

// ─── Portable workflows: the install sheet, the record, the publish sheet ────
//
// Three dialogs ship as modules of their own, each owning one surface. What
// they need from this page is handed over here: how to navigate, what the
// billing mode is, when the grid repaints, and the function that starts a
// workflow. They are given hooks and they call back.

// The control that opens the install sheet is minted here, beside New Workflow,
// and built node by node.
function wfxMountInstallControl() {
  const head = document.querySelector('.page-workflows .page-head-right');
  if (!head || document.getElementById('btn-wfx-install')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost-btn';
  btn.id = 'btn-wfx-install';
  btn.title = 'Read a workflow file before it runs anything';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'btn-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 3v12M7 10l5 5 5-5M5 19h14');
  svg.appendChild(path);
  btn.append(svg, document.createTextNode(' Install workflow'));
  // Before New Workflow, so authoring keeps the last slot as the primary
  // action on this page.
  head.insertBefore(btn, document.getElementById('btn-new-workflow'));
  btn.addEventListener('click', wfxOpenInstallSheet);
}
wfxMountInstallControl();

// The install sheet and the receipts record share one dialog, so each sets the
// title on the way in rather than restoring it on the way out.
function wfxOpenInstallSheet() {
  if (!window.WfxInstall || typeof window.WfxInstall.open !== 'function') {
    toast('The install sheet did not load in this window', 'error');
    return;
  }
  const title = $('#wfx-in-title');
  if (title) title.textContent = 'Install a workflow';
  window.WfxInstall.open();
}

// The receipts chip on a card opens the record those figures came from: the
// same inspector the install sheet shows, over the artifact this workflow was
// installed from, with nothing to commit. The two shell controls the inspector
// re-parents belong to the install flow and are taken back out here.
let wfxRecordSeq = 0;

async function wfOpenReceiptRecord(workflowId) {
  const ui = window.WfxArtifactUi;
  const sidecar = wfSidecarFor(workflowId);
  const artifact = sidecar && sidecar.artifact;
  const workflow = workflowsCache.find((x) => x.id === workflowId) || null;
  if (!ui || typeof ui.renderInspector !== 'function' || !artifact) {
    toast('This workflow has no imported record to open', 'info');
    return;
  }
  // An install in progress owns this dialog. Repainting its ready pane from
  // here would discard a staged file the reader is halfway through checking.
  if (window.WfxInstall && typeof window.WfxInstall.isOpen === 'function' && window.WfxInstall.isOpen()) {
    toast('Finish or cancel the install first', 'info');
    return;
  }
  const modal = $('#wfx-install-modal');
  const card = modal && modal.querySelector('.modal-card.wfx-sheet');
  const host = $('#wfx-in-ready');
  if (!modal || !card || !host) return;

  const seq = (wfxRecordSeq += 1);
  const paint = (preflight) => {
    const res = ui.renderInspector({
      host,
      artifact,
      preflight,
      cwd: sidecar.boundCwd || null,
      billing: autBilling,
      // The same local history the card's strip is drawn from, so the panel and
      // the chip say one thing.
      aggregate: wfAggregateFor(workflowId),
      // The same finding the card's chip is drawn from, so both report the
      // tier the same way.
      chainCheck: (sidecar && sidecar.chainCheck) || null,
      // The same drawing the install sheet showed for this file, which is the
      // comparison this view exists for. The run is null, so no status colours
      // the pane.
      miniGraph: wfMiniGraph(artifact.graph, null, 'panel'),
      onFix: null,
    });
    // One of these copies the fingerprint of the file being staged, the other
    // rebinds the directory it would be installed into. Neither means anything
    // over a workflow that is already installed.
    host.querySelectorAll('#wfx-in-fp-copy, #wfx-in-cwd-change').forEach((node) => node.remove());
    return !!(res && res.ok);
  };

  const title = $('#wfx-in-title');
  if (title) title.textContent = workflow ? `Receipts · ${workflow.name}` : 'Receipts';
  card.setAttribute('data-state', 'ready');
  const painted = paint(null);
  const foot = $('#wfx-in-foot');
  if (foot) {
    foot.classList.toggle('is-error', !painted);
    foot.textContent = painted
      ? 'This is the file this workflow was installed from. Nothing here installs or runs anything.'
      : 'Husk could not read this record. Nothing about the installed workflow has changed.';
  }
  modal.hidden = false;
  const closeBtn = $('#wfx-in-x');
  if (closeBtn) { try { closeBtn.focus(); } catch (_) { /* focus is a courtesy, not a contract */ } }
  if (!painted) return;
  ui.say('wfx-in-say', 'The record this workflow was installed from, with nothing to install.');

  // Preflight describes this machine today, so it is asked again and painted in
  // when it lands. The sequence token drops an answer that arrives after the
  // reader has moved on.
  let pf = null;
  try { pf = await window.husk.workflows.preflight({ workflowId }); } catch (_) { pf = null; }
  if (seq !== wfxRecordSeq || modal.hidden) return;
  if (pf && pf.ok) paint(pf);
}

// What the install sheet needs from this page. Every hook is a navigation or a
// repaint, none of them carries a value out of the manifest, and openMcpForm
// takes no argument.
if (window.WfxInstall && typeof window.WfxInstall.configure === 'function') {
  window.WfxInstall.configure({
    onInstalled: () => { renderWorkflows(); },
    // The sheet's own Run it hands the workflow back here rather than starting
    // it, so a run that begins in a dialog still lands in the run view with
    // its progress, its canvas and its per-step terminals.
    openConsent: (id, workflow, cwd) => { setPage('workflows'); runWorkflow(id, { cwd, workflow }); },
    openMcpForm: () => { setPage('mcp'); openMcpCustomModal(); },
    openSkills: () => setPage('skills'),
    openAgents: () => setPage('agents'),
    getBilling: () => autBilling,
  });
}
$('#btn-wf-builder-back') && $('#btn-wf-builder-back').addEventListener('click', () => { wfShowView('list'); paintWorkflowList(); });
$('#btn-save-workflow') && $('#btn-save-workflow').addEventListener('click', saveWorkflow);
$('#btn-run-from-builder') && $('#btn-run-from-builder').addEventListener('click', async () => {
  const id = await saveWorkflow({ silent: true, stay: true });
  if (!id) return;
  workflowsCache = await window.husk.workflows.list();
  runWorkflow(id);
});
$('#wf-name-input') && $('#wf-name-input').addEventListener('input', wfSyncNameCount);
$('#btn-add-wf-node') && $('#btn-add-wf-node').addEventListener('click', () => wfAddCanvasNode(null));
$('#btn-wf-arrange') && $('#btn-wf-arrange').addEventListener('click', () => { wfAutoArrange(); });

// The legend is open the first time and whenever it was left open. Once the
// moves are learned it collapses to a pill and stays that way.
const WF_LEGEND_KEY = 'husk.wfLegendCollapsed';
function wfSetLegend(collapsed, persist) {
  const el = $('#wf-legend');
  const btn = $('#wf-legend-toggle');
  const label = $('#wf-legend-toggle-label');
  if (!el) return;
  el.classList.toggle('is-collapsed', collapsed);
  if (btn) btn.setAttribute('aria-expanded', String(!collapsed));
  if (label) label.textContent = collapsed ? 'How this works' : 'Hide guide';
  if (persist) { try { localStorage.setItem(WF_LEGEND_KEY, collapsed ? '1' : '0'); } catch (_) {} }
}
function wfRestoreLegend() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(WF_LEGEND_KEY) === '1'; } catch (_) {}
  wfSetLegend(collapsed, false);
}
$('#wf-legend-toggle') && $('#wf-legend-toggle').addEventListener('click', () => {
  const el = $('#wf-legend');
  wfSetLegend(!(el && el.classList.contains('is-collapsed')), true);
});
$('#btn-wf-run-back') && $('#btn-wf-run-back').addEventListener('click', () => {
  wfShowView('list');
  paintWorkflowList();
  // Leaving the run does not end it, so say so on the list.
  wfPaintLiveBand(activeRunId ? { workflowId: (wfRunWorkflow || {}).id, stepStates: wfNodeStatusAsStates() } : null);
});
$('#wf-band-watch') && $('#wf-band-watch').addEventListener('click', () => { wfShowView('run'); });
$('#btn-run-again') && $('#btn-run-again').addEventListener('click', (e) => {
  const id = e.currentTarget.dataset.id;
  if (id) runWorkflow(id);
});

// The canvas holds node state as a flat map; the band wants the run's shape.
function wfNodeStatusAsStates() {
  const out = {};
  Object.entries(wfNodeStatus).forEach(([id, status]) => { out[id] = { status }; });
  return out;
}
// Node config panel
['wf-np-name', 'wf-np-agent', 'wf-np-context', 'wf-np-prompt', 'wf-np-model', 'wf-np-model-custom', 'wf-np-branch'].forEach((id) => {
  const el = $(`#${id}`);
  if (el) { el.addEventListener('input', wfSyncPanelToNode); el.addEventListener('change', wfSyncPanelToNode); }
});
// Switching a step's agent loads that agent's models. Reset the pin, since a
// claude model id means nothing to gemini.
$('#wf-np-agent') && $('#wf-np-agent').addEventListener('change', () => {
  wfLoadNodeModels(wfAgentCommandForPanel(), '');
});
// The model select toggles a free-text field for anything not in the catalog.
$('#wf-np-model') && $('#wf-np-model').addEventListener('change', (e) => {
  const custom = $('#wf-np-model-custom');
  if (custom) {
    custom.hidden = e.target.value !== '__custom__';
    if (!custom.hidden) custom.focus();
  }
});
$('#wf-np-model-refresh') && $('#wf-np-model-refresh').addEventListener('click', () => {
  const node = wfEditor && wfSelectedNodeId != null ? wfEditor.getNodeFromId(wfSelectedNodeId) : null;
  const pinned = (node && node.data && node.data.model) || '';
  wfLoadNodeModels(wfAgentCommandForPanel(), pinned, { refresh: true });
});
$('#wf-node-panel-close') && $('#wf-node-panel-close').addEventListener('click', hideNodePanel);
$('#wf-node-panel-done') && $('#wf-node-panel-done').addEventListener('click', hideNodePanel);
// Escape: dismiss a pending AI suggestion first, otherwise close the modal.
// No backdrop-close: a stray click must not discard a half-written prompt.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const rev = $('#wf-gen-review');
  if (rev && !rev.hidden) { $('#wf-gen-discard') && $('#wf-gen-discard').click(); return; }
  if (!$('#wf-node-panel').hidden) hideNodePanel();
});

// ── Node config: drawflow release, mini-IDE gutter, AI generate with review ──
const WF_PROMPT_MIN = 12;
// Clears Drawflow's drag flags and selection when the modal closes, so the node
// stops following the cursor and is not left highlighted.
function wfDeselectNode() {
  if (!wfEditor) return;
  try { const el = wfEditor.node_selected; if (el && el.classList) el.classList.remove('selected'); wfEditor.node_selected = null; } catch (_) {}
  document.querySelectorAll('#wf-canvas .drawflow-node.selected').forEach((n) => n.classList.remove('selected'));
}
// ─── Prompt editor ──────────────────────────────────────────────────────────
// A prompt is prose, so it wraps. The mirror measures each logical line at the
// editor's real text width, and the gutter gives that line a block of exactly
// that height.

function wfUpdateGutter() {
  const ta = $('#wf-np-prompt');
  const gut = $('#wf-np-gutter');
  if (!ta || !gut) return;
  const lines = ta.value.split('\n');
  const mirror = $('#wf-ide-mirror');
  let heights = null;
  if (mirror && ta.clientWidth) {
    const cs = getComputedStyle(ta);
    const inner = ta.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    if (inner > 0) {
      mirror.style.width = `${inner}px`;
      // A blank line still occupies one row; a zero-width space gives the
      // mirror something to lay out so the height is not collapsed to nothing.
      mirror.replaceChildren(...lines.map((line) => {
        const d = document.createElement('div');
        d.textContent = line === '' ? '​' : line;
        return d;
      }));
      heights = [...mirror.children].map((c) => c.offsetHeight);
    }
  }
  gut.replaceChildren(...lines.map((_, i) => {
    const d = document.createElement('div');
    if (heights && heights[i]) d.style.height = `${heights[i]}px`;
    d.textContent = String(i + 1);
    return d;
  }));
  gut.scrollTop = ta.scrollTop;
  wfUpdateMeasure();
}

// Length in the units that matter downstream. The token figure is the usual
// four-characters-per-token approximation, marked as approximate because it is.
function wfUpdateMeasure() {
  const ta = $('#wf-np-prompt');
  const out = $('#wf-np-measure');
  if (!ta || !out) return;
  const value = ta.value;
  const words = (value.trim().match(/\S+/g) || []).length;
  out.textContent = words
    ? `${words} word${words === 1 ? '' : 's'} · ~${Math.max(1, Math.ceil(value.length / 4))} tokens`
    : '';
}

// The panel is the writing surface, so its width is the writer's to set. Drag
// the left edge for anything, or hit Widen to jump between the compact form
// width and a comfortable measure. The choice sticks across sessions.
const WF_DRAWER_MIN = 440;
const WF_DRAWER_NARROW = 560;
const WF_DRAWER_WIDTH_KEY = 'husk.wfNodeDrawerWidth';

function wfDrawerPanel() { return document.querySelector('#wf-node-panel .wf-drawer-panel'); }
function wfDrawerMax() { return Math.max(WF_DRAWER_MIN, window.innerWidth - 140); }
function wfDrawerWide() { return Math.min(940, wfDrawerMax()); }

function wfSetDrawerWidth(px, persist) {
  const panel = wfDrawerPanel();
  if (!panel) return;
  const w = Math.round(Math.min(wfDrawerMax(), Math.max(WF_DRAWER_MIN, px)));
  panel.style.width = `${w}px`;
  if (persist) { try { localStorage.setItem(WF_DRAWER_WIDTH_KEY, String(w)); } catch (_) {} }
  const btn = $('#wf-np-widen');
  if (btn) {
    const wide = w >= wfDrawerWide() - 4;
    btn.classList.toggle('is-wide', wide);
    btn.title = wide ? 'Back to the compact panel' : 'Give the prompt more room';
    const label = $('#wf-np-widen-label');
    if (label) label.textContent = wide ? 'Narrow' : 'Widen';
  }
}

function wfRestoreDrawerWidth() {
  let w = WF_DRAWER_NARROW;
  try {
    const saved = parseInt(localStorage.getItem(WF_DRAWER_WIDTH_KEY) || '', 10);
    if (Number.isFinite(saved)) w = saved;
  } catch (_) {}
  wfSetDrawerWidth(w, false);
}
function wfClearGenState() {
  const ide = $('#wf-ide'); if (ide) ide.classList.remove('field-invalid');
  const st = $('#wf-np-gen-status'); if (st) { st.hidden = true; st.textContent = ''; st.classList.remove('is-error'); }
  const rev = $('#wf-gen-review'); if (rev) rev.hidden = true;
  wfPendingSuggestion = '';
}
function wfGenError(msg) {
  const ide = $('#wf-ide'); if (ide) ide.classList.add('field-invalid');
  const st = $('#wf-np-gen-status'); if (st) { st.hidden = false; st.textContent = msg; st.classList.add('is-error'); }
  toast(msg, 'error');
  const ta = $('#wf-np-prompt'); if (ta) ta.focus();
}
let wfPendingSuggestion = '';
function wfShowGenReview(text) {
  wfPendingSuggestion = text;
  const body = $('#wf-gen-review-text'); if (body) body.textContent = text;
  const rev = $('#wf-gen-review'); if (rev) rev.hidden = false;
}
{
  const ta = $('#wf-np-prompt');
  if (ta) {
    ta.addEventListener('input', () => {
      wfUpdateGutter();
      const ide = $('#wf-ide'); if (ide) ide.classList.remove('field-invalid');
      const st = $('#wf-np-gen-status'); if (st && st.classList.contains('is-error')) { st.hidden = true; st.classList.remove('is-error'); }
    });
    ta.addEventListener('scroll', () => { const g = $('#wf-np-gutter'); if (g) g.scrollTop = ta.scrollTop; });
    // One source of truth for "the text column changed width": dragging the
    // panel, hitting Widen, and resizing the window all land here.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => wfUpdateGutter()).observe(ta);
    }
  }
}

// Drag the panel's left edge. Pointer capture keeps the drag alive over the
// canvas and past the window edge, which a plain mousemove listener loses.
{
  const grip = $('#wf-drawer-grip');
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      const panel = wfDrawerPanel();
      const drawer = $('#wf-node-panel');
      if (!panel) return;
      e.preventDefault();
      const right = panel.getBoundingClientRect().right;
      panel.classList.add('is-dragging');
      if (drawer) drawer.classList.add('is-dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => wfSetDrawerWidth(right - ev.clientX, false);
      const end = (ev) => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
        panel.classList.remove('is-dragging');
        if (drawer) drawer.classList.remove('is-dragging');
        wfSetDrawerWidth(right - ev.clientX, true);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    });
  }
}

$('#wf-np-widen') && $('#wf-np-widen').addEventListener('click', () => {
  const panel = wfDrawerPanel();
  const current = panel ? panel.getBoundingClientRect().width : WF_DRAWER_NARROW;
  wfSetDrawerWidth(current >= wfDrawerWide() - 4 ? WF_DRAWER_NARROW : wfDrawerWide(), true);
  const ta = $('#wf-np-prompt'); if (ta) ta.focus();
});
$('#wf-np-generate') && $('#wf-np-generate').addEventListener('click', async () => {
  const btn = $('#wf-np-generate');
  const promptEl = $('#wf-np-prompt');
  const statusEl = $('#wf-np-gen-status');
  if (!promptEl) return;
  const seed = (promptEl.value || '').trim();
  // Refuse to generate from nothing: the AI improves what you have, it cannot
  // invent the step's goal. Mark the field and say exactly what's needed.
  if (seed.length < WF_PROMPT_MIN) {
    wfGenError(`Write at least ${WF_PROMPT_MIN} characters describing this step first. The AI improves your draft, it can't invent the goal.`);
    return;
  }
  wfClearGenState();
  btn.disabled = true;
  if (statusEl) { statusEl.hidden = false; statusEl.classList.remove('is-error'); statusEl.textContent = 'Generating…'; }
  try {
    const res = await window.husk.workflows.generateStepPrompt(seed);
    if (res && res.ok && res.prompt) {
      if (statusEl) statusEl.hidden = true;
      wfShowGenReview(res.prompt);
    } else {
      wfGenError((res && res.error) || 'Generation failed. Check that the agent CLI is installed and authenticated.');
    }
  } catch (_) {
    wfGenError('Generation failed. Check that the agent CLI is installed and authenticated.');
  } finally {
    btn.disabled = false;
  }
});
$('#wf-gen-discard') && $('#wf-gen-discard').addEventListener('click', () => {
  wfPendingSuggestion = '';
  const rev = $('#wf-gen-review'); if (rev) rev.hidden = true;
  const ta = $('#wf-np-prompt'); if (ta) ta.focus();
});
$('#wf-gen-use') && $('#wf-gen-use').addEventListener('click', () => {
  const ta = $('#wf-np-prompt');
  if (ta && wfPendingSuggestion) {
    ta.value = wfPendingSuggestion;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    wfUpdateGutter();
  }
  wfPendingSuggestion = '';
  const rev = $('#wf-gen-review'); if (rev) rev.hidden = true;
});
$('#wf-edge-panel-close') && $('#wf-edge-panel-close').addEventListener('click', hideEdgePanel);
$('#wf-ec-type') && $('#wf-ec-type').addEventListener('change', wfSyncEdgePanel);
$('#wf-ec-value') && $('#wf-ec-value').addEventListener('input', wfSyncEdgePanel);
$('#wf-np-delete') && $('#wf-np-delete').addEventListener('click', () => {
  if (wfEditor && wfSelectedNodeId != null) {
    wfEditor.removeNodeId('node-' + wfSelectedNodeId);
    hideNodePanel();
  }
});

// Delete the selected connection. Drawflow binds its key handler to the canvas
// container, which never receives keys, so the shortcut lives on the document
// and runs only in the builder, with the config drawer closed and no text field
// focused. Steps are removed from their drawer instead.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (!wfEditor) return;
  const builder = $('#wf-builder-view');
  if (!builder || builder.hidden) return;
  const drawer = $('#wf-node-panel');
  if (drawer && !drawer.hidden) return;
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;

  // connection_selected is the <path>; its parent <svg> carries the endpoints.
  const path = wfEditor.connection_selected;
  if (path && path.parentElement) {
    e.preventDefault();
    if (wfRemoveConnectionEl(path.parentElement)) toast('Connection removed', 'success');
  }
});
$('#btn-stop-wf') && $('#btn-stop-wf').addEventListener('click', async () => {
  if (activeRunId) await window.husk.workflows.stop(activeRunId);
});

// ─── Agents page ───────────────────────────────────────────────────────────────

let profilesCache = [];
let editingProfileId = null;
// Origin is a property of an agent, so it groups the list and it filters it.
// Pinned is a view of the same list, so it only filters.
let agOrigin = 'all';        // all | custom | builtin | repo
let agState = 'all';         // all | pinned
let agQuery = '';
let agCursor = null;         // id of the row under the caret
let agLoad = 'ready';        // ready | loading | error
let agError = '';
let agGenSeq = 0;            // draft-cancel token
const AG_MOD = isMac ? '⌘' : 'Ctrl';
const AG_BANDS = [['custom', 'custom'], ['builtin', 'built-in'], ['repo', 'from repo']];
// Below this a band per group is more chrome than content.
const AG_BAND_MIN = 6;
const AG_FACET_LABEL = {
  all: 'All', custom: 'Custom', builtin: 'Built-in', repo: 'From repo',
  pinned: 'Pinned',
};
// Shared stroke attributes for the row glyphs.
const AG_STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const AG_EDIT_SVG = `<svg viewBox="0 0 24 24" ${AG_STROKE}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;
const AG_VIEW_SVG = `<svg viewBox="0 0 24 24" ${AG_STROKE}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const AG_TRASH_SVG = `<svg viewBox="0 0 24 24" ${AG_STROKE}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
const AG_PIN_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.3V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.7a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;

// The single mount test. It reads the DOM rather than a page variable, so it
// stays true no matter which route put the page on screen.
function agentsPageOpen() {
  const el = document.querySelector('.page-agents');
  return !!el && !el.hidden;
}

async function renderAgents() {
  if (!$('#ag-list')) return;
  // The placeholder waits out a fast local read and only stands in for a cold
  // list; a refresh keeps the rows it has.
  const cold = !profilesCache.length;
  agLoad = 'loading'; agError = '';
  const refreshBtn = $('#btn-agents-refresh');
  let skelTimer = 0;
  if (cold) skelTimer = setTimeout(() => { if (agLoad === 'loading') paintAgents(); }, 250);
  else if (refreshBtn) refreshBtn.disabled = true;
  try {
    // The pinned set lives in config and anything can have moved it since the
    // last visit, so the page reads both halves of its own truth.
    const [list, next] = await Promise.all([window.husk.profiles.list(), window.husk.config.get()]);
    profilesCache = Array.isArray(list) ? list : [];
    if (next) cfg = next;
    agLoad = 'ready';
  } catch (err) {
    agError = String((err && err.message) || err);
    agLoad = 'error';
  }
  clearTimeout(skelTimer);
  if (refreshBtn) refreshBtn.disabled = false;
  paintAgents();
  updateActiveChatProfile();
}

function getActiveProfileIds() {
  if (Array.isArray(cfg && cfg.activeProfileIds)) return cfg.activeProfileIds;
  return cfg && cfg.activeProfileId ? [cfg.activeProfileId] : [];
}

// ── Derivation ──────────────────────────────────────────────────────────────

function agOriginOf(p) { return p.builtin ? 'builtin' : (p.repoRoot ? 'repo' : 'custom'); }

// The sentence that decides anything. When an agent carries no description the
// first line of its prompt says more than an empty cell does.
function agDesc(p) {
  const d = String(p.description || '').trim();
  if (d) return d;
  const first = String(p.systemPrompt || '').split('\n').map((s) => s.trim()).find(Boolean);
  return first ? first.slice(0, 180) : '';
}

// Behaviour tags only. Origin is already carried by the band, the facet chip
// and the detail pane's property cell.
function agTags(p) {
  const t = [];
  if (p.autoSelect) t.push('auto');
  if (!String(p.systemPrompt || '').trim()) t.push('no prompt');
  return t.slice(0, 2);
}

function agShortPath(v) {
  return String(v || '').replace(/^([A-Za-z]:)?[\\/](?:home|Users)[\\/][^\\/]+/, '~');
}

function agMatch(p, ids, q, origin, state) {
  if (origin !== 'all' && agOriginOf(p) !== origin) return false;
  if (state === 'pinned' && !ids.has(p.id)) return false;
  if (!q) return true;
  return (`${p.name} ${p.description || ''} ${p.systemPrompt || ''}`).toLowerCase().includes(q);
}

// Alphabetical, always. Sorting pinned rows to the top would move a row out
// from under the pointer that just pinned it.
function agRows(origin = agOrigin, state = agState) {
  const ids = new Set(getActiveProfileIds());
  const q = agQuery.toLowerCase().trim();
  return profilesCache
    .filter((p) => agMatch(p, ids, q, origin, state))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function agFiltered() { return agOrigin !== 'all' || agState !== 'all' || !!agQuery.trim(); }

// Name column width, sized off the longest name in the whole roster so the
// column holds still while the list filters, and capped so one long name
// cannot push every description to the right.
let agMeasureCtx = null;
function agNameWidth(rows) {
  const AG_NAME_FONT = '500 13px Inter, sans-serif';
  if (!agMeasureCtx) {
    const c = document.createElement('canvas');
    agMeasureCtx = c.getContext && c.getContext('2d');
  }
  let widest = 0;
  for (const p of rows) {
    const name = String(p.name || '');
    // Measured in the face the name actually renders in, so a column sized for
    // twenty characters holds twenty characters.
    if (agMeasureCtx) {
      agMeasureCtx.font = AG_NAME_FONT;
      widest = Math.max(widest, agMeasureCtx.measureText(name).width);
    } else {
      widest = Math.max(widest, name.length * 6.8);
    }
  }
  return `${Math.round(Math.min(160, Math.max(64, widest + 2)))}px`;
}
function agRowEl(id) {
  const list = $('#ag-list');
  if (!list || !id) return null;
  return list.querySelector(`.ag-row[data-id="${CSS.escape(id)}"]`);
}

// ── Paint ───────────────────────────────────────────────────────────────────

// A chip with nothing behind it stays on the band and goes disabled, so the
// band keeps its controls while the list filters.
function agFacetHtml(axis, key, n, active) {
  const on = key === active;
  const off = !on && n === 0;
  return `<button type="button" class="ag-facet${on ? ' is-active' : ''}" data-facet="${escapeAttr(axis)}" data-key="${escapeAttr(key)}" aria-pressed="${on ? 'true' : 'false'}"${off ? ' disabled aria-disabled="true"' : ''} tabindex="${on ? '0' : '-1'}">${escapeHtml(AG_FACET_LABEL[key] || key)}<span class="ag-facet-n">${escapeHtml(String(n))}</span></button>`;
}

const AG_ORIGIN_LABEL = { custom: 'Custom', builtin: 'Built-in', repo: 'From a repo' };

// One property cell. The label carries the field, the value carries the state,
// so the pane says what the row has no column for. A field with nothing behind
// it prints the sentence that names the absence, so the set of properties is
// the same on every record.
function agMetaHtml(label, value, cls, opts) {
  const o = opts || {};
  const empty = !value;
  const text = empty ? String(o.none || 'None') : String(value);
  const dd = [];
  if (o.mono && !empty) dd.push('ag-dt-path');
  if (empty) dd.push('is-empty');
  // Only a path can outrun its cell, so only a path carries a tooltip.
  const attr = (dd.length ? ` class="${dd.join(' ')}"` : '') + (o.mono && !empty ? ` title="${escapeAttr(text)}"` : '');
  return `<div class="ag-dt-cell${cls ? ` ${cls}` : ''}">`
    + `<dt>${escapeHtml(label)}</dt>`
    + `<dd${attr}>${escapeHtml(text)}</dd>`
    + '</div>';
}

// The agent under the caret, read in full: the same record the editor opens.
// The pane is mounted whenever the roster is, so the column count holds still
// while the list filters or loads.
function agPaintDetail() {
  const el = $('#ag-detail');
  const split = $('#ag-split');
  if (!el) return;
  // A roster that does not exist yet still holds its column, so the list never
  // snaps between one pane and two while the first read is in flight.
  const solo = !profilesCache.length && agLoad !== 'loading';
  if (split) split.classList.toggle('is-solo', solo);
  el.hidden = solo;
  if (solo) { el.textContent = ''; return; }
  if (agLoad === 'loading') {
    // eslint-disable-next-line no-unsanitized/property -- static placeholder
    el.innerHTML = '<div class="ag-dt-skel">'
      + '<span class="ag-skel ag-skel-name"></span>'
      + '<span class="ag-skel ag-skel-desc"></span>'
      + '<span class="ag-skel ag-skel-block"></span>'
      + '</div>';
    return;
  }
  const p = profilesCache.find((x) => x.id === agCursor);
  if (!p) {
    // eslint-disable-next-line no-unsanitized/property -- static copy
    el.innerHTML = '<p class="ag-dt-none">No agent selected</p>';
    return;
  }
  const prompt = String(p.systemPrompt || '').trim();
  const builtin = !!p.builtin;
  const pinned = getActiveProfileIds().includes(p.id);
  const name = String(p.name || '');
  const openTitle = builtin ? `View · ${AG_MOD} Enter` : `Edit · ${AG_MOD} Enter`;
  const openLabel = builtin ? `View ${name}` : `Edit ${name}`;
  // The pin is a control here rather than a printed value, so the pane gains
  // the verb instead of echoing a state the row already shows.
  const acts = `<button type="button" class="ag-pin" data-ag-dt-act="pin" aria-pressed="${pinned ? 'true' : 'false'}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${escapeAttr(name)}" title="${escapeAttr(agPinTitle(pinned))}">${AG_PIN_SVG}</button>`
    + `<button type="button" class="ag-act-btn" data-ag-dt-act="edit" aria-label="${escapeAttr(openLabel)}" title="${escapeAttr(openTitle)}">${builtin ? AG_VIEW_SVG : AG_EDIT_SVG}</button>`
    + (builtin ? '' : `<button type="button" class="ag-act-btn is-danger" data-ag-dt-act="del" aria-label="Delete ${escapeAttr(name)}" title="Delete · ${escapeAttr(AG_MOD)} Backspace">${AG_TRASH_SVG}</button>`);
  // Source names a repository, so it stands only for a record that came from one.
  const meta = agMetaHtml('Origin', AG_ORIGIN_LABEL[agOriginOf(p)] || 'Custom')
    + agMetaHtml('Auto-select', p.autoSelect ? 'On' : 'Off')
    + (p.repoRoot ? agMetaHtml('Source', agShortPath(p.repoRoot), 'ag-dt-cell-wide', { mono: true }) : '');
  // The sentence about the agent is the pane's lede, whatever the row managed to
  // show. A record with no sentence at all says so rather than leaving the slot out.
  const full = agDesc(p);
  // eslint-disable-next-line no-unsanitized/property -- every interpolation goes through escapeHtml / escapeAttr
  el.innerHTML = `<div class="ag-dt-head"><h2 class="ag-dt-name" title="${escapeAttr(name)}">${escapeHtml(name)}</h2><span class="ag-dt-acts">${acts}</span></div>`
    + (full ? `<p class="ag-dt-desc">${escapeHtml(full)}</p>` : '<p class="ag-dt-desc is-empty">No description</p>')
    + `<dl class="ag-dt-meta">${meta}</dl>`
    + '<p class="ag-dt-label">System prompt</p>'
    + (prompt
      ? `<pre class="ag-dt-prompt">${escapeHtml(prompt)}</pre>`
      : '<p class="ag-dt-none">No prompt of its own.</p>');
  // A block only earns a tab stop when there is something under the fold to
  // scroll to, so a one-line prompt costs the keyboard nothing.
  const pre = el.querySelector('.ag-dt-prompt');
  if (pre && pre.scrollHeight > pre.clientHeight + 1) {
    pre.tabIndex = 0;
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', 'System prompt');
  }
}

// One toggle, since unpinned is the roster minus pinned. The chip stays mounted
// while anything is pinned and greys out when the query excludes all of them,
// and it updates in place so the keyboard keeps its stop.
function agPaintStateFacet() {
  const el = $('#ag-state');
  const sep = $('#ag-bar-sep');
  if (!el) return;
  const n = agRows(agOrigin, 'pinned').length;
  const on = agState === 'pinned';
  const show = on || getActiveProfileIds().length > 0;
  const chip = el.querySelector('.ag-facet');
  if (show && chip) {
    const nEl = chip.querySelector('.ag-facet-n');
    if (nEl) nEl.textContent = String(n);
    chip.classList.toggle('is-active', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    agSetFacetEnabled(chip, on || n > 0);
  } else if (show) {
    // eslint-disable-next-line no-unsanitized/property -- every interpolation goes through escapeHtml / escapeAttr
    el.innerHTML = agFacetHtml('state', 'pinned', n, agState);
  } else if (chip) {
    el.textContent = '';
  }
  if (sep) sep.hidden = !show;
  // The head names an axis, so it stands only while the axis has chips under it.
  const group = $('#ag-state-group');
  if (group) group.hidden = !show;
  agSyncFacetTabs(el);
}

function agSetFacetEnabled(chip, enabled) {
  chip.disabled = !enabled;
  if (enabled) chip.removeAttribute('aria-disabled');
  else chip.setAttribute('aria-disabled', 'true');
}

function agSyncFacetTabs(group) {
  if (!group) return;
  const chips = [...group.querySelectorAll('.ag-facet')];
  if (!chips.length) return;
  // A greyed chip is not a tab stop, so the one stop each axis owns always
  // lands somewhere the keyboard can act.
  const live = chips.filter((c) => !c.disabled);
  const active = chips.find((c) => c.classList.contains('is-active')) || live[0] || chips[0];
  chips.forEach((c) => { c.tabIndex = c === active ? 0 : -1; });
}

function agPinTitle(pinned) {
  return `${pinned ? 'Unpin from the chat header' : 'Pin to the chat header'} · Space`;
}

function agRowDomId(id) {
  return `ag-row-${encodeURIComponent(String(id))}`;
}

function agRowHtml(p, pinned) {
  const name = String(p.name || '');
  const desc = agDesc(p);
  const builtin = !!p.builtin;
  const tags = agTags(p).map((t) => `<span class="ag-tag">${escapeHtml(t)}</span>`).join('');
  const openLabel = builtin ? `View ${name}` : `Edit ${name}`;
  const openTitle = builtin ? `View · ${AG_MOD} Enter` : `Edit · ${AG_MOD} Enter`;
  // A built-in has no trash button at all rather than a disabled one; the
  // remaining verb takes the trailing slot, so the right rail stays flush.
  const del = builtin ? '' : `<button type="button" class="ag-act-btn is-danger" data-ag-act="del" tabindex="-1" aria-label="Delete ${escapeAttr(name)}" title="Delete · ${escapeAttr(AG_MOD)} Backspace">${AG_TRASH_SVG}</button>`;
  // The row carries a stable id of its own so the search field can name it as
  // the active record while the caret moves and focus stays in the field.
  return `<div class="ag-row${pinned ? ' is-pinned' : ''}" id="${escapeAttr(agRowDomId(p.id))}" role="option" aria-selected="false" tabindex="-1" data-id="${escapeAttr(p.id)}" data-builtin="${builtin ? '1' : '0'}">`
    + `<button type="button" class="ag-pin" data-ag-act="pin" tabindex="-1" aria-pressed="${pinned ? 'true' : 'false'}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${escapeAttr(name)}" title="${escapeAttr(agPinTitle(pinned))}">${AG_PIN_SVG}</button>`
    + `<span class="ag-name">${escapeHtml(name)}</span>`
    + `<span class="ag-desc">${escapeHtml(desc)}</span>`
    + `<span class="ag-tags">${tags}</span>`
    + `<span class="ag-act">`
    + `<button type="button" class="ag-act-btn" data-ag-act="edit" tabindex="-1" aria-label="${escapeAttr(openLabel)}" title="${escapeAttr(openTitle)}">${builtin ? AG_VIEW_SVG : AG_EDIT_SVG}</button>`
    + del
    + `</span></div>`;
}

// The placeholder is as long as the roster was the last time this window saw
// it, so a library of thirty does not open on a stub of eight.
function agSkeletonHtml() {
  let n;
  try { n = Math.min(24, Math.max(4, Number(sessionStorage.getItem('ag.rows')) || 8)); } catch (_) { n = 8; }
  let out = '';
  for (let i = 0; i < n; i++) {
    out += '<div class="ag-row is-skel" role="presentation">'
      + '<span class="ag-skel ag-skel-check"></span>'
      + '<span class="ag-name"><span class="ag-skel ag-skel-name"></span></span>'
      + '<span class="ag-desc"><span class="ag-skel ag-skel-desc"></span></span>'
      + '<span class="ag-tags"><span class="ag-skel ag-skel-tag"></span></span>'
      + '<span class="ag-act"></span></div>';
  }
  return out;
}

function agEmptyHtml(title, msg, actionKey, actionLabel, errText) {
  return '<div class="ag-empty" role="presentation">'
    + `<p class="ag-empty-title">${escapeHtml(title)}</p>`
    + (msg ? `<p class="ag-empty-msg">${escapeHtml(msg)}</p>` : '')
    + (errText ? `<p class="ag-empty-err">${escapeHtml(errText)}</p>` : '')
    + `<button type="button" class="ghost-btn" data-ag-empty="${escapeAttr(actionKey)}">${escapeHtml(actionLabel)}</button>`
    + '</div>';
}

function agSyncMaster(rows) {
  const master = $('#ag-master');
  if (!master) return;
  const ids = new Set(getActiveProfileIds());
  const on = rows.filter((p) => ids.has(p.id)).length;
  const all = !!rows.length && on === rows.length;
  master.disabled = !rows.length;
  master.setAttribute('aria-pressed', all ? 'true' : 'false');
  master.classList.toggle('is-some', !!on && !all);
  const label = all ? 'Unpin all shown' : 'Pin all shown';
  // One click rewrites the whole shown scope, so the control names the chord
  // that does the same thing without the pointer.
  master.title = `${label} · ${AG_MOD} Shift ${all ? 'D' : 'A'}`;
  master.setAttribute('aria-label', label);
}

// Counts only. Never writes #ag-list, so a pin never destroys the row the
// pointer or the caret is resting on.
function agPaintCounts() {
  $$('#ag-origin .ag-facet').forEach((b) => {
    const n = agRows(b.dataset.key, agState).length;
    const nEl = b.querySelector('.ag-facet-n');
    if (nEl) nEl.textContent = String(n);
    agSetFacetEnabled(b, b.classList.contains('is-active') || n > 0);
  });
  agPaintStateFacet();
  const rows = agRows();
  const countEl = $('#ag-count');
  if (countEl) countEl.textContent = agFiltered() ? `${rows.length} of ${profilesCache.length}` : '';
  agSyncMaster(rows);
}

function agSyncPinLabels(pin, pinned, label) {
  if (!pin) return;
  pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${label}`);
  pin.title = agPinTitle(pinned);
}

// The row and the reader can both be showing the same record, so both toggles
// take the new state in place rather than through a repaint that would move
// focus off the button that was just pressed.
function agSyncRowLabels(id, pinned) {
  const row = agRowEl(id);
  const name = row && row.querySelector('.ag-name');
  const label = name ? name.textContent : (profilesCache.find((x) => x.id === id) || {}).name || '';
  if (row) agSyncPinLabels(row.querySelector('.ag-pin'), pinned, label);
  if (id === agCursor) agSyncPinLabels($('#ag-detail [data-ag-dt-act="pin"]'), pinned, label);
}

function paintAgents() {
  const list = $('#ag-list');
  if (!list) return;
  const total = profilesCache.length;
  const loading = agLoad === 'loading';
  if (!loading) { try { sessionStorage.setItem('ag.rows', String(total)); } catch (_) { /* private mode */ } }

  // An origin with no members earns no chip, so a facet can never point at an
  // empty set the user did not ask for.
  const members = { custom: 0, builtin: 0, repo: 0 };
  for (const p of profilesCache) members[agOriginOf(p)]++;
  if (agOrigin !== 'all' && !members[agOrigin]) agOrigin = 'all';

  const panel = $('#ag-panel');
  if (panel) panel.classList.toggle('is-loading', loading);

  // While the roster is in flight the chip set holds whatever it had, so the
  // band never claims a count it does not know and never reflows on arrival.
  const originEl = $('#ag-origin');
  if (originEl && !loading) {
    // One origin is not an axis: All and the only origin there is select the
    // same rows, so the roster is unambiguous and the chips are dropped.
    const present = AG_BANDS.map(([k]) => k).filter((k) => members[k]);
    if (present.length < 2) agOrigin = 'all';
    const keys = present.length > 1 ? ['all', ...present] : [];
    // eslint-disable-next-line no-unsanitized/property -- every interpolation goes through escapeHtml / escapeAttr
    originEl.innerHTML = keys.map((k) => agFacetHtml('origin', k, agRows(k, agState).length, agOrigin)).join('');
    // The head counts the origins the roster actually holds, not the chips,
    // since All is a view of the axis rather than a member of it.
    const originN = $('#ag-origin-n');
    if (originN) originN.textContent = String(present.length);
  }
  // The head names an axis, so it stands only while the axis has chips under it.
  const originGroup = $('#ag-origin-group');
  if (originGroup && originEl) originGroup.hidden = !originEl.children.length;
  if (!loading) agPaintStateFacet();
  // An axis with nothing selected still owes the keyboard one way in.
  agSyncFacetTabs(originEl);

  const rows = agRows();
  const countEl = $('#ag-count');
  if (countEl) countEl.textContent = (!loading && agFiltered()) ? `${rows.length} of ${total}` : '';
  agSyncMaster(rows);

  const keysEl = $('#ag-keys');
  if (keysEl) {
    // Every binding that acts on a row, in one list of verbs, spelled out
    // rather than glyphed. With no row to act on, the legend names the
    // bindings that lead back to one.
    const onRows = [
      [['↑', '↓'], 'move'], [['Enter'], 'open'], [['Space'], 'pin'],
      [[AG_MOD, 'D'], 'duplicate'], [[AG_MOD, 'Backspace'], 'delete'], [['N'], 'new'],
    ];
    const wayBack = agFiltered() ? [[['Esc'], 'clear'], [['N'], 'new']] : [[['N'], 'new']];
    const chips = (loading || rows.length) ? onRows : wayBack;
    // eslint-disable-next-line no-unsanitized/property -- every interpolation goes through escapeHtml
    keysEl.innerHTML = chips.map(([keys, v]) => '<span class="ag-key"><span class="ag-key-caps">'
      + keys.map((k) => `<kbd class="kbd-cap">${escapeHtml(k)}</kbd>`).join('')
      + `</span><span class="ag-key-word">${escapeHtml(v)}</span></span>`).join('');
  }

  // Sized off the whole roster, so a keystroke that narrows the list never
  // slides the description column sideways.
  list.style.setProperty('--ag-name-w', agNameWidth(profilesCache));

  const ids = new Set(getActiveProfileIds());
  let body;
  if (loading) {
    body = agSkeletonHtml();
  } else if (agLoad === 'error') {
    body = agEmptyHtml('Could not load agents', '', 'retry', 'Retry', agError.slice(0, 140));
  } else if (!total) {
    // A heading and the one action, nothing else. The routes a longer sentence
    // would name are the buttons already on the toolbar above it.
    body = agEmptyHtml('No agents yet', '', 'new', 'New agent');
  } else if (!rows.length) {
    const q = agQuery.trim();
    body = q
      ? agEmptyHtml('No match', '', 'create', `New "${q}"`)
      : agEmptyHtml(`No agents in ${AG_FACET_LABEL[agOrigin === 'all' ? agState : agOrigin]}`, '', 'clear', 'Show all agents');
  } else {
    // Bands only earn their space in a library big enough to lose a row in,
    // with more than one group to separate, and only when the origin facet is
    // not already naming the scope.
    const groups = AG_BANDS.filter(([key]) => rows.some((p) => agOriginOf(p) === key));
    const banded = agOrigin === 'all' && total >= AG_BAND_MIN && groups.length > 1;
    let out = '';
    if (banded) {
      for (const [key, label] of groups) {
        const run = rows.filter((p) => agOriginOf(p) === key);
        out += `<div class="ag-group" role="presentation"><span class="ag-group-name">${escapeHtml(label)}</span><span class="ag-group-n">${run.length}</span></div>`;
        out += run.map((p) => agRowHtml(p, ids.has(p.id))).join('');
      }
    } else {
      out = rows.map((p) => agRowHtml(p, ids.has(p.id))).join('');
    }
    body = out;
  }
  // eslint-disable-next-line no-unsanitized/property -- every interpolation goes through escapeHtml / escapeAttr
  list.innerHTML = body;
  agSyncTruncationTitles(list);

  if (!rows.some((p) => p.id === agCursor)) agCursor = (rows[0] && rows[0].id) || null;
  agSyncCursor();
}

// A tooltip that repeats a label the reader can already see is noise, so the
// title exists only on the runs the column actually cut off.
function agSyncTruncationTitles(list) {
  list.querySelectorAll('.ag-name, .ag-desc').forEach((el) => {
    const text = el.textContent.trim();
    if (text && el.scrollWidth > el.clientWidth + 1) el.title = text;
    else el.removeAttribute('title');
  });
}

// ── Pinning ─────────────────────────────────────────────────────────────────

// Off-scope rule: inside the Pinned facet a toggled row stops matching the
// filter and stays where it is until the next explicit repaint, so rows never
// move under the pointer or the caret.
async function agToggle(id, want) {
  const ids = getActiveProfileIds();
  const on = ids.includes(id);
  const next = (want === undefined) ? !on : !!want;
  if (next === on) return;
  const row = agRowEl(id);
  const pin = row && row.querySelector('.ag-pin');
  const dtPin = id === agCursor ? $('#ag-detail [data-ag-dt-act="pin"]') : null;
  // Optimistic flip on the same nodes: the transition runs, focus survives.
  if (row) row.classList.toggle('is-pinned', next);
  if (pin) pin.setAttribute('aria-pressed', next ? 'true' : 'false');
  if (dtPin) dtPin.setAttribute('aria-pressed', next ? 'true' : 'false');
  const res = next ? await window.husk.profiles.activate(id)
    : await window.husk.profiles.deactivate(id);
  if (!res || !res.ok) {
    if (row) row.classList.toggle('is-pinned', on);
    if (pin) pin.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (dtPin) dtPin.setAttribute('aria-pressed', on ? 'true' : 'false');
    toast('Could not update agent', 'error');
    return;
  }
  cfg = await window.husk.config.get();
  agPaintCounts();
  agSyncRowLabels(id, next);
  updateActiveChatProfile();
}

// One IPC and one config write for any scope, filtered or not. One gesture can
// rewrite the whole pinned set, so it carries the same undo a delete does.
async function agBulkPin(next) {
  const rows = agRows();
  if (!rows.length) return;
  const before = getActiveProfileIds().slice();
  const ids = new Set(before);
  for (const p of rows) { if (next) ids.add(p.id); else ids.delete(p.id); }
  const master = $('#ag-master');
  if (master) master.disabled = true;
  const res = await window.husk.profiles.setActive([...ids]);
  if (master) master.disabled = false;
  if (!res || !res.ok) { toast('Could not update agents', 'error'); return; }
  cfg = await window.husk.config.get();
  paintAgents();               // an explicit gesture, so the list is expected to settle
  updateActiveChatProfile();
  const n = rows.length;
  toastAction(`${next ? 'Pinned' : 'Unpinned'} ${n} ${n === 1 ? 'agent' : 'agents'}`, 'Undo', async () => {
    const back = await window.husk.profiles.setActive(before);
    if (!back || !back.ok) { toast('Could not restore the pinned agents', 'error'); return; }
    cfg = await window.husk.config.get();
    paintAgents();
    updateActiveChatProfile();
  }, '');
}

// ── Cursor ──────────────────────────────────────────────────────────────────

// Roving tabindex: the cursor row and its three controls are the only tab
// stops in the list, so the list costs four stops at any agent count and every
// control is still reachable by moving the cursor and pressing Tab.
function agSyncCursor({ scroll = false, focus = false } = {}) {
  const list = $('#ag-list');
  if (!list) return;
  list.querySelectorAll('.ag-row').forEach((r) => {
    const on = r.dataset.id === agCursor;
    r.classList.toggle('is-cursor', on);
    // The caret is a state of the record, not only a fill on the row, so it
    // is readable without the pixels.
    if (on) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current');
    r.setAttribute('aria-selected', on ? 'true' : 'false');
    r.tabIndex = on ? 0 : -1;
    r.querySelectorAll('.ag-pin, .ag-act-btn').forEach((c) => { c.tabIndex = on ? 0 : -1; });
  });
  const el = agRowEl(agCursor);
  if (el && scroll) el.scrollIntoView({ block: 'nearest' });
  if (el && focus) el.focus({ preventScroll: true });
  // The arrows move the caret while the query field holds focus, so the field
  // names the record the caret is on.
  const search = $('#agents-search');
  if (search) {
    if (el && !list.contains(document.activeElement)) search.setAttribute('aria-activedescendant', el.id);
    else search.removeAttribute('aria-activedescendant');
  }
  agPaintDetail();
}

// Held arrow keys repeat faster than a 120ms cross-fade resolves, so the list
// drops its transition while the keyboard owns the caret and takes it back the
// moment the pointer moves.
function agNavByKey() {
  const list = $('#ag-list');
  if (list) list.dataset.nav = 'key';
}

function agMoveCursor(delta) {
  const rows = agRows();
  if (!rows.length) return;
  const i = rows.findIndex((p) => p.id === agCursor);
  const next = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i + delta)));
  agCursor = rows[next].id;
  agNavByKey();
  const list = $('#ag-list');
  const inList = !!list && list.contains(document.activeElement);
  agSyncCursor({ scroll: true, focus: inList });
}

// Roving tabindex inside a facet group: one chip per axis is a tab stop and
// the arrows reach the rest, so every filter on the band is a keyboard filter.
function agMoveFacet(group, key) {
  // A greyed chip is skipped rather than selected, so the arrows only ever
  // land on a filter that has something behind it.
  const chips = [...group.querySelectorAll('.ag-facet')].filter((c) => !c.disabled);
  if (!chips.length) return;
  const from = chips.findIndex((c) => c.contains(document.activeElement));
  let i;
  if (key === 'Home') i = 0;
  else if (key === 'End') i = chips.length - 1;
  else {
    const step = key === 'ArrowRight' ? 1 : chips.length - 1;
    i = ((from < 0 ? 0 : from) + step) % chips.length;
  }
  const want = chips[i].dataset.key;
  agSetFacet(chips[i].dataset.facet, want);
  paintAgents();
  // The group element survives the repaint; its chips do not.
  const back = group.querySelector(`.ag-facet[data-key="${CSS.escape(want)}"]`);
  if (back) { back.tabIndex = 0; back.focus(); }
}

function agSetFacet(axis, key) {
  if (axis === 'origin') agOrigin = key; else agState = key;
}

function agSetCursorEdge(last) {
  const rows = agRows();
  if (!rows.length) return;
  agCursor = (last ? rows[rows.length - 1] : rows[0]).id;
  agNavByKey();
  const list = $('#ag-list');
  const inList = !!list && list.contains(document.activeElement);
  agSyncCursor({ scroll: true, focus: inList });
}

// ── Compatibility shims ─────────────────────────────────────────────────────
// Callers outside this page (launch-time auto-select, the palette) keep their
// entry points; the page keeps its nodes.

async function activateProfile(id) {
  const res = await window.husk.profiles.activate(id);
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  updateActiveChatProfile();
  if (!agentsPageOpen()) return;
  agPaintCounts();
  const row = agRowEl(id);
  if (row) {
    row.classList.add('is-pinned');
    agSyncRowLabels(id, true);
  }
}

async function deactivateProfile(id) {
  const res = await window.husk.profiles.deactivate(id);
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  updateActiveChatProfile();
  if (!agentsPageOpen()) return;
  agPaintCounts();
  const row = agRowEl(id);
  if (row) {
    row.classList.remove('is-pinned');
    agSyncRowLabels(id, false);
  }
}

async function activateAllProfiles() {
  const res = await window.husk.profiles.setActive(profilesCache.map((p) => p.id).filter(Boolean));
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  if (agentsPageOpen()) paintAgents();
  updateActiveChatProfile();
}

async function deactivateAllProfiles() {
  const res = await window.husk.profiles.setActive([]);
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  if (agentsPageOpen()) paintAgents();
  updateActiveChatProfile();
}

// The tool and the folder this chat runs in. A resumed session hands its own
// pair over here, and they hold until preferences or the active project moves.
// The status bar and the Context pane both read from it.
let chatSubBase = null;
function setChatSubBase(base) {
  chatSubBase = base || null;
  updateActiveChatProfile();
}

function updateActiveChatProfile() {
  refreshShellStatusBar();
  refreshArtifactPane();
}

// ── Delete, duplicate ───────────────────────────────────────────────────────

async function deleteProfile(id) {
  const p = profilesCache.find((x) => x.id === id);
  if (!p) return;
  if (p.builtin) { toast('Built-in agents cannot be deleted', 'error'); return; }
  const ok = await openConfirmDialog({
    title: 'Delete agent',
    bodyHtml: `Removes <strong>${escapeHtml(p.name)}</strong> from Husk and deletes its agent file from every AI tool folder on this machine.`,
    confirmLabel: 'Delete agent',
  });
  if (!ok) return;
  const wasPinned = getActiveProfileIds().includes(id);
  const snapshot = { ...p };
  const rows = agRows();
  const i = rows.findIndex((x) => x.id === id);
  const res = await window.husk.profiles.delete(id);
  if (!res || !res.ok) { toast((res && res.error) || 'Could not delete agent', 'error'); return; }
  profilesCache = profilesCache.filter((x) => x.id !== id);
  cfg = await window.husk.config.get();
  agCursor = (rows[i + 1] || rows[i - 1] || {}).id || null;
  paintAgents();
  // The caret lands on the neighbour, so the keyboard comes back out of the
  // dialog standing in the list rather than on the document.
  agSyncCursor({ scroll: true, focus: true });
  updateActiveChatProfile();
  // The restored record carries a new id, and a repo agent loses its repo
  // binding, because create accepts neither. The toast promises nothing more
  // than the name it names.
  toastAction(`Deleted ${snapshot.name}`, 'Undo', async () => {
    const back = await window.husk.profiles.create({
      name: snapshot.name,
      description: snapshot.description || '',
      systemPrompt: snapshot.systemPrompt || '',
      autoSelect: !!snapshot.autoSelect,
    });
    if (!back || !back.id) { toast('Could not restore agent', 'error'); return; }
    profilesCache = [...profilesCache, back];
    if (wasPinned) await window.husk.profiles.activate(back.id);
    cfg = await window.husk.config.get();
    agCursor = back.id;
    paintAgents();
    updateActiveChatProfile();
  }, '');
}

// The route for changing a built-in's prompt: copy it, then edit the copy.
async function agDuplicate(id) {
  const p = profilesCache.find((x) => x.id === id);
  if (!p) return;
  const base = `${p.name} copy`;
  const taken = new Set(profilesCache.map((x) => x.name));
  let name = base, i = 2;
  while (taken.has(name)) name = `${base} ${i++}`;
  const res = await window.husk.profiles.create({
    name: name.slice(0, 64),
    description: p.description || '',
    systemPrompt: p.systemPrompt || '',
    autoSelect: false,
  });
  if (!res || !res.id) { toast('Could not duplicate agent', 'error'); return; }
  profilesCache = [...profilesCache, res];
  agCursor = res.id;
  paintAgents();
  openAgentModal(res.id);
}

// ── Editor ──────────────────────────────────────────────────────────────────

const AG_CAPS = ['#agent-name', '#agent-description', '#agent-system-prompt'];

// The limit lives on the field itself, so the counter matches what the field
// accepts. The denominator appears only near the cap.
function agSyncCounter(sel) {
  const el = $(sel);
  const cc = $(`${sel}-cc`);
  if (!el || !cc) return;
  const cap = Number(el.maxLength) > 0 ? Number(el.maxLength) : Infinity;
  const len = String(el.value || '').length;
  const near = Number.isFinite(cap) && len >= Math.floor(cap * 0.9);
  cc.textContent = near ? `${len}/${cap}` : String(len);
  cc.classList.toggle('is-full', Number.isFinite(cap) && len >= cap);
  cc.classList.toggle('is-near', near && len < cap);
}
function agSyncCounters() { for (const sel of AG_CAPS) agSyncCounter(sel); }

function openAgentModal(editId, { prefillName } = {}) {
  const modal = $('#agent-modal');
  if (!modal) return;
  editingProfileId = editId || null;
  const existing = editId ? profilesCache.find((p) => p.id === editId) : null;
  const builtin = !!(existing && existing.builtin);

  const titleEl = $('#agent-modal-title');
  if (titleEl) titleEl.textContent = existing ? (builtin ? 'View agent' : 'Edit agent') : 'New agent';

  if ($('#agent-name')) { $('#agent-name').value = existing ? (existing.name || '') : (prefillName || ''); $('#agent-name').classList.remove('field-invalid'); }
  if ($('#agent-description')) $('#agent-description').value = existing ? (existing.description || '') : '';
  if ($('#agent-system-prompt')) $('#agent-system-prompt').value = existing ? (existing.systemPrompt || '') : '';
  if ($('#agent-autoselect')) $('#agent-autoselect').checked = !!(existing && existing.autoSelect);
  agSyncCounters();

  for (const sel of AG_CAPS) { const el = $(sel); if (el) el.readOnly = builtin; }

  const genStep = $('#agent-generate-step');
  if (genStep) genStep.hidden = !!existing;
  if ($('#agent-generate-desc')) $('#agent-generate-desc').value = '';
  agResetGenButtons();

  if ($('#agent-modal-delete')) $('#agent-modal-delete').hidden = !existing || builtin;
  if ($('#agent-modal-save')) $('#agent-modal-save').hidden = builtin;
  if ($('#agent-modal-duplicate')) $('#agent-modal-duplicate').hidden = !builtin;
  if ($('#agent-builtin-note')) $('#agent-builtin-note').hidden = !builtin;

  const srcRow = $('#agent-source-row');
  const srcPath = $('#agent-source-path');
  const repoRoot = existing && existing.repoRoot;
  if (srcRow) srcRow.hidden = !repoRoot;
  if (srcPath) { srcPath.textContent = repoRoot ? agShortPath(repoRoot) : ''; srcPath.title = repoRoot || ''; }

  modal.hidden = false;
  const first = prefillName ? '#agent-description' : (existing ? '#agent-name' : '#agent-generate-desc');
  setTimeout(() => { try { $(first).focus(); } catch (_) {} }, 30);
}

function agResetGenButtons() {
  const btn = $('#btn-generate-agent');
  if (btn) { btn.disabled = false; btn.textContent = 'Draft'; }
  const cancel = $('#btn-generate-cancel');
  if (cancel) cancel.hidden = true;
}

function closeAgentModal() {
  const modal = $('#agent-modal');
  if (modal) modal.hidden = true;
  agGenSeq++;
  const status = $('#agent-generate-status');
  if (status) { status.hidden = true; status.textContent = ''; status.classList.remove('is-error'); }
  agResetGenButtons();
  const genStep = $('#agent-generate-step');
  if (genStep) genStep.hidden = false;
  for (const sel of AG_CAPS) { const el = $(sel); if (el) el.readOnly = false; }
  editingProfileId = null;
}

async function saveAgentModal() {
  const name = (($('#agent-name') || {}).value || '').trim();
  const description = (($('#agent-description') || {}).value || '').trim();
  const systemPrompt = (($('#agent-system-prompt') || {}).value || '').trim();
  const autoSelect = !!(($('#agent-autoselect') || {}).checked);
  if ($('#agent-name')) $('#agent-name').classList.remove('field-invalid');
  if (!name) {
    toast('Name is required', 'error');
    if ($('#agent-name')) { $('#agent-name').classList.add('field-invalid'); $('#agent-name').focus(); }
    return;
  }
  let res;
  if (editingProfileId) {
    res = await window.husk.profiles.update({ id: editingProfileId, name, description, systemPrompt, autoSelect });
    if (res && res.ok) profilesCache = profilesCache.map((p) => p.id === editingProfileId ? { ...p, name, description, systemPrompt, autoSelect } : p);
  } else {
    res = await window.husk.profiles.create({ name, description, systemPrompt, autoSelect });
    if (res && res.id) { profilesCache = [...profilesCache, res]; agCursor = res.id; }
  }
  if (!res || (!res.ok && !res.id)) { toast('Could not save agent', 'error'); return; }
  closeAgentModal();
  paintAgents();
  updateActiveChatProfile();
}

// The draft has no abort channel, so Cancel stops waiting for it rather than
// claiming to stop it.
async function generateAgentWithAI() {
  const descEl = $('#agent-generate-desc');
  const statusEl = $('#agent-generate-status');
  const btn = $('#btn-generate-agent');
  const cancel = $('#btn-generate-cancel');
  const desc = descEl ? descEl.value.trim() : '';
  if (!desc) {
    toast('Describe what the agent should do first', 'error');
    if (descEl) descEl.focus();
    return;
  }
  const token = ++agGenSeq;
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; statusEl.classList.remove('is-error'); }
  if (btn) btn.disabled = true;
  if (cancel) cancel.hidden = false;
  // A spinner under 400ms reads as a flicker, so the button only changes when
  // the wait is long enough to notice.
  setTimeout(() => {
    if (token !== agGenSeq || !btn) return;
    // eslint-disable-next-line no-unsanitized/property -- static markup
    btn.innerHTML = '<span class="ag-spin"></span> Drafting';
  }, 400);

  let res = null;
  try { res = await window.husk.profiles.generate(desc); } catch (err) { res = { ok: false, error: String((err && err.message) || err) }; }
  if (token !== agGenSeq) return;
  agResetGenButtons();
  if (!res || !res.ok) {
    if (statusEl) {
      statusEl.textContent = (res && res.error) || 'Draft failed';
      statusEl.hidden = false;
      statusEl.classList.add('is-error');
    }
    return;
  }
  if ($('#agent-name')) $('#agent-name').value = res.name || '';
  if ($('#agent-description')) $('#agent-description').value = res.description || '';
  if ($('#agent-system-prompt')) $('#agent-system-prompt').value = res.systemPrompt || '';
  agSyncCounters();
  setTimeout(() => { try { $('#agent-name').focus(); } catch (_) {} }, 30);
}

// ── Events ──────────────────────────────────────────────────────────────────

function agResetFilters() {
  agOrigin = 'all'; agState = 'all'; agQuery = '';
  const s = $('#agents-search');
  if (s) s.value = '';
}

function agFocusSearch() {
  const s = $('#agents-search');
  if (!s) return;
  s.focus();
  s.select();
}

function onAgListClick(e) {
  const em = e.target.closest('[data-ag-empty]');
  if (em) {
    const k = em.dataset.agEmpty;
    if (k === 'retry') return void renderAgents();
    if (k === 'new') return void openAgentModal(null);
    if (k === 'create') {
      const q = agQuery.trim();
      agResetFilters();
      paintAgents();
      return void openAgentModal(null, { prefillName: q.slice(0, 64) });
    }
    agResetFilters();
    paintAgents();
    // The repaint destroys the button that was pressed, so the keyboard lands
    // in the list the press just refilled.
    agSyncCursor({ focus: true });
    return;
  }
  const row = e.target.closest('.ag-row');
  if (!row || row.classList.contains('is-skel')) return;
  const act = e.target.closest('[data-ag-act]');
  if (act) {
    e.stopPropagation();
    const kind = act.dataset.agAct;
    if (kind === 'pin') agToggle(row.dataset.id);
    else if (kind === 'edit') openAgentModal(row.dataset.id);
    else deleteProfile(row.dataset.id);
    return;
  }
  // Only a selection made inside this row blocks the click, so leftover
  // selected text elsewhere on the page cannot make a row dead.
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && row.contains(sel.anchorNode)) return;
  agCursor = row.dataset.id;
  agSyncCursor({ focus: true });
}

function agKeydown(e) {
  if (!agentsPageOpen()) return;
  // Anything layered over the page owns the keyboard while it is up, so the
  // caret behind it never moves and Enter never reaches a row.
  if (document.querySelector('.modal:not([hidden]), .palette:not([hidden])')) return;
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
  const inInput = tag === 'INPUT' || tag === 'SELECT';
  const key = e.key;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && !e.altKey) {
    const k = String(key).toLowerCase();
    if (e.shiftKey && k === 'a') { e.preventDefault(); agBulkPin(true); return; }
    if (e.shiftKey && k === 'd') { e.preventDefault(); agBulkPin(false); return; }
    if (e.shiftKey) return;
    if (k === 'f') { e.preventDefault(); agFocusSearch(); return; }
    if (key === 'Enter') { e.preventDefault(); if (agCursor) openAgentModal(agCursor); return; }
    if (k === 'd') { e.preventDefault(); if (agCursor) agDuplicate(agCursor); return; }
    if (key === 'Backspace') { e.preventDefault(); if (agCursor) deleteProfile(agCursor); return; }
    return;                       // every other chord belongs to the shell
  }
  if (e.altKey) return;

  // A focused facet owns the horizontal arrows, so every chip on both axes is
  // reachable without a pointer.
  const group = t && t.closest && t.closest('.ag-facets');
  if (group && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End')) {
    e.preventDefault();
    agMoveFacet(group, key);
    return;
  }

  // Arrows move the caret even while the search box has focus, but only while
  // focus is inside the page or nowhere in particular, so the rail and the
  // shell keep their own arrow keys.
  const idle = !document.activeElement || document.activeElement === document.body;
  const inPage = idle || !!(t && t.closest && t.closest('.page-agents'));
  if (inPage) {
    if (key === 'ArrowDown' || key === 'ArrowUp') { e.preventDefault(); agMoveCursor(key === 'ArrowDown' ? 1 : -1); return; }
    if (key === 'PageDown' || key === 'PageUp') { e.preventDefault(); agMoveCursor(key === 'PageDown' ? 10 : -10); return; }
    if ((key === 'Home' || key === 'End') && !inInput) { e.preventDefault(); agSetCursorEdge(key === 'End'); return; }
  }

  if (key === 'Escape') {
    if (agQuery.trim()) {
      agQuery = '';
      const s = $('#agents-search');
      if (s) s.value = '';
      paintAgents();
      e.preventDefault();
      return;
    }
    if (agOrigin !== 'all' || agState !== 'all') {
      agResetFilters();
      paintAgents();
      e.preventDefault();
      return;
    }
    const s = $('#agents-search');
    if (s && document.activeElement === s) s.blur();
    return;
  }

  // A control that already answers the key answers it natively.
  const onControl = !!(t && t.closest && t.closest('.ag-act-btn, .ag-pin, .ag-facet, button'));
  // Enter opens what the caret is on, the way it does in every list. Space is
  // the toggle, which is where a pin belongs.
  if (key === 'Enter') {
    if (onControl) return;
    e.preventDefault();
    if (agCursor) openAgentModal(agCursor);
    return;
  }
  if (key === ' ') {
    if (onControl || inInput) return;
    e.preventDefault();
    if (agCursor) agToggle(agCursor);
    return;
  }
  if (key === '/' && !inInput) { e.preventDefault(); agFocusSearch(); return; }
  if (!inInput && (key === 'n' || key === 'N')) { e.preventDefault(); openAgentModal(null); }
}

$('#agents-search') && $('#agents-search').addEventListener('input', (e) => { agQuery = e.target.value; paintAgents(); });
$('#btn-agents-refresh') && $('#btn-agents-refresh').addEventListener('click', () => renderAgents());
$('#btn-new-agent') && $('#btn-new-agent').addEventListener('click', () => openAgentModal(null));

$('#ag-bar') && $('#ag-bar').addEventListener('click', (e) => {
  const f = e.target.closest('.ag-facet');
  if (!f) return;
  // The pinned axis has no All chip, so clicking the chip that is already on
  // is how the axis clears.
  const key = f.dataset.key;
  const group = f.closest('.ag-facets');
  const next = (f.dataset.facet === 'state' && agState === key) ? 'all' : key;
  agSetFacet(f.dataset.facet, next);
  paintAgents();
  // The group element survives the repaint; its chips do not. Without this the
  // arrows that traverse the band have nothing to start from.
  const back = group && group.querySelector(`.ag-facet[data-key="${CSS.escape(key)}"]`);
  if (back) { back.tabIndex = 0; back.focus(); }
  else agSyncCursor({ focus: true });
});
$('#ag-master') && $('#ag-master').addEventListener('click', (e) => {
  agBulkPin(e.currentTarget.getAttribute('aria-pressed') !== 'true');
});

$('#ag-detail') && $('#ag-detail').addEventListener('click', (e) => {
  const act = e.target.closest('[data-ag-dt-act]');
  if (!act || !agCursor) return;
  const kind = act.dataset.agDtAct;
  if (kind === 'pin') agToggle(agCursor);
  else if (kind === 'edit') openAgentModal(agCursor);
  else deleteProfile(agCursor);
});

$('#ag-list') && $('#ag-list').addEventListener('click', onAgListClick);
$('#ag-list') && $('#ag-list').addEventListener('pointermove', (e) => {
  if (e.currentTarget.dataset.nav) delete e.currentTarget.dataset.nav;
});
$('#ag-list') && $('#ag-list').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.ag-row');
  if (row && !e.target.closest('.ag-pin, .ag-act-btn')) openAgentModal(row.dataset.id);
});
$('#ag-list') && $('#ag-list').addEventListener('focusin', (e) => {
  const row = e.target.closest('.ag-row');
  if (row && row.dataset.id !== agCursor) { agCursor = row.dataset.id; agSyncCursor(); }
});
window.addEventListener('keydown', agKeydown);

// Import agents already on disk, from every installed tool's agents directory.
async function openAgentsImportModal() {
  const modal = $('#agents-import-modal');
  const listEl = $('#ai-list');
  const confirmBtn = $('#ai-confirm');
  if (!modal || !listEl) return;
  // eslint-disable-next-line no-unsanitized/property -- static placeholder
  listEl.innerHTML = `<div class="ai-empty">Loading...</div>`;
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Import'; }
  if ($('#ai-activate-after')) $('#ai-activate-after').checked = true;
  modal.hidden = false;

  const res = await window.husk.profiles.listImportableAgents();
  if (!res || !res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- error from local fs read, no html
    listEl.innerHTML = `<div class="ai-empty">${escapeHtml((res && res.error) || 'Could not read agents')}</div>`;
    return;
  }
  if (!res.agents.length) {
    // eslint-disable-next-line no-unsanitized/property -- static html
    listEl.innerHTML = `<div class="ai-empty">No agents found on this machine.</div>`;
    return;
  }
  const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
  // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
  listEl.innerHTML = res.agents.map((a) => {
    if (a.alreadyImported) {
      return `
      <div class="ai-row-done">
        <span class="ai-check-box-done" aria-hidden="true">${checkIcon}</span>
        <div class="ai-row-body">
          <div class="ai-row-name">${escapeHtml(a.name)}<span class="ai-row-source">${escapeHtml(a.source)}</span></div>
          ${a.description ? `<div class="ai-row-desc">${escapeHtml(a.description)}</div>` : ''}
        </div>
        <span class="ai-row-pill">Already added</span>
      </div>
    `;
    }
    return `
      <label class="ai-row">
        <input type="checkbox" class="ai-check" data-source="${escapeAttr(a.source)}" data-file="${escapeAttr(a.filename)}" />
        <span class="ai-check-box" aria-hidden="true"></span>
        <div class="ai-row-body">
          <div class="ai-row-name">${escapeHtml(a.name)}<span class="ai-row-source">${escapeHtml(a.source)}</span></div>
          ${a.description ? `<div class="ai-row-desc">${escapeHtml(a.description)}</div>` : ''}
        </div>
      </label>
    `;
  }).join('');

  // With nothing ticked the button names the action, not a count of nothing.
  const updateCount = () => {
    const n = listEl.querySelectorAll('.ai-check:checked').length;
    if (!confirmBtn) return;
    confirmBtn.disabled = n === 0;
    confirmBtn.textContent = n === 0 ? 'Import' : `Import ${n} agent${n !== 1 ? 's' : ''}`;
  };
  listEl.querySelectorAll('.ai-check').forEach((el) => el.addEventListener('change', updateCount));
  const setAll = (checked) => {
    listEl.querySelectorAll('.ai-check').forEach((el) => { el.checked = checked; });
    updateCount();
  };
  const selAll = $('#ai-select-all');
  const deselAll = $('#ai-deselect-all');
  if (selAll) selAll.onclick = () => setAll(true);
  if (deselAll) deselAll.onclick = () => setAll(false);
  updateCount();
}

function closeAgentsImportModal() {
  const m = $('#agents-import-modal');
  if (m) m.hidden = true;
}

async function confirmAgentsImport() {
  const listEl = $('#ai-list');
  if (!listEl) return;
  const picks = Array.from(listEl.querySelectorAll('.ai-check:checked'))
    .filter((el) => el.dataset.source)
    .map((el) => ({ source: el.dataset.source, filename: el.dataset.file }));
  if (!picks.length) return;
  const btn = $('#ai-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
  const activate = !!($('#ai-activate-after') && $('#ai-activate-after').checked);
  const res = await window.husk.profiles.importAgents(picks, activate);
  if (!res || !res.ok) { toast((res && res.error) || 'Import failed', 'error'); if (btn) btn.disabled = false; return; }
  toast(`Imported ${res.imported} agent${res.imported !== 1 ? 's' : ''}${activate ? ' and pinned' : ''}`, 'success');
  closeAgentsImportModal();
  profilesCache = await window.husk.profiles.list();
  if (activate) cfg = await window.husk.config.get();
  paintAgents();
  updateActiveChatProfile();
}

$('#btn-import-agents') && $('#btn-import-agents').addEventListener('click', openAgentsImportModal);
$('#ai-close') && $('#ai-close').addEventListener('click', closeAgentsImportModal);
$('#ai-cancel') && $('#ai-cancel').addEventListener('click', closeAgentsImportModal);
$('#ai-confirm') && $('#ai-confirm').addEventListener('click', confirmAgentsImport);
$('#agents-import-modal') && $('#agents-import-modal').addEventListener('click', (e) => { if (e.target === $('#agents-import-modal')) closeAgentsImportModal(); });

// ─── Install agents from a repo (local folder or https URL) ─────────────────────
// The repo ships agents/*.md with markdown frontmatter, and optionally
// skills/*.md. Husk writes each picked agent into every installed tool's agents
// directory and stamps the profile with repoRoot, which spawnPty uses as the
// cwd so the agent's relative skills reads resolve.
let lastRepoScan = null;
// Two entry points share the scan/install flow below: a GitHub URL row and a
// local folder row. Picking a source reveals its row; local also opens the
// folder picker right away.
function setRepoSource(src) {
  $('#ra-src-github')?.classList.toggle('selected', src === 'github');
  $('#ra-src-local')?.classList.toggle('selected', src === 'local');
  const gh = $('#ra-row-github');
  const lo = $('#ra-row-local');
  if (gh) gh.hidden = src !== 'github';
  if (lo) lo.hidden = src !== 'local';
}
function openRepoAgentsModal() {
  const modal = $('#repo-agents-modal');
  if (!modal) return;
  if ($('#ra-root')) $('#ra-root').value = '';
  if ($('#ra-url')) $('#ra-url').value = '';
  setRepoSource(null);
  if ($('#ra-list')) $('#ra-list').innerHTML = '';
  const status = $('#ra-status');
  if (status) { status.hidden = true; status.textContent = ''; status.className = 'ra-status'; }
  const confirmBtn = $('#ra-confirm');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Install'; }
  if ($('#ra-install-all')) $('#ra-install-all').checked = true;
  if ($('#ra-activate')) $('#ra-activate').checked = true;
  lastRepoScan = null;
  modal.hidden = false;
}
function closeRepoAgentsModal() {
  const m = $('#repo-agents-modal');
  if (m) m.hidden = true;
}
function setRepoStatus(text, kind) {
  const el = $('#ra-status');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; el.className = 'ra-status'; return; }
  el.hidden = false;
  el.className = 'ra-status' + (kind ? ' ra-status-' + kind : '');
  if (kind === 'error') {
    el.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'ra-status-icon';
    // eslint-disable-next-line no-unsanitized/property -- static SVG
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
    const msg = document.createElement('span');
    msg.textContent = text;
    el.appendChild(icon);
    el.appendChild(msg);
    return;
  }
  el.textContent = text;
}
async function browseForRepoRoot() {
  const picked = await window.husk.repoAgents.pickDir();
  if (!picked) return;
  if ($('#ra-root')) $('#ra-root').value = picked;
  await scanRepoRoot(picked);
}
async function scanRepoRoot(root) {
  const listEl = $('#ra-list');
  const confirmBtn = $('#ra-confirm');
  if (!listEl || !confirmBtn) return;
  const isUrl = /^https?:\/\//i.test(String(root || '').trim());
  setRepoStatus(isUrl ? 'Cloning repository…' : 'Scanning…');
  // eslint-disable-next-line no-unsanitized/property -- static loading placeholder
  listEl.innerHTML = `<div class="ai-empty">Looking for agents/*.md…</div>`;
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Install';
  const res = await window.husk.repoAgents.scan(root);
  if (!res || !res.ok) {
    setRepoStatus(res && res.error ? res.error : 'Scan failed. Try again.', 'error');
    listEl.innerHTML = '';
    lastRepoScan = null;
    return;
  }
  lastRepoScan = res;
  const skillsNote = res.hasSkillsDir
    ? `Found a <code>skills/</code> directory. Agents that read <code>skills/&lt;id&gt;/SKILL.md</code> will work after install.`
    : `No <code>skills/</code> directory at this root. Agents will install but any <code>skills/</code> read will fail until you add one.`;
  const installNote = `Imported agents are added to every detected AI tool's own agent folder. No tool-specific files are written.`;
  setRepoStatus('');
  const statusEl = $('#ra-status');
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = 'ra-status ra-status-info';
    // eslint-disable-next-line no-unsanitized/property -- static + escapeHtml above
    statusEl.innerHTML = `<div>${skillsNote}</div><div>${installNote}</div>`;
  }
  if (!res.agents.length) {
    // eslint-disable-next-line no-unsanitized/property -- static html
    listEl.innerHTML = `<div class="ai-empty">No <code>agents/*.md</code> files in that folder.</div>`;
    return;
  }
  const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
  // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
  listEl.innerHTML = res.agents.map((a) => {
    const pill = a.alreadyImported
      ? `<span class="ai-row-pill">Already imported</span>`
      : (a.alreadyInClaude ? '<span class="ai-row-source">already installed</span>' : '');
    if (a.alreadyImported) {
      return `
        <div class="ai-row-done">
          <span class="ai-check-box-done" aria-hidden="true">${checkIcon}</span>
          <div class="ai-row-body">
            <div class="ai-row-name">${escapeHtml(a.name)}<span class="ai-row-source">${escapeHtml(a.filename)}</span></div>
            ${a.description ? `<div class="ai-row-desc">${escapeHtml(a.description)}</div>` : ''}
          </div>
          ${pill}
        </div>
      `;
    }
    return `
      <label class="ai-row">
        <input type="checkbox" class="ai-check ra-pick" data-file="${escapeAttr(a.filename)}" />
        <span class="ai-check-box" aria-hidden="true"></span>
        <div class="ai-row-body">
          <div class="ai-row-name">${escapeHtml(a.name)}<span class="ai-row-source">${escapeHtml(a.filename)}</span></div>
          ${a.description ? `<div class="ai-row-desc">${escapeHtml(a.description)}</div>` : ''}
        </div>
        ${pill}
      </label>
    `;
  }).join('');
  // With nothing ticked the button names the action, not a count of nothing.
  const updateCount = () => {
    const n = listEl.querySelectorAll('.ra-pick:checked').length;
    confirmBtn.disabled = n === 0;
    confirmBtn.textContent = n === 0 ? 'Install' : `Install ${n} agent${n !== 1 ? 's' : ''}`;
  };
  listEl.querySelectorAll('.ra-pick').forEach((el) => el.addEventListener('change', updateCount));
  const tools = $('#ra-list-tools');
  if (tools) tools.hidden = !listEl.querySelector('.ra-pick');
  const setAll = (checked) => {
    listEl.querySelectorAll('.ra-pick').forEach((el) => { el.checked = checked; });
    updateCount();
  };
  if ($('#ra-select-all')) $('#ra-select-all').onclick = () => setAll(true);
  if ($('#ra-deselect-all')) $('#ra-deselect-all').onclick = () => setAll(false);
  updateCount();
}
async function confirmRepoAgentsInstall() {
  if (!lastRepoScan || !lastRepoScan.ok) return;
  const root = lastRepoScan.root;
  const listEl = $('#ra-list');
  if (!listEl) return;
  const picks = Array.from(listEl.querySelectorAll('.ra-pick:checked')).map((el) => ({ filename: el.dataset.file }));
  if (!picks.length) return;
  const btn = $('#ra-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  const installToAllAgents = !!($('#ra-install-all') && $('#ra-install-all').checked);
  const activate = !!($('#ra-activate') && $('#ra-activate').checked);
  const res = await window.husk.repoAgents.install({
    root, picks, installToAllAgents, activate,
  });
  if (!res || !res.ok) {
    toast((res && res.error) || 'Install failed', 'error');
    if (btn) btn.disabled = false;
    return;
  }
  {
    const parts = [`Installed ${res.imported} agent${res.imported !== 1 ? 's' : ''}`];
    if (installToAllAgents && res.distributedTo && res.distributedTo.length) parts.push('synced to every AI tool');
    if (activate) parts.push('pinned');
    toast(parts.join(' · '), 'success');
    // Files left alone because the user already had one by that name, called
    // out separately from the success line.
    const skipped = Array.isArray(res.skippedExisting) ? res.skippedExisting : [];
    if (skipped.length) {
      const shown = skipped.slice(0, 3).join(', ');
      const rest = skipped.length > 3 ? `, and ${skipped.length - 3} more` : '';
      toast(`Kept your existing ${shown}${rest}. The repo's version was not written.`, 'error');
    }
  }
  closeRepoAgentsModal();
  profilesCache = await window.husk.profiles.list();
  if (activate) cfg = await window.husk.config.get();
  paintAgents();
  updateActiveChatProfile();
}
$('#btn-install-from-repo') && $('#btn-install-from-repo').addEventListener('click', openRepoAgentsModal);
$('#ra-close') && $('#ra-close').addEventListener('click', closeRepoAgentsModal);
$('#ra-cancel') && $('#ra-cancel').addEventListener('click', closeRepoAgentsModal);
$('#ra-src-github') && $('#ra-src-github').addEventListener('click', () => {
  setRepoSource('github');
  setTimeout(() => { try { $('#ra-url').focus(); } catch (_) {} }, 0);
});
$('#ra-src-local') && $('#ra-src-local').addEventListener('click', () => {
  setRepoSource('local');
  browseForRepoRoot();
});
$('#ra-browse') && $('#ra-browse').addEventListener('click', browseForRepoRoot);
$('#ra-confirm') && $('#ra-confirm').addEventListener('click', confirmRepoAgentsInstall);
const scanRepoUrlInput = () => {
  let v = ($('#ra-url').value || '').trim();
  if (!v) { setRepoStatus('Enter a repository URL first.', 'error'); return; }
  // A pasted "github.com/dev/repo" is clearly a URL; fill in the scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v;
  scanRepoRoot(v);
};
$('#ra-fetch') && $('#ra-fetch').addEventListener('click', scanRepoUrlInput);
$('#ra-url') && $('#ra-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); scanRepoUrlInput(); }
});
$('#ra-root') && $('#ra-root').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = ($('#ra-root').value || '').trim();
    if (v) scanRepoRoot(v);
    else setRepoStatus('Enter a folder path first.', 'error');
  }
});
$('#repo-agents-modal') && $('#repo-agents-modal').addEventListener('click', (e) => { if (e.target === $('#repo-agents-modal')) closeRepoAgentsModal(); });

// ─── Install MCP servers from a cloned repo ───────────────────────────────────
// Sibling of the agent install flow. Three views inside a single modal:
//   1) "list":    picker for repo path + scanned servers
//   2) "detail":  env-var form + per-CLI target checkboxes for one server
//   3) "results": per-CLI status pills + copy-able snippets for codex/aider
// Each view replaces the modal body, the foot button changes role between
// Install / Back / Done so the user always knows what to press next.
let rmScan = null;
let rmPicked = null;
// Two ways in. The modal opens with both offered and no row revealed, so it
// asks which kind of repository this is first.
function setMcpRepoSource(src) {
  const gh = $('#rm-src-github');
  const lo = $('#rm-src-local');
  if (gh) gh.classList.toggle('selected', src === 'github');
  if (lo) lo.classList.toggle('selected', src === 'local');
  const ghRow = $('#rm-row-github');
  const loRow = $('#rm-row-local');
  if (ghRow) ghRow.hidden = src !== 'github';
  if (loRow) loRow.hidden = src !== 'local';
}
function openRepoMcpModal() {
  const m = $('#repo-mcp-modal');
  if (!m) return;
  rmScan = null;
  rmPicked = null;
  if ($('#rm-root')) $('#rm-root').value = '';
  if ($('#rm-url')) $('#rm-url').value = '';
  setMcpRepoSource(null);
  const list = $('#rm-list');
  if (list) list.replaceChildren();
  rmSetView('list');
  rmStatus('');
  m.hidden = false;
}
function closeRepoMcpModal() { const m = $('#repo-mcp-modal'); if (m) m.hidden = true; }
function rmStatus(text, kind) {
  const el = $('#rm-status'); if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; el.className = 'ra-status'; return; }
  el.hidden = false; el.className = 'ra-status' + (kind ? ' ra-status-' + kind : '');
  el.textContent = text;
}
function rmSetView(view) {
  const list = $('#rm-list'); const detail = $('#rm-detail'); const results = $('#rm-results');
  const installBtn = $('#rm-install'); const cancelBtn = $('#rm-cancel');
  if (list) list.hidden = view !== 'list';
  if (detail) detail.hidden = view !== 'detail';
  if (results) results.hidden = view !== 'results';
  if (installBtn) {
    installBtn.disabled = true;
    installBtn.textContent = view === 'detail' ? 'Install' : (view === 'list' ? 'Next' : 'Done');
    installBtn.onclick = view === 'detail' ? rmDoInstall : (view === 'list' ? rmAdvanceToDetail : closeRepoMcpModal);
    if (view === 'results') installBtn.disabled = false;
  }
  if (cancelBtn) cancelBtn.textContent = view === 'list' ? 'Close' : 'Back';
  cancelBtn.onclick = view === 'list' ? closeRepoMcpModal : () => rmSetView(view === 'detail' ? 'list' : 'detail');
}
async function rmBrowse() {
  const picked = await window.husk.repoMcp.pickDir();
  if (!picked) return;
  if ($('#rm-root')) $('#rm-root').value = picked;
  await rmScanRoot(picked);
}
async function rmScanRoot(root) {
  const list = $('#rm-list'); if (!list) return;
  // A URL is fetched before it can be read, and that is the slow half. Saying
  // "scanning" through a clone describes the wrong wait.
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(root || ''));
  rmStatus(isUrl ? 'Cloning the repository…' : 'Scanning…');
  // eslint-disable-next-line no-unsanitized/property -- static loading copy
  list.innerHTML = isUrl
    ? '<div class="ai-empty">Fetching the repository, then looking for mcp-servers/*…</div>'
    : '<div class="ai-empty">Looking for mcp-servers/*…</div>';
  const res = await window.husk.repoMcp.scan(root);
  if (!res || !res.ok) {
    rmStatus((res && res.error) || 'Scan failed', 'error');
    // eslint-disable-next-line no-unsanitized/property -- escapeHtml below
    list.innerHTML = `<div class="ai-empty">${escapeHtml((res && res.error) || 'Could not scan that folder')}</div>`;
    rmScan = null; return;
  }
  rmScan = res;
  if (!res.hasServersDir) {
    // eslint-disable-next-line no-unsanitized/property -- static html
    list.innerHTML = '<div class="ai-empty">No <code>mcp-servers/</code> directory at that path.</div>';
    rmStatus('');
    return;
  }
  if (!res.servers.length) {
    // eslint-disable-next-line no-unsanitized/property -- static html
    list.innerHTML = '<div class="ai-empty">The <code>mcp-servers/</code> dir exists but contains no subfolders.</div>';
    rmStatus('');
    return;
  }
  rmStatus(res.truncated
    ? `Showing first ${res.servers.length} of ${res.totalFound} servers. Narrow the repo if you need more.`
    : `Found ${res.servers.length} server${res.servers.length !== 1 ? 's' : ''}.`, 'info');
  // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
  list.innerHTML = res.servers.map((s, i) => {
    const pillBits = [];
    if (!s.installable) pillBits.push('<span class="ai-row-pill">not installable</span>');
    if (s.needsBuild) pillBits.push('<span class="ai-row-pill">needs build</span>');
    if (s.mainExists) pillBits.push('<span class="ai-row-pill">ready</span>');
    return `
      <label class="ai-row${s.installable ? '' : ' is-duplicate'}">
        <input type="radio" name="rm-pick" class="ai-check rm-pick" data-idx="${i}" ${s.installable ? '' : 'disabled'} />
        <span class="ai-check-box" aria-hidden="true"></span>
        <div class="ai-row-body">
          <div class="ai-row-name">${escapeHtml(s.displayName)}<span class="ai-row-source">${escapeHtml(s.name)}</span></div>
          ${s.description ? `<div class="ai-row-desc">${escapeHtml(s.description)}</div>` : ''}
        </div>
        ${pillBits.join('')}
      </label>
    `;
  }).join('');
  list.querySelectorAll('.rm-pick').forEach((el) => el.addEventListener('change', () => {
    const i = Number(el.dataset.idx);
    rmPicked = (rmScan && Array.isArray(rmScan.servers)) ? rmScan.servers[i] : null;
    const btn = $('#rm-install'); if (btn) btn.disabled = !rmPicked;
  }));
}
function rmAdvanceToDetail() {
  if (!rmPicked) return;
  const detail = $('#rm-detail'); if (!detail) return;
  const envFields = (rmPicked.envVars || []).map((e) => {
    const safeId = 'rm-env-' + e.key.replace(/[^a-zA-Z0-9_-]/g, '');
    return `
      <label class="pref-row" style="flex-direction:column; align-items:stretch; gap:4px;">
        <span class="pref-label" style="font-family:'JetBrains Mono', monospace; font-size: 12px;">${escapeHtml(e.key)}</span>
        <input type="text" data-env="${escapeAttr(e.key)}" id="${escapeAttr(safeId)}" placeholder="${escapeAttr(e.hint || '')}" spellcheck="false" autocomplete="off" />
      </label>
    `;
  }).join('') || '<div class="ai-empty" style="padding:10px 0;">No environment variables declared.</div>';
  const targets = [
    { id: 'claude', label: 'Claude Code', sub: 'writes ~/.claude.json', write: true },
    { id: 'copilot', label: 'GitHub Copilot CLI', sub: 'writes ~/.copilot/mcp-config.json', write: true },
    { id: 'gemini', label: 'Gemini CLI', sub: 'writes ~/.gemini/settings.json', write: true },
    { id: 'codex', label: 'Codex CLI', sub: 'shows TOML snippet to paste into ~/.codex/config.toml', write: false },
    { id: 'aider', label: 'Aider', sub: 'shows --mcp flag snippet to paste into your aider invocation', write: false },
    { id: 'kiro-cli', label: 'Kiro CLI', sub: 'shows kiro-cli mcp add command to run after login', write: false },
  ];
  // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
  detail.innerHTML = `
    <div class="ra-status ra-status-info"><strong>${escapeHtml(rmPicked.displayName)}</strong> · <code>${escapeHtml(rmPicked.dir)}</code></div>
    ${rmPicked.needsBuild ? `
      <label class="ai-foot-toggle" title="Run npm install and the repository's own build script before installing">
        <input type="checkbox" id="rm-build" class="ai-check" />
        <span class="ai-check-box" aria-hidden="true"></span>
        Run npm install + npm run build first (the server's <code>dist/</code> is missing)
      </label>
      <div class="ra-status ra-status-warn" style="margin-top:6px;">
        This runs the repository's own <code>build</code> script as a shell command on your machine, as you. Install hooks are already blocked with <code>--ignore-scripts</code>; the build script is not, because building is what it is for. Leave this off unless you trust the repository, and read the script first.
      </div>
    ` : ''}
    <div class="modal-section">
      <div class="modal-label">Environment variables</div>
      ${envFields}
    </div>
    <div class="modal-section">
      <div class="modal-label">Install into</div>
      ${targets.map((t) => `
        <label class="ai-foot-toggle" title="${escapeAttr(t.sub)}">
          <input type="checkbox" class="ai-check rm-target" data-target="${escapeAttr(t.id)}" ${t.write ? 'checked' : ''} />
          <span class="ai-check-box" aria-hidden="true"></span>
          ${escapeHtml(t.label)} <span class="ai-row-source">${escapeHtml(t.sub)}</span>
        </label>
      `).join('')}
    </div>
  `;
  rmSetView('detail');
  const updateBtn = () => {
    const picked = $$('#rm-detail .rm-target:checked').length;
    const btn = $('#rm-install'); if (btn) btn.disabled = picked === 0;
  };
  $$('#rm-detail .rm-target').forEach((el) => el.addEventListener('change', updateBtn));
  updateBtn();
}
async function rmDoInstall() {
  if (!rmPicked) return;
  const targets = $$('#rm-detail .rm-target:checked').map((el) => el.dataset.target);
  if (!targets.length) return;
  const envValues = {};
  $$('#rm-detail input[data-env]').forEach((el) => { envValues[el.dataset.env] = el.value; });
  const btn = $('#rm-install'); if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  const shouldBuild = rmPicked.needsBuild && $('#rm-build') && $('#rm-build').checked;
  rmStatus(shouldBuild ? 'Running npm install + build…' : 'Installing…', 'info');
  if (shouldBuild) {
    const br = await window.husk.repoMcp.build(rmPicked.dir);
    if (!br || !br.ok) {
      const lastStage = br && Array.isArray(br.stages) ? br.stages[br.stages.length - 1] : null;
      rmStatus((lastStage && lastStage.error) ? `Build failed: ${lastStage.error}` : 'Build failed', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
      return;
    }
  }
  const res = await window.husk.repoMcp.install({
    server: rmPicked,
    envValues,
    targets,
    serverId: (rmPicked.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
  });
  if (!res || !res.ok) {
    rmStatus((res && res.error) || 'Install failed', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
    return;
  }
  rmRenderResults(res);
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
}
function rmRenderResults(res) {
  const wrap = $('#rm-results'); if (!wrap) return;
  rmStatus('');
  const rows = Object.keys(res.results || {}).map((target) => {
    const r = res.results[target] || {};
    let body = '';
    let pill = '';
    if (r.status === 'installed') { pill = 'Installed'; body = `<div class="ai-row-desc">wrote to <code>${escapeHtml(r.configPath || '')}</code></div>`; }
    else if (r.status === 'exists') { pill = 'Already installed'; body = `<div class="ai-row-desc">entry already in <code>${escapeHtml(r.configPath || '')}</code>; remove it first if you want to replace</div>`; }
    else if (r.status === 'snippet') {
      pill = 'Snippet';
      body = `<pre class="ai-row-snippet" style="white-space:pre-wrap; font-family:'JetBrains Mono', monospace; font-size: 11.5px; background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--radius-md); padding: 8px 10px; margin: 6px 0 0;">${escapeHtml(r.snippet || '')}</pre><div style="margin-top:6px;"><button class="ghost-btn rm-copy" data-text="${escapeAttr(r.snippet || '')}">Copy</button></div>`;
    } else { pill = 'Error'; body = `<div class="ai-row-desc">${escapeHtml(r.error || 'unknown error')}</div>`; }
    return `
      <div class="ai-row" style="cursor:default;">
        <div class="ai-row-body">
          <div class="ai-row-name">${escapeHtml(target)}<span class="ai-row-source">${escapeHtml(res.serverId || '')}</span></div>
          ${body}
        </div>
        <span class="ai-row-pill">${escapeHtml(pill)}</span>
      </div>`;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property -- escapeHtml above for every dynamic value
  wrap.innerHTML = `<div class="ai-list">${rows}</div>`;
  wrap.querySelectorAll('.rm-copy').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.text || ''); toast('Snippet copied', 'success'); } catch (_) {}
  }));
  rmSetView('results');
}
$('#btn-mcp-install-from-repo') && $('#btn-mcp-install-from-repo').addEventListener('click', openRepoMcpModal);
$('#rm-close') && $('#rm-close').addEventListener('click', closeRepoMcpModal);
$('#rm-browse') && $('#rm-browse').addEventListener('click', rmBrowse);
$('#rm-src-github') && $('#rm-src-github').addEventListener('click', () => {
  setMcpRepoSource('github');
  setTimeout(() => { try { $('#rm-url').focus(); } catch (_) {} }, 0);
});
$('#rm-src-local') && $('#rm-src-local').addEventListener('click', () => {
  setMcpRepoSource('local');
  rmBrowse();
});
// A pasted "github.com/dev/repo" gets the scheme filled in. Anything else is
// handed over as typed, so the main process stays the single validator.
const rmScanUrlInput = () => {
  let v = (($('#rm-url') || {}).value || '').trim();
  if (!v) { rmStatus('Enter a repository URL first.', 'error'); return; }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'https://' + v;
  rmScanRoot(v);
};
$('#rm-fetch') && $('#rm-fetch').addEventListener('click', rmScanUrlInput);
$('#rm-url') && $('#rm-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); rmScanUrlInput(); }
});
$('#rm-root') && $('#rm-root').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = (($('#rm-root') || {}).value || '').trim();
    if (v) rmScanRoot(v);
  }
});
$('#rm-root') && $('#rm-root').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); const v = ($('#rm-root').value || '').trim(); if (v) rmScanRoot(v); }
});
$('#repo-mcp-modal') && $('#repo-mcp-modal').addEventListener('click', (e) => { if (e.target === $('#repo-mcp-modal')) closeRepoMcpModal(); });
$('#agent-modal-close') && $('#agent-modal-close').addEventListener('click', closeAgentModal);
$('#agent-modal-cancel') && $('#agent-modal-cancel').addEventListener('click', closeAgentModal);
$('#agent-modal-save') && $('#agent-modal-save').addEventListener('click', saveAgentModal);
$('#agent-modal-delete') && $('#agent-modal-delete').addEventListener('click', () => {
  const id = editingProfileId;
  closeAgentModal();
  if (id) deleteProfile(id);
});
$('#agent-modal-duplicate') && $('#agent-modal-duplicate').addEventListener('click', () => {
  const id = editingProfileId;
  closeAgentModal();
  if (id) agDuplicate(id);
});
$('#agent-source-reveal') && $('#agent-source-reveal').addEventListener('click', () => {
  const p = profilesCache.find((x) => x.id === editingProfileId);
  if (p && p.repoRoot) window.husk.fs.open(p.repoRoot);
});
$('#agent-name') && $('#agent-name').addEventListener('input', () => $('#agent-name').classList.remove('field-invalid'));
for (const sel of AG_CAPS) {
  const el = $(sel);
  if (el) el.addEventListener('input', () => agSyncCounter(sel));
}
$('#agent-modal') && $('#agent-modal').addEventListener('click', (e) => { if (e.target === $('#agent-modal')) closeAgentModal(); });
$('#agent-modal') && $('#agent-modal').addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return;
  const save = $('#agent-modal-save');
  if (!save || save.hidden) return;
  e.preventDefault();
  saveAgentModal();
});
$('#btn-generate-agent') && $('#btn-generate-agent').addEventListener('click', generateAgentWithAI);
$('#btn-generate-cancel') && $('#btn-generate-cancel').addEventListener('click', () => {
  agGenSeq++;
  agResetGenButtons();
});
$('#btn-generate-cancel') && $('#btn-generate-cancel').setAttribute('title', 'Stop waiting for the draft');
$('#agent-generate-desc') && $('#agent-generate-desc').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); generateAgentWithAI(); }
});

// ─── Prompts page ──────────────────────────────────────────────────────────────
let promptsCache = [];
// The row the right pane is showing, and the bodies already pulled off disk.
// Filtering re-renders the whole pane, so the cache is what keeps typing in
// the search field from re-reading files on every keystroke.
let selectedPromptMd = '';
const promptBodyCache = new Map();

const PR_TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
const PR_PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const PR_PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const PR_ARROW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>';

async function renderPrompts() {
  const pane = $('#prompts-pane');
  if (!pane) return;
  pane.classList.add('is-empty');
  // eslint-disable-next-line no-unsanitized/property -- Static loading template.
  pane.innerHTML = '<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">Loading prompts…</div></div>';
  const res = await window.husk.prompts.list();
  if (!res.ok) {
    pane.classList.add('is-empty');
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    pane.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${escapeHtml(res.error || 'Unknown error')}</div></div>`;
    return;
  }
  promptsCache = res.prompts || [];
  promptBodyCache.clear();
  paintPrompts(promptsCache, ($('#prompts-search') || {}).value || '');
}

// A prompt file name has to be lowercase letters, digits and dashes, so a
// search term seeded into the composer gets folded into that shape first.
function promptSlug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
}

// Line numbers for the prompt editor. The body wraps, so each number is given
// the height its own line renders at, measured in a mirror element that copies
// the textarea's width, font and padding. Wrapped continuation rows get blank
// space, exactly as an editor shows them.
let prMirror = null;
function syncPromptGutter() {
  const ta = document.querySelector('#prompts-pane .pr-body-edit');
  const gutter = document.querySelector('#prompts-pane .pr-gutter');
  if (!ta || !gutter) return;
  const cs = getComputedStyle(ta);
  if (!prMirror) {
    // A textarea, not a div, since the two do not break lines identically.
    prMirror = document.createElement('textarea');
    prMirror.readOnly = true;
    prMirror.tabIndex = -1;
    prMirror.setAttribute('aria-hidden', 'true');
    prMirror.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;'
      + 'top:0;left:-9999px;overflow:hidden;resize:none;border:0;height:0;min-height:0;';
    document.body.appendChild(prMirror);
  }
  // Copy every property that changes where a line breaks. Missing one here
  // means the mirror wraps at a different column than the textarea does.
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
    'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize', 'paddingLeft', 'paddingRight',
    'textIndent', 'boxSizing']) {
    prMirror.style[prop] = cs[prop];
  }
  prMirror.style.paddingTop = '0px';
  prMirror.style.paddingBottom = '0px';
  prMirror.style.width = ta.clientWidth + 'px';
  // The exact, unrounded line box. Everything below is a multiple of it.
  const lineH = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.5);
  const src = ta.value;
  const rows = src.split('\n');
  const frag = document.createDocumentFragment();
  for (let n = 0; n < rows.length; n += 1) {
    // An empty line still occupies one row, and a lone newline measures zero
    // without a placeholder, so the gutter would collapse against the text.
    prMirror.value = rows[n].length ? rows[n] : ' ';
    // scrollHeight is an integer, so count rows instead and lay them out at
    // the exact fractional line height the text uses.
    const rowCount = Math.max(1, Math.round(prMirror.scrollHeight / lineH));
    const cell = document.createElement('div');
    cell.className = 'pr-gutter-n';
    cell.style.height = (rowCount * lineH) + 'px';
    cell.textContent = String(n + 1);
    frag.appendChild(cell);
  }
  gutter.replaceChildren(frag);
  gutter.style.paddingTop = cs.paddingTop;
  gutter.scrollTop = ta.scrollTop;
}

// The gutter scrolls with the text rather than having its own scrollbar.
function bindPromptGutter() {
  const ta = document.querySelector('#prompts-pane .pr-body-edit');
  const gutter = document.querySelector('#prompts-pane .pr-gutter');
  if (!ta || !gutter || ta.dataset.gutterBound === '1') return;
  ta.dataset.gutterBound = '1';
  ta.addEventListener('input', syncPromptGutter);
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  // A pane resize changes where lines wrap, so the measured heights change.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => syncPromptGutter());
    ro.observe(ta);
  }
  syncPromptGutter();
}

function openPromptComposer(seedName) {
  const btn = document.getElementById('btn-prompts-new');
  if (!btn) return;
  btn.click();
  const nameEl = document.getElementById('np-name');
  if (nameEl && seedName) nameEl.value = seedName;
}

// The prompt being edited in the detail pane, or null when it is being read.
// Editing happens in place, where the prompt is already shown.
let editingPromptPath = null;

// Enter edit mode on the open prompt. The body has to be on hand before the
// repaint so the textarea is never briefly empty over real content.
async function beginPromptEdit(prompt) {
  if (!prompt) return;
  if (!promptBodyCache.has(prompt.mdPath)) await fillPromptBody(prompt.mdPath);
  editingPromptPath = prompt.mdPath;
  paintPrompts(promptsCache, ($('#prompts-search') || {}).value || '');
  const body = $('#prompts-pane .pr-body-edit');
  if (body) { body.focus(); body.setSelectionRange(body.value.length, body.value.length); }
}

function cancelPromptEdit() {
  editingPromptPath = null;
  paintPrompts(promptsCache, ($('#prompts-search') || {}).value || '');
}

// Frontmatter is the file's bookkeeping and has its own fields, so the editor
// shows the prompt itself rather than the header it was stored behind.
function stripPromptFrontmatter(text) {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(String(text || ''));
  return (m ? String(text).slice(m[0].length) : String(text || '')).replace(/^\n+/, '');
}

async function savePromptEdit(original) {
  const nameEl = $('#pr-edit-name');
  const descEl = $('#pr-edit-desc');
  const bodyEl = $('#prompts-pane .pr-body-edit');
  if (!nameEl || !descEl || !bodyEl) return;
  const name = nameEl.value.trim();
  const description = descEl.value.trim();
  const invalid = (el, msg) => { el.classList.add('field-invalid'); el.focus(); toast(msg, 'error'); };
  [nameEl, descEl].forEach((el) => el.classList.remove('field-invalid'));
  if (!name) return invalid(nameEl, 'Name is required');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return invalid(nameEl, 'Name must be lowercase letters, digits, dashes; start with a letter.');
  }
  if (!description) return invalid(descEl, 'Description is required');

  const res = await window.husk.prompts.update({
    mdPath: original.mdPath, name, description, content: bodyEl.value,
  });
  if (!res || !res.ok) { toast((res && res.error) || 'Could not save prompt', 'error'); return; }
  // A rename moves the file, so the selection follows it rather than falling
  // back to whichever prompt happens to sort first.
  promptBodyCache.delete(original.mdPath);
  if (res.mdPath) selectedPromptMd = res.mdPath;
  editingPromptPath = null;
  toast(`Saved ${name}`, 'success');
  await renderPrompts();
}


function paintPrompts(items, filter) {
  const pane = $('#prompts-pane');
  if (!pane) return;
  const q = (filter || '').toLowerCase().trim();
  const filtered = q
    ? items.filter((p) => (p.name + ' ' + (p.description || '')).toLowerCase().includes(q))
    : items;

  if (!filtered.length) {
    const seed = q ? promptSlug(q) : '';
    const head = q ? `No prompt matches “${escapeHtml(q)}”` : 'No prompts yet';
    const sub = q
      ? 'Nothing in the library uses that word. Write it instead and it saves to disk as markdown.'
      : 'Prompts are markdown files in ~/.config/husk/prompts/. Write one here, or drop a file in that folder and refresh.';
    const cta = seed
      ? `Create “${escapeHtml(seed)}”`
      : (items.length ? 'Create a prompt' : 'Create your first prompt');
    pane.classList.add('is-empty');
    // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml above.
    pane.innerHTML = `<div class="empty-state">
        <div class="es-icon">⌬</div>
        <div class="es-msg">${head}</div>
        <div class="pr-empty-sub">${sub}</div>
        <button class="pr-run pr-empty-cta" type="button">${PR_PLUS_SVG}${cta}</button>
      </div>`;
    const ctaBtn = pane.querySelector('.pr-empty-cta');
    if (ctaBtn) ctaBtn.addEventListener('click', () => openPromptComposer(seed));
    return;
  }

  pane.classList.remove('is-empty');
  if (!filtered.some((p) => p.mdPath === selectedPromptMd)) selectedPromptMd = filtered[0].mdPath;
  const active = filtered.find((p) => p.mdPath === selectedPromptMd) || filtered[0];
  const editing = editingPromptPath === active.mdPath;

  const rows = filtered.map((p) => {
    const isActive = p.mdPath === selectedPromptMd;
    return `<div class="pr-item${isActive ? ' is-active' : ''}${p.disabled ? ' is-disabled' : ''}" data-md="${escapeAttr(p.mdPath)}" role="button" aria-current="${isActive}" tabindex="0">
      <div class="pr-item-top">
        <span class="pr-item-name">${escapeHtml(p.name)}</span>
        ${p.disabled ? '<span class="pill" data-state="muted">off</span>' : ''}
      </div>
      ${p.description ? `<span class="pr-item-desc">${escapeHtml(p.description)}</span>` : ''}
    </div>`;
  }).join('');

  const count = q ? `${filtered.length} of ${items.length}` : `${items.length} prompt${items.length === 1 ? '' : 's'}`;
  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml/escapeAttr above.
  pane.innerHTML = `<div class="pr-list">
      <div class="pr-list-head section-label"><span>Library</span><span class="section-label-count">${escapeHtml(count)}</span></div>
      <div class="pr-items" aria-label="Prompts">
        ${rows}
        <button class="pr-new" type="button">${PR_PLUS_SVG}New prompt</button>
      </div>
    </div>
    <div class="pr-detail${editing ? ' is-editing' : ''}">
      <div class="pr-detail-head">
        <div class="pr-detail-heading">
          <div class="pr-eyebrow">${editing ? 'Editing' : 'Prompt'}${active.disabled ? '<span class="pill" data-state="muted">off</span>' : ''}</div>
          ${editing ? `
            <input class="pr-edit-field pr-edit-name" id="pr-edit-name" type="text" value="${escapeAttr(active.name)}"
                   spellcheck="false" autocomplete="off" aria-label="Prompt name" />
            <input class="pr-edit-field pr-edit-desc" id="pr-edit-desc" type="text" value="${escapeAttr(active.description || '')}"
                   placeholder="One-line summary of what this prompt does" aria-label="Prompt description" />
          ` : `
            <h2 class="pr-detail-title">${escapeHtml(active.name)}</h2>
            ${active.description ? `<div class="pr-detail-desc">${escapeHtml(active.description)}</div>` : ''}
          `}
          <div class="pr-detail-path" title="${escapeAttr(active.mdPath)}">${escapeHtml(active.mdPath)}</div>
        </div>
        <div class="pr-detail-actions">
          ${editing ? `
            <button class="ghost-btn pr-cancel" type="button">Cancel</button>
            <button class="btn-primary pr-save" type="button" title="Save · Ctrl+S">Save</button>
          ` : `
            <button class="pr-iconbtn pr-edit" type="button" title="Edit prompt" aria-label="Edit prompt">${PR_PENCIL_SVG}</button>
            <button class="pr-iconbtn pr-delete" type="button" title="Delete prompt" aria-label="Delete prompt">${PR_TRASH_SVG}</button>
            <button class="pr-run pr-run-btn" type="button" title="Send into chat">Run${PR_ARROW_SVG}</button>
          `}
        </div>
      </div>
      ${editing
    ? `<div class="pr-editor">
             <div class="pr-gutter" id="pr-gutter" aria-hidden="true"></div>
             <textarea class="pr-body pr-body-edit" spellcheck="false" aria-label="Prompt body">${escapeHtml(promptBodyCache.get(active.mdPath) || '')}</textarea>
           </div>`
    : '<pre class="pr-body is-muted">Loading…</pre>'}
    </div>`;

  // Switching prompts mid-edit would drop the edit without saying so, so the
  // list asks first and stays put when the answer is no.
  const selectRow = async (md) => {
    if (!md || md === selectedPromptMd) return;
    if (editingPromptPath) {
      const leave = await openConfirmDialog({
        title: 'Discard changes',
        bodyHtml: `Leaves <strong>${escapeHtml(active.name)}</strong> without saving your edit.`,
        confirmLabel: 'Discard',
      });
      if (!leave) return;
      editingPromptPath = null;
    }
    selectedPromptMd = md;
    paintPrompts(promptsCache, ($('#prompts-search') || {}).value || '');
  };
  pane.querySelectorAll('.pr-item').forEach((row) => {
    row.addEventListener('click', () => selectRow(row.dataset.md));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRow(row.dataset.md); }
    });
  });
  const newRow = pane.querySelector('.pr-new');
  if (newRow) newRow.addEventListener('click', () => openPromptComposer(''));
  const runBtn = pane.querySelector('.pr-run-btn');
  if (runBtn) runBtn.addEventListener('click', () => runPrompt(active.mdPath));
  const editBtn = pane.querySelector('.pr-edit');
  if (editBtn) editBtn.addEventListener('click', () => beginPromptEdit(active));
  const delBtn = pane.querySelector('.pr-delete');
  if (delBtn) delBtn.addEventListener('click', () => deletePrompt(active.mdPath, active.name));
  const saveBtn = pane.querySelector('.pr-save');
  if (saveBtn) saveBtn.addEventListener('click', () => savePromptEdit(active));
  const cancelBtn = pane.querySelector('.pr-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelPromptEdit);

  if (editing) {
    // Numbers are measured from the rendered text, so this runs after the
    // editor is in the DOM and has a real width to wrap against.
    bindPromptGutter();
    // Ctrl/Cmd+S saves and Esc leaves, so a full edit never needs the pointer.
    pane.querySelectorAll('.pr-edit-field, .pr-body-edit').forEach((el) => {
      el.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); savePromptEdit(active); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelPromptEdit(); }
      });
      el.addEventListener('input', () => el.classList.remove('field-invalid'));
    });
  } else {
    fillPromptBody(active.mdPath);
  }
}

// Loads the prompt text into the right pane. Cached bodies paint before the
// first await, so a re-render from filtering or selection never flashes.
async function fillPromptBody(mdPath) {
  const paint = (text, muted) => {
    const el = $('#prompts-pane .pr-body');
    if (!el) return;
    el.classList.toggle('is-muted', !!muted);
    el.textContent = text;
  };
  if (promptBodyCache.has(mdPath)) {
    const body = promptBodyCache.get(mdPath);
    paint(body || 'This prompt has no body yet. Open the file and write one.', !body);
    return;
  }
  paint('Loading…', true);
  const res = await window.husk.skills.read(mdPath);
  if (selectedPromptMd !== mdPath) return;
  if (!res || !res.ok) {
    paint((res && res.error) || 'Could not read this prompt.', true);
    return;
  }
  // Strip the frontmatter block; the body is what actually gets sent.
  const body = String(res.content || '').replace(/^---[\s\S]*?---\n?/, '').trim();
  promptBodyCache.set(mdPath, body);
  paint(body || 'This prompt has no body yet. Open the file and write one.', !body);
}

async function deletePrompt(mdPath, name) {
  if (!mdPath) return;
  const confirmed = await openConfirmDialog({
    title: 'Delete prompt?',
    bodyHtml: `Permanently delete <strong>${escapeHtml(name || 'this prompt')}</strong>. The markdown file on disk will be removed.`,
    confirmLabel: 'Delete prompt',
  });
  if (!confirmed) return;
  const res = await window.husk.prompts.delete(mdPath);
  if (!res || !res.ok) {
    const t = document.getElementById('toast');
    if (t) { t.textContent = (res && res.error) || 'Could not delete prompt'; t.hidden = false; setTimeout(() => { t.hidden = true; }, 3500); }
    return;
  }
  await renderPrompts();
}

async function runPrompt(mdPath) {
  if (!mdPath) return;
  const res = await window.husk.skills.read(mdPath);
  if (!res.ok || !res.content) return;
  // Strip the frontmatter block; we want the body only sent into the chat.
  const body = res.content.replace(/^---[\s\S]*?---\n?/, '').trim();
  if (!body) return;
  setPage('chat');
  // Send the prompt body to the agent's PTY. Append a newline so the agent
  // treats it as a complete user turn. setPage('chat') focuses the terminal.
  setTimeout(() => { try { armRecap(); window.husk.pty.write(body + '\n'); } catch (_) {} }, 60);
}

// Wire prompts search + refresh + create.
{
  const search = document.getElementById('prompts-search');
  if (search) search.addEventListener('input', debounce(() => paintPrompts(promptsCache, search.value), 120));
  const refresh = document.getElementById('btn-prompts-refresh');
  if (refresh) refresh.addEventListener('click', renderPrompts);

  const newBtn = document.getElementById('btn-prompts-new');
  const modal = document.getElementById('new-prompt-modal');
  const nameEl = document.getElementById('np-name');
  const descEl = document.getElementById('np-desc');
  const bodyEl = document.getElementById('np-content');
  const cancelBtn = document.getElementById('np-cancel');
  const createBtn = document.getElementById('np-create');
  function clearInvalid() { [nameEl, descEl].forEach((el) => el && el.classList.remove('field-invalid')); }
  function openNewPrompt() {
    if (!modal) return;
    if (nameEl) nameEl.value = '';
    if (descEl) descEl.value = '';
    if (bodyEl) bodyEl.value = '';
    clearInvalid();
    modal.hidden = false;
    setTimeout(() => { try { nameEl && nameEl.focus(); } catch (_) {} }, 30);
  }
  function closeNewPrompt() { if (modal) modal.hidden = true; }
  async function submitNewPrompt() {
    const name = (nameEl && nameEl.value || '').trim();
    const description = (descEl && descEl.value || '').trim();
    const content = bodyEl && bodyEl.value || '';
    // Both fields are required by the backend; validate here so the user sees
    // exactly which field is missing instead of a generic save failure.
    clearInvalid();
    if (!name) {
      if (nameEl) { nameEl.classList.add('field-invalid'); nameEl.focus(); }
      toast('Name is required', 'error');
      return;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      if (nameEl) { nameEl.classList.add('field-invalid'); nameEl.focus(); }
      toast('Name must be lowercase letters, digits, dashes; start with a letter.', 'error');
      return;
    }
    if (!description) {
      if (descEl) { descEl.classList.add('field-invalid'); descEl.focus(); }
      toast('Description is required', 'error');
      return;
    }
    const res = await window.husk.prompts.create({ name, description, content });
    if (!res || !res.ok) {
      toast((res && res.error) || 'Could not create prompt', 'error');
      return;
    }
    // Land on the prompt that was just written rather than on whichever one
    // happens to sort first.
    if (res.mdPath) selectedPromptMd = res.mdPath;
    closeNewPrompt();
    toast(`Created ${name}`, 'success');
    await renderPrompts();
  }
  if (newBtn) newBtn.addEventListener('click', openNewPrompt);
  if (cancelBtn) cancelBtn.addEventListener('click', closeNewPrompt);
  if (createBtn) createBtn.addEventListener('click', submitNewPrompt);
  // Drop the invalid-field highlight the moment the user starts fixing it.
  [nameEl, descEl].forEach((el) => el && el.addEventListener('input', () => el.classList.remove('field-invalid')));
  // Close only via Cancel or Escape. A backdrop click must not dismiss the
  // modal, so half-written prompts survive an accidental outside click.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) closeNewPrompt();
  });
}

// ─── Skills page ──────────────────────────────────────────────────────────────
let skillsCache = [];
let agentKindCache = 'claude';
async function renderSkills() {
  const listEl = $('#skills-list');
  // eslint-disable-next-line no-unsanitized/property -- Static loading template.
  listEl.innerHTML = '<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">Loading…</div></div>';
  const res = await window.husk.skills.list();
  if (!res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    listEl.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${escapeHtml(res.error || 'Unknown error')}</div></div>`;
    return;
  }
  // Husk prompts have a page of their own. Nothing auto-loads a prompt, so
  // listing one here would make a row mean two different things.
  skillsCache = (res.skills || []).filter((sk) => sk.source !== 'husk');
  agentKindCache = res.agentKind || 'claude';
  document.body.dataset.agentKind = agentKindCache;
  applyPromptsLabels();
  paintSkills(skillsCache, $('#skills-search').value);
}
function applyPromptsLabels() {
  // The page is always called "Skills" regardless of agent. The difference
  // between agents is internal: claude auto-loads ~/.claude/skills/, while
  // generic CLIs only see Husk-managed skills via the Use button.
  const railItem = document.querySelector('.rail-item[data-page="skills"]');
  if (railItem) {
    // Use aria-label, not title: the collapsed rail draws its own tooltip from
    // aria-label, and a title attribute would add a duplicate native tooltip.
    railItem.setAttribute('aria-label', 'Skills');
    railItem.removeAttribute('title');
    const lbl = railItem.querySelector('.ri-label');
    if (lbl) lbl.textContent = 'Skills';
  }
  const skillsTitle = document.querySelector('.page-skills .page-title');
  if (skillsTitle) skillsTitle.textContent = 'Skills';
  const skillsSub = document.querySelector('.page-skills .page-sub');
  if (skillsSub) {
    // Count what the page lists.
    const n = skillsCache.length || ((lastStats && typeof lastStats.skills === 'number') ? lastStats.skills : null);
    const count = n != null ? `${n} ${n === 1 ? 'skill' : 'skills'} · ` : '';
    skillsSub.textContent = count + (agentKindCache === 'claude'
      ? 'An enabled skill is called automatically whenever the agent decides it fits'
      : 'Switch off anything this agent should not see');
  }
}
async function injectPromptToChat(content) {
  if (!content) return;
  const trimmed = String(content).replace(/^---[\s\S]*?---\n?/, '').trim();
  if (!trimmed) return;
  setPage('chat');
  // With no chat open, launch the agent with this prompt as its initial input.
  // Otherwise paste into the running PTY. The test is the live tab, not the
  // welcome screen, which can still be painted over a chat that is already up.
  if (!TABS.size && $('#chat-empty')?.classList.contains('show')) {
    await launchAgent({ initialPrompt: trimmed });
    return;
  }
  $('#chat-empty').classList.remove('show');
  setTimeout(() => {
    try { window.husk.pty.write(trimmed); } catch (_) {}
    try { term.focus(); } catch (_) {}
  }, 60);
}
// A source is only worth its own entry in the rail once enough skills share
// the folder prefix; the rest live under Library.
const SK_SOURCE_MIN = 3;
const SK_LIBRARY = '__library';
// Recent is a view across the folders rather than a folder of its own, so it
// filters like All does instead of claiming skills away from their source.
const SK_RECENT = '__recent';
const SK_RECENT_DAYS = 14;
function skIsRecent(sk) {
  return !!sk.installedAt && (Date.now() - sk.installedAt) < SK_RECENT_DAYS * 864e5;
}
let skSource = 'all';
let skState = 'all';

function skSourceKey(sk, counts) {
  const m = /^([A-Za-z0-9]+)[-:_]/.exec(sk.name || '');
  const key = m ? m[1].toLowerCase() : '';
  if (!key) return SK_LIBRARY;
  if (counts && (counts.get(key) || 0) < SK_SOURCE_MIN) return SK_LIBRARY;
  return key;
}
function skSourceLabel(key) {
  if (key === SK_LIBRARY) return 'Library';
  if (key === SK_RECENT) return 'Recently added';
  return key;
}
// The rail carries the source, so the row drops the prefix it repeats. The
// full name stays on the row for search, the tooltip and the detail view.
function skShortName(sk, key) {
  if (key === SK_LIBRARY) return sk.name;
  const cut = sk.name.slice(key.length);
  return /^[-:_]/.test(cut) ? cut.slice(1) : sk.name;
}
function skPrefixCounts(list) {
  const counts = new Map();
  for (const sk of list) {
    const m = /^([A-Za-z0-9]+)[-:_]/.exec(sk.name || '');
    if (!m) continue;
    const key = m[1].toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}
function skSourceOrder(a, b) {
  // Library first because it is the default home for anything unprefixed.
  return (a === SK_LIBRARY ? 0 : 1) - (b === SK_LIBRARY ? 0 : 1) || a.localeCompare(b);
}
// What the header, its switch and the bulk toggle all act on. One definition,
// so the count above the list and the switch beside it cannot disagree.
function skScope(list, counts) {
  if (skSource === 'all') return list;
  if (skSource === SK_RECENT) return list.filter(skIsRecent);
  return list.filter((sk) => skSourceKey(sk, counts) === skSource);
}
function skMatches(sk, q, counts) {
  if (skState === 'on' && sk.disabled) return false;
  if (skState === 'off' && !sk.disabled) return false;
  if (skSource === SK_RECENT) { if (!skIsRecent(sk)) return false; }
  else if (skSource !== 'all' && skSourceKey(sk, counts) !== skSource) return false;
  if (!q) return true;
  return (sk.name + ' ' + (sk.description || '')).toLowerCase().includes(q);
}

// A skill's frontmatter is written for the model: the sentence is followed by
// routing clauses the reader has no use for. The row prints what comes first.
function skBlurb(desc) {
  const text = String(desc || '').trim();
  if (!text) return '';
  const cut = text.search(/\b(USE WHEN|NOT FOR|USE_WHEN|NOT_FOR|Triggers on)\b/);
  if (cut <= 0) return text;
  const head = text.slice(0, cut).trim().replace(/[·|,;\s]+$/, '');
  return head || text;
}

function paintSkills(list, query) {
  const q = (query || '').toLowerCase().trim();
  const counts = skPrefixCounts(list);
  const keys = [...new Set(list.map((sk) => skSourceKey(sk, counts)))].sort(skSourceOrder);
  const recent = list.filter(skIsRecent);
  if (skSource === SK_RECENT ? !recent.length : (skSource !== 'all' && !keys.includes(skSource))) skSource = 'all';

  // Left rail: every source, with how many it holds.
  const tally = new Map();
  for (const sk of list) {
    const k = skSourceKey(sk, counts);
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  // Offered only when there is something to show, so the rail never carries a
  // row that leads to an empty pane.
  const entries = [
    ['all', 'All skills', list.length],
    ...(recent.length ? [[SK_RECENT, skSourceLabel(SK_RECENT), recent.length]] : []),
    ...keys.map((k) => [k, skSourceLabel(k), tally.get(k)]),
  ];
  // eslint-disable-next-line no-unsanitized/property -- Labels are escaped below.
  $('#skills-sources').innerHTML = entries.map(([key, label, n]) => `
    <button type="button" class="sk-source${skSource === key ? ' is-active' : ''}" data-source-key="${escapeAttr(key)}">
      <span class="sk-source-name">${escapeHtml(label)}</span>
      <span class="sk-source-n">${n}</span>
    </button>`).join('');
  // The rows carry their own counts, so the header names the axis and nothing else.
  const sourcesN = $('#skills-sources-n');
  if (sourcesN) sourcesN.textContent = '';

  // Each state names its own size, so choosing one costs no guess about what
  // is behind it.
  const stateTally = { all: list.length, on: 0, off: 0 };
  for (const sk of list) stateTally[sk.disabled ? 'off' : 'on'] += 1;
  for (const key of ['all', 'on', 'off']) {
    const el = $(`#skills-state-n-${key}`);
    if (el) el.textContent = String(stateTally[key]);
  }

  // Newest first under Recent, where the order is the whole point; alphabetical
  // everywhere else.
  const rows = list.filter((sk) => skMatches(sk, q, counts))
    .sort((a, b) => (skSource === SK_RECENT
      ? b.installedAt - a.installedAt
      : skShortName(a, skSourceKey(a, counts))
        .localeCompare(skShortName(b, skSourceKey(b, counts)))));

  // Header: what is being shown, and one switch for the whole of it.
  const scope = skScope(list, counts);
  const live = scope.filter((sk) => !sk.disabled).length;
  $('#sk-title').textContent = skSource === 'all' ? 'All skills' : skSourceLabel(skSource);
  $('#sk-sub').textContent = scope.length
    ? `${live} of ${scope.length} enabled${rows.length !== scope.length ? ` · ${rows.length} shown` : ''}`
    : 'Nothing here yet';
  const bulkWrap = $('#sk-bulk-wrap');
  const bulk = $('#sk-bulk');
  bulkWrap.hidden = !scope.length;
  const allOn = scope.length > 0 && live === scope.length;
  bulk.classList.toggle('on', allOn);
  bulk.classList.toggle('is-mixed', live > 0 && !allOn);
  bulk.dataset.bulk = skSource;
  bulk.title = `${allOn ? 'Disable' : 'Enable'} every skill shown here`;
  $('#sk-bulk-label').textContent = allOn ? 'All on' : live ? 'Some on' : 'All off';

  const body = $('#skills-list');
  if (!rows.length) {
    // The empty view carries the way out of itself: back to the whole library
    // when a filter hid it, straight to a new skill when there is none.
    const filtered = list.length > 0;
    const msg = filtered
      ? 'Nothing matches this filter.'
      : 'No skills yet. Drop a folder in, import one you already wrote, or create one here.';
    // eslint-disable-next-line no-unsanitized/property -- Static message and action text.
    body.innerHTML = `<div class="sk-empty">
      <p class="sk-empty-msg">${msg}</p>
      <button type="button" class="ghost-btn" data-sk-empty="${filtered ? 'clear' : 'new'}">${filtered ? 'Show all skills' : 'Create skill'}</button>
    </div>`;
    return;
  }
  // eslint-disable-next-line no-unsanitized/property -- Skill fields are escaped via escapeHtml/escapeAttr.
  body.innerHTML = rows.map((sk) => {
    const key = skSourceKey(sk, counts);
    const on = !sk.disabled;
    return `
    <div class="sk-row${on ? '' : ' disabled'}" data-id="${escapeAttr(sk.id)}" data-source="${escapeAttr(sk.source)}" data-dirname="${escapeAttr(sk.dirName || sk.id)}" data-mdpath="${escapeAttr(sk.mdPath)}" data-path="${escapeAttr(sk.path)}" data-name="${escapeAttr(sk.name)}">
      <div class="sk-row-label" title="${escapeAttr(sk.name)}">${escapeHtml(skShortName(sk, key))}</div>
      <div class="sk-row-desc" title="${escapeAttr(sk.description || '')}">${escapeHtml(skBlurb(sk.description) || 'No description.')}</div>
      <button class="toggle ${on ? 'on' : ''}" data-toggle="1" title="${on ? 'Disable' : 'Enable'} skill"></button>
    </div>`;
  }).join('');
}

// Delegated once at the container: the list repaints on every keystroke, and
// rebinding a handler per row would make each repaint proportional to the
// library's size.
$('#skills-list').addEventListener('click', async (e) => {
  const emptyBtn = e.target.closest('[data-sk-empty]');
  if (emptyBtn) {
    if (emptyBtn.dataset.skEmpty === 'new') { openCreateSkillModal(); return; }
    // One click puts every filter back, including the search box that is not
    // part of the bar.
    skSource = 'all';
    skState = 'all';
    $('#skills-search').value = '';
    $('#skills-state').querySelectorAll('[data-state]').forEach((b) => b.classList.toggle('is-active', b.dataset.state === 'all'));
    paintSkills(skillsCache, '');
    return;
  }
  const row = e.target.closest('.sk-row');
  if (!row) return;
  const toggleBtn = e.target.closest('[data-toggle]');
  if (toggleBtn) {
    e.stopPropagation();
    const id = row.dataset.id || row.dataset.dirname;
    const source = row.dataset.source || 'claude';
    const wasOn = toggleBtn.classList.contains('on');
    // Optimistic flip, CSS transition needs the same node, not a re-rendered one.
    toggleBtn.classList.toggle('on');
    row.classList.toggle('disabled');
    const result = await window.husk.skills.toggle({ id, source, dirName: id });
    if (result.ok) {
      // Reload rather than patch: toggling renames the entry on disk, so its
      // path and its place in the filter both move.
      toastRestart(`${row.dataset.name} ${result.disabled ? 'disabled' : 'enabled'}`);
      await renderSkills();
      refreshStats();
    } else {
      toggleBtn.classList.toggle('on', wasOn);
      row.classList.toggle('disabled', !wasOn);
      toast(result.error || 'Toggle failed', 'error');
    }
    return;
  }
  openSkillDetail(row.dataset);
});
$('#skills-sources').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-source-key]');
  if (!btn) return;
  skSource = btn.dataset.sourceKey;
  paintSkills(skillsCache, $('#skills-search').value);
});
// A filter section folds away when its axis is settled, so a long list of
// filters never costs the reader the axis below it. Delegated from the document,
// so every page that mounts a filter group gets the behaviour.
document.addEventListener('click', (e) => {
  const head = e.target.closest && e.target.closest('.filter-group-head');
  if (!head) return;
  const group = head.closest('.filter-group');
  if (!group) return;
  const open = group.dataset.open !== 'false';
  group.dataset.open = open ? 'false' : 'true';
  head.setAttribute('aria-expanded', open ? 'false' : 'true');
});
$('#skills-state').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-state]');
  if (!btn) return;
  skState = btn.dataset.state;
  $('#skills-state').querySelectorAll('[data-state]').forEach((b) => b.classList.toggle('is-active', b === btn));
  paintSkills(skillsCache, $('#skills-search').value);
});
$('#sk-bulk').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  btn.disabled = true;
  const counts = skPrefixCounts(skillsCache);
  const scope = skScope(skillsCache, counts);
  const turnOn = scope.some((sk) => sk.disabled);
  // One pass over the members that disagree with the target, then a single
  // reload: each toggle renames a directory, so the paths only settle once
  // every rename is done.
  let changed = 0;
  for (const sk of scope) {
    if (!!sk.disabled === !turnOn) continue;
    const r = await window.husk.skills.toggle({ id: sk.id, source: sk.source, dirName: sk.id });
    if (r.ok) changed += 1;
  }
  if (changed) toastRestart(`${changed} ${changed === 1 ? 'skill' : 'skills'} ${turnOn ? 'enabled' : 'disabled'}`);
  else toast('Nothing to change', 'info');
  await renderSkills();
  refreshStats();
  btn.disabled = false;
});
$('#skills-search').addEventListener('input', debounce((e) => paintSkills(skillsCache, e.target.value), 120));
$('#btn-skills-refresh').addEventListener('click', renderSkills);
$('#btn-skills-open').addEventListener('click', () => lastStats && window.husk.fs.open(lastStats.skillsDir));
$('#btn-skills-new').addEventListener('click', openCreateSkillModal);
// Installing a skill you already wrote, on the same path a dropped file takes.
$('#btn-skills-import').addEventListener('click', async () => {
  const picked = await window.husk.dialog.pickFile();
  const files = (picked || []).filter((p) => /\.md$/i.test(p));
  if (!picked || !picked.length) return;
  if (!files.length) { toast('Pick a .md file', 'error'); return; }
  const failed = [];
  let added = 0;
  for (const p of files) {
    const r = await window.husk.fs.dropFile({ sourcePath: p, kind: 'skill' });
    if (r.ok) added += 1; else failed.push(`${p.split('/').pop()}: ${r.error}`);
  }
  await renderSkills();
  refreshStats();
  if (failed.length) toast(failed.join(' · '), 'error');
  if (added) toastRestart(`${added} ${added === 1 ? 'skill' : 'skills'} imported`);
});

function openCreateSkillModal() {
  $('#ns-name').value = '';
  $('#ns-desc').value = '';
  $('#ns-content').value = '';
  $('#ns-name').classList.remove('field-invalid');
  $('#ns-desc').classList.remove('field-invalid');
  $('#new-skill-modal').hidden = false;
  setTimeout(() => $('#ns-name').focus(), 50);
}
function closeCreateSkillModal() { $('#new-skill-modal').hidden = true; }
$('#ns-cancel').addEventListener('click', closeCreateSkillModal);
// Close only via Cancel or Escape; a backdrop click must not discard the form.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#new-skill-modal').hidden) closeCreateSkillModal();
});
[$('#ns-name'), $('#ns-desc')].forEach((el) => el && el.addEventListener('input', () => el.classList.remove('field-invalid')));

async function submitCreateSkill() {
  const name = $('#ns-name').value.trim().toLowerCase();
  const description = $('#ns-desc').value.trim();
  const content = $('#ns-content').value;
  $('#ns-name').classList.remove('field-invalid');
  $('#ns-desc').classList.remove('field-invalid');
  if (!name) { toast('Name is required', 'error'); $('#ns-name').classList.add('field-invalid'); $('#ns-name').focus(); return; }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    toast('Name must be lowercase letters, digits, dashes; start with a letter.', 'error');
    $('#ns-name').classList.add('field-invalid'); $('#ns-name').focus(); return;
  }
  if (!description) { toast('Description is required', 'error'); $('#ns-desc').classList.add('field-invalid'); $('#ns-desc').focus(); return; }
  const r = await window.husk.skills.create({ name, description, content });
  if (r.ok) {
    toast(`Skill created: ${name} · restart agent to load it`, 'success');
    closeCreateSkillModal();
    await renderSkills();
    refreshStats();
  } else {
    toast(`Failed: ${r.error}`, 'error');
  }
}
$('#ns-create').addEventListener('click', submitCreateSkill);
$('#ns-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#ns-desc').focus(); });
$('#ns-desc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitCreateSkill(); });
$('#ns-content').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitCreateSkill(); });

async function openSkillDetail({ dirname, mdpath, path: skPath, name }) {
  const res = await window.husk.skills.read(mdpath);
  const content = res.ok ? res.content : `Error: ${res.error}`;
  const isDisabled = dirname.startsWith('_disabled_');
  showDetail({
    eyebrow: 'Skill',
    title: name,
    sub: skPath,
    meta: [
      ['Status', isDisabled ? 'Disabled' : 'Active'],
      ['Source', mdpath],
    ],
    body: content,
    actions: [
      { label: isDisabled ? 'Enable' : 'Disable', kind: 'ghost', onClick: async () => {
        const r = await window.husk.skills.toggle(dirname);
        if (r.ok) { toastRestart(`${name} ${r.disabled ? 'disabled' : 'enabled'}`); closeDetail(); renderSkills(); refreshStats(); }
        else toast(r.error || 'Toggle failed', 'error');
      }},
      { label: 'Edit in OS', kind: 'ghost', onClick: () => window.husk.fs.open(mdpath) },
      { label: 'Open folder', kind: 'ghost', onClick: () => window.husk.fs.open(skPath) },
    ],
  });
}

// ─── Sessions page ───────────────────────────────────────────────────────────────
let sessionsCache = [];
// Set once renderSessions has written the detailed subheader, so the periodic
// stats pass stops replacing it with the placeholder.
let sessionsSubOwned = false;
let sessionsAgent = 'claude';
let sessionsDir = '';
let sessionsSelectMode = false;
const sessionsSelected = new Set();

// One shape for every state that leaves the list without rows: real icon,
// headline, one support line, then the actions that state offers. Callers
// escape their own interpolations; everything else here is static.
function sessionsEmptyCard({ title, msg, actions = '', hints = '' }) {
  return `<div class="empty-state">
    <div class="es-icon">${ICONS.sessions}</div>
    <div class="se-title">${title}</div>
    <div class="es-msg">${msg}</div>
    ${actions}
    ${hints}
  </div>`;
}

// The card is rebuilt on every paint, so its buttons are bound on every paint.
function wireSessionsEmpty(host) {
  const start = host.querySelector('#se-start-chat');
  if (start) start.addEventListener('click', () => setPage('chat'));
  const open = host.querySelector('#se-open-folder');
  if (open) open.addEventListener('click', openSessionsFolder);
  const retry = host.querySelector('#se-retry');
  if (retry) retry.addEventListener('click', renderSessions);
  const clear = host.querySelector('#se-clear-filter');
  if (clear) {
    clear.addEventListener('click', () => {
      const search = $('#sessions-search');
      search.value = '';
      paintSessions(sessionsCache, '');
      search.focus();
    });
  }
}

function openSessionsFolder() {
  const dir = sessionsDir || (lastStats && lastStats.sessionsDir);
  if (dir) window.husk.fs.open(dir);
}

async function renderSessions() {
  const list = $('#sessions-list');
  // eslint-disable-next-line no-unsanitized/property -- Static loading template.
  list.innerHTML = sessionsEmptyCard({
    title: 'Loading sessions',
    msg: 'Reading the session files on disk.',
  });
  const res = await window.husk.sessions.list();
  if (!res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    list.innerHTML = sessionsEmptyCard({
      title: 'Could not read sessions',
      msg: escapeHtml(res.error || 'Unknown error'),
      actions: '<div class="se-actions"><button class="btn-primary" id="se-retry" type="button">Try again</button><button class="ghost-btn" id="se-open-folder" type="button">Open folder</button></div>',
    });
    wireSessionsEmpty(list);
    return;
  }
  sessionsCache = res.sessions;
  sessionsAgent = res.agent || 'claude';
  sessionsDir = res.sessionsDir || '';
  await loadSessionAgents();
  // Reflect which agent's sessions are shown, and where they live.
  const subEl = $('#sessions-sub');
  if (subEl) {
    const hidden = Number(res.hiddenAutopilotSessions) || 0;
    const hiddenHTML = hidden
      ? `<span class="ss-note">${hidden} Autopilot ${hidden === 1 ? 'session is' : 'sessions are'} hidden here and kept under Autopilot Recent runs</span>`
      : '';
    if (res.supported === false) {
      subEl.textContent = 'Session history is not available for this agent yet';
    } else {
      // The head reads as prose; where the sessions live rides the button that
      // opens them, so a deep project path cannot widen the head.
      // eslint-disable-next-line no-unsanitized/property -- the note is built from a count.
      subEl.innerHTML = '<span>Click a session to preview, Resume to continue</span>' + hiddenHTML;
    }
    sessionsSubOwned = true;
  }
  const openBtn = $('#btn-sessions-open');
  if (openBtn) openBtn.title = sessionsDir ? `Open ${sessionsDir} in your file manager` : 'Open in your file manager';
  if (res.supported === false) {
    // eslint-disable-next-line no-unsanitized/property -- Static, agent name escaped.
    $('#sessions-list').innerHTML = sessionsEmptyCard({
      title: 'Not available for this agent',
      msg: 'Husk does not read this agent\'s session history yet. Switch the active agent in Preferences to browse sessions.',
    });
    return;
  }
  // Drop selections that no longer exist (e.g. after delete + refresh).
  const live = new Set(sessionsCache.map((s) => s.path));
  for (const p of sessionsSelected) if (!live.has(p)) sessionsSelected.delete(p);
  paintSessions(sessionsCache, $('#sessions-search').value);
  syncSelectModeUI();
  // Keep the rail's Recent list in sync with the full Sessions page.
  refreshRecentList();
}
function timeAgo(ms) {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Which listed sessions are agents a chat started, keyed by session id, plus
// the parent each one belongs to. An agent is a fork of its chat and inherits
// its title, so this comes from the tool's own agent listing rather than from
// the transcripts.
let sessionAgents = { bySession: new Map(), byParent: new Map() };
let sessionAgentsExpanded = new Set();

async function loadSessionAgents() {
  sessionAgents = { bySession: new Map(), byParent: new Map() };
  let res = null;
  try { res = await window.husk.bgAgents.list({ all: true }); } catch (_) { return; }
  if (!res || !res.ok || !Array.isArray(res.agents)) return;
  for (const a of res.agents) {
    if (!a || !a.sessionId) continue;
    sessionAgents.bySession.set(a.sessionId, a);
    if (!a.parentSessionId) continue;
    if (!sessionAgents.byParent.has(a.parentSessionId)) sessionAgents.byParent.set(a.parentSessionId, []);
    sessionAgents.byParent.get(a.parentSessionId).push(a);
  }
  for (const arr of sessionAgents.byParent.values()) arr.sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));
}

function agentChildRowsHTML(parentId) {
  const kids = sessionAgents.byParent.get(parentId) || [];
  if (!kids.length || !sessionAgentsExpanded.has(parentId)) return '';
  // The chat these belong to is the row directly above, so a child carries only
  // what its siblings do not: its id, what it is doing, how it stands, how old.
  // Fields run state then age here and in the switcher, in one age format.
  const rows = kids.map((a) => `
      <button class="agent-row ${agentStateClass(a)}" type="button" data-agent="${escapeAttr(a.sessionId)}">
        <span class="agent-dot" aria-hidden="true"></span>
        <code class="agent-id">${escapeHtml(agentShortId(a))}</code>
        <span class="agent-live">${escapeHtml(agentSubtitle(a))}</span>
        <span class="agent-state">${escapeHtml(agentStateWord(a))}</span>
        <span class="agent-age">${escapeHtml(agentAgeLabel(a.startedAt))}</span>
      </button>`).join('');
  return `<div class="agent-group">${rows}</div>`;
}

function agentChipHTML(parentId) {
  const kids = sessionAgents.byParent.get(parentId) || [];
  if (!kids.length) return '';
  const live = kids.filter((a) => a.running).length;
  const blocked = kids.filter((a) => a.running && a.state === 'blocked').length;
  const open = sessionAgentsExpanded.has(parentId);
  // One tail note, and the waiting count outranks the running one: a chat with
  // an agent stuck on a question needs the collapsed row to say so.
  const tail = blocked
    ? `<span class="sa-live">${blocked} needs you</span>`
    : (live ? `<span class="sa-live">${live} running</span>` : '');
  return `<span class="session-agents${blocked ? ' has-blocked' : ''}" role="button" tabindex="0" data-agents-for="${escapeAttr(parentId)}" aria-expanded="${open ? 'true' : 'false'}">
      <svg class="sa-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      <span class="sa-count">${kids.length} agent${kids.length === 1 ? '' : 's'}</span>${tail}
    </span>`;
}

function paintSessions(list, query) {
  const ul = $('#sessions-list');
  const q = (query || '').toLowerCase().trim();
  const matched = q ? list.filter((s) =>
    (s.title + ' ' + s.id + ' ' + s.projectPath + ' ' + (s.prdPhase || '')).toLowerCase().includes(q)
  ) : list;
  // An agent carries its chat's title, so it is shown under the chat that
  // started it, and only while that chat is itself in view.
  const present = new Set(matched.map((s) => s.id));
  const filtered = matched.filter((s) => {
    const a = sessionAgents.bySession.get(s.id);
    return !(a && a.parentSessionId && present.has(a.parentSessionId));
  });
  if (!filtered.length) {
    const card = list.length
      ? sessionsEmptyCard({
        title: 'No matching sessions',
        msg: `Nothing in ${list.length} session${list.length === 1 ? '' : 's'} matches "${escapeHtml(query)}".`,
        actions: '<div class="se-actions"><button class="ghost-btn" id="se-clear-filter" type="button">Clear filter</button></div>',
      })
      : sessionsEmptyCard({
        title: 'No sessions yet',
        msg: 'Every chat you start is written to disk, so you can come back later, read what happened and pick the thread up again.',
        actions: '<div class="se-actions"><button class="btn-primary" id="se-start-chat" type="button">Start a chat</button><button class="ghost-btn" id="se-open-folder" type="button">Open folder</button></div>',
        hints: `<div class="se-hints">
            <div class="se-hint"><span class="se-hint-n">1</span><span>Start a chat. <b>Husk saves it for you</b> while you work.</span></div>
            <div class="se-hint"><span class="se-hint-n">2</span><span>It shows up in this list. <b>Click a row</b> to preview the transcript.</span></div>
            <div class="se-hint"><span class="se-hint-n">3</span><span>Press <b>Resume</b> to reopen that session in a new chat tab.</span></div>
          </div>`,
      });
    // eslint-disable-next-line no-unsanitized/property -- Message content is escaped above.
    ul.innerHTML = card;
    wireSessionsEmpty(ul);
    return;
  }
  ul.classList.toggle('select-mode', sessionsSelectMode);
  // eslint-disable-next-line no-unsanitized/property -- Session fields are escaped via escapeHtml/escapeAttr.
  ul.innerHTML = filtered.map((s) => {
    // No badge for the default: a filled pill reading "chat" on every chat is
    // the loudest thing in the card and the only one carrying no information.
    const phaseHTML = s.prdPhase
      ? `<span class="session-phase ${escapeAttr(s.prdPhase)}">${escapeHtml(s.prdPhase)}</span>`
      : '';
    const progressHTML = s.prdProgress ? `<span class="session-progress">${escapeHtml(s.prdProgress)}</span>` : '';
    const checked = sessionsSelected.has(s.path) ? 'checked' : '';
    const checkboxHTML = sessionsSelectMode
      ? `<label class="session-check"><input class="ai-check" type="checkbox" tabindex="-1" ${checked} data-path="${escapeAttr(s.path)}" /><span class="ai-check-box"></span></label>`
      : '';
    const rowHTML = `
      <button class="session-row${sessionsSelected.has(s.path) ? ' selected' : ''}${phaseHTML ? '' : ' no-phase'}" data-id="${escapeAttr(s.id)}" data-title="${escapeAttr(s.title)}" data-project="${escapeAttr(s.projectPath)}" data-path="${escapeAttr(s.path)}" data-prdpath="${escapeAttr(s.prdPath)}" data-started="${escapeAttr(s.startedISO)}" data-mtime="${s.mtime}" data-size="${s.sizeBytes}" data-phase="${escapeAttr(s.prdPhase || '')}" data-progress="${escapeAttr(s.prdProgress || '')}">
        ${checkboxHTML}
        <div class="session-task">
          <strong>${escapeHtml(s.title)}</strong>
          <span class="session-slug">${escapeHtml(s.projectPath)} · ${escapeHtml(s.id.slice(0, 8))}</span>
        </div>
        <span class="session-effort">${escapeHtml(timeAgo(s.mtime))}</span>
        ${progressHTML || `<span class="session-progress">${escapeHtml(fmtSize(s.sizeBytes))}</span>`}
        ${phaseHTML}
      </button>`;
    // A chat and its agents are one card: the chat keeps the card's surface
    // and the agents hang off it.
    if (!(sessionAgents.byParent.get(s.id) || []).length) return rowHTML;
    return `<div class="session-block">${rowHTML}${agentChipHTML(s.id)}${agentChildRowsHTML(s.id)}</div>`;
  }).join('');
  ul.querySelectorAll('.session-row').forEach((r) =>
    r.addEventListener('click', (e) => {
      if (sessionsSelectMode) {
        e.preventDefault();
        toggleSessionSelection(r.dataset.path);
      } else {
        openSessionDetail(r.dataset);
      }
    })
  );
  const toggleAgents = (parentId) => {
    if (sessionAgentsExpanded.has(parentId)) sessionAgentsExpanded.delete(parentId);
    else sessionAgentsExpanded.add(parentId);
    const top = ul.scrollTop;
    paintSessions(list, query);
    ul.scrollTop = top;
    // The repaint replaces the chip that was just pressed, so hand focus to its
    // replacement or the next key lands on the page body.
    for (const chip of ul.querySelectorAll('.session-agents')) {
      if (chip.dataset.agentsFor === parentId) { chip.focus(); break; }
    }
  };
  ul.querySelectorAll('.session-agents').forEach((chip) => {
    chip.addEventListener('click', () => toggleAgents(chip.dataset.agentsFor));
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAgents(chip.dataset.agentsFor); }
    });
  });
  ul.querySelectorAll('.agent-row').forEach((row) =>
    row.addEventListener('click', () => {
      const a = sessionAgents.bySession.get(row.dataset.agent);
      if (a) openBgAgent(a);
    })
  );
}

function toggleSessionSelection(p) {
  if (!p) return;
  const wasSelected = sessionsSelected.has(p);
  if (wasSelected) sessionsSelected.delete(p);
  else sessionsSelected.add(p);
  // Update only the affected row in place: repainting the whole list on every
  // checkbox click costs an O(n) DOM teardown and listener rebind.
  const ul = $('#sessions-list');
  if (ul) {
    for (const row of ul.querySelectorAll('.session-row')) {
      if (row.dataset.path === p) {
        row.classList.toggle('selected', !wasSelected);
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb) cb.checked = !wasSelected;
        break;
      }
    }
  }
  syncSelectModeUI();
}

function syncSelectModeUI() {
  const selectBtn = $('#btn-sessions-select');
  const deleteBtn = $('#btn-sessions-delete');
  const cancelBtn = $('#btn-sessions-cancel');
  if (!selectBtn) return;
  selectBtn.hidden = sessionsSelectMode;
  deleteBtn.hidden = !sessionsSelectMode;
  cancelBtn.hidden = !sessionsSelectMode;
  const n = sessionsSelected.size;
  deleteBtn.textContent = `Delete (${n})`;
  deleteBtn.disabled = n === 0;
}

function enterSelectMode() {
  sessionsSelectMode = true;
  paintSessions(sessionsCache, $('#sessions-search').value);
  syncSelectModeUI();
}
function exitSelectMode() {
  sessionsSelectMode = false;
  sessionsSelected.clear();
  paintSessions(sessionsCache, $('#sessions-search').value);
  syncSelectModeUI();
}

async function deleteSelectedSessions() {
  const paths = [...sessionsSelected];
  if (!paths.length) return;
  const res = await window.husk.sessions.delete(paths);
  if (res.cancelled) return;
  if (!res.ok && !res.deleted) {
    toast(res.error || 'Delete failed', 'error');
    return;
  }
  toast(`Deleted ${res.deleted} session${res.deleted === 1 ? '' : 's'}`, 'success');
  if (res.failed?.length) toast(`${res.failed.length} failed`, 'error');
  sessionsSelectMode = false;
  sessionsSelected.clear();
  await renderSessions();
}

$('#sessions-search').addEventListener('input', debounce((e) => paintSessions(sessionsCache, e.target.value), 120));
$('#btn-sessions-refresh').addEventListener('click', renderSessions);
$('#btn-sessions-open').addEventListener('click', openSessionsFolder);
$('#btn-sessions-select').addEventListener('click', enterSelectMode);
$('#btn-sessions-cancel').addEventListener('click', exitSelectMode);
$('#btn-sessions-delete').addEventListener('click', deleteSelectedSessions);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sessionsSelectMode && document.querySelector('.page-sessions:not([hidden])')) {
    exitSelectMode();
  }
});

async function openSessionDetail(d) {
  // Read PRD body if matched, else show first message preview
  let body = '';
  if (d.prdpath) {
    const res = await window.husk.sessions.read(d.prdpath);
    if (res.ok) body = res.content.replace(/^---[\s\S]*?---\n*/, '');
  }
  if (!body) body = '(no PRD attached. This is a raw chat session. Resume to continue the conversation.)';

  const meta = [
    ['Session ID', d.id],
    ['Project', d.project],
    ['Started', new Date(d.started).toLocaleString()],
    ['Updated', new Date(parseInt(d.mtime, 10)).toLocaleString()],
    ['Size', fmtSize(parseInt(d.size, 10))],
  ];
  if (d.phase) meta.push(['PRD phase', d.phase]);
  if (d.progress) meta.push(['PRD progress', d.progress]);
  if (d.prdpath) meta.push(['PRD', d.prdpath]);

  // A session an agent is holding cannot be resumed, so it is not offered. The
  // two things that do work are named for what they are: joining the work that
  // is running, and taking a copy that stops following it.
  //
  // held, not attachable. An agent that has finished its turn still owns the
  // transcript until its process exits, and offering Resume there hands over a
  // command the CLI refuses.
  const holder = sessionAgents.bySession.get(d.id);
  const busy = !!(holder && holder.held);
  const owned = { ...d, owner: d.owner || sessionsAgent };
  if (busy) meta.push(['Held by', `agent ${agentShortId(holder)} · ${agentStateWord(holder)}`]);

  showDetail({
    eyebrow: `${sessionsAgent} session`,
    title: d.title,
    sub: d.id,
    meta,
    body,
    actions: [
      busy
        ? { label: '⇥ Attach to the running agent', kind: 'primary', onClick: () => resumeSessionInChat(owned) }
        : { label: '↻ Resume this session', kind: 'primary', onClick: () => resumeSessionInChat(owned) },
      busy ? { label: 'Open a copy', kind: 'ghost', onClick: () => resumeSessionInChat(owned, { fork: true }) } : null,
      d.prdpath ? { label: 'Open PRD', kind: 'ghost', onClick: () => window.husk.fs.open(d.prdpath) } : null,
      { label: 'Open files', kind: 'ghost', onClick: () => window.husk.fs.open(d.path) },
    ].filter(Boolean),
  });
}

// A short, display-only rendering of the resume command for the agent that owns
// the session, or null when that agent has no resume form. The command that is
// actually run comes from main, which resolves it against what is on disk.
function resumeCommandLabel(agent, id) {
  if (agent === 'claude') return `claude --resume ${id}`;
  if (agent === 'copilot') return `copilot --resume=${id}`;
  if (agent === 'gemini') return `gemini --resume ${id}`;
  return null;
}

async function resumeSessionInChat(d, opts) {
  const options = opts || {};
  // Already open means already answered, and it is answered before the planner
  // is asked: the round trip that decides between attaching and resuming is
  // work nobody needs when the conversation is one tab away.
  //
  // A copy is the exception. Somebody asking for one has looked at the open
  // chat and wants a second, divergent line from it, so the tab they are
  // looking at is not what they are asking for.
  if (!options.fork && focusOpenSession(d.id)) return;
  // The session's OWNING agent decides the resume command. Every list
  // entry carries its owner; the active config is only a last resort
  // (an owner-less entry from an older render).
  const agent = (d.owner
    || (cfg && cfg.agentCommand ? cfg.agentCommand : 'claude')).trim().split(/\s+/)[0].toLowerCase();
  let cmd = null;
  let plan = null;
  try {
    const r = await window.husk.sessions.resumeCommand({ agent, id: d.id, cwd: d.project || '' });
    if (r && r.ok && r.command) { cmd = r.command; plan = r; }
    else if (r && r.error) { toast(r.error, 'error'); return; }
  } catch (_) { /* fall through to the unsupported message */ }
  if (!cmd) {
    toast(`Resume is not supported for ${agent} sessions`, 'error');
    return;
  }
  // A session something is still holding does not open by resuming, because the
  // CLI will not hand one transcript to a second reader. A background agent is
  // joined by attaching to it; a chat open in another window has no id to
  // attach to, so a copy is the only way in. The fork is offered rather than
  // taken where attaching is possible: a copy diverges from the moment it is
  // made, which is a different thing from watching work that is running.
  const attaching = plan && plan.mode === 'attach' && !options.fork;
  const forking = !!(options.fork || (plan && plan.mode === 'fork'));
  if (options.fork && plan && plan.forkCommand) cmd = plan.forkCommand;
  closeDetail();
  setPage('chat');
  // The tool and folder the chat named before the resume, restored if the agent
  // turns the session down.
  const previousHeader = { subBase: chatSubBase };
  const cmdShort = attaching
    ? `claude attach ${plan.agentId}`
    : (forking ? `claude --resume ${d.id.slice(0, 8)} --fork-session`
      : (resumeCommandLabel(agent, d.id.slice(0, 8)) || cmd));
  // The attach runs where the agent is working, and so does a copy of it; only
  // a plain resume is free to open in the directory the list row named.
  const cwd = ((attaching || forking) && plan && plan.cwd) ? plan.cwd : (d.project || null);
  if (attaching) {
    toast(`Attaching to ${plan.agentId}, which is running this session`, 'success');
  } else if (options.fork) {
    // Asked for, next to an attach that was also on offer.
    toast(`Opening a copy of ${d.id.slice(0, 8)}…`, 'success');
  } else if (forking) {
    // The only way in: a chat open in another window has no id to attach to.
    toast(`That session is open elsewhere; opening a copy`, 'success');
  } else {
    toast(`Resuming ${d.id.slice(0, 8)}… (cwd: ${cwd || huskHome})`, 'success');
  }
  setChatSubBase({ tool: cmdShort, dir: cwd || huskHome });
  if ($('#sp-agent')) $('#sp-agent').textContent = cmdShort;
  if ($('#sp-session-id')) $('#sp-session-id').textContent = `${d.id.slice(0, 8)} · ${cwd || huskHome}`;
  // Resume in a fresh tab so the current chat keeps running alongside it.
  const tab = await openNewChatTab({
    command: cmd,
    cwd,
    skipContext: true,
    // The failure watcher is for a resume. An attach fails its own way and has
    // no transcript to be missing, so it is not watched for one.
    resumeAttempt: (attaching || forking) ? null : { agent, id: d.id, cwd: d.project || '', previousHeader },
  });
  // The other real answer, offered rather than taken. Attaching shows the work
  // as it happens; a fork is a copy that stops tracking it.
  if (attaching && plan.forkCommand && typeof toastAction === 'function') {
    toastAction('Attached to the running agent', 'Open a copy instead',
      () => resumeSessionInChat(d, { fork: true }), 'success');
  }
  // Link the tab to the resumed session so future renames persist, and restore
  // a custom name if this session was renamed before. The default label stays
  // "Chat N" otherwise; the header title stays "Chat".
  //
  // A copy is deliberately not linked. It is a new session that starts from
  // this one's history and diverges immediately, so claiming the parent's id
  // would name two conversations with one id: the next click on the original
  // would focus the copy, and a rename of either would follow the other. The
  // resolver assigns the copy its own id once the CLI has minted one.
  if (tab) {
    if (!forking) {
      tab.agentId = d.id;
      try {
        const res = await window.husk.sessions.resolveLiveTitle({ knownAgentId: d.id });
        if (res && res.ok && res.custom && res.title) tab.customTitle = res.title;
      } catch (_) {}
    }
    renderTabStrip();
  }
  if (term) term.scrollToBottom();
}

// ─── Files command-center ────────────────────────────────────────────────────
// The Files page is a two-pane cockpit: a fuzzy-searchable, git-decorated file
// index on the left and an inline syntax-highlighted preview on the right, with
// per-file actions that push the file to the agent. It is the bridge between the
// codebase and the agent, not a file browser.
const fx = {
  root: null,
  index: [],          // flat relative paths
  truncated: false,
  gitByPath: new Map(),   // rel -> status label
  changed: [],            // [{path,status}]
  tab: 'all',             // 'all' | 'changed'
  query: '',
  results: [],            // current rendered rows [{path, status}]
  activeKey: -1,          // keyboard-highlighted row index
  selected: null,         // rel path currently previewed
  diffOpen: false,
  loaded: false,
  indexError: null,
  filter: '',             // extension filter string, e.g. "js, ts"
  // Inline editor state.
  currentText: null,      // loaded text of the previewed file (for editing)
  currentMtime: null,     // mtimeMs at load, for conflict detection
  currentLang: 'text',
  editing: false,
  dirty: false,
};
const FX_MAX_ROWS = 400;

// Files follows the workspace: the folder the agent is working in is the folder
// this page shows. Open-folder is a detour held for the session only, and
// pinning a different project ends it.
let fxRootOverride = null;
function fxDefaultRoot() {
  const active = projectsCache.find((p) => p && p.id === activeProjectId);
  if (active && active.path) return active.path;
  return (cfg && (cfg.agentCwd || cfg.treeRoot)) || huskHome || null;
}
function fxCurrentRoot() { return fxRootOverride || fxDefaultRoot(); }

// Called when the pinned project changes: drop the detour and repaint while
// the page is on screen, so Files follows the chat.
function fxSyncToWorkspace() {
  fxRootOverride = null;
  if (currentPage !== 'files') return;
  const root = fxCurrentRoot();
  fxSetOpenFolderLabel(root);
  fxLoad(root);
}

function fxGitClass(status) {
  if (!status) return '';
  if (status === 'untracked') return 'fx-b-question';
  return 'fx-b-' + (window.husk.text.gitBadge(status) || '');
}

async function fxLoad(root) {
  fx.root = root;
  fx.loaded = false;
  fx.selected = null;
  fx.diffOpen = false;
  // The head reads as a sentence; the folder itself is named on the button that
  // changes it and on the overview below.
  const sub = $('#files-sub');
  if (sub) sub.textContent = root ? 'Read, edit and search the files in this workspace' : 'No folder open';
  const openBtn = $('#btn-files-open');
  if (openBtn) openBtn.title = root || 'Choose the folder to browse';
  if (!root) { fxRenderList([]); fxShowEmptyPreview('Set a root folder to browse.'); return; }
  // Git status first so the index can decorate rows.
  fx.gitByPath = new Map();
  fx.changed = [];
  try {
    const g = await window.husk.fs.gitStatus(root);
    if (g && g.ok && g.isRepo) {
      const parsed = window.husk.text.parseGitStatus(g.porcelain);
      for (const e of parsed) { fx.gitByPath.set(e.path, e.status); }
      fx.changed = parsed.map((e) => ({ path: e.path, status: e.status }));
    }
  } catch (_) {}
  const cc = $('#fx-changed-count');
  if (cc) { cc.textContent = String(fx.changed.length); cc.hidden = fx.changed.length === 0; }
  // File index. A genuinely empty folder and a failed index call get different
  // empty states.
  fx.indexError = null;
  if (!window.husk.fs.indexFiles) {
    fx.index = []; fx.truncated = false;
    fx.indexError = 'This window is running an older Husk. Fully quit and relaunch to load files.';
  } else {
    try {
      const r = await window.husk.fs.indexFiles(root, !!cfg.showHidden);
      if (r && r.ok) { fx.index = r.files; fx.truncated = !!r.truncated; }
      else { fx.index = []; fx.truncated = false; fx.indexError = (r && r.error) || 'Could not index this folder.'; }
    } catch (err) {
      fx.index = []; fx.truncated = false;
      fx.indexError = 'Could not reach the file index (try fully restarting Husk).';
    }
  }
  fx.loaded = true;
  fxRefreshList();
  if (!fx.selected) fxShowEmptyPreview();
}

function fxCurrentItems() {
  let items = fx.tab === 'changed'
    ? fx.changed.slice()
    : fx.index.map((p) => ({ path: p, status: fx.gitByPath.get(p) || '' }));
  if (fx.filter && fxParseFilter(fx.filter).length) {
    items = items.filter((it) => fxMatchesFilter(it.path));
  }
  return items;
}

function fxRefreshList() {
  const filtering = !!(fx.filter && fxParseFilter(fx.filter).length);
  // Default browse view is a hierarchical tree (folders + files). Searching or
  // filtering flattens to a ranked/filtered list, and the Changed tab is always
  // flat. This mirrors VSCode: the explorer is a tree, search is a flat panel.
  if (fx.tab === 'all' && !fx.query && !filtering) {
    fx.results = [];
    fx.activeKey = -1;
    fxRenderTree();
    return;
  }
  const items = fxCurrentItems();
  let rows;
  if (fx.query) {
    rows = window.husk.text.fuzzyFilter(fx.query, items, 'path');
  } else {
    rows = items;
  }
  fx.results = rows.slice(0, FX_MAX_ROWS);
  fx.activeKey = fx.results.length ? 0 : -1;
  fxRenderList(fx.results);
}

// File-type icon: a compact colored monogram keyed by extension, plus a folder
// glyph for directories. Keeps the tree readable at a glance like VSCode.
const FX_ICONS = {
  js: ['JS', 'ic-js'], mjs: ['JS', 'ic-js'], cjs: ['JS', 'ic-js'], jsx: ['JS', 'ic-js'],
  ts: ['TS', 'ic-ts'], tsx: ['TS', 'ic-ts'],
  json: ['{}', 'ic-json'], css: ['#', 'ic-css'], scss: ['#', 'ic-css'],
  html: ['<>', 'ic-html'], htm: ['<>', 'ic-html'],
  md: ['MD', 'ic-md'], markdown: ['MD', 'ic-md'],
  py: ['PY', 'ic-py'], sh: ['$', 'ic-sh'], bash: ['$', 'ic-sh'], zsh: ['$', 'ic-sh'],
  go: ['GO', 'ic-go'], rs: ['RS', 'ic-rs'], c: ['C', 'ic-c'], h: ['H', 'ic-c'],
  yml: ['Y', 'ic-yml'], yaml: ['Y', 'ic-yml'], toml: ['T', 'ic-yml'],
  png: ['IMG', 'ic-img'], jpg: ['IMG', 'ic-img'], jpeg: ['IMG', 'ic-img'], gif: ['IMG', 'ic-img'], svg: ['IMG', 'ic-img'], webp: ['IMG', 'ic-img'], ico: ['IMG', 'ic-img'],
  lock: ['L', 'ic-dim'], txt: ['T', 'ic-dim'], log: ['L', 'ic-dim'],
};
function fxFileIconEl(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const spec = FX_ICONS[ext] || ['•', 'ic-default'];
  const el = document.createElement('span');
  el.className = 'fx-ficon ' + spec[1];
  el.textContent = spec[0];
  return el;
}
function fxFolderIconEl() {
  const el = document.createElement('span');
  el.className = 'fx-ficon ic-folder';
  el.textContent = '';
  return el;
}
// Does any changed path live under this directory? Used to tint a folder whose
// contents git thinks changed (VSCode does the same).
function fxDirHasChanges(rel) {
  const prefix = rel + '/';
  for (const c of fx.changed) { if (c.path.startsWith(prefix)) return true; }
  return false;
}

async function fxRenderTree() {
  const list = $('#fx-list');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!fx.loaded) return;
  if (!fx.root) { const e = document.createElement('div'); e.className = 'fx-list-empty'; e.textContent = 'No folder selected.'; list.appendChild(e); return; }
  let res;
  try { res = await window.husk.fs.listDir(fx.root, !!cfg.showHidden); }
  catch (err) { res = { ok: false, error: String(err) }; }
  if (!res || !res.ok) {
    const e = document.createElement('div'); e.className = 'fx-list-empty';
    e.textContent = fx.indexError || (res && res.error) || 'Could not read this folder.';
    list.appendChild(e); return;
  }
  if (!res.entries.length) { const e = document.createElement('div'); e.className = 'fx-list-empty'; e.textContent = 'Empty folder.'; list.appendChild(e); return; }
  for (const ent of res.entries) list.appendChild(fxBuildTreeNode(ent.name, ent.isDir, '', 0));
}

// Build one tree row (and, for a directory, a lazily-populated children box).
function fxBuildTreeNode(name, isDir, parentRel, depth) {
  const rel = parentRel ? parentRel + '/' + name : name;
  const node = document.createElement('div');
  node.className = 'fx-tnode';
  const row = document.createElement('div');
  row.className = 'fx-trow' + (isDir ? ' is-dir' : ' is-file');
  if (!isDir && rel === fx.selected) row.classList.add('is-selected');
  row.style.paddingLeft = (8 + depth * 12) + 'px';
  row.dataset.path = rel;

  const chevron = document.createElement('span');
  chevron.className = 'fx-tchevron';
  chevron.textContent = isDir ? '›' : '';

  const status = fx.gitByPath.get(rel) || '';
  if (isDir) {
    row.appendChild(chevron);
    row.appendChild(fxFolderIconEl());
  } else {
    row.appendChild(chevron);
    row.appendChild(fxFileIconEl(name));
  }
  const nameEl = document.createElement('span');
  nameEl.className = 'fx-tname';
  nameEl.textContent = name;
  nameEl.title = rel;
  if (status) nameEl.classList.add('is-changed');
  else if (isDir && fxDirHasChanges(rel)) nameEl.classList.add('is-changed-dir');
  row.appendChild(nameEl);
  if (!isDir && status) {
    const b = document.createElement('span');
    b.className = 'fx-trow-badge ' + fxGitClass(status);
    b.textContent = status === 'untracked' ? '?' : window.husk.text.gitBadge(status);
    row.appendChild(b);
  }
  node.appendChild(row);

  if (isDir) {
    const children = document.createElement('div');
    children.className = 'fx-tchildren';
    children.hidden = true;
    node.appendChild(children);
    let loaded = false;
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!loaded) {
        let r;
        try { r = await window.husk.fs.listDir(joinRoot(rel), !!cfg.showHidden); }
        catch (err) { r = { ok: false, error: String(err) }; }
        if (r && r.ok) {
          for (const c of r.entries) children.appendChild(fxBuildTreeNode(c.name, c.isDir, rel, depth + 1));
        } else {
          const err = document.createElement('div');
          err.className = 'fx-list-empty';
          err.textContent = (r && r.error) || 'Could not read folder.';
          children.appendChild(err);
        }
        loaded = true;
      }
      fxSetCursor(row, 'list');
      const open = !children.hidden;
      children.hidden = open;
      row.classList.toggle('is-open', !open);
      chevron.classList.toggle('is-open', !open);
    });
  } else {
    row.addEventListener('click', () => {
      const prev = $('#fx-list').querySelector('.fx-trow.is-selected');
      if (prev) prev.classList.remove('is-selected');
      row.classList.add('is-selected');
      fxSetCursor(row, 'list');
      fxOpenFile(rel, status);
    });
  }
  return node;
}

function fxRenderList(rows) {
  const list = $('#fx-list');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!fx.loaded) { return; }
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'fx-list-empty';
    const filtering = !!(fx.filter && fxParseFilter(fx.filter).length);
    if (fx.indexError && fx.tab === 'all' && !fx.query && !filtering) empty.textContent = fx.indexError;
    else if (fx.query || filtering) empty.textContent = 'No files match.';
    else empty.textContent = fx.tab === 'changed'
      ? (fx.root ? 'No changes in the working tree.' : 'No folder selected.')
      : 'No files indexed.';
    list.appendChild(empty);
    return;
  }
  rows.forEach((row, i) => {
    const el = document.createElement('div');
    el.className = 'fx-row' + (row.path === fx.selected ? ' is-selected' : '') + (i === fx.activeKey ? ' is-active-key' : '');
    el.dataset.path = row.path;
    const badge = document.createElement('span');
    badge.className = 'fx-row-badge ' + fxGitClass(row.status);
    badge.textContent = row.status ? (row.status === 'untracked' ? '?' : window.husk.text.gitBadge(row.status)) : '';
    const name = document.createElement('span');
    name.className = 'fx-row-name';
    const inner = document.createElement('span');
    inner.textContent = row.path;
    inner.title = row.path;
    name.appendChild(inner);
    el.appendChild(badge);
    el.appendChild(name);
    el.addEventListener('click', () => { fx.activeKey = i; fxSetCursor(el, 'list'); fxOpenFile(row.path, row.status); });
    list.appendChild(el);
  });
  // Surface truncation and result caps so a big root never looks complete when
  // it was cut off.
  const notes = [];
  if (fx.truncated && fx.tab === 'all' && !fx.query) notes.push('Index capped; pick a project folder for the full set.');
  else if (rows.length >= FX_MAX_ROWS) notes.push(`Showing first ${FX_MAX_ROWS}; keep typing to narrow.`);
  if (notes.length) {
    const t = document.createElement('div');
    t.className = 'fx-list-trunc';
    t.textContent = notes[0];
    list.appendChild(t);
  }
}

// Keyboard navigation over whatever the list is showing. The list renders as a
// nested tree while browsing and as a flat list once you search or switch to
// Changed, so navigation walks the rendered rows rather than fx.results, and it
// listens at the page level so the arrows work wherever focus sits. fxPane says
// which region the keys drive: the file list, or one of the two overview
// columns. Left and Right move between them, Up and Down move inside one.
let fxPane = 'list';

function fxPaneEl(pane) {
  if (pane === 'ov0') return $('#fx-ov-changed');
  if (pane === 'ov1') return $('#fx-ov-key');
  return $('#fx-list');
}

// The overview only exists while no file is open, so the two extra panes are
// reachable only in that state.
function fxOverviewOpen() {
  const empty = $('#fx-preview-empty');
  return !!empty && !empty.hidden;
}

function fxNavRows(pane) {
  const which = pane || fxPane;
  const host = fxPaneEl(which);
  if (!host) return [];
  const sel = which === 'list' ? '.fx-row, .fx-trow' : '.fx-ov-row';
  // offsetParent is null inside a collapsed folder, so a row behind a closed
  // chevron is skipped rather than silently selected.
  return [...host.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
}

// One cursor for the whole page: every pane is cleared first, so the pointer
// and the keyboard cannot leave two highlights behind.
function fxClearCursor() {
  ['list', 'ov0', 'ov1'].forEach((p) => {
    const host = fxPaneEl(p);
    if (host) host.querySelectorAll('.is-active-key').forEach((el) => el.classList.remove('is-active-key'));
  });
}

// The cursor is the focus: moving the cursor moves focus, so Tab and the arrows
// drive one highlight. Roving tabindex, so the cursor row is the single tab stop
// for its pane and tabbing in lands on it.
function fxSetCursor(row, pane) {
  if (!row) return;
  fxClearCursor();
  row.classList.add('is-active-key');
  if (pane) fxPane = pane;
  const host = fxPaneEl(fxPane);
  if (host) {
    const sel = fxPane === 'list' ? '.fx-row, .fx-trow' : '.fx-ov-row';
    host.querySelectorAll(sel).forEach((el) => { el.tabIndex = -1; });
  }
  row.tabIndex = 0;
  // preventScroll: scrollIntoView already positions the row, and letting focus
  // scroll as well jumps the pane.
  try { row.focus({ preventScroll: true }); } catch (_) { }
}

// Tab moves focus without going through fxSetCursor, so mirror it back onto the
// cursor by class alone, which cannot recurse. Focus leaving all three panes
// drops the cursor with it.
document.addEventListener('focusin', (e) => {
  if (document.body.dataset.page !== 'files') return;
  const panes = [['#fx-list', 'list'], ['#fx-ov-changed', 'ov0'], ['#fx-ov-key', 'ov1']];
  for (const [sel, pane] of panes) {
    const host = document.querySelector(sel);
    if (!host || !host.contains(e.target)) continue;
    const row = e.target.closest('.fx-row, .fx-trow, .fx-ov-row');
    if (!row || row.classList.contains('is-active-key')) return;
    fxClearCursor();
    row.classList.add('is-active-key');
    fxPane = pane;
    return;
  }
  fxClearCursor();
});

function fxMove(delta) {
  const rows = fxNavRows();
  if (!rows.length) return;
  const cur = rows.findIndex((el) => el.classList.contains('is-active-key'));
  const next = cur < 0
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.min(rows.length - 1, Math.max(0, cur + delta));
  fxSetCursor(rows[next]);
  // Keep the flat-mode index in step, since other code reads fx.activeKey.
  if (fxPane === 'list') fx.activeKey = fx.results.length ? next : -1;
  rows[next].scrollIntoView({ block: 'nearest' });
}

// Left and Right walk the panes: the list, then the two overview columns. The
// overview panes drop out of the chain when a file is open, since they are not
// rendered then.
function fxMovePane(delta) {
  const chain = fxOverviewOpen() ? ['list', 'ov0', 'ov1'] : ['list'];
  let at = Math.max(0, chain.indexOf(fxPane));
  // Step over panes that render nothing, such as the changed column on a clean
  // working tree.
  for (let i = at + delta; i >= 0 && i < chain.length; i += delta) {
    const rows = fxNavRows(chain[i]);
    if (rows.length) {
      fxSetCursor(rows[0], chain[i]);
      rows[0].scrollIntoView({ block: 'nearest' });
      return;
    }
  }
}

// Escape drops the cursor first; a second press closes the open file.
function fxEscape() {
  const hadCursor = !!document.querySelector('#fx-list .is-active-key, #fx-ov-changed .is-active-key, #fx-ov-key .is-active-key');
  if (hadCursor) {
    fxClearCursor();
    fxPane = 'list';
    fx.activeKey = -1;
    try { document.activeElement && document.activeElement.blur(); } catch (_) { }
    return;
  }
  // No cursor left to drop: close the open file and return to the overview.
  if (fx.selected) {
    fx.selected = null;
    fx.diffOpen = false;
    $$('#fx-list .is-selected').forEach((el) => el.classList.remove('is-selected'));
    fxShowEmptyPreview('');
  }
}

function fxActivateRow() {
  const row = fxNavRows().find((el) => el.classList.contains('is-active-key'));
  if (!row) return;
  // Overview rows already carry their own click behaviour.
  if (fxPane !== 'list') { row.click(); return; }
  if (row.classList.contains('is-dir')) { row.click(); return; }
  const path = row.dataset && row.dataset.path;
  if (path) fxOpenFile(path, fx.gitByPath.get(path) || '');
}

function fxSyncActiveKey() {
  const rows = $('#fx-list').children;
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].classList) continue;
    rows[i].classList.toggle('is-active-key', i === fx.activeKey);
    rows[i].classList.toggle('is-selected', rows[i].dataset && rows[i].dataset.path === fx.selected);
  }
  const active = rows[fx.activeKey];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function fxShowEmptyPreview(msg) {
  const empty = $('#fx-preview-empty');
  const body = $('#fx-preview-body');
  if (body) body.hidden = true;
  if (empty) {
    empty.hidden = false;
    fxRenderOverview(msg);
  }
}

// ── Workspace overview ─────────────────────────────────────────────────────
// With no file selected the preview pane shows an overview of the folder: what
// git says changed, the usual entry-point files, and the type mix. Every row
// opens a file and every type chip applies the extension filter.
const FX_ENTRY_FILES = [
  'readme.md', 'claude.md', 'agents.md', 'contributing.md', 'security.md', 'license',
  'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'makefile',
  'dockerfile', 'docker-compose.yml', 'tsconfig.json', 'index.html', 'main.js',
];
const FX_OV_ROWS = 12;
const FX_OV_TYPES = 10;
const FX_SVG_NS = 'http://www.w3.org/2000/svg';

function fxOvIcon(d) {
  const svg = document.createElementNS(FX_SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(FX_SVG_NS, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}

function fxOvEmptyBox(text, iconPath) {
  const box = document.createElement('div');
  box.className = 'fx-ov-empty';
  box.appendChild(fxOvIcon(iconPath || 'M20 6L9 17l-5-5'));
  const t = document.createElement('span');
  t.textContent = text;
  box.appendChild(t);
  return box;
}

// One clickable file row: type monogram, basename at full contrast, dimmed
// parent path, and the git status when there is one.
function fxOvRow(path, status) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'fx-ov-row';
  row.title = path;
  const cut = path.lastIndexOf('/');
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  row.appendChild(fxFileIconEl(base));
  const nameEl = document.createElement('span');
  nameEl.className = 'fx-ov-row-base';
  nameEl.textContent = base;
  row.appendChild(nameEl);
  const dirEl = document.createElement('span');
  dirEl.className = 'fx-ov-row-dir';
  dirEl.textContent = cut > 0 ? path.slice(0, cut) : '';
  row.appendChild(dirEl);
  if (status) {
    const st = document.createElement('span');
    st.className = 'fx-ov-status ' + fxGitClass(status);
    st.textContent = status;
    row.appendChild(st);
  }
  row.addEventListener('click', () => fxOpenFile(path, status || ''));
  return row;
}

// The conventional entry points, shallowest first. A folder with none of them
// falls back to its shallowest files.
function fxEntryPoints() {
  if (!fx.index.length) return [];
  const rank = new Map(FX_ENTRY_FILES.map((n, i) => [n, i]));
  const scored = [];
  for (const p of fx.index) {
    const base = (p.split('/').pop() || p).toLowerCase();
    if (!rank.has(base)) continue;
    scored.push({ p, r: rank.get(base), depth: p.split('/').length });
  }
  scored.sort((a, b) => a.depth - b.depth || a.r - b.r || a.p.length - b.p.length);
  if (scored.length) return scored.slice(0, FX_OV_ROWS).map((s) => s.p);
  return fx.index.slice()
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, FX_OV_ROWS);
}

function fxTypeCounts() {
  const counts = new Map();
  for (const p of fx.index) {
    const base = p.split('/').pop() || p;
    const dot = base.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = base.slice(dot + 1).toLowerCase();
    if (!ext || ext.length > 8) continue;
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, FX_OV_TYPES);
}

function fxOvStat(value, label) {
  const box = document.createElement('div');
  box.className = 'fx-ov-stat';
  const n = document.createElement('span');
  n.className = 'fx-ov-stat-n';
  n.textContent = value;
  const l = document.createElement('span');
  l.className = 'fx-ov-stat-l';
  l.textContent = label;
  box.appendChild(n);
  box.appendChild(l);
  return box;
}

function fxRenderOverview(msg) {
  const changedBox = $('#fx-ov-changed');
  const keyBox = $('#fx-ov-key');
  if (!changedBox || !keyBox) return;
  const root = fx.root ? fx.root.replace(/\/+$/, '') : '';
  const title = $('#fx-ov-title');
  if (title) title.textContent = root ? (root.split('/').pop() || root) : 'No folder open';
  const sub = $('#fx-ov-sub');
  if (sub) {
    sub.textContent = msg || fx.indexError || (root
      ? 'Pick a file on the left to read or edit it in place, or start from what changed below.'
      : 'Choose a folder with Open folder, or pin a project in the chat and this page follows it.');
  }
  const stats = $('#fx-ov-stats');
  if (stats) {
    while (stats.firstChild) stats.removeChild(stats.firstChild);
    stats.appendChild(fxOvStat(String(fx.index.length) + (fx.truncated ? '+' : ''), fx.index.length === 1 ? 'file' : 'files'));
    stats.appendChild(fxOvStat(String(fx.changed.length), 'changed'));
  }

  while (changedBox.firstChild) changedBox.removeChild(changedBox.firstChild);
  const seeAll = $('#fx-ov-see-changed');
  if (fx.changed.length) {
    for (const c of fx.changed.slice(0, FX_OV_ROWS)) changedBox.appendChild(fxOvRow(c.path, c.status));
    if (seeAll) {
      seeAll.hidden = fx.changed.length <= FX_OV_ROWS;
      seeAll.textContent = `See all ${fx.changed.length}`;
    }
  } else {
    if (seeAll) seeAll.hidden = true;
    changedBox.appendChild(fxOvEmptyBox(root ? 'Working tree clean.' : 'No folder open.'));
  }

  while (keyBox.firstChild) keyBox.removeChild(keyBox.firstChild);
  const entries = fxEntryPoints();
  if (entries.length) {
    for (const p of entries) keyBox.appendChild(fxOvRow(p, fx.gitByPath.get(p) || ''));
  } else {
    keyBox.appendChild(fxOvEmptyBox(
      fx.indexError || (root ? 'Nothing indexed in this folder.' : 'No folder open.'),
      'M12 8v5M12 16.5v.01M12 3l9 16H3z',
    ));
  }

  const typesBox = $('#fx-ov-types');
  if (typesBox) {
    while (typesBox.firstChild) typesBox.removeChild(typesBox.firstChild);
    const types = fxTypeCounts();
    typesBox.hidden = types.length === 0;
    for (const [ext, n] of types) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'fx-ov-type';
      chip.title = `Filter the list to .${ext}`;
      const label = document.createElement('span');
      label.textContent = '.' + ext;
      const count = document.createElement('span');
      count.className = 'fx-ov-type-n';
      count.textContent = String(n);
      chip.appendChild(label);
      chip.appendChild(count);
      chip.addEventListener('click', () => {
        fx.filter = ext;
        const inp = $('#fx-filter-input'); if (inp) inp.value = ext;
        fxToggleFilter(true);
        fxRenderFilterChips();
        fxRefreshList();
      });
      typesBox.appendChild(chip);
    }
  }
}

function fxFmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function fxOpenFile(rel, status) {
  // Opening another file with unsaved edits confirms first, so an accidental
  // click never silently loses work.
  if (fx.dirty && rel !== fx.selected) {
    const ok = await openConfirmDialog({
      title: 'Discard unsaved edits?',
      bodyHtml: `You have unsaved changes to ${escapeHtml(fx.selected || 'this file')}. Opening another file will discard them.`,
      confirmLabel: 'Discard', cancelLabel: 'Keep editing',
    });
    if (!ok) return;
  }
  fx.dirty = false;
  fx.selected = rel;
  fx.diffOpen = false;
  const empty = $('#fx-preview-empty');
  const body = $('#fx-preview-body');
  if (empty) empty.hidden = true;
  if (body) body.hidden = false;
  $('#fx-preview-path').textContent = rel;
  const gb = $('#fx-preview-gitbadge');
  const st = status || fx.gitByPath.get(rel) || '';
  if (gb) {
    if (st) { gb.hidden = false; gb.textContent = st; gb.className = 'fx-preview-badge b-' + st; }
    else { gb.hidden = true; }
  }
  const diffBtn = $('#fx-act-diff');
  if (diffBtn) { diffBtn.hidden = !st; diffBtn.classList.remove('is-on'); }
  $('#fx-diff-wrap').hidden = true;
  $('#fx-code-wrap').hidden = true;
  $('#fx-editor-wrap').hidden = true;
  const meta = $('#fx-preview-meta');
  const note = $('#fx-preview-note');
  if (note) note.hidden = true;
  if (meta) meta.textContent = 'Loading...';
  fx.currentText = null; fx.currentMtime = null; fx.currentLang = 'text';
  fx.editing = false;
  fxSetEditButtons(false);
  let r;
  try { r = await window.husk.fs.readFile(fx.root, rel); }
  catch (err) { r = { ok: false, error: String(err) }; }
  if (fx.selected !== rel) return; // a newer selection won
  if (!r || !r.ok) {
    if (note) {
      note.hidden = false;
      note.textContent = (r && r.reason) || (r && r.error === 'binary' ? 'Binary file (no text preview).' : (r && r.error) || 'Could not read file.');
      const openBtn = document.createElement('button');
      openBtn.className = 'btn-primary';
      openBtn.textContent = 'Open in default app';
      openBtn.addEventListener('click', () => window.husk.fs.open(joinRoot(rel)));
      note.appendChild(document.createElement('br'));
      note.appendChild(openBtn);
    }
    if (meta) meta.textContent = r && r.bytes ? fxFmtBytes(r.bytes) : '';
    return;
  }
  if (meta) meta.textContent = `${fxFmtBytes(r.bytes)} · ${r.lang}`;
  fx.currentText = r.text; fx.currentMtime = r.mtimeMs; fx.currentLang = r.lang;
  // The preview IS the editor: load the text into the always-live textarea so
  // the user can just click and type, no mode to discover.
  fx.editing = true;
  fx.dirty = false;
  $('#fx-editor-wrap').hidden = false;
  const ta = $('#fx-editor-input');
  if (ta) { ta.value = r.text; ta.scrollTop = 0; ta.setSelectionRange(0, 0); }
  fxUpdateEditHighlight();
  fxSetEditButtons(true);
  const save = $('#fx-act-save'); if (save) save.classList.remove('is-dirty');
}

// ── Inline editor ──────────────────────────────────────────────────────────
// The preview is always the editor (no read/edit toggle). The action bar shows
// Save (whenever an editable file is open) and Revert (only when there are
// unsaved edits). Diff toggles when the file has git changes.
function fxSetEditButtons(editing) {
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('#fx-act-save', editing);
  show('#fx-act-revert', editing && fx.dirty);
  show('#fx-act-diff', editing && !!(fx.gitByPath.get(fx.selected)));
}
// Discard unsaved edits and reload the last-saved content into the editor.
async function fxRevert() {
  if (!fx.dirty || fx.currentText == null) return;
  const ok = await openConfirmDialog({
    title: 'Discard unsaved edits?',
    bodyHtml: 'Your unsaved changes to this file will be reverted to the last saved version.',
    confirmLabel: 'Discard', cancelLabel: 'Keep editing',
  });
  if (!ok) return;
  const ta = $('#fx-editor-input');
  if (ta) { ta.value = fx.currentText; fxUpdateEditHighlight(); }
  fxMarkDirty();
}
function fxMarkDirty() {
  const ta = $('#fx-editor-input');
  fx.dirty = ta ? (ta.value !== fx.currentText) : false;
  const save = $('#fx-act-save');
  if (save) save.classList.toggle('is-dirty', fx.dirty);
  const revert = $('#fx-act-revert');
  if (revert) revert.hidden = !fx.dirty;
}
// Live re-highlighting re-tokenizes the whole file per keystroke. Past this
// size the backdrop stays plain-escaped: aligned, just uncolored.
const FX_LIVE_HL_MAX = 200000;
// Rebuild the highlighted backdrop + gutter from the textarea's current value.
function fxUpdateEditHighlight() {
  const ta = $('#fx-editor-input');
  const hl = $('#fx-editor-highlight');
  const gutter = $('#fx-editor-gutter');
  if (!ta || !hl) return;
  const val = ta.value;
  let lines;
  if (val.length > FX_LIVE_HL_MAX) {
    lines = val.split('\n').map((l) => escapeHtml(l));
  } else {
    lines = window.husk.text.highlightLines(val, fx.currentLang);
    if (!Array.isArray(lines)) lines = val.split('\n').map((l) => escapeHtml(l));
  }
  // eslint-disable-next-line no-unsanitized/property -- highlightLines/escapeHtml entity-escape all input.
  hl.innerHTML = lines.map((l) => l || '​').join('\n');
  if (gutter) {
    const n = lines.length;
    let g = '';
    for (let i = 1; i <= n; i++) g += i + '\n';
    gutter.textContent = g;
  }
  fxSyncEditScroll();
}
function fxSyncEditScroll() {
  const ta = $('#fx-editor-input');
  const hl = $('#fx-editor-highlight');
  const gutter = $('#fx-editor-gutter');
  if (!ta) return;
  if (hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; }
  if (gutter) gutter.scrollTop = ta.scrollTop;
}
async function fxSave(force) {
  if (!fx.editing || fx.currentText == null) return;
  const ta = $('#fx-editor-input');
  const content = ta.value;
  const r = await window.husk.fs.writeFile({
    root: fx.root, rel: fx.selected, content,
    expectMtimeMs: fx.currentMtime, force: !!force,
  });
  if (!r) { toast('Save failed', 'error'); return; }
  if (!r.ok) {
    if (r.error === 'conflict') {
      const ok = await openConfirmDialog({
        title: 'File changed on disk',
        bodyHtml: escapeHtml(r.reason || 'The file changed since you opened it.'),
        confirmLabel: 'Overwrite', cancelLabel: 'Keep my version open',
      });
      if (ok) return fxSave(true);
      return;
    }
    toast((r && r.error) || 'Save failed', 'error');
    return;
  }
  fx.currentText = content;
  fx.currentMtime = r.mtimeMs;
  fx.dirty = false;
  const save = $('#fx-act-save'); if (save) save.classList.remove('is-dirty');
  const revert = $('#fx-act-revert'); if (revert) revert.hidden = true;
  toast('Saved', 'success');
  // Stay in the editor; just refresh git status so the badge and Changed count
  // reflect the newly modified file.
  const meta = $('#fx-preview-meta');
  if (meta) meta.textContent = `${fxFmtBytes(r.bytes)} · ${fx.currentLang}`;
  fxRefreshGitStatus();
}
async function fxRefreshGitStatus() {
  if (!fx.root) return;
  try {
    const g = await window.husk.fs.gitStatus(fx.root);
    fx.gitByPath = new Map();
    fx.changed = [];
    if (g && g.ok && g.isRepo) {
      const parsed = window.husk.text.parseGitStatus(g.porcelain);
      for (const e of parsed) fx.gitByPath.set(e.path, e.status);
      fx.changed = parsed.map((e) => ({ path: e.path, status: e.status }));
    }
    const cc = $('#fx-changed-count');
    if (cc) { cc.textContent = String(fx.changed.length); cc.hidden = fx.changed.length === 0; }
    // Update the open file's badge.
    const st = fx.gitByPath.get(fx.selected) || '';
    const gb = $('#fx-preview-gitbadge');
    if (gb) { if (st) { gb.hidden = false; gb.textContent = st; gb.className = 'fx-preview-badge b-' + st; } else gb.hidden = true; }
    fxRefreshList();
  } catch (_) {}
}

function joinRoot(rel) { return fx.root.endsWith('/') ? fx.root + rel : fx.root + '/' + rel; }

// Toggle the git diff for the open file over the editor.
async function fxToggleDiff() {
  if (!fx.selected) return;
  const diffBtn = $('#fx-act-diff');
  fx.diffOpen = !fx.diffOpen;
  if (diffBtn) diffBtn.classList.toggle('is-on', fx.diffOpen);
  // The diff overlays the editor; hide the editor while it is shown.
  $('#fx-editor-wrap').hidden = fx.diffOpen;
  $('#fx-diff-wrap').hidden = !fx.diffOpen;
  if (!fx.diffOpen) return;
  const diffEl = $('#fx-diff');
  diffEl.innerHTML = '';
  let r;
  try { r = await window.husk.fs.gitDiff(fx.root, fx.selected); }
  catch (err) { r = { ok: false, error: String(err) }; }
  if (!r || !r.ok || !r.diff) {
    const d = document.createElement('div');
    d.className = 'd-meta';
    d.textContent = (r && r.error) || 'No diff (file may be untracked or unchanged).';
    diffEl.appendChild(d);
    return;
  }
  for (const raw of r.diff.split('\n')) {
    const line = document.createElement('span');
    if (raw.startsWith('+') && !raw.startsWith('+++')) line.className = 'd-add';
    else if (raw.startsWith('-') && !raw.startsWith('---')) line.className = 'd-del';
    else if (raw.startsWith('@@')) line.className = 'd-hunk';
    else line.className = 'd-meta';
    line.textContent = raw || '​';
    diffEl.appendChild(line);
  }
}

function fxSetTab(tab) {
  fx.tab = tab;
  $('#fx-tab-all').classList.toggle('is-active', tab === 'all');
  $('#fx-tab-changed').classList.toggle('is-active', tab === 'changed');
  fxRefreshList();
}

// Wire the command-center once at load.
function initFilesCommandCenter() {
  const search = $('#fx-search');
  if (search) {
    search.addEventListener('input', () => { fx.query = search.value.trim(); fxRefreshList(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); fxMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); fxMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); fxActivateRow(); }
      else if (e.key === 'Escape') { if (search.value) { search.value = ''; fx.query = ''; fxRefreshList(); } else search.blur(); }
    });
  }
  // Page-level, so the footer's arrow hint is true wherever focus sits. The
  // search input keeps its own handler, since a keydown inside it is consumed
  // there and never reaches this listener.
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.page !== 'files') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const isText = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    // Only defer to a field the user can see. xterm parks focus in a hidden
    // helper textarea on the chat page, which can still hold it from here.
    const onScreen = isText && t.closest
      && t.closest('.page:not([hidden]), .modal:not([hidden]), #palette:not([hidden]), #topbar');
    if (onScreen) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); fxMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); fxMove(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); fxMovePane(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); fxMovePane(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); fxActivateRow(); }
    else if (e.key === 'Escape') { e.preventDefault(); fxEscape(); }
    else if (e.key === '/') { e.preventDefault(); const el = $('#fx-search'); if (el) el.focus(); }
  });

  $('#fx-tab-all') && $('#fx-tab-all').addEventListener('click', () => fxSetTab('all'));
  $('#fx-tab-changed') && $('#fx-tab-changed').addEventListener('click', () => fxSetTab('changed'));
  // The overview's "See all" jumps the left index to the full changed set.
  $('#fx-ov-see-changed') && $('#fx-ov-see-changed').addEventListener('click', () => fxSetTab('changed'));
  $('#fx-act-open') && $('#fx-act-open').addEventListener('click', () => { if (fx.selected) window.husk.fs.open(joinRoot(fx.selected)); });
  $('#fx-act-diff') && $('#fx-act-diff').addEventListener('click', fxToggleDiff);
  $('#fx-act-mention') && $('#fx-act-mention').addEventListener('click', () => {
    if (!fx.selected) return;
    attachFileToChat(joinRoot(fx.selected));
    toast('Added to the chat', 'success');
  });
  $('#fx-act-context') && $('#fx-act-context').addEventListener('click', () => {
    if (!fx.selected) return;
    addToSessionContext({ name: fx.selected.split('/').pop(), path: joinRoot(fx.selected) });
    toast('Added to agent context', 'success');
  });
  // Editor wiring. The preview is always editable, so there is no edit toggle;
  // the user just clicks into the code and types.
  $('#fx-act-save') && $('#fx-act-save').addEventListener('click', () => fxSave(false));
  $('#fx-act-revert') && $('#fx-act-revert').addEventListener('click', fxRevert);
  const editor = $('#fx-editor-input');
  if (editor) {
    editor.addEventListener('input', () => { fxUpdateEditHighlight(); fxMarkDirty(); });
    editor.addEventListener('scroll', fxSyncEditScroll);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        // Insert two spaces at the caret instead of leaving the field.
        e.preventDefault();
        const s = editor.selectionStart, en = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(en);
        editor.selectionStart = editor.selectionEnd = s + 2;
        fxUpdateEditHighlight(); fxMarkDirty();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault(); fxSave(false);
      }
    });
  }
  // "/" focuses the fuzzy search while the Files page is visible and the user
  // is not already typing in a field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!document.querySelector('.page-files:not([hidden])')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    const s = $('#fx-search');
    if (s) { s.focus(); s.select(); }
  });
  $('#btn-files-refresh') && $('#btn-files-refresh').addEventListener('click', () => fxLoad(fxCurrentRoot()));
  $('#files-hidden') && $('#files-hidden').addEventListener('change', async (e) => {
    cfg = await window.husk.config.set({ showHidden: e.target.checked });
    fxLoad(fxCurrentRoot());
  });
  // Open folder: native OS directory picker instead of a raw path box. The pick
  // holds for the session and is also saved, so it survives a restart as the
  // browsing root for whenever no project is pinned.
  $('#btn-files-open') && $('#btn-files-open').addEventListener('click', async () => {
    let dir = null;
    try { dir = await window.husk.dialog2.pickDir(); } catch (_) {}
    if (!dir) return;
    fxRootOverride = dir;
    cfg = await window.husk.config.set({ treeRoot: dir });
    fxSetOpenFolderLabel(dir);
    fxLoad(dir);
  });
  // Extension filter (VSCode-style): funnel toggles the input; comma/space
  // separated types narrow the list.
  $('#fx-filter-btn') && $('#fx-filter-btn').addEventListener('click', () => fxToggleFilter());
  const filterInput = $('#fx-filter-input');
  if (filterInput) {
    filterInput.addEventListener('input', () => { fx.filter = filterInput.value; fxRenderFilterChips(); fxRefreshList(); });
    filterInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); fxClearFilter(); } });
  }
  $('#fx-filter-clear') && $('#fx-filter-clear').addEventListener('click', fxClearFilter);
}
initFilesCommandCenter();

function fxSetOpenFolderLabel(dir) {
  const el = $('#fx-open-folder-label');
  if (!el) return;
  if (!dir) { el.textContent = 'Open folder'; return; }
  const clean = dir.replace(/\/+$/, '');
  el.textContent = clean.split('/').pop() || clean || 'Open folder';
  const btn = $('#btn-files-open'); if (btn) btn.title = dir;
}
function fxToggleFilter(force) {
  const box = $('#fx-filter');
  const btn = $('#fx-filter-btn');
  const open = force != null ? force : box.hidden;
  box.hidden = !open;
  if (btn) btn.classList.toggle('is-on', open || !!(fx.filter && fx.filter.trim()));
  if (open) { const inp = $('#fx-filter-input'); if (inp) inp.focus(); }
}
function fxClearFilter() {
  fx.filter = '';
  const inp = $('#fx-filter-input'); if (inp) inp.value = '';
  fxRenderFilterChips();
  fxRefreshList();
  const btn = $('#fx-filter-btn'); if (btn) btn.classList.remove('is-on');
}
// Parse the filter string into a set of normalized extensions (no dot,
// lowercase). Accepts "js, ts", ".md", "*.css", space or comma separated.
function fxParseFilter(s) {
  if (!s) return [];
  return s.split(/[\s,]+/).map((t) => t.trim().replace(/^\*?\./, '').replace(/^\*/, '').toLowerCase())
    .filter(Boolean);
}
function fxRenderFilterChips() {
  const wrap = $('#fx-filter-chips');
  const clear = $('#fx-filter-clear');
  if (!wrap) return;
  const exts = fxParseFilter(fx.filter);
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  if (clear) clear.hidden = !(fx.filter && fx.filter.trim());
  const btn = $('#fx-filter-btn'); if (btn) btn.classList.toggle('is-on', exts.length > 0);
  if (!exts.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  for (const ext of exts) {
    const chip = document.createElement('span');
    chip.className = 'fx-chip';
    chip.textContent = '.' + ext;
    const x = document.createElement('span');
    x.className = 'fx-chip-x';
    x.textContent = '×';
    chip.appendChild(x);
    chip.title = 'Remove filter';
    chip.addEventListener('click', () => {
      const remaining = fxParseFilter(fx.filter).filter((e) => e !== ext);
      fx.filter = remaining.join(', ');
      const inp = $('#fx-filter-input'); if (inp) inp.value = fx.filter;
      fxRenderFilterChips();
      fxRefreshList();
    });
    wrap.appendChild(chip);
  }
}
function fxMatchesFilter(relPath) {
  const exts = fxParseFilter(fx.filter);
  if (!exts.length) return true;
  const name = relPath.split('/').pop() || relPath;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return exts.includes(ext);
}

// ─── Preferences page ────────────────────────────────────────────────────────────

const PREF_AGENT_CUSTOM = '__custom';

// The command is a choice, not a spelling test: the picker lists what Husk found
// on this machine and keeps a free-text escape hatch for anything else.
async function paintAgentCommandPicker() {
  const pick = $('#pref-agent-pick');
  const field = $('#pref-agent');
  if (!pick || !field) return;
  const current = (cfg.agentCommand || '').trim();
  let found = [];
  try {
    const r = await window.husk.agents.detect();
    found = ((r && r.agents) || []).filter((a) => a.available);
  } catch (_) { found = []; }
  const options = found.map((a) => ({ value: a.command, label: `${a.label} (${a.command})` }));
  const known = new Set(options.map((o) => o.value));
  if (current && !known.has(current)) options.unshift({ value: current, label: current });
  pick.replaceChildren();
  for (const o of options) {
    const el = document.createElement('option');
    el.value = o.value;
    el.textContent = o.label;
    pick.appendChild(el);
  }
  const custom = document.createElement('option');
  custom.value = PREF_AGENT_CUSTOM;
  custom.textContent = 'Custom command…';
  pick.appendChild(custom);
  const useCustom = !current || !options.some((o) => o.value === current);
  pick.value = useCustom ? PREF_AGENT_CUSTOM : current;
  field.hidden = !useCustom;
}

function bindPrefs() {
  $('#pref-agent').value = cfg.agentCommand || '';
  paintAgentCommandPicker();
  $('#pref-agent-name').value = cfg.agentName || 'Husk';
  if ($('#pref-agent-cwd')) $('#pref-agent-cwd').value = cfg.agentCwd || '';
  bindOrchestratorConfig();
  $('#pref-recap').checked = cfg.recap !== false;
  if ($('#pref-pai')) $('#pref-pai').checked = cfg.paiEnabled !== false;
  $('#pref-theme').value = cfg.theme || 'midnight';
  $('#pref-rail').checked = !!cfg.railExpanded;
  $('#pref-root').value = cfg.treeRoot || '';
  $('#pref-hidden').checked = !!cfg.showHidden;
  $$('.accent-swatch').forEach((sw) => sw.classList.toggle('selected', sw.dataset.c === (cfg.accent || 'orange')));
  const v = cfg.voice || {};
  $('#pref-voice-enabled').checked = !!v.enabled;
  $('#pref-voice-name').value = v.name || 'en_US-amy-medium';
  $('#pref-voice-rate').value = String(v.rate || 1.0);
  $('#pref-voice-rate-display').textContent = `${Number(v.rate || 1.0).toFixed(1)}×`;
  const cmdShort = (cfg.agentCommand || 'agent').split(/\s+/)[0];
  const agentDisplay = cfg.agentName || 'Husk';
  // Show the same cwd the agent is actually launched in (config.agentCwd
  // wins; falls back to $HOME when unset, mirroring main.js's resolution).
  setChatSubBase({ tool: cmdShort, dir: cfg.agentCwd || huskHome });
  $('#ce-agent').textContent = agentDisplay;
  if ($('#sp-agent')) $('#sp-agent').textContent = cfg.agentCommand || 'claude';
}

// ─── Voice (Piper TTS) ──────────────────────────────────────────────────────────
async function refreshVoiceStatus() {
  const s = await window.husk.voice.status();
  const el = $('#voice-status');
  const enableToggle = $('#pref-voice-enabled');
  const testBtn = $('#btn-voice-test');
  const uninstallBtn = $('#btn-voice-uninstall');
  if (s.installed) {
    el.textContent = `Installed · ${s.voices.length} voice${s.voices.length === 1 ? '' : 's'}`;
    el.className = 'pref-status ok';
    $('#btn-voice-install').textContent = 'Reinstall voice';
    const voiceSelect = $('#pref-voice-name');
    voiceSelect.replaceChildren();
    if (s.voices.length) {
      for (const v of s.voices) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        voiceSelect.appendChild(opt);
      }
    } else {
      const opt = document.createElement('option');
      opt.textContent = 'No voices';
      voiceSelect.appendChild(opt);
    }
    voiceSelect.value = (cfg.voice && cfg.voice.name) || s.voices[0];
    enableToggle.disabled = false;
    enableToggle.title = '';
    testBtn.disabled = false;
    uninstallBtn.disabled = false;
  } else {
    if (s.binaryPresent) {
      el.textContent = 'Binary present, no voices';
      el.className = 'pref-status err';
    } else {
      el.textContent = 'Not installed';
      el.className = 'pref-status';
    }
    enableToggle.checked = false;
    enableToggle.disabled = true;
    enableToggle.title = 'Install voice first to enable';
    testBtn.disabled = true;
    uninstallBtn.disabled = true;
  }
}

window.husk.voice.onProgress(({ stage, detail }) => {
  const el = $('#voice-status');
  if (!el) return;
  if (stage === 'step') { el.textContent = detail; el.className = 'pref-status busy'; }
  else if (stage === 'done') { el.textContent = 'Voice ready'; el.className = 'pref-status ok'; }
  else if (stage === 'error') { el.textContent = `Error: ${detail}`; el.className = 'pref-status err'; }
});

$('#btn-voice-install').addEventListener('click', async () => {
  $('#btn-voice-install').disabled = true;
  toast('Downloading Piper and voice (~50 MB)…');
  const r = await window.husk.voice.install({ voice: $('#pref-voice-name').value || 'en_US-amy-medium' });
  $('#btn-voice-install').disabled = false;
  if (r.ok) { toast('Voice installed', 'success'); await refreshVoiceStatus(); }
  else toast(`Install failed: ${r.error}`, 'error');
});

$('#btn-voice-test').addEventListener('click', async () => {
  await speak('Husk voice test. The seed is ready.');
});

$('#btn-voice-uninstall').addEventListener('click', async () => {
  if (!confirm('Remove Piper binary and all installed voices? This deletes ~/.local/share/husk/piper/.')) return;
  $('#btn-voice-uninstall').disabled = true;
  const r = await window.husk.voice.uninstall();
  $('#btn-voice-uninstall').disabled = false;
  if (r.ok) {
    cfg = await window.husk.config.set({ voice: { ...(cfg.voice || {}), enabled: false } });
    toast('Voice uninstalled', 'success');
    await refreshVoiceStatus();
    bindPrefs();
  } else {
    toast(`Uninstall failed: ${r.error}`, 'error');
  }
});

$('#pref-voice-enabled').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ voice: { ...(cfg.voice || {}), enabled: e.target.checked } });
  toast(`Voice ${cfg.voice.enabled ? 'enabled' : 'disabled'}`, 'success');
  if (cfg.voice.enabled) speak('Voice enabled');
});
$('#pref-voice-name').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ voice: { ...(cfg.voice || {}), name: e.target.value } });
});
$('#pref-voice-rate').addEventListener('input', (e) => {
  $('#pref-voice-rate-display').textContent = `${Number(e.target.value).toFixed(1)}×`;
});
$('#pref-voice-rate').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ voice: { ...(cfg.voice || {}), rate: parseFloat(e.target.value) } });
});

async function speak(text) {
  if (!cfg || !cfg.voice || !cfg.voice.enabled) return;
  if (!text) return;
  await window.husk.voice.speak({ text, voice: cfg.voice.name, rate: cfg.voice.rate || 1.0 });
}

// Read the agent's spoken-summary line and pipe it into local TTS:
//   🗣️ <Name>: <one-line summary>     (PAI NATIVE/MINIMAL trailing line)
//   * recap: <one-line summary>        (Claude Code recap)
//
// The text is read from xterm's rendered grid rather than the raw byte stream,
// since a full-screen agent interleaves its UI chrome into the stream and only
// the final grid has each line on its own row. Output has to settle first, then
// the grid is scanned for the recap row. Spoken at most once per user turn, and
// each unique line at most once.
const SPOKEN_HISTORY_MAX = 32;
const RECAP_SCAN_ROWS = 80;
const spokenSet = new Set();
const spokenOrder = [];
// Speak at most one recap per user turn. Armed when the user submits input;
// disarmed once a recap is read. A terminal redraw (zoom / SIGWINCH re-paint)
// is not a new turn, so the recap is never re-read on a redraw.
let recapArmed = false;
function armRecap() { recapArmed = true; }
// After output stops streaming, wait this long with no further output before
// reading the grid, so the whole recap line is rendered, not a half line.
let speakSettleTimer = null;
const RECAP_SETTLE_MS = 1500;

// Dedup key is a fixed-length prefix of the normalised line, so a redraw that
// re-wraps the same line onto different columns still collapses onto one key.
function normalizeForDedup(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 60);
}
function recordSpoken(key) {
  if (spokenSet.has(key)) return false;
  spokenSet.add(key);
  spokenOrder.push(key);
  while (spokenOrder.length > SPOKEN_HISTORY_MAX) {
    const evicted = spokenOrder.shift();
    spokenSet.delete(evicted);
  }
  return true;
}
function resetSpeechState() {
  spokenSet.clear();
  spokenOrder.length = 0;
  if (speakSettleTimer) { clearTimeout(speakSettleTimer); speakSettleTimer = null; }
  recapArmed = false;
}
// Called on every PTY data chunk. While a turn is armed, (re)arm a short settle
// so the recap is read only after the reply stops streaming.
function detectAndSpeak() {
  if (!cfg || !cfg.voice || !cfg.voice.enabled) return;
  if (cfg.recap === false) return;
  if (!recapArmed) return;
  if (speakSettleTimer) clearTimeout(speakSettleTimer);
  speakSettleTimer = setTimeout(flushRecap, RECAP_SETTLE_MS);
}
async function flushRecap() {
  speakSettleTimer = null;
  if (!recapArmed) return;
  // Snapshot the last rows of the rendered grid (same approach as the autopilot
  // feed). translateToString(true) trims trailing cells; isWrapped marks a
  // soft-wrap continuation that the extractor joins back into one line.
  const rows = [];
  try {
    const b = term.buffer.active;
    const start = Math.max(0, b.length - RECAP_SCAN_ROWS);
    for (let y = start; y < b.length; y++) {
      const line = b.getLine(y);
      rows.push({ text: line ? line.translateToString(true) : '', wrapped: !!(line && line.isWrapped) });
    }
  } catch (_) { return; }
  let text = null;
  try { text = await window.husk.recap.extract(rows); } catch (_) { return; }
  if (!text) return;
  // Already-spoken line (e.g. the previous turn's recap still on screen before
  // this turn's reply renders): leave the turn armed so the new recap is read
  // once it appears.
  if (!recordSpoken(normalizeForDedup(text))) return;
  recapArmed = false;
  speak(text);
}
// Preferences is a page, and every entry point into it routes through here.
function openPrefs(section) {
  setPage('prefs');
  if (section) showPrefsSection(section);
}
function showPrefsSection(section) {
  $$('.prefs-nav-item').forEach((el) => el.classList.toggle('active', el.dataset.prefsSection === section));
  $$('.pref-section').forEach((el) => el.classList.toggle('active', el.dataset.prefsSection === section));
}
(function wirePrefs() {
  const nav = $('#prefs-nav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const item = e.target.closest('.prefs-nav-item');
      if (!item) return;
      showPrefsSection(item.dataset.prefsSection);
    });
  }
  $('#prefs-release-notes')?.addEventListener('click', async () => {
    let ver = '';
    try { ver = ((await window.husk.updates.get()) || {}).current || ''; } catch (_) {}
    if (!whatsNewFor(ver)) ver = latestWhatsNewVersion();
    if (ver) showWhatsNew(ver);
  });
  // Nothing pending is one click to recheck; anything pending opens the card
  // that carries the install, the manual steps and the release notes.
  $('#btn-pref-update-check')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (updateNeedsDetail(updateState || {})) {
      const pop = $('#update-pop');
      if (!pop) return;
      if (pop.hidden) openUpdatePop(); else pop.hidden = true;
      return;
    }
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await window.husk.updates.check(); } catch (_) {}
    btn.disabled = false;
  });
  $('#btn-pref-repo')?.addEventListener('click', () => {
    try { window.husk.urls.openExternal('https://github.com/DorShaer/Husk'); } catch (_) {}
  });
})();

// Orchestrator model routing, configured from the "Configure" button next to
// Start a run. The catalog is loaded from the active provider instead of a
// hardcoded list (Copilot/Claude/Gemini via /model, Aider via --list-models).
let orchCatalog = {
  loading: false,
  vendor: '',
  providerLabel: '',
  command: '',
  flag: '',
  models: [],
  source: 'none',
  sourceLabel: '',
  error: '',
};
function orchVendor() {
  return (cfg && cfg.agentCommand ? cfg.agentCommand : 'claude')
    .trim().split(/\s+/)[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}
function orchModelFlagFor(vendor) {
  return vendor === 'gemini' ? '-m'
    : ['claude', 'copilot', 'codex', 'aider', 'kiro-cli'].includes(vendor) ? '--model'
    : '';
}
function isUsableModelValue(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 90) return false;
  if (/\s/.test(raw)) return false;
  if (/not logged in|use \/login|authenticate|plan:|session:|aic used|context\b/i.test(raw)) return false;
  // Reject config-path and doc tokens (claude/settings.json, claude-api),
  // which are not model ids.
  if (/\.(json|jsonc|ya?ml|md|txt|log|lock|toml|ini|cfg|conf|sh|mjs|cjs|js|ts)$/i.test(raw)) return false;
  if (/(^|[-./_])(api|sdk|cli|docs?|settings|config|readme|help)$/i.test(raw)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(raw);
}
function orchSavedModels(vendor) {
  const mr = ((cfg && cfg.modelRouting) || {})[vendor] || {};
  return [mr.cheap, mr.smart].filter(isUsableModelValue).map((value) => ({ value, label: prettyModel(value) || value }));
}
function orchMergedModels(vendor) {
  const source = Array.isArray(orchCatalog.models) ? orchCatalog.models : [];
  const seen = new Set();
  const out = [];
  for (const m of source.concat(orchSavedModels(vendor))) {
    const value = String((m && m.value) || '').trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push({ value, label: String((m && m.label) || prettyModel(value) || value) });
  }
  return out;
}
function updateOrchCatalogStatus() {
  const status = $('#aut-model-status');
  if (!status) return;
  status.className = 'aut-model-status';
  if (orchCatalog.loading) {
    status.classList.add('is-loading');
    status.textContent = 'Checking available models...';
    return;
  }
  const count = Array.isArray(orchCatalog.models) ? orchCatalog.models.length : 0;
  if (count) {
    status.classList.add('is-live');
    status.textContent = `Loaded ${count} available model${count === 1 ? '' : 's'}`;
    return;
  }
  if (orchCatalog.error) {
    status.classList.add('is-error');
    status.textContent = orchCatalog.error;
    return;
  }
  status.textContent = 'No model catalog yet. Use Refresh models, or enter an exact model id manually.';
}
function orchCatalogReady() {
  return !orchCatalog.loading && Array.isArray(orchCatalog.models) && orchCatalog.models.length > 0;
}
function orchCatalogBusy() {
  return !!orchCatalog.loading;
}
function fillOrchSelect(sel, customInput, vendor, current) {
  if (!sel) return;
  current = isUsableModelValue(current) ? current : '';
  sel.replaceChildren();
  const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o); };
  const ready = orchCatalogReady();
  add('', ready ? 'Automatic (Husk decides)' : (orchCatalog.loading ? 'Loading models...' : 'No models loaded'));
  const models = orchMergedModels(vendor);
  if (models.length) {
    const group = document.createElement('optgroup');
    group.label = `${orchCatalog.providerLabel || vendor} models`;
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m.value;
      // The label names the model and the raw id lives in the tooltip, so a
      // long row stays inside the control's width.
      o.textContent = m.label || m.value;
      if (m.label !== m.value) o.title = m.value;
      group.appendChild(o);
    }
    sel.appendChild(group);
  }
  add('__custom__', 'Enter model id…');
  const known = models.some((m) => m.value === current);
  if (current && !known) { sel.value = '__custom__'; if (customInput) { customInput.value = current; customInput.hidden = false; } }
  else { sel.value = current || ''; if (customInput) { customInput.hidden = true; customInput.value = ''; } }
  sel.disabled = orchCatalogBusy();
  if (customInput) customInput.disabled = orchCatalogBusy();
}
function readOrchValue(sel, customInput) {
  if (!sel) return '';
  return sel.value === '__custom__' ? ((customInput && customInput.value) || '').trim() : (sel.value || '');
}
function bindOrchestratorConfig() {
  const vendor = orchVendor();
  const label = $('#aut-orch-vendor'); if (label) label.textContent = orchCatalog.providerLabel || vendor;
  const cmd = $('#aut-model-command');
  const flag = orchCatalog.flag || orchModelFlagFor(vendor);
  if (cmd) cmd.textContent = `${(cfg && cfg.agentCommand) || vendor}${flag ? ` · ${flag}` : ''}`;
  const mr = ((cfg && cfg.modelRouting) || {})[vendor] || {};
  fillOrchSelect($('#aut-mr-simple'), $('#aut-mr-simple-custom'), vendor, mr.cheap || '');
  fillOrchSelect($('#aut-mr-complex'), $('#aut-mr-complex-custom'), vendor, mr.smart || '');
  updateOrchCatalogStatus();
  const save = $('#aut-mr-save');
  if (save) save.disabled = orchCatalogBusy();
}
async function loadOrchModelCatalog(refresh = false) {
  const vendor = orchVendor();
  orchCatalog = {
    loading: true,
    vendor,
    providerLabel: vendor,
    command: (cfg && cfg.agentCommand) || vendor,
    flag: '',
    models: [],
    source: 'loading',
    sourceLabel: '',
    error: '',
  };
  bindOrchestratorConfig();
  const refreshBtn = $('#aut-model-refresh');
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const res = await window.husk.models.list({ refresh });
    orchCatalog = Object.assign({
      loading: false,
      vendor,
      providerLabel: vendor,
      command: (cfg && cfg.agentCommand) || vendor,
      flag: '',
      models: [],
      source: 'none',
      sourceLabel: '',
      error: '',
    }, res || {}, { loading: false });
  } catch (err) {
    orchCatalog = {
      loading: false,
      vendor,
      providerLabel: vendor,
      command: (cfg && cfg.agentCommand) || vendor,
      flag: '',
      models: [],
      source: 'error',
      sourceLabel: '',
      error: (err && err.message) || 'Could not read models.',
    };
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
    bindOrchestratorConfig();
  }
}
function wireOrchCustomToggle(sel, customInput) {
  if (!sel || !customInput) return;
  sel.addEventListener('change', () => {
    const isCustom = sel.value === '__custom__';
    customInput.hidden = !isCustom;
    if (isCustom) customInput.focus();
  });
}
wireOrchCustomToggle($('#aut-mr-simple'), $('#aut-mr-simple-custom'));
wireOrchCustomToggle($('#aut-mr-complex'), $('#aut-mr-complex-custom'));
function openOrchestratorModal() {
  if (autopilotActive) {
    toast('Model routing can only be changed before starting a run', 'info');
    return;
  }
  loadOrchModelCatalog(false);
  const m = $('#aut-orch-modal'); if (m) m.hidden = false;
}
function closeOrchestratorModal() {
  const m = $('#aut-orch-modal'); if (m) m.hidden = true;
}
$('#aut-configure-orch') && $('#aut-configure-orch').addEventListener('click', openOrchestratorModal);
$('#aut-orch-close') && $('#aut-orch-close').addEventListener('click', closeOrchestratorModal);
$('#aut-orch-cancel') && $('#aut-orch-cancel').addEventListener('click', closeOrchestratorModal);
$('#aut-model-refresh') && $('#aut-model-refresh').addEventListener('click', () => loadOrchModelCatalog(true));
if ($('#aut-mr-save')) {
  $('#aut-mr-save').addEventListener('click', async () => {
    const vendor = orchVendor();
    const cheap = readOrchValue($('#aut-mr-simple'), $('#aut-mr-simple-custom'));
    const smart = readOrchValue($('#aut-mr-complex'), $('#aut-mr-complex-custom'));
    if ((cheap && !isUsableModelValue(cheap)) || (smart && !isUsableModelValue(smart))) {
      toast('Enter a model id only, not status text or CLI output.', 'error');
      return;
    }
    const mr = Object.assign({}, (cfg && cfg.modelRouting) || {});
    const flag = orchCatalog.flag || orchModelFlagFor(vendor);
    const entry = Object.assign({}, (cheap || smart) && flag ? { flag } : {}, cheap ? { cheap } : {}, smart ? { smart } : {});
    if (Object.keys(entry).length) mr[vendor] = entry; else delete mr[vendor];
    cfg = await window.husk.config.set({ modelRouting: mr });
    closeOrchestratorModal();
    toast('Model routing saved', 'success');
  });
}
// Picking a detected command fills the field; Custom hands the field back.
$('#pref-agent-pick') && $('#pref-agent-pick').addEventListener('change', function () {
  const field = $('#pref-agent');
  if (!field) return;
  if (this.value === PREF_AGENT_CUSTOM) {
    field.hidden = false;
    field.focus();
    return;
  }
  field.hidden = true;
  field.value = this.value;
});
$('#pref-save').addEventListener('click', async () => {
  const name = ($('#pref-agent-name').value || '').trim().slice(0, 40) || 'Husk';
  const cwdInput = $('#pref-agent-cwd');
  const agentCwd = cwdInput ? cwdInput.value.trim() : '';
  cfg = await window.husk.config.set({
    agentCommand: $('#pref-agent').value.trim(),
    agentName: name,
    agentCwd,
  });
  bindPrefs();
  renderSkills();
  updateAgentPill();
  paintAgentMenu();
  toast('Saved, restarting agent', 'success');
  await restartPty();
});

// Folder picker for the working directory field.
{
  const pickBtn = document.getElementById('btn-pref-cwd-pick');
  if (pickBtn) {
    pickBtn.addEventListener('click', async () => {
      try {
        const picked = await window.husk.dialog2.pickDir();
        if (picked && $('#pref-agent-cwd')) $('#pref-agent-cwd').value = picked;
      } catch (_) {}
    });
  }
}
$('#pref-theme').addEventListener('change', (e) => {
  previewAppearance({ theme: e.target.value });
});
$$('.accent-swatch').forEach((sw) => sw.addEventListener('click', () => {
  previewAppearance({ accent: sw.dataset.c });
}));
$('#pref-rail').addEventListener('change', (e) => {
  previewAppearance({ railExpanded: e.target.checked });
});
$('#pref-appearance-save')?.addEventListener('click', saveAppearancePreview);
$('#pref-appearance-revert')?.addEventListener('click', revertAppearancePreview);
$('#pref-replay-onboarding')?.addEventListener('click', () => runOnboarding({ replay: true }));
$('#pref-root').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ treeRoot: e.target.value.trim() || cfg.treeRoot });
  toast('Tree root saved', 'success');
});
$('#pref-hidden').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ showHidden: e.target.checked });
  toast('Saved', 'success');
});
$('#pref-recap').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ recap: e.target.checked });
  toastRestart(`Recap ${cfg.recap ? 'enabled' : 'disabled'}`);
});
$('#pref-pai') && $('#pref-pai').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ paiEnabled: e.target.checked });
  const msg = cfg.paiEnabled
    ? 'LifeOS enabled · restart Husk to bootstrap, restart agent to load it'
    : 'LifeOS disabled · restart agent to drop the prompt; existing ~/.claude/ files left in place';
  toast(msg, 'success');
});

// ─── Updates (Preferences > About) ──────────────────────────────────────────────
// The version and its update action live on the About row: idle, checking,
// up-to-date, available, downloading (n%), ready (restart to install), error.
// The dot pulses only when there's something for the user to do.
let updateState = { status: 'idle', current: 'v?' };

// States that carry more than a one-word action, so the button opens the card
// that explains them instead of firing another check.
function updateNeedsDetail(s) {
  if (s.dev) return true;
  if (s.status === 'available' || s.status === 'downloading' || s.status === 'ready') return true;
  return s.status === 'error' && s.phase === 'install';
}

// The Preferences nav stamp and its About row read the same update state.
function paintPrefsVersion() {
  const s = updateState || { status: 'idle' };
  const cur = s.current ? (s.current.startsWith('v') ? s.current : 'v' + s.current) : '';
  const stamp = $('#prefs-version');
  if (stamp) stamp.textContent = cur ? `Husk ${cur}` : 'Husk';
  const next = s.version ? ('v' + s.version) : '';
  const el = $('#pref-about-version');
  if (el) {
    let label = cur || 'version unknown';
    if (s.status === 'checking') label = 'checking…';
    else if (s.status === 'available' && next) label = `${next} available`;
    else if (s.status === 'downloading') label = `downloading ${s.percent || 0}%`;
    else if (s.status === 'ready') label = 'restart to update';
    el.textContent = label;
    el.className = s.status === 'error' ? 'pref-status err' : 'pref-status';
  }
  const btn = $('#btn-pref-update-check');
  if (!btn) return;
  const text = $('#tv-text');
  const dot = btn.querySelector('.tv-dot');
  let label = 'Check now';
  let title = 'Look for a new version';
  let showDot = false;
  switch (s.status) {
    case 'checking':
      label = 'Checking…'; title = 'Looking for a new version'; break;
    case 'available':
      label = 'Install update'; title = `Update from ${cur} to ${next}`; showDot = true; break;
    case 'downloading':
      label = `Downloading ${s.percent || 0}%`; title = 'Downloading update'; break;
    case 'ready':
      label = 'Restart and install'; title = `${next} ready, click to install and relaunch`; showDot = true; break;
    case 'up-to-date':
      title = `You're up to date (${cur}), click to recheck`; break;
    case 'error':
      title = `Update check failed: ${s.error || 'unknown'}`; break;
    default:
      break;
  }
  if (s.dev) { label = 'Releases'; title = 'Auto-update only runs in packaged builds'; }
  if (text) text.textContent = label;
  btn.title = title;
  btn.dataset.state = s.status;
  if (dot) dot.hidden = !showDot;
}
function openUpdatePop() {
  const pop = $('#update-pop');
  if (!pop) return;
  const s = updateState;
  const cur = s.current && (s.current.startsWith('v') ? s.current : 'v' + s.current);
  const next = s.version ? ('v' + s.version) : '';
  const title = $('#up-title');
  const body = $('#up-body');
  const cta = $('#up-cta');
  const notesBtn = $('#up-notes');
  // Every render starts from a clean, enabled CTA, so a status change
  // re-enables the button the download click disabled.
  cta.disabled = false;
  notesBtn.hidden = !s.url;
  notesBtn.onclick = () => { window.husk.updates.openRelease(s.url); pop.hidden = true; };
  if (s.dev) {
    title.textContent = 'Auto-update disabled in dev mode';
    // eslint-disable-next-line no-unsanitized/property -- Dynamic values are escaped, remaining markup is static.
    body.innerHTML = `Running from source as <strong>${escapeHtml(cur)}</strong>. Auto-update only runs in packaged builds. Install the latest release to get update notifications in-app.`;
    cta.textContent = 'Open releases page';
    cta.onclick = () => { window.husk.updates.openRelease(); pop.hidden = true; };
    pop.hidden = false;
    return;
  }
  if (s.status === 'available') {
    title.textContent = `Husk ${next} is available`;
    if (isMac) {
      // macOS updates by hand: send the user to the dmg download and show the
      // quarantine command that lets Gatekeeper open the new build.
      // eslint-disable-next-line no-unsanitized/property -- Dynamic values are escaped, the command is a static constant.
      body.innerHTML = `You're on <strong>${escapeHtml(cur)}</strong>. Husk for macOS isn't code-signed yet, so update manually: download the new build, replace the app, then run this once so macOS will open it:`
        + `<div class="up-cmd"><code>${escapeHtml(MAC_TRUST_CMD)}</code><button class="ghost-btn up-copy" id="up-trust-copy" type="button">Copy</button></div>`;
      const copyBtn = $('#up-trust-copy');
      if (copyBtn) copyBtn.onclick = () => { try { navigator.clipboard.writeText(MAC_TRUST_CMD); copyBtn.textContent = 'Copied'; } catch (_) {} };
      cta.textContent = 'Download for Mac';
      cta.onclick = () => { window.husk.updates.openRelease(s.url); pop.hidden = true; };
    } else {
      // eslint-disable-next-line no-unsanitized/property -- Dynamic values are escaped, remaining markup is static.
      body.innerHTML = `You're on <strong>${escapeHtml(cur)}</strong>. The new version is ready to install.`;
      cta.textContent = 'Install update';
      cta.onclick = async () => {
        cta.disabled = true; cta.textContent = 'Downloading…';
        const r = await window.husk.updates.download();
        if (!r.ok) {
          // Auto-download not supported here (e.g. .deb / .rpm).
          cta.textContent = 'Open releases page';
          cta.disabled = false;
          cta.onclick = () => { window.husk.updates.openRelease(s.url); pop.hidden = true; };
        }
      };
    }
  } else if (s.status === 'ready') {
    title.textContent = `Husk ${next} is ready`;
    // On deb/rpm the install runs through the package manager as root, so the
    // desktop raises a password prompt. Say so before it appears, otherwise an
    // unexplained prompt reads as something to dismiss.
    const needsAuth = s.packageType === 'deb' || s.packageType === 'rpm';
    body.textContent = needsAuth
      ? 'Husk will ask for your password to install the update, then close and reopen. Your current chat will end.'
      : 'Husk will close and reopen to finish installing. Your current chat will end.';
    cta.textContent = 'Restart and install';
    cta.onclick = () => {
      cta.disabled = true;
      cta.textContent = needsAuth ? 'Waiting for your password…' : 'Installing…';
      window.husk.updates.install();
    };
  } else if (s.status === 'downloading') {
    title.textContent = `Downloading ${next}`;
    // eslint-disable-next-line no-unsanitized/property -- Progress value is escaped before insertion.
    body.innerHTML = `${escapeHtml(s.percent || 0)}% ... please don't quit Husk.`;
    cta.textContent = 'Close';
    cta.onclick = () => { pop.hidden = true; };
  } else if (s.status === 'up-to-date') {
    title.textContent = "You're up to date";
    // eslint-disable-next-line no-unsanitized/property -- Dynamic values are escaped, remaining markup is static.
    body.innerHTML = `Running <strong>${escapeHtml(cur)}</strong>. Husk checks again every six hours.`;
    cta.textContent = 'Check now';
    cta.onclick = async () => {
      cta.disabled = true;
      await window.husk.updates.check();
      cta.disabled = false;
    };
  } else if (s.status === 'error' && s.phase === 'install') {
    // A failed install reports what went wrong and hands over the exact command
    // that completes the update by hand.
    title.textContent = 'Could not install the update';
    const manual = MANUAL_UPDATE_CMD[s.packageType] || '';
    let html = `Husk downloaded ${escapeHtml(next || 'the update')} but could not install it: <strong>${escapeHtml(s.error || 'unknown error')}</strong>.`;
    if (manual) {
      html += ` You can finish it yourself:`
        + `<div class="up-cmd"><code>${escapeHtml(manual)}</code><button class="ghost-btn up-copy" id="up-manual-copy" type="button">Copy</button></div>`;
    }
    if (s.logPath) html += `<div class="up-note">Details: ${escapeHtml(s.logPath)}</div>`;
    // eslint-disable-next-line no-unsanitized/property -- Dynamic values are escaped, remaining markup is static.
    body.innerHTML = html;
    const copyBtn = $('#up-manual-copy');
    if (copyBtn) copyBtn.onclick = () => {
      try { navigator.clipboard.writeText(manual); copyBtn.textContent = 'Copied'; } catch (_) {}
    };
    cta.textContent = 'Download from GitHub';
    cta.onclick = () => { window.husk.updates.openRelease(s.url); pop.hidden = true; };
  } else {
    title.textContent = 'Updates';
    // eslint-disable-next-line no-unsanitized/property -- Dynamic values are escaped, remaining markup is static.
    body.innerHTML = s.status === 'checking'
      ? 'Looking for a new version…'
      : (s.error
          ? `Update check failed: ${escapeHtml(s.error)}.`
          : `Running <strong>${escapeHtml(cur || 'Husk')}</strong>.`);
    cta.textContent = 'Check now';
    cta.onclick = async () => {
      cta.disabled = true;
      await window.husk.updates.check();
      cta.disabled = false;
    };
  }
  pop.hidden = false;
}
{
  const close = $('#up-close');
  if (close) close.addEventListener('click', () => { const p = $('#update-pop'); if (p) p.hidden = true; });
  window.addEventListener('click', (e) => {
    const pop = $('#update-pop');
    if (!pop || pop.hidden) return;
    if (e.target.closest('#update-pop') || e.target.closest('#btn-pref-update-check')) return;
    pop.hidden = true;
  });
}
window.husk.updates.onStatus((s) => {
  updateState = s;
  paintPrefsVersion();
  const pop = $('#update-pop');
  if (pop && !pop.hidden) openUpdatePop();
});
(async () => {
  try { updateState = (await window.husk.updates.get()) || updateState; } catch (_) {}
  paintPrefsVersion();
})();

// ─── Topbar buttons ─────────────────────────────────────────────────────────────
$('#btn-restart').addEventListener('click', restartPty);
// Theme selection lives only in Preferences (full picker).
// Attaching a file puts its absolute path in the agent's input and stops there,
// quoted when it holds whitespace. Nothing is submitted, so the user types their
// question and presses Enter. The rule for what may reach a live prompt lives in
// src/lib/terminal-safe.js, shared with the main process.
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/;

function chatFileRef(filePath) {
  return window.husk.text.chatFileRef(filePath);
}


async function attachFileToChat(filePath) {
  const ref = chatFileRef(filePath);
  if (!ref.trim()) {
    if (String(filePath || '') && CONTROL_CHARS_RE.test(String(filePath))) {
      toast('That file name contains control characters, so it was not sent to the agent.', 'error');
    }
    return;
  }
  // The welcome screen can still be up over a running chat, so a live tab
  // means write to it and clear the overlay.
  if (!TABS.size && $('#chat-empty')?.classList.contains('show')) {
    await launchAgent({ initialPrompt: ref });
    return;
  }
  $('#chat-empty').classList.remove('show');
  setPage('chat');
  setTimeout(() => {
    try { window.husk.pty.write(ref); } catch (_) {}
    try { term.focus(); } catch (_) {}
  }, 60);
}

// ─── "In context" list ──────────────────────────────────────────────────────────
// Tracks files the user shared with the agent during this Husk session only.
// The context directory on disk is never enumerated, so the pane reflects what
// was shared with this agent now rather than everything ever written.
const sessionContext = [];
function addToSessionContext({ name, path }) {
  if (!path) return;
  // De-dup by path: if already present, move it to the top.
  const idx = sessionContext.findIndex((f) => f.path === path);
  if (idx !== -1) sessionContext.splice(idx, 1);
  sessionContext.unshift({ name, path, sharedAt: Date.now() });
  refreshContextList();
}
function removeFromSessionContext(filePath) {
  const idx = sessionContext.findIndex((f) => f.path === filePath);
  if (idx !== -1) sessionContext.splice(idx, 1);
  refreshContextList();
}
function clearSessionContext() {
  sessionContext.length = 0;
  refreshContextList();
}
// Every share, drop and removal lands in the context pane's In context section.
function refreshContextList() {
  refreshArtifactPane();
}
async function attachContextSource(sourcePath, name, successLabel = 'Attached') {
  const result = await window.husk.fs.dropFile({ sourcePath, kind: 'context' });
  if (result.ok) {
    toast(`${successLabel}: ${name}`, 'success');
    addToSessionContext({ name, path: result.dest });
    await attachFileToChat(result.dest);
  } else {
    toast(`Failed: ${result.error}`, 'error');
  }
  return result;
}
async function shareFilesViaPicker() {
  const paths = await window.husk.dialog.pickFile();
  if (!paths || !paths.length) return;
  for (const p of paths) {
    const name = p.split('/').pop();
    await attachContextSource(p, name);
  }
}
$('#btn-context-add').addEventListener('click', shareFilesViaPicker);

// ─── Rail "Recent" sessions list ────────────────────────────────────────────────
const RAIL_RECENT_MAX = 5;
async function refreshRecentList() {
  const wrap = $('#rail-recent-list');
  const section = $('#rail-recent');
  if (!wrap || !section) return;
  const r = await window.husk.sessions.list();
  if (!r.ok || !r.sessions || !r.sessions.length) {
    section.hidden = true;
    return;
  }
  // Scope Recent to the active chat's project. The full Sessions page still
  // lists every project; the rail should only surface this project's chats, so
  // a session from another cwd (e.g. a "Hi" chat in $HOME) never shows here.
  const norm = (p) => (p || '').replace(/\/+$/, '');
  const here = norm(r.currentCwd);
  const scoped = here
    ? r.sessions.filter((s) => norm(s.originalCwd || s.projectPath || s.cwd) === here)
    : r.sessions;
  if (!scoped.length) {
    section.hidden = true;
    return;
  }
  const top = scoped.slice(0, RAIL_RECENT_MAX);
  section.hidden = false;
  // eslint-disable-next-line no-unsanitized/property -- Recent session fields are escaped via escapeHtml/escapeAttr.
  wrap.innerHTML = top.map((s) => `
    <div class="rail-recent-item" data-id="${escapeAttr(s.id)}" data-project="${escapeAttr(s.projectPath)}" data-owner="${escapeAttr(r.agent || '')}" title="${escapeAttr(s.title)}\n${escapeAttr(s.projectPath)}">
      <span class="rri-title">${escapeHtml(s.title)}</span>
      <span class="rri-meta">${escapeHtml(timeAgo(s.mtime))}</span>
    </div>
  `).join('');
  wrap.querySelectorAll('.rail-recent-item').forEach((el) => {
    el.addEventListener('click', () => {
      resumeSessionInChat({ id: el.dataset.id, project: el.dataset.project, owner: el.dataset.owner });
    });
  });
  animateRecentTitles(wrap, top);
}

// Presentation pass over the freshly painted Recent list: a just-active
// session that has no real name yet breathes thinking dots, and the first
// paint of its earned name types in. Older unnamed sessions keep their
// placeholder text (nothing is brewing for them anymore).
const railTitleSeen = new Map(); // session id -> last title painted
const RAIL_NAMING_WINDOW_MS = 3 * 60 * 1000;
function animateRecentTitles(wrap, sessions) {
  const alive = new Set();
  for (const s of sessions) {
    alive.add(s.id);
    const titleEl = wrap.querySelector(`.rail-recent-item[data-id="${escapeAttr(s.id)}"] .rri-title`);
    if (!titleEl) continue;
    const prev = railTitleSeen.get(s.id);
    railTitleSeen.set(s.id, { title: s.title, named: !!s.named });
    if (!s.named) {
      // No generated name yet: a session with fresh activity breathes dots
      // (its name is brewing); a stale one keeps its placeholder text.
      const active = Date.now() - (Number(s.mtime) || 0) < RAIL_NAMING_WINDOW_MS;
      if (active) showThinkingDots(titleEl);
      continue;
    }
    // First paint of the generated name after the unnamed phase: type it in.
    if (prev !== undefined && !prev.named) {
      try { typewriterTo(titleEl, s.title); } catch (_) {}
    }
  }
  for (const id of railTitleSeen.keys()) if (!alive.has(id)) railTitleSeen.delete(id);
}
$('#btn-recent-all').addEventListener('click', () => setPage('sessions'));

// ─── Chats panel (sessions list in sidebar on chat page) ─────────────────────────
async function renderChatsPanelSessions() {
  const container = $('#cp-sessions');
  if (!container) return;
  const r = await window.husk.sessions.list();
  if (!r.ok || !r.sessions || !r.sessions.length) {
    container.innerHTML = '<div class="cp-empty">No sessions yet.<br/>Start a chat to see history here.</div>';
    return;
  }
  const top = r.sessions.slice(0, 40);
  // eslint-disable-next-line no-unsanitized/property -- Session fields are escaped.
  container.innerHTML = top.map((s) => `
    <div class="cp-session-item" data-id="${escapeAttr(s.id)}" data-project="${escapeAttr(s.projectPath || '')}" data-owner="${escapeAttr(r.agent || '')}">
      <span class="cp-si-title">${escapeHtml(s.title || 'Untitled chat')}</span>
      <span class="cp-si-meta">${escapeHtml(timeAgo(s.mtime))}</span>
    </div>
  `).join('');
  container.querySelectorAll('.cp-session-item').forEach((el) => {
    el.addEventListener('click', () => {
      resumeSessionInChat({ id: el.dataset.id, project: el.dataset.project, owner: el.dataset.owner });
    });
  });
}
(function wireChatsPanelButtons() {
  const btnNew = $('#btn-cp-new');
  if (btnNew) btnNew.addEventListener('click', () => openNewChatTab());

  const searchInput = $('#cp-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(async (e) => {
      const q = e.target.value.trim().toLowerCase();
      const items = $('#cp-sessions')?.querySelectorAll('.cp-session-item');
      if (!items) return;
      items.forEach((el) => {
        const title = el.querySelector('.cp-si-title')?.textContent || '';
        el.style.display = title.toLowerCase().includes(q) ? '' : 'none';
      });
    }, 100));
  }

  const btnAddCtx = $('#ce-btn-add-context');
  if (btnAddCtx) btnAddCtx.addEventListener('click', () => { $('#btn-context-add')?.click(); });
  // Add-context from the chat header button (top-right, left of Autopilot).
  $('#btn-head-add-context')?.addEventListener('click', () => { $('#btn-context-add')?.click(); });

  const btnPickTool = $('#ce-btn-pick-tool');
  if (btnPickTool) {
    btnPickTool.addEventListener('click', () => {
      const pill = $('.rail-agent');
      if (pill) pill.click();
    });
    // Sync tool name label with current agent
    // Initial sync happens in boot() after cfg loads.
  }
})();

// ─── MCP page ───────────────────────────────────────────────────────────────────
let mcpCatalog = [];
let mcpInstalled = [];
// Snapshot of which MCPs were enabled when the current PTY session started.
// Still-enabled members of this set are "Loaded"; anything enabled outside it
// is "Pending" and applies on the next agent restart.
const loadedMcpSnapshot = new Set();
function snapshotLoadedMcps(servers) {
  loadedMcpSnapshot.clear();
  (servers || []).forEach((s) => { if (s.enabled) loadedMcpSnapshot.add(s.id); });
  refreshLoadedMcpsBadge();
  // If the user is on the MCP page, repaint so Pending → Loaded transitions
  // visibly without needing to navigate away and back.
  if (currentPage === 'mcp') paintMcpSections();
}
// Live connection status from the active agent's CLI, as id -> 'connected' |
// 'failed' | 'auth' | 'disabled'. An agent with no health command gets a
// neutral "configured" pill on those rows instead.
let mcpHealth = {};
let mcpHealthLoading = false;
let mcpSupportsLiveStatus = true;
let mcpAdapterAgent = 'claude';
let mcpAdapterUnsupported = false;
async function reloadMcpInventory() {
  if (!mcpCatalog.length) mcpCatalog = (await window.husk.mcp.catalog()) || [];
  const r = await window.husk.mcp.list();
  mcpInstalled = (r && r.servers) || [];
  mcpSupportsLiveStatus = !!(r && r.supportsLiveStatus);
  mcpAdapterAgent = (r && r.agent) || 'claude';
  mcpAdapterUnsupported = !!(r && r.unsupported);
  return mcpInstalled;
}
async function reloadMcpHealth() {
  if (mcpHealthLoading) return;
  mcpHealthLoading = true;
  try {
    const r = await window.husk.mcp.health();
    mcpHealth = (r && r.status) || {};
  } catch (_) { mcpHealth = {}; }
  finally {
    mcpHealthLoading = false;
    if (currentPage === 'mcp') paintMcpSections();
  }
}
// Which folder the MCP page is editing. 'global' edits the list every folder
// inherits; a project scope edits only which of those servers that one folder
// runs. Server definitions always live in the global list, so Add / Edit /
// Remove stay global whatever the scope.
let mcpScope = 'global';
let mcpProject = null;   // { id, name, path } when scoped to a project
let mcpProjectState = null; // last projectMcp:get result

function mcpActiveProject() {
  if (!activeProjectId) return null;
  const p = projectsCache.find((x) => x && x.id === activeProjectId);
  return (p && p.path) ? p : null;
}

async function reloadMcpProjectState() {
  // The MCP page can be opened without the Projects page ever having painted,
  // so the cache it fills is not something this can wait for.
  if (!projectsCache.length) {
    try {
      const res = await window.husk.projects.list();
      projectsCache = (res && res.projects) || [];
      activeProjectId = (res && res.activeProjectId) || null;
    } catch (_) {}
  }
  mcpProject = mcpActiveProject();
  if (!mcpProject) { mcpScope = 'global'; mcpProjectState = null; return; }
  try { mcpProjectState = await window.husk.mcp.projectGet(mcpProject.path); }
  catch (_) { mcpProjectState = null; }
}

function mcpRowState(id) {
  const rows = (mcpProjectState && mcpProjectState.rows) || [];
  const row = rows.find((r) => r.id === id);
  return row ? row.state : 'inherit';
}

function paintMcpScope() {
  const bar = $('#mcp-scope');
  if (!bar) return;
  // Nothing to scope to until a project is open.
  if (!mcpProject) { bar.hidden = true; return; }
  bar.hidden = false;
  const unsupported = mcpProjectState && mcpProjectState.supported === false;
  const seg = (key, label) =>
    `<button class="mcp-scope-btn${mcpScope === key ? ' on' : ''}" data-scope="${key}">${escapeHtml(label)}</button>`;
  const note = mcpScope === 'project'
    ? (unsupported
      ? `<span class="mcp-scope-note mcp-scope-warn">${escapeHtml(mcpAdapterAgent)} has no per-folder switch, so this list applies everywhere for now.</span>`
      : '<span class="mcp-scope-note">Servers not set here follow the global list.</span>')
    : '<span class="mcp-scope-note">Applies to every folder that does not override it.</span>';
  const reset = (mcpScope === 'project' && mcpProjectState && mcpProjectState.customized)
    ? '<button class="ghost-btn mcp-scope-reset" id="mcp-scope-reset">Reset to global</button>'
    : '';
  // eslint-disable-next-line no-unsanitized/property -- Labels go through escapeHtml.
  bar.innerHTML = `<div class="mcp-scope-seg">${seg('global', 'Everywhere')}${seg('project', mcpProject.name || 'This project')}</div>${note}${reset}`;
  bar.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', async () => {
    mcpScope = b.dataset.scope;
    await renderMcp();
  }));
  const resetBtn = $('#mcp-scope-reset');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    await window.husk.mcp.projectClear(mcpProject.path);
    notify(`${mcpProject.name} follows the global MCP list again`, { kind: 'success' });
    await renderMcp();
  });
}

async function renderMcp() {
  await reloadMcpInventory();
  await reloadMcpProjectState();
  paintMcpScope();
  paintMcpSections();
  paintMcpCatalog();
  // Kick off a fresh health probe in the background. The probe shells out
  // to `claude mcp list` which can take a few seconds for HTTP servers, so
  // we don't await it: the UI repaints when the result lands.
  reloadMcpHealth();
}
function healthBadgeHTML(id, enabled) {
  if (!enabled) return '';
  const h = mcpHealth[id];
  if (!h) {
    if (mcpHealthLoading) return '<span class="mcp-health mcp-health-loading" title="Checking connection…">checking…</span>';
    // An agent with no health probe gets a neutral pill rather than a claim
    // about the row's state.
    if (!mcpSupportsLiveStatus) {
      return '<span class="mcp-health mcp-health-configured" title="Configured in this agent. Husk cannot fetch live status for this CLI.">configured</span>';
    }
    return '<span class="mcp-health mcp-health-unknown" title="Configured but the CLI did not return a status">unknown</span>';
  }
  if (h === 'connected') return '<span class="mcp-health mcp-health-ok" title="Connected">connected</span>';
  if (h === 'failed')    return '<span class="mcp-health mcp-health-err" title="Failed to connect">failed</span>';
  if (h === 'auth')      return '<span class="mcp-health mcp-health-warn" title="Server requires authentication">needs auth</span>';
  if (h === 'disabled')  return '<span class="mcp-health mcp-health-unknown" title="Disabled in the CLI config">disabled</span>';
  return `<span class="mcp-health mcp-health-unknown">${escapeHtml(h)}</span>`;
}
function mcpRowHTML(s) {
  const cat = mcpCatalog.find((c) => c.id === s.id);
  const icon = cat ? cat.icon : '⊟';
  const detail = (s.transport === 'http' || s.transport === 'sse')
    ? `${s.transport.toUpperCase()} · ${s.url || ''}`
    : `${s.command || ''} ${(s.args || []).join(' ')}`.trim();
  // In project scope the row answers whether this folder runs the server, so
  // the on/off toggle becomes a three-way that can defer to the global list.
  // Edit and Remove are global actions and stay out of that scope.
  if (mcpScope === 'project' && mcpProject) {
    const rows = (mcpProjectState && mcpProjectState.rows) || [];
    const row = rows.find((r) => r.id === s.id) || { on: s.enabled !== false, state: 'inherit', globallyOn: s.enabled !== false };
    const inheritLabel = row.globallyOn ? 'Default · on' : 'Default · off';
    const seg = (key, label, title) =>
      `<button class="mr-tri-btn${row.state === key ? ' on' : ''}" data-tri="${key}" title="${escapeAttr(title)}">${escapeHtml(label)}</button>`;
    return `
      <div class="mcp-row${row.on ? '' : ' disabled'}" data-id="${escapeAttr(s.id)}">
        <span class="mr-icon">${escapeHtml(icon)}</span>
        <div class="mr-info">
          <span class="mr-name">${escapeHtml(s.id)}${row.source === 'project' ? '<span class="mr-tag">project</span>' : ''}</span>
          <span class="mr-cmd">${escapeHtml(detail)}</span>
        </div>
        <div class="mr-actions mr-tri">
          ${seg('off', 'Off', `Never run ${s.id} in this project`)}
          ${seg('inherit', inheritLabel, 'Follow the global list')}
          ${seg('on', 'On', `Always run ${s.id} in this project`)}
        </div>
      </div>`;
  }

  const badge = healthBadgeHTML(s.id, s.enabled);
  return `
    <div class="mcp-row${s.enabled ? '' : ' disabled'}" data-id="${escapeAttr(s.id)}">
      <span class="mr-icon">${escapeHtml(icon)}</span>
      <div class="mr-info">
        <span class="mr-name">${escapeHtml(s.id)} ${badge}</span>
        <span class="mr-cmd">${escapeHtml(detail)}</span>
      </div>
      <div class="mr-actions">
        <button class="mr-edit" data-edit="1" title="Edit" aria-label="Edit MCP server">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
        <button class="toggle ${s.enabled ? 'on' : ''}" data-toggle="1" title="${s.enabled ? 'Disable' : 'Enable'}"></button>
        <button class="mr-remove" data-remove="1" title="Remove">×</button>
      </div>
    </div>`;
}
// Settle an MCP change after install / toggle / remove: refresh the inventory
// and repaint the page so the row shows Loaded or Pending.
async function applyMcpChange(label) {
  const inv = await reloadMcpInventory();
  if (!TABS.size) {
    // No live agent yet. Snapshot lazily; whenever the user clicks Launch /
    // Start building, the new MCPs load on first start (shown as Loaded).
    snapshotLoadedMcps(inv);
    if (currentPage === 'mcp') paintMcpSections();
    return;
  }
  // With a PTY live the running agent is left untouched, so an unsent draft in
  // the chat input survives. The change shows as Pending and applies on the
  // next agent restart, which is when the snapshot is recaptured.
  if (currentPage === 'mcp') paintMcpSections();
  toastRestart(`${label || 'MCP change'} saved`);
}

function bindMcpRows(scope) {
  scope.querySelectorAll('.mcp-row').forEach((row) => {
    const t = row.querySelector('[data-toggle]');
    const e = row.querySelector('[data-edit]');
    const x = row.querySelector('[data-remove]');
    if (t) t.addEventListener('click', async () => {
      const r = await window.husk.mcp.toggle(row.dataset.id);
      if (!r.ok) { toast(r.error || 'Toggle failed', 'error'); return; }
      toast(`${row.dataset.id} ${r.enabled ? 'enabled' : 'disabled'}`, 'success');
      await renderMcp();
      applyMcpChange(row.dataset.id);
    });
    if (e) e.addEventListener('click', () => {
      const server = mcpInstalled.find((s) => s.id === row.dataset.id);
      if (server) openMcpEditModal(server);
    });
    if (x) x.addEventListener('click', async () => {
      if (!confirm(`Remove MCP server "${row.dataset.id}"?`)) return;
      const r = await window.husk.mcp.remove(row.dataset.id);
      if (!r.ok) { toast(r.error || 'Remove failed', 'error'); return; }
      toast(`Removed ${row.dataset.id}`, 'success');
      await renderMcp();
      applyMcpChange(row.dataset.id);
    });
    row.querySelectorAll('[data-tri]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!mcpProject) return;
      const r = await window.husk.mcp.projectSet({ path: mcpProject.path, id: row.dataset.id, state: btn.dataset.tri });
      if (!r || !r.ok) { toast((r && r.error) || 'Could not save', 'error'); return; }
      await renderMcp();
      // The set only reaches the agent at launch, so say so rather than
      // implying the running session just changed.
      applyMcpChange(row.dataset.id);
    }));
  });
}
function paintMcpSections() {
  const wrap = $('#mcp-installed');
  const head = $('#mcp-installed-head');
  if (head) head.textContent = mcpScope === 'project' && mcpProject ? `Running in ${mcpProject.name}` : 'Installed';

  if (!mcpInstalled.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="es-icon">⊟</div><div class="es-msg">No MCP servers yet. Pick one below to give the agent a new ability.</div></div>';
    return;
  }

  if (mcpScope === 'project' && mcpProject) {
    // Project scope splits on what this folder ends up running, not on the
    // global on/off, because that is the question the scope is here to answer.
    const rows = (mcpProjectState && mcpProjectState.rows) || [];
    const on = mcpInstalled.filter((s) => (rows.find((r) => r.id === s.id) || {}).on);
    const off = mcpInstalled.filter((s) => !(rows.find((r) => r.id === s.id) || {}).on);
    let phtml = '';
    if (on.length) {
      phtml += '<div class="mcp-subhead"><span class="mcp-dot mcp-dot-on"></span>On in this project</div>';
      phtml += on.map((s) => mcpRowHTML(s)).join('');
    }
    if (off.length) {
      phtml += '<div class="mcp-subhead"><span class="mcp-dot mcp-dot-off"></span>Off in this project</div>';
      phtml += off.map((s) => mcpRowHTML(s)).join('');
    }
    // eslint-disable-next-line no-unsanitized/property -- MCP row templates escape dynamic values.
    wrap.innerHTML = phtml;
    bindMcpRows(wrap);
    return;
  }

  const enabled = mcpInstalled.filter((s) => s.enabled);
  const disabled = mcpInstalled.filter((s) => !s.enabled);
  const loaded   = enabled.filter((s) => loadedMcpSnapshot.has(s.id));
  const pending  = enabled.filter((s) => !loadedMcpSnapshot.has(s.id));

  let html = '';
  if (loaded.length) {
    html += `<div class="mcp-subhead"><span class="mcp-dot mcp-dot-on"></span>Loaded · live in current chat</div>`;
    html += loaded.map((s) => mcpRowHTML(s)).join('');
  }
  if (pending.length) {
    html += `<div class="mcp-subhead"><span class="mcp-dot mcp-dot-pending"></span>Applying · agent reload pending</div>`;
    html += pending.map((s) => mcpRowHTML(s)).join('');
  }
  if (disabled.length) {
    html += `<div class="mcp-subhead"><span class="mcp-dot mcp-dot-off"></span>Inactive · turned off</div>`;
    html += disabled.map((s) => mcpRowHTML(s)).join('');
  }
  // eslint-disable-next-line no-unsanitized/property -- MCP row templates escape dynamic values.
  wrap.innerHTML = html;
  bindMcpRows(wrap);
}
function paintMcpCatalog() {
  const wrap = $('#mcp-catalog');
  const installedIds = new Set(mcpInstalled.map((s) => s.id));
  const cards = mcpCatalog.map((c) => {
    const installed = installedIds.has(c.id);
    return `
      <div class="mcp-card" data-id="${escapeAttr(c.id)}" data-installed="${installed ? '1' : '0'}">
        <div class="mc-head">
          <span class="mc-icon">${escapeHtml(c.icon)}</span>
          <span class="mc-name">${escapeHtml(c.name)}</span>
          <span class="mc-add">${installed ? 'installed' : 'install'}</span>
        </div>
        <div class="mc-desc">${escapeHtml(c.description)}</div>
      </div>`;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property -- MCP catalog card fields are escaped via escapeHtml/escapeAttr.
  wrap.innerHTML = cards;
  wrap.querySelectorAll('.mcp-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.dataset.installed === '1') return;
      const id = card.dataset.id;
      const cat = mcpCatalog.find((c) => c.id === id);
      if (cat) openMcpInstallModal(cat);
    });
  });
}

// State for the custom MCP modal, held across renders of the modal body.
// mode is 'add' | 'edit', activeTab is 'stdio' | 'http', view is 'paste' |
// 'form', and parsedItems holds the last parse result while paste is open.
let mcpModalState = {
  mode: 'add',
  editingId: null,
  activeTab: 'stdio',
  view: 'form',
  parsedItems: [],
  parseErrors: [],
};

function openMcpCustomModal() { renderMcpModal({ mode: 'add' }); }
function openMcpEditModal(server) {
  if (!server || !server.id) return;
  renderMcpModal({ mode: 'edit', server });
}

// Builds the modal body for both flows.
// Add:  form view with a toggle into paste view; the primary button reads
//       "Install N servers" once paste holds valid JSON, else "Install".
// Edit: pre-filled form view, no paste view. Changing the name renames the
//       entry, and the primary button reads "Save changes".
function renderMcpModal({ mode, server }) {
  mcpModalState = {
    mode,
    editingId: mode === 'edit' && server ? server.id : null,
    activeTab: 'stdio',
    view: 'form',
    parsedItems: [],
    parseErrors: [],
  };
  const isEdit = mode === 'edit';
  $('#mcp-install-title').textContent = isEdit
    ? `Edit MCP server: ${server.id}`
    : 'Install a custom MCP server';
  $('#mcp-install-sub').textContent = isEdit
    ? 'Update the fields below and save.'
    : 'Paste a JSON snippet (one or many servers), or fill in the form.';
  const fields = $('#mcp-install-fields');
  const codeStyle = "background:var(--bg-3); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-family:'JetBrains Mono', monospace; font-size:12px; resize:vertical;";
  // eslint-disable-next-line no-unsanitized/property -- Static modal template; dynamic values are escaped where they appear (server.id in the title above sets textContent, not innerHTML).
  fields.innerHTML = `
    ${isEdit ? '' : `
    <div class="mcp-paste-wrap" id="mcp-paste-wrap" hidden>
      <div class="mcp-input-group">
        <label for="mig-paste-json">Paste your MCP JSON</label>
        <textarea id="mig-paste-json" rows="9" spellcheck="false" placeholder='{
  "my-server": { "command": "node", "args": ["dist/index.js"] },
  "remote-svc": { "type": "http", "url": "https://example.com/mcp" }
}' style="${codeStyle}"></textarea>
        <div class="mig-hint">Accepts: full <code>mcpServers</code> wrapper, VS Code-style <code>servers</code> wrapper, single-server <code>{ "name": {...} }</code>, an array, a bare entry, or a mid-JSON paste with stray indents and trailing commas. Multiple servers install in one shot.</div>
        <div id="mig-paste-status" class="ra-status" style="margin-top:8px;" hidden></div>
      </div>
    </div>
    `}

    <div class="mcp-form-wrap" id="mcp-form-wrap">
      ${isEdit ? '' : `
        <div style="display:flex; justify-content:center; margin-bottom:10px;">
          <button type="button" class="ghost-btn" id="mcp-view-toggle">Paste JSON instead</button>
        </div>
      `}
      <div id="mcp-form-status" class="ra-status ra-status-error" hidden></div>
      <div class="mcp-input-group">
        <label>Transport</label>
        <div class="mcp-tabs">
          <button type="button" class="mcp-tab active" data-tab="stdio">Local command (stdio)</button>
          <button type="button" class="mcp-tab" data-tab="http">Remote (HTTP / SSE)</button>
        </div>
      </div>
      <div class="mcp-input-group">
        <label for="mig-custom-id">Server name</label>
        <input id="mig-custom-id" type="text" placeholder="my-server" autocomplete="off" />
        <div class="mig-hint">Letters, numbers, dashes. Used as the key in the CLI's MCP config.</div>
      </div>
      <div data-tab-pane="stdio">
        <div class="mcp-input-group">
          <label for="mig-custom-cmd">Command</label>
          <input id="mig-custom-cmd" type="text" placeholder="npx" autocomplete="off" />
          <div class="mig-hint">Just the binary. Put each arg on its own line below.</div>
        </div>
        <div class="mcp-input-group">
          <label for="mig-custom-args">Arguments (one per line)</label>
          <textarea id="mig-custom-args" rows="3" placeholder="-y&#10;@my-org/my-mcp-server" style="${codeStyle}"></textarea>
        </div>
        <div class="mcp-input-group">
          <label for="mig-custom-env">Environment variables (KEY=value, one per line)</label>
          <textarea id="mig-custom-env" rows="3" placeholder="API_KEY=..." style="${codeStyle}"></textarea>
          <div class="mig-hint">Optional. Useful for API keys or per-server settings.</div>
        </div>
      </div>
      <div data-tab-pane="http" hidden>
        <div class="mcp-input-group">
          <label for="mig-custom-type">Transport type</label>
          <select id="mig-custom-type" style="${codeStyle}">
            <option value="http">HTTP (streamable)</option>
            <option value="sse">SSE (server-sent events)</option>
          </select>
        </div>
        <div class="mcp-input-group">
          <label for="mig-custom-url">URL</label>
          <input id="mig-custom-url" type="text" placeholder="https://example.com/mcp" autocomplete="off" />
        </div>
        <div class="mcp-input-group">
          <label for="mig-custom-headers">Headers (Header-Name: value, one per line)</label>
          <textarea id="mig-custom-headers" rows="3" placeholder="Authorization: Bearer your-token-here" style="${codeStyle}"></textarea>
          <div class="mig-hint">Optional. Used for auth tokens and per-server headers.</div>
        </div>
      </div>
    </div>`;

  // Tab switching keeps form view in sync with mcpModalState.activeTab.
  fields.querySelectorAll('.mcp-tab').forEach((t) => {
    t.addEventListener('click', () => { setMcpActiveTab(t.dataset.tab); });
  });

  if (isEdit) {
    // Pre-fill the form from the existing server. The original id is held
    // in mcpModalState.editingId so update() can still locate the entry
    // even when the name field is changed (a rename).
    $('#mig-custom-id').value = server.id;
    if (server.transport === 'http' || server.transport === 'sse') {
      setMcpActiveTab('http');
      $('#mig-custom-type').value = server.transport;
      $('#mig-custom-url').value = server.url || '';
      const hdrs = server.headers || {};
      $('#mig-custom-headers').value = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\n');
    } else {
      setMcpActiveTab('stdio');
      $('#mig-custom-cmd').value = server.command || '';
      $('#mig-custom-args').value = (server.args || []).join('\n');
      $('#mig-custom-env').value = Object.entries(server.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
    }
  } else {
    // Add mode: wire the paste-view toggle + live parse + view toggle.
    $('#mcp-view-toggle').addEventListener('click', () => { setMcpView(mcpModalState.view === 'form' ? 'paste' : 'form'); });
    $('#mig-paste-json').addEventListener('input', mcpParseDebounced);
  }

  $('#mcp-install').hidden = false;
  $('#mcp-install-confirm').onclick = submitMcpModal;
  $('#mcp-install-cancel').onclick = () => { $('#mcp-install').hidden = true; };
  updateMcpFootButton();
}

function setMcpActiveTab(tab) {
  mcpModalState.activeTab = tab;
  clearMcpFormError();
  const fields = $('#mcp-install-fields'); if (!fields) return;
  fields.querySelectorAll('.mcp-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  fields.querySelectorAll('[data-tab-pane]').forEach((p) => { p.hidden = p.dataset.tabPane !== tab; });
}

function setMcpView(view) {
  mcpModalState.view = view;
  const paste = $('#mcp-paste-wrap'); const form = $('#mcp-form-wrap');
  if (paste) paste.hidden = view !== 'paste';
  if (form) form.hidden = view !== 'form';
  const toggle = $('#mcp-view-toggle');
  if (toggle) toggle.textContent = view === 'paste' ? 'Use the form instead' : 'Paste JSON instead';
  if (view === 'paste') {
    setTimeout(() => { try { $('#mig-paste-json').focus(); } catch (_) {} }, 30);
    mcpParseDebounced();
  }
  updateMcpFootButton();
}

// Live parse on every input event, debounced so a fast typist doesn't
// pay the IPC round-trip per keystroke.
let mcpParseTimer = null;
function mcpParseDebounced() {
  if (mcpParseTimer) clearTimeout(mcpParseTimer);
  mcpParseTimer = setTimeout(mcpParseNow, 180);
}
async function mcpParseNow() {
  if (mcpModalState.view !== 'paste') return;
  const raw = ($('#mig-paste-json') && $('#mig-paste-json').value) || '';
  if (!raw.trim()) {
    mcpModalState.parsedItems = []; mcpModalState.parseErrors = [];
    setMcpPasteStatus('');
    updateMcpFootButton();
    return;
  }
  const res = await window.husk.mcp.parseSnippet(raw);
  if (!res || !res.ok) {
    mcpModalState.parsedItems = []; mcpModalState.parseErrors = [];
    setMcpPasteStatus((res && res.error) || 'Could not parse JSON', 'error');
    updateMcpFootButton();
    return;
  }
  mcpModalState.parsedItems = (res.items || []).filter((it) => it && it.id);
  mcpModalState.parseErrors = res.errors || [];
  const ok = mcpModalState.parsedItems.length;
  const bad = mcpModalState.parseErrors.length;
  const unnamed = (res.items || []).filter((it) => !it.id).length;
  const parts = [];
  if (ok) parts.push(`${ok} server${ok !== 1 ? 's' : ''} ready`);
  if (unnamed) parts.push(`${unnamed} entry without a name (provide one in the JSON)`);
  if (bad) parts.push(`${bad} with errors`);
  setMcpPasteStatus(parts.join(' · '), ok ? 'info' : 'error');
  updateMcpFootButton();
}
function setMcpPasteStatus(text, kind) {
  const el = $('#mig-paste-status'); if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; el.className = 'ra-status'; return; }
  el.hidden = false; el.textContent = text; el.className = 'ra-status' + (kind ? ' ra-status-' + kind : '');
}
// Inline validation banner for the form view (add + edit). Shows a specific
// reason a save was blocked, focuses the offending field, and rings it red.
// Returns false so callers can `return setMcpFormError(...)` in one line.
function setMcpFormError(text, fieldId) {
  const el = $('#mcp-form-status');
  if (el) { el.hidden = false; el.textContent = text; }
  $$('#mcp-install .input-error').forEach((n) => n.classList.remove('input-error'));
  const field = fieldId ? $(`#${fieldId}`) : null;
  if (field) { field.classList.add('input-error'); try { field.focus(); } catch (_) {} }
  return false;
}
function clearMcpFormError() {
  const el = $('#mcp-form-status');
  if (el) { el.hidden = true; el.textContent = ''; }
  $$('#mcp-install .input-error').forEach((n) => n.classList.remove('input-error'));
}
function updateMcpFootButton() {
  const btn = $('#mcp-install-confirm'); if (!btn) return;
  if (mcpModalState.mode === 'edit') {
    btn.textContent = 'Save changes';
    btn.disabled = false;
    return;
  }
  if (mcpModalState.view === 'paste') {
    const n = mcpModalState.parsedItems.length;
    btn.textContent = n > 0 ? `Install ${n} server${n !== 1 ? 's' : ''}` : 'Paste JSON above';
    btn.disabled = n === 0;
    return;
  }
  btn.textContent = 'Install';
  btn.disabled = false;
}
async function submitMcpModal() {
  if (mcpModalState.mode === 'add' && mcpModalState.view === 'paste') {
    if (!mcpModalState.parsedItems.length) {
      toast('Nothing valid to install. Fix the JSON above.', 'error');
      return;
    }
    const r = await window.husk.mcp.addMany(mcpModalState.parsedItems);
    if (!r || !r.ok) { toast((r && r.error) || 'Install failed', 'error'); return; }
    const ok = []; const skip = []; const err = [];
    for (const id of Object.keys(r.results || {})) {
      const s = r.results[id];
      if (s.status === 'installed') ok.push(id);
      else if (s.status === 'exists') skip.push(id);
      else err.push(`${id}: ${s.error || 'error'}`);
    }
    const msg = [];
    if (ok.length) msg.push(`Installed ${ok.length}`);
    if (skip.length) msg.push(`${skip.length} already existed`);
    if (err.length) msg.push(`${err.length} failed`);
    toast(msg.join(' · ') || 'Done', err.length ? 'error' : 'success');
    $('#mcp-install').hidden = true;
    await renderMcp();
    if (ok.length) applyMcpChange(ok.join(', '));
    return;
  }
  // Form-view path (add or edit). Build the payload from the current
  // form fields, then call add() or update() based on mode.
  clearMcpFormError();
  const idRaw = $('#mig-custom-id').value || '';
  const id = idRaw.trim();
  // Name validation, most-specific reason first so the user knows exactly
  // what to change rather than a blanket "invalid".
  if (!id) return setMcpFormError('Server name is required.', 'mig-custom-id');
  if (/\s/.test(idRaw)) return setMcpFormError('Server name cannot contain spaces. Use a dash (-) or underscore (_) instead.', 'mig-custom-id');
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return setMcpFormError('Server name can only use letters, numbers, dashes (-) and underscores (_).', 'mig-custom-id');
  const tab = mcpModalState.activeTab;
  let payload;
  if (tab === 'http') {
    const url = ($('#mig-custom-url').value || '').trim();
    const transport = $('#mig-custom-type').value || 'http';
    const headersText = ($('#mig-custom-headers').value || '').trim();
    if (!url) return setMcpFormError('URL is required for an HTTP/SSE server.', 'mig-custom-url');
    if (!/^https?:\/\//i.test(url)) return setMcpFormError('URL must start with http:// or https://.', 'mig-custom-url');
    const headers = {};
    if (headersText) {
      for (const line of headersText.split('\n')) {
        if (!line.trim()) continue;
        const idx = line.indexOf(':');
        if (idx <= 0) return setMcpFormError(`Header line "${line.trim()}" is missing a colon. Use the form Header-Name: value.`, 'mig-custom-headers');
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    payload = { id, transport, url, headers };
  } else {
    const command = ($('#mig-custom-cmd').value || '').trim();
    const argsText = ($('#mig-custom-args').value || '').trim();
    const envText = ($('#mig-custom-env').value || '').trim();
    if (!command) return setMcpFormError('Command is required for a local (stdio) server.', 'mig-custom-cmd');
    const args = argsText ? argsText.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    const env = {};
    if (envText) {
      for (const line of envText.split('\n')) {
        if (!line.trim()) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) return setMcpFormError(`Env line "${line.trim()}" is missing an equals sign. Use the form KEY=value.`, 'mig-custom-env');
        env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    payload = { id, command, args, env };
  }
  // In edit mode, carry the original id so the adapter can locate the
  // entry even when `id` (the name field) has been changed to rename it.
  if (mcpModalState.mode === 'edit') payload.oldId = mcpModalState.editingId;
  const op = mcpModalState.mode === 'edit'
    ? await window.husk.mcp.update(payload)
    : await window.husk.mcp.add(payload);
  // Surface adapter-side failures inline on the form. Name collisions point at
  // the name field because that is the field the user can correct.
  if (!op || !op.ok) {
    const err = (op && op.error) || 'Save failed';
    return setMcpFormError(err, /exists|server name|server id/i.test(err) ? 'mig-custom-id' : null);
  }
  $('#mcp-install').hidden = true;
  toast(mcpModalState.mode === 'edit' ? `Updated ${id}` : `Installed ${id}`, 'success');
  await renderMcp();
  applyMcpChange(id);
}

// Small badge in the chat-empty welcome area showing which MCPs are loaded
// in the current session, so users see what the agent can do right now.
async function refreshLoadedMcpsBadge() {
  const el = $('#ce-mcps');
  if (!el) return;
  if (!loadedMcpSnapshot.size) { el.hidden = true; return; }
  const ids = [...loadedMcpSnapshot];
  el.hidden = false;
  // eslint-disable-next-line no-unsanitized/property -- MCP IDs are escaped before insertion.
  el.innerHTML = `<span class="ce-mcps-label">MCPs loaded:</span> ${ids.map((i) => `<span class="ce-mcps-chip">${escapeHtml(i)}</span>`).join('')}`;
}

function openMcpInstallModal(cat) {
  $('#mcp-install-title').textContent = `Install ${cat.name}`;
  $('#mcp-install-sub').textContent = cat.description;
  const fields = $('#mcp-install-fields');
  fields.innerHTML = '';
  const inputs = (cat.inputs || []).map((inp) => {
    const groupId = `mig-${inp.id}`;
    if (inp.kind === 'path') {
      return `
        <div class="mcp-input-group">
          <label for="${groupId}">${escapeHtml(inp.label)}</label>
          <div class="mig-row">
            <input id="${groupId}" type="text" placeholder="/path/to/folder" />
            <button class="mig-pick" data-pick="${escapeAttr(inp.id)}" type="button">Browse…</button>
          </div>
          ${inp.hint ? `<div class="mig-hint">${escapeHtml(inp.hint)}</div>` : ''}
        </div>`;
    }
    return `
      <div class="mcp-input-group">
        <label for="${groupId}">${escapeHtml(inp.label)}</label>
        <input id="${groupId}" type="${inp.kind === 'secret' ? 'password' : 'text'}" autocomplete="off" />
        ${inp.hint ? `<div class="mig-hint">${escapeHtml(inp.hint)}</div>` : ''}
      </div>`;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property -- Input labels/hints are escaped via escapeHtml/escapeAttr.
  fields.innerHTML = inputs || '<div class="mig-hint" style="margin-top:8px;">No configuration needed. Click Install.</div>';
  fields.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dir = await window.husk.dialog2.pickDir();
      if (dir) fields.querySelector(`#mig-${btn.dataset.pick}`).value = dir;
    });
  });
  $('#mcp-install').hidden = false;
  $('#mcp-install-confirm').onclick = () => submitMcpInstall(cat);
  $('#mcp-install-cancel').onclick = () => { $('#mcp-install').hidden = true; };
}
async function submitMcpInstall(cat) {
  const env = {};
  let args = [...(cat.template.args || [])];
  for (const inp of (cat.inputs || [])) {
    const el = document.querySelector(`#mig-${inp.id}`);
    const val = (el && el.value || '').trim();
    if (inp.required && !val) {
      toast(`${inp.label} is required`, 'error');
      if (el) el.focus();
      return;
    }
    if (inp.kind === 'path') {
      args = args.map((a) => a.replace(`<${inp.id}>`, val));
    } else if (cat.envKeys && cat.envKeys.includes(inp.id)) {
      env[inp.id] = val;
    } else {
      args = args.map((a) => a.replace(`<${inp.id}>`, val));
    }
  }
  const r = await window.husk.mcp.add({ id: cat.id, command: cat.template.command, args, env });
  if (!r.ok) { toast(r.error || 'Install failed', 'error'); return; }
  $('#mcp-install').hidden = true;
  toast(`${cat.name} installed`, 'success');
  await renderMcp();
  applyMcpChange(cat.name);
}
$('#btn-mcp-refresh').addEventListener('click', renderMcp);
$('#btn-mcp-add-custom').addEventListener('click', openMcpCustomModal);

// ─── Plugins page ───────────────────────────────────────────────────────────────
//
// Installed plugins come from the agent CLI's registry; the browse grid
// unions every known marketplace catalog. Mutations (install, uninstall,
// enable, disable) run through the CLI via plugins:run, then the page
// refreshes from disk so the UI never invents state.
let pluginsInstalledCache = [];
let pluginsCatalogCache = [];
let pluginsCapabilities = { canEnableDisable: true, canEdit: true, canBrowse: true };
// Category chips narrow the catalog grid, alongside the free-text filter.
let pluginsCategories = new Set();

// Cut on a word boundary and strip the punctuation the cut leaves behind, so a
// truncated description ends in an ellipsis rather than a dangling comma.
function clampWords(text, max) {
  const t = String(text).trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-]+$/, '') + '...';
}
// Set of in-flight plugin ids so a slow install cannot be double-clicked.
const pluginsBusy = new Set();

function pluginCatalogById() {
  return new Map(pluginsCatalogCache.map((p) => [p.id, p]));
}

function versionParts(version) {
  return String(version || '').match(/\d+/g)?.map((n) => Number(n)) || [];
}

function compareVersions(a, b) {
  const av = versionParts(a);
  const bv = versionParts(b);
  if (!av.length || !bv.length) return null;
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const d = (av[i] || 0) - (bv[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function pluginUpdateState(plugin, catalog) {
  const latest = catalog && catalog.version ? catalog.version : '';
  if (!latest || !plugin.version) return { latest, state: 'unknown', label: 'Update', disabled: false, title: 'Check for plugin updates' };
  const cmp = compareVersions(plugin.version, latest);
  if (cmp == null) return { latest, state: 'unknown', label: 'Update', disabled: false, title: `Latest listed version: ${latest}` };
  if (cmp >= 0) return { latest, state: 'current', label: 'Up to date', disabled: true, title: `Latest version installed (${latest})` };
  return { latest, state: 'available', label: `Update to v${latest}`, disabled: false, title: `Installed v${plugin.version}; latest is v${latest}` };
}

async function renderPlugins() {
  const body = $('#plugins-body');
  const unsupported = $('#plugins-unsupported');
  const installedEl = $('#plugins-installed');
  // Back to the two-section layout while the fetch runs; paintPlugins decides
  // again afterwards whether the single zero state is the right answer.
  const zeroEl = $('#plugins-zero');
  if (zeroEl) zeroEl.hidden = true;
  const installedSection = $('#plugins-section-installed');
  const browseSection = $('#plugins-section-browse');
  if (installedSection) installedSection.hidden = false;
  if (browseSection) browseSection.hidden = false;
  // eslint-disable-next-line no-unsanitized/property -- Static loading template.
  installedEl.innerHTML = `<div class="empty-state plugins-hint"><div class="es-msg">Loading...</div></div>`;
  const [li, cat] = await Promise.all([window.husk.plugins.list(), window.husk.plugins.catalog()]);
  if (!li.supported) {
    body.hidden = true;
    unsupported.hidden = false;
    return;
  }
  body.hidden = false;
  unsupported.hidden = true;
  pluginsInstalledCache = li.plugins || [];
  pluginsCatalogCache = (cat.catalog || []);
  pluginsCapabilities = li.capabilities || cat.capabilities || pluginsCapabilities;
  paintPlugins($('#plugins-search').value);
}

function paintPlugins(query) {
  const q = (query || '').toLowerCase().trim();
  const installedEl = $('#plugins-installed');
  const catalogEl = $('#plugins-catalog');
  const installedIds = new Set(pluginsInstalledCache.map((p) => p.id));
  const catalogById = pluginCatalogById();
  const canToggle = pluginsCapabilities.canEnableDisable !== false;
  const canEdit = pluginsCapabilities.canEdit !== false;

  // Nothing installed and no marketplace to install from collapses both
  // sections into one full-height state with one action.
  const nothingAnywhere = !pluginsInstalledCache.length && !pluginsCatalogCache.length;
  const zeroEl = $('#plugins-zero');
  const installedSection = $('#plugins-section-installed');
  const browseSection = $('#plugins-section-browse');
  if (zeroEl) zeroEl.hidden = !nothingAnywhere;
  if (installedSection) installedSection.hidden = nothingAnywhere;
  if (browseSection) browseSection.hidden = nothingAnywhere;
  // Nothing to filter: leaving the input live invites a keystroke that cannot
  // do anything, since this function returns before it reaches a list.
  const searchEl = $('#plugins-search');
  if (searchEl) {
    searchEl.disabled = nothingAnywhere;
    searchEl.placeholder = nothingAnywhere ? 'No plugins to filter' : 'Filter plugins...';
  }
  if (nothingAnywhere) return;

  const inst = q
    ? pluginsInstalledCache.filter((p) => (p.name + ' ' + p.marketplace).toLowerCase().includes(q))
    : pluginsInstalledCache;
  if (!inst.length) {
    const msg = pluginsInstalledCache.length
      ? `No installed plugins match "${escapeHtml(query)}"`
      : 'Nothing installed yet. Pick one from the marketplaces below.';
    // A one-line hint rather than a tall illustration: the catalog underneath
    // is the thing worth the vertical space.
    // eslint-disable-next-line no-unsanitized/property -- Message content is escaped above.
    installedEl.innerHTML = `<div class="empty-state plugins-hint"><div class="es-msg">${msg}</div></div>`;
  } else {
    // eslint-disable-next-line no-unsanitized/property -- Plugin fields are escaped via escapeHtml/escapeAttr.
    installedEl.innerHTML = inst.map((p) => {
      const update = pluginUpdateState(p, catalogById.get(p.id));
      return `
      <div class="plugin-row${p.enabled ? '' : ' disabled'}" data-id="${escapeAttr(p.id)}">
        <div class="plugin-row-main">
          <div class="plugin-row-name">${escapeHtml(p.name)}${p.marketplace ? `<span class="plugin-badge">${escapeHtml(p.marketplace)}</span>` : ''}</div>
          <div class="plugin-row-meta">v${escapeHtml(p.version || '?')}${update.latest ? ` · latest v${escapeHtml(update.latest)}` : ''}${p.lastUpdated ? ' · updated ' + escapeHtml(fmtRelTime(p.lastUpdated)) : ''}</div>
        </div>
        <div class="plugin-row-actions">
          ${canEdit ? '<button class="ghost-btn" data-act="edit" title="Browse and edit this plugin\'s files">Edit</button>' : ''}
          <button class="ghost-btn plugin-update-btn ${update.state === 'current' ? 'is-current' : ''}" data-act="update" title="${escapeAttr(update.title)}" ${update.disabled ? 'disabled' : ''}>${escapeHtml(update.label)}</button>
          <button class="ghost-btn ghost-btn-danger" data-act="uninstall" title="Uninstall">Remove</button>
          ${canToggle ? `<button class="toggle ${p.enabled ? 'on' : ''}" data-act="toggle" title="${p.enabled ? 'Disable' : 'Enable'}"></button>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  const avail = pluginsCatalogCache.filter((c) => !installedIds.has(c.id));
  const matchesText = (c) => !q || (c.name + ' ' + c.description + ' ' + c.category).toLowerCase().includes(q);
  // Counts come from the text-filtered set, so a chip never promises results
  // that the active search has already excluded.
  const textMatched = avail.filter(matchesText);
  const counts = new Map();
  textMatched.forEach((c) => {
    const k = (c.category || '').trim();
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  });
  // Drop selections the current search has emptied, so a stale chip cannot
  // leave the grid showing nothing with no visible cause.
  [...pluginsCategories].forEach((k) => { if (!counts.has(k)) pluginsCategories.delete(k); });
  // Categories combine as OR: picking Security and Database shows both.
  const found = pluginsCategories.size
    ? textMatched.filter((c) => pluginsCategories.has((c.category || '').trim()))
    : textMatched;

  const catsEl = $('#plugins-cats');
  if (catsEl) {
    const chips = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (chips.length < 2) {
      catsEl.hidden = true;
      catsEl.textContent = '';
    } else {
      catsEl.hidden = false;
      const chip = (val, label, n, on) =>
        `<button type="button" class="plugins-cat${on ? ' is-on' : ''}" data-cat="${escapeAttr(val)}" aria-pressed="${on}">`
        + `${escapeHtml(label)}<span class="plugins-cat-n">${n}</span></button>`;
      // capitalize turns "ai" into "Ai"; anything this short is an acronym.
      const label = (k) => (k.length <= 3 ? k.toUpperCase() : k);
      // eslint-disable-next-line no-unsanitized/property -- Labels are escaped above.
      catsEl.innerHTML = chip('', 'All', textMatched.length, !pluginsCategories.size)
        + chips.map(([k, n]) => chip(k, label(k), n, pluginsCategories.has(k))).join('');
    }
  }

  const instHead = document.querySelector('#plugins-section-installed .mcp-section-head');
  if (instHead) {
    const on = pluginsInstalledCache.filter((p) => p.enabled).length;
    instHead.textContent = pluginsInstalledCache.length
      ? `Installed · ${pluginsInstalledCache.length}${on < pluginsInstalledCache.length ? `, ${on} enabled` : ''}`
      : 'Installed';
  }

  const head = $('#plugins-browse-head');
  if (head) head.textContent = found.length ? `Browse marketplaces · ${found.length} available` : 'Browse marketplaces';
  // An empty grid is laid out as flex so the message centers in the whole
  // section instead of the first 280px column.
  catalogEl.classList.toggle('is-empty', !found.length);
  if (!found.length) {
    // Three different reasons for an empty catalog, three different answers.
    const msg = q
      ? `No plugin matches "${escapeHtml(query)}"`
      : (pluginsCatalogCache.length
        ? 'Every plugin from your marketplaces is already installed.'
        : 'No marketplaces configured. Add one from the agent CLI, then refresh.');
    // eslint-disable-next-line no-unsanitized/property -- Message content is escaped above.
    catalogEl.innerHTML = `<div class="empty-state"><div class="es-icon">${ICONS.plugins}</div><div class="es-msg">${msg}</div></div>`;
  } else {
    // The grid draws every match; the category chips do the narrowing.
    const overflow = '';
    // eslint-disable-next-line no-unsanitized/property -- Catalog fields are escaped via escapeHtml/escapeAttr.
    catalogEl.innerHTML = found.map((c) => `
      <div class="plugin-card" data-id="${escapeAttr(c.id)}">
        <div class="plugin-card-top">
          <span class="plugin-card-name">${escapeHtml(c.name)}</span>
          ${c.category ? `<span class="plugin-badge">${escapeHtml(c.category)}</span>` : ''}
        </div>
        <div class="plugin-card-desc">${escapeHtml(clampWords(c.description || '', 170))}</div>
        <div class="plugin-card-foot">
          <span class="plugin-card-mp">${escapeHtml(c.marketplace)}</span>
          <button class="btn-primary plugin-install" data-act="install">Install</button>
        </div>
      </div>`).join('') + overflow;
  }
}

// One CLI mutation with busy handling. Only the installed list is re-fetched
// afterwards, since these actions cannot change the marketplace catalogs.
async function runPluginAction(action, id, btn) {
  if (pluginsBusy.has(id)) return;
  const before = pluginsInstalledCache.find((p) => p.id === id) || null;
  pluginsBusy.add(id);
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const r = await window.husk.plugins.run(action, id);
    if (!r.ok) {
      toast(r.error || `plugin ${action} failed`, 'error');
      return;
    }
    const li = await window.husk.plugins.list();
    if (li.supported) pluginsInstalledCache = li.plugins || [];
    const after = pluginsInstalledCache.find((p) => p.id === id) || null;
    if (action === 'update') {
      const output = String(r.output || '');
      if (before && after && before.version && after.version && before.version !== after.version) {
        toastRestart(`${id.split('@')[0]} updated to v${after.version}`);
      } else if (/already|latest|up[- ]?to[- ]?date|no update/i.test(output)) {
        toast(`${id.split('@')[0]} is already on the latest version`, 'info');
      } else {
        toast(`${id.split('@')[0]} update completed; no version change reported`, 'warn');
      }
    } else {
      const verbed = { install: 'installed', uninstall: 'removed', enable: 'enabled', disable: 'disabled' }[action] || action;
      toastRestart(`${id.split('@')[0]} ${verbed}`);
    }
    paintPlugins($('#plugins-search').value);
  } finally {
    pluginsBusy.delete(id);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// Delegated click handling, wired once: repaints swap innerHTML freely
// without rebinding a listener per row and button.
$('#plugins-installed').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.plugin-row');
  if (!row) return;
  const id = row.dataset.id;
  const act = btn.dataset.act;
  if (act === 'edit') { openPluginEditor(id); return; }
  if (act === 'toggle') {
    await runPluginAction(btn.classList.contains('on') ? 'disable' : 'enable', id, null);
    return;
  }
  if (act === 'update') { await runPluginAction('update', id, btn); return; }
  if (act === 'uninstall') {
    const ok = await openConfirmDialog({
      title: `Remove ${id.split('@')[0]}?`,
      bodyHtml: 'The plugin is uninstalled from the agent. You can reinstall it from the marketplace at any time.',
      confirmLabel: 'Remove plugin',
      cancelLabel: 'Keep',
    });
    if (ok) await runPluginAction('uninstall', id, btn);
  }
});
$('#plugins-catalog').addEventListener('click', (e) => {
  const btn = e.target.closest('.plugin-install');
  if (!btn) return;
  const card = btn.closest('.plugin-card');
  if (card) runPluginAction('install', card.dataset.id, btn);
});

// ─── Plugin editor modal ────────────────────────────────────────────────────────
let peCurrent = { id: null, relPath: null, dirty: false };

async function openPluginEditor(id) {
  peCurrent = { id, relPath: null, dirty: false };
  $('#pe-title').textContent = `Edit ${id.split('@')[0]}`;
  $('#pe-path').textContent = 'select a file';
  const ta = $('#pe-content');
  ta.value = '';
  ta.disabled = true;
  $('#pe-save').disabled = true;
  $('#pe-status').textContent = '';
  $('#plugin-editor').hidden = false;
  const r = await window.husk.plugins.files(id);
  const list = $('#pe-files');
  if (!r.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    list.innerHTML = `<div class="empty-state"><div class="es-msg">${escapeHtml(r.error || 'Could not list files')}</div></div>`;
    return;
  }
  // eslint-disable-next-line no-unsanitized/property -- File paths are escaped via escapeHtml/escapeAttr.
  list.innerHTML = r.files.map((f) => `
    <button class="pe-file${f.editable ? '' : ' pe-file-locked'}" data-rel="${escapeAttr(f.path)}" ${f.editable ? '' : 'disabled title="binary or too large"'}>
      ${escapeHtml(f.path)}
    </button>`).join('');
  list.querySelectorAll('.pe-file').forEach((btn) => {
    btn.addEventListener('click', () => loadPluginFile(btn.dataset.rel, btn));
  });
}

async function loadPluginFile(relPath, btn) {
  if (peCurrent.dirty && !(await openConfirmDialog({
    title: 'Discard unsaved changes?',
    bodyHtml: 'The current file has edits that are not saved.',
    confirmLabel: 'Discard',
    cancelLabel: 'Stay',
  }))) return;
  const r = await window.husk.plugins.readFile(peCurrent.id, relPath);
  if (!r.ok) { toast(r.error || 'Could not read file', 'error'); return; }
  peCurrent.relPath = relPath;
  peCurrent.dirty = false;
  $$('#pe-files .pe-file').forEach((b) => b.classList.toggle('active', b === btn));
  $('#pe-path').textContent = relPath;
  const ta = $('#pe-content');
  ta.value = r.content;
  ta.disabled = false;
  $('#pe-save').disabled = true;
  $('#pe-status').textContent = '';
}

async function savePluginFile() {
  if (!peCurrent.id || !peCurrent.relPath) return;
  const r = await window.husk.plugins.writeFile(peCurrent.id, peCurrent.relPath, $('#pe-content').value);
  if (!r.ok) { toast(r.error || 'Save failed', 'error'); return; }
  peCurrent.dirty = false;
  $('#pe-save').disabled = true;
  $('#pe-status').textContent = 'saved';
  toastRestart(`${peCurrent.relPath} saved`);
}

async function closePluginEditor() {
  if (peCurrent.dirty && !(await openConfirmDialog({
    title: 'Discard unsaved changes?',
    bodyHtml: 'The current file has edits that are not saved.',
    confirmLabel: 'Discard',
    cancelLabel: 'Stay',
  }))) return;
  $('#plugin-editor').hidden = true;
  peCurrent = { id: null, relPath: null, dirty: false };
}

$('#pe-content').addEventListener('input', () => {
  if (!peCurrent.relPath) return;
  peCurrent.dirty = true;
  $('#pe-save').disabled = false;
  $('#pe-status').textContent = 'unsaved changes';
});
$('#pe-save').addEventListener('click', savePluginFile);
$('#pe-close').addEventListener('click', closePluginEditor);
$('#pe-close-x').addEventListener('click', closePluginEditor);
$('#pe-open-folder').addEventListener('click', () => { if (peCurrent.id) window.husk.plugins.openFolder(peCurrent.id); });
$('#plugin-editor').addEventListener('click', (e) => { if (e.target.id === 'plugin-editor') closePluginEditor(); });
$('#plugins-search').addEventListener('input', debounce((e) => paintPlugins(e.target.value), 120));
$('#btn-plugins-refresh').addEventListener('click', renderPlugins);
$('#plugins-zero-refresh').addEventListener('click', renderPlugins);
$('#plugins-cats')?.addEventListener('click', (e) => {
  const chip = e.target.closest('.plugins-cat');
  if (!chip) return;
  const val = chip.dataset.cat || '';
  // "All" is the clear; any other chip toggles its own membership, so the
  // filter never becomes a trap and two categories can be held at once.
  if (!val) pluginsCategories.clear();
  else if (pluginsCategories.has(val)) pluginsCategories.delete(val);
  else pluginsCategories.add(val);
  paintPlugins($('#plugins-search').value);
});

$('#plugins-zero-cmd')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(btn.dataset.cmd || '');
    btn.classList.add('is-copied');
    toast('Command copied', 'success');
    setTimeout(() => btn.classList.remove('is-copied'), 1600);
  } catch (_) {
    toast('Could not copy to the clipboard', 'error');
  }
});

// ─── Agent quick-switch (rail pill + dropdown) ──────────────────────────────────
let agentMenuOpen = false;
let agentsCache = [];
function updateAgentPill() {
  const cmd = (cfg && cfg.agentCommand) ? cfg.agentCommand.trim().split(/\s+/)[0] : 'claude';
  $('#ra-name').textContent = cmd || 'agent';
  const ceToolName = $('#ce-tool-name');
  if (ceToolName) ceToolName.textContent = cmd || 'agent';
}
async function refreshAgentMenu() {
  const r = await window.husk.agents.detect();
  // detect() returns { agents, tools, platform } as of v0.3. Also support
  // the older bare-array shape so a renderer running against an older main
  // (e.g. partial upgrade) still works.
  agentsCache = Array.isArray(r) ? r : (r && Array.isArray(r.agents) ? r.agents : []);
  paintAgentMenu();
}
function paintAgentMenu() {
  const menu = $('#rail-agent-menu');
  if (!menu) return;
  const activeCmd = (cfg && cfg.agentCommand) ? cfg.agentCommand.trim().split(/\s+/)[0] : 'claude';
  const rows = agentsCache.map((a) => `
    <button class="rail-agent-item" data-cmd="${escapeAttr(a.command)}" data-available="${a.available ? '1' : '0'}" data-active="${a.command === activeCmd ? '1' : '0'}">
      <span class="rai-name">${escapeHtml(a.label)}</span>
      <span class="rai-cmd">${escapeHtml(a.command)}</span>
    </button>
  `).join('');
  // eslint-disable-next-line no-unsanitized/property -- Agent row values are escaped via escapeHtml/escapeAttr.
  menu.innerHTML = `${rows}
    <div class="rail-agent-divider"></div>
    <button class="rail-agent-config" id="rai-config">Configure custom command…</button>`;
  menu.querySelectorAll('.rail-agent-item').forEach((el) => {
    el.addEventListener('click', async () => {
      if (el.dataset.available === '0') {
        toast(`${el.querySelector('.rai-name').textContent} is not installed on this system`, 'error');
        return;
      }
      const cmd = el.dataset.cmd;
      cfg = await window.husk.config.set({ agentCommand: cmd });
      updateAgentPill();
      paintAgentMenu();
      bindPrefs();
      renderSkills();
      closeAgentMenu();
      await restartPty({ silent: true });
      toast(`Switched to ${cmd}`, 'success');
    });
  });
  const cfgBtn = menu.querySelector('#rai-config');
  if (cfgBtn) cfgBtn.addEventListener('click', () => { closeAgentMenu(); openPrefs('agent'); });
}
function openAgentMenu() {
  // Paint instantly from cache, then re-detect so an agent installed since
  // launch shows as available. refreshAgentMenu repaints when it resolves.
  paintAgentMenu();
  $('#rail-agent-menu').hidden = false;
  agentMenuOpen = true;
  refreshAgentMenu();
}
function closeAgentMenu() {
  $('#rail-agent-menu').hidden = true;
  agentMenuOpen = false;
}
$('#rail-agent-pill').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (document.body.dataset.rail === 'collapsed') {
    document.body.dataset.rail = 'expanded';
    syncRailToggleTitle();
    cfg = await window.husk.config.set({ railExpanded: true });
    setTimeout(fitNow, 200);
  }
  if (agentMenuOpen) closeAgentMenu(); else openAgentMenu();
});
window.addEventListener('click', (e) => {
  if (!agentMenuOpen) return;
  if (e.target.closest('#rail-agent-pill') || e.target.closest('#rail-agent-menu')) return;
  closeAgentMenu();
});
$('#btn-new-session').addEventListener('click', () => openNewChatTab());
// The zoom level is applied immediately in the keydown handler; the toast and
// the terminal refit are debounced so a rapid burst settles to one fit (and
// one pty.resize / SIGWINCH) instead of one per keypress.
const settleZoom = debounce((lvl) => {
  const base = (window.husk.ui && typeof window.husk.ui.zoomBase === 'number') ? window.husk.ui.zoomBase : 0;
  const pct = Math.round(Math.pow(1.2, lvl - base) * 100);
  // Keyed, so stepping the zoom rewrites one readout instead of stacking a
  // card per step.
  notify(`Zoom: ${pct}%`, { kind: 'success', key: 'zoom' });
  fitNow();
}, 120);
function reportZoom(lvl) { settleZoom(lvl); }
// Zoom controls live in the View menu (Ctrl/Cmd +/-/0). The Electron menu
// handles them via webContents zoom. We keep the renderer-side keyboard
// shortcuts as a fallback for when the menu is hidden.

// ─── Drag overlay ───────────────────────────────────────────────────────────────
const overlay = $('#drag-overlay');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.hidden = true;
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  // Determine which drop target was hit
  let kind = 'context';
  const target = e.target.closest('.drag-target');
  if (target) kind = target.dataset.kind;
  const files = Array.from(e.dataTransfer.files || []);
  for (const f of files) {
    const sourcePath = window.husk.getPathForFile(f);
    if (!sourcePath) { toast(`Cannot resolve ${f.name}`, 'error'); continue; }
    const result = await window.husk.fs.dropFile({ sourcePath, kind });
    if (result.ok) {
      if (kind === 'skill') {
        toast(`Skill installed: ${f.name}`, 'success');
        announceInTerminal(`Skill installed: ${f.name}\r\n  → ${result.dest}\r\n  Click ↻ Restart to activate.`);
      } else {
        toast(`Added to the chat: ${f.name}`, 'success');
        addToSessionContext({ name: f.name, path: result.dest });
        await attachFileToChat(result.dest);
      }
      if (currentPage === 'skills') renderSkills();
    } else toast(`Failed: ${result.error}`, 'error');
  }
});
overlay.addEventListener('dragover', (e) => {
  e.preventDefault();
  $$('.drag-target').forEach((t) => t.classList.remove('dragover'));
  const t = e.target.closest('.drag-target');
  if (t) t.classList.add('dragover');
});
overlay.addEventListener('dragleave', () => {
  $$('.drag-target').forEach((t) => t.classList.remove('dragover'));
});

// ─── Welcome screen actions ─────────────────────────────────────────────────────
// The composer starts the agent, with whatever it holds as the first message. An
// empty composer starts it with nothing, which is the plain launch.
// A newline at a live prompt submits it, so the field arrives as a single line
// and every control character is stripped on the way, as for any other text
// Husk hands to a running agent.
function launchFromComposer() {
  const box = $('#ce-prompt');
  const text = window.husk.text.stripControls(box ? box.value : '').replace(/\s+/g, ' ').trim();
  if (box) { box.value = ''; box.style.height = ''; }
  launchAgent(text ? { initialPrompt: text } : {});
}
$('#ce-composer')?.addEventListener('submit', (e) => { e.preventDefault(); launchFromComposer(); });
$('#ce-composer-attach')?.addEventListener('click', () => shareFilesViaPicker());
// The field grows with its content up to the max height the stylesheet sets.
$('#ce-prompt')?.addEventListener('input', (e) => {
  const el = e.currentTarget;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
});
$('#ce-prompt')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  launchFromComposer();
});
$$('.ce-chip').forEach((c) => {
  c.addEventListener('click', () => {
    const text = c.dataset.prompt;
    if (!text) return;
    launchAgent({ initialPrompt: text });
  });
});

// ─── Command palette ────────────────────────────────────────────────────────────
// Palette icons match the rail surface so the user sees the same glyph in
// both places. Inline SVGs (stroke: currentColor, sized by .pi-icon CSS).
const ICONS = {
  chat:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>',
  skills:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3"/></svg>',
  sessions:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/></svg>',
  files:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
  mcp:         '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="19" cy="18" r="2.2"/><path d="M7 11l10-4M7 13l10 4"/></svg>',
  preferences: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.16.39.43.72.78.95.34.23.74.35 1.14.36H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  restart:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  plus:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  theme:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
  folder:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
  plugins:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v4"/><path d="M15 3v4"/><path d="M7 7h10a2 2 0 0 1 2 2v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6V9a2 2 0 0 1 2-2z"/><path d="M12 19v2"/></svg>',
  agents:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  workflows:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="9" width="6" height="6" rx="1.5"/><rect x="9" y="9" width="6" height="6" rx="1.5"/><rect x="17" y="9" width="6" height="6" rx="1.5"/><path d="M7 12h2M15 12h2"/><path d="M4 9V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/></svg>',
  autopilot:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><path d="M12 22v-6"/><path d="M4.93 4.93l4.24 4.24"/><path d="M14.83 14.83l4.24 4.24"/><path d="M2 12h6"/><path d="M16 12h6"/><path d="M4.93 19.07l4.24-4.24"/><path d="M14.83 9.17l4.24-4.24"/></svg>',
  projects:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 11h18"/></svg>',
  prompts:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M16 4v3h3"/><path d="M8 12h8M8 16h8M8 8h4"/></svg>',
};

// Order mirrors the rail. Shortcut hints show the real Alt+digit bindings from
// the digit map in the global keydown handler, with the Alt modifier spelled
// out, since a bare digit on the chat page goes to the terminal.
const PALETTE_ACTIONS = [
  { icon: ICONS.chat,        label: 'Switch to Chat',                 run: () => setPage('chat'),        shortcut: 'Alt 1' },
  // An agent is a saved configuration; a session is a running chat. The two
  // nouns stay apart here so each query matches the right entry.
  { icon: ICONS.agents,      label: 'Find a running session',         run: () => openAgentSwitch(), shortcut: 'Alt+A' },
  { icon: ICONS.agents,      label: 'Switch to Agents',               run: () => setPage('agents'), shortcut: 'Alt 7' },
  { icon: ICONS.plus,        label: 'New agent',                      run: () => { setPage('agents'); openAgentModal(null); } },
  { icon: ICONS.agents,      label: 'Import agents',                  run: () => { setPage('agents'); openAgentsImportModal(); } },
  { icon: ICONS.agents,      label: 'Import agent pack',              run: () => { setPage('agents'); openRepoAgentsModal(); } },
  { icon: ICONS.agents,      label: 'Unpin all agents',               run: () => deactivateAllProfiles() },
  { icon: ICONS.workflows,   label: 'Switch to Workflows',            run: () => setPage('workflows') },
  { icon: ICONS.autopilot,    label: 'Switch to Autopilot',             run: () => setPage('autopilot') },
  { icon: ICONS.projects,    label: 'Switch to Projects',             run: () => setPage('projects') },
  { icon: ICONS.prompts,     label: 'Switch to Prompts',              run: () => setPage('prompts') },
  { icon: ICONS.skills,      label: 'Switch to Skills',               run: () => setPage('skills'),      shortcut: 'Alt 2' },
  { icon: ICONS.sessions,    label: 'Switch to Sessions',             run: () => setPage('sessions'),    shortcut: 'Alt 3' },
  { icon: ICONS.files,       label: 'Switch to Files',                run: () => setPage('files'),       shortcut: 'Alt 4' },
  { icon: ICONS.mcp,         label: 'Switch to MCP',                  run: () => setPage('mcp'),         shortcut: 'Alt 5' },
  { icon: ICONS.plugins,     label: 'Switch to Plugins',              run: () => setPage('plugins') },
  { icon: ICONS.preferences, label: 'Switch to Preferences',          run: () => setPage('prefs'),       shortcut: 'Alt 6' },
  { icon: ICONS.restart,     label: 'Restart Agent',                  run: restartPty },
  { icon: ICONS.plus,        label: 'New chat session',               run: () => openNewChatTab() },
  { icon: ICONS.plus,        label: 'Add custom MCP server',          run: () => openMcpCustomModal() },
  { icon: ICONS.mcp,         label: 'Install MCP servers from repo',  run: () => openRepoMcpModal() },
  { icon: ICONS.plus,        label: 'Share file (picker)',            run: shareFilesViaPicker },
  { icon: ICONS.folder,      label: 'Open memory folder',             run: () => lastStats && window.husk.fs.open(lastStats.sessionsDir), claudeOnly: true },
  { icon: ICONS.skills,      label: 'Open skill library',             run: () => lastStats && window.husk.fs.open(lastStats.skillsDir) },
  { icon: ICONS.folder,      label: 'Open hooks folder',              run: () => lastStats && lastStats.hooksDir && window.husk.fs.open(lastStats.hooksDir), show: () => !!(lastStats && lastStats.hooksApplicable) },
];

let paletteSel = 0;
// ─── Agent switcher ──────────────────────────────────────────────────────────
// A chat can start agents that keep working after it moves on, each in its own
// session. This is the picker for them. `view` is the list actually on screen,
// and every index from a click, an arrow or a digit is a position in that.
let agentSwitch = { rows: [], view: [], sel: 0, loading: false, error: '', supported: true };
let agentSwitchLoad = 0;
let agentOpening = false;
let agentSwitchPointer = { x: -1, y: -1 };

function agentAgeLabel(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function agentStateClass(a) {
  return `is-${a ? window.husk.agents.state(a.state, { started: !!a.hasTranscript }) : 'done'}`;
}

// Only the waiting state is worded urgently; the other two label themselves
// quietly so one marker in the list carries the thing that needs a human.
function agentStateWord(a) {
  const st = a ? window.husk.agents.state(a.state, { started: !!a.hasTranscript }) : 'done';
  return { blocked: 'needs you', running: 'working', failed: 'failed' }[st] || 'done';
}

// What the agent is doing right now.
function agentSubtitle(a) {
  if (a.detail) return a.detail;
  if (a.needs) return a.needs;
  if (a.intent) return a.intent;
  return a.running ? 'starting up' : 'no activity recorded';
}

// The title leads, and the id rides the second line, since every agent a chat
// starts inherits that chat's title and only the id differs between siblings.
function agentHeadline(a) { return a.name || a.id || ''; }
function agentShortId(a) { return String(a.id || a.sessionId || '').slice(0, 8); }

// Order is the message: what is waiting on a human first, then what is still
// moving, then what is over. Newest first inside each of the three.
const AGENT_SECTIONS = [
  { key: 'blocked', label: 'Needs you', has: (a) => a.running && a.state === 'blocked' },
  { key: 'running', label: 'Running', has: (a) => a.running && a.state !== 'blocked' },
  { key: 'done', label: 'Finished', has: (a) => !a.running },
];

function agentSections(rows) {
  return AGENT_SECTIONS
    .map((sec) => ({ label: sec.label, items: rows.filter(sec.has).sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0)) }))
    .filter((sec) => sec.items.length);
}

async function openAgentSwitch() {
  const el = $('#agent-switch');
  if (!el) return;
  if (!$('#palette').hidden) closePalette();   // two stacked overlays would fight over the same keys
  el.hidden = false;
  const input = $('#agent-switch-input');
  input.value = '';
  agentSwitch = { rows: [], view: [], sel: 0, loading: true, error: '', supported: true };
  renderAgentSwitch('');
  input.focus();
  const token = ++agentSwitchLoad;
  let res = null;
  // The whole fleet, not just this project's: an agent is reachable from
  // wherever it was started.
  try { res = await window.husk.bgAgents.list({ all: true, allProjects: true }); } catch (err) { res = { ok: false, error: (err && err.message) || 'could not reach the agent list' }; }
  // Closed, or reopened while this call was in flight: the later open owns the list.
  if (el.hidden || token !== agentSwitchLoad) return;
  agentSwitch.loading = false;
  agentSwitch.supported = !res || res.supported !== false;
  agentSwitch.error = res && res.ok === false ? (res.error || 'could not list agents') : '';
  agentSwitch.rows = (res && Array.isArray(res.agents) ? res.agents : []).slice();
  renderAgentSwitch(input.value);
  paintTopbarAgents(res);
}

function closeAgentSwitch() {
  const el = $('#agent-switch');
  if (el) el.hidden = true;
  agentSwitch.view = [];
  if (term) term.focus();
}

// The topbar carries a standing count as the visible way into the switcher. It
// stands down only when there are no agents at all, so a finished agent still
// keeps the entry point on screen.
// Ids the pill has already accounted for. A new one means an agent appeared
// while the user was looking somewhere else, which is the moment worth pointing
// at. Seeded on the first poll so opening the app is not an arrival.
let topbarAgentIds = null;
let topbarAgentFlash = null;

function markTopbarAgentsSeen() {
  const el = $('#topbar-agents');
  if (!el) return;
  el.classList.remove('is-new');
  if (topbarAgentFlash) { clearTimeout(topbarAgentFlash); topbarAgentFlash = null; }
}

function paintTopbarAgents(res) {
  const el = $('#topbar-agents');
  if (!el) return;
  const agents = res && res.ok !== false && res.supported !== false && Array.isArray(res.agents) ? res.agents : [];
  const live = agents.filter((a) => a && a.running);
  const blocked = live.filter((a) => a.state === 'blocked').length;
  const ids = new Set(agents.map((a) => a && a.id).filter(Boolean));
  if (topbarAgentIds === null) topbarAgentIds = ids;
  else {
    const arrived = [...ids].filter((id) => !topbarAgentIds.has(id));
    topbarAgentIds = ids;
    // Only while the center is shut: if it is open the arrival is already on
    // screen and the pill has nothing to announce.
    if (arrived.length && $('#agent-map') && $('#agent-map').hidden) {
      el.classList.add('is-new');
      if (topbarAgentFlash) clearTimeout(topbarAgentFlash);
      topbarAgentFlash = setTimeout(() => el.classList.remove('is-new'), 12000);
    }
  }
  if (!agents.length) { el.hidden = true; return; }
  el.hidden = false;
  // Live agents when there are any, otherwise the size of the fleet. Both are
  // numbers the center repeats, so the pill never advertises its own total.
  const n = live.length || agents.length;
  $('#topbar-agents-count').textContent = String(n);
  $('#topbar-agents-word').textContent = n === 1 ? 'agent' : 'agents';
  const needs = $('#topbar-agents-needs');
  needs.hidden = !blocked;
  needs.textContent = blocked ? `${blocked} needs you` : '';
  el.classList.toggle('is-blocked', !!blocked);
  el.classList.toggle('is-running', !!live.length && !blocked);
  el.classList.toggle('is-idle', !live.length);
  if (!live.length) el.title = `${n} finished agent${n === 1 ? '' : 's'} (Alt+A)`;
  else if (blocked) el.title = `${blocked} of ${n} running agent${n === 1 ? '' : 's'} is waiting on you (Alt+A)`;
  else el.title = `${n} agent${n === 1 ? '' : 's'} running (Alt+A)`;
}

async function refreshTopbarAgents() {
  if (!$('#topbar-agents')) return;
  let res = null;
  try { res = await window.husk.bgAgents.list({ all: true, allProjects: true }); } catch (_) { res = null; }
  paintTopbarAgents(res);
}

function agentSwitchMatches(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return agentSwitch.rows;
  return agentSwitch.rows.filter((a) =>
    (a.name || '').toLowerCase().includes(q)
    || (a.id || '').toLowerCase().includes(q)
    || (a.detail || '').toLowerCase().includes(q)
    || (a.intent || '').toLowerCase().includes(q));
}

// One drawing for every state the list can be in instead of rows, so an empty
// card is centred and iconed rather than one orphaned line at the row indent.
function agentSwitchEmptyHTML(title, hint) {
  return `<li class="as-empty" role="presentation">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M5 20c0-3.3 3.1-6 7-6s7 2.7 7 6"/></svg>
      <strong>${escapeHtml(title)}</strong><span>${escapeHtml(hint)}</span>
    </li>`;
}

function renderAgentSwitch(query) {
  const list = $('#agent-switch-list');
  if (!list) return;
  const esc = escapeHtml;
  agentSwitch.view = [];
  let html = '';
  let count = 0;
  if (agentSwitch.loading) {
    // Shape-preserving placeholders in the geometry of the loaded list, with a
    // label placeholder because that list is banded.
    html = '<li class="as-skel-group" role="presentation"><i></i></li>'
      + '<li class="as-skel" role="presentation"><i class="sk-dot"></i><i class="sk-name"></i><i class="sk-sub"></i><i class="sk-meta"></i></li>'.repeat(4);
  } else if (!agentSwitch.supported) {
    html = agentSwitchEmptyHTML('This tool has no background agents', 'Husk shows them for tools that start them.');
  } else if (agentSwitch.error) {
    html = agentSwitchEmptyHTML('Could not list agents', agentSwitch.error);
  } else {
    const rows = agentSwitchMatches(query);
    if (!rows.length) {
      html = agentSwitch.rows.length
        ? agentSwitchEmptyHTML('No agent matches', 'Clear the filter to see them all.')
        : agentSwitchEmptyHTML('No agents yet', 'Agents this chat starts in the background show up here.');
    } else {
      count = rows.length;
      // The flat view stays the index space every click, arrow and Enter speaks
      // in; the section labels are painted around it and own no index.
      const sections = agentSections(rows);
      agentSwitch.view = sections.flatMap((sec) => sec.items);
      agentSwitch.sel = Math.min(Math.max(agentSwitch.sel, 0), agentSwitch.view.length - 1);
      let i = 0;
      html = sections.map((sec) => `
    <li class="as-group" role="presentation">${esc(sec.label)}</li>` + sec.items.map((a) => {
        const idx = i++;
        return `
    <li class="as-row ${agentStateClass(a)}" id="as-row-${idx}" data-idx="${idx}" role="option" aria-selected="false">
      <span class="as-dot" aria-hidden="true"></span>
      <span class="as-text">
        <strong class="as-name">${esc(agentHeadline(a))}</strong>
        <span class="as-sub"><code class="as-id">${esc(agentShortId(a))}</code>${esc(agentSubtitle(a))}</span>
      </span>
      <span class="as-meta">
        <span class="as-state">${esc(agentStateWord(a))}</span>
        <span class="as-age">${esc(agentAgeLabel(a.startedAt))}</span>
      </span>
    </li>`;
      }).join('')).join('');
    }
  }
  // eslint-disable-next-line no-unsanitized/property -- Every interpolated value is escaped or a literal.
  list.innerHTML = html;
  // A key hint that does nothing is worse than no hint, so the row keys stand
  // down whenever there is no row for them to reach.
  const navHints = $('#as-nav-hints');
  if (navHints) navHints.hidden = !agentSwitch.view.length;
  const foot = $('#as-foot-count');
  if (foot) foot.textContent = count ? `${count} agent${count === 1 ? '' : 's'}` : '';
  // Measured, not guessed: the bottom ramp is only honest while there is
  // something below the fold, and the list is polled across that threshold.
  list.classList.toggle('is-scrollable', list.scrollHeight > list.clientHeight + 1);
  paintAgentSwitchSel(false);
}

// Moving the selection flips a class and never rebuilds the list: replacing the
// rows under the pointer destroys the one being pressed, so its click is lost.
function paintAgentSwitchSel(scroll) {
  const list = $('#agent-switch-list');
  const input = $('#agent-switch-input');
  if (!list || !input) return;
  let active = null;
  list.querySelectorAll('li.as-row').forEach((li, i) => {
    const on = i === agentSwitch.sel;
    li.classList.toggle('active', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) active = li;
  });
  if (active) input.setAttribute('aria-activedescendant', active.id);
  else input.removeAttribute('aria-activedescendant');
  if (scroll && active) active.scrollIntoView({ block: 'nearest' });
}

async function openAgentFromSwitch(idx) {
  const a = agentSwitch.view[idx];
  if (!a) return;
  closeAgentSwitch();
  await openBgAgent(a);
}

async function openBgAgent(a) {
  if (agentOpening) return;                    // the tab takes a round trip to appear, so one press is one tab
  // Same rule as the session lists: an agent already on screen is focused
  // rather than opened beside itself.
  if (focusOpenSession(a && a.sessionId)) return;
  agentOpening = true;
  try {
    let res = null;
    try {
      res = await window.husk.bgAgents.openCommand({
        id: a.id, sessionId: a.sessionId, attach: !!a.attachable, cwd: a.cwd || '',
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || 'could not open that agent' }; }
    if (!res || !res.ok) {
      toast((res && res.error) || 'could not open that agent', 'error');
      return;
    }
    setPage('chat');
    const tab = await openNewChatTab({
      command: res.command,
      // The transcript's own directory, resolved by main: resuming anywhere
      // else makes the CLI deny the session exists.
      cwd: res.cwd || a.cwd || null,
      skipContext: true,
      skipWelcome: true,
    });
    if (tab) {
      tab.customTitle = a.name || a.id;
      tab.agentId = a.sessionId || '';
      renderTabStrip();
    }
    toast(`Opened ${a.name || a.id}`, 'success');
  } finally { agentOpening = false; }
}

function openPalette() {
  if (!$('#agent-switch').hidden) closeAgentSwitch();
  $('#palette').hidden = false;
  $('#palette-input').value = '';
  paletteSel = 0;
  renderPalette('');
  $('#palette-input').focus();
}
function closePalette() { $('#palette').hidden = true; if (term) term.focus(); }
function renderPalette(query) {
  const q = query.toLowerCase().trim();
  const matches = PALETTE_ACTIONS
    .filter((a) => !a.claudeOnly || agentKindCache === 'claude')
    .filter((a) => typeof a.show !== 'function' || a.show())
    .filter((a) => !q || a.label.toLowerCase().includes(q));
  // eslint-disable-next-line no-unsanitized/property -- Palette labels are escaped and icons are trusted constants.
  $('#palette-list').innerHTML = matches.map((a, i) => `
    <li class="${i === paletteSel ? 'active' : ''}" data-idx="${i}">
      <span class="pi-icon">${a.icon}</span>
      <span>${escapeHtml(a.label)}</span>
      ${a.shortcut ? `<span class="pi-shortcut">${a.shortcut}</span>` : ''}
    </li>
  `).join('');
  $('#palette-list').querySelectorAll('li').forEach((li, i) =>
    li.addEventListener('click', () => { paletteSel = i; runPaletteAction(matches); })
  );
  // Keep the highlighted row in view as the user arrows past the visible area.
  const active = $('#palette-list li.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function runPaletteAction(matches) {
  const a = matches[paletteSel];
  closePalette();
  if (a) try { a.run(); } catch (err) { toast(err.message, 'error'); }
}
$('#palette-input').addEventListener('input', (e) => { paletteSel = 0; renderPalette(e.target.value); });
$('#palette-input').addEventListener('keydown', (e) => {
  const visible = $$('#palette-list li');
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(visible.length - 1, paletteSel + 1); renderPalette($('#palette-input').value); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(0, paletteSel - 1); renderPalette($('#palette-input').value); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const q = $('#palette-input').value;
    const matches = PALETTE_ACTIONS.filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase().trim()));
    runPaletteAction(matches);
  }
});
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });

$('#agent-switch-input').addEventListener('input', (e) => { agentSwitch.sel = 0; renderAgentSwitch(e.target.value); });
$('#agent-switch-input').addEventListener('keydown', (e) => {
  const rows = agentSwitch.view;
  // Nothing else may act on this Esc: the page underneath has its own, and one
  // press must close one layer.
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAgentSwitch(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    const step = e.key === 'ArrowDown' ? 1 : -1;
    agentSwitch.sel = (agentSwitch.sel + step + rows.length) % rows.length;
    paintAgentSwitchSel(true);
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); openAgentFromSwitch(agentSwitch.sel); }
});
$('#agent-switch-list').addEventListener('mousedown', (e) => {
  // A row cannot hold focus, so letting the press move it would strand the
  // arrows and Enter away from the input that handles them.
  if (e.target.closest('li.as-row')) e.preventDefault();
});
$('#agent-switch-list').addEventListener('click', (e) => {
  const li = e.target.closest('li.as-row');
  if (li) openAgentFromSwitch(Number(li.dataset.idx));
});
$('#agent-switch-list').addEventListener('mousemove', (e) => {
  // Only a real pointer move re-aims the selection: scrolling a row under a
  // parked cursor would otherwise undo the arrow key that caused the scroll.
  if (e.clientX === agentSwitchPointer.x && e.clientY === agentSwitchPointer.y) return;
  agentSwitchPointer = { x: e.clientX, y: e.clientY };
  const li = e.target.closest('li.as-row');
  if (!li) return;
  const idx = Number(li.dataset.idx);
  if (!Number.isInteger(idx) || idx === agentSwitch.sel) return;
  agentSwitch.sel = idx;
  paintAgentSwitchSel(false);
});
$('#agent-switch').addEventListener('click', (e) => { if (e.target.id === 'agent-switch') closeAgentSwitch(); });
// ─── Agent command center ───────────────────────────────────────────────────
// Every background agent on this machine, grouped by what it needs: the ones
// waiting on a human first, then the ones working, then the finished. A detail
// pane streams what the selected agent is doing right now. Polls while open and
// only repaints what changed, so the picture is live without flicker.

const agentMap = {
  rows: [], selected: null, filter: 'live', q: '',
  timer: null, ticker: null, loading: false, inflight: false,
  sig: '', view: [], supported: true, error: '',
  feed: { sessionId: '', entries: [], model: '', busy: false },
  // Graph view: the camera, the ids already drawn (so only genuinely new agents
  // animate in), and the live element maps a repaint reconciles against.
  chats: [],
  mode: 'canvas', cam: { x: 0, y: 0, k: 1 }, known: new Set(), fitted: false,
  nodeEls: new Map(), edgeEls: new Map(), drag: null, layout: [],
};

const AM_POLL_MS = 2000;
const AM_VIEW_KEY = 'husk.agentView';

// The four conditions a reader acts on. A state the CLI does not report as
// live reads as finished, never as running.
function amStateOf(a) {
  if (!a) return 'done';
  return window.husk.agents.state(a.state, { started: !!a.hasTranscript });
}

// Failed agents sit under the finished filter: both are over.
function amFilterKeyOf(a) {
  const st = amStateOf(a);
  return st === 'failed' ? 'done' : st;
}

// Terse in the list ("46m"), exact in the detail pane ("46m 12s").
function amElShort(ms) {
  const s = Math.max(0, Math.round((Date.now() - (Number(ms) || Date.now())) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
function amElLong(ms) {
  const s = Math.max(0, Math.round((Date.now() - (Number(ms) || Date.now())) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function amProjectName(cwd) {
  const p = String(cwd || '').replace(/[\\/]+$/, '');
  return p.split(/[\\/]/).pop() || '';
}

function amFmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

// What a row says under its name: the live one-liner if the agent reports one.
function amRowSub(a) {
  const st = amStateOf(a);
  if (st === 'blocked') return a.needs || a.detail || 'Waiting on you';
  if (st === 'running') return a.detail || a.intent || 'Starting up';
  if (st === 'failed') return a.detail || a.intent || 'Failed';
  const epilogue = (a.detail || a.intent || '').trim();
  return epilogue.toLowerCase() === 'finished' ? '' : epilogue;
}

// Live is running plus waiting on a human: both are agents still in flight, and
// that is the set worth opening on.
function amInFilter(a) {
  if (agentMap.filter === 'all') return true;
  if (agentMap.filter === 'live') return window.husk.agents.isLive(a.state);
  return amFilterKeyOf(a) === agentMap.filter;
}

function amMatches(a) {
  if (!amInFilter(a)) return false;
  const q = agentMap.q;
  if (!q) return true;
  return [a.name, a.id, a.detail, a.intent, a.needs, amProjectName(a.cwd)]
    .some((v) => String(v || '').toLowerCase().includes(q));
}

const AM_SECTIONS = [
  { key: 'blocked', label: 'Needs you' },
  { key: 'running', label: 'Running' },
  { key: 'failed', label: 'Failed' },
  { key: 'done', label: 'Finished' },
];

// Whether more than one project is on screen, which decides if rows carry a
// project chip. The chip only appears on rows away from the dominant project,
// so the common case never repeats itself down the list.
function amMultiProject(rows) {
  return new Set(rows.map((a) => a.cwd || '')).size > 1;
}

function amDominantProject(rows) {
  const counts = new Map();
  for (const a of rows) counts.set(a.cwd || '', (counts.get(a.cwd || '') || 0) + 1);
  let best = '';
  let n = -1;
  for (const [cwd, c] of counts) if (c > n) { best = cwd; n = c; }
  return best;
}

function amPaintCounts() {
  const by = { all: agentMap.rows.length, blocked: 0, running: 0, failed: 0, done: 0 };
  for (const a of agentMap.rows) by[amStateOf(a)]++;
  by.live = by.blocked + by.running;
  // The Finished chip counts what its filter shows, which includes failures.
  by.done += by.failed;
  for (const k of Object.keys(by)) {
    const el = $(`#am-n-${k}`);
    if (el) el.textContent = agentMap.rows.length ? String(by[k]) : '';
  }
  $$('#am-filters .am-chip').forEach((c) => {
    const on = c.dataset.amFilter === agentMap.filter;
    c.classList.toggle('is-active', on);
    c.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const sub = $('#am-sub');
  if (sub) {
    if (!agentMap.supported) sub.textContent = 'This agent CLI does not report background agents';
    else if (agentMap.error) sub.textContent = 'Could not reach the agent list';
    else if (!agentMap.rows.length) sub.textContent = 'Nothing running on this machine';
    else {
      const bits = [];
      if (by.running) bits.push(`<span class="am-sub-live">${by.running} running</span>`);
      if (by.blocked) bits.push(`<span class="am-sub-needs">${by.blocked} need${by.blocked === 1 ? 's' : ''} you</span>`);
      if (by.failed) bits.push(`<span class="am-sub-failed">${by.failed} failed</span>`);
      bits.push(`${by.all} total`);
      // eslint-disable-next-line no-unsanitized/property -- Numbers and literals only.
      sub.innerHTML = bits.join(' <span aria-hidden="true">·</span> ');
    }
  }
}

function amBlankState() {
  if (!agentMap.supported) {
    return { t: 'No background agents here', m: 'The active CLI does not run agents in the background. Switch to claude to use them.', art: true };
  }
  if (agentMap.error) return { t: 'Could not list agents', m: agentMap.error };
  if (!agentMap.rows.length) return { t: 'No agents yet', m: 'Ask your chat to work on something in the background and it will show up here, live.', art: true };
  if (agentMap.q) return { t: 'No matches', m: '', q: agentMap.q, act: 'Clear search', art: true };
  if (agentMap.filter === 'live') {
    return {
      t: 'Nothing running right now',
      m: 'Agents appear here the moment one starts, and the graph grows as they spawn their own.',
      act: `Show all ${agentMap.rows.length} agents`,
      art: true,
    };
  }
  const label = { blocked: 'waiting on you', running: 'running', done: 'finished' }[agentMap.filter] || '';
  return { t: `No agents ${label}`, m: 'They will appear here the moment one is.', act: 'Show all agents', art: true };
}

function amPaintList() {
  const list = $('#am-list');
  const blank = $('#am-blank');
  const body = $('#agent-map .am-body');
  if (!list || !blank) return;

  if (agentMap.loading) {
    blank.hidden = true;
    if (body) body.classList.remove('is-empty');
    // eslint-disable-next-line no-unsanitized/property -- Static skeleton markup.
    list.innerHTML = '<li class="am-skel" role="presentation"><i class="sk-dot"></i><i class="sk-name"></i><i class="sk-sub"></i><i class="sk-meta"></i></li>'.repeat(3);
    return;
  }

  const rows = agentMap.rows.filter(amMatches);
  const showProj = amMultiProject(agentMap.rows);
  const domProj = showProj ? amDominantProject(agentMap.rows) : '';
  agentMap.view = [];

  if (!rows.length) {
    list.innerHTML = '';
    const b = amBlankState();
    // An illustration for having nothing; the plain glyph for having a problem.
    const art = $('#am-blank-art');
    const icon = $('#am-blank-icon');
    if (art) art.hidden = !b.art;
    if (icon) icon.hidden = !!b.art;
    $('#am-blank-t').textContent = b.t;
    const msg = $('#am-blank-m');
    if (b.q) {
      msg.replaceChildren(
        document.createTextNode('Nothing matches '),
        Object.assign(document.createElement('code'), { textContent: b.q }),
        document.createTextNode('.'),
      );
    } else {
      msg.textContent = b.m;
    }
    const act = $('#am-blank-act');
    if (act) {
      act.hidden = !b.act;
      act.textContent = b.act || '';
      act.onclick = () => {
        const q = $('#am-search-input');
        if (q) q.value = '';
        agentMap.q = '';
        agentMap.filter = 'all';
        amPaint();
        amAutoSelect({ prune: true });
        amRefit();
      };
    }
    blank.hidden = false;
    // Nothing to list means nothing to detail: the message owns the full card
    // instead of sitting beside a dead pane.
    if (body) body.classList.add('is-empty');
    amPaintDetail();
    return;
  }
  blank.hidden = true;
  if (body) body.classList.remove('is-empty');

  const esc = escapeHtml;
  let html = '';
  for (const sec of AM_SECTIONS) {
    const items = rows
      .filter((a) => amStateOf(a) === sec.key)
      .sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0));
    if (!items.length) continue;
    html += `<li class="am-sect is-${sec.key}" role="presentation">${sec.label} <span class="am-sect-n">${items.length}</span></li>`;
    for (const a of items) {
      const st = amStateOf(a);
      const live = st === 'running' || st === 'blocked';
      const sub = amRowSub(a);
      agentMap.view.push(a.id);
      const proj = showProj && (a.cwd || '') !== domProj && amProjectName(a.cwd)
        ? `<span class="am-row-proj">${esc(amProjectName(a.cwd))}</span>` : '';
      html += `
    <li class="am-row is-${st}${sub ? '' : ' is-compact'}${agentMap.selected === a.id ? ' is-selected' : ''}" data-am-id="${esc(a.id)}" role="option" aria-selected="${agentMap.selected === a.id}">
      <span class="am-dot" aria-hidden="true"></span>
      <span class="am-row-name">${esc(a.name || a.id || 'agent')}</span>
      <span class="am-row-sub">${esc(sub)}</span>
      <span class="am-row-meta">
        <span class="am-row-time" data-am-ts="${Number(a.startedAt) || 0}" data-am-live="${live ? 1 : 0}">${esc(amElShort(a.startedAt))}</span>
        ${proj}
      </span>
    </li>`;
    }
  }
  const keepScroll = list.scrollTop;
  // A filter that hides rows says what it is hiding instead of leaving a void.
  const hidden = agentMap.rows.length - rows.length;
  if (hidden > 0 && (agentMap.filter !== 'all' || agentMap.q)) {
    html += `<li class="am-hidden-note" role="presentation"><button type="button" id="am-show-all">${hidden} hidden by ${agentMap.q ? 'search' : 'filter'} · Show all</button></li>`;
  }
  // eslint-disable-next-line no-unsanitized/property -- Every interpolated value is escaped.
  list.innerHTML = html;
  list.scrollTop = keepScroll;
  const showAll = $('#am-show-all');
  if (showAll) {
    showAll.onclick = () => {
      const q = $('#am-search-input');
      if (q) q.value = '';
      agentMap.q = '';
      agentMap.filter = 'all';
      amPaint();
      amAutoSelect({ prune: true });
      amRefit();
    };
  }
}

// ─── Spawn graph ────────────────────────────────────────────────────────────
// The same fleet as the list, drawn along the axis a list cannot express: who
// started whom. Lineage comes from `parentSessionId`, which the agent list
// resolves from the daemon roster and the transcript head. Layout is a pure
// function of the rows so a two-second repaint lands every node exactly where
// it was, and a node only moves when the shape of the fleet actually changed.

// A cell is one leaf's worth of horizontal room. The glyph is what the eye
// tracks and the label hangs under it, so the card is small enough that a wide
// generation still fits across the pane.
const AM_CELL_W = 132;
const AM_CELL_H = 146;
// Where a card's ink ends: glyph, then label, then the line under it. Used as
// the first guess before a painted card is measured.
const AM_NODE_BOT = 102;
const AM_NODE_BOT_LG = 124;
const AM_NODE_W = AM_CELL_W;
const AM_NODE_H = AM_NODE_BOT_LG;
const AM_ROOT_GAP = 44;
const AM_FIT_PAD = 44;
const AM_ZOOM_MIN = 0.35;
const AM_ZOOM_MAX = 1.8;
// Framing may magnify a small fleet, which is what makes a bigger window worth
// asking for, but only so far: past this a handful of agents reads as a poster.
const AM_FIT_MAX = 1.12;
const AM_FIT_MAX_TINY = 1.2;
// Guards a parent chain that loops: layout walks depth-first, so a cycle would
// recurse forever without a ceiling on top of the visited set.
const AM_DEPTH_MAX = 24;

function amSavedView() {
  try {
    const v = localStorage.getItem(AM_VIEW_KEY);
    return v === 'list' ? 'list' : 'canvas';
  } catch (_) { return 'canvas'; }
}

function amSaveView(mode) {
  try { localStorage.setItem(AM_VIEW_KEY, mode); } catch (_) {}
}

// True when following an agent's parents leads back to itself. Such a node is
// drawn as a root rather than dropped, so a bad lineage costs an edge and never
// a whole agent.
function amAncestorLoops(a, parentOf) {
  const seen = new Set([a.id]);
  let cur = parentOf(a);
  let hops = 0;
  while (cur && hops++ < 64) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = parentOf(cur);
  }
  return false;
}

// Nothing runs on its own: an agent was started by a chat, and a sub-agent by
// another agent. The forest is therefore rooted in chats, not in agents. Where
// the chat that started an agent is gone, the project it ran in stands in, so
// every agent still hangs off something rather than floating.
function amChatNode(chat) {
  return {
    id: `chat:${chat.sessionId}`,
    sessionId: chat.sessionId,
    name: chat.name || 'Chat',
    cwd: chat.cwd || '',
    kind: 'chat',
    running: chat.status !== 'done',
    state: chat.status === 'busy' ? 'working' : '',
    startedAt: chat.startedAt || 0,
  };
}

function amProjectNode(cwd) {
  return {
    id: `proj:${cwd}`,
    sessionId: '',
    name: amProjectName(cwd) || 'Elsewhere',
    cwd,
    kind: 'project',
    running: false,
    state: 'done',
    startedAt: 0,
  };
}

function amBuildTree(rows, chats) {
  const bySession = new Map();
  for (const a of rows) if (a.sessionId) bySession.set(a.sessionId, a);
  const chatBySession = new Map();
  for (const c of (chats || [])) if (c && c.sessionId) chatBySession.set(c.sessionId, c);

  const agentParent = (a) => {
    const p = a && a.parentSessionId ? bySession.get(a.parentSessionId) : null;
    return p && p.id !== a.id ? p : null;
  };
  const order = rows.slice().sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0)
    || String(x.id).localeCompare(String(y.id)));

  const kids = new Map();
  const roots = [];
  const holders = new Map();
  const attach = (parentId, node) => {
    if (!kids.has(parentId)) kids.set(parentId, []);
    kids.get(parentId).push(node);
  };
  // A holder is created only when something needs it, so an idle chat or an
  // untouched project never appears as an empty root.
  const holderFor = (node) => {
    if (holders.has(node.id)) return holders.get(node.id);
    holders.set(node.id, node);
    roots.push(node);
    return node;
  };

  for (const a of order) {
    const parent = agentParent(a);
    if (parent && !amAncestorLoops(a, agentParent)) { attach(parent.id, a); continue; }
    const chat = a.parentSessionId ? chatBySession.get(a.parentSessionId) : null;
    if (chat) { attach(holderFor(amChatNode(chat)).id, a); continue; }
    attach(holderFor(amProjectNode(a.cwd || '')).id, a);
  }
  return { roots, kids };
}

// Tidy tree, top down: depth sets y, a running cursor lays leaves out across the
// x axis, and a parent centres over the span of its children. Generations read
// as rows, which is how a spawn tree is understood.
function amLayout(tree, aspect = 1.9) {
  const out = [];
  const placed = new Set();
  let cursor = 0;
  const walk = (a, depth, parent) => {
    if (placed.has(a.id)) return null;
    placed.add(a.id);
    const children = depth >= AM_DEPTH_MAX ? [] : (tree.kids.get(a.id) || []);
    const node = {
      a, depth, parent, x: 0, y: depth * AM_CELL_H,
      live: window.husk.agents.isLive(a.state), kids: 0,
    };
    // Pushed before its children, so the array is the tree in reading order:
    // a parent, then everything it started, then the next parent.
    out.push(node);
    // Branches keep their own column so their subtree reads down the page.
    // Leaves are just a set, and a chat that started twenty agents would draw a
    // row two thousand pixels wide, so they wrap into a block under the parent.
    const laid = [];
    const hasKids = (c) => ((tree.kids.get(c.id) || []).length > 0);
    for (const c of children.filter(hasKids)) {
      const r = walk(c, depth + 1, node);
      if (r) laid.push(r);
    }
    const leaves = children.filter((c) => !hasKids(c));
    if (leaves.length) {
      const perRow = Math.max(1, Math.round(Math.sqrt(leaves.length * aspect * (AM_CELL_H / AM_CELL_W))) || 1);
      const startX = cursor;
      const grid = [];
      leaves.forEach((c, i) => {
        const r = walk(c, depth + 1, node);
        if (!r) return;
        r.x = startX + (i % perRow) * AM_CELL_W;
        r.y = (depth + 1 + Math.floor(i / perRow)) * AM_CELL_H;
        grid.push(r);
        laid.push(r);
      });
      cursor = startX + Math.min(leaves.length, perRow) * AM_CELL_W;
      // A block deeper than one row has no lane a connector could take to its
      // lower rows without running over the row above. The block is drawn as
      // one region on a single stem instead, and its members carry no line.
      if (grid.length && Math.ceil(grid.length / perRow) > 1) {
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (const r of grid) {
          r.inBlock = true;
          x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x);
          y0 = Math.min(y0, r.y); y1 = Math.max(y1, r.y);
        }
        node.block = { x: x0, y: y0, w: (x1 - x0) + AM_CELL_W, h: (y1 - y0) + AM_NODE_BOT };
      }
    }
    if (laid.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of laid) { lo = Math.min(lo, c.x); hi = Math.max(hi, c.x); }
      node.x = (lo + hi) / 2;
      node.kids = laid.reduce((n, c) => n + 1 + c.kids, 0);
      // An edge earns its current from the work below it, not from its own node.
      if (laid.some((c) => c.live)) node.live = true;
    } else {
      node.x = cursor;
      cursor += AM_CELL_W;
    }
    return node;
  };
  // Every root is a chat or a project, and each holds its own block, so they sit
  // side by side with a gap between them.
  for (const r of tree.roots) {
    walk(r, 0, null);
    cursor += AM_ROOT_GAP;
  }
  return out;
}

// From the parent's rim to the top of the child's glyph. Sideways moves happen
// only on the corridor between two generations, which holds no card.
const AM_EDGE_R = 14;
// Clear air between the last line of a card's text and the corridor below it.
const AM_EDGE_GAP = 7;

// Card height follows the type inside it, which moves with the font scale, so
// it is measured from a painted card rather than assumed.
function amCardMetrics() {
  const m = { glyph: 44, glyphLg: 54, bottom: AM_NODE_BOT, bottomLg: AM_NODE_BOT_LG };
  for (const [, el] of agentMap.nodeEls) {
    const g = el.querySelector('.am-node-glyph');
    const t = el.querySelector('.am-node-time');
    const l = el.querySelector('.am-node-label');
    if (!g) continue;
    const last = t && t.offsetHeight ? t : l;
    const bottom = last ? last.offsetTop + last.offsetHeight : g.offsetTop + g.offsetHeight;
    if (el.classList.contains('is-holder')) {
      m.glyphLg = Math.max(m.glyphLg, g.offsetTop + g.offsetHeight);
      m.bottomLg = Math.max(m.bottomLg, bottom);
    } else {
      m.glyph = Math.max(m.glyph, g.offsetTop + g.offsetHeight);
      m.bottom = Math.max(m.bottom, bottom);
    }
  }
  return m;
}
// Breathing room between a block's region and the cards inside it.
const AM_BLOCK_PAD = 14;

function amEdgePath(p, c) {
  const m = agentMap.card || amCardMetrics();
  const holder = !!p.a.kind;
  const x1 = p.x + AM_CELL_W / 2;
  const x2 = c.x + AM_CELL_W / 2;
  const y2 = c.y;
  // The rim of the circle, so the line reads as leaving the node itself. It
  // passes behind the card's name plate on its way down.
  const y1 = p.y + (holder ? m.glyphLg : m.glyph);
  // Below the parent's own text, where the row is empty all the way across, so
  // every sideways move happens where no card can be.
  const lane = p.y + (holder ? m.bottomLg : m.bottom) + AM_EDGE_GAP;
  const corridor = Math.max(y1 + 2, Math.min(lane, y2 - 2));
  if (Math.abs(x2 - x1) < 0.5) return `M${x1},${y1} L${x2},${y2}`;
  const dir = x2 > x1 ? 1 : -1;
  const r = Math.max(2, Math.min(AM_EDGE_R, Math.abs(x2 - x1) / 2, Math.abs(y2 - corridor) / 2));
  return `M${x1},${y1}`
    + ` L${x1},${corridor - r}`
    + ` Q${x1},${corridor} ${x1 + dir * r},${corridor}`
    + ` L${x2 - dir * r},${corridor}`
    + ` Q${x2},${corridor} ${x2},${corridor + r}`
    + ` L${x2},${y2}`;
}

function amPolishSparseLayout(layout) {
  if (layout.length > 3) return false;
  const root = layout.find((n) => n.a.kind);
  const child = layout.find((n) => !n.a.kind);
  if (!root || !child) return true;
  root.x -= 10;
  child.x += 10;
  child.y = 128;
  return true;
}

function amApplyCam() {
  const stage = $('#am-cv-stage');
  const grid = $('#am-cv-grid');
  const { x, y, k } = agentMap.cam;
  if (stage) stage.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${k})`;
  // The grid is painted on the pane rather than the stage, so it scrolls with
  // the camera instead of scaling its own dots into blobs.
  if (grid) {
    const s = 26 * k;
    grid.style.backgroundSize = `${s}px ${s}px`;
    grid.style.backgroundPosition = `${x}px ${y}px`;
  }
  const zl = $('#am-cv-zoom');
  if (zl) zl.textContent = `${Math.round(k * 100)}%`;
}

function amZoomTo(k, cx, cy) {
  const pane = $('#am-canvas-pane');
  if (!pane) return;
  const next = Math.min(AM_ZOOM_MAX, Math.max(AM_ZOOM_MIN, k));
  const cam = agentMap.cam;
  const r = pane.getBoundingClientRect();
  const px = cx == null ? r.width / 2 : cx - r.left;
  const py = cy == null ? r.height / 2 : cy - r.top;
  // Hold the point under the cursor still while the scale changes.
  cam.x = px - ((px - cam.x) / cam.k) * next;
  cam.y = py - ((py - cam.y) / cam.k) * next;
  cam.k = next;
  amApplyCam();
}

function amFit(animate) {
  const pane = $('#am-canvas-pane');
  const nodes = agentMap.layout;
  if (!pane || !nodes.length) return;
  // Layout size, not painted size: the card scales as it arrives, and a rect
  // read mid-entrance carries that scale into the framing.
  const r = { width: pane.clientWidth, height: pane.clientHeight };
  if (!r.width || !r.height) return;
  let maxX = 0;
  let maxY = 0;
  const cardH = Math.max(AM_NODE_H, (agentMap.card || {}).bottom || 0, (agentMap.card || {}).bottomLg || 0);
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + AM_NODE_W);
    maxY = Math.max(maxY, n.y + cardH);
  }
  const fitMax = nodes.length <= 2 ? AM_FIT_MAX_TINY : AM_FIT_MAX;
  const k = Math.min(fitMax, (r.width - AM_FIT_PAD * 2) / maxX, (r.height - AM_FIT_PAD * 2) / maxY);
  const cam = agentMap.cam;
  cam.k = Math.max(AM_ZOOM_MIN, k);
  cam.x = (r.width - maxX * cam.k) / 2;
  const spareY = Math.max(0, r.height - maxY * cam.k);
  cam.y = nodes.length <= 2
    ? spareY / 2 - Math.min(16, spareY * 0.04)
    : spareY / 2 - Math.min(30, spareY * 0.12);
  const stage = $('#am-cv-stage');
  if (stage) {
    stage.classList.toggle('is-gliding', !!animate);
    if (animate) setTimeout(() => stage.classList.remove('is-gliding'), 420);
  }
  amApplyCam();
}

// Pans just enough to bring a node inside the frame, so arrowing through the
// tree never walks the selection off screen and never re-centres what is
// already comfortably visible.
function amRevealNode(id) {
  const pane = $('#am-canvas-pane');
  const n = agentMap.layout.find((m) => m.a.id === id);
  if (!pane || !n) return;
  // Camera maths runs in layout space, so the pane is measured there too.
  const r = { width: pane.clientWidth, height: pane.clientHeight };
  if (!r.width) return;
  const cam = agentMap.cam;
  const m = 28;
  const left = cam.x + n.x * cam.k;
  const top = cam.y + n.y * cam.k;
  const right = left + AM_NODE_W * cam.k;
  const bottom = top + AM_NODE_H * cam.k;
  let dx = 0;
  let dy = 0;
  if (left < m) dx = m - left;
  else if (right > r.width - m) dx = (r.width - m) - right;
  if (top < m) dy = m - top;
  else if (bottom > r.height - m) dy = (r.height - m) - bottom;
  if (!dx && !dy) return;
  cam.x += dx;
  cam.y += dy;
  const stage = $('#am-cv-stage');
  if (stage) {
    stage.classList.add('is-gliding');
    setTimeout(() => stage.classList.remove('is-gliding'), 320);
  }
  amApplyCam();
}

function amNodeEl(a) {
  const el = document.createElement('div');
  el.className = 'am-node';
  el.setAttribute('role', 'option');
  el.dataset.amId = a.id;
  // eslint-disable-next-line no-unsanitized/property -- Static shell; every value lands via textContent in amPaintNode.
  el.innerHTML = '<span class="am-node-glyph">'
    + '<svg class="am-node-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"></svg>'
    + '<b class="am-node-kids"></b></span>'
    + '<span class="am-node-plate">'
    + '<span class="am-node-label"></span>'
    + '<span class="am-node-time"></span></span>';
  return el;
}

// The glyph says state without a legend: a check for finished, an exclamation
// for waiting on a human, a ring for work in flight.
const AM_MARKS = {
  done: 'M5.2 12.4l4.3 4.25L18.8 7.4',
  blocked: 'M12 6.25v7.25M12 17.8h.01',
  running: 'M12 5.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5z',
  failed: 'M8.5 8.5l7 7M15.5 8.5l-7 7',
  chat: 'M4.75 6.75a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v6.65a2 2 0 0 1-2 2H10l-4.15 3.45v-3.45h-.1a2 2 0 0 1-1-2z',
  project: 'M3.75 7.7a2 2 0 0 1 2-2h3.4l2 2h7.1a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2z',
};

function amCanvasLabel(s) {
  const raw = String(s || 'agent').trim() || 'agent';
  if (raw.length <= 30) return raw;
  const words = raw.split(/\s+/);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 28) break;
    out = next;
  }
  return `${out || raw.slice(0, 27).trimEnd()}…`;
}

function amPaintNode(el, n) {
  const a = n.a;
  const st = amStateOf(a);
  el.classList.toggle('is-holder', !!a.kind);
  el.classList.toggle('is-chat', a.kind === 'chat');
  el.classList.toggle('is-project', a.kind === 'project');
  el.classList.toggle('is-running', st === 'running');
  el.classList.toggle('is-blocked', st === 'blocked');
  el.classList.toggle('is-failed', st === 'failed');
  el.classList.toggle('is-done', st === 'done');
  el.classList.toggle('is-selected', agentMap.selected === a.id);
  el.classList.toggle('is-root', n.depth === 0);
  el.setAttribute('aria-selected', agentMap.selected === a.id ? 'true' : 'false');
  el.style.transform = `translate3d(${n.x}px, ${n.y}px, 0)`;
  const mark = el.querySelector('.am-node-mark');
  mark.replaceChildren();
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', a.kind ? AM_MARKS[a.kind] : AM_MARKS[st]);
  mark.appendChild(p);
  const rawName = a.name || a.id || 'agent';
  el.querySelector('.am-node-label').textContent = agentMap.layout.length <= 3 ? rawName : amCanvasLabel(rawName);
  const time = el.querySelector('.am-node-time');
  if (a.kind) {
    time.textContent = n.kids === 1 ? '1 agent' : `${n.kids} agents`;
    time.dataset.amLive = '0';
    time.dataset.amTs = '0';
  } else {
    time.textContent = amElShort(a.startedAt);
    time.dataset.amTs = String(Number(a.startedAt) || 0);
    time.dataset.amLive = st === 'done' ? '0' : '1';
  }
  const kids = el.querySelector('.am-node-kids');
  const badge = a.kind ? 0 : n.kids;
  kids.textContent = badge ? String(badge) : '';
  kids.hidden = !badge;
  // The whole card is the tooltip: the name in full plus what it is doing.
  el.title = `${a.name || a.id || 'agent'}\n${amRowSub(a)}`;
}

function amPaintCanvas() {
  const pane = $('#am-canvas-pane');
  const nodeLayer = $('#am-cv-nodes');
  const svg = $('#am-cv-edges');
  if (!pane || !nodeLayer || !svg) return;

  const rows = agentMap.rows.filter(amMatches);
  const box = pane.getBoundingClientRect();
  const aspect = box.height > 0 ? Math.max(0.4, Math.min(6, box.width / box.height)) : 1.9;
  const layout = amLayout(amBuildTree(rows, agentMap.chats), aspect);
  const sparse = amPolishSparseLayout(layout);
  agentMap.layout = layout;
  pane.classList.toggle('is-sparse', sparse);
  $('#am-cv-stage')?.classList.toggle('is-sparse', sparse);
  // The arrows walk the tree the way it is read: a parent, then its descendants.
  // Holders are scenery, not destinations, so they stay out of the walk.
  agentMap.view = layout.filter((n) => !n.a.kind).map((n) => n.a.id);

  let maxX = 0;
  let maxY = 0;
  const cardH = Math.max(AM_NODE_H, (agentMap.card || {}).bottom || 0, (agentMap.card || {}).bottomLg || 0);
  for (const n of layout) {
    maxX = Math.max(maxX, n.x + AM_NODE_W);
    maxY = Math.max(maxY, n.y + cardH);
  }
  svg.setAttribute('width', String(maxX));
  svg.setAttribute('height', String(maxY));
  svg.setAttribute('viewBox', `0 0 ${maxX} ${maxY}`);

  const seenNodes = new Set();
  const fresh = [];
  for (const n of layout) {
    const id = n.a.id;
    seenNodes.add(id);
    let el = agentMap.nodeEls.get(id);
    if (!el) {
      el = amNodeEl(n.a);
      // Placed before it joins the box tree, so the transform transition has
      // nothing to glide from and the card appears where it belongs.
      amPaintNode(el, n);
      if (!agentMap.known.has(id)) { el.classList.add('is-enter'); fresh.push(el); }
      agentMap.nodeEls.set(id, el);
      nodeLayer.appendChild(el);
      continue;
    }
    amPaintNode(el, n);
  }
  for (const [id, el] of agentMap.nodeEls) {
    if (seenNodes.has(id)) continue;
    el.remove();
    agentMap.nodeEls.delete(id);
  }

  // Block regions sit under everything else, so they read as ground the cards
  // stand on rather than as boxes drawn over them.
  let blockLayer = svg.querySelector('#am-cv-blocks');
  if (!blockLayer) {
    blockLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    blockLayer.setAttribute('id', 'am-cv-blocks');
    svg.insertBefore(blockLayer, svg.firstChild);
  }
  const blocks = layout.filter((n) => n.block);
  blockLayer.replaceChildren(...blocks.map((n) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('class', `am-block${n.live ? ' is-live' : ''}`);
    r.setAttribute('x', String(n.block.x - AM_BLOCK_PAD));
    r.setAttribute('y', String(n.block.y - AM_BLOCK_PAD));
    r.setAttribute('width', String(n.block.w + AM_BLOCK_PAD * 2));
    r.setAttribute('height', String(n.block.h + AM_BLOCK_PAD * 2));
    r.setAttribute('rx', '16');
    return r;
  }));

  agentMap.card = amCardMetrics();

  const seenEdges = new Set();
  for (const n of layout) {
    if (!n.parent || n.inBlock) continue;
    const key = `${n.parent.a.id}>${n.a.id}`;
    seenEdges.add(key);
    let path = agentMap.edgeEls.get(key);
    const brandNew = !path;
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      // Normalised length lets one dash pattern read the same on a short hop
      // and a long reach across the tree.
      path.setAttribute('pathLength', '1');
      agentMap.edgeEls.set(key, path);
    }
    path.setAttribute('d', amEdgePath(n.parent, n));
    path.setAttribute('class', `am-edge${n.live ? ' is-live' : ''}${brandNew && !agentMap.known.has(n.a.id) ? ' is-enter' : ''}`);
    if (brandNew) svg.appendChild(path);
  }
  for (const n of blocks) {
    const key = `${n.a.id}>block`;
    seenEdges.add(key);
    let path = agentMap.edgeEls.get(key);
    const brandNew = !path;
    if (!path) {
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('pathLength', '1');
      agentMap.edgeEls.set(key, path);
    }
    const target = { x: n.block.x + n.block.w / 2 - AM_CELL_W / 2, y: n.block.y - AM_BLOCK_PAD, a: {} };
    path.setAttribute('d', amEdgePath(n, target));
    path.setAttribute('class', `am-edge${n.live ? ' is-live' : ''}`);
    if (brandNew) svg.appendChild(path);
  }
  for (const [key, path] of agentMap.edgeEls) {
    if (seenEdges.has(key)) continue;
    path.remove();
    agentMap.edgeEls.delete(key);
  }

  for (const n of layout) agentMap.known.add(n.a.id);
  // The class only exists to start the animation; dropping it afterwards keeps
  // a later repaint from replaying an entrance the user already watched.
  if (fresh.length) {
    setTimeout(() => { for (const el of fresh) el.classList.remove('is-enter'); }, 700);
  }
  if (!agentMap.fitted && layout.length) {
    agentMap.fitted = true;
    requestAnimationFrame(() => amFit(false));
  }
}

function amSetView(mode, { save = true } = {}) {
  const next = mode === 'list' ? 'list' : 'canvas';
  agentMap.mode = next;
  if (save) amSaveView(next);
  $$('#am-views .am-view').forEach((b) => {
    const on = b.dataset.amView === next;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  amPaint(true);
  const focus = next === 'canvas' ? $('#am-cv-nodes') : $('#am-list');
  if (focus) focus.focus({ preventScroll: true });
}

// The list only rebuilds when what it would say changes, so pointer hover and
// scroll survive the poll. Timestamps live outside the signature; a ticker
// rewrites them in place.
function amSignature() {
  return JSON.stringify([
    agentMap.filter, agentMap.q, agentMap.selected, agentMap.loading,
    agentMap.supported, agentMap.error, agentMap.mode,
    agentMap.rows.map((a) => [a.id, amStateOf(a), a.name, amRowSub(a), a.cwd, a.parentSessionId || '']),
  ]);
}

// Nothing to draw means nothing to draw in either view, so the blank state is
// written once and the list pane owns it whichever view is selected.
function amHasRows() {
  return !agentMap.loading && agentMap.rows.filter(amMatches).length > 0;
}

function amPaint(force) {
  const sig = amSignature();
  if (!force && sig === agentMap.sig) { amPaintCounts(); return; }
  agentMap.sig = sig;
  amPaintCounts();
  const graph = agentMap.mode === 'canvas' && amHasRows();
  const pane = $('#am-canvas-pane');
  const listPane = $('#am-list-pane');
  const body = $('#agent-map .am-body');
  if (pane) pane.hidden = !graph;
  if (listPane) listPane.hidden = graph;
  // The detail pane belongs to whichever view is up, so the empty-card state is
  // decided here rather than inside one painter.
  if (body && graph) body.classList.remove('is-empty');
  if (graph) amPaintCanvas(); else amPaintList();
}

// Seconds tick without repainting rows: only the time cells are rewritten.
function amTick() {
  $$('#agent-map [data-am-ts][data-am-live="1"]').forEach((el) => {
    el.textContent = amElShort(Number(el.dataset.amTs) || 0);
  });
  const a = agentMap.rows.find((x) => x.id === agentMap.selected);
  const el = $('#am-d-elapsed');
  if (a && el) {
    // The chip already names the state; this is only the clock.
    const st = amStateOf(a);
    if (st === 'done') el.textContent = `${agentAgeLabel(a.startedAt) === 'now' ? 'just now' : agentAgeLabel(a.startedAt) + ' ago'}`;
    else if (st === 'blocked') el.textContent = `for ${amElShort(a.startedAt)}`;
    else el.textContent = amElLong(a.startedAt);
  }
}

function amFeedKindLabel(e) {
  if (e.kind === 'user') return 'you';
  if (e.kind === 'tool') return e.tool || 'tool';
  return 'agent';
}

function amPaintFeed() {
  const feed = $('#am-d-feed');
  if (!feed) return;
  const f = agentMap.feed;
  if (!f.entries.length) {
    // eslint-disable-next-line no-unsanitized/property -- Static markup.
    feed.innerHTML = `<li class="am-d-feed-empty" role="presentation">${f.busy ? 'Reading the transcript\u2026' : 'No activity recorded yet.'}</li>`;
    return;
  }
  const esc = escapeHtml;
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
  const prevLast = feed.dataset.last || '';
  const keyOf = (e) => `${e.ts}|${e.kind}|${(e.text || '').slice(0, 40)}`;
  const prevIdx = f.entries.findIndex((e) => keyOf(e) === prevLast);
  // eslint-disable-next-line no-unsanitized/property -- Every interpolated value is escaped.
  feed.innerHTML = f.entries.map((e, i) => `
    <li class="k-${esc(e.kind)}${prevLast && i > prevIdx && prevIdx !== -1 ? ' is-new' : ''}">
      <span class="fk">${esc(amFeedKindLabel(e))}</span>
      <span class="ft"><span class="ftxt">${esc(e.text || '')}</span></span>
      ${e.ts ? `<time class="ftime" datetime="${new Date(e.ts).toISOString()}">${esc(agentAgeLabel(e.ts))}</time>` : ''}
    </li>`).join('');
  feed.dataset.last = keyOf(f.entries[f.entries.length - 1]);
  if (atBottom || prevIdx === -1) {
    const pin = () => {
      feed.scrollTop = feed.scrollHeight;
      feed.scrollTop = Math.max(0, feed.scrollTop - 30);
    };
    pin();
    // Fonts or wrapping can settle a frame later; align again so the top fold
    // never slices through a readable row while the newest lines remain visible.
    requestAnimationFrame(pin);
  }
}

async function amFetchFeed(a) {
  if (!a || !a.sessionId) return;
  const f = agentMap.feed;
  if (f.busy) return;
  f.busy = true;
  if (f.sessionId !== a.sessionId) { f.sessionId = a.sessionId; f.entries = []; f.model = ''; const feed = $('#am-d-feed'); if (feed) feed.dataset.last = ''; amPaintFeed(); }
  let res = null;
  try { res = await window.husk.bgAgents.peek({ sessionId: a.sessionId, cwd: a.cwd || '' }); } catch (_) { res = null; }
  f.busy = false;
  if (!res || res.ok === false || f.sessionId !== a.sessionId) { amPaintFeed(); return; }
  f.entries = Array.isArray(res.entries) ? res.entries : [];
  if (res.model) f.model = res.model;
  amPaintFeed();
  amPaintFacts(a);
}

function amPaintFacts(a) {
  const facts = [
    amProjectName(a.cwd) ? ['project', amProjectName(a.cwd)] : null,
    agentMap.feed.sessionId === a.sessionId && agentMap.feed.model ? ['model', agentMap.feed.model] : null,
    a.tokens ? ['tokens', amFmtTokens(a.tokens)] : null,
  ].filter(Boolean);
  const nodes = facts.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    if (k === 'model') dd.classList.add('is-mono');
    dd.title = v;
    return [dt, dd];
  });
  // The id is a control: one click copies the whole thing.
  const full = String(a.sessionId || a.id || '');
  if (full) {
    const dt = document.createElement('dt'); dt.textContent = 'session';
    const dd = document.createElement('dd');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'am-d-copyid';
    btn.title = `Copy ${full}`;
    btn.setAttribute('aria-label', 'Copy session id');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const r1 = document.createElementNS(ns, 'rect');
    r1.setAttribute('x', '9'); r1.setAttribute('y', '9');
    r1.setAttribute('width', '11'); r1.setAttribute('height', '11');
    r1.setAttribute('rx', '2');
    const p1 = document.createElementNS(ns, 'path');
    p1.setAttribute('d', 'M5 15V6a2 2 0 0 1 2-2h9');
    svg.append(r1, p1);
    btn.append(document.createTextNode(full.slice(0, 8)), svg);
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(full); toast('Session id copied', 'success'); }
      catch (_) { toast('Could not copy', 'error'); }
    });
    dd.appendChild(btn);
    nodes.push(dt, dd);
  }
  $('#am-d-facts').replaceChildren(...nodes);
}

function amPaintDetail() {
  const a = agentMap.rows.find((x) => x.id === agentMap.selected) || null;
  const detail = $('#am-detail');
  const none = $('#am-detail-blank');
  if (!detail || !none) return;
  detail.hidden = !a;
  none.hidden = !!a;
  if (!a) return;
  const st = amStateOf(a);
  const stateEl = $('#am-d-state');
  stateEl.className = `am-state is-${st}`;
  stateEl.textContent = { blocked: 'Needs you', running: 'Running', failed: 'Failed' }[st] || 'Finished';
  $('#am-d-name').textContent = a.name || a.id || 'agent';
  const intent = a.intent || a.detail || a.needs || '';
  const intentEl = $('#am-d-intent');
  intentEl.textContent = intent;
  intentEl.hidden = !intent;
  amPaintFacts(a);
  amTick();
  const open = $('#am-d-open');
  const openable = a.attachable || a.hasTranscript;
  open.disabled = !openable;
  // The one urgent case borrows the amber and the verb changes with it: a
  // blocked agent is answered, not merely opened.
  open.classList.toggle('is-blocked', st === 'blocked');
  open.textContent = st === 'blocked' ? 'Respond' : 'Open session';
  open.title = openable
    ? (a.attachable ? 'Attach to the live agent' : 'Resume this session in a chat tab')
    : 'This agent left no transcript to open';
  open.onclick = () => { if (openable) { closeAgentMap(); openBgAgent(a); } };

  // A live agent is stopped; one that has already ended is removed.
  const end = $('#am-d-end');
  if (!end) return;
  const live = st === 'running' || st === 'blocked';
  end.textContent = live ? 'Stop' : 'Delete';
  end.title = live
    ? 'Stop this agent. Its conversation is kept.'
    : 'Delete this agent and anything it was working in';
  end.disabled = false;
  end.onclick = () => endBgAgent(a, live ? 'stop' : 'remove');
}

// Stopping keeps the conversation, so it goes through without ceremony.
// Removing throws the job away, so it is confirmed first.
async function endBgAgent(a, action) {
  const end = $('#am-d-end');
  if (!a || !end || end.disabled) return;
  const name = a.name || a.id || 'this agent';
  if (action === 'remove') {
    const ok = await openConfirmDialog({
      title: 'Delete this agent?',
      bodyHtml: `<p>${escapeHtml(name)} and anything it was working in go with it. Its conversation cannot be reopened afterwards.</p>`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
  }
  end.disabled = true;
  const was = end.textContent;
  end.textContent = action === 'stop' ? 'Stopping' : 'Deleting';
  let res = null;
  try {
    res = action === 'stop' ? await window.husk.bgAgents.stop(a.id) : await window.husk.bgAgents.remove(a.id);
  } catch (err) { res = { ok: false, error: (err && err.message) || 'that agent could not be ended' }; }
  if (!res || !res.ok) {
    end.disabled = false;
    end.textContent = was;
    toast((res && res.error) || 'that agent could not be ended', 'error');
    return;
  }
  toast(action === 'stop' ? `Stopped ${name}` : `Deleted ${name}`, 'success');
  if (action === 'remove') {
    agentMap.rows = agentMap.rows.filter((r) => r.id !== a.id);
    agentMap.selected = null;
  }
  await amRefresh();
  refreshTopbarAgents();
}

function amSelect(id, { scroll = false } = {}) {
  if (agentMap.selected === id) return;
  agentMap.selected = id;
  $$('#am-list .am-row').forEach((li) => {
    const on = li.dataset.amId === id;
    li.classList.toggle('is-selected', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on && scroll) li.scrollIntoView({ block: 'nearest' });
  });
  for (const [nid, el] of agentMap.nodeEls) {
    const on = nid === id;
    el.classList.toggle('is-selected', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  if (scroll && agentMap.mode === 'canvas') amRevealNode(id);
  amPaintDetail();
  const a = agentMap.rows.find((x) => x.id === id);
  if (a) amFetchFeed(a);
}

// Selection follows what matters: the first agent waiting on a human, else the
// first one running. A poll never steals the user's own pick, even one the
// current filter hides: acting on a picked agent must act on that agent. Only
// a deliberate narrowing (filter, search, view) prunes a hidden selection back
// to something visible.
function amAutoSelect({ prune = false } = {}) {
  const visible = agentMap.view;
  if (agentMap.selected && agentMap.rows.some((a) => a.id === agentMap.selected)
      && (!prune || !visible.length || visible.includes(agentMap.selected))) return;
  agentMap.selected = null;
  const pick = agentMap.rows.filter(amMatches)
    .sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))
    .sort((x, y) => {
      const rank = { blocked: 0, running: 1, failed: 2, done: 3 };
      return rank[amStateOf(x)] - rank[amStateOf(y)];
    })[0];
  if (pick) amSelect(pick.id);
  else amPaintDetail();
}

async function amRefresh() {
  if (agentMap.inflight) return;
  agentMap.inflight = true;
  let res = null;
  try { res = await window.husk.bgAgents.list({ all: true, allProjects: true }); } catch (_) { res = null; }
  agentMap.inflight = false;
  if ($('#agent-map').hidden) return;
  agentMap.loading = false;
  agentMap.supported = !(res && res.supported === false);
  agentMap.error = res && res.ok === false ? (res.error || 'could not list agents') : '';
  agentMap.rows = (res && res.ok !== false && Array.isArray(res.agents)) ? res.agents.slice() : [];
  agentMap.chats = (res && res.ok !== false && Array.isArray(res.chats)) ? res.chats.slice() : [];
  const foot = $('#am-foot');
  if (foot) foot.textContent = agentMap.rows.length ? `Updated ${new Date().toLocaleTimeString()}` : '';
  const sum = $('#am-foot-sum');
  if (sum) {
    const projects = new Set(agentMap.rows.map((a) => a.cwd || '')).size;
    sum.textContent = agentMap.rows.length
      ? `${agentMap.rows.length} agent${agentMap.rows.length === 1 ? '' : 's'} · ${projects} project${projects === 1 ? '' : 's'}`
      : '';
  }
  amPaint();
  amAutoSelect();
  amPaintDetail();
  // The pill is a window onto the same fleet; painting it from this answer
  // keeps the corner number and the open center from ever disagreeing.
  paintTopbarAgents(res);
  const sel = agentMap.rows.find((x) => x.id === agentMap.selected);
  if (sel) amFetchFeed(sel);
}

function openAgentMap() {
  const el = $('#agent-map');
  if (!el) return;
  el.hidden = false;
  markTopbarAgentsSeen();
  agentMap.loading = true;
  agentMap.sig = '';
  agentMap.q = '';
  // Every opening starts on what is happening now, whatever was left selected
  // last time.
  agentMap.filter = 'live';
  const q = $('#am-search-input');
  if (q) q.value = '';
  // A fresh opening draws itself: the fleet animates in and the camera frames
  // it once the first list lands.
  agentMap.known = new Set();
  agentMap.fitted = false;
  agentMap.layout = [];
  for (const n of agentMap.nodeEls.values()) n.remove();
  for (const p of agentMap.edgeEls.values()) p.remove();
  agentMap.nodeEls.clear();
  agentMap.edgeEls.clear();
  amSetView(amSavedView(), { save: false });
  amRefresh();
  if (agentMap.timer) clearInterval(agentMap.timer);
  agentMap.timer = setInterval(amRefresh, AM_POLL_MS);
  if (agentMap.ticker) clearInterval(agentMap.ticker);
  agentMap.ticker = setInterval(amTick, 1000);
}

function closeAgentMap() {
  const el = $('#agent-map');
  if (!el) return;
  el.hidden = true;
  if (agentMap.timer) { clearInterval(agentMap.timer); agentMap.timer = null; }
  if (agentMap.ticker) { clearInterval(agentMap.ticker); agentMap.ticker = null; }
  if (term) term.focus();
}

// The pill and Alt+A open the same center, over the same fleet the switcher
// lists, so the three never disagree about how many agents there are.
$('#topbar-agents').addEventListener('click', () => {
  if ($('#agent-map').hidden) openAgentMap(); else closeAgentMap();
});
$('#am-close') && $('#am-close').addEventListener('click', closeAgentMap);
$('#agent-map') && $('#agent-map').addEventListener('click', (e) => {
  if (e.target.id === 'agent-map') closeAgentMap();
});

// Narrowing or widening the set changes how much there is to look at, so the
// camera reframes. A poll never does this; only a deliberate change does.
function amRefit() {
  if (agentMap.mode === 'canvas') requestAnimationFrame(() => amFit(true));
}

$('#am-filters') && $('#am-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.am-chip');
  if (!chip) return;
  agentMap.filter = chip.dataset.amFilter || 'all';
  amPaint();
  amAutoSelect({ prune: true });
  amRefit();
});

$('#am-search-input') && $('#am-search-input').addEventListener('input', (e) => {
  agentMap.q = String(e.target.value || '').toLowerCase().trim();
  amPaint();
  amAutoSelect({ prune: true });
  amRefit();
});

$('#am-views') && $('#am-views').addEventListener('click', (e) => {
  const b = e.target.closest('.am-view');
  if (b) amSetView(b.dataset.amView);
});

// Canvas pointer model: a press on a node selects it, a press on the ground
// pans. The pan only begins after a few pixels of travel, so a click that
// wobbles still counts as a click.
$('#am-canvas-pane') && $('#am-canvas-pane').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.am-cv-hud')) return;
  const node = e.target.closest('.am-node');
  if (node) { if (!node.classList.contains('is-holder')) amSelect(node.dataset.amId); return; }
  const pane = e.currentTarget;
  agentMap.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: agentMap.cam.x, oy: agentMap.cam.y, moved: false };
  pane.setPointerCapture(e.pointerId);
});

$('#am-canvas-pane') && $('#am-canvas-pane').addEventListener('pointermove', (e) => {
  const d = agentMap.drag;
  if (!d || d.id !== e.pointerId) return;
  const dx = e.clientX - d.x;
  const dy = e.clientY - d.y;
  if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
  d.moved = true;
  e.currentTarget.classList.add('is-panning');
  agentMap.cam.x = d.ox + dx;
  agentMap.cam.y = d.oy + dy;
  amApplyCam();
});

const amEndPan = (e) => {
  const d = agentMap.drag;
  if (!d || d.id !== e.pointerId) return;
  agentMap.drag = null;
  e.currentTarget.classList.remove('is-panning');
  try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
};
$('#am-canvas-pane') && $('#am-canvas-pane').addEventListener('pointerup', amEndPan);
$('#am-canvas-pane') && $('#am-canvas-pane').addEventListener('pointercancel', amEndPan);

$('#am-canvas-pane') && $('#am-canvas-pane').addEventListener('dblclick', (e) => {
  const node = e.target.closest('.am-node');
  if (!node || node.classList.contains('is-holder')) { amFit(true); return; }
  const a = agentMap.rows.find((x) => x.id === node.dataset.amId);
  if (a && (a.attachable || a.hasTranscript)) { closeAgentMap(); openBgAgent(a); }
});

// The wheel zooms toward the pointer, which is what a graph is expected to do.
// Shift holds it to panning for anyone who wants to slide the frame instead.
$('#am-canvas-pane') && $('#am-canvas-pane').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.shiftKey) {
    agentMap.cam.x -= e.deltaX || e.deltaY;
    agentMap.cam.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
    amApplyCam();
    return;
  }
  amZoomTo(agentMap.cam.k * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
}, { passive: false });

$('#am-cv-in') && $('#am-cv-in').addEventListener('click', () => amZoomTo(agentMap.cam.k * 1.25));
$('#am-cv-out') && $('#am-cv-out').addEventListener('click', () => amZoomTo(agentMap.cam.k / 1.25));
$('#am-cv-zoom') && $('#am-cv-zoom').addEventListener('click', () => amZoomTo(1));
$('#am-cv-fit') && $('#am-cv-fit').addEventListener('click', () => amFit(true));

// Full screen grows the card to the window rather than trimming what is in it,
// then relays out and refits so the new room is actually used.
$('#am-cv-expand') && $('#am-cv-expand').addEventListener('click', () => {
  const card = $('#agent-map .am-card');
  const btn = $('#am-cv-expand');
  if (!card || !btn) return;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  card.classList.toggle('is-full', on);
  btn.classList.toggle('is-on', on);
  btn.title = on ? 'Back to the smaller card' : 'Fill the window';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  // Reframe when the card's resize has actually finished: a starved main
  // thread can hold the width transition past any fixed delay, and a refit
  // that fires mid-resize frames the size the card just left. transitionend
  // reports the real moment; the timer only covers reduced-motion, where no
  // transition ever fires.
  let reframed = false;
  const reframe = () => {
    if (reframed) return;
    reframed = true;
    card.removeEventListener('transitionend', onEnd);
    amPaint(true);
    amFit(true);
  };
  const onEnd = (e) => { if (e.target === card && (e.propertyName === 'width' || e.propertyName === 'height')) reframe(); };
  card.addEventListener('transitionend', onEnd);
  setTimeout(reframe, 700);
});

$('#am-list') && $('#am-list').addEventListener('click', (e) => {
  const li = e.target.closest('.am-row');
  if (li) amSelect(li.dataset.amId);
});
$('#am-list') && $('#am-list').addEventListener('dblclick', (e) => {
  const li = e.target.closest('.am-row');
  if (!li) return;
  const a = agentMap.rows.find((x) => x.id === li.dataset.amId);
  if (a && (a.attachable || a.hasTranscript)) { closeAgentMap(); openBgAgent(a); }
});

// One key model for the whole card, in the capture phase so the terminal
// underneath never sees a keystroke while the center is up: arrows move the
// selection, Enter opens it, / reaches the search, and plain typing starts a
// search from anywhere.
document.addEventListener('keydown', (e) => {
  const overlay = $('#agent-map');
  if (!overlay || overlay.hidden) return;
  if (e.key === 'Escape') return;              // the global Esc registry owns closing
  const search = $('#am-search-input');
  const inSearch = e.target === search;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopPropagation();
    const v = agentMap.view;
    if (!v.length) return;
    const i = v.indexOf(agentMap.selected);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = i === -1 ? (step === 1 ? 0 : v.length - 1) : Math.min(v.length - 1, Math.max(0, i + step));
    amSelect(v[next], { scroll: true });
    return;
  }
  if (e.key === 'Enter' && !inSearch) {
    const a = agentMap.rows.find((x) => x.id === agentMap.selected);
    if (a && (a.attachable || a.hasTranscript)) { e.preventDefault(); e.stopPropagation(); closeAgentMap(); openBgAgent(a); }
    return;
  }
  if (inSearch || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); e.stopPropagation(); search.focus(); return; }
  // Typing anywhere lands in the search box, first letter included.
  if (e.key.length === 1) {
    e.preventDefault(); e.stopPropagation();
    search.focus();
    search.value += e.key;
    search.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, true);

$('#btn-palette').addEventListener('click', openPalette);
// On the chat page, a printable or edit key pressed with nothing focused hands
// focus to the active terminal first, in the capture phase so the keystroke
// still lands there.
document.addEventListener('keydown', (e) => {
  if (currentPage !== 'chat' || !term) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target !== document.body) return;
  // The agent center owns the keys while it is up.
  if ($('#agent-map') && !$('#agent-map').hidden) return;
  if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') {
    try { term.focus(); } catch (_) {}
  }
}, true);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'r') {
    e.preventDefault();
    refreshFromShortcut();
    return;
  }
  if (e.key === 'F5') {
    e.preventDefault();
    reloadFromShortcut();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
  // Alt+1..6 page switch (Alt to avoid conflicting with terminal input)
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const map = { '1': 'chat', '2': 'skills', '3': 'sessions', '4': 'files', '5': 'mcp', '6': 'prefs', '7': 'agents' };
    if (map[e.key]) { e.preventDefault(); setPage(map[e.key]); }
    // Alt-keyed like the rest of the chrome so it never eats terminal input.
    if (String(e.key || '').toLowerCase() === 'a') {
      e.preventDefault();
      // The same surface the pill opens: one shortcut, one place agents live.
      if ($('#agent-map') && $('#agent-map').hidden) openAgentMap(); else closeAgentMap();
    }
  }
  // Ctrl/Cmd +/-/0 for renderer zoom
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); reportZoom(window.husk.ui.zoomIn()); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); reportZoom(window.husk.ui.zoomOut()); }
    else if (e.key === '0') { e.preventDefault(); reportZoom(window.husk.ui.zoomReset()); }
  }
});

// ─── Detail panel ────────────────────────────────────────────────────────────────
function showDetail({ eyebrow = '', title = '', sub = '', meta = [], body = '', actions = [] }) {
  $('#dp-eyebrow').textContent = eyebrow;
  $('#dp-title').textContent = title;
  $('#dp-sub').textContent = sub;
  // eslint-disable-next-line no-unsanitized/property -- Metadata keys/values are escaped via escapeHtml.
  $('#dp-meta').innerHTML = meta
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v || '')}</dd>`)
    .join('');
  $('#dp-body').textContent = body;
  $('#dp-foot').replaceChildren();
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = a.kind === 'primary' ? 'btn-primary' : 'ghost-btn';
    btn.textContent = a.label;
    btn.addEventListener('click', a.onClick);
    $('#dp-foot').appendChild(btn);
  }
  $('#detail-panel').hidden = false;
  document.body.dataset.detail = 'open';
  setTimeout(fitNow, 200);
}
function closeDetail() {
  $('#detail-panel').hidden = true;
  document.body.dataset.detail = 'closed';
  setTimeout(fitNow, 200);
}
$('#dp-close').addEventListener('click', closeDetail);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.dataset.detail === 'open') {
    if ($('#palette').hidden) closeDetail();
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────────
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }

// Minimal markdown to HTML, over workflow step output. The source is escaped
// first and formatting is layered onto the escaped string, so every tag in the
// result is one this function wrote.
function renderMarkdown(src) {
  let s = escapeHtml(String(src ?? ''));
  const codeBlocks = [];
  // Fenced code blocks: stash, restore last so inner content is untouched.
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    codeBlocks.push(`<pre class="md-pre"><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `__HUSK_MD_CODE_BLOCK_${codeBlocks.length - 1}__`;
  });
  const lines = s.split('\n');
  const out = [];
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const line of lines) {
    if (/^__HUSK_MD_CODE_BLOCK_\d+__$/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
    let m;
    if ((m = line.match(/^### (.+)/))) { closeList(); out.push(`<h3 class="md-h3">${inlineMd(m[1])}</h3>`); continue; }
    if ((m = line.match(/^## (.+)/)))  { closeList(); out.push(`<h2 class="md-h2">${inlineMd(m[1])}</h2>`); continue; }
    if ((m = line.match(/^# (.+)/)))   { closeList(); out.push(`<h1 class="md-h1">${inlineMd(m[1])}</h1>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.+)/))) {
      if (listType !== 'ul') { closeList(); out.push('<ul class="md-ul">'); listType = 'ul'; }
      out.push(`<li>${inlineMd(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.+)/))) {
      if (listType !== 'ol') { closeList(); out.push('<ol class="md-ol">'); listType = 'ol'; }
      out.push(`<li>${inlineMd(m[1])}</li>`); continue;
    }
    if (line.trim() === '') { closeList(); continue; }
    closeList();
    out.push(`<p class="md-p">${inlineMd(line)}</p>`);
  }
  closeList();
  let html = out.join('\n');
  html = html.replace(/__HUSK_MD_CODE_BLOCK_(\d+)__/g, (_m, i) => codeBlocks[Number(i)] || '');
  return html;
}
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Drop framework persona ceremony that leaks into workflow step output. Both
// banner vocabularies are matched, since an install may emit either.
function stripPaiNoise(text) {
  return String(text || '')
    .split('\n')
    .filter((ln) => !/^[═=]{3,}.*(PAI|LifeOS)/.test(ln.trim()))
    .filter((ln) => !/Executing using PAI native mode/.test(ln))
    .join('\n')
    .trim();
}
function escapeAttr(s) { return escapeHtml(s); }

// ─── First-run onboarding + boot ──────────────────────────────────────────────────────
// First-launch onboarding: a three-step full-window flow of welcome, pick CLI
// and preferences. Step 2 detects installed CLI agents on PATH and installs
// missing ones inline; step 3 sets theme, accent and rail. Finishing persists
// those choices plus firstRunDone. Preferences reopens it with { replay: true },
// which leaves firstRunDone alone. Resolves when the flow is dismissed.
async function runOnboarding({ replay = false } = {}) {
  const overlay = $('#onboarding');
  const backBtn = $('#ob-back');
  const skipBtn = $('#ob-skip');
  const steps = $$('.ob-step', overlay);
  const dots = $$('.ob-dot', overlay);
  const list = $('#ob-agents');
  const log = $('#ob-log');
  const nameInput = $('#ob-name');
  const cliNext = $('#ob-cli-next');
  // Per-open listener scope so re-opening (replay) never stacks handlers.
  const ac = new AbortController();
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn, { signal: ac.signal });

  // Working selections seed from the current config so Skip commits sane values.
  let step = 0;
  let detection = null;
  let selectedCmd = null;
  let theme = cfg.theme || 'midnight';
  let accent = cfg.accent || 'orange';
  let rail = cfg.railExpanded !== false;

  function showStep(i) {
    step = Math.max(0, Math.min(steps.length - 1, i));
    // The ambience layer keys off this: only the welcome step is dressed.
    overlay.dataset.step = String(step);
    steps.forEach((s, idx) => { s.hidden = idx !== step; });
    dots.forEach((d, idx) => d.classList.toggle('active', idx === step));
    backBtn.hidden = step === 0;
    // Skip stays available on the lead-in steps; the final step's primary CTA
    // is itself the finish action, so Skip would be redundant there.
    skipBtn.hidden = step === steps.length - 1;
    if (step === 1 && nameInput) setTimeout(() => nameInput.focus(), 60);
  }

  function paintAgents() {
    if (!detection || !detection.agents) {
      list.innerHTML = '<div class="fr-loading">No agents probed.</div>';
      return;
    }
    const available = detection.agents.filter((a) => a.available);
    if (!selectedCmd && available.length >= 1) selectedCmd = available[0].command;
    // eslint-disable-next-line no-unsanitized/property -- Agent fields are escaped via escapeHtml/escapeAttr.
    list.innerHTML = detection.agents.map((a) => {
      const main = `
        <span class="ob-cli-main">
          <span class="ob-cli-name">${escapeHtml(a.label)}</span>
          <span class="ob-cli-cmd">${escapeHtml(a.command)}</span>
        </span>`;
      if (a.available) {
        const isSelected = selectedCmd === a.command;
        return `
          <label class="ob-cli" data-id="${escapeAttr(a.id)}">
            ${main}
            <span class="ob-cli-end">
              <span class="ob-cli-meta">Installed</span>
              <input type="radio" name="ob-agent" value="${escapeAttr(a.command)}" ${isSelected ? 'checked' : ''} />
              <span class="ob-cli-radio" aria-hidden="true"></span>
            </span>
          </label>`;
      }
      const btn = a.installable
        ? `<button type="button" class="ob-cli-btn ob-cli-install" data-id="${escapeAttr(a.id)}">Install</button>`
        : `<button type="button" class="ob-cli-btn" data-docs="${escapeAttr(a.docs || '')}">Install page</button>`;
      return `
        <div class="ob-cli ob-cli-missing" data-id="${escapeAttr(a.id)}">
          ${main}
          <span class="ob-cli-end">
            <span class="ob-cli-meta ob-cli-meta-off">Not installed</span>
            ${btn}
          </span>
        </div>`;
    }).join('');
    list.querySelectorAll('input[name="ob-agent"]').forEach((r) => {
      on(r, 'change', () => { selectedCmd = r.value; updateCliNext(); });
    });
    list.querySelectorAll('[data-docs]').forEach((b) => {
      on(b, 'click', () => { const url = b.getAttribute('data-docs'); if (url) window.open(url, '_blank'); });
    });
    list.querySelectorAll('.ob-cli-install').forEach((b) => {
      on(b, 'click', (e) => { e.preventDefault(); installAgent(b.dataset.id, b); });
    });
    updateCliNext();
  }

  async function refreshDetection() {
    list.innerHTML = '<div class="fr-loading">Scanning your system…</div>';
    try {
      detection = await window.husk.agents.detect();
    } catch (err) {
      // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
      list.innerHTML = `<div class="fr-loading">Could not scan: ${escapeHtml(String(err))}</div>`;
      return;
    }
    paintAgents();
  }

  async function installAgent(id, btn) {
    const def = detection.agents.find((a) => a.id === id);
    if (!def) return;
    btn.disabled = true;
    btn.textContent = 'Installing…';
    log.hidden = false;
    log.textContent = '';
    const onLine = ({ id: pid, line }) => { if (pid === id) log.textContent += line + '\n'; log.scrollTop = log.scrollHeight; };
    if (window.husk.agents.onInstallProgress) window.husk.agents.onInstallProgress(onLine);
    const r = await window.husk.agents.install(id);
    btn.disabled = false;
    if (r && r.ok) {
      btn.textContent = 'Installed';
      await refreshDetection();
      if (!selectedCmd) selectedCmd = def.command;
      paintAgents();
    } else {
      btn.textContent = 'Retry';
      log.textContent += `\n[install failed] ${(r && r.error) || 'unknown error'}\n`;
    }
  }

  function updateCliNext() { cliNext.disabled = !selectedCmd; }

  function syncPrefControls() {
    $$('.ob-theme-sw', overlay).forEach((b) => b.classList.toggle('active', b.dataset.mode === theme));
    $$('#ob-accent .accent-swatch', overlay).forEach((sw) => sw.classList.toggle('selected', sw.dataset.c === accent));
    const railBox = $('#ob-rail'); if (railBox) railBox.checked = rail;
  }

  async function finish() {
    const name = (nameInput.value || '').trim().slice(0, 40) || 'Husk';
    const cmd = (selectedCmd || cfg.agentCommand || 'claude').trim();
    const patch = { agentCommand: cmd, agentName: name, theme, accent, railExpanded: rail };
    if (!replay) patch.firstRunDone = true;
    cfg = await window.husk.config.set(patch);
    document.body.dataset.rail = rail ? 'expanded' : 'collapsed';
    syncRailToggleTitle();
    overlay.hidden = true;
    ac.abort();
  }

  // Skip warns first when nothing is installed and nothing was picked, so it
  // never commits an agent command this machine does not have.
  async function skipWithGuard() {
    const anyInstalled = !!(detection && Array.isArray(detection.agents) && detection.agents.some((a) => a && a.available));
    if (!selectedCmd && !anyInstalled) {
      const proceed = await openConfirmDialog({
        title: 'No agent CLI found',
        bodyHtml: 'Husk drives a terminal AI agent (claude, copilot, codex, aider, gemini, kiro-cli...), and none was detected on this system. You can skip now, but chat will not work until one is installed. You can reopen this setup anytime from Preferences.',
        confirmLabel: 'Skip anyway',
        cancelLabel: 'Back to setup',
      });
      if (!proceed) return;
    }
    finish();
  }

  // Kernel. The husk hatches, and what is inside watches the pointer, blinks, and
  // reacts to being poked. The shell tilts on its wrapper so the tilt never
  // competes with the breathing and drift running on the mark itself.
  {
    const wrap = overlay.querySelector('.ob-logo-wrap');
    const welcome = overlay.querySelector('.ob-step[data-step="welcome"]');
    const hk = overlay.querySelector('#ob-kernel');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // With motion off the pod still opens, it just does not animate getting there.
    if (hk && still) hk.classList.add('is-open');

    if (hk && !still) {
      // Hatch once the wordmark has landed. The pod shakes, then cracks open.
      let crack = 0;
      const hatch = setTimeout(() => {
        hk.classList.add('is-wiggle');
        crack = setTimeout(() => {
          hk.classList.remove('is-wiggle');
          hk.classList.add('is-open', 'is-pop');
          setTimeout(() => hk.classList.remove('is-pop'), 1000);
        }, 620);
      }, 700);
      ac.signal.addEventListener('abort', () => { clearTimeout(hatch); clearTimeout(crack); });

      // Blink at irregular intervals. A fixed cadence reads as a machine.
      let blinkTimer = 0;
      const scheduleBlink = () => {
        blinkTimer = setTimeout(() => {
          hk.classList.add('is-blink');
          setTimeout(() => hk.classList.remove('is-blink'), 130);
          // Occasionally a double blink, which is what makes it read as alive.
          if (Math.random() < 0.25) {
            setTimeout(() => {
              hk.classList.add('is-blink');
              setTimeout(() => hk.classList.remove('is-blink'), 120);
            }, 260);
          }
          scheduleBlink();
        }, 2600 + Math.random() * 4200);
      };
      scheduleBlink();
      ac.signal.addEventListener('abort', () => clearTimeout(blinkTimer));

      // Poke it: it pops, leans out, and blinks at you. Only when it is out,
      // though. Hovering a shut pod should not prise it open.
      on(hk, 'pointerenter', () => {
        if (hk.classList.contains('is-open')) hk.classList.add('is-peek');
      });
      on(hk, 'pointerleave', () => hk.classList.remove('is-peek'));

      // Click toggles: out of the husk, or back into it.
      let settle = 0;
      on(hk, 'click', () => {
        clearTimeout(settle);
        if (hk.classList.contains('is-open')) {
          hk.classList.remove('is-open', 'is-peek', 'is-pop');
          hk.classList.add('is-shut');
          // The pod rocks once the halves have met, which lands the close.
          settle = setTimeout(() => {
            hk.classList.add('is-wiggle');
            setTimeout(() => hk.classList.remove('is-wiggle'), 640);
          }, 1300);
          return;
        }
        hk.classList.remove('is-shut', 'is-pop', 'is-wiggle');
        // Reflow, or re-adding the class in the same frame does not restart it.
        void hk.offsetWidth;
        hk.classList.add('is-open', 'is-pop');
        setTimeout(() => hk.classList.remove('is-pop'), 1000);
      });
      ac.signal.addEventListener('abort', () => clearTimeout(settle));

      // It watches the Get Started button when you go for it.
      const cta = $('#ob-start');
      if (cta) {
        on(cta, 'pointerenter', () => {
          if (!hk.classList.contains('is-open')) return;
          hk.style.setProperty('--hk-x', '0px');
          hk.style.setProperty('--hk-y', '5px');
          hk.classList.add('is-peek');
        });
        on(cta, 'pointerleave', () => hk.classList.remove('is-peek'));
      }
    }

    if (wrap && welcome && !still) {
      let frame = 0;
      const MAX_DEG = 9;
      // The eye offset lands on an element inside the SVG, so it is measured in
      // viewBox units, not screen pixels.
      const EYE_PX = 4.5;
      on(welcome, 'pointermove', (e) => {
        if (frame) return; // one update per painted frame, not one per event
        frame = requestAnimationFrame(() => {
          frame = 0;
          const r = welcome.getBoundingClientRect();
          const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
          const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
          const clamp = (n) => Math.max(-1, Math.min(1, n));
          wrap.style.transform =
            `rotateY(${clamp(dx) * MAX_DEG}deg) rotateX(${clamp(-dy) * MAX_DEG}deg)`;
          if (hk) {
            // The eyes lead the head: they travel further than the shell tilts.
            const b = hk.getBoundingClientRect();
            const ex = (e.clientX - (b.left + b.width / 2)) / (b.width * 2);
            const ey = (e.clientY - (b.top + b.height / 2)) / (b.height * 2);
            hk.style.setProperty('--hk-x', `${clamp(ex) * EYE_PX}px`);
            hk.style.setProperty('--hk-y', `${clamp(ey) * EYE_PX}px`);
          }
        });
      });
      on(welcome, 'pointerleave', () => {
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        wrap.style.transition = 'transform 0.6s var(--ease-out)';
        wrap.style.transform = '';
        if (hk) {
          hk.style.setProperty('--hk-x', '0px');
          hk.style.setProperty('--hk-y', '0px');
        }
        setTimeout(() => { wrap.style.transition = ''; }, 650);
      });
    }
  }

  // Navigation.
  on($('#ob-start'), 'click', () => showStep(1));
  on(cliNext, 'click', () => showStep(2));
  on(backBtn, 'click', () => showStep(step - 1));
  on(skipBtn, 'click', skipWithGuard);
  on($('#ob-finish'), 'click', finish);

  // Step 3 controls apply live so the user sees the change behind the panel.
  $$('.ob-theme-sw', overlay).forEach((b) => on(b, 'click', () => {
    theme = b.dataset.mode; applyTheme(theme); syncPrefControls();
  }));
  $$('#ob-accent .accent-swatch', overlay).forEach((sw) => on(sw, 'click', () => {
    accent = sw.dataset.c; applyAccent(accent); syncPrefControls();
  }));
  on($('#ob-rail'), 'change', (e) => { rail = e.target.checked; });

  // Open.
  if (nameInput) nameInput.value = cfg.agentName || 'Husk';
  syncPrefControls();
  try {
    const u = await window.husk.updates.get();
    const ver = u && u.version ? ('Version ' + u.version) : '';
    const vEl = $('#ob-version'); if (vEl) vEl.textContent = ver;
  } catch (_) {}
  overlay.hidden = false;
  showStep(0);
  refreshDetection();

  await new Promise((resolve) => { ac.signal.addEventListener('abort', resolve, { once: true }); });
}

async function boot() {
  const localReloadState = takeReloadState();
  let mainReloadState = null;
  try { mainReloadState = await window.husk.ui.takeReloadState(); } catch (_) {}
  const reloadState = localReloadState || mainReloadState;
  bootingFromReloadState = reloadState || null;
  cfg = await window.husk.config.get();
  try { huskHome = await window.husk.fs.home() || '~'; } catch (_) {}
  profilesCache = await window.husk.profiles.list();
  applyTheme(cfg.theme || 'midnight');
  applyAccent(cfg.accent || 'orange');
  document.body.dataset.rail = cfg.railExpanded === false ? 'collapsed' : 'expanded';
  document.body.dataset.status = cfg.statusCollapsed ? 'collapsed' : 'expanded';
  syncRailToggleTitle();
  syncStatusToggleTitle();

  // What's new. First run shows the welcome tour and then the What's new page;
  // an existing user who just updated (version changed) sees only the What's
  // new page, never the tour again. Either way we record the version so it is
  // shown at most once per version.
  let curVer = '';
  try { curVer = ((await window.husk.updates.get()) || {}).current || ''; } catch (_) {}
  if (!reloadState && !cfg.firstRunDone) {
    await runOnboarding();
    // Non-blocking: float the What's new page on top while the app renders.
    if (curVer) showWhatsNew(curVer);
  } else if (!reloadState && curVer && cfg.lastSeenVersion !== curVer) {
    showWhatsNew(curVer);
  }
  if (!reloadState && curVer && cfg.lastSeenVersion !== curVer) {
    try { cfg = await window.husk.config.set({ lastSeenVersion: curVer }); } catch (_) {}
  }

  bindPrefs();
  // Set rail label early based on configured agent so it reads "Prompts" for
  // non-claude users even before the page is opened.
  agentKindCache = (cfg.agentCommand || 'claude').trim().split(/\s+/)[0].toLowerCase() === 'claude'
    ? 'claude' : 'generic';
  document.body.dataset.agentKind = agentKindCache;
  applyPromptsLabels();
  updateAgentPill();
  refreshAgentMenu();
  // The agents pill answers before the stats do: it only needs the fleet
  // list, and parking it behind the stats probe leaves the corner blank for
  // however long that spawn takes.
  refreshTopbarAgents();
  await refreshStats();
  setStatusPane(cfg.statusPane === 'status' ? 'status' : 'work');
  refreshStatusline();
  refreshVoiceStatus();
  refreshContextList();
  refreshRecentList();
  refreshProjectsState();
  if (reloadState && reloadState.page) {
    setPage(reloadState.page, { _nav: true });
  } else {
    saveRouteState();
  }
  // Pause polling when the window is hidden so we don't burn frames or
  // recompute the status panel for an invisible UI.
  setInterval(async () => {
    if (document.hidden) return;
    await refreshStats();
    refreshStatusline();
  }, 8000);
  setInterval(() => {
    if (document.hidden) return;
    refreshRecentList();
  }, 30000);
  setInterval(() => {
    if (document.hidden) return;
    refreshTopbarAgents();
  }, 20000);

  // With skipWelcome on, boot goes straight to a chat, so the welcome screen
  // stays out of the paint entirely.
  const autoChat = cfg.skipWelcome && !(reloadState && reloadState.suppressAutoChat);
  if (!autoChat) $('#chat-empty').classList.add('show');

  // A renderer reload keeps the main-process PTYs alive, so reattach to any
  // open chats first and fall through to cold boot only when there are none.
  const reattached = await reattachSessions();
  if (!reattached && autoChat) {
    await startPty();
  }
  bootingFromReloadState = null;
}

async function launchAgent({ initialPrompt = null } = {}) {
  const skipBox = $('#ce-skip-next');
  if (skipBox && skipBox.checked && !cfg.skipWelcome) {
    cfg = await window.husk.config.set({ skipWelcome: true });
  }
  $('#chat-empty').classList.remove('show');
  try {
    await startPty();
  } catch (err) {
    // Spawn failure must not strand the user on an empty black terminal:
    // restore the welcome screen and say what happened.
    $('#chat-empty').classList.add('show');
    toastAction(
      `Could not start the agent: ${(err && err.message) || err}`,
      'Open setup',
      () => runOnboarding({ replay: true })
    );
    return;
  }
  if (initialPrompt) {
    setTimeout(() => {
      armRecap();
      window.husk.pty.write(initialPrompt);
      if (term) term.focus();
    }, 250);
  }
}

// ─── Autopilot Mode ────────────────────────────────────────────────────────────
//
// The chat header's Autopilot button opens a start dialog. The renderer
// collects goal and caps, asks the supervisor over IPC to start a run, then
// shows a live banner with a Cancel button. On autopilot:ended it opens a
// review modal with the diff and a one-click Revert.
let autopilotActive = false;
let autopilotLastSession = null;
// True while a run is being started, which is when the wizard stops responding
// to a backdrop click or Esc.
let autopilotStarting = false;
// All currently active runs. One run is the plain single-run UX.
const activeRuns = new Map(); // runId → { runId, sessionId, workspaceRoot, goal, startedAt, caps, budget }
let focusedRunId = null;      // which run the detail pane displays
const autopilotModelDecisions = new Map(); // runId/role → { model, tier, reason }
// '_solo' is a renderer-side placeholder key for a start that carries no
// runId; never send it to main, which expects a real pool key or nothing.
function focusedRealRunId() {
  return focusedRunId && focusedRunId !== '_solo' ? focusedRunId : undefined;
}
function openAutopilotStart() {
  const hasProject = !!(activeProjectId && projectsCache.some((p) => p && p.id === activeProjectId));
  const noProj = $('#aut-no-project');
  const body = $('#aut-start-body');
  const foot = $('#aut-start-foot');
  if (noProj) noProj.hidden = hasProject;
  if (body) body.hidden = !hasProject;
  if (foot) foot.hidden = !hasProject;
  $('#aut-goal').classList.remove('field-invalid');
  $('#autopilot-start-modal').hidden = false;
  if (hasProject) setTimeout(() => { try { $('#aut-goal').focus(); } catch (_) {} }, 0);
}
function closeAutopilotStart() {
  // Never tear down the wizard while a run is mid-launch.
  if (autopilotStarting) return;
  $('#autopilot-start-modal').hidden = true;
}
// Read one cap field. Empty falls back to the default, a typed 0 stays 0 and
// the budget meter reads it as no cap, and anything negative or non-numeric
// returns the default with an invalid flag.
function readCapField(id, def) {
  const el = $(id);
  const raw = el ? String(el.value || '').trim() : '';
  if (raw === '') return { value: def };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { value: def, invalid: true };
  return { value: n };
}
async function startAutopilot() {
  const goalEl = $('#aut-goal');
  const goal = (goalEl && goalEl.value || '').trim();
  // A run with no goal just burns tokens; require one before launching.
  if (!goal) {
    toast('Goal is required', 'error');
    if (goalEl) { goalEl.classList.add('field-invalid'); goalEl.focus(); }
    return;
  }
  const cMin = readCapField('#aut-cap-min', 60);
  const cTok = readCapField('#aut-cap-tok', 200000);
  const cUsd = readCapField('#aut-cap-usd', 5);
  if (cMin.invalid || cTok.invalid || cUsd.invalid) {
    toast('Caps must be zero or a positive number; invalid values were reset to the default', 'error');
  }
  const caps = { minutes: cMin.value, tokens: cTok.value, dollars: cUsd.value };
  // Snapshot is opt-in via the wizard toggle. Users who manage state with
  // git can skip it; revert/diff are then unavailable for the run.
  const snapEl = $('#aut-snapshot-toggle');
  const snapshot = snapEl ? !!snapEl.checked : true;
  // Cost guard: caps are per agent, so a team multiplies them. Confirm before
  // launching without a dollar limit, and state the fleet ceiling for a
  // capped team.
  const isTeam = autopilotStartMode === 'collab';
  if (caps.dollars <= 0) {
    const ok = await openConfirmDialog({
      title: 'Launch with no spend limit?',
      bodyHtml: (isTeam
        ? 'This team has <b>no dollar cap</b>, and a stuck team can burn tokens fast. '
        : 'This run has <b>no dollar cap</b>. ')
        + 'It runs until it finishes or hits the time/token cap. Set a dollar cap, or continue uncapped.',
      confirmLabel: 'Run uncapped',
      cancelLabel: 'Set a limit',
    });
    if (!ok) return;
  } else if (isTeam) {
    const fleetMax = caps.dollars * 4;
    const ok = await openConfirmDialog({
      title: `Start the team? Up to $${fleetMax.toFixed(2)} total`,
      bodyHtml: `The $${caps.dollars.toFixed(2)} cap is <b>per agent</b>. The orchestrator may spawn up to 4 agents, so the team can spend up to <b>$${fleetMax.toFixed(2)}</b> before caps stop it.`,
      confirmLabel: 'Start team',
      cancelLabel: 'Adjust caps',
    });
    if (!ok) return;
  }
  const goBtn = $('#aut-start-go');
  const cancelBtn = $('#aut-start-cancel');
  const status = $('#aut-snapshot-status');
  const goLabelBefore = goBtn ? goBtn.textContent : 'Start run';
  autopilotStarting = true;
  if (goBtn) { goBtn.disabled = true; goBtn.textContent = snapshot ? 'Capturing snapshot...' : 'Starting run...'; }
  if (cancelBtn) cancelBtn.disabled = true;
  if (status) { status.hidden = false; status.textContent = snapshot ? 'Capturing workspace snapshot...' : 'Starting run...'; }
  // Mode: solo (one run) or collab (orchestrator decomposes the goal and
  // decides the team size; the user never picks a count).
  const mode = autopilotStartMode;
  if (mode === 'collab') {
    // Planning can take tens of seconds, so progress is shown on the live page.
    autopilotStarting = false;
    if (goBtn) { goBtn.disabled = false; goBtn.textContent = goLabelBefore; }
    if (cancelBtn) cancelBtn.disabled = false;
    if (status) { status.hidden = true; status.textContent = ''; }
    closeAutopilotStart();
    try { setPage('autopilot'); } catch (_) {}
    autopilotActive = true;
    autopilotState.startedAt = Date.now();
    resetAutopilotRunScope();
    autopilotFleetId = `planning-${Date.now()}`;
    resetAutopilotPanel();
    setAutopilotGoal(goal);
    setAutopilotCaps(caps);
    paintAutopilotBanner();
    pushActivity(['Planning the team (this can take a minute or two)...'], '_orch');
    try {
      const r = await window.husk.autopilot.startCollab({ goal, caps, snapshot });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not start the team');
      toast(`Team of ${r.agents.length} started`, 'success');
    } catch (err) {
      // Every failure must be VISIBLE: feed line + toast, then re-derive the
      // page state so it never sits in a runless "running" limbo.
      const msg = (err && err.message) || String(err);
      pushActivity([`Team start failed: ${msg}`], '_orch');
      toast(`Team start failed: ${msg}`, 'error');
      autopilotActive = liveRunCount() > 0 || plannedAgents.length > 0;
      paintAutopilotBanner();
    }
    return;
  }
  try {
    const r = await window.husk.autopilot.start({ goal, caps, snapshot });
    if (!r || !r.ok) {
      toast((r && r.error) || 'Could not start autopilot', 'error');
      if (status) { status.hidden = true; status.textContent = ''; }
      return;
    }
    if (!r.queued) {
      const runId = r.runId || null;
      const runKey = runId || '_solo';
      // The autopilot:started event usually lands before this resolves and
      // creates the full entry (color, files, telemetry); do not clobber it.
      if (!activeRuns.has(runKey)) {
        resetAutopilotRunScope();
        autopilotFleetId = runId || runKey;
        activeRuns.set(runKey, {
          runId, sessionId: r.sessionId, workspaceRoot: r.workspaceRoot, goal, originalGoal: goal,
          startedAt: Date.now(), caps, budget: null, feed: [],
          colorIdx: activeRuns.size % AP_LANE_COLORS, files: [],
          state: 'starting', nudges: 0, lastTool: null, lastToolAt: 0, quietMs: 0,
          ended: false, endedOk: false,
        });
      }
      const entry = activeRuns.get(runKey);
      entry.caps = caps;
      focusedRunId = runKey;
      autopilotActive = true;
      autopilotLastSession = { sessionId: r.sessionId, workspaceRoot: r.workspaceRoot };
      autopilotState.startedAt = Date.now();
      resetAutopilotPanel();
      setAutopilotGoal(goal);
      setAutopilotCaps(caps);
    }
    // Release the close guard before dismissing the wizard.
    autopilotStarting = false;
    closeAutopilotStart();
    try { setPage('autopilot'); } catch (_) {}
    paintAutopilotBanner();
    if (r.queued) {
      toast('Autopilot queued; it starts when a slot frees up', 'info');
    } else {
      const fc = Number(r.fileCount) || 0;
      toast(snapshot ? `Autopilot running, snapshot of ${fc} files captured` : 'Autopilot running (no snapshot)', 'success');
    }
  } finally {
    autopilotStarting = false;
    if (goBtn) { goBtn.disabled = false; goBtn.textContent = goLabelBefore; }
    if (cancelBtn) cancelBtn.disabled = false;
    if (status) { status.hidden = true; status.textContent = ''; }
  }
}
async function cancelAutopilot() {
  if (!autopilotActive) return;
  // The explicit Stop action, confirmed first since it ends in-flight work.
  // A collab run stops the whole team, which the dialog says; chat sessions
  // are left alone.
  const focused = activeRuns.get(focusedRunId);
  const gid = focused && focused.groupId;
  const teamSize = gid ? [...activeRuns.values()].filter((r) => r.groupId === gid && !r.ended).length : 1;
  const ok = await openConfirmDialog({
    title: teamSize > 1 ? `Stop the autopilot team (${teamSize} agents)?` : 'Stop the autopilot run?',
    bodyHtml: (teamSize > 1
      ? `All ${teamSize} agents spawned by this autopilot run will be interrupted and the run will end. `
      : 'The agent will be interrupted and the run will end. ')
      + 'Your workspace changes are kept; you can review or revert them afterward. Regular chat sessions are not affected.',
    confirmLabel: teamSize > 1 ? 'Stop all agents' : 'Stop run',
    cancelLabel: 'Keep running',
  });
  if (!ok) return;
  const r = await window.husk.autopilot.cancel({ runId: focusedRealRunId() });
  if (!r || !r.ok) { toast((r && r.error) || 'Cancel failed', 'error'); return; }
}
// Curated preset goals. Each preset prefills the start-run modal so
// users have a clear first action instead of staring at a blank
// textarea. Caps are sensible defaults; user can edit before running.
const AUTOPILOT_PRESETS = [
  {
    id: 'security-audit',
    title: 'Security audit pass',
    body: 'Walk the codebase for obvious security issues: auth bypass, missing input validation, secrets in source, unsafe deserialization. Report findings inline.',
    caps: { minutes: 60, tokens: 250000, dollars: 6 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v6c0 5-3.5 9.5-8 10-4.5-.5-8-5-8-10V6l8-4z"/><path d="M9 12l2 2 4-4"/></svg>',
  },
  {
    id: 'cleanup-todos',
    title: 'Cleanup TODOs',
    body: 'Find every TODO and FIXME comment in source. Group by area, propose a fix for each, do not push.',
    caps: { minutes: 30, tokens: 120000, dollars: 3 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  },
  {
    id: 'docs-pass',
    title: 'Documentation pass',
    body: 'Generate or improve docstrings, comments, and README sections for public APIs. Match the existing tone.',
    caps: { minutes: 45, tokens: 180000, dollars: 4 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  },
  {
    id: 'add-tests',
    title: 'Add missing tests',
    body: 'Identify functions and modules with no test coverage. Write unit tests using the existing test framework. Do not modify production code.',
    caps: { minutes: 60, tokens: 220000, dollars: 5 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/><path d="M9 13l2 2 4-4"/></svg>',
  },
  {
    id: 'refactor-types',
    title: 'Tighten types',
    body: 'Find loosely typed code (any, unknown, missing return types) and add precise types. Run the type checker after each change.',
    caps: { minutes: 45, tokens: 200000, dollars: 4 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2"/><path d="M9 21h6"/><path d="M12 3v18"/></svg>',
  },
  {
    id: 'dep-bump',
    title: 'Bump dependencies',
    body: 'Review outdated dependencies. Bump patch and minor versions where safe. Run the test suite after each batch. Do not bump major versions without explicit confirmation.',
    caps: { minutes: 30, tokens: 100000, dollars: 2 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  },
  {
    id: 'fix-failing-tests',
    title: 'Fix failing tests',
    body: 'Run the test suite. Diagnose each failure and fix the code or the test, whichever is wrong. Re-run after each fix until green. Do not delete or skip tests.',
    caps: { minutes: 60, tokens: 250000, dollars: 6 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4.5 4.5 0 0 0-6.4 6.4L3 18v3h3l5.3-5.3a4.5 4.5 0 0 0 6.4-6.4z"/><path d="M15 9l6-6"/></svg>',
  },
  {
    id: 'remove-dead-code',
    title: 'Remove dead code',
    body: 'Find unused functions, exports, files, and dependencies. Confirm each is unreferenced before deleting. Run the test suite after removal.',
    caps: { minutes: 45, tokens: 180000, dollars: 4 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
  },
  {
    id: 'harden-errors',
    title: 'Harden error handling',
    body: 'Find swallowed errors, empty catch blocks, and unchecked async results. Add proper handling with clear messages. Do not change behavior on the happy path.',
    caps: { minutes: 45, tokens: 200000, dollars: 4 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  },
  {
    id: 'accessibility-pass',
    title: 'Accessibility pass',
    body: 'Review UI markup for accessibility: missing labels, keyboard navigation, focus states, contrast. Fix low-risk issues directly, report the rest inline.',
    caps: { minutes: 45, tokens: 180000, dollars: 4 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none"/><path d="M7 10.5l4 1v3l-1.5 4M17 10.5l-4 1v3l1.5 4"/></svg>',
  },
  {
    id: 'release-notes',
    title: 'Draft release notes',
    body: 'Read the commits since the last tag. Draft release notes grouped by features, fixes, and breaking changes. Write to a file, do not tag or push.',
    caps: { minutes: 20, tokens: 80000, dollars: 2 },
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4L11 3H4v7l9.6 10.4a2 2 0 0 0 2.8 0l4.2-4.2a2 2 0 0 0 0-2.8z"/><circle cx="8" cy="7" r="1.5"/></svg>',
  },
];

function renderAutopilotPage() {
  // The dollar figure means different things on an API key vs a plan; learn
  // which so the label is honest before any numbers paint.
  refreshAutBilling();
  // Static parts: presets gallery. Re-rendered every visit so it
  // refreshes with workspace switches without bookkeeping.
  const grid = $('#aut-preset-grid');
  if (grid) {
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    for (const p of AUTOPILOT_PRESETS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'aut-preset';
      card.dataset.preset = p.id;
      const head = document.createElement('div');
      head.className = 'aut-preset-head';
      const icon = document.createElement('div');
      icon.className = 'aut-preset-icon';
      // eslint-disable-next-line no-unsanitized/property -- inline SVG from a static constant, no user input
      icon.innerHTML = p.icon;
      const title = document.createElement('div');
      title.className = 'aut-preset-title';
      title.textContent = p.title;
      head.appendChild(icon);
      head.appendChild(title);
      const body = document.createElement('div');
      body.className = 'aut-preset-body';
      body.textContent = p.body;
      const caps = document.createElement('div');
      caps.className = 'aut-preset-caps';
      const capLine = (label, val) => {
        const s = document.createElement('span');
        s.textContent = `${label} ${val}`;
        return s;
      };
      caps.appendChild(capLine('time', `${p.caps.minutes}m`));
      caps.appendChild(capLine('tokens', formatTokens(p.caps.tokens)));
      caps.appendChild(capLine('spend', `$${p.caps.dollars}`));
      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(caps);
      card.addEventListener('click', () => loadPresetIntoStartModal(p));
      grid.appendChild(card);
    }
  }
  // Dynamic: recent runs + hero stats fetched from backend.
  refreshAutopilotHistory();
  // Restore the live/running (or review) view on every visit so a run
  // started earlier is never hidden behind the empty/presets state.
  paintAutopilotBanner();
}

function loadPresetIntoStartModal(p) {
  openAutopilotStart();
  setTimeout(() => {
    const ga = $('#aut-goal');
    const m = $('#aut-cap-min');
    const t = $('#aut-cap-tok');
    const d = $('#aut-cap-usd');
    if (ga) ga.value = p.body;
    if (m) m.value = p.caps.minutes;
    if (t) t.value = p.caps.tokens;
    if (d) d.value = p.caps.dollars;
    try { ga && ga.focus(); } catch (_) {}
  }, 30);
}

// Open the Start-run modal prefilled with a past run's goal and caps, for the
// Rerun buttons on Recent Runs rows and in the review footer. A row without
// caps falls back to the defaults.
function rerunFromPastRun(run) {
  if (!run || !run.goal) { toast('That run has no goal text to rerun', 'error'); return; }
  if (autopilotActive) { toast('A run is already active', 'info'); return; }
  // Exit any review session so the modal opens cleanly.
  if (autopilotReview) {
    autopilotReview = false;
    autopilotReviewData = null;
    paintAutopilotBanner();
  }
  const caps = run.caps && typeof run.caps === 'object' ? run.caps : { minutes: 60, tokens: 200000, dollars: 5 };
  loadPresetIntoStartModal({
    id: 'rerun',
    title: 'Rerun',
    body: run.goal,
    caps: {
      minutes: Number(caps.minutes) || 60,
      tokens: Number(caps.tokens) || 200000,
      dollars: Number(caps.dollars) || 5,
    },
  });
}

async function deleteRun(run) {
  if (!run || !run.sessionId) return;
  const sessionIds = Array.isArray(run.sessionIds) && run.sessionIds.length ? run.sessionIds : [run.sessionId];
  const label = sessionIds.length > 1 ? 'fleet run' : 'run';
  const ok = await openConfirmDialog({
    title: `Delete this ${label}?`,
    bodyHtml: "This permanently removes the snapshot, audit log, and saved file versions. You will no longer be able to review or revert it.",
    confirmLabel: `Delete ${label}`,
    cancelLabel: 'Keep',
  });
  if (!ok) return;
  let deleted = 0;
  let firstError = '';
  for (const sessionId of sessionIds) {
    const r = await window.husk.autopilot.deleteRun({ sessionId });
    if (r && r.ok) deleted += 1;
    else if (!firstError) firstError = (r && r.error) || 'Could not delete run';
  }
  if (firstError) { toast(`Deleted ${deleted}; ${firstError}`, 'error'); return; }
  toast(sessionIds.length > 1 ? 'Fleet run deleted' : 'Run deleted', 'success');
  // If the deleted run is the one currently under review, leave review
  // mode; otherwise just refresh the list in place.
  if (autopilotReview && autopilotReviewData && sessionIds.includes(autopilotReviewData.sessionId)) {
    exitReviewMode();
  } else {
    refreshAutopilotHistory();
  }
}
// Render the head-to-head race scorecards: one card per race, one column per
// agent run, the judge-suggested winner marked, with per-run diff + Apply /
// Discard. Reuses the autopilot:race IPC (grouped + ranked) and applyWinner.
function fxFmtMs(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
async function renderRaces() {
  const section = $('#aut-races-section');
  const wrap = $('#aut-races');
  if (!section || !wrap) return;
  let res;
  try { res = await window.husk.autopilot.race(); }
  catch (_) { res = { ok: false }; }
  const races = (res && res.ok && Array.isArray(res.races)) ? res.races.filter((r) => r.count > 1) : [];
  if (!races.length) { section.hidden = true; while (wrap.firstChild) wrap.removeChild(wrap.firstChild); return; }
  section.hidden = false;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  for (const race of races) wrap.appendChild(buildRaceCard(race));
}
function buildRaceCard(race) {
  const card = document.createElement('div');
  card.className = 'aut-race';
  const head = document.createElement('div');
  head.className = 'aut-race-head';
  const goal = document.createElement('div');
  goal.className = 'aut-race-goal';
  goal.textContent = race.goal || '(no goal recorded)';
  goal.title = race.goal || '';
  const right = document.createElement('div');
  right.className = 'aut-race-head-right';
  const tag = document.createElement('div');
  tag.className = 'aut-race-tag';
  tag.textContent = `${race.count} agents`;
  const cardBtn = document.createElement('button');
  cardBtn.className = 'aut-race-cardbtn';
  cardBtn.textContent = 'Race Card';
  cardBtn.title = 'Create a shareable image of this race';
  cardBtn.addEventListener('click', () => openRaceCard(race));
  right.appendChild(tag);
  right.appendChild(cardBtn);
  head.appendChild(goal);
  head.appendChild(right);
  card.appendChild(head);

  const cols = document.createElement('div');
  cols.className = 'aut-race-cols';
  cols.style.gridTemplateColumns = `repeat(${race.runs.length}, minmax(0, 1fr))`;
  for (const run of race.runs) cols.appendChild(buildRaceColumn(run));
  card.appendChild(cols);
  return card;
}
function buildRaceColumn(run) {
  const m = run.metrics || {};
  const col = document.createElement('div');
  col.className = 'aut-race-col' + (run.suggested ? ' is-winner' : '') + (!run.fileCount ? ' is-empty' : '');
  // Header: agent + winner ribbon.
  const top = document.createElement('div');
  top.className = 'aut-race-col-top';
  const agent = document.createElement('span');
  agent.className = 'aut-race-agent';
  agent.textContent = run.agent || 'agent';
  top.appendChild(agent);
  if (run.suggested) {
    const rib = document.createElement('span');
    rib.className = 'aut-race-winner';
    rib.textContent = 'WINNER';
    rib.title = run.reason || '';
    top.appendChild(rib);
  }
  col.appendChild(top);
  // Metric rows.
  const metrics = [
    { k: 'files', v: `${run.fileCount}`, best: run.isSmallest },
    { k: 'cost', v: formatDollars(Number(m.dollars) || 0), best: run.isCheapest },
    { k: 'time', v: fxFmtMs(m.durationMs), best: run.isFastest },
    { k: 'tokens', v: formatTokens(Number(m.tokens) || 0), best: false },
  ];
  const grid = document.createElement('div');
  grid.className = 'aut-race-metrics';
  for (const met of metrics) {
    const row = document.createElement('div');
    row.className = 'aut-race-metric' + (met.best ? ' is-best' : '');
    const lbl = document.createElement('span'); lbl.className = 'aut-race-metric-k'; lbl.textContent = met.k;
    const val = document.createElement('span'); val.className = 'aut-race-metric-v'; val.textContent = met.v;
    row.appendChild(lbl); row.appendChild(val);
    grid.appendChild(row);
  }
  col.appendChild(grid);
  // Reason.
  const reason = document.createElement('div');
  reason.className = 'aut-race-reason';
  reason.textContent = run.reason || '';
  col.appendChild(reason);
  // Actions.
  const actions = document.createElement('div');
  actions.className = 'aut-race-actions';
  const diffBtn = document.createElement('button');
  diffBtn.className = 'aut-race-btn';
  diffBtn.textContent = `Diff (${run.fileCount})`;
  diffBtn.disabled = !run.fileCount;
  diffBtn.addEventListener('click', () => openRaceRunDiff(run));
  const applyBtn = document.createElement('button');
  applyBtn.className = 'aut-race-btn is-apply';
  applyBtn.textContent = 'Apply';
  applyBtn.disabled = !run.fileCount;
  applyBtn.title = 'Apply this run and discard the others in this race';
  applyBtn.addEventListener('click', () => applyRaceWinner(run));
  const discardBtn = document.createElement('button');
  discardBtn.className = 'aut-race-btn';
  discardBtn.textContent = 'Discard';
  discardBtn.addEventListener('click', () => discardRaceRun(run));
  actions.appendChild(diffBtn);
  actions.appendChild(applyBtn);
  actions.appendChild(discardBtn);
  col.appendChild(actions);
  return col;
}
// Show one changed file of a race run in the existing file-diff modal, using
// that run's own session + worktree so the diff is against its pre-run snapshot.
function openRaceRunDiff(run) {
  const changes = run.changes || [];
  if (!changes.length) return;
  // Point the diff modal at this run's session/worktree, then open its first
  // changed file (a full multi-file diff view is a later refinement).
  autopilotReview = false;
  autopilotLastSession = { sessionId: run.sessionId, workspaceRoot: run.worktreePath };
  openFileDiffModal(changes[0].path, changes[0].status);
}
async function applyRaceWinner(run) {
  const ok = await openConfirmDialog({
    title: `Apply ${run.agent}'s changes and discard the rest?`,
    bodyHtml: `Husk will apply ${run.fileCount} changed file${run.fileCount === 1 ? '' : 's'} from ${escapeHtml(run.agent || 'this run')} into your project, then discard the other runs in this race.`,
    confirmLabel: 'Apply winner', cancelLabel: 'Cancel',
  });
  if (!ok) return;
  const r = await window.husk.autopilot.applyWinner({ runId: run.runId });
  if (!r) { toast('Apply failed', 'error'); return; }
  const applied = (r.applied || []).length;
  const failed = (r.failed || []).length;
  if (failed) toast(`Applied ${applied} file${applied === 1 ? '' : 's'}; ${failed} failed`, 'error');
  else toast(`Applied ${run.agent}'s changes; discarded ${r.discarded} other run${r.discarded === 1 ? '' : 's'}`, 'success');
  renderRaces();
  refreshAutopilotHistory();
}
async function discardRaceRun(run) {
  const r = await window.husk.autopilot.discardRun({ runId: run.runId });
  if (!r || !r.ok) { toast((r && r.error) || 'Discard failed', 'error'); return; }
  toast('Run discarded', 'success');
  renderRaces();
}

// ── Race Card: a self-contained shareable PNG drawn on a canvas ──
// The card is drawn with the Canvas 2D API on a fixed dark palette, so it looks
// the same wherever it is shared. It shows the agents, their headline metrics
// and the winner, and carries no repo path or file names.
const RC_PALETTE = {
  bg0: '#0b0d13', bg1: '#12151f', card: '#171b26', cardWin: '#12241a',
  line: 'rgba(255,255,255,0.10)', lineWin: '#34d399',
  text: '#f4f4f6', text2: 'rgba(244,244,246,0.62)', text3: 'rgba(244,244,246,0.4)',
  accent: '#ff7847', win: '#34d399', amber: '#f6b73c',
};
function rcRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function rcFmtMs(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
function drawRaceCard(canvas, race) {
  const W = 1200, H = 630;
  const ctx = canvas.getContext('2d');
  const p = RC_PALETTE;
  // Background.
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, p.bg0); g.addColorStop(1, p.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // Accent glow top-left.
  const glow = ctx.createRadialGradient(120, 60, 0, 120, 60, 520);
  glow.addColorStop(0, 'rgba(255,120,71,0.14)'); glow.addColorStop(1, 'rgba(255,120,71,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // Header.
  ctx.fillStyle = p.accent;
  ctx.font = '800 34px "Space Grotesk", "Inter", sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('⬢ HUSK', 64, 84);
  ctx.fillStyle = p.text3;
  ctx.font = '700 20px "JetBrains Mono", monospace';
  const tag = 'AGENT RACE';
  ctx.fillText(tag, W - 64 - ctx.measureText(tag).width, 82);
  // Goal (up to 2 lines).
  ctx.fillStyle = p.text;
  ctx.font = '600 40px "Space Grotesk", "Inter", sans-serif';
  const goal = (race.goal || 'One task, N agents.').trim();
  const words = goal.split(/\s+/);
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > W - 128 && cur) { lines.push(cur); cur = w; if (lines.length === 2) break; }
    else cur = t;
  }
  if (lines.length < 2 && cur) lines.push(cur);
  if (lines.length === 2 && ctx.measureText(lines[1]).width > W - 128) {
    while (lines[1].length > 3 && ctx.measureText(lines[1] + '...').width > W - 128) lines[1] = lines[1].slice(0, -1);
    lines[1] += '...';
  }
  lines.forEach((ln, i) => ctx.fillText(ln, 64, 168 + i * 52));
  // Agent columns (up to 4).
  const runs = race.runs.slice(0, 4);
  const n = runs.length;
  const pad = 64, gap = 20;
  const colW = (W - pad * 2 - gap * (n - 1)) / n;
  const colY = 300, colH = 230;
  runs.forEach((run, i) => {
    const x = pad + i * (colW + gap);
    const isWin = !!run.suggested;
    ctx.fillStyle = isWin ? p.cardWin : p.card;
    rcRoundRect(ctx, x, colY, colW, colH, 16); ctx.fill();
    ctx.lineWidth = isWin ? 2 : 1;
    ctx.strokeStyle = isWin ? p.lineWin : p.line;
    rcRoundRect(ctx, x, colY, colW, colH, 16); ctx.stroke();
    // Agent name.
    ctx.fillStyle = p.text;
    ctx.font = '800 26px "JetBrains Mono", monospace';
    const name = (run.agent || 'agent').replace(/^\w/, (c) => c.toUpperCase());
    ctx.fillText(name, x + 22, colY + 46);
    if (isWin) {
      ctx.fillStyle = p.win;
      rcRoundRect(ctx, x + colW - 22 - 92, colY + 22, 92, 30, 15); ctx.fill();
      ctx.fillStyle = '#04160c';
      ctx.font = '800 15px "JetBrains Mono", monospace';
      ctx.fillText('WINNER', x + colW - 22 - 78, colY + 43);
    }
    // Metrics.
    const m = run.metrics || {};
    const rows = [
      ['files', String(run.fileCount), run.isSmallest],
      ['cost', '$' + (Number(m.dollars) || 0).toFixed(2), run.isCheapest],
      ['time', rcFmtMs(m.durationMs), run.isFastest],
    ];
    rows.forEach((r, j) => {
      const ry = colY + 92 + j * 42;
      ctx.fillStyle = p.text3;
      ctx.font = '500 18px "Inter", sans-serif';
      ctx.fillText(r[0], x + 22, ry);
      ctx.fillStyle = r[2] ? p.win : p.text;
      ctx.font = '700 20px "JetBrains Mono", monospace';
      const vw = ctx.measureText(r[1]).width;
      ctx.fillText(r[1], x + colW - 22 - vw, ry);
    });
  });
  // Footer.
  ctx.fillStyle = p.text3;
  ctx.font = '500 20px "Inter", sans-serif';
  ctx.fillText('Raced in Husk · the neutral arena for coding agents', 64, H - 40);
  ctx.fillStyle = p.text3;
  const url = 'github.com/DorShaer/Husk';
  ctx.font = '500 18px "JetBrains Mono", monospace';
  ctx.fillText(url, W - 64 - ctx.measureText(url).width, H - 41);
}
let rcCurrentBlob = null;
function openRaceCard(race) {
  const modal = $('#race-card-modal');
  const canvas = $('#rc-canvas');
  if (!modal || !canvas) return;
  drawRaceCard(canvas, race);
  canvas.toBlob((blob) => { rcCurrentBlob = blob; }, 'image/png');
  modal.hidden = false;
}
function closeRaceCard() { const m = $('#race-card-modal'); if (m) m.hidden = true; }
async function rcCopy() {
  const canvas = $('#rc-canvas');
  if (!canvas) return;
  try {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Race Card copied to clipboard', 'success');
  } catch (err) {
    toast('Copy not available; use Save PNG', 'error');
  }
}
function rcSave() {
  const canvas = $('#rc-canvas');
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) { toast('Could not render card', 'error'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'husk-race-card.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Saved husk-race-card.png', 'success');
  }, 'image/png');
}
// Line-art glyph for the run rows and the audit table.
function autIcon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    svg.appendChild(el);
  }
  return svg;
}
const AUT_ICON_FILE = ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'];
const AUT_ICON_CHECK = ['M20 6 9 17l-5-5'];
const AUT_ICON_ALERT = ['M12 8v5', 'M12 17h.01', 'M12 3 2 20h20z'];
const AUT_ICON_STOP = ['M6 6h12v12H6z'];
const AUT_ICON_HELP = ['M12 17h.01', 'M9.5 9a2.5 2.5 0 1 1 3.2 2.4c-.7.3-1.2 1-1.2 1.8v.3'];

// How a finished run reads: the state the pill takes, the word beside it, and
// the glyph that carries the same meaning without colour.
function autRunOutcome(run) {
  const key = String((run && (run.haltReason || run.status)) || 'ended');
  if (key === 'natural' || key === 'ended') return { state: 'success', label: 'completed', icon: AUT_ICON_CHECK };
  if (key === 'user' || key === 'cancelled') return { state: 'muted', label: 'stopped', icon: AUT_ICON_STOP };
  if (key === 'unknown') return { state: 'muted', label: 'unknown', icon: AUT_ICON_HELP };
  if (key === 'budget') return { state: 'warning', label: 'capped', icon: AUT_ICON_ALERT };
  return { state: 'warning', label: key, icon: AUT_ICON_ALERT };
}

// Relative stamp for run rows and audit rows: seconds through years, with a
// forward form for anything stamped ahead of now.
function fmtRelWhen(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const t = (typeof value === 'number' || /^\d{10,}$/.test(raw)) ? Number(value) : Date.parse(raw);
  if (!isFinite(t)) return '';
  const delta = Date.now() - t;
  const ahead = delta < 0;
  const secs = Math.floor(Math.abs(delta) / 1000);
  const say = (n, unit) => (ahead ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (secs < 10) return ahead ? 'in a moment' : 'just now';
  if (secs < 60) return say(secs, 's');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return say(mins, 'm');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return say(hours, 'h');
  const days = Math.floor(hours / 24);
  if (days < 7) return say(days, 'd');
  if (days < 35) return say(Math.floor(days / 7), 'w');
  if (days < 365) return say(Math.floor(days / 30), 'mo');
  return say(Math.floor(days / 365), 'y');
}
// The exact stamp behind a relative one, for the hover title.
function fmtAbsWhen(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const t = (typeof value === 'number' || /^\d{10,}$/.test(raw)) ? Number(value) : Date.parse(raw);
  if (!isFinite(t)) return '';
  return new Date(t).toLocaleString();
}

// Proportional bar over the mix a run left behind: files added, modified and
// removed, each segment weighted by its own count.
function buildChangeBar(mix) {
  const parts = [
    ['added', Number(mix && mix.added) || 0],
    ['modified', Number(mix && mix.modified) || 0],
    ['deleted', Number(mix && mix.deleted) || 0],
  ].filter(([, n]) => n > 0);
  if (!parts.length) return null;
  const bar = document.createElement('span');
  bar.className = 'aut-changebar';
  for (const [kind, n] of parts) {
    const seg = document.createElement('span');
    seg.className = 'aut-changebar-seg';
    seg.dataset.kind = kind;
    seg.style.flex = String(n);
    bar.appendChild(seg);
  }
  bar.title = parts.map(([kind, n]) => `${n} ${kind}`).join(', ');
  return bar;
}

// One run's metrics: how many files it touched, the mix, and the lines it added
// and removed once those land.
function buildRunMetrics(run, sessionIds) {
  const wrap = document.createElement('div');
  wrap.className = 'aut-recent-metrics';
  const count = Number(run && run.fileCount) || 0;
  const files = document.createElement('span');
  files.className = 'aut-recent-files';
  files.appendChild(autIcon(AUT_ICON_FILE));
  const num = document.createElement('span');
  num.textContent = count > 0 ? String(count) : 'none';
  files.appendChild(num);
  if (!count) files.classList.add('is-empty');
  files.title = count === 1 ? '1 file touched' : `${count} files touched`;
  wrap.appendChild(files);
  const bar = buildChangeBar(run && run.changes);
  if (bar) wrap.appendChild(bar);
  const lines = document.createElement('span');
  lines.className = 'aut-recent-lines';
  lines.dataset.sessions = (sessionIds || []).join(' ');
  wrap.appendChild(lines);
  return wrap;
}

// Line counts come from the run's own snapshot against the workspace it ran in,
// so they land after the list paints and only for runs that still have one.
const autopilotRunStats = new Map();
const AUT_STATS_BATCH = 12;
async function fillRunLineStats(runs) {
  const wanted = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!(Number(run.fileCount) > 0)) continue;
    const ids = Array.isArray(run.sessionIds) && run.sessionIds.length ? run.sessionIds : [run.sessionId];
    for (const sid of ids) if (sid && !autopilotRunStats.has(sid)) wanted.push(sid);
  }
  for (let i = 0; i < wanted.length; i += AUT_STATS_BATCH) {
    const batch = wanted.slice(i, i + AUT_STATS_BATCH);
    try {
      const res = await window.husk.autopilot.runStats({ sessionIds: batch });
      if (res && res.ok && res.stats) {
        for (const [sid, stat] of Object.entries(res.stats)) autopilotRunStats.set(sid, stat);
      } else {
        for (const sid of batch) autopilotRunStats.set(sid, null);
      }
    } catch (_) {
      for (const sid of batch) autopilotRunStats.set(sid, null);
    }
    paintRunLineStats();
  }
  paintRunLineStats();
}
function paintRunLineStats() {
  document.querySelectorAll('#aut-recent .aut-recent-lines').forEach((el) => {
    const ids = String(el.dataset.sessions || '').split(' ').filter(Boolean);
    let insertions = 0;
    let deletions = 0;
    let known = false;
    for (const sid of ids) {
      const stat = autopilotRunStats.get(sid);
      if (!stat) continue;
      known = true;
      insertions += Number(stat.insertions) || 0;
      deletions += Number(stat.deletions) || 0;
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!known || (!insertions && !deletions)) { el.removeAttribute('title'); return; }
    const ins = document.createElement('span');
    ins.className = 'is-ins';
    ins.textContent = `+${insertions}`;
    const del = document.createElement('span');
    del.className = 'is-del';
    del.textContent = `−${deletions}`;
    el.appendChild(ins);
    el.appendChild(del);
    el.title = `${insertions} lines added, ${deletions} lines removed`;
  });
}

async function refreshAutopilotHistory() {
  const list = $('#aut-recent');
  const meta = $('#aut-recent-meta');
  if (!list) return;
  const active = projectsCache.find((p) => p && p.id === activeProjectId);
  const workspaceRoot = active && active.path ? active.path : null;
  let r;
  try { r = await window.husk.autopilot.history({ workspaceRoot }); }
  catch (_) { r = { ok: false }; }
  if (!r || !r.ok) {
    while (list.firstChild) list.removeChild(list.firstChild);
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'Could not load history.';
    list.appendChild(empty);
    return;
  }
  const runs = r.runs || [];
  while (list.firstChild) list.removeChild(list.firstChild);
  // Bulk selection needs rows to act on, and the section states the fact once.
  const tools = $('#aut-recent-tools');
  if (tools) tools.hidden = !runs.length;
  if (meta) meta.textContent = '';
  if (!runs.length) {
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'No runs in this workspace yet. Start one from a preset above.';
    list.appendChild(empty);
    return;
  }
  // Selection survives a refresh only for sessions that still exist.
  const present = new Set(runs.flatMap((r) => Array.isArray(r.sessionIds) ? r.sessionIds : [r.sessionId]));
  for (const sid of [...selectedRunSessions]) if (!present.has(sid)) selectedRunSessions.delete(sid);
  lastHistorySessions = [...present];
  let totalFiles = 0;
  let totalSpend = 0;
  for (const run of runs) {
    totalFiles += Number(run.fileCount) || 0;
    totalSpend += Number(run.dollars) || 0;
    const row = document.createElement('div');
    row.className = 'aut-recent-row';
    const rowSessionIds = Array.isArray(run.sessionIds) && run.sessionIds.length ? run.sessionIds : [run.sessionId];
    row.dataset.session = run.historyId || run.sessionId;
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'aut-recent-check';
    check.checked = rowSessionIds.every((sid) => selectedRunSessions.has(sid));
    check.addEventListener('change', () => {
      if (check.checked) for (const sid of rowSessionIds) selectedRunSessions.add(sid);
      else for (const sid of rowSessionIds) selectedRunSessions.delete(sid);
      updateBulkDeleteUi();
    });
    // A full-height label strip on the row's left edge, so selection has a
    // forgiving target separate from the row's own open-on-click.
    const checkZone = document.createElement('label');
    checkZone.className = 'aut-recent-checkzone';
    checkZone.title = 'Select for bulk delete';
    checkZone.addEventListener('click', (e) => e.stopPropagation());
    checkZone.appendChild(check);
    row.appendChild(checkZone);
    const main = document.createElement('div');
    main.className = 'aut-recent-main';
    const goal = document.createElement('div');
    goal.className = 'aut-recent-goal';
    goal.textContent = run.goal || '(no goal recorded)';
    const m2 = document.createElement('div');
    m2.className = 'aut-recent-meta';
    const when = run.endedAt || run.capturedAt;
    const memberText = run.memberCount && run.memberCount > 1 ? `${run.memberCount} agents · ` : '';
    m2.textContent = `${fmtRelWhen(when) || 'no end time'} · ${memberText}${run.sessionId.slice(5, 17)}`;
    m2.title = fmtAbsWhen(when);
    main.appendChild(goal);
    main.appendChild(m2);
    const files = buildRunMetrics(run, rowSessionIds);
    const outcome = autRunOutcome(run);
    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.dataset.state = outcome.state;
    pill.appendChild(autIcon(outcome.icon));
    const pillLabel = document.createElement('span');
    pillLabel.textContent = outcome.label;
    pill.appendChild(pillLabel);
    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.className = 'aut-recent-rerun';
    rerun.title = 'Rerun this task';
    const rerunSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    rerunSvg.setAttribute('viewBox', '0 0 24 24');
    rerunSvg.setAttribute('fill', 'none');
    rerunSvg.setAttribute('stroke', 'currentColor');
    rerunSvg.setAttribute('stroke-width', '2');
    rerunSvg.setAttribute('stroke-linecap', 'round');
    rerunSvg.setAttribute('stroke-linejoin', 'round');
    rerunSvg.setAttribute('aria-hidden', 'true');
    const rerunP1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    rerunP1.setAttribute('d', 'M21 12a9 9 0 1 1-3-6.7L21 8');
    const rerunP2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    rerunP2.setAttribute('d', 'M21 3v5h-5');
    rerunSvg.appendChild(rerunP1);
    rerunSvg.appendChild(rerunP2);
    const rerunLbl = document.createElement('span');
    rerunLbl.textContent = 'Rerun';
    rerun.appendChild(rerunSvg);
    rerun.appendChild(rerunLbl);
    rerun.addEventListener('click', (e) => { e.stopPropagation(); rerunFromPastRun(run); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'aut-recent-del';
    del.title = 'Delete this run';
    del.setAttribute('aria-label', 'Delete run');
    const delSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    delSvg.setAttribute('viewBox', '0 0 24 24');
    delSvg.setAttribute('fill', 'none');
    delSvg.setAttribute('stroke', 'currentColor');
    delSvg.setAttribute('stroke-width', '2');
    delSvg.setAttribute('stroke-linecap', 'round');
    delSvg.setAttribute('stroke-linejoin', 'round');
    delSvg.setAttribute('aria-hidden', 'true');
    for (const d of ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2']) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      delSvg.appendChild(p);
    }
    del.appendChild(delSvg);
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteRun(run); });
    row.appendChild(main);
    row.appendChild(files);
    row.appendChild(pill);
    row.appendChild(rerun);
    row.appendChild(del);
    row.addEventListener('click', () => openAutopilotHistoryRun(run));
    list.appendChild(row);
  }
  // Totals ride the section's own line, and a zero figure is left off it.
  const metaParts = [`${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`];
  if (totalFiles) metaParts.push(`${totalFiles} ${totalFiles === 1 ? 'file' : 'files'} changed`);
  if (totalSpend) metaParts.push(`${formatDollars(totalSpend)} spent`);
  if (meta) meta.textContent = metaParts.join(' · ');
  updateBulkDeleteUi();
  fillRunLineStats(runs);
}
// ── Bulk run management ─────────────────────────────────────────────────
const selectedRunSessions = new Set();
let lastHistorySessions = [];
function updateBulkDeleteUi() {
  const btn = $('#aut-recent-bulkdel');
  const selall = $('#aut-recent-selall');
  const n = selectedRunSessions.size;
  if (btn) {
    btn.hidden = n === 0;
    btn.textContent = `Delete selected (${n})`;
  }
  if (selall) {
    selall.checked = n > 0 && n === lastHistorySessions.length;
    selall.indeterminate = n > 0 && n < lastHistorySessions.length;
  }
}
$('#aut-recent-selall') && $('#aut-recent-selall').addEventListener('change', function () {
  if (this.checked) for (const sid of lastHistorySessions) selectedRunSessions.add(sid);
  else selectedRunSessions.clear();
  document.querySelectorAll('#aut-recent .aut-recent-check').forEach((c) => { c.checked = this.checked; });
  updateBulkDeleteUi();
});
$('#aut-recent-bulkdel') && $('#aut-recent-bulkdel').addEventListener('click', async () => {
  const n = selectedRunSessions.size;
  if (!n) return;
  const ok = await openConfirmDialog({
    title: `Delete ${n} ${n === 1 ? 'run' : 'runs'}?`,
    bodyHtml: 'This permanently removes each selected run\'s snapshot, audit log, and saved file versions. You will no longer be able to review or revert them.',
    confirmLabel: `Delete ${n} ${n === 1 ? 'run' : 'runs'}`,
    cancelLabel: 'Keep',
  });
  if (!ok) return;
  let deleted = 0;
  const failed = [];
  for (const sid of [...selectedRunSessions]) {
    try {
      const r = await window.husk.autopilot.deleteRun({ sessionId: sid });
      if (r && r.ok) { deleted += 1; selectedRunSessions.delete(sid); }
      else failed.push((r && r.error) || sid);
    } catch (err) { failed.push((err && err.message) || sid); }
  }
  if (failed.length) toast(`Deleted ${deleted}; ${failed.length} failed (${String(failed[0]).slice(0, 60)})`, 'error');
  else toast(`Deleted ${deleted} ${deleted === 1 ? 'run' : 'runs'}`, 'success');
  refreshAutopilotHistory();
});

// Load a past run into the live layout in review mode: the same panes with
// frozen values, and a footer of Revert / Start-new instead of Stop. The
// activity feed is summarized from the audit log's event kinds and counts.
async function openAutopilotRunReview(sessionId, workspaceRoot) {
  try { setPage('autopilot'); } catch (_) {}
  try {
    const sum = await window.husk.autopilot.summary({ sessionId, workspaceRoot });
    if (!sum || !sum.ok) { toast((sum && sum.error) || 'Could not load run', 'error'); return; }
    enterReviewMode({ sessionId, workspaceRoot, summary: sum });
  } catch (err) {
    toast(`Could not load run: ${err && err.message || err}`, 'error');
  }
}

function summaryDiffWithSource(sum, fallback = {}) {
  const diff = Array.isArray(sum && sum.diff) ? sum.diff
    : (sum && sum.summary && Array.isArray(sum.summary.diff) ? sum.summary.diff : []);
  return diff.map((c) => ({
    ...c,
    sessionId: (sum && sum.sessionId) || fallback.sessionId || null,
    workspaceRoot: (sum && sum.workspaceRoot) || fallback.workspaceRoot || null,
  }));
}

async function openAutopilotHistoryRun(run) {
  const members = Array.isArray(run && run.members) && run.members.length ? run.members : [run];
  if (members.length <= 1) return openAutopilotRunReview(run.sessionId, run.workspaceRoot);
  try { setPage('autopilot'); } catch (_) {}
  try {
    const summaries = [];
    for (const member of members) {
      const sum = await window.husk.autopilot.summary({ sessionId: member.sessionId, workspaceRoot: member.workspaceRoot });
      if (sum && sum.ok) {
        sum.sessionId = sum.sessionId || member.sessionId;
        sum.workspaceRoot = sum.workspaceRoot || member.workspaceRoot;
        sum.role = sum.role || member.role || null;
        sum.agent = sum.agent || member.agent || null;
        summaries.push({ member, sum });
      }
    }
    if (!summaries.length) { toast('Could not load fleet run', 'error'); return; }
    const preferred = summaries.find((x) => x.member.sessionId === run.sessionId) || summaries[0];
    const aggregateDiff = summaries.flatMap((x) => summaryDiffWithSource(x.sum, x.member));
    if (!Array.isArray(preferred.sum.diff) || preferred.sum.diff.length === 0) preferred.sum.diff = aggregateDiff;
    if (preferred.sum.summary && (!Array.isArray(preferred.sum.summary.diff) || preferred.sum.summary.diff.length === 0)) {
      preferred.sum.summary.diff = aggregateDiff;
    }
    const fleet = summaries.map((x) => finishedAgentFromSummary(x.sum, { sessionId: x.member.sessionId }));
    enterReviewMode({
      sessionId: preferred.member.sessionId,
      workspaceRoot: preferred.member.workspaceRoot,
      summary: preferred.sum,
      members: fleet,
    });
    showFleetReceipt(summaries.map((x) => ({
      sessionId: x.member.sessionId,
      agent: x.member.agent || x.sum.agent || null,
      model: x.member.model || x.sum.modelObserved || null,
      fleetStartedAt: x.member.fleetStartedAt || x.sum.fleetStartedAt || null,
    })));
  } catch (err) {
    toast(`Could not load fleet run: ${err && err.message || err}`, 'error');
  }
}

// Autopilot live state, driven by the autopilot:started / budget / activity IPC
// events plus a poll of autopilot:liveDiff. The activity stream comes from each
// run's own transcript in the main process, so the feed is the selected run's
// data. Idle detection, nudges and auto-end live in main beside the run PTYs.
const AP_RING_C = 2 * Math.PI * 42; // r=42 on the big page rings
const AP_FEED_MAX_ROWS = 300;
const AP_DIFF_POLL_MS = 4000;
let autopilotReview = false;
let autopilotReviewData = null;
let autopilotState = {
  goal: '',
  startedAt: 0,
  caps: { minutes: 60, tokens: 200000, dollars: 5 },
  budget: null,
  feed: [],
  eventCount: 0,
  files: [],
  tickerId: null,
  diffPollId: null,
};
// Agents card: one row per agent, live, ended or orchestrator-planned, in the
// cockpit's left rail. A row carries a color dot, role and state, with the
// current action and elapsed/$/files below it, and clicking one focuses and
// maximizes that lane.
function renderRunCards() {
  const list = document.getElementById('aut-fleet-list');
  if (!list) return;
  // Rebuild the DOM only when the set of agents changes; budget ticks patch
  // the existing nodes in place through updateRunCardsLive.
  const sig = [...activeRuns.keys()].join(',') + '|' + plannedAgents.map((p) => p.role).join(',')
    + '|done:' + (activeRuns.size ? '' : finishedFleet.map((f) => f.role).join(','));
  if (list.dataset.sig === sig) { updateRunCardsLive(); return; }
  list.dataset.sig = sig;
  while (list.firstChild) list.removeChild(list.firstChild);
  for (const [rid, run] of activeRuns) {
    const row = document.createElement('div');
    row.className = 'aut-agent-row' + (rid === focusedRunId ? ' is-focused' : '');
    row.dataset.rid = rid;
    row.dataset.lane = String((run.colorIdx || 0) % AP_LANE_COLORS);
    row.title = run.goal || '(no goal)';
    row.addEventListener('click', () => switchFocusedRun(rid));
    const nameRow = document.createElement('div');
    nameRow.className = 'aut-chip-name';
    const cDot = document.createElement('span');
    cDot.className = 'aut-chip-dot';
    const cLabel = document.createElement('span');
    cLabel.className = 'aut-chip-label';
    cLabel.textContent = (run.role || run.agent || (run.goal || 'run').slice(0, 24));
    cLabel.title = cLabel.textContent;
    const cState = document.createElement('span');
    cState.className = 'aut-chip-state';
    nameRow.appendChild(cDot);
    nameRow.appendChild(cLabel);
    nameRow.appendChild(cState);
    const action = document.createElement('div');
    action.className = 'aut-chip-action';
    const metaEl = document.createElement('div');
    metaEl.className = 'aut-swarm-card-meta';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'aut-swarm-card-cancel';
    cancelBtn.title = 'Stop this run';
    cancelBtn.textContent = '×';
    cancelBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await openConfirmDialog({
        title: 'Stop this autopilot run?',
        bodyHtml: 'The agent will be interrupted. Changes are kept.',
        confirmLabel: 'Stop run',
        cancelLabel: 'Keep running',
      });
      if (!ok) return;
      try { await window.husk.autopilot.cancel({ runId: rid }); } catch (_) {}
    });
    row.appendChild(nameRow);
    row.appendChild(action);
    appendModelDecision(row, {
      model: bestRunModel(run),
      observedModel: run.modelObserved,
      tier: run.tier,
      reason: run.reason,
    });
    row.appendChild(metaEl);
    row.appendChild(cancelBtn);
    list.appendChild(row);
  }
  for (const p of plannedAgents) {
    const row = document.createElement('div');
    row.className = 'aut-agent-row is-queued';
    row.title = p.subgoal || '';
    const nameRow = document.createElement('div');
    nameRow.className = 'aut-chip-name';
    const cDot = document.createElement('span');
    cDot.className = 'aut-chip-dot';
    const cLabel = document.createElement('span');
    cLabel.className = 'aut-chip-label';
    cLabel.textContent = p.role || 'agent';
    cLabel.title = cLabel.textContent;
    const cState = document.createElement('span');
    cState.className = 'aut-chip-state';
    cState.textContent = 'queued';
    nameRow.appendChild(cDot);
    nameRow.appendChild(cLabel);
    nameRow.appendChild(cState);
    const action = document.createElement('div');
    action.className = 'aut-chip-action';
    action.textContent = String(p.subgoal || 'waiting for a free slot');
    action.title = p.subgoal || 'waiting for a free slot';
    // The transcript sits on disk beside the audit log, and this button is how
    // a finished run's own output is read back.
    if (f.sessionId) {
      const logBtn = document.createElement('button');
      logBtn.type = 'button';
      logBtn.className = 'aut-chip-log';
      logBtn.textContent = 'View log';
      logBtn.addEventListener('click', (e) => { e.stopPropagation(); openRunTranscript(f); });
      nameRow.appendChild(logBtn);
    }
    row.appendChild(nameRow);
    row.appendChild(action);
    appendModelDecision(row, p);
    list.appendChild(row);
  }
  // Post-run: no live or queued agents, but a finished fleet to keep on screen.
  // Each card shows what that agent did (model, tokens, cost, cache, files, how
  // it ended) so the panel is a durable record instead of going blank.
  if (!activeRuns.size && !plannedAgents.length && finishedFleet.length) {
    for (const f of finishedFleet) list.appendChild(buildFinishedAgentCard(f));
  }
  updateRunCardsLive();
}
// The run-log viewer renders a finished agent's transcript as text. It closes
// on its button, on the backdrop and on Escape.
$('#aut-transcript-close')?.addEventListener('click', () => { const d = $('#aut-transcript'); if (d) d.hidden = true; });
$('#aut-transcript')?.addEventListener('click', (e) => { if (e.target && e.target.id === 'aut-transcript') e.target.hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const d = $('#aut-transcript');
  if (d && !d.hidden) { e.preventDefault(); e.stopPropagation(); d.hidden = true; }
}, true);

async function openRunTranscript(f) {
  const dlg = $('#aut-transcript');
  const body = $('#aut-transcript-body');
  const title = $('#aut-transcript-title');
  if (!dlg || !body) return;
  if (title) title.textContent = `Run log \u00b7 ${f.role || 'agent'}`;
  body.textContent = 'Loading...';
  dlg.hidden = false;
  let res = null;
  try { res = await window.husk.autopilot.transcript({ sessionId: f.sessionId }); } catch (_) { res = null; }
  if (!res || !res.ok) {
    body.textContent = 'Could not read the transcript for this run.';
    return;
  }
  if (!res.text) {
    body.textContent = 'This run produced no output before it ended.';
    return;
  }
  // Strip the escape sequences a TUI agent paints with, so the log reads as
  // text instead of as cursor moves and colour codes.
  const clean = String(res.text)
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r/g, '');
  body.textContent = res.truncated ? `[showing the last ${formatTokens(res.text.length)} characters of ${formatTokens(res.bytes)}]\n\n${clean}` : clean;
  body.scrollTop = body.scrollHeight;
}

// Read-only card for a finished agent, built from its persisted record.
function buildFinishedAgentCard(f) {
  const row = document.createElement('div');
  row.className = 'aut-agent-row is-done' + (f.endedOk ? '' : ' is-halted');
  row.dataset.lane = String((f.colorIdx || 0) % AP_LANE_COLORS);
  row.title = f.goal || f.role;
  const nameRow = document.createElement('div');
  nameRow.className = 'aut-chip-name';
  const dot = document.createElement('span');
  dot.className = 'aut-chip-dot';
  const label = document.createElement('span');
  label.className = 'aut-chip-label';
  label.textContent = f.role;
  label.title = f.role;
  const state = document.createElement('span');
  state.className = 'aut-chip-state';
  state.dataset.state = f.endedOk ? 'done' : 'stopped';
  state.textContent = f.endedOk ? 'done' : (f.endReason || 'stopped');
  nameRow.appendChild(dot);
  nameRow.appendChild(label);
  nameRow.appendChild(state);
  const action = document.createElement('div');
  action.className = 'aut-chip-action';
  action.textContent = f.finalMessage || `${f.files} file${f.files === 1 ? '' : 's'} changed`;
  action.title = action.textContent;
  const meta = document.createElement('div');
  meta.className = 'aut-swarm-card-meta';
  const secs = Math.round((f.durationMs || 0) / 1000);
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
  const money = f.approx && !f.exact ? `~${formatDollars(f.dollars)}` : formatDollars(f.dollars);
  meta.textContent = `${dur}  ·  ${formatTokens(f.tokens)} tok  ·  ${money}`;
  // Cache-aware split, so the persisted record proves the number is real.
  const split = document.createElement('div');
  split.className = 'aut-chip-split';
  split.textContent = `in ${formatTokens(f.input)} · out ${formatTokens(f.output)} · cache r ${formatTokens(f.cacheRead)}/w ${formatTokens(f.cacheWrite)}`;
  row.appendChild(nameRow);
  row.appendChild(action);
  appendModelDecision(row, { model: f.model, observedModel: f.modelObserved, tier: f.tier, reason: f.reason, fallbackLabel: f.agent || null });
  row.appendChild(meta);
  row.appendChild(split);
  return row;
}
// Patch live agent-row content (state, current action, meta) in place.
function updateRunCardsLive() {
  const list = document.getElementById('aut-fleet-list');
  if (!list) return;
  const meta = document.getElementById('aut-agents-meta');
  if (meta) {
    if (!activeRuns.size && finishedFleet.length) {
      // Post-run: summarize the finished fleet, not a live count.
      const usd = finishedFleet.reduce((s, f) => s + (Number(f.dollars) || 0), 0);
      meta.textContent = `${finishedFleet.length} finished · ${formatDollars(usd)}`;
    } else {
      const totalUsd = [...activeRuns.values()].reduce((s, r) => s + (r.budget ? Number(r.budget.dollars) || 0 : 0), 0);
      meta.textContent = `${liveRunCount()}/${activeRuns.size + plannedAgents.length} live · ${formatDollars(totalUsd)}`;
    }
  }
  list.querySelectorAll('.aut-agent-row[data-rid]').forEach((row) => {
    const rid = row.dataset.rid;
    const run = activeRuns.get(rid);
    if (!run) return;
    row.classList.toggle('is-focused', rid === focusedRunId);
    row.classList.toggle('is-ended', !!run.ended);
    const stateEl = row.querySelector('.aut-chip-state');
    if (stateEl) {
      let state = run.ended ? (run.endedOk ? 'done' : 'stopped') : (run.state || 'starting');
      let text = state;
      if (!run.ended && run.nudges > 0 && state === 'quiet') text = `nudged ${run.nudges}/5`;
      else if (state === 'tool') text = 'tool';
      stateEl.dataset.state = state;
      stateEl.textContent = text;
    }
    const actionEl = row.querySelector('.aut-chip-action');
    if (actionEl) {
      if (run.ended && run.endSummary && run.endSummary.finalMessage) {
        actionEl.textContent = String(run.endSummary.finalMessage).slice(0, 220);
      } else if (run.lastTool) {
        actionEl.textContent = `▸ ${run.lastTool.slice(0, 220)}`;
      } else {
        const model = prettyModel(bestRunModel(run));
        actionEl.textContent = `${model ? model + ' · ' : ''}${(run.goal || '').slice(0, 220)}`;
      }
      actionEl.title = actionEl.textContent;
    }
    const oldModel = row.querySelector('.aut-chip-model');
    if (oldModel) oldModel.remove();
    const metaEl = row.querySelector('.aut-swarm-card-meta');
    appendModelDecision(row, {
      model: bestRunModel(run),
      observedModel: run.modelObserved,
      tier: run.tier,
      reason: run.reason,
    });
    const modelEl = row.querySelector('.aut-chip-model');
    if (modelEl && metaEl) row.insertBefore(modelEl, metaEl);
    if (metaEl) {
      const elapsed = run.startedAt ? Math.floor((Date.now() - run.startedAt) / 1000) : 0;
      const elTag = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m`;
      const usd = run.budget ? Number(run.budget.dollars) || 0 : 0;
      const files = Array.isArray(run.files) ? run.files.length : 0;
      metaEl.textContent = `${elTag}  ·  $${usd.toFixed(2)}  ·  ${files} ${files === 1 ? 'file' : 'files'}`;
    }
  });
}
// Focus an agent: highlight its chip and maximize its lane. No panel
// reset, no replay; every lane is already live.
function switchFocusedRun(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;
  focusedRunId = runId;
  autopilotLastSession = { sessionId: run.sessionId, workspaceRoot: run.workspaceRoot };
  if (run.caps) setAutopilotCaps(run.caps);
  toggleLaneMax(runId);
}
function paintAutopilotBanner() {
  const pulse = $('#rail-aut-pulse');
  const empty = $('#aut-page-empty');
  const live = $('#aut-page-live');
  const status = $('#aut-page-status');
  const statusText = $('#aut-page-status-text');
  const startBtn = $('#aut-page-start');
  const stopBtnTop = $('#aut-page-stop-top');
  const reviewButtons = document.querySelectorAll('.aut-review-only');
  const backBtn = $('#aut-review-back');
  const pageEl = document.querySelector('.page-autopilot');
  const showLive = autopilotActive || autopilotReview;
  if (pulse) pulse.hidden = !autopilotActive;
  if (empty) empty.hidden = showLive;
  if (live) live.hidden = !showLive;
  if (status) status.hidden = !showLive;
  if (pageEl) pageEl.classList.toggle('is-live', !!showLive);
  if (pageEl) pageEl.classList.toggle('is-review-mode', !!autopilotReview);
  // While a run is active or a review is open, the status pill replaces the
  // header Start button.
  if (startBtn) startBtn.hidden = showLive;
  if (stopBtnTop) stopBtnTop.hidden = !autopilotActive;
  // Revert needs a pre-run snapshot. Runs started with the snapshot toggle
  // off carry hasSnapshot === false, so the Revert button stays hidden even
  // in review (older runs without the field are treated as snapshotted).
  const reviewHasSnapshot = !(autopilotReviewData && autopilotReviewData.summary
    && autopilotReviewData.summary.hasSnapshot === false);
  // A retained run has a live worktree awaiting Apply/Discard and its changes
  // are not in the workspace yet, so those two replace the snapshot-flow
  // buttons. A run whose worktree is gone keeps the snapshot flow.
  const isRetained = !!(autopilotReview && autopilotReviewData && autopilotReviewData.retained);
  const reviewDiff = autopilotReviewData && autopilotReviewData.summary
    ? ((Array.isArray(autopilotReviewData.summary.diff) && autopilotReviewData.summary.diff.length)
      || (autopilotReviewData.summary.summary && Array.isArray(autopilotReviewData.summary.summary.diff) && autopilotReviewData.summary.summary.diff.length)
      || 0)
    : 0;
  reviewButtons.forEach((b) => {
    const isRevert = b.id === 'aut-review-revert';
    b.hidden = !autopilotReview || isRetained || (isRevert && !reviewHasSnapshot);
  });
  const applyBtn = $('#aut-review-apply');
  const discardBtn = $('#aut-review-discard');
  if (applyBtn) {
    applyBtn.hidden = !isRetained || reviewDiff === 0;
    applyBtn.disabled = reviewDiff === 0;
    applyBtn.textContent = reviewDiff > 0 ? `Apply ${reviewDiff} change${reviewDiff === 1 ? '' : 's'}` : 'No changes to apply';
  }
  if (discardBtn) {
    discardBtn.hidden = !isRetained;
    discardBtn.textContent = reviewDiff > 0 ? 'Discard run' : 'Dismiss run';
  }
  const fileActions = document.querySelector('.aut-files-actions');
  if (fileActions) fileActions.dataset.empty = reviewDiff === 0 ? '1' : '0';
  if (backBtn) backBtn.hidden = !autopilotReview;
  // Status pill content shifts by mode.
  if (statusText) {
    if (autopilotActive) statusText.textContent = 'Running';
    else if (autopilotReview && autopilotReviewData) {
      const reason = summaryEndReason(autopilotReviewData.summary) || 'ended';
      statusText.textContent = summaryCompletedSuccessfully(autopilotReviewData.summary)
        ? 'Succeeded'
        : (reason === 'agent_idle' || reason === 'agent_unverified') ? 'Incomplete'
        : reason === 'agent_blocked' ? 'Blocked'
        : reason === 'agent_failed' ? 'Failed'
        : (reason.charAt(0).toUpperCase() + reason.slice(1));
    } else statusText.textContent = '';
  }
  // Re-style the status pill in review mode (no accent pulse).
  if (status) status.classList.toggle('is-review', !autopilotActive && autopilotReview);
  if (status) {
    const reviewSuccess = !autopilotActive && autopilotReview && summaryCompletedSuccessfully(autopilotReviewData && autopilotReviewData.summary);
    const reviewIncomplete = !autopilotActive && autopilotReview && !reviewSuccess;
    status.classList.toggle('is-success', !!reviewSuccess);
    status.classList.toggle('is-incomplete', !!reviewIncomplete);
  }
  if (autopilotActive) {
    if (!autopilotState.tickerId) {
      autopilotState.tickerId = setInterval(updateAutopilotElapsed, 1000);
      updateAutopilotElapsed();
    }
    startLiveDiffPoll();
  } else {
    if (autopilotState.tickerId) { clearInterval(autopilotState.tickerId); autopilotState.tickerId = null; }
    stopLiveDiffPoll();
  }
  renderRunCards();
}
function exitReviewMode() {
  // Remember what was open so the mouse forward button can return to it,
  // mirroring browser back/forward symmetry.
  if (autopilotReviewData && autopilotReviewData.sessionId) {
    autopilotLastReview = { sessionId: autopilotReviewData.sessionId, workspaceRoot: autopilotReviewData.workspaceRoot };
  }
  autopilotReview = false;
  autopilotReviewData = null;
  if (finishedFleetBeforeHistory) {
    finishedFleet = finishedFleetBeforeHistory;
    finishedFleetBeforeHistory = null;
  }
  resetAutopilotPanel();
  paintAutopilotBanner();
  refreshAutopilotHistory();
  // Land back exactly where the user left the runs list, not at the top.
  const page = document.querySelector('.page-autopilot');
  if (page) page.scrollTop = autopilotHubScroll || 0;
}
// ── Global navigation: back/forward are first-class gestures ────────────
// One layered chain behind the mouse back/forward buttons, Alt+arrows,
// Esc, and the review back pill:
//   back:    topmost modal closes → autopilot review exits → previous page
//   forward: reopen last review → next page
// Esc walks the same chain except page history (Esc never leaves a page).
let autopilotHubScroll = 0;
let autopilotLastReview = null;
function autopilotPageVisible() {
  const page = document.querySelector('.page-autopilot');
  return !!(page && !page.hidden);
}
// Every overlay that floats on the palette shell, so a key aimed at one of them
// is not also read as a key for the page underneath.
function paletteOpen() {
  return !!document.querySelector('.palette:not([hidden])');
}
// Close the topmost open modal the way the modal itself would: its own close
// button when it has one, else the backdrop-click contract. The confirm dialog
// owns its promise and Esc handling, so it is left alone.
function closeTopModal() {
  const open = [...document.querySelectorAll('.modal:not([hidden])')].filter((m) => m.id !== 'confirm-modal');
  if (!open.length) return false;
  const m = open[open.length - 1];
  if (m.id === 'aut-diff-modal') { closeFileDiffModal(); return true; }
  const btn = m.querySelector('.modal-close, [data-modal-close]');
  if (btn) { btn.click(); return true; }
  m.dispatchEvent(new MouseEvent('click', { bubbles: false }));
  return true;
}
function anyModalOpen() {
  return !!document.querySelector('.modal:not([hidden])');
}
function reviewForward() {
  if (!autopilotPageVisible() || anyModalOpen()) return false;
  if (autopilotReview || autopilotActive || !autopilotLastReview) return false;
  openAutopilotRunReview(autopilotLastReview.sessionId, autopilotLastReview.workspaceRoot);
  return true;
}
function pageBack() {
  if (!pageHistory.length) return false;
  const prev = pageHistory.pop();
  pageForwardStack.push(currentPage);
  setPage(prev, { _nav: true });
  return true;
}
function pageForwardNav() {
  if (!pageForwardStack.length) return false;
  const next = pageForwardStack.pop();
  pageHistory.push(currentPage);
  setPage(next, { _nav: true });
  return true;
}
function globalBack() {
  if (paletteOpen()) return false; // the palette owns its own dismissal
  if (closeTopModal()) return true;
  if (autopilotPageVisible() && autopilotReview) { exitReviewMode(); return true; }
  return pageBack();
}
function globalForward() {
  if (paletteOpen() || anyModalOpen()) return false;
  if (reviewForward()) return true;
  return pageForwardNav();
}
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { if (globalBack()) e.preventDefault(); }
  else if (e.button === 4) { if (globalForward()) e.preventDefault(); }
});
window.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === 'Escape') {
    // Open modals are closed by the document-level Esc closer, which runs
    // first in the capture chain.
    if (paletteOpen() || anyModalOpen()) return;
    if (typing) return;
    if (autopilotPageVisible() && autopilotReview) { exitReviewMode(); e.preventDefault(); }
  } else if (e.key === 'ArrowLeft' && e.altKey && !typing) {
    if (globalBack()) e.preventDefault();
  } else if (e.key === 'ArrowRight' && e.altKey && !typing) {
    if (globalForward()) e.preventDefault();
  }
});
// ── Audit trail ─────────────────────────────────────────────────────────
// Every row the run appended to its hash-chained log, filtered by event type
// and paged newest first.
const AUT_AUDIT_PAGE = 50;
const AUT_AUDIT_MAX = 200;
const autopilotAudit = { sessionId: null, kind: null, limit: AUT_AUDIT_PAGE };

// The state an event type reads as, from what the name means rather than from a
// fixed list, so a kind added later still lands somewhere sensible.
function autAuditState(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'halt_user' || k.startsWith('cancel')) return 'muted';
  if (/error|fail|blocked|denied|broken/.test(k)) return 'error';
  if (/^halt|warn|cap|stall|idle|nudge/.test(k)) return 'warning';
  if (/summary|end_run|complete|done/.test(k)) return 'success';
  // Streamed output is the bulk of any log, so it stays quiet and the events
  // worth reading keep the colour.
  if (/output|chunk|token/.test(k)) return 'muted';
  if (/start|identity|status|tool|run_|agent_/.test(k)) return 'running';
  return 'muted';
}

function renderAuditFilters(kinds) {
  const wrap = $('#aut-audit-filters');
  if (!wrap) return;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  const total = (Array.isArray(kinds) ? kinds : []).reduce((sum, k) => sum + (Number(k.count) || 0), 0);
  const make = (kind, label, count) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    if ((autopilotAudit.kind || null) === kind) chip.classList.add('is-active');
    chip.setAttribute('aria-pressed', String((autopilotAudit.kind || null) === kind));
    const text = document.createElement('span');
    text.textContent = label;
    chip.appendChild(text);
    const n = document.createElement('span');
    n.className = 'chip-count';
    n.textContent = String(count);
    chip.appendChild(n);
    chip.addEventListener('click', () => {
      autopilotAudit.kind = kind;
      autopilotAudit.limit = AUT_AUDIT_PAGE;
      loadAuditTrail(autopilotAudit.sessionId);
    });
    return chip;
  };
  wrap.appendChild(make(null, 'All', total));
  for (const entry of Array.isArray(kinds) ? kinds : []) {
    wrap.appendChild(make(entry.kind, entry.kind, entry.count));
  }
}

function renderAuditRows(events) {
  const rows = $('#aut-audit-rows');
  if (!rows) return;
  while (rows.firstChild) rows.removeChild(rows.firstChild);
  if (!Array.isArray(events) || !events.length) {
    const empty = document.createElement('div');
    empty.className = 'aut-audit-empty';
    empty.textContent = autopilotAudit.kind
      ? `No ${autopilotAudit.kind} events in this run.`
      : 'This run recorded no events.';
    rows.appendChild(empty);
    return;
  }
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'aut-audit-row';
    const pill = document.createElement('span');
    pill.className = 'pill is-mono';
    pill.dataset.state = autAuditState(ev.kind);
    pill.textContent = ev.kind;
    row.appendChild(pill);
    const key = document.createElement('span');
    key.className = 'aut-audit-key';
    key.textContent = ev.key || 'no key';
    if (!ev.key) key.classList.add('is-empty');
    row.appendChild(key);
    const details = document.createElement('span');
    details.className = 'aut-audit-details';
    details.textContent = ev.details
      || (ev.spilled ? 'payload stored outside the log' : 'no details recorded');
    if (!ev.details) details.classList.add('is-empty');
    if (ev.details) details.title = ev.details;
    row.appendChild(details);
    const when = document.createElement('span');
    when.className = 'aut-audit-when';
    when.textContent = fmtRelWhen(ev.ts) || 'no stamp';
    when.title = fmtAbsWhen(ev.ts);
    row.appendChild(when);
    rows.appendChild(row);
  }
}

function renderAuditChain(chain) {
  const el = $('#aut-audit-chain');
  if (!el) return;
  if (!chain) { el.hidden = true; return; }
  el.hidden = false;
  el.dataset.state = chain.valid ? 'success' : 'error';
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(autIcon(chain.valid ? AUT_ICON_CHECK : AUT_ICON_ALERT));
  const label = document.createElement('span');
  label.textContent = chain.valid ? 'chain verified' : 'chain broken';
  el.appendChild(label);
  el.title = chain.valid
    ? 'Every row hashes over the one before it, so the log is tamper evident.'
    : `The hash chain breaks at row ${chain.brokenAtIndex}.`;
}

function renderAuditFoot(shown, filtered) {
  const more = $('#aut-audit-more');
  const showing = $('#aut-audit-showing');
  const noun = filtered === 1 ? 'event' : 'events';
  // The page stops at a ceiling, so the count says the newest ones are what is
  // on screen instead of implying the rest are one more click away.
  const capped = shown >= AUT_AUDIT_MAX && shown < filtered;
  if (showing) {
    showing.textContent = !filtered ? 'No events to show'
      : capped ? `Showing the newest ${shown} of ${filtered} ${noun}`
      : `Showing ${shown} of ${filtered} ${noun}`;
  }
  if (more) more.hidden = shown >= filtered || shown >= AUT_AUDIT_MAX;
}

function hideAuditTrail() {
  const section = $('#aut-audit');
  if (section) section.hidden = true;
  autopilotAudit.sessionId = null;
  autopilotAudit.kind = null;
  autopilotAudit.limit = AUT_AUDIT_PAGE;
}

async function loadAuditTrail(sessionId, opts = {}) {
  const section = $('#aut-audit');
  if (!section) return;
  if (!sessionId) { hideAuditTrail(); return; }
  if (opts.reset) {
    autopilotAudit.kind = null;
    autopilotAudit.limit = AUT_AUDIT_PAGE;
  }
  autopilotAudit.sessionId = sessionId;
  section.hidden = false;
  let res;
  try {
    res = await window.husk.autopilot.auditEvents({
      sessionId,
      kind: autopilotAudit.kind || undefined,
      limit: autopilotAudit.limit,
    });
  } catch (_) { res = null; }
  // A second run opened while this read was in flight owns the section now.
  if (autopilotAudit.sessionId !== sessionId) return;
  const totalEl = $('#aut-audit-total');
  if (!res || !res.ok) {
    renderAuditFilters([]);
    renderAuditChain(null);
    renderAuditRows([]);
    renderAuditFoot(0, 0);
    if (totalEl) totalEl.textContent = '';
    const rows = $('#aut-audit-rows');
    if (rows && rows.firstChild) rows.firstChild.textContent = 'Could not read this run\'s audit log.';
    return;
  }
  if (totalEl) totalEl.textContent = String(res.total || 0);
  renderAuditFilters(res.kinds);
  renderAuditChain(res.chain);
  renderAuditRows(res.events);
  renderAuditFoot((res.events || []).length, Number(res.filtered) || 0);
}

$('#aut-audit-more') && $('#aut-audit-more').addEventListener('click', () => {
  autopilotAudit.limit = Math.min(autopilotAudit.limit + AUT_AUDIT_PAGE, AUT_AUDIT_MAX);
  loadAuditTrail(autopilotAudit.sessionId);
});

function enterReviewMode({ sessionId, workspaceRoot, summary, retained = false, runId = null, members = null }) {
  // Remember the hub scroll position so back returns to the same spot
  // in the runs list.
  const pageEl0 = document.querySelector('.page-autopilot');
  if (pageEl0 && !autopilotReview) autopilotHubScroll = pageEl0.scrollTop;
  // A review opens at its own top, so the run reads from the first card down.
  if (pageEl0) pageEl0.scrollTop = 0;
  autopilotActive = false;
  autopilotReview = true;
  autopilotReviewData = { sessionId, workspaceRoot, summary, retained, runId };
  if (Array.isArray(members) && members.length) {
    if (finishedFleet.length && !finishedFleetBeforeHistory) finishedFleetBeforeHistory = finishedFleet.slice();
    finishedFleet = members;
  } else if (!activeRuns.size) {
    const sid = sessionId || (summary && summary.sessionId) || null;
    const hasCurrent = sid && finishedFleet.some((f) => f && f.sessionId === sid);
    if (!hasCurrent) {
      if (finishedFleet.length && !finishedFleetBeforeHistory) finishedFleetBeforeHistory = finishedFleet.slice();
      finishedFleet = [finishedAgentFromSummary(summary, { sessionId: sid })];
    }
  }
  resetAutopilotPanel();
  const s = summary && summary.summary;
  // The goal lives in the start_run row; the run_summary payload carries the
  // final meter and diff but no goal.
  const realGoal = missionGoalFromSummary(summary) || null;
  setAutopilotGoal(realGoal || '(no goal recorded for this run)');
  // Caps: start_run row first, then meter.caps, then current defaults.
  const caps = (summary && summary.caps) || (s && s.meter && s.meter.caps) || autopilotState.caps;
  setAutopilotCaps(caps);
  // Show a frozen elapsed timer = the final duration.
  const ms = (s && s.durationMs) || 0;
  const elSec = Math.floor(ms / 1000);
  const elMin = Math.floor(elSec / 60);
  const elapsedTxt = elMin === 0 ? `${elSec}s` : `${elMin}m ${String(elSec % 60).padStart(2, '0')}s`;
  const headEl = $('#aut-page-elapsed'); if (headEl) headEl.textContent = elapsedTxt;
  // Paint rings with final values.
  const finalBudget = (s && s.meter) || null;
  if (finalBudget) {
    autopilotState.startedAt = Date.now() - ms;
    updateAutopilotBudget(finalBudget);
  }
  // Touched files = final diff from the run.
  const diff = (summary && summary.diff) || [];
  autopilotState.files = diff.slice();
  renderTouchedFiles(diff);
  // Activity placeholder: audit log records event counts but not
  // full text; surface a short summary in the feed pane.
  const events = Number(summary && summary.eventCount) || 0;
  const halt = (s && s.haltReason) || 'natural';
  const lines = [
    `Run ${halt === 'natural' ? 'completed' : halt}.`,
    `${events} ${events === 1 ? 'event' : 'events'} recorded in the audit log.`,
    `${diff.length} ${diff.length === 1 ? 'file' : 'files'} touched against the pre-run snapshot.`,
  ];
  if (summary && summary.chain && summary.chain.valid) lines.push('Audit chain verified (tamper-evident).');
  pushActivity(lines, '_review');
  renderRunConclusion(summary);
  paintReviewLaneState(summary);
  renderTimeline();
  paintAutopilotBanner();
  loadAuditTrail(sessionId || (summary && summary.sessionId) || null, { reset: true });
}
// The replay lane holds a recording, so its badge reports how the run finished
// rather than the starting state a live lane opens on.
function paintReviewLaneState(sum) {
  const el = document.querySelector('.aut-lane[data-key="_review"] .aut-lane-state');
  if (!el) return;
  const reason = summaryEndReason(sum);
  const stopped = reason === 'user' || reason === 'cancelled';
  const ok = summaryCompletedSuccessfully(sum);
  el.dataset.state = ok ? 'done' : stopped ? 'stopped' : 'blocked';
  el.textContent = ok ? 'completed' : stopped ? 'stopped' : 'incomplete';
}
// Conclusion card appended to the feed when a run is reviewed: why it ended,
// the final numbers, and the agent's last narration as its report. A summary
// with no finalMessage shows outcome and metrics only.
function renderRunConclusion(sum) {
  if (!sum) return;
  const laneKey = (sum.runId && activeRuns.has(sum.runId)) ? sum.runId : '_review';
  const lane = ensureLane(laneKey);
  const feed = lane && lane.querySelector('.aut-lane-stream');
  if (!feed) return;
  const s = sum.summary || {};
  const halt = s.haltReason || 'natural';
  const reason = sum.endReason || '';
  const card = document.createElement('div');
  card.className = 'aut-conclusion';
  card.dataset.state =
    reason === 'agent_complete' ? 'success'
    : (reason === 'agent_failed' || reason === 'agent_blocked') ? 'error'
    : (reason === 'user' || halt === 'user') ? 'muted'
    : (halt === 'natural' && !reason) ? 'success'
    : 'warning';
  const title = document.createElement('div');
  title.className = 'aut-conclusion-title';
  title.textContent =
    reason === 'agent_complete' ? 'Run complete: the agent declared the goal finished'
    : reason === 'agent_idle' ? 'Run ended: the agent went idle without declaring completion'
    : reason === 'agent_startup_stall' ? 'Run stopped: the agent never got past startup'
    : reason === 'agent_blocked' ? 'Run blocked: the agent reported it could not continue'
    : reason === 'agent_failed' ? 'Run failed: the agent reported failure'
    : reason === 'agent_unverified' ? 'Run incomplete: the agent reported completion without verification'
    : (reason === 'user' || halt === 'user') ? 'Run stopped by you'
    : (reason === 'budget' || halt === 'budget') ? 'Run stopped at a budget cap'
    : reason === 'agent-exited' ? 'Run ended: the agent process exited'
    : 'Run ended';
  card.appendChild(title);
  const meter = s.meter || {};
  const files = Array.isArray(sum.diff) ? sum.diff.length : 0;
  const secs = Math.round((s.durationMs || 0) / 1000);
  const durTxt = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
  const meta = document.createElement('div');
  meta.className = 'aut-conclusion-meta';
  // Scope label: the live strip sums the whole fleet while this card
  // covers one run, and the two must not read as the same number.
  const scope = sum.groupId ? 'this agent' : 'this run';
  meta.textContent = `${scope}: ${durTxt}  ·  ${formatTokens(Number(meter.totalTokens) || 0)} tokens  ·  $${(Number(meter.dollars) || 0).toFixed(2)}  ·  ${files} ${files === 1 ? 'file' : 'files'} changed`;
  card.appendChild(meta);
  if (sum.finalMessage) {
    const label = document.createElement('div');
    label.className = 'aut-conclusion-label';
    label.textContent = 'AGENT FINAL REPORT';
    card.appendChild(label);
    const msg = document.createElement('div');
    msg.className = 'aut-conclusion-msg';
    msg.textContent = String(sum.finalMessage).slice(0, 4000);
    card.appendChild(msg);
  }
  feed.appendChild(card);
  feed.scrollTop = feed.scrollHeight;
}
// Fleet Receipt: one shareable card summarizing the whole fleet, with total
// spend, what landed, and the waste the governor caught. Built from the
// autopilot:receipt IPC, rendered in the review lane on the conclusion card's
// classes, and copyable in one click.
async function showFleetReceipt(members) {
  try {
    const runs = (Array.isArray(members) ? members : []).filter((m) => m && m.sessionId);
    if (!runs.length) return;
    const res = await window.husk.autopilot.receipt({ runs });
    if (!res || !res.ok || !res.receipt) return;
    renderFleetReceipt(res.receipt);
    // For a real fleet the Mission panel shows the fleet total, so it and the
    // receipt report the same number.
    if (res.receipt.runCount > 1) {
      try {
        updateAutopilotBudget({
          totalTokens: res.receipt.totalTokens,
          dollars: res.receipt.totalDollars,
          tokensReported: !!res.receipt.tokensEstimated,
        });
        const ms = Number(res.receipt.totalDurationMs) || 0;
        if (ms > 0) {
          autopilotState.startedAt = Date.now() - ms;
          const sec = Math.floor(ms / 1000);
          const min = Math.floor(sec / 60);
          const elapsed = min === 0 ? `${sec}s` : `${min}m ${String(sec % 60).padStart(2, '0')}s`;
          const headEl = $('#aut-page-elapsed');
          if (headEl) headEl.textContent = elapsed;
        }
      } catch (_) {}
    }
  } catch (_) { /* a receipt is a bonus; never let it break review */ }
}
function renderFleetReceipt(receipt) {
  if (!receipt || !receipt.runCount) return;
  const lane = ensureLane('_review');
  const feed = lane && lane.querySelector('.aut-lane-stream');
  if (!feed) return;
  // Only a genuinely incomplete fleet (stalled/capped/stopped, nothing landed)
  // is a failure. A clean finish with no file changes is a read-only/no-op
  // success and must not be flagged red.
  const incomplete = receipt.outcome === 'incomplete';
  const noOp = receipt.outcome === 'no-op';
  const card = document.createElement('div');
  card.className = 'aut-conclusion aut-receipt';
  card.dataset.state = incomplete ? 'warning' : (noOp ? 'muted' : 'success');

  const label = document.createElement('div');
  label.className = 'aut-conclusion-label';
  label.textContent = incomplete ? 'FLEET RECEIPT · DID NOT COMPLETE'
    : noOp ? 'FLEET RECEIPT · NO CODE CHANGES'
    : 'FLEET RECEIPT';
  card.appendChild(label);

  if (incomplete) {
    const note = document.createElement('div');
    note.className = 'aut-conclusion-meta';
    note.textContent = 'The fleet stopped before finishing (stall or cap) and nothing landed. Review each agent, then rerun or adjust the goal.';
    card.appendChild(note);
  } else if (noOp) {
    const note = document.createElement('div');
    note.className = 'aut-conclusion-meta';
    note.textContent = 'Agents completed and changed no files. Expected for a read-only task (audit, list, report); if you wanted edits, make the goal explicit.';
    card.appendChild(note);
  }

  const title = document.createElement('div');
  title.className = 'aut-conclusion-title';
  title.textContent = receipt.headline;
  card.appendChild(title);

  const c = receipt.counts || {};
  const secs = Math.round((receipt.totalDurationMs || 0) / 1000);
  const durTxt = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`;
  const meta = document.createElement('div');
  meta.className = 'aut-conclusion-meta';
  const bits = [
    `${receipt.runCount} ${receipt.runCount === 1 ? 'run' : 'runs'}`,
    `${durTxt} wall-clock`,
    `${formatTokens(receipt.totalTokens || 0)} tokens`,
    `$${(receipt.totalDollars || 0).toFixed(2)}`,
  ];
  if (c.landed) bits.push(`${c.landed} landed`);
  if (c.incomplete) bits.push(`${c.incomplete} incomplete`);
  if (c.saved) bits.push(`${c.saved} runaway${c.saved === 1 ? '' : 's'} caught`);
  if (c.capped) bits.push(`${c.capped} capped`);
  meta.textContent = bits.join('  ·  ');
  card.appendChild(meta);

  if (Array.isArray(receipt.agents) && receipt.agents.length > 1) {
    const per = document.createElement('div');
    per.className = 'aut-conclusion-meta';
    per.textContent = receipt.agents.map((a) => `${a.agent} ${a.runs}× $${(a.dollars || 0).toFixed(2)}`).join('   ');
    card.appendChild(per);
  }

  const copy = document.createElement('button');
  copy.textContent = 'Copy receipt';
  copy.className = 'aut-receipt-copy';
  copy.addEventListener('click', () => {
    const s$ = receipt.savings && receipt.savings.dollars > 0 ? ` Governor caught ${receipt.savings.caughtStalls} runaway run${receipt.savings.caughtStalls === 1 ? '' : 's'} (up to $${receipt.savings.dollars.toFixed(2)} saved).` : '';
    const text = `Ran my backlog across ${receipt.runCount} agents in Husk: ${receipt.headline}.${s$}`;
    try { navigator.clipboard.writeText(text); toast('Receipt copied', 'success'); }
    catch (_) { toast('Copy failed', 'error'); }
  });
  card.appendChild(copy);

  feed.appendChild(card);
  feed.scrollTop = feed.scrollHeight;
}
function summaryEndReason(sum) {
  const s = (sum && sum.summary) || {};
  return (sum && sum.endReason)
    || (s.haltDetail && s.haltDetail.reason)
    || s.haltReason
    || '';
}
function summaryCompletedSuccessfully(sum) {
  const reason = summaryEndReason(sum);
  if (['agent_idle', 'agent_startup_stall', 'agent-exited', 'agent_blocked', 'agent_failed', 'agent_unverified', 'budget', 'stall', 'user'].includes(reason)) return false;
  const s = (sum && sum.summary) || {};
  return reason === 'agent_complete' || reason === 'natural' || (reason === 'ended' && s.haltReason === 'natural');
}
function missionGoalFromSummary(sum) {
  const s = (sum && sum.summary) || {};
  return (sum && typeof sum.originalGoal === 'string' && sum.originalGoal.trim())
    || (sum && typeof sum.fleetGoal === 'string' && sum.fleetGoal.trim())
    || (sum && typeof sum.goal === 'string' && sum.goal.trim())
    || (s && typeof s.goal === 'string' && s.goal.trim())
    || '';
}
function setAutopilotGoal(goal) {
  autopilotState.goal = goal || '(no goal provided)';
  const el = $('#aut-page-goal-text');
  if (el) el.textContent = autopilotState.goal;
}
function setAutopilotCaps(caps) {
  autopilotState.caps = Object.assign({ minutes: 60, tokens: 200000, dollars: 5 }, caps || {});
  const c = autopilotState.caps;
  const tc = $('#aut-page-cap-time'); if (tc) tc.textContent = c.minutes > 0 ? `of ${c.minutes}m` : 'no time limit';
  const ko = $('#aut-page-cap-tokens'); if (ko) ko.textContent = c.tokens > 0 ? `of ${formatTokens(c.tokens)}` : 'no token limit';
  const dc = $('#aut-page-cap-dollars'); if (dc) dc.textContent = c.dollars > 0 ? `of ${formatDollars(c.dollars)}` : 'no budget limit';
}
function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}
// Friendly model label from a raw id or tier alias, vendor-agnostic.
// claude-opus-4-8 -> Opus 4.8; haiku -> Haiku; gemini-2.5-pro -> Gemini 2.5 Pro.
function prettyModel(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  // gpt ids ("gpt-5.5", "gpt 5.4-mini") parsed stepwise: version head first,
  // then a plain-token remainder, so no quantifier nests in an optional group.
  const gptHead = s.match(/^gpt[-_ ]?(\d[\d.]*)/i);
  if (gptHead) {
    let rest = s.slice(gptHead[0].length);
    if (/^[-_ ]/.test(rest)) rest = rest.slice(1);
    if (!rest || (rest.length <= 32 && /^[A-Za-z0-9.]+$/.test(rest))) {
      return `GPT-${gptHead[1]}${rest ? '-' + rest : ''}`;
    }
  }
  const bare = s.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const cap = (w) => w ? w[0].toUpperCase() + w.slice(1) : w;
  const fam = bare.match(/^(opus|sonnet|haiku|fable|mythos)\b/);
  if (fam) {
    const ver = bare.slice(fam[1].length).replace(/^-/, '');
    if (!ver) return cap(fam[1]);
    if (ver.length <= 8 && /^\d[\d.-]*$/.test(ver)) return cap(fam[1]) + ' ' + ver.replace('-', '.');
  }
  // Non-claude ids: title-case the dashed segments.
  return bare.split(/[-_]/).map((p) => /^\d/.test(p) ? p : cap(p)).join(' ');
}
function formatDollars(usd) {
  // Always $X.YY, including under a cent, so the unit reads the same
  // everywhere.
  if (!Number.isFinite(usd)) return '$0.00';
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  return `$${usd.toFixed(2)}`;
}
function updateRing(id, pct, meterEl) {
  const ring = document.getElementById(id);
  if (!ring) return;
  const clamped = Math.max(0, Math.min(1, pct));
  ring.style.strokeDashoffset = String(AP_RING_C * (1 - clamped));
  if (meterEl) meterEl.classList.toggle('is-warn', clamped >= 0.8);
}
function updateAutopilotBudget(b) {
  if (!b) return;
  autopilotState.budget = b;
  const caps = autopilotState.caps;
  const meters = document.querySelectorAll('.aut-page-meter');
  const elapsedMin = (Date.now() - autopilotState.startedAt) / 60000;
  const tv = $('#aut-page-val-time');
  if (tv) tv.textContent = elapsedMin < 1 ? `${Math.floor(elapsedMin * 60)}s` : `${elapsedMin.toFixed(1)}m`;
  updateRing('aut-page-ring-time', caps.minutes > 0 ? elapsedMin / caps.minutes : 0, meters[0]);
  const tk = Number(b.totalTokens) || 0;          // fresh work, for the cap ring
  const approx = !!(b.tokensReported || b.tokensEstimated);
  const partial = !!b.tokensPartial;
  const tv2 = $('#aut-page-val-tokens');
  if (tv2) {
    // The headline is the quantity the cap ring measures. Cache reads sit
    // outside it and are reported separately below.
    tv2.textContent = (approx && tk > 0 ? '~' : '') + formatTokens(tk);
    tv2.title = partial
      ? 'Partial token accounting: this agent did not expose full input/context totals'
      : 'Input, output and cache writes. Cache reads are the cached prefix re-sent each request and are counted separately below.';
  }
  updateRing('aut-page-ring-tokens', caps.tokens > 0 ? tk / caps.tokens : 0, meters[1]);
  const usd = Number(b.dollars) || 0;
  const dv = $('#aut-page-val-dollars');
  if (dv) dv.textContent = formatDollars(usd);
  applyDollarLabel();
  updateRing('aut-page-ring-dollars', caps.dollars > 0 ? usd / caps.dollars : 0, meters[2]);
}
// Billing mode: whether the dollar figure is money the user actually pays
// (claude on an API key) or a would-be API cost (a Pro/Max plan, which is flat
// monthly and capped by usage, not billed per token).
let autBilling = { metered: false, agent: 'claude', hasApiKey: false };
async function refreshAutBilling() {
  try { autBilling = await window.husk.autopilot.billingMode() || autBilling; } catch (_) {}
  applyDollarLabel();
}
// Relabel the dollar stat so a plan user is never told they "spent" money they
// did not. On a plan it is an API-equivalent reference; on an API key it is an
// estimate of real spend.
function applyDollarLabel() {
  const lbl = document.getElementById('aut-page-lbl-dollars');
  const val = document.getElementById('aut-page-val-dollars');
  if (lbl) lbl.textContent = autBilling.metered ? 'Est. spend' : 'API-equivalent';
  if (val) {
    val.title = autBilling.metered
      ? 'Estimated from the transcript at API list prices (cache writes 1.25x input, cache reads 0.1x, output ~5x). Close, not a bill.'
      : `You are on a ${autBilling.agent === 'claude' ? 'Claude plan' : 'plan'}: a flat monthly fee with usage limits, not per-token billing. This is what these tokens would cost via the API, for reference only.`;
  }
}

// Live usage strip across the whole fleet: tokens and spend sum over all
// runs, time counts from the earliest start, warn when ANY run crosses
// 80% of a cap.
function renderUsageStripLive() {
  const caps = autopilotState.caps;
  const meters = document.querySelectorAll('.aut-page-meter');
  let tokens = 0;      // fresh work (input+output+cache write); drives the cap
  let dollars = 0;
  let anyApprox = false;
  let warnTime = false;
  let warnTokens = false;
  let warnDollars = false;
  let earliest = 0;
  let brk = { input: 0, output: 0, cw: 0, cr: 0, baseline: 0, agents: 0, requests: 0, exact: false, approx: false, partial: false };
  for (const run of activeRuns.values()) {
    const b = run.budget;
    if (run.startedAt && (!earliest || run.startedAt < earliest)) earliest = run.startedAt;
    if (!b) continue;
    tokens += Number(b.totalTokens) || 0;
    dollars += Number(b.dollars) || 0;
    brk.input += Number(b.inputTokens) || 0;
    brk.output += Number(b.outputTokens) || 0;
    brk.cw += Number(b.cacheCreateTokens) || 0;
    brk.cr += Number(b.cacheReadTokens) || 0;
    // Context each agent loaded before starting. A fleet pays this once per
    // agent, so it scales with agent count rather than with the task.
    const base = Number(b.baselineContextTokens) || 0;
    if (base > 0) { brk.baseline += base; brk.agents += 1; }
      brk.requests += Number(b.requestCount) || 0;
    if (b.tokensExact) brk.exact = true;
    if (b.tokensReported || b.tokensEstimated) { anyApprox = true; brk.approx = true; }
    if (b.tokensPartial) brk.partial = true;
    if (caps.tokens > 0 && (Number(b.totalTokens) || 0) / caps.tokens >= 0.8) warnTokens = true;
    if (caps.dollars > 0 && (Number(b.dollars) || 0) / caps.dollars >= 0.8) warnDollars = true;
  }
  renderTokenBreakdown(brk);
  const elapsedMin = earliest ? (Date.now() - earliest) / 60000 : 0;
  if (caps.minutes > 0 && elapsedMin / caps.minutes >= 0.8) warnTime = true;
  const tv = $('#aut-page-val-time');
  if (tv) tv.textContent = elapsedMin < 1 ? `${Math.floor(elapsedMin * 60)}s` : `${elapsedMin.toFixed(1)}m`;
  const tv2 = $('#aut-page-val-tokens');
  if (tv2) {
    // The headline is the quantity the cap ring measures. Cache reads sit
    // outside it and are reported separately below.
    tv2.textContent = (anyApprox && tokens > 0 ? '~' : '') + formatTokens(tokens);
    tv2.title = brk.partial
      ? 'Partial token accounting: at least one agent did not expose full input/context totals'
      : 'Input, output and cache writes. Cache reads are the cached prefix re-sent each request and are counted separately below.';
  }
  const dv = $('#aut-page-val-dollars');
  if (dv) dv.textContent = formatDollars(dollars);
  applyDollarLabel();
  if (meters[0]) meters[0].classList.toggle('is-warn', warnTime);
  if (meters[1]) meters[1].classList.toggle('is-warn', warnTokens);
  if (meters[2]) meters[2].classList.toggle('is-warn', warnDollars);
}
// Cache-aware token split under the headline count, since cache reads dominate
// the raw number but bill at a tenth. 'exact' means the numbers came from the
// agent's structured transcript; 'approx' means a status-line cumulative or a
// chars/4 estimate.
function renderTokenBreakdown(brk) {
  const box = document.getElementById('aut-token-breakdown');
  if (!box) return;
  const total = brk.input + brk.output + brk.cw + brk.cr;
  if (!total) { box.hidden = true; return; }
  box.hidden = false;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = formatTokens(v); };
  // The headline counts every tier, and cache writes are the context each
  // agent loads before doing any work, so the split names each quantity.
  const split = document.getElementById('aut-page-split-tokens');
  if (split) {
    const generated = brk.input + brk.output;
    const context = brk.cw + brk.cr;
    if (context > generated) {
      split.hidden = false;
      // Each quantity is named: context is loaded once per agent, and cache
      // reads are that same prefix re-sent on every request.
      const perAgent = brk.agents > 0 ? Math.round(brk.baseline / brk.agents) : 0;
      const parts = [`${formatTokens(generated)} generated`];
      if (perAgent > 0) {
        parts.push(brk.agents > 1
          ? `${brk.agents} \u00d7 ~${formatTokens(perAgent)} context loaded`
          : `~${formatTokens(perAgent)} context loaded`);
      }
      if (brk.cr > 0) {
        parts.push(brk.requests > 0
          ? `${formatTokens(brk.cr)} re-read over ${brk.requests} requests`
          : `${formatTokens(brk.cr)} re-read`);
      }
      split.textContent = parts.join(' \u00b7 ');
      split.title = 'Generated is what the models actually wrote and read as new input. Context is the '
        + 'workspace, skills and tool definitions each agent loads before it starts: written to cache '
        + 'once, reread every turn at a tenth of the price.';
    } else {
      split.hidden = true;
    }
  }
  set('aut-tb-input', brk.input);
  set('aut-tb-output', brk.output);
  set('aut-tb-cw', brk.cw);
  set('aut-tb-cr', brk.cr);
  const src = document.getElementById('aut-tb-src');
  if (src) {
    src.textContent = brk.partial ? 'partial · output/cache only'
      : brk.exact ? 'exact · from transcript'
      : brk.approx ? 'approx · status line'
      : '';
    src.dataset.exact = brk.exact ? '1' : '0';
  }
}
function updateAutopilotElapsed() {
  if (!autopilotActive) return;
  const ms = Date.now() - autopilotState.startedAt;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const tag = m === 0 ? `${r}s` : `${m}m ${String(r).padStart(2, '0')}s`;
  const headEl = $('#aut-page-elapsed'); if (headEl) headEl.textContent = tag;
  if (autopilotState.budget) updateAutopilotBudget(autopilotState.budget);
  updateRunCardsLive();
}
function classifyActivityLine(line) {
  const t = line.toLowerCase();
  if (/^[•·→>*]/.test(line) || /^(running|using|calling) tool/.test(t)) return 'ap-row-tool';
  if (/(edit|writ|patch|appl|chang)/i.test(t)) return 'ap-row-edit';
  if (/(done|success|complet|ok|wrote)/i.test(t)) return 'ap-row-result';
  return '';
}
// Spinner dedupe: an agent cycles glyphs ("* Foo...", "+ Foo...") to show
// liveness, so lines that match after their leading non-word chars are
// stripped become one row that flashes per tick.
function normalizeForSpinnerDedupe(s) {
  return String(s).replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// ── Mission-control dashboard ───────────────────────────────────────────
// One lane per agent, all streaming live. Each lane shows the agent's
// thinking (assistant narration) interleaved with tool calls; the fleet
// strip above summarizes every agent's state; the right rail groups
// touched files by agent and plots lifecycle events on a timeline.
const AP_LANE_COLORS = 4; // hue set: accent, emerald, amber, violet
let autopilotTimeline = [];
let autopilotRunStart = 0;
let plannedAgents = []; // orchestrator-planned roles not yet started
let finishedFleet = []; // per-agent records that survive activeRuns.clear() into review
let autopilotFleetId = null;
let finishedFleetBeforeHistory = null;

function resetAutopilotRunScope() {
  activeRuns.clear();
  focusedRunId = null;
  autopilotTimeline = [];
  autopilotRunStart = 0;
  plannedAgents = [];
  finishedFleet = [];
  finishedFleetBeforeHistory = null;
  autopilotModelDecisions.clear();
}

// Snapshot every active run's final state before activeRuns is cleared, so the
// agents panel keeps showing what each agent did after the run ends.
function snapshotFinishedFleet() {
  finishedFleet = [...activeRuns.values()].map((run) => {
    const b = run.budget || {};
    const sum = run.endSummary || null;
    return {
      sessionId: run.sessionId || (sum && sum.sessionId) || null,
      role: run.role || run.agent || (run.goal ? run.goal.slice(0, 24) : 'agent'),
      agent: run.agent || null,
      model: bestRunModel(run) || null,
      modelObserved: run.modelObserved || b.modelObserved || null,
      tier: run.tier || null,
      reason: run.reason || null,
      goal: run.goal || null,
      originalGoal: run.originalGoal || run.goal || null,
      colorIdx: run.colorIdx || 0,
      endedOk: !!run.endedOk,
      endReason: (sum && sum.endReason) || (run.endedOk ? 'agent_complete' : 'ended'),
      finalMessage: (sum && sum.finalMessage) ? String(sum.finalMessage).slice(0, 200) : null,
      durationMs: run.startedAt ? Date.now() - run.startedAt : 0,
      files: Array.isArray(run.files) ? run.files.length : 0,
      dollars: Number(b.dollars) || 0,
      tokens: Number(b.totalTokens) || 0,
      input: Number(b.inputTokens) || 0,
      output: Number(b.outputTokens) || 0,
      cacheWrite: Number(b.cacheCreateTokens) || 0,
      cacheRead: Number(b.cacheReadTokens) || 0,
      exact: !!b.tokensExact,
      approx: !!(b.tokensReported || b.tokensEstimated),
    };
  });
}
function finishedAgentFromSummary(sum, fallback = {}) {
  const s = (sum && sum.summary) || {};
  const meter = s.meter || {};
  const diff = Array.isArray(sum && sum.diff) ? sum.diff
    : (Array.isArray(s.diff) ? s.diff : []);
  const secs = Number(s.durationMs) || 0;
  return {
    sessionId: (sum && sum.sessionId) || fallback.sessionId || null,
    role: (sum && (sum.role || sum.agent)) || 'reviewed run',
    agent: (sum && sum.agent) || null,
    model: meter.modelId || null,
    modelObserved: (sum && sum.modelObserved) || null,
    tier: null,
    reason: null,
    goal: (sum && sum.goal) || null,
    originalGoal: missionGoalFromSummary(sum) || null,
    colorIdx: 0,
    endedOk: summaryCompletedSuccessfully(sum),
    endReason: (sum && sum.endReason) || s.haltReason || 'ended',
    finalMessage: (sum && sum.finalMessage) ? String(sum.finalMessage).slice(0, 200) : null,
    durationMs: secs,
    files: diff.length,
    dollars: Number(meter.dollars) || 0,
    tokens: Number(meter.totalTokens) || 0,
    input: Number(meter.inputTokens) || 0,
    output: Number(meter.outputTokens) || 0,
    cacheWrite: Number(meter.cacheCreateTokens) || 0,
    cacheRead: Number(meter.cacheReadTokens) || 0,
    exact: !!meter.tokensExact,
    approx: !!(meter.tokensReported || meter.tokensEstimated),
  };
}

function liveRunCount() {
  let n = 0;
  for (const r of activeRuns.values()) if (!r.ended) n++;
  return n;
}
function shouldResetAutopilotForStarted(info) {
  const continuingGroup = !!(info && info.groupId
    && [...activeRuns.values()].some((r) => r && r.groupId === info.groupId));
  return !continuingGroup && !liveRunCount() && !plannedAgents.length;
}
function isModelFallback(id) {
  const raw = String(id || '').trim();
  if (!raw) return true;
  if (/\(default\)$/i.test(raw)) return true;
  // '_default' is the budget meter's pricing-table fallback key; older run
  // summaries persisted it as the model id, so never show it as a model name.
  if (/^_?default$/i.test(raw)) return true;
  return /^(claude|copilot|codex|aider|gemini)$/i.test(raw);
}
function bestRunModel(run) {
  if (!run) return '';
  const b = run.budget || {};
  const observed = run.modelObserved || b.modelObserved || '';
  if (observed && !isModelFallback(observed)) return observed;
  const planned = run.model || b.modelId || '';
  return isModelFallback(planned) ? '' : planned;
}
function appendModelDecision(parent, data = {}) {
  const observed = data.modelObserved || data.observedModel || '';
  const planned = data.model || data.modelId || '';
  const rawModel = observed && !isModelFallback(observed)
    ? observed
    : (!isModelFallback(planned) ? planned : '');
  const model = rawModel ? prettyModel(rawModel) : '';
  const tier = data.tier ? String(data.tier) : '';
  const reason = data.reason ? String(data.reason) : '';
  const row = document.createElement('div');
  row.className = 'aut-chip-model';
  row.title = [rawModel, tier, reason].filter(Boolean).join(' | ');
  const label = document.createElement('span');
  label.className = 'aut-chip-model-k';
  label.textContent = 'model';
  row.appendChild(label);
  if (model) {
    const pill = document.createElement('span');
    pill.className = 'aut-model-pill';
    pill.textContent = model;
    pill.title = rawModel;
    row.appendChild(pill);
  } else {
    const pending = document.createElement('span');
    pending.className = 'aut-model-pill is-pending';
    pending.textContent = data.fallbackLabel || 'detecting...';
    row.appendChild(pending);
  }
  if (tier) {
    const tierEl = document.createElement('span');
    tierEl.className = 'aut-tier-pill';
    tierEl.textContent = tier;
    row.appendChild(tierEl);
  }
  if (reason) {
    const why = document.createElement('span');
    why.className = 'aut-chip-model-reason';
    why.textContent = reason;
    why.title = reason;
    if (model) why.hidden = true;
    row.appendChild(why);
  }
  parent.appendChild(row);
  return row;
}
function tlPush(kind, label, colorIdx) {
  autopilotTimeline.push({
    at: Date.now(), kind,
    label: String(label || kind).slice(0, 120),
    color: colorIdx == null ? -1 : (colorIdx % AP_LANE_COLORS),
  });
  if (autopilotTimeline.length > 150) autopilotTimeline.shift();
  renderTimeline();
}
// Run log: labeled lifecycle events, newest first. Each row: wall-clock
// timestamp, colored marker for the owning agent, and what happened.
function renderTimeline() {
  const el = $('#aut-timeline');
  if (!el) return;
  // Rebuild only when a new event landed; this runs on every budget tick.
  const sig = String(autopilotTimeline.length);
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  // The count belongs to this card, so it reports what this card renders
  // rather than the run-log feed's separate stream.
  const ec = $('#aut-page-event-count');
  if (ec) {
    const n = autopilotTimeline.length;
    ec.textContent = `${n} ${n === 1 ? 'event' : 'events'}`;
  }
  while (el.firstChild) el.removeChild(el.firstChild);
  if (!autopilotTimeline.length) {
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'Lifecycle events appear here.';
    el.appendChild(empty);
    return;
  }
  for (let i = autopilotTimeline.length - 1; i >= 0; i--) {
    const ev = autopilotTimeline[i];
    const row = document.createElement('div');
    row.className = `aut-ev aut-ev-${ev.kind}`;
    if (ev.color >= 0) row.dataset.lane = String(ev.color);
    const d = new Date(ev.at);
    const t = document.createElement('span');
    t.className = 'aut-ev-time';
    // Absolute wall-clock stamp, DD-MM-YYYY HH:MM:SS, so a persisted log reads
    // unambiguously after the run (and across days), not a relative offset.
    const p2 = (n) => String(n).padStart(2, '0');
    t.textContent = `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} `
      + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    const mark = document.createElement('span');
    mark.className = 'aut-ev-mark';
    const label = document.createElement('span');
    label.className = 'aut-ev-label';
    label.textContent = ev.label;
    label.title = new Date(ev.at).toLocaleTimeString();
    row.appendChild(t);
    row.appendChild(mark);
    row.appendChild(label);
    el.appendChild(row);
  }
}
function laneTitleFor(key) {
  if (key === '_orch') return 'orchestrator';
  if (key === '_review') return 'run log';
  const run = activeRuns.get(key);
  if (!run) return key.replace(/^_/, '');
  return run.role || run.agent || (run.goal ? run.goal.slice(0, 40) : 'agent');
}
function ensureLane(key, opts = {}) {
  const lanes = $('#aut-lanes');
  if (!lanes) return null;
  let lane = lanes.querySelector(`.aut-lane[data-key="${CSS.escape(key)}"]`);
  if (lane) return lane;
  const run = activeRuns.get(key);
  const colorIdx = opts.colorIdx != null ? opts.colorIdx
    : (run && run.colorIdx != null) ? run.colorIdx
    : (key === '_orch' ? 3 : 0);
  lane = document.createElement('div');
  lane.className = 'aut-lane';
  lane.dataset.key = key;
  lane.dataset.lane = String(colorIdx % AP_LANE_COLORS);
  const head = document.createElement('div');
  head.className = 'aut-lane-head';
  head.title = 'Click to expand this agent';
  const dot = document.createElement('span');
  dot.className = 'aut-lane-dot';
  const name = document.createElement('span');
  name.className = 'aut-lane-name';
  name.textContent = opts.title || laneTitleFor(key);
  const model = document.createElement('span');
  model.className = 'aut-lane-model';
  model.hidden = true;
  const state = document.createElement('span');
  state.className = 'aut-lane-state';
  state.dataset.state = 'starting';
  state.textContent = 'starting';
  const tool = document.createElement('span');
  tool.className = 'aut-lane-tool';
  tool.hidden = true;
  head.appendChild(dot);
  head.appendChild(name);
  head.appendChild(model);
  head.appendChild(state);
  head.appendChild(tool);
  head.addEventListener('click', () => toggleLaneMax(key));
  const stream = document.createElement('div');
  stream.className = 'aut-lane-stream';
  // Auto-follow with pause-on-scroll: scrolling up freezes the lane and
  // reveals the jump pill; the pill (or scrolling back down) resumes.
  stream.addEventListener('scroll', () => {
    const atBottom = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 24;
    lane.classList.toggle('is-paused', !atBottom);
  });
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'aut-lane-jump';
  jump.textContent = 'jump to live';
  jump.addEventListener('click', () => {
    stream.scrollTop = stream.scrollHeight;
    lane.classList.remove('is-paused');
  });
  lane.appendChild(head);
  lane.appendChild(stream);
  lane.appendChild(jump);
  lanes.appendChild(lane);
  lanes.dataset.count = String(lanes.querySelectorAll('.aut-lane').length);
  // The orchestrator's planning lane earns a column only while it is the
  // whole show; once real agent lanes exist its notes live in the fleet
  // strip and timeline instead.
  if (key !== '_orch' && key !== '_review') {
    const orch = lanes.querySelector('.aut-lane[data-key="_orch"]');
    if (orch) orch.classList.add('is-bg');
  }
  if (key === '_orch' && lanes.querySelector('.aut-lane:not([data-key="_orch"]):not([data-key="_review"])')) {
    lane.classList.add('is-bg');
  }
  return lane;
}
function toggleLaneMax(key) {
  const lanes = $('#aut-lanes');
  if (!lanes) return;
  const lane = lanes.querySelector(`.aut-lane[data-key="${CSS.escape(key)}"]`);
  if (!lane) return;
  const wasMax = lane.classList.contains('is-max');
  lanes.querySelectorAll('.aut-lane').forEach((l) => l.classList.remove('is-max'));
  lanes.classList.toggle('has-max', !wasMax);
  if (!wasMax) lane.classList.add('is-max');
  if (activeRuns.has(key)) {
    focusedRunId = key;
    const run = activeRuns.get(key);
    if (run && run.originalGoal) setAutopilotGoal(run.originalGoal);
  }
  renderRunCards();
}
function laneAppend(key, items, opts = {}) {
  if (!Array.isArray(items) || !items.length) return;
  const lane = ensureLane(key, opts);
  if (!lane) return;
  const stream = lane.querySelector('.aut-lane-stream');
  if (!stream) return;
  const follow = !lane.classList.contains('is-paused');
  for (const raw of items) {
    const it = (raw && typeof raw === 'object') ? raw : { kind: 'status', text: String(raw) };
    const kind = it.kind === 'thought' || it.kind === 'tool' || it.kind === 'output' ? it.kind : 'status';
    const text = String(it.text || '').slice(0, 320);
    if (!text || text.length < 3) continue;
    const normalized = normalizeForSpinnerDedupe(text);
    const last = stream.lastElementChild;
    if (last && last.dataset && last.dataset.norm === normalized) {
      const tEl = last.querySelector('.aut-ln-text');
      if (tEl) tEl.textContent = text;
      continue;
    }
    autopilotState.eventCount += 1;
    const row = document.createElement('div');
    row.className = `aut-ln aut-ln-${kind}`;
    row.dataset.norm = normalized;
    const tEl = document.createElement('span');
    tEl.className = 'aut-ln-text';
    tEl.textContent = text;
    row.appendChild(tEl);
    stream.appendChild(row);
  }
  while (stream.children.length > AP_FEED_MAX_ROWS) stream.removeChild(stream.firstChild);
  if (follow) stream.scrollTop = stream.scrollHeight;
}
// Update a lane's header from the run's live telemetry (state chip and
// current-tool ticker with elapsed seconds).
function updateLaneHead(key) {
  const lanes = $('#aut-lanes');
  const run = activeRuns.get(key);
  if (!lanes || !run) return;
  const lane = lanes.querySelector(`.aut-lane[data-key="${CSS.escape(key)}"]`);
  if (!lane) return;
  const stateEl = lane.querySelector('.aut-lane-state');
  const modelEl = lane.querySelector('.aut-lane-model');
  const toolEl = lane.querySelector('.aut-lane-tool');
  let state = run.ended ? (run.endedOk ? 'done' : 'stopped') : (run.state || 'starting');
  let stateText = state;
  if (!run.ended && run.nudges > 0 && state === 'quiet') stateText = `nudged ${run.nudges}/5`;
  else if (state === 'quiet' && run.quietMs > 4000) stateText = `quiet ${Math.round(run.quietMs / 1000)}s`;
  else if (state === 'tool') stateText = 'running tool';
  if (stateEl) {
    stateEl.dataset.state = state;
    stateEl.textContent = stateText;
  }
  if (modelEl) {
    const model = bestRunModel(run);
    modelEl.hidden = !model;
    modelEl.textContent = model ? prettyModel(model) : '';
    modelEl.title = model || '';
  }
  if (toolEl) {
    if (!run.ended && run.lastTool && (state === 'tool' || state === 'working')) {
      const secs = run.lastToolAt ? Math.max(0, Math.round((Date.now() - run.lastToolAt) / 1000)) : 0;
      toolEl.hidden = false;
      toolEl.textContent = `${run.lastTool.slice(0, 60)}${state === 'tool' ? ` · ${secs}s` : ''}`;
    } else {
      toolEl.hidden = true;
    }
  }
}
// Untyped entry point: route bare lines into a lane. Tool lines carry
// the arrow prefix from main; everything else is status narration.
function pushActivity(lines, runKey) {
  if (!Array.isArray(lines) || !lines.length) return;
  const items = lines.map((l) => (l && typeof l === 'object')
    ? l
    : { kind: String(l).startsWith('→ ') ? 'tool' : 'status', text: String(l) });
  const key = runKey || (autopilotReview ? '_review' : (focusedRunId || '_orch'));
  laneAppend(key, items);
}
// Live rail: touched files across ALL agents, grouped under each agent's
// color marker. Clicking a row opens the diff modal against that run's
// own session/worktree.
function renderRailFiles() {
  const pane = $('#aut-page-files');
  const counter = $('#aut-page-files-count');
  if (!pane) return;
  while (pane.firstChild) pane.removeChild(pane.firstChild);
  let total = 0;
  let groups = 0;
  for (const [key, run] of activeRuns) {
    const files = Array.isArray(run.files) ? run.files : [];
    if (!files.length) continue;
    groups += 1;
    total += files.length;
    const head = document.createElement('div');
    head.className = 'aut-rf-group';
    head.dataset.lane = String((run.colorIdx || 0) % AP_LANE_COLORS);
    const gDot = document.createElement('span');
    gDot.className = 'aut-rf-dot';
    const gName = document.createElement('span');
    gName.className = 'aut-rf-name';
    gName.textContent = laneTitleFor(key);
    const gCount = document.createElement('span');
    gCount.className = 'aut-rf-count';
    gCount.textContent = String(files.length);
    head.appendChild(gDot);
    head.appendChild(gName);
    head.appendChild(gCount);
    pane.appendChild(head);
    const ordered = files.slice().sort((a, b) => String(a.path).localeCompare(String(b.path)));
    for (const c of ordered) {
      const row = document.createElement('div');
      row.className = 'aut-file-row aut-rf-row';
      row.dataset.status = c.status || 'modified';
      row.title = 'Open diff';
      const badge = document.createElement('span');
      badge.className = 'aut-file-status';
      badge.textContent = (c.status || 'modified')[0].toUpperCase();
      const p = document.createElement('span');
      p.className = 'aut-file-path';
      p.textContent = c.path || '';
      row.appendChild(badge);
      row.appendChild(p);
      row.addEventListener('click', () => openFileDiffModal(c.path, c.status, {
        sessionId: run.sessionId, workspaceRoot: run.workspaceRoot,
      }));
      pane.appendChild(row);
    }
  }
  if (!groups) {
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'No file changes yet.';
    pane.appendChild(empty);
  }
  if (counter) counter.textContent = String(total);
}
function renderTouchedFiles(changes) {
  const pane = $('#aut-page-files');
  const counter = $('#aut-page-files-count');
  if (!pane) return;
  while (pane.firstChild) pane.removeChild(pane.firstChild);
  if (!Array.isArray(changes) || !changes.length) {
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    const title = document.createElement('div');
    title.className = 'aut-empty-title';
    title.textContent = autopilotReview ? 'No code changes to apply' : 'No file changes yet';
    const sub = document.createElement('div');
    sub.className = 'aut-empty-sub';
    sub.textContent = autopilotReview
      ? 'This run produced output only. Keep the report, rerun with an edit-focused goal, or dismiss the retained worktree.'
      : 'Files touched by the agent will appear here with inline diffs.';
    empty.appendChild(title);
    empty.appendChild(sub);
    pane.appendChild(empty);
    if (counter) counter.textContent = '0';
    return;
  }
  const ordered = changes.slice().sort((a, b) => String(a.path).localeCompare(String(b.path)));
  for (const c of ordered) {
    const row = document.createElement('div');
    row.className = 'aut-file-row';
    row.dataset.status = c.status || 'modified';
    row.dataset.path = c.path || '';
    row.title = 'Open diff';
    const badge = document.createElement('span');
    badge.className = 'aut-file-status';
    badge.textContent = c.status || 'modified';
    const p = document.createElement('span');
    p.className = 'aut-file-path';
    p.textContent = c.path || '';
    row.appendChild(badge);
    row.appendChild(p);
    row.addEventListener('click', () => openFileDiffModal(c.path, c.status, {
      sessionId: c.sessionId || undefined,
      workspaceRoot: c.workspaceRoot || undefined,
    }));
    pane.appendChild(row);
  }
  if (counter) counter.textContent = String(changes.length);
}

// LCS line diff. Returns array of { kind: 'add' | 'remove' | 'context',
// text, beforeNo?, afterNo? }. O(m*n) memory; main.js capped sides at
// 6000 lines so the table stays manageable.
function lineDiff(beforeText, afterText) {
  const a = beforeText.split('\n');
  const b = afterText.split('\n');
  const m = a.length;
  const n = b.length;
  // Build LCS length table (m+1 by n+1). Uint16 saves memory for the
  // common case of <= 65535 lines (our cap is 6000).
  const rowSize = n + 1;
  const dp = new Uint16Array((m + 1) * rowSize);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const idx = i * rowSize + j;
      if (a[i] === b[j]) dp[idx] = dp[(i + 1) * rowSize + (j + 1)] + 1;
      else dp[idx] = Math.max(dp[(i + 1) * rowSize + j], dp[i * rowSize + (j + 1)]);
    }
  }
  const out = [];
  let i = 0, j = 0, bn = 1, an = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i], beforeNo: bn++, afterNo: an++ });
      i++; j++;
    } else if (dp[(i + 1) * rowSize + j] >= dp[i * rowSize + (j + 1)]) {
      out.push({ kind: 'remove', text: a[i], beforeNo: bn++ });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], afterNo: an++ });
      j++;
    }
  }
  while (i < m) { out.push({ kind: 'remove', text: a[i], beforeNo: bn++ }); i++; }
  while (j < n) { out.push({ kind: 'add', text: b[j], afterNo: an++ }); j++; }
  return out;
}

// Collapse big runs of unchanged context into a hunk-gap row so the
// modal is scannable on long files. Keeps CONTEXT_LINES around each
// change.
function compactDiff(rows, contextLines = 3) {
  const isChange = (r) => r.kind === 'add' || r.kind === 'remove';
  // Pre-compute distance-to-nearest-change so we can fast-cull.
  const n = rows.length;
  const nearChange = new Uint8Array(n);
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (isChange(rows[i])) last = i;
    if (i - last <= contextLines) nearChange[i] = 1;
  }
  last = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    if (isChange(rows[i])) last = i;
    if (last - i <= contextLines) nearChange[i] = 1;
  }
  const out = [];
  let skipped = 0;
  let skipStart = 0;
  for (let i = 0; i < n; i++) {
    if (nearChange[i]) {
      if (skipped > 0) {
        out.push({ kind: 'hunk-gap', text: `... ${skipped} unchanged line${skipped === 1 ? '' : 's'}`, skippedFrom: skipStart, skippedTo: i - 1 });
        skipped = 0;
      }
      out.push(rows[i]);
    } else {
      if (skipped === 0) skipStart = i;
      skipped++;
    }
  }
  if (skipped > 0) out.push({ kind: 'hunk-gap', text: `... ${skipped} unchanged line${skipped === 1 ? '' : 's'}`, skippedFrom: skipStart, skippedTo: n - 1 });
  return out;
}

async function openFileDiffModal(relPath, status, ctx) {
  const modal = $('#aut-diff-modal');
  const pathEl = $('#aut-diff-path');
  const statusEl = $('#aut-diff-status');
  const loading = $('#aut-diff-loading');
  const message = $('#aut-diff-message');
  const content = $('#aut-diff-content');
  const added = $('#aut-diff-added-count');
  const removed = $('#aut-diff-removed-count');
  if (!modal) return;
  // Resolve which session + workspace owns this diff. Live run wins;
  // review mode uses the loaded review session.
  let sessionId = autopilotLastSession && autopilotLastSession.sessionId;
  let workspaceRoot = autopilotLastSession && autopilotLastSession.workspaceRoot;
  if (autopilotReview && autopilotReviewData) {
    sessionId = autopilotReviewData.sessionId;
    workspaceRoot = autopilotReviewData.workspaceRoot;
  }
  // The rail passes the owning run's session explicitly, since every agent in
  // a team has its own worktree.
  if (ctx && ctx.sessionId && ctx.workspaceRoot) {
    sessionId = ctx.sessionId;
    workspaceRoot = ctx.workspaceRoot;
  }
  if (!sessionId || !workspaceRoot) {
    toast('No active session for this diff', 'error');
    return;
  }
  if (pathEl) pathEl.textContent = relPath;
  if (statusEl) {
    statusEl.dataset.status = status || 'modified';
    statusEl.textContent = (status || 'modified').toUpperCase();
  }
  if (added) added.textContent = '+0';
  if (removed) removed.textContent = '−0';
  while (content.firstChild) content.removeChild(content.firstChild);
  if (message) { message.hidden = true; message.textContent = ''; }
  if (loading) { loading.hidden = false; loading.textContent = 'Loading diff...'; }
  modal.hidden = false;
  let res;
  try {
    res = await window.husk.autopilot.fileDiff({ sessionId, workspaceRoot, path: relPath });
  } catch (err) {
    res = { ok: false, error: err && err.message || String(err) };
  }
  if (loading) loading.hidden = true;
  if (!res || !res.ok) {
    if (message) { message.hidden = false; message.textContent = (res && res.error) || 'Could not load diff'; }
    return;
  }
  if (res.tooLarge) {
    if (message) { message.hidden = false; message.textContent = `File is too large to diff inline (${(res.beforeBytes || 0).toLocaleString()} -> ${(res.afterBytes || 0).toLocaleString()} bytes).`; }
    return;
  }
  // Compute diff client-side. Status determines if we even bother.
  let rows;
  if (res.status === 'added') {
    rows = res.after.split('\n').map((t, i) => ({ kind: 'add', text: t, afterNo: i + 1 }));
  } else if (res.status === 'deleted') {
    rows = res.before.split('\n').map((t, i) => ({ kind: 'remove', text: t, beforeNo: i + 1 }));
  } else {
    rows = lineDiff(res.before, res.after);
  }
  let addCount = 0, removeCount = 0;
  for (const r of rows) {
    if (r.kind === 'add') addCount++;
    else if (r.kind === 'remove') removeCount++;
  }
  if (added) added.textContent = `+${addCount}`;
  if (removed) removed.textContent = `−${removeCount}`;
  // Compact long unchanged runs.
  const display = res.status === 'modified' ? compactDiff(rows, 3) : rows;
  for (const r of display) {
    const line = document.createElement('div');
    line.className = `aut-diff-line ${r.kind}`;
    const beforeLn = document.createElement('span');
    beforeLn.className = 'aut-diff-ln';
    beforeLn.textContent = r.beforeNo != null ? String(r.beforeNo) : '';
    const afterLn = document.createElement('span');
    afterLn.className = 'aut-diff-ln';
    afterLn.textContent = r.afterNo != null ? String(r.afterNo) : '';
    const sign = document.createElement('span');
    sign.className = 'aut-diff-sign';
    sign.textContent = r.kind === 'add' ? '+' : r.kind === 'remove' ? '−' : (r.kind === 'hunk-gap' ? '⋯' : ' ');
    const text = document.createElement('span');
    text.className = 'aut-diff-text';
    text.textContent = r.text;
    line.appendChild(beforeLn);
    line.appendChild(afterLn);
    line.appendChild(sign);
    line.appendChild(text);
    content.appendChild(line);
  }
}

function closeFileDiffModal() {
  const modal = $('#aut-diff-modal');
  if (modal) modal.hidden = true;
}
async function pollLiveDiff() {
  if (!autopilotActive) return;
  // Every live agent's diff, not just the focused one: the rail groups
  // files per agent, so all lanes must stay warm.
  let any = false;
  for (const [key, run] of activeRuns) {
    if (run.ended) continue;
    try {
      const r = await window.husk.autopilot.liveDiff({ runId: run.runId || undefined });
      if (!r || !r.ok) continue;
      const had = Array.isArray(run.files) ? run.files.length : 0;
      run.files = r.changes || [];
      if (!had && run.files.length) tlPush('file', `${laneTitleFor(key)}: first file change`, run.colorIdx);
      any = true;
    } catch (_) {}
  }
  if (any) renderRailFiles();
}
function startLiveDiffPoll() {
  if (autopilotState.diffPollId) return;
  pollLiveDiff();
  autopilotState.diffPollId = setInterval(pollLiveDiff, AP_DIFF_POLL_MS);
}
function stopLiveDiffPoll() {
  if (autopilotState.diffPollId) { clearInterval(autopilotState.diffPollId); autopilotState.diffPollId = null; }
}
function resetAutopilotPanel() {
  hideAuditTrail();
  autopilotState.feed = [];
  autopilotState.eventCount = 0;
  autopilotState.budget = null;
  autopilotState.files = [];
  const lanes = $('#aut-lanes');
  if (lanes) {
    while (lanes.firstChild) lanes.removeChild(lanes.firstChild);
    lanes.classList.remove('has-max');
    lanes.dataset.count = '0';
  }
  const tl = $('#aut-timeline');
  if (tl) { while (tl.firstChild) tl.removeChild(tl.firstChild); tl.dataset.sig = ''; }
  const fleet = $('#aut-fleet-list');
  if (fleet) { while (fleet.firstChild) fleet.removeChild(fleet.firstChild); fleet.dataset.sig = ''; }
  renderTouchedFiles([]);
  const ec = $('#aut-page-event-count'); if (ec) ec.textContent = '0 events';
  ['aut-page-ring-time', 'aut-page-ring-tokens', 'aut-page-ring-dollars'].forEach((id) => {
    const r = document.getElementById(id);
    if (r) r.style.strokeDashoffset = String(AP_RING_C);
  });
  document.querySelectorAll('.aut-page-meter').forEach((m) => m.classList.remove('is-warn'));
  const tv = $('#aut-page-val-time'); if (tv) tv.textContent = '0s';
  const tv2 = $('#aut-page-val-tokens'); if (tv2) tv2.textContent = '0';
  const dv = $('#aut-page-val-dollars'); if (dv) dv.textContent = '$0.00';
}
function openAutopilotEndModal(sum) {
  if (!sum || !sum.ok) { toast('Could not load run summary', 'error'); return; }
  const meta = $('#aut-end-meta');
  const diff = $('#aut-end-diff');
  const title = $('#aut-end-title');
  const status = (sum.summary && sum.summary.status) || 'ended';
  const haltReason = (sum.summary && sum.summary.haltReason) || 'natural';
  const durationMin = sum.summary && sum.summary.durationMs ? Math.round(sum.summary.durationMs / 60000 * 10) / 10 : 0;
  title.textContent = `Autopilot run ${status}`;
  // eslint-disable-next-line no-unsanitized/property -- escapeHtml on every dynamic value
  meta.innerHTML = `
    <div><strong>Status:</strong> ${escapeHtml(status)} (${escapeHtml(haltReason)})</div>
    <div><strong>Duration:</strong> ${durationMin} min</div>
    <div><strong>Events recorded:</strong> ${Number(sum.eventCount) || 0}</div>
    <div><strong>Audit chain:</strong> ${sum.chain && sum.chain.valid ? 'valid (tamper-evident)' : 'BROKEN at row ' + (sum.chain && sum.chain.brokenAtIndex)}</div>
  `;
  const changes = sum.diff || [];
  if (!changes.length) {
    // eslint-disable-next-line no-unsanitized/property -- static html
    diff.innerHTML = '<div class="ai-empty">No file changes detected.</div>';
  } else {
    // eslint-disable-next-line no-unsanitized/property -- every dynamic value escaped
    diff.innerHTML = changes.map((c) => `
      <div class="ai-row" style="cursor:default;">
        <div class="ai-row-body">
          <div class="ai-row-name">${escapeHtml(c.path)}</div>
        </div>
        <span class="ai-row-pill">${escapeHtml(c.status)}</span>
      </div>
    `).join('');
  }
  // Revert restores the pre-run snapshot; hide it for runs that had none
  // (snapshot toggle off). Older runs without the field keep the button.
  const revertBtn = $('#aut-end-revert');
  if (revertBtn) revertBtn.hidden = sum.hasSnapshot === false;
  $('#autopilot-end-modal').hidden = false;
}
function closeAutopilotEndModal() { $('#autopilot-end-modal').hidden = true; }
// Report a revert honestly: a non-empty warnings list means some files
// were NOT restored (decrypt failure, blob mismatch, fs error).
function reportRevertResult(r) {
  const restored = (r.restored || []).length;
  const warned = (r.warnings || []).length;
  if (warned) {
    toast(`Reverted ${restored} file${restored === 1 ? '' : 's'}; ${warned} could not be restored`, 'error');
  } else {
    toast(`Reverted ${restored} file${restored === 1 ? '' : 's'}`, 'success');
  }
}
async function revertAutopilot() {
  if (!autopilotLastSession) { toast('No run to revert', 'error'); return; }
  const ok = await openConfirmDialog({
    title: 'Revert every change from this autopilot run?',
    bodyHtml: 'Husk will restore the workspace to the pre-run snapshot. Files the agent created will be removed. This cannot be undone from the UI.',
    confirmLabel: 'Revert all',
    cancelLabel: 'Keep changes',
  });
  if (!ok) return;
  const r = await window.husk.autopilot.revert(autopilotLastSession);
  if (!r || !r.ok) { toast((r && r.error) || 'Revert failed', 'error'); return; }
  reportRevertResult(r);
  closeAutopilotEndModal();
}
$('#btn-autopilot') && $('#btn-autopilot').addEventListener('click', () => {
  // While a run is active this button opens the run view. Stopping is the
  // explicit Stop button on the autopilot page.
  if (autopilotActive) { try { setPage('autopilot'); } catch (_) {} return; }
  openAutopilotStart();
});
$('#aut-start-close') && $('#aut-start-close').addEventListener('click', closeAutopilotStart);
$('#aut-start-cancel') && $('#aut-start-cancel').addEventListener('click', closeAutopilotStart);
$('#aut-start-go') && $('#aut-start-go').addEventListener('click', startAutopilot);
$('#aut-goal') && $('#aut-goal').addEventListener('input', () => $('#aut-goal').classList.remove('field-invalid'));
// Segmented mode control: Solo (one agent) or Team (orchestrated collab).
// Team shows its explainer; the orchestrator decides the team size, so there
// is no count to pick.
let autopilotStartMode = 'solo';
$('#aut-mode-seg') && $('#aut-mode-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('.aut-seg-btn');
  if (!btn) return;
  autopilotStartMode = btn.dataset.mode || 'solo';
  document.querySelectorAll('#aut-mode-seg .aut-seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
  const hint = $('#aut-mode-hint');
  if (hint) hint.hidden = autopilotStartMode !== 'collab';
});
// One click to zero every cap (0 = unlimited for that metric).
$('#aut-caps-unlimited') && $('#aut-caps-unlimited').addEventListener('click', () => {
  ['#aut-cap-min', '#aut-cap-tok', '#aut-cap-usd'].forEach((id) => { const el = $(id); if (el) el.value = '0'; });
  toast('All caps set to unlimited', 'info');
});
$('#aut-goto-projects') && $('#aut-goto-projects').addEventListener('click', () => {
  closeAutopilotStart();
  try { setPage('projects'); } catch (_) {}
});
$('#aut-end-close') && $('#aut-end-close').addEventListener('click', closeAutopilotEndModal);
$('#aut-end-close-foot') && $('#aut-end-close-foot').addEventListener('click', closeAutopilotEndModal);
$('#aut-end-revert') && $('#aut-end-revert').addEventListener('click', revertAutopilot);
$('#autopilot-start-modal') && $('#autopilot-start-modal').addEventListener('click', (e) => { if (e.target === $('#autopilot-start-modal')) closeAutopilotStart(); });
$('#autopilot-end-modal') && $('#autopilot-end-modal').addEventListener('click', (e) => { if (e.target === $('#autopilot-end-modal')) closeAutopilotEndModal(); });

try {
  if (window.husk && window.husk.autopilot) {
    window.husk.autopilot.onStarted((info) => {
      const runId = (info && info.runId) || null;
      const key = runId || '_solo';
      if (info && info.groupId) autopilotFleetId = info.groupId;
      else if (runId) autopilotFleetId = runId;
      const incomingDecision = runId ? autopilotModelDecisions.get(runId) : null;
      // Fresh dashboard when nothing is live: drop ended lanes and the
      // previous run's timeline before this one paints. A collab integrator
      // starts within its own group, so its ended workers are kept.
      if (shouldResetAutopilotForStarted(info)) {
        activeRuns.clear();
        autopilotTimeline = [];
        autopilotRunStart = 0;
        plannedAgents = [];
        finishedFleet = [];
        finishedFleetBeforeHistory = null;
        autopilotModelDecisions.clear();
        if (incomingDecision && runId) autopilotModelDecisions.set(runId, incomingDecision);
        autopilotState.eventCount = 0;
        const lanes = $('#aut-lanes');
        if (lanes) {
          // Keep the orchestrator's planning lane: for a collab start it
          // precedes the first started event and its narration belongs to
          // this run, not the previous one.
          lanes.querySelectorAll('.aut-lane:not([data-key="_orch"])').forEach((l) => l.remove());
          lanes.classList.remove('has-max');
          lanes.dataset.count = String(lanes.querySelectorAll('.aut-lane').length);
        }
      }
      const colorIdx = activeRuns.size % AP_LANE_COLORS;
      const planned = plannedAgents.find((p) => p.role === (info && info.role)) || null;
      const decision = (runId && autopilotModelDecisions.get(runId))
        || (planned && autopilotModelDecisions.get(planned.role))
        || planned
        || null;
      activeRuns.set(key, {
        runId, sessionId: info && info.sessionId, workspaceRoot: info && info.workspaceRoot,
        goal: info && info.goal, originalGoal: (info && info.originalGoal) || (info && info.goal) || null,
        fleetStartedAt: (info && info.fleetStartedAt) || null,
        role: (info && info.role) || null, groupId: (info && info.groupId) || null,
        startedAt: Date.now(), caps: null, budget: null, feed: [],
        model: decision && decision.model || null,
        tier: decision && decision.tier || null,
        reason: decision && decision.reason || null,
        colorIdx, files: [], state: 'starting', nudges: 0, lastTool: null, lastToolAt: 0, quietMs: 0,
        ended: false, endedOk: false,
      });
      if (!autopilotRunStart) autopilotRunStart = Date.now();
      plannedAgents = plannedAgents.filter((p) => p.role !== (info && info.role));
      if (!focusedRunId || !activeRuns.has(focusedRunId)) focusedRunId = key;
      autopilotActive = true;
      autopilotState.startedAt = activeRuns.get(key).startedAt;
      if (!autopilotLastSession && info) autopilotLastSession = { sessionId: info.sessionId, workspaceRoot: info.workspaceRoot };
      if (info && typeof info.originalGoal === 'string' && info.originalGoal) setAutopilotGoal(info.originalGoal);
      ensureLane(key);
      tlPush('start', `${laneTitleFor(key)} started`, colorIdx);
      paintAutopilotBanner();
      renderRunCards();
    });
    window.husk.autopilot.onEnded((sum) => {
      const runId = (sum && sum.runId) || null;
      const key = runId || focusedRunId || '_solo';
      const run = activeRuns.get(key);
      // groupPending: the collab team is still alive (siblings running, or
      // the integrator is spawning asynchronously). Keep this agent's lane
      // frozen in place with its conclusion instead of vanishing.
      const groupPending = !!(sum && sum.groupPending);
      if (run) {
        run.ended = true;
        run.endedOk = summaryCompletedSuccessfully(sum);
        run.endSummary = sum || null;
        if (sum && sum.modelObserved && !run.modelObserved) run.modelObserved = sum.modelObserved;
        tlPush('end', `${laneTitleFor(key)} ended (${(sum && sum.endReason) || 'ended'})`, run.colorIdx);
        if (groupPending || liveRunCount() > 0) {
          const items = [{ kind: 'status', text: `Run ended: ${(sum && sum.endReason) || 'ended'}.` }];
          if (sum && sum.finalMessage) items.push({ kind: 'thought', text: `Final report: ${String(sum.finalMessage).slice(0, 280)}` });
          laneAppend(key, items);
        }
        updateLaneHead(key);
      }
      autopilotActive = liveRunCount() > 0 || groupPending;
      if (autopilotActive) {
        if (key === focusedRunId) {
          const next = [...activeRuns.entries()].find(([, r]) => !r.ended);
          if (next) focusedRunId = next[0];
          runEndBanner(liveRunCount() === 0 && groupPending
            ? 'Team finished; the integrator is starting...'
            : `${laneTitleFor(key)} finished`, '');
        }
        paintAutopilotBanner();
        renderRunCards();
      } else {
        focusedRunId = null;
        if (sum && sum.ok) {
          const sid = (sum.sessionId) || (autopilotLastSession && autopilotLastSession.sessionId) || '';
          const wr = (sum.workspaceRoot) || (autopilotLastSession && autopilotLastSession.workspaceRoot) || '';
          // Snapshot the fleet's members before clearing so the receipt can
          // summarize every run that just finished (not only the last one).
          const fleetMembers = [...activeRuns.values()].map((r) => ({
            sessionId: r.sessionId || (r.endSummary && r.endSummary.sessionId) || null,
            agent: r.agent || (r.endSummary && r.endSummary.agent) || null,
            model: bestRunModel(r) || null,
            fleetStartedAt: r.fleetStartedAt || (r.endSummary && r.endSummary.fleetStartedAt) || null,
          })).filter((m) => m.sessionId);
          // A just-finished run retains its worktree, so this review offers
          // Apply/Discard rather than the snapshot-flow Revert.
          snapshotFinishedFleet();
          activeRuns.clear();
          plannedAgents = [];
          enterReviewMode({ sessionId: sid, workspaceRoot: wr, summary: sum, retained: true, runId });
          showFleetReceipt(fleetMembers);
          const halt = (sum.summary && sum.summary.haltReason) || 'natural';
          if (sum.endReason === 'agent_complete') runEndBanner('Run complete: goal declared finished', '');
          else if (sum.endReason === 'agent_blocked') runEndBanner('Run blocked: agent reported a blocker', 'stopped');
          else if (sum.endReason === 'agent_failed') runEndBanner('Run failed: agent reported failure', 'stopped');
          else if (sum.endReason === 'agent_unverified') runEndBanner('Run incomplete: completion was not verified', 'stopped');
          else if (sum.endReason === 'agent_startup_stall') runEndBanner('Run stopped: agent never got past startup', 'stopped');
          else if (halt === 'budget') runEndBanner('Run stopped at a budget cap', 'budget');
          else if (halt === 'stall') runEndBanner('Run stopped after stalling', 'stopped');
          else if (halt === 'user' || sum.endReason === 'user') runEndBanner('Run stopped', 'stopped');
          else if (halt === 'agent-exited') runEndBanner('Run ended: agent exited', 'stopped');
          else runEndBanner('Run complete', '');
        } else {
          snapshotFinishedFleet();
          activeRuns.clear();
          plannedAgents = [];
          paintAutopilotBanner();
        }
      }
      refreshAutopilotHistory();
    });
    window.husk.autopilot.onHalt((info) => {
      let why, level;
      if (info && info.cap) { why = `${info.cap} cap reached`; level = 'error'; }
      else if (info && info.reason === 'agent-exited') {
        // Name the exit code, so a clean quit and an unexpected exit read
        // differently.
        const code = (typeof info.exitCode === 'number') ? info.exitCode : null;
        why = code == null ? 'agent exited' : `agent exited (code ${code})`;
        level = (code && code !== 0) ? 'error' : 'info';
      } else { why = 'stopped'; level = 'error'; }
      toast(`Autopilot halted: ${why}`, level);
    });
    if (window.husk.autopilot.onSnapshotProgress) {
      window.husk.autopilot.onSnapshotProgress((info) => {
        const status = $('#aut-snapshot-status');
        if (!status || status.hidden) return;
        const n = Number(info && info.count) || 0;
        status.textContent = `Capturing workspace snapshot... ${n} files`;
      });
    }
    if (window.husk.autopilot.onActivity) {
      window.husk.autopilot.onActivity((info) => {
        if (!info || !Array.isArray(info.lines) || !info.lines.length) return;
        const runId = info.runId || null;
        const key = runId || '_solo';
        const run = activeRuns.get(key);
        if (run) {
          if (!Array.isArray(run.feed)) run.feed = [];
          run.feed.push(...info.lines.map((l) => String(l).slice(0, 320)));
          while (run.feed.length > AP_FEED_MAX_ROWS) run.feed.shift();
        }
        // Structured items from main (thought/tool/output); untagged status
        // lines are classified by their arrow prefix. EVERY lane streams
        // live; no focus gating.
        const items = Array.isArray(info.items) && info.items.length
          ? info.items
          : info.lines.map((l) => ({ kind: String(l).startsWith('→ ') ? 'tool' : 'status', text: String(l) }));
        laneAppend(key, items);
        // Lifecycle markers for the timeline, mined from status narration.
        for (const it of items) {
          if (it.kind !== 'status') continue;
          const t = it.text;
          if (/nudging to continue/i.test(t)) tlPush('nudge', `${laneTitleFor(key)}: nudged`, run && run.colorIdx);
          else if (/Goal delivered/i.test(t)) tlPush('goal', `${laneTitleFor(key)}: goal delivered`, run && run.colorIdx);
          else if (/declared the goal complete/i.test(t)) tlPush('done', `${laneTitleFor(key)}: declared complete`, run && run.colorIdx);
          else if (/Stop requested/i.test(t)) tlPush('stop', t, run && run.colorIdx);
        }
      });
    }
    if (window.husk.autopilot.onCollabPlan) {
      window.husk.autopilot.onCollabPlan((info) => {
        if (!info) return;
        if (info.groupId && autopilotFleetId && autopilotFleetId.startsWith('collab-') && info.groupId !== autopilotFleetId) return;
        if (info.groupId) autopilotFleetId = info.groupId;
        if (info.note) {
          pushActivity([info.note], '_orch');
          if (!info.cancelled) toast(info.note, 'info');
          if (info.role) plannedAgents = plannedAgents.filter((p) => p.role !== info.role);
          if (info.terminal) plannedAgents = [];
          // Notes can mean the team ended without an integrator (nothing to
          // integrate, or it failed to start). Re-derive live state so the
          // page cannot stay stuck in a runless "running" limbo.
          autopilotActive = liveRunCount() > 0 || plannedAgents.length > 0;
          paintAutopilotBanner();
          return;
        }
        const agents = Array.isArray(info.agents) ? info.agents : [];
        if (!activeRuns.size && !plannedAgents.length && !autopilotTimeline.length) {
          finishedFleet = [];
          finishedFleetBeforeHistory = null;
          autopilotModelDecisions.clear();
        }
        // Planned-but-not-started agents appear as queued chips in the
        // fleet strip until their started event replaces them.
        plannedAgents = agents.map((a) => ({ role: a.role, subgoal: a.subgoal, tier: a.tier, model: a.model, reason: a.reason }));
        for (const a of plannedAgents) {
          if (a.role) autopilotModelDecisions.set(a.role, { model: a.model, tier: a.tier, reason: a.reason });
        }
        // Persistent run-log entries, one per agent, explaining the model
        // choice. No toast -- the user wants a durable, readable record.
        const auto = agents.some((a) => a.autoSelected);
        // Name each agent's model in the headline so the persisted log reads
        // "decided 2 agents: Backend Auditor (haiku), Frontend Auditor (opus)".
        const roster = agents
          .map((a) => `${a.role} (${prettyModel(a.model) || a.tier || 'default'})`)
          .join(', ');
        tlPush('plan', `ORCHESTRATOR decided ${agents.length} agent${agents.length === 1 ? '' : 's'}`
          + `${roster ? ': ' + roster : ''}${auto ? ' (auto-selected)' : ''}`, 3);
        const lines = [`Planned ${agents.length} agent${agents.length === 1 ? '' : 's'}:`];
        for (const a of agents) {
          const detail = a.reason || `${a.tier} → ${prettyModel(a.model) || 'default'}`;
          tlPush('plan', `${a.role}: ${detail}`, 3);
          lines.push(`→ ${a.role}: ${detail}`);
        }
        pushActivity(lines, '_orch');
        renderRunCards();
      });
    }
    if (window.husk.autopilot.onOrchestrator) {
      window.husk.autopilot.onOrchestrator((info) => {
        if (!info || !info.reason) return;
        if (info.runId) autopilotModelDecisions.set(info.runId, { model: info.model, tier: info.tier, reason: info.reason });
        const key = info.runId && activeRuns.has(info.runId) ? info.runId : null;
        const run = key ? activeRuns.get(key) : null;
        if (run) {
          run.model = info.model || run.model || null;
          run.tier = info.tier || run.tier || null;
          run.reason = info.reason || run.reason || null;
        }
        tlPush('plan', `ORCHESTRATOR: ${info.reason}${info.autoSelected ? ' (auto-selected)' : ''}`, 3);
        pushActivity([info.reason], '_orch');
        renderRunCards();
      });
    }
    if (window.husk.autopilot.onBudget) {
      window.husk.autopilot.onBudget((b) => {
        const runId = (b && b.runId) || null;
        const key = runId || '_solo';
        const run = activeRuns.get(key);
        if (run) {
          run.budget = b;
          // Live telemetry riding the tick: coarse state, current tool,
          // nudge count. Drives the lane header and fleet chip.
          if (b.state) run.state = b.state;
          if (typeof b.nudges === 'number') run.nudges = b.nudges;
          if (typeof b.quietMs === 'number') run.quietMs = b.quietMs;
          if (b.lastTool !== undefined) { run.lastTool = b.lastTool; run.lastToolAt = b.lastToolAt || 0; }
          if (b.agent && !run.agent) run.agent = b.agent;
          if (b.modelObserved) run.modelObserved = b.modelObserved;
          if (b.modelId && !run.model) run.model = b.modelId;
          run.tokensPartialSeen = !!(run.tokensPartialSeen || b.tokensPartial);
          run.tokensApproxSeen = !!(run.tokensApproxSeen || b.tokensReported || b.tokensEstimated);
          if (run.tokensPartialSeen) run.budget.tokensPartial = true;
          if (run.tokensApproxSeen) run.budget.tokensReported = true;
          updateLaneHead(key);
        }
        if (!autopilotActive) return;
        renderUsageStripLive();
        renderTimeline();
        renderRunCards();
      });
    }
  }
} catch (_) {}

// Dedicated Autopilot page buttons. Start opens the start-run modal; Stop
// cancels the active run (SIGINT into the PTY via the IPC handler).
$('#aut-page-start') && $('#aut-page-start').addEventListener('click', () => {
  if (autopilotActive) { toast('A run is already active', 'info'); return; }
  openAutopilotStart();
});
$('#aut-page-stop-top') && $('#aut-page-stop-top').addEventListener('click', () => cancelAutopilot());
// Mission goal is clamped to a few lines; click toggles the full text.
$('#aut-page-goal-text') && $('#aut-page-goal-text').addEventListener('click', function () {
  this.classList.toggle('is-expanded');
});
$('#aut-jump-presets') && $('#aut-jump-presets').addEventListener('click', () => {
  const el = $('#aut-presets-section');
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Land on the gallery itself so the keyboard carries on from the first card.
  const first = el && el.querySelector('.aut-preset');
  if (first) first.focus();
});
$('#aut-diff-close') && $('#aut-diff-close').addEventListener('click', closeFileDiffModal);
$('#aut-diff-modal') && $('#aut-diff-modal').addEventListener('click', (e) => { if (e.target === $('#aut-diff-modal')) closeFileDiffModal(); });
$('#rc-close') && $('#rc-close').addEventListener('click', closeRaceCard);
$('#rc-copy') && $('#rc-copy').addEventListener('click', rcCopy);
$('#rc-save') && $('#rc-save').addEventListener('click', rcSave);
$('#race-card-modal') && $('#race-card-modal').addEventListener('click', (e) => { if (e.target === $('#race-card-modal')) closeRaceCard(); });
$('#aut-review-back') && $('#aut-review-back').addEventListener('click', exitReviewMode);
$('#aut-review-new') && $('#aut-review-new').addEventListener('click', () => {
  exitReviewMode();
  openAutopilotStart();
});
$('#aut-review-apply') && $('#aut-review-apply').addEventListener('click', async () => {
  const d = autopilotReviewData;
  if (!d || !d.retained || !d.runId) return;
  const fileCount = (d.summary && Array.isArray(d.summary.diff)) ? d.summary.diff.length : 0;
  const ok = await openConfirmDialog({
    title: 'Apply this run’s changes to your project?',
    bodyHtml: `Husk will copy ${fileCount} changed file${fileCount === 1 ? '' : 's'} from this run’s isolated worktree into your working directory, then remove the worktree. Review the diff first if you have not.`,
    confirmLabel: 'Apply changes',
    cancelLabel: 'Not yet',
  });
  if (!ok) return;
  const r = await window.husk.autopilot.applyRun({ runId: d.runId });
  if (!r) { toast('Apply failed', 'error'); return; }
  const applied = (r.applied || []).length;
  const failed = (r.failed || []).length;
  if (failed) {
    toast(`Applied ${applied} file${applied === 1 ? '' : 's'}; ${failed} failed: ${(r.failed[0] && r.failed[0].path) || ''}${failed > 1 ? ' and others' : ''}`, 'error');
  } else {
    toast(`Applied ${applied} file${applied === 1 ? '' : 's'} to your project`, 'success');
  }
  exitReviewMode();
});
$('#aut-review-discard') && $('#aut-review-discard').addEventListener('click', async () => {
  const d = autopilotReviewData;
  if (!d || !d.retained || !d.runId) return;
  const ok = await openConfirmDialog({
    title: 'Discard this run?',
    bodyHtml: 'The run’s isolated worktree and all changes it made will be removed. Your working directory is left untouched. This cannot be undone.',
    confirmLabel: 'Discard run',
    cancelLabel: 'Keep',
  });
  if (!ok) return;
  const r = await window.husk.autopilot.discardRun({ runId: d.runId });
  if (!r || !r.ok) { toast((r && r.error) || 'Discard failed', 'error'); return; }
  toast('Run discarded', 'success');
  exitReviewMode();
});
$('#aut-review-rerun') && $('#aut-review-rerun').addEventListener('click', () => {
  if (!autopilotReviewData) return;
  // The real goal and caps come from the start_run row on the summary
  // payload, not from the display string in autopilotState.goal.
  const summary = autopilotReviewData.summary;
  const sumPayload = summary && summary.summary;
  const goal = (summary && typeof summary.goal === 'string' && summary.goal) || null;
  const caps = (summary && summary.caps) || (sumPayload && sumPayload.meter && sumPayload.meter.caps) || null;
  if (!goal) { toast('That run has no goal text to rerun', 'error'); return; }
  rerunFromPastRun({ goal, caps });
});
$('#aut-review-revert') && $('#aut-review-revert').addEventListener('click', async () => {
  if (!autopilotReviewData) return;
  const ok = await openConfirmDialog({
    title: 'Revert every change from this autopilot run?',
    bodyHtml: 'Husk will restore the workspace to the pre-run snapshot. Files the agent created will be removed. This cannot be undone from the UI.',
    confirmLabel: 'Revert all',
    cancelLabel: 'Keep changes',
  });
  if (!ok) return;
  const r = await window.husk.autopilot.revert({
    sessionId: autopilotReviewData.sessionId,
    workspaceRoot: autopilotReviewData.workspaceRoot,
  });
  if (!r || !r.ok) { toast((r && r.error) || 'Revert failed', 'error'); return; }
  reportRevertResult(r);
  // Refresh the live diff view from disk so it reflects the revert.
  if (autopilotReviewData) {
    const sum = await window.husk.autopilot.summary({
      sessionId: autopilotReviewData.sessionId,
      workspaceRoot: autopilotReviewData.workspaceRoot,
    });
    if (sum && sum.ok) enterReviewMode({ ...autopilotReviewData, summary: sum });
  }
});

// Global Esc handler: closes any visible `.modal` element, so every dialog gets
// the same dismissal without per-dialog wiring. Per-modal handlers run first,
// and composition events are skipped so an IME's own Esc keeps working. The
// workflow-artifact dialogs close through their own modules, looked up at press
// time; a missing closer falls through to the generic path.
const wfxCloser = (modalId, namespace, fn) => () => {
  const mod = window[namespace];
  if (mod && typeof mod[fn] === 'function') { mod[fn](); return; }
  const m = document.getElementById(modalId);
  if (m) m.hidden = true;
};
const MODAL_CLOSERS = {
  'agent-map': closeAgentMap,
  'agent-modal': closeAgentModal,
  'agents-import-modal': closeAgentsImportModal,
  'repo-agents-modal': closeRepoAgentsModal,
  'wfx-install-modal': wfxCloser('wfx-install-modal', 'WfxInstall', 'close'),
  'wfx-publish-modal': wfxCloser('wfx-publish-modal', 'WfxPublish', 'close'),
  'wfx-consent-modal': wfxCloser('wfx-consent-modal', 'WfxArtifactUi', 'closeConsentGate'),
};
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  let open = $$('.modal:not([hidden])');
  // The autopilot wizard is locked while a run is launching; Esc must not
  // tear it down mid-capture.
  if (autopilotStarting) open = open.filter((m) => m.id !== 'autopilot-start-modal');
  if (!open.length) return;
  // DOM order is install order, so the last visible dialog is the most
  // recently opened. Closing just that one dismisses a confirm before its
  // parent.
  const top = open[open.length - 1];
  // A dialog that holds state of its own closes through its own closer, so a
  // pending draft, a status line and a cancel token are all torn down.
  const closer = MODAL_CLOSERS[top.id];
  if (closer) closer(); else top.hidden = true;
});

requestAnimationFrame(() => boot());
