// Husk renderer orchestrator.
// Pages: chat, skills, sessions, files, preferences.
// Includes: command palette, theme toggle, drag overlay, status panel.

const $ = (s) => document.querySelector(s);
// Optional root scopes the query (onboarding passes its overlay so its
// selectors cannot leak matches from the rest of the document).
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// ─── Notifications ─────────────────────────────────────────────────────────
// A top-center stack of independent cards. Each slides in, auto-dismisses
// (errors linger longer), pauses on hover, and can be dismissed by hand.
// Newest sits on top; the stack is capped so a burst cannot bury the UI.
const NOTIF_MAX = 4;
const NOTIF_TTL = { error: 6500, warn: 5500, success: 4000, info: 4000, '': 4000 };
// Icon path sets (stroke, 24x24 viewBox). Built with createElementNS so no
// markup is injected as a string.
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
// that card in place instead of stacking another one, so a value the user is
// stepping through (zoom, volume) reads as one readout that keeps changing.
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
  // Remove the entrance class so the card transitions in. rAF gives clean
  // first-paint timing on a real display; the setTimeout is a guarantee so
  // the card never stays stuck hidden if rAF is starved (background window).
  const reveal = () => card.classList.remove('is-enter');
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 60);
  // Cap the stack: drop the oldest beyond the limit. dismissNotif animates the
  // card out and removes it asynchronously, so it does not shrink
  // stack.children synchronously. Iterate a snapshot of live (not-already-
  // dismissing) cards, oldest first, so each pass acts on a distinct card and
  // the loop always terminates.
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
// Re-use a keyed card: swap the text, the kind and the icon, restart the
// countdown, and pulse once so a changed value is noticed without the card
// moving or re-entering.
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
// Changes to skills, plugins and MCP only reach a session when it starts, and
// the pages that make those changes have no terminal of their own. The notice
// that asks for a restart carries the restart, so the instruction is something
// the reader can act on where they are standing.
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
// Reusable destructive-action confirmation. Replaces the two-click "is-armed"
// pattern with a proper modal that names what is about to be deleted. Returns
// a promise that resolves true on confirm, false on cancel/escape/backdrop.
function openConfirmDialog({ title = 'Are you sure?', bodyHtml = '', confirmLabel = 'Delete', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-title');
    const bodyEl = document.getElementById('confirm-body');
    const okBtn = document.getElementById('confirm-ok');
    const cancelBtn = document.getElementById('confirm-cancel');
    if (!modal || !titleEl || !bodyEl || !okBtn || !cancelBtn) {
      // Fallback when the modal elements are not in the DOM (early boot
      // race). window.confirm displays plain text, so extract the text
      // content of bodyHtml via DOMParser, which parses into a fresh
      // inert document (no resource loads, no scripts). textContent on
      // the parsed body collapses the markup to its text nodes.
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
    modal.hidden = false;
    setTimeout(() => { try { okBtn.focus(); } catch (_) {} }, 30);

    const cleanup = (result) => {
      modal.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      else if (e.key === 'Enter') cleanup(true);
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
const VALID_PAGES = new Set(['chat', 'agents', 'workflows', 'autopilot', 'projects', 'prompts', 'skills', 'sessions', 'files', 'mcp', 'plugins']);
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

function applyPageShell(name) {
  const page = normalizePageName(name);
  document.body.dataset.page = page;
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== page; });
  $$('.rail-item').forEach((it) => it.classList.toggle('active', it.dataset.page === page));
}
applyPageShell(currentPage);

// ─── Tabs: one PTY-backed terminal per chat tab, all live in parallel ────────
// Each tab owns its own xterm instance + FitAddon + DOM pane, keyed by the
// sessionId shared with the main process. Only the active pane is shown; the
// rest keep running and retain full scrollback. `term` / `fitAddon` are
// re-pointed to the active tab so every terminal-bound handler below (input,
// copy/paste, wheel, recap, speech, fit) keeps working unchanged.
const TABS = new Map();
let activeTabId = null;
let tabSeq = 0;
let term = null;
let fitAddon = null;

// Route every URL click through the OS browser via shell.openExternal,
// gated by Husk's own confirm dialog so the user sees the destination
// before leaving the app. Two paths need to be covered:
//   - WebLinksAddon: regex-detected plain-text URLs in TUI output
//   - term.options.linkHandler: OSC 8 hyperlinks emitted by the agent
//     as terminal escape codes
// Both handlers must return a truthy value so xterm's internal
// `result || defaultConfirmAndOpen` fallback does not fire. The
// confirm runs asynchronously; we return true immediately.
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
  t.open(el);
  const tab = {
    id, term: t, fitAddon: fa, el,
    mouseOn: false, chatHasInput: false, restarting: false,
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
  // Refresh the status panel for the newly focused tab. The main process must
  // switch the active session FIRST so stats:get resolves THIS tab's
  // transcript, then we fetch fresh stats (not the previous tab's cached
  // numbers) and render.
  Promise.resolve(window.husk.pty.setActive(id))
    .then(() => refreshStats())
    .then(() => refreshStatusline())
    // The agent count is scoped to the active chat's directory, so it is only
    // right once the main process knows which chat that is.
    .then(() => refreshTopbarAgents())
    .catch(() => {});
}

// Wheel forwarding for full-screen agents. A TUI like copilot runs in the
// alternate screen (no terminal scrollback) and turns mouse reporting on so it
// can scroll its OWN transcript. Husk strips that reporting upstream so
// drag-to-select stays local, which also stops the agent from receiving the
// wheel. So when the agent has reporting on, forward only the wheel to it as
// scroll input; otherwise let xterm scroll its scrollback normally. Capture
// phase + passive:false so we intercept before xterm and can preventDefault.
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

// Auto-scroll while drag-selecting. xterm only scrolls the viewport once the
// pointer leaves the screen element: anywhere inside it the scroll amount is
// zero, so holding at the top of a terminal that fills its pane selects nothing
// further. Treat a band at each edge as if the pointer were already outside by
// re-sending the move with a clamped Y. xterm then runs its own drag-scroll,
// which extends the selection as it scrolls; a plain scrollLines call moves
// the viewport but leaves the selection behind.
// Which scroller moves depends on the agent. A TUI that draws its own viewport
// (it prints its own jump-to-bottom hint and turns mouse reporting on) keeps no
// terminal scrollback, so xterm has nothing to scroll and only wheel input the
// agent understands moves it. Everything else scrolls xterm's own scrollback.
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
  // Prefer xterm's own scroller whenever it has somewhere to go: only xterm
  // grows the selection as it scrolls. Forwarding to the agent instead makes it
  // repaint the screen, which xterm never hears about, so the selection keeps
  // its old anchor and the marked text scrolls out of the buffer entirely.
  // The alternate screen a full-screen TUI runs in holds no scrollback, so
  // there the agent is the only thing that can move.
  const buf = term.buffer.active;
  const xtermCanScroll = buf.type === 'normal'
    && (selEdge.dir < 0 ? buf.viewportY > 0 : buf.viewportY < buf.baseY);
  if (!xtermCanScroll && agentMouseOn) {
    // Agent owns the viewport: hand it wheel input, the same path the wheel
    // listener above uses, so it redraws one step further back.
    const cw = r.width / term.cols || 1;
    const ch = r.height / term.rows || 1;
    let col = Math.floor((selEdge.x - r.left) / cw) + 1;
    let row = Math.floor((selEdge.y - r.top) / ch) + 1;
    col = Math.min(Math.max(col, 1), term.cols);
    row = Math.min(Math.max(row, 1), term.rows);
    window.husk.pty.wheel({ deltaY: selEdge.dir * 120, deltaMode: 0, col, row }, activeTabId);
    return;
  }
  // Already past the edge: xterm scrolls on its own there, so leave it alone
  // rather than driving it twice as fast.
  if (selEdge.y < r.top || selEdge.y > r.bottom) return;
  // xterm owns the scrollback: its drag-scroll amount is zero for any pointer
  // inside the screen, so feed it one that reads as outside. Going through
  // xterm keeps the selection growing as it scrolls; scrollLines would move the
  // viewport and leave the selection behind.
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

// Capture phase: the drag must be registered even if something downstream
// stops the event from bubbling.
$('#terminal').addEventListener('mousedown', (e) => { if (e.button === 0) selDragging = true; }, true);
window.addEventListener('mouseup', () => { selDragging = false; selEdgeStop(); });
document.addEventListener('mousemove', (e) => {
  if (!selDragging || selSynthetic) return;
  const tab = TABS.get(activeTabId);
  const screen = tab && tab.el.querySelector('.xterm-screen');
  if (!screen) { selEdgeStop(); return; }
  const r = screen.getBoundingClientRect();
  const y = e.clientY;
  // Open-ended on purpose: dragging "to the top" usually overshoots past the
  // terminal into the tab strip above it. Anything at or beyond each edge keeps
  // scrolling, which is what a text editor does.
  let dir = 0;
  if (y < r.top + DRAG_EDGE_PX) dir = -1;
  else if (y > r.bottom - DRAG_EDGE_PX) dir = 1;
  if (!dir) { selEdgeStop(); return; }
  selEdge = { x: e.clientX, y, dir };
  if (!selEdgeTimer) selEdgeTimer = setInterval(selEdgeTick, DRAG_EDGE_MS);
});

function themeForXterm() {
  // The terminal runs a TUI agent that themes its output through the 16 ANSI
  // colors. The canvas background/foreground come from the active theme's
  // --term-bg / --term-fg tokens (so any theme's terminal matches the chrome),
  // and the ANSI set is the light or dark one depending on --term-light. Read
  // after body[data-theme] is set.
  const cs = getComputedStyle(document.body);
  const accent = cs.getPropertyValue('--accent').trim() || '#ff7847';
  const isLight = cs.getPropertyValue('--term-light').trim() === '1';
  const bg = cs.getPropertyValue('--term-bg').trim() || (isLight ? '#ffffff' : '#0c0a09');
  const fg = cs.getPropertyValue('--term-fg').trim() || (isLight ? '#1f2328' : '#e6e9ef');
  const ansi = isLight
    ? {
        // Dark, saturated colors readable on a light background. The dim greys
        // agents use for hints (brightBlack) become a mid grey, not near-white.
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

// An agent CLI has no way to learn the terminal went light, so it keeps
// emitting colours chosen for a dark background: pale greys for diff context
// and, for some tokens, outright white. Those turn invisible on a light
// terminal. Remapping the sixteen ANSI slots cannot help, because the text
// arrives as 256-colour and truecolour codes that name their colour outright.
// xterm re-tones any foreground that falls under this ratio against the real
// background, which reaches those codes too. Dark themes already contrast, so
// they keep xterm's default of 1 (off) and render exactly as before.
function contrastForXterm() {
  return getComputedStyle(document.body).getPropertyValue('--term-light').trim() === '1' ? 4.5 : 1;
}

function fitNow() {
  if (currentPage !== 'chat') return;
  if (!fitAddon || !term) return;
  // Skip while the terminal is not actually laid out (e.g. the chat page was
  // just revealed and the container has not been sized yet). Fitting against a
  // zero-size box yields a degenerate resize.
  const host = term.element;
  if (host && (host.clientWidth === 0 || host.clientHeight === 0)) return;
  try {
    fitAddon.fit();
    const { cols, rows } = term;
    if (!cols || !rows) return;
    const tab = TABS.get(activeTabId);
    // Only resize the PTY when the geometry actually changed. A redundant
    // resize makes the agent's TUI redraw and drop any unsent text in its
    // input line, which otherwise happens every time you leave the chat page
    // and come back at the same window size.
    if (tab && tab._cols === cols && tab._rows === rows) return;
    if (tab) { tab._cols = cols; tab._rows = rows; }
    window.husk.pty.resize({ cols, rows }, activeTabId);
  } catch (_) {}
}
// Refit on resize. A trailing debounce coalesces the rapid resize burst
// from a window drag into one fit so the terminal reflow stays smooth.
window.addEventListener('resize', debounce(fitNow, 80));
// Refit whenever the terminal container changes size, not only on a window
// 'resize'. The container can reach its final height after the first paint
// (fonts/layout settling) and on sidebar/status-panel toggles, so observing it
// keeps the terminal sized to its container, including the initial render.
try {
  const _termFitObserver = new ResizeObserver(debounce(fitNow, 80));
  const _termEl = $('#terminal');
  if (_termEl) _termFitObserver.observe(_termEl);
} catch (_) {}

// Copy / paste affordances for the embedded terminal.
//   - Right-click on the terminal opens a small Copy / Paste / Select all menu.
//   - Ctrl+Shift+C (macOS: Cmd+C) copies the selection.
//   - Paste is handled natively: xterm already listens for the browser `paste`
//     event on its hidden textarea and routes the clipboard through onData.
//     We do NOT also call term.paste() from a custom key handler, because the
//     browser fires the native paste event independently and that would double
//     every paste. Ctrl+C is intentionally left as SIGINT.
const isMac = (navigator.userAgentData && navigator.userAgentData.platform === 'macOS') ||
              /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
// Mark the platform so CSS can clear the macOS traffic-light controls, which
// overlay the top-left of the window under the hiddenInset title bar.
if (isMac) document.documentElement.setAttribute('data-platform', 'mac');

// The command macOS users run to clear the quarantine flag on the unsigned app
// so Gatekeeper will open it (we have no Apple Developer ID yet).
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
  // Exact match only. A packaged release reports its real version (e.g. 2.8.4)
  // and matches; running from source reports Electron's version, which has no
  // entry, so the page never shows in dev or e2e and cannot cover the UI.
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
// Clone Kernel into an empty-state stage, posed peeking from the open pod with
// an idle blink and a wiggle+spark that lands as the page's prop animation
// loops, so he reads as "doing" the task rather than just sitting there. Ids are
// re-prefixed per mount so clones never collide with the onboarding original or
// each other. Returns an unmount fn that stops the timers.
let emptyKernelSeq = 0;
function mountEmptyKernel(slot) {
  const src = $('#ob-kernel');
  if (!src || !slot) return null;
  const prefix = `ek${++emptyKernelSeq}`;
  const markup = src.outerHTML
    .replaceAll('id="hk-', `id="${prefix}-`)
    .replaceAll('url(#hk-', `url(#${prefix}-`)
    .replace('id="ob-kernel"', '');
  // eslint-disable-next-line no-unsanitized/property -- own static SVG markup, id-prefixed
  slot.innerHTML = markup;
  const hk = slot.querySelector('svg');
  if (!hk) return null;
  hk.removeAttribute('style');
  // Bare, static Kernel: just the seed character, no pod/husk shell and no idle
  // motion (CSS `.is-bare` hides the shell and disables animation). The viewBox
  // is retightened around the seed so the hidden shell leaves no gap below him.
  hk.className.baseVal = 'hk is-bare';
  hk.setAttribute('viewBox', '40 -14 120 176');
  return null;
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
      // The last slide's own button finishes, so Skip would be a second way to
      // do the same thing.
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
    // Clicking a menu button pulled focus out of the terminal. Return it so
    // the user can keep typing without clicking back into the chat.
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
// synchronous disk write in the main process; spamming it (e.g. clicking
// the theme toggle or accent swatches fast) floods the main thread and
// freezes the UI. Apply the change optimistically to the local cfg and the
// DOM, then write once the clicks settle. The final merged patch wins.
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
// Every theme/accent/rail change applies to the DOM immediately (so themes can
// be browsed freely) and accumulates in pendingAppearance; Save persists the
// merged patch, Revert (or navigating away from Preferences) restores the
// saved appearance.
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
    // Refresh with the same semantics as the Ctrl+R shortcut
    // (refreshFromShortcut): on the chat page restart the agent so the
    // conversation keeps running; every other page gets the full renderer
    // reload.
    if (currentPage === 'chat') {
      bindPrefs();
      syncAppearanceActionsBar();
      closePrefsModal();
      await restartPty();
    } else {
      reloadRendererPreservingPlace();
    }
    return;
  } catch (err) {
    restoreAppearanceSnapshot(appearanceSnapshot());
    toast(`Could not save appearance: ${(err && err.message) || err}`, 'error');
  }
  bindPrefs();
  syncAppearanceActionsBar();
}

// Coalesce a tab's PTY output into one xterm write per animation frame. A
// chatty agent emits many chunks in quick succession, and each separate write
// costs its own scroll callback and speech scan. Buffering to the next frame
// collapses a burst into a single write, scroll, and speech scan. Each tab owns
// its own buffer so a background agent's output never bleeds into another.
function _flushTabWrite(tab) {
  tab.flushScheduled = false;
  if (!tab.writeBuf) return;
  const data = tab.writeBuf;
  tab.writeBuf = '';
  const t = tab.term;
  // Follow the tail only when the user is already pinned to the bottom. If they
  // scrolled up to read while the agent is still streaming, leave the viewport
  // where it is instead of yanking it back down on every chunk. (In the alt
  // screen there is no scrollback, so viewportY/baseY are both 0 and this stays
  // pinned -- copilot's own wheel-forwarded scrolling is unaffected.)
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

async function closeRejectedResumeTab(tab) {
  if (!tab || !tab.resumeAttempt || tab.resumeAttempt.failureHandled) return;
  tab.resumeAttempt.failureHandled = true;
  tab.restarting = true;
  tab.writeBuf = '';
  const agent = tab.resumeAttempt.agent || 'session';
  const id = tab.resumeAttempt.id ? ` ${String(tab.resumeAttempt.id).slice(0, 8)}` : '';
  const header = tab.resumeAttempt.previousHeader || null;
  if (header) {
    if (Object.prototype.hasOwnProperty.call(header, 'chatSub') && $('#chat-sub')) $('#chat-sub').textContent = header.chatSub;
    if (Object.prototype.hasOwnProperty.call(header, 'spAgent') && $('#sp-agent')) $('#sp-agent').textContent = header.spAgent;
    if (Object.prototype.hasOwnProperty.call(header, 'spSessionId') && $('#sp-session-id')) $('#sp-session-id').textContent = header.spSessionId;
  }
  toast(`${agent}${id} is not resumable yet; refreshed sessions`, 'error');
  await closeTab(tab.id);
  try { await refreshRecentList(); } catch (err) { console.warn('recent refresh after rejected resume failed', err); }
  if (currentPage === 'sessions') {
    try { await renderSessions(); } catch (err) { console.warn('sessions refresh after rejected resume failed', err); }
  }
}

function captureResumeFailure(tab, data) {
  if (!tab || !tab.resumeAttempt || tab.resumeAttempt.failureHandled) return false;
  const age = Date.now() - (tab.resumeAttempt.startedAt || 0);
  if (age > 20000) { tab.resumeAttempt = null; return false; }
  tab.resumeAttempt.tail = ((tab.resumeAttempt.tail || '') + String(data || '')).slice(-4096);
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
  // Suppress the exit notice when we're tearing this tab's PTY down on
  // purpose, otherwise the line stitches into the new PTY's welcome banner.
  if (!tab || tab.restarting) return;
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

// After a renderer reload the main-process PTYs are still alive but the renderer
// lost its tabs. Rebuild the open chats instead of orphaning them and minting a
// fresh one. For an agent session we can resume (claude), we close the orphaned
// PTY and reopen the SAME conversation with --resume, which re-renders the full
// history cleanly (a scrolling TUI cannot have its scrollback restored by
// keeping the process alive). For agents without a resume path we keep the live
// process and reattach to it. Returns true if any chat was restored.
async function reattachSessions() {
  let live;
  try { live = await window.husk.pty.list(); } catch (_) { live = null; }
  if (!live || !live.ok || !Array.isArray(live.sessions) || !live.sessions.length) return false;
  $('#chat-empty').classList.remove('show');
  const agent = (cfg && cfg.agentCommand ? cfg.agentCommand : 'claude').trim().split(/\s+/)[0].toLowerCase();
  let activeTab = null;
  for (const sess of live.sessions) {
    let tab = null;
    // Only close-and-resume when the active agent actually has a resume
    // form; otherwise the live PTY is kept and reattached below. Closing
    // first and failing to resume would destroy a healthy session.
    let resumeCmd = null;
    // Only resume when the transcript still exists. Resuming a session that was
    // never written (claude exited 0 without a conversation) surfaces the
    // "No conversation found with session ID" error and a dead tab.
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
  await window.husk.pty.start({ cols, rows, sessionId: tab.id, resumeLast: false });
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
  await window.husk.pty.start({ cols, rows, command: opts.command || null, cwd: opts.cwd || null, sessionId: tab.id, env: opts.env || null });
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
  await window.husk.pty.restart({ cols, rows, command: opts.command || null, cwd: opts.cwd || null, sessionId: tab.id });
  // Let the dying PTY drain its tail notice into the (suppressed) handlers
  // before we re-enable output. Claude's welcome banner takes >300ms to
  // produce, so a 200ms quiet window does not cut into it.
  await new Promise((r) => setTimeout(r, 200));
  // Second wipe: clears anything that wrote to the buffer despite suppression
  // (e.g. xterm internal sequences from the kill), so the new PTY's banner
  // starts on a clean canvas.
  try { tab.term.reset(); } catch (_) {}
  tab.restarting = false;
  // Respect the "Don't show this on next launch" toggle on restart too;
  // otherwise the welcome briefly flashes in (added here) and out again
  // (stripped by the first pty.onData tick once the new agent banner
  // arrives), which reads as a layout glitch.
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

// Close one chat tab and reap its agent. The window never ends up with no chat
// in it: closing the last one opens a fresh chat behind it. That is a new
// session with a new name, not the old one restarted in place, so the chat the
// user just closed does not stay on screen under its old title.
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

// Type `full` into `el` character by character. The element must already hold
// its final state elsewhere (data/attributes): if this animation is
// interrupted by a repaint, the repaint simply shows the full text.
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
  strip.classList.toggle('multi', tabs.length >= 1);
}

// Link each tab to the agent session it spawned, so a saved custom name can be
// restored and future renames persisted.
//
// A tab is probed while it has no session, and also while the session it landed
// on is provisional. Some CLIs create a session directory at launch and only
// write to it once the conversation starts, so the first match can be an empty
// directory left behind by an abandoned chat. That session never earns a name,
// so a binding frozen on it leaves the tab showing the pending dots forever.
// Re-probing lets the tab move across to the real session once it appears.
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

// Adopt a generated session name for a tab. State first, full repaint second
// (so the name is already correct even if the animation is interrupted), then
// the typewriter reveal plays over the freshly painted label.
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
// the Sessions and Recent lists once the conversation earns a name (e.g. the
// agent summarizes it). A user rename (customTitle) always wins and opts the
// tab out. The first earned name types itself in; later refinements swap
// silently through the repaint inside adoptTabTitle.
async function syncTabTitles() {
  for (const tab of TABS.values()) {
    if (!tab.agentId || tab.customTitle) continue;
    try {
      const res = await window.husk.sessions.resolveLiveTitle({ knownAgentId: tab.agentId });
      if (!res || !res.ok) continue;
      // Track this every poll: once the bound session stops being provisional the
      // tab stays put, and while it still is, linkTabs keeps looking for the real one.
      tab.agentIdProvisional = !!res.provisional;
      if (!res.title) continue;
      if (res.custom) {
        tab.customTitle = res.title; tab.titleEarned = true; renderTabStrip();
        continue;
      }
      // Only a name the CLI generated counts; the first user message echoed
      // back as a title does not, so the dots keep breathing until then.
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
  // Light/dark FAMILY flag, derived from the theme's --term-light token. The
  // chrome glass treatment (frosted topbar/rail/status/modals) is gated on
  // data-mode, not data-theme, so every dark-family theme (dark, midnight,
  // nord, dracula) gets it and every light-family theme (light, sepia) gets
  // the solid treatment. New themes are handled automatically by their token.
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
// Page visit history: every page change is a navigation entry, so the
// mouse back/forward buttons and Alt+arrows walk pages exactly like a
// browser walks documents. Programmatic back/forward passes _nav so it
// does not re-record itself.
let pageHistory = [];
let pageForwardStack = [];
// The palette badge shows the chord this platform actually uses.
{
  const pal = document.getElementById('btn-palette');
  if (pal && !/mac/i.test(navigator.platform)) pal.textContent = 'Ctrl+K';
}

function setPage(name, opts = {}) {
  name = normalizePageName(name);
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
}

// Only rail items that name a page navigate; the Preferences gear (no
// data-page) opens its modal over whatever page is currently shown.
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

// Untrusted-folder banner. Claude ignores a workspace's saved permissions until
// the folder is trusted, warning on every launch. Show an explicit, one-click
// "Trust this folder" action (Claude only); never set trust silently.
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
// The collapsed rail draws its own styled tooltip (.rail-item::after, fed by
// aria-label). Move each item's `title` to `aria-label` and drop the title so
// the native OS tooltip does not render a second, duplicate label on hover.
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
    // Sessions subheader is refined by renderSessions once the active agent's
    // sessions are read. This is a hint until that happens, and it stands down
    // afterwards: stats refresh on their own schedule, and overwriting the
    // detailed line drops the count of Autopilot sessions kept out of the list.
    if (!sessionsSubOwned) {
      const agentNow = (cfg && cfg.agentCommand ? cfg.agentCommand : 'claude').trim().split(/\s+/)[0];
      $('#sessions-sub').textContent = `${agentNow} sessions · click to preview, Resume to continue`;
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

// ─── PAI-style context meter ───────────────────────────────────────────────────
// Port of statusline-command.sh get_bucket_color: a 4-stop linear gradient
// green(74,222,128) -> yellow(250,204,21) -> orange(251,146,60) -> red(239,68,68).
// `pos` is a 0-100 position ALONG the bar, so the bar itself reads green->red.
function ctxBucketColor(pos) {
  const p = Math.max(0, Math.min(100, pos));
  let r, g, b;
  if (p <= 33) { r = 74 + (250 - 74) * p / 33; g = 222 + (204 - 222) * p / 33; b = 128 + (21 - 128) * p / 33; }
  else if (p <= 66) { const t = p - 33; r = 250 + (251 - 250) * t / 33; g = 204 + (146 - 204) * t / 33; b = 21 + (60 - 21) * t / 33; }
  else { const t = p - 66; r = 251 + (239 - 251) * t / 34; g = 146 + (68 - 146) * t / 34; b = 60 + (68 - 60) * t / 34; }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}
// Build the discrete block meter. Filled cells take their gradient color from
// their own position along the bar; trailing cells are the dim empty marker.
// Friendly model name for the status readout. The banner the CLI prints
// ("Opus 4.8") is its own text; here we derive the same shape from the model
// id. Strip the tier suffix ("[1m]") and vendor prefix ("claude-"), then split
// the rest into family + version. Bare aliases from settings.json ("opus",
// before any transcript turn names the full "claude-opus-4-8[1m]") carry no
// version, so they render capitalized ("Opus") and upgrade to "Opus 4.8" once
// the session resolves the full id. Date stamps (6+ digits) are dropped.
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
  if (p >= 60) return 'rgb(251,146,60)';
  if (p >= 40) return 'rgb(251,191,36)';
  return 'var(--emerald)';
}

async function refreshStatusline() {
  if (!lastStats) return;
  const s = lastStats;
  const here = (s.location && s.location.city) || '';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Timezone is always available locally via Intl, no network. We fall back to
  // it as the WHERE headline whenever IP geolocation didn't resolve to a city
  // (common on Windows / corporate networks / VPNs / offline). Honest UX: show
  // what we know, never blank a section.
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
  // Stabilize the context reading. A poll taken while the agent is mid-turn can
  // transiently return no session or ctxTokens===0 (the newest-by-mtime
  // transcript momentarily being a sidechain/fresh file, or a tail read landing
  // before the next usage record). Without this the whole Context Window block
  // flickers out and back. Cache the last good reading and fall back to it; a
  // real change overwrites it on the next good poll, and activateTab() clears it
  // on a session switch so we never show a stale cross-session number.
  if (u.session && u.session.ctxTokens > 0) lastGoodCtx = u.session;
  // Context window is a Claude-session figure; for any other agent, do not
  // fall back to a Claude session's cached ctx.
  const ctx = agentKindCache !== 'claude'
    ? null
    : ((u.session && u.session.ctxTokens > 0) ? u.session : lastGoodCtx);
  // The active model. Trim the vendor prefix and the context-tier suffix so the
  // readout stays compact and matches the banner (e.g. "fable-5", not
  // "claude-fable-5[1m]"). Empty when no model is known, which hides the row.
  // The model comes from the active agent's OWN session transcript
  // (claude from ~/.claude, copilot from ~/.copilot), so it always names
  // the agent's real model, never a different CLI's session. The ctx
  // fallback is claude-only (context window is a claude-transcript figure).
  // The CLI's own name for the model wins when the catalog has been read: an
  // id-derived name can only print what the id spells out, so a bare alias
  // renders without its version. Falls back to the derived name until then.
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
        ${mcp.supported ? `<div class="sp-row sp-clickable" data-open="mcp"><span class="sp-muted">MCP ${spInfo('MCP servers configured for the active agent. Click to open the MCP page.')}</span><span class="sp-mono sp-accent">${escapeHtml(mcp.count)}</span></div>` : ''}
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

// Scale the status stack down when it would overflow the space between the
// head and foot border lines, so the panel never scrolls and every section
// stays visible at any window height. The wrapper keeps its layout height;
// the flex centering on #sp-content splits the overflow evenly, so the
// scaled copy sits centered between the two border lines.
function fitStatusContent() {
  const box = $('#sp-content');
  const fit = $('#sp-fit');
  if (!box || !fit) return;
  fit.style.transform = '';
  const cs = getComputedStyle(box);
  const avail = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (avail <= 0) return; // panel collapsed or not laid out yet
  const need = fit.scrollHeight;
  if (need > avail) fit.style.transform = `scale(${avail / need})`;
}

// Re-fit whenever the panel itself resizes (window resize, collapse/expand).
const spFitObserver = new ResizeObserver(() => fitStatusContent());
if ($('#sp-content')) spFitObserver.observe($('#sp-content'));

// ─── Projects page ─────────────────────────────────────────────────────────────
let projectsCache = [];
let activeProjectId = null;

// ─── Projects: board + per-project workspace ─────────────────────────────────
// A project is a folder context. The board answers "which folder needs me",
// the workspace answers "what is going on in this one". Clicking a row opens
// the workspace; launching the agent is always the explicit button, never a
// side effect of looking around.
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
// The filter input scopes the board list, so it hides while a workspace is
// open; Add project stays, it is global either way.
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

// One table row. The full path lives in the tooltip; the cell shows the
// home-relative form. Empty cells carry a dim placeholder so the columns keep
// their rhythm; an ellipsis placeholder means derived state has not landed yet.
// The action column always has exactly one occupant: "Open" launches into the
// folder, "Current" states that the agent is already there.
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
    board.innerHTML = `<div class="empty-state"><div class="es-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg></div><div class="es-title">No projects yet</div><div class="es-msg">Pin a folder so the agent can launch into it with one click, and this board can tell you what is going on inside it.</div></div>`;
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
  // Separators appear only when there is more than one non-empty group, so a
  // short list stays a clean flat table.
  const nonEmpty = [needs, act, quiet].filter((g) => g.length).length;
  const groupRow = (label, n) => (nonEmpty > 1 ? `<div class="ws-group"><span>${label}</span><span class="ws-sec-count">${n}</span></div>` : '');
  // The failure note lives inside the paint so it survives every repaint and
  // carries the actual error; a screenshot of it is a diagnosis.
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
    const names = (ins && ins.ok && ins.mcpServers) || [];
    mcpEl.classList.toggle('is-empty', !names.length);
    if (!names.length) {
      // eslint-disable-next-line no-unsanitized/property -- Static markup.
      mcpEl.innerHTML = '<div class="ws-empty">None configured for this folder.</div><button class="ghost-btn ws-cta" id="ws-cta-mcp">Add server</button>';
      const cta = $('#ws-cta-mcp');
      if (cta) cta.addEventListener('click', () => setPage('mcp'));
    } else {
      // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
      mcpEl.innerHTML = names.map((n) => `<span class="ws-stat">${escapeHtml(n)}</span>`).join(' ');
    }
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
  // Pass the project's path explicitly to restartPty so the new PTY lands
  // in the right cwd even if there is any lag between setActive persisting
  // config and pty.restart reading it. Belt-and-suspenders.
  const project = (res.project && res.project.path) ? res.project : (projectsCache.find((p) => p.id === id) || {});
  await restartPty({ cwd: project.path || null });
  setPage('chat');
}

// Leave the active project: clear the selection so the agent runs in the
// default (home / configured) cwd again. Restarts the PTY so the change
// takes effect, mirroring how switching projects works.
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
  // Refresh chat-sub since the agent cwd may have changed.
  try { cfg = await window.husk.config.get(); } catch (_) {}
  // The workspace moved, so Files moves with it.
  if (activeProjectId !== prevActiveId) fxSyncToWorkspace();
  updateAgentPill && updateAgentPill();
  const cmdShort = (cfg.agentCommand || 'agent').split(/\s+/)[0];
  const active = projectsCache.find((p) => p.id === activeProjectId);
  const cwdLabel = active ? active.path : (cfg.agentCwd || huskHome);
  const activeProfiles = getActiveProfileIds()
    .map((id) => profilesCache.find((p) => p.id === id))
    .filter(Boolean);
  let profileTag = '';
  if (activeProfiles.length === 1) profileTag = activeProfiles[0].name;
  else if (activeProfiles.length === 2) profileTag = `${activeProfiles[0].name}, ${activeProfiles[1].name}`;
  else if (activeProfiles.length > 2) profileTag = `${activeProfiles.length} agents`;
  if ($('#chat-sub')) $('#chat-sub').textContent = profileTag ? `${cmdShort} · ${cwdLabel} · ${profileTag}` : `${cmdShort} · ${cwdLabel}`;
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
  // Derived state ages while the window is unfocused (commits from a terminal,
  // runs finishing); refresh on focus so the board is honest when eyes return.
  window.addEventListener('focus', () => { if (currentPage === 'projects') renderProjects(); });

  const newBtn = document.getElementById('btn-projects-new');
  const modal = document.getElementById('new-project-modal');
  const nameEl = document.getElementById('npj-name');
  const pathEl = document.getElementById('npj-path');
  const pickEl = document.getElementById('npj-pick');
  const cancelBtn = document.getElementById('npj-cancel');
  const createBtn = document.getElementById('npj-create');
  // Named openProjectModal / closeProjectModal rather than open / close: in
  // non-strict mode a function declaration in a block hoists to the script
  // scope and shadows the global window.open / window.close that xterm's link
  // click path calls.
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
  // A run in flight owns this page: opening Workflows while one is going (or
  // after a reload) drops you back into watching it, rather than showing a list
  // that pretends nothing is happening.
  if (activeRunId) { wfShowView('run'); return; }
  const adopted = await wfReattachRun();
  if (adopted) return;
  wfShowView('list');
  paintWorkflowList();
  wfPaintLiveBand(null);
}

let wfRunsCache = [];

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

// The flow's own shape, drawn small. A workflow is recognised by its topology,
// which is why "2 steps" told you nothing. When there is a last run, the steps
// are coloured by what happened, so the thumbnail carries the outcome too.
function wfMiniGraph(graph, lastRun) {
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  if (!nodes.length) return '<div class="wf-mini is-empty"><span>no steps yet</span></div>';

  const W = 250;
  const H = 74;
  const PAD = 12;
  const NW = 26;
  const NH = 13;
  const xs = nodes.map((n) => n.x || 0);
  const ys = nodes.map((n) => n.y || 0);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const sx = (maxX - minX) || 1;
  const sy = (maxY - minY) || 1;
  // Single row or column flows would otherwise squash into a line.
  const spanX = (maxX - minX) < 1 ? 1 : sx;
  const spanY = (maxY - minY) < 1 ? 1 : sy;
  const px = (n) => PAD + ((n.x || 0) - minX) / spanX * (W - PAD * 2 - NW);
  const py = (n) => (maxY - minY) < 1
    ? (H - NH) / 2
    : PAD + ((n.y || 0) - minY) / spanY * (H - PAD * 2 - NH);

  const statusOf = {};
  if (lastRun) (lastRun.steps || []).forEach((st) => { statusOf[st.nodeId] = st.status; });

  const pos = {};
  nodes.forEach((n) => { pos[n.id] = { x: px(n), y: py(n) }; });

  const lines = edges.map((e) => {
    const a = pos[e.from]; const b = pos[e.to];
    if (!a || !b) return '';
    const x1 = a.x + NW; const y1 = a.y + NH / 2;
    const x2 = b.x; const y2 = b.y + NH / 2;
    const mx = (x1 + x2) / 2;
    const taken = lastRun && statusOf[e.from] && statusOf[e.from] !== 'skipped'
      && statusOf[e.to] && statusOf[e.to] !== 'skipped';
    return `<path d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" class="wf-mini-edge${taken ? ' is-taken' : ''}" />`;
  }).join('');

  const boxes = nodes.map((n) => {
    const p = pos[n.id];
    const st = statusOf[n.id] || '';
    return `<rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${NW}" height="${NH}" rx="4"
      class="wf-mini-node${st ? ` is-${st}` : ''}" />`;
  }).join('');

  return `<svg class="wf-mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${lines}${boxes}</svg>`;
}

// The last few outcomes, oldest to newest. The CI trick: reliability in one row.
function wfHistoryDots(runs) {
  if (!runs.length) return '<span class="wf-dots-none">not run yet</span>';
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

function wfLastRunPill(runs) {
  if (!runs.length) return '';
  const r = runs[0];
  if (r.status === 'done') {
    return `<span class="wf-lr is-done"><i></i>Passed<span class="wf-lr-sep">&middot;</span>${escapeHtml(wfDur(r.ms))}<span class="wf-lr-sep">&middot;</span>${escapeHtml(wfRelTime(r.finishedAt))}</span>`;
  }
  if (r.status === 'failed') {
    const where = r.failedStep ? ` at "${r.failedStep}"` : '';
    return `<span class="wf-lr is-failed"><i></i>Failed${escapeHtml(where)}<span class="wf-lr-sep">&middot;</span>${escapeHtml(wfRelTime(r.finishedAt))}</span>`;
  }
  return `<span class="wf-lr is-stopped"><i></i>Stopped<span class="wf-lr-sep">&middot;</span>${escapeHtml(wfRelTime(r.finishedAt))}</span>`;
}

// ─── Patterns ────────────────────────────────────────────────────────────────
// Topologies worth copying, each one a real graph. Clicking a card saves the
// flow and drops you into the builder with working nodes, edges and prompts,
// so the first workflow anyone owns is a shape that already makes sense.
//
// Every pattern here is expressible on the run engine as it stands: fan-out,
// join, agent-picked branches and conditional edges. Nothing loops, because a
// node runs at most once per run.

function wfPatternGraph(spec) {
  const ids = {};
  const rand = () => Math.random().toString(36).slice(2, 8);
  const nodes = spec.nodes.map((n) => {
    const id = `node-${Date.now()}-${rand()}`;
    ids[n.key] = id;
    return {
      id,
      name: n.name,
      agentCommand: null,
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
      <div class="wfx-pattern-shape">${wfMiniGraph(p.build().graph, null)}</div>
      <div class="wfx-pattern-body">${escapeHtml(p.blurb)}</div>
      <div class="wfx-pattern-foot">
        <span>${escapeHtml(p.trait)}</span>
        <span class="wfx-pattern-use">Use this<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg></span>
      </div>`;
    card.addEventListener('click', () => wfCreateFromPattern(p));
    grid.appendChild(card);
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

  // Hero figures: what this page is worth at a glance.
  const week = wfRunsCache.filter((r) => Date.now() - new Date(r.finishedAt).getTime() < 7 * 864e5);
  const passed = week.filter((r) => r.status === 'done').length;
  const setStat = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
  setStat('#wfx-stat-flows', String(workflowsCache.length));
  setStat('#wfx-stat-runs', String(week.length));
  setStat('#wfx-stat-pass', week.length ? `${Math.round((passed / week.length) * 100)}%` : 'n/a');
  if (wfRunsCache.length) {
    const durations = wfRunsCache.map((r) => r.ms || 0).filter(Boolean).sort((a, b) => a - b);
    setStat('#wfx-stat-median', durations.length ? wfDur(durations[Math.floor(durations.length / 2)]) : 'n/a');
  } else {
    setStat('#wfx-stat-median', 'n/a');
  }

  // Nothing saved yet: the patterns gallery is the call to action, so the
  // "your workflows" section stays out of the way entirely.
  const mine = $('#wfx-mine-section');
  const mineSub = $('#wfx-mine-sub');
  if (mine) mine.hidden = !workflowsCache.length;
  // The full hero is the pitch for an empty workspace. Once flows exist the
  // saved cards are the point, so the hero drops to a band and hands the fold
  // back to them.
  const hero = document.querySelector('.wfx-hero');
  if (hero) hero.classList.toggle('is-compact', workflowsCache.length > 0);
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
    const agents = wfAgentsUsed(w.graph);
    return `
      <div class="wf-card" data-id="${escapeAttr(w.id)}">
        <div class="wf-card-head">
          <div class="wf-card-title">${escapeHtml(w.name)}</div>
          <button class="wf-card-menu" data-menu="${escapeAttr(w.id)}" title="More" aria-label="More actions">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
          </button>
        </div>
        ${w.description ? `<div class="wf-card-desc">${escapeHtml(w.description)}</div>` : ''}
        <div class="wf-card-graph"${runs.length ? ` data-open-run="${escapeAttr(w.id)}" title="Open the last run"` : ''}>${wfMiniGraph(w.graph, runs[0])}</div>
        <div class="wf-card-status">${runs.length
          ? `<button class="wf-lr-btn" data-open-run="${escapeAttr(w.id)}" title="Open the last run">${wfLastRunPill(runs)}</button>`
          : '<span class="wf-lr is-never"><i></i>Never run</span>'}</div>
        <div class="wf-card-foot">
          ${wfHistoryDots(runs)}
          <div class="wf-card-tags">
            ${agents.map((a) => `<span class="wf-tag">${escapeHtml(a)}</span>`).join('')}
            <span class="wf-tag is-quiet">${n} step${n !== 1 ? 's' : ''}</span>
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

// Duplicate / delete, on the card rather than a permanent delete button that
// invites the wrong click.
function wfOpenCardMenu(anchor, id) {
  document.querySelectorAll('.wf-menu-pop').forEach((m) => m.remove());
  const w = workflowsCache.find((x) => x.id === id);
  if (!w) return;
  const pop = document.createElement('div');
  pop.className = 'wf-menu-pop';
  pop.innerHTML = `
    <button data-act="duplicate">Duplicate</button>
    <button data-act="delete" class="is-danger">Delete</button>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;

  const close = () => pop.remove();
  pop.querySelector('[data-act="duplicate"]').addEventListener('click', async () => {
    close();
    const copy = JSON.parse(JSON.stringify(w));
    delete copy.id;
    copy.name = `${w.name} copy`;
    await window.husk.workflows.create(copy);
    await renderWorkflows();
    toast('Workflow duplicated', 'success');
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

function buildAgentOptions(currentVal) {
  const installed = (agentsCache || []).filter((a) => a.available);
  const opts = [`<option value="">Default (from settings)</option>`];
  installed.forEach((a) => {
    const sel = (a.command === currentVal) ? ' selected' : '';
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
    <div class="wf-cv-node-meta">${escapeHtml(data.model ? `${data.agentCommand || 'default'} \u00b7 ${data.model}` : (data.agentCommand || 'default agent'))}</div>
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

// A connection Drawflow started but never finished keeps its <svg> in the DOM
// with none of the endpoint classes on it, which draws as a line joined to
// nothing and cannot be selected, configured or removed. Releasing a drag over
// anything that is not a step leaves one behind, so sweep after every release.
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
  // Dropping a connection anywhere on the target node's body connects it to
  // that node's input, instead of forcing the user to land exactly on the
  // small input dot. Each step has a single input, so first-input is the
  // right target.
  wfEditor.force_first_input = true;
  wfEditor.start();
  // Drawflow opens a delete popover on right-click. Suppress it: a node is
  // removed from its config panel, and the popover rendered as a stray black box.
  const cont = $('#wf-canvas');
  if (cont) cont.addEventListener('contextmenu', (e) => e.preventDefault());
  // Open the config modal only on a real click: mousedown then mouseup on the
  // same node without dragging. Dragging a node to reposition it must NOT open
  // the wizard. Drawflow keeps owning selection and drag; we just detect a click
  // on mouseup, after Drawflow has already ended its own drag.
  let wfDownNodeEl = null, wfDownX = 0, wfDownY = 0, wfNodeMoved = false;
  if (cont) {
    // Touching the canvas hands the keyboard back to it. The builder focuses
    // the name field on open, and a field that keeps focus swallows Delete,
    // so selecting a connection and pressing Delete would silently do nothing.
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
  // Double-click a line to remove it. Drawflow's own dblclick would drop a
  // reroute point on the path instead, so this runs in the capture phase and
  // stops there. Double-clicking an existing reroute point still removes that
  // point, which is Drawflow's own handler and stays reachable.
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
    agentCommand: (data && data.agentCommand) || '',
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
    idMap[n.id] = wfEditor.addNode('step', 1, 1, n.x || 60, n.y || 60, 'wf-cv', data, wfNodeHtml(data));
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
  // updateNodeDataFromId replaces the node's data wholesale, so carry the stable
  // id through: dropping it would renumber the step and orphan its run history.
  let existing = {};
  try { existing = (wfEditor.getNodeFromId(wfSelectedNodeId) || {}).data || {}; } catch (_) {}
  const modelSel = ($('#wf-np-model') || {}).value || '';
  const model = modelSel === '__custom__'
    ? (($('#wf-np-model-custom') || {}).value || '').trim()
    : (modelSel === 'Loading...' ? '' : modelSel);
  const data = {
    huskId: existing.huskId || wfNewNodeId(),
    name: ($('#wf-np-name').value || 'Step').slice(0, 64),
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
  // The node's own label now names its agent and model, so the graph shows the
  // mix at a glance without opening anything.
  if (metaEl) metaEl.textContent = wfNodeAgentLabel(data);
}

function wfNodeAgentLabel(d) {
  const agent = (d.agentCommand || 'default agent');
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
  // Drawflow needs the container visible and sized before start(). The view is
  // on screen now, so force the layout and build it: a timer here meant the
  // graph did not exist for the first frames, and anything that read it in that
  // window (Run, Save) saw an empty canvas.
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
    wfRunEditor.start();
    wfRunEditor.editor_mode = 'fixed';
  }
  wfRunDfId = {};
  const graph = workflow.graph || { nodes: [], edges: [] };
  wfRunGraph = graph;

  (graph.nodes || []).forEach((n, i) => {
    const html = `
      <div class="wf-rn">
        <div class="wf-rn-top">
          <span class="wf-rn-idx">${i + 1}</span>
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
    const dfId = wfRunEditor.addNode(
      'step', 1, 1, n.x || 60, n.y || 60, 'wf-rn-node', { huskId: n.id }, html,
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
  const xs = nodes.map((n) => n.x || 0);
  const ys = nodes.map((n) => n.y || 0);
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

  // Opening is async (the buffer comes from the main process) and can be
  // superseded mid-flight, by follow mode moving to the next node or by another
  // click. Without a token, the slower open finishes last and paints the wrong
  // node's output into the terminal.
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
  wfCloseTerm();
  wfShowView('run');
  const hint = $('#wf-run-hint');
  if (hint) { hint.hidden = false; hint.textContent = 'Click a step to watch its terminal'; }
  wfBuildRunCanvas(workflow);
  const total = wfAllNodes(workflow.graph).length;
  wfActiveRun = { total, done: 0 };
  wfSetProgress(0, total);
}

async function runWorkflow(workflowId) {
  const workflow = workflowsCache.find((w) => w.id === workflowId);
  if (!workflow) return;
  // Only refuse if the backend actually has a live run. A stale activeRunId
  // left over from a run this window did not see finish must never wedge Run.
  if (activeRunId) {
    let live = null;
    try { const r = await window.husk.workflows.activeRun(); live = r && r.ok ? r.run : null; } catch (_) {}
    if (live) { toast('A workflow is already running', 'info'); wfShowView('run'); return; }
    activeRunId = null;
  }
  wfResetRunUi(workflow);
  const res = await window.husk.workflows.run(workflowId);
  if (!res || !res.ok) {
    toast((res && res.error) || 'Could not start workflow', 'error');
    // The main process may be running something this window lost track of, so
    // adopt it rather than dropping the user on a list that says nothing.
    const adopted = await wfReattachRun();
    if (!adopted) { wfShowView('list'); paintWorkflowList(); }
    return;
  }
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
  // The run just became history: pull it in so the card behind this view is
  // already correct when the user goes back.
  window.husk.workflows.runs().then((res) => {
    wfRunsCache = (res && res.ok && res.runs) || wfRunsCache;
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
  // Bracketed paste: the agent's TUI reads a bare newline as "send", so writing
  // this raw would submit the text a line at a time. Wrapped, it lands in the
  // prompt as one block the user can still edit.
  const paste = `\x1b[200~${primer.replace(/\r/g, '')}\x1b[201~`;
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
$('#wfx-cta-build') && $('#wfx-cta-build').addEventListener('click', () => openWorkflowBuilder(null));
// The two learn-more CTAs scroll rather than navigate: the answer to both is
// already further down this page, and a jump keeps the context.
const wfxScrollTo = (sel) => {
  const el = $(sel);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('#wfx-cta-patterns') && $('#wfx-cta-patterns').addEventListener('click', () => wfxScrollTo('#wfx-patterns-section'));
$('#wfx-cta-learn') && $('#wfx-cta-learn').addEventListener('click', () => wfxScrollTo('#wfx-concepts-section'));
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
// Opening the modal on Drawflow's mousedown-select leaves the node mid-drag (its
// mouseup lands on the modal overlay, not the canvas). Clear the drag flags so
// the node stops following the cursor once the modal closes.
// Closing the modal must also drop Drawflow's selection so the node is not left
// highlighted (which otherwise needs an extra canvas click to clear).
function wfDeselectNode() {
  if (!wfEditor) return;
  try { const el = wfEditor.node_selected; if (el && el.classList) el.classList.remove('selected'); wfEditor.node_selected = null; } catch (_) {}
  document.querySelectorAll('#wf-canvas .drawflow-node.selected').forEach((n) => n.classList.remove('selected'));
}
// ─── Prompt editor ──────────────────────────────────────────────────────────
// A prompt is prose, so it wraps. That breaks the naive gutter, which counted
// newlines and would number a five-row paragraph "1" while the rows below it
// went unlabelled. The mirror measures each logical line at the editor's real
// text width, and the gutter gives that line a block of exactly that height.

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

// Delete the selected connection. Drawflow binds its own key handler to the
// canvas container, which never receives keys because a div is not focusable,
// so the shortcut lives on the document and guards itself: only in the builder,
// only with the config drawer closed, never while a text field has focus.
//
// Steps are deliberately not covered here. Clicking a step opens its drawer and
// closing the drawer clears the selection, so "a selected step with no drawer
// open" is not a state this canvas can be in. Steps are removed from the drawer.
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

async function renderAgents() {
  const grid = $('#agents-grid');
  if (!grid) return;
  // eslint-disable-next-line no-unsanitized/property
  grid.innerHTML = '<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">Loading agents…</div></div>';
  profilesCache = await window.husk.profiles.list();
  paintAgents();
  updateAgentBanner();
}

function getActiveProfileIds() {
  if (Array.isArray(cfg && cfg.activeProfileIds)) return cfg.activeProfileIds;
  return cfg && cfg.activeProfileId ? [cfg.activeProfileId] : [];
}

function paintAgents() {
  const grid = $('#agents-grid');
  if (!grid) return;
  if (!profilesCache.length) {
    // eslint-disable-next-line no-unsanitized/property
    grid.innerHTML = `<div class="empty-state"><div class="es-icon"></div><div class="es-title">No agents yet</div><div class="es-msg">Create a named configuration to shape how the AI works for a specific task.</div></div>`;
    return;
  }
  const activeIds = new Set(getActiveProfileIds());
  // Alphabetical only; active state is purely visual, not positional.
  const sorted = [...profilesCache].sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const editIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;
  const trashIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

  const cards = sorted.map((p) => {
    const isActive = activeIds.has(p.id);
    return `
    <div class="agent-card${isActive ? ' is-active' : ''}" data-id="${escapeHtml(p.id)}" role="button" aria-pressed="${isActive}" tabindex="0" title="${isActive ? 'Selected. Click to deselect.' : 'Click to select.'}">
      ${!p.builtin ? `
        <div class="agent-card-corner">
          <button class="agent-card-icon agent-edit" data-id="${escapeHtml(p.id)}" title="Edit agent" aria-label="Edit agent">${editIcon}</button>
          <button class="agent-card-icon is-danger agent-delete" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Delete agent" aria-label="Delete agent">${trashIcon}</button>
        </div>` : ''}
      <div class="agent-card-head">
        <div class="agent-card-title">${escapeHtml(p.name)}</div>
        ${isActive ? '<span class="agent-card-pill">Selected</span>' : ''}
        ${p.builtin ? '<span class="agent-card-builtin">Built-in</span>' : ''}
      </div>
      ${p.description ? `<div class="agent-card-desc">${escapeHtml(p.description)}</div>` : ''}
      ${p.repoRoot ? `<div class="agent-card-repo" title="Installed from ${escapeAttr(p.repoRoot)}">repo: ${escapeHtml(p.repoRoot.replace(/^\/home\/[^/]+/, '~'))}</div>` : ''}
      ${p.systemPrompt ? `<div class="agent-card-prompt">${escapeHtml(p.systemPrompt)}</div>` : ''}
    </div>
  `;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property
  grid.innerHTML = cards;

  // Whole-card click toggles selection; clicks on inner buttons fall through.
  grid.querySelectorAll('.agent-card').forEach((card) => {
    const id = card.dataset.id;
    const toggle = () => {
      if (activeIds.has(id)) deactivateProfile(id);
      else activateProfile(id);
    };
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (window.getSelection && window.getSelection().toString().length > 0) return;
      toggle();
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });
  grid.querySelectorAll('.agent-edit').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openAgentModal(e.currentTarget.dataset.id); }));
  grid.querySelectorAll('.agent-delete').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(e.currentTarget.dataset.id, e.currentTarget.dataset.name); }));
}

async function activateProfile(id) {
  const res = await window.husk.profiles.activate(id);
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  paintAgents();
  updateAgentBanner();
  updateActiveChatProfile();
}

async function deactivateProfile(id) {
  const res = await window.husk.profiles.deactivate(id);
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  paintAgents();
  updateAgentBanner();
  updateActiveChatProfile();
}

async function deactivateAllProfiles() {
  const res = await window.husk.profiles.deactivateAll();
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  paintAgents();
  updateAgentBanner();
  updateActiveChatProfile();
}

async function activateAllProfiles() {
  const res = await window.husk.profiles.activateAll();
  if (!res || !res.ok) return;
  cfg = await window.husk.config.get();
  paintAgents();
  updateAgentBanner();
  updateActiveChatProfile();
}

function updateAgentBanner() {
  const banner = $('#agents-active-banner');
  const chipsEl = $('#aab-chips');
  if (!banner || !chipsEl) return;
  const active = getActiveProfileIds()
    .map((id) => profilesCache.find((p) => p.id === id))
    .filter(Boolean);
  if (!active.length) { banner.hidden = true; chipsEl.innerHTML = ''; return; }
  banner.hidden = false;
  // eslint-disable-next-line no-unsanitized/property -- escapeHtml on each interpolated value
  chipsEl.innerHTML = active.map((p) => `
    <span class="aab-chip">
      <span class="aab-chip-name">${escapeHtml(p.name)}</span>
      <button class="aab-chip-x" data-id="${escapeHtml(p.id)}" aria-label="Remove ${escapeAttr(p.name)}">&times;</button>
    </span>
  `).join('');
  chipsEl.querySelectorAll('.aab-chip-x').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deactivateProfile(e.currentTarget.dataset.id); }));
}

function updateActiveChatProfile() {
  const sub = $('#chat-sub');
  if (!sub) return;
  const active = getActiveProfileIds()
    .map((id) => profilesCache.find((p) => p.id === id))
    .filter(Boolean);
  const toolName = (cfg && cfg.agentCommand) ? cfg.agentCommand.trim().split(/\s+/)[0] : 'claude';
  const dir = (cfg && cfg.treeRoot) ? cfg.treeRoot.replace(/.*\//, '~') : '~';
  let tag = '';
  if (active.length === 1) tag = active[0].name;
  else if (active.length === 2) tag = `${active[0].name}, ${active[1].name}`;
  else if (active.length > 2) tag = `${active.length} agents`;
  sub.textContent = tag ? `${toolName} · ${dir} · ${tag}` : `${toolName} · ${dir}`;
}

async function deleteProfile(id, name) {
  if (!id) return;
  const confirmed = await openConfirmDialog({
    title: 'Delete agent?',
    bodyHtml: `Permanently delete <strong>${escapeHtml(name || 'this agent')}</strong>.`,
    confirmLabel: 'Delete agent',
  });
  if (!confirmed) return;
  const res = await window.husk.profiles.delete(id);
  if (!res || !res.ok) { toast((res && res.error) || 'Could not delete agent', 'error'); return; }
  profilesCache = profilesCache.filter((p) => p.id !== id);
  if (getActiveProfileIds().includes(id)) { cfg = await window.husk.config.get(); }
  paintAgents();
  updateAgentBanner();
}

function openAgentModal(editId) {
  const modal = $('#agent-modal');
  if (!modal) return;
  editingProfileId = editId || null;
  const existing = editId ? profilesCache.find((p) => p.id === editId) : null;
  const titleEl = $('#agent-modal-title');
  if (titleEl) titleEl.textContent = existing ? 'Edit Agent' : 'New Agent';

  const genStep = $('#agent-generate-step');
  const editStep = $('#agent-edit-step');
  const genDesc = $('#agent-generate-desc');
  const statusEl = $('#agent-generate-status');

  const genFoot = $('#agent-generate-foot');
  const editFoot = $('#agent-edit-foot');

  if (existing) {
    if (genStep) genStep.hidden = true;
    if (genFoot) genFoot.hidden = true;
    if (editStep) editStep.hidden = false;
    if (editFoot) editFoot.hidden = false;
    if ($('#agent-name')) $('#agent-name').value = existing.name;
    if ($('#agent-description')) $('#agent-description').value = existing.description || '';
    if ($('#agent-system-prompt')) $('#agent-system-prompt').value = existing.systemPrompt || '';
    if ($('#agent-autoselect')) $('#agent-autoselect').checked = !!existing.autoSelect;
  } else {
    if (genStep) genStep.hidden = false;
    if (genFoot) genFoot.hidden = false;
    if (editStep) editStep.hidden = true;
    if (editFoot) editFoot.hidden = true;
    if (genDesc) genDesc.value = '';
    if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; }
  }

  modal.hidden = false;
  setTimeout(() => { try { (existing ? $('#agent-name') : genDesc).focus(); } catch (_) {} }, 30);
}

function closeAgentModal() {
  const modal = $('#agent-modal');
  if (modal) modal.hidden = true;
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
    if (res && res.id) profilesCache = [...profilesCache, res];
  }
  if (!res || (!res.ok && !res.id)) { toast('Could not save agent', 'error'); return; }
  closeAgentModal();
  paintAgents();
}

async function generateAgentWithAI() {
  const descEl = $('#agent-generate-desc');
  const statusEl = $('#agent-generate-status');
  const genBtn = $('#btn-generate-agent');
  const desc = descEl ? descEl.value.trim() : '';
  if (!desc) { toast('Describe what the agent should do first', 'error'); return; }
  if (statusEl) { statusEl.textContent = 'Generating...'; statusEl.hidden = false; }
  if (genBtn) genBtn.disabled = true;
  const res = await window.husk.profiles.generate(desc);
  if (genBtn) genBtn.disabled = false;
  if (!res || !res.ok) {
    if (statusEl) { statusEl.textContent = res ? res.error : 'Generation failed'; statusEl.hidden = false; }
    return;
  }
  if (statusEl) statusEl.hidden = true;
  const genStep = $('#agent-generate-step');
  const editStep = $('#agent-edit-step');
  const genFoot = $('#agent-generate-foot');
  const editFoot = $('#agent-edit-foot');
  if (genStep) genStep.hidden = true;
  if (genFoot) genFoot.hidden = true;
  if (editStep) editStep.hidden = false;
  if (editFoot) editFoot.hidden = false;
  if ($('#agent-name')) $('#agent-name').value = res.name || '';
  if ($('#agent-description')) $('#agent-description').value = res.description || '';
  if ($('#agent-system-prompt')) $('#agent-system-prompt').value = res.systemPrompt || '';
  if ($('#agent-autoselect')) $('#agent-autoselect').checked = false;
  setTimeout(() => { try { $('#agent-name').focus(); } catch (_) {} }, 30);
}

$('#btn-new-agent') && $('#btn-new-agent').addEventListener('click', () => openAgentModal(null));

// Import agents from ~/.claude/agents/*.md
async function openAgentsImportModal() {
  const modal = $('#agents-import-modal');
  const listEl = $('#ai-list');
  const confirmBtn = $('#ai-confirm');
  if (!modal || !listEl) return;
  // eslint-disable-next-line no-unsanitized/property -- static placeholder
  listEl.innerHTML = `<div class="ai-empty">Loading...</div>`;
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Import 0 agents'; }
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

  const updateCount = () => {
    const n = listEl.querySelectorAll('.ai-check:checked').length;
    if (confirmBtn) { confirmBtn.disabled = n === 0; confirmBtn.textContent = `Import ${n} agent${n !== 1 ? 's' : ''}`; }
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
  toast(`Imported ${res.imported} agent${res.imported !== 1 ? 's' : ''}${activate ? ' and activated' : ''}`, 'success');
  closeAgentsImportModal();
  profilesCache = await window.husk.profiles.list();
  if (activate) cfg = await window.husk.config.get();
  paintAgents();
  updateAgentBanner();
  updateActiveChatProfile();
}

$('#btn-import-agents') && $('#btn-import-agents').addEventListener('click', openAgentsImportModal);
$('#ai-close') && $('#ai-close').addEventListener('click', closeAgentsImportModal);
$('#ai-cancel') && $('#ai-cancel').addEventListener('click', closeAgentsImportModal);
$('#ai-confirm') && $('#ai-confirm').addEventListener('click', confirmAgentsImport);
$('#agents-import-modal') && $('#agents-import-modal').addEventListener('click', (e) => { if (e.target === $('#agents-import-modal')) closeAgentsImportModal(); });

// ─── Install agents from a repo (local folder or https URL) ─────────────────────
// The repo is expected to ship agents/*.md (Claude-style frontmatter) and
// optionally skills/*.md. Husk copies each picked agent to ~/.claude/agents/
// (Claude path), writes the body into <repo>/.github/copilot-instructions.md
// inside HUSK-AGENTS markers (Copilot path), and stamps the resulting Husk
// profile with repoRoot. spawnPty consumes repoRoot as the cwd, so the agent's
// relative skills/<test_id>.md reads resolve when the chat launches.
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
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Install 0 agents'; }
  if ($('#ra-claude')) $('#ra-claude').checked = true;
  if ($('#ra-copilot')) $('#ra-copilot').checked = true;
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
  confirmBtn.textContent = 'Install 0 agents';
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
  const installNote = `Imported agents install into every detected AI tool's agent folder (Claude, Copilot, ...). No tool-specific files are written.`;
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
  const updateCount = () => {
    const n = listEl.querySelectorAll('.ra-pick:checked').length;
    confirmBtn.disabled = n === 0;
    confirmBtn.textContent = `Install ${n} agent${n !== 1 ? 's' : ''}`;
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
  const installToClaudeAgents = !!($('#ra-claude') && $('#ra-claude').checked);
  const activate = !!($('#ra-activate') && $('#ra-activate').checked);
  const res = await window.husk.repoAgents.install({
    root, picks, installToClaudeAgents, activate,
  });
  if (!res || !res.ok) {
    toast((res && res.error) || 'Install failed', 'error');
    if (btn) btn.disabled = false;
    return;
  }
  {
    const parts = [`Installed ${res.imported} agent${res.imported !== 1 ? 's' : ''}`];
    if (installToClaudeAgents && res.distributedTo && res.distributedTo.length) parts.push(`synced to all AI tools`);
    if (activate) parts.push('activated');
    toast(parts.join(' · '), 'success');
  }
  closeRepoAgentsModal();
  profilesCache = await window.husk.profiles.list();
  if (activate) cfg = await window.husk.config.get();
  paintAgents();
  updateAgentBanner();
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
function openRepoMcpModal() {
  const m = $('#repo-mcp-modal');
  if (!m) return;
  rmScan = null;
  rmPicked = null;
  if ($('#rm-root')) $('#rm-root').value = '';
  rmSetView('list');
  rmStatus('');
  m.hidden = false;
  setTimeout(() => { try { $('#rm-root').focus(); } catch (_) {} }, 0);
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
  rmStatus('Scanning…');
  // eslint-disable-next-line no-unsanitized/property -- static loading copy
  list.innerHTML = '<div class="ai-empty">Looking for mcp-servers/*…</div>';
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
  ];
  // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
  detail.innerHTML = `
    <div class="ra-status ra-status-info"><strong>${escapeHtml(rmPicked.displayName)}</strong> · <code>${escapeHtml(rmPicked.dir)}</code></div>
    ${rmPicked.needsBuild ? `
      <label class="ai-foot-toggle" title="Run npm install + npm run build inside the server before installing">
        <input type="checkbox" id="rm-build" class="ai-check" checked />
        <span class="ai-check-box" aria-hidden="true"></span>
        Run npm install + npm run build first (the server's <code>dist/</code> is missing)
      </label>
      <div class="ra-status ra-status-info" style="margin-top:6px;">
        Heads up: running build executes the server's <code>package.json</code> lifecycle scripts (preinstall / install / postinstall / build). Only do this for repos you trust.
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
$('#rm-root') && $('#rm-root').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); const v = ($('#rm-root').value || '').trim(); if (v) rmScanRoot(v); }
});
$('#repo-mcp-modal') && $('#repo-mcp-modal').addEventListener('click', (e) => { if (e.target === $('#repo-mcp-modal')) closeRepoMcpModal(); });
$('#agent-modal-close') && $('#agent-modal-close').addEventListener('click', closeAgentModal);
$('#agent-modal-cancel') && $('#agent-modal-cancel').addEventListener('click', closeAgentModal);
$('#agent-modal-save') && $('#agent-modal-save').addEventListener('click', saveAgentModal);
$('#agent-name') && $('#agent-name').addEventListener('input', () => $('#agent-name').classList.remove('field-invalid'));
$('#btn-deactivate-all') && $('#btn-deactivate-all').addEventListener('click', () => deactivateAllProfiles());
$('#btn-select-all-agents') && $('#btn-select-all-agents').addEventListener('click', () => activateAllProfiles());
$('#btn-deselect-all-agents') && $('#btn-deselect-all-agents').addEventListener('click', () => deactivateAllProfiles());
$('#agent-modal') && $('#agent-modal').addEventListener('click', (e) => { if (e.target === $('#agent-modal')) closeAgentModal(); });
$('#btn-generate-agent') && $('#btn-generate-agent').addEventListener('click', generateAgentWithAI);
$('#btn-manual-agent') && $('#btn-manual-agent').addEventListener('click', () => {
  $('#agent-generate-step').hidden = true;
  $('#agent-generate-foot').hidden = true;
  $('#agent-edit-step').hidden = false;
  $('#agent-edit-foot').hidden = false;
  setTimeout(() => { try { $('#agent-name').focus(); } catch (_) {} }, 30);
});
$('#agent-modal-back') && $('#agent-modal-back').addEventListener('click', () => {
  $('#agent-edit-step').hidden = true;
  $('#agent-edit-foot').hidden = true;
  $('#agent-generate-step').hidden = false;
  $('#agent-generate-foot').hidden = false;
  setTimeout(() => { try { $('#agent-generate-desc').focus(); } catch (_) {} }, 30);
});

// ─── Prompts page ──────────────────────────────────────────────────────────────
let promptsCache = [];
// The row the right pane is showing, and the bodies already pulled off disk.
// Filtering re-renders the whole pane, so the cache is what keeps typing in
// the search field from re-reading files on every keystroke.
let selectedPromptMd = '';
const promptBodyCache = new Map();

const PR_TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
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

function openPromptComposer(seedName) {
  const btn = document.getElementById('btn-prompts-new');
  if (!btn) return;
  btn.click();
  const nameEl = document.getElementById('np-name');
  if (nameEl && seedName) nameEl.value = seedName;
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

  const rows = filtered.map((p) => {
    const isActive = p.mdPath === selectedPromptMd;
    return `<div class="pr-item${isActive ? ' is-active' : ''}${p.disabled ? ' is-disabled' : ''}" data-md="${escapeAttr(p.mdPath)}" role="button" aria-current="${isActive}" tabindex="0">
      <div class="pr-item-top">
        <span class="pr-item-name">${escapeHtml(p.name)}</span>
        ${p.disabled ? '<span class="pr-pill">off</span>' : ''}
      </div>
      ${p.description ? `<span class="pr-item-desc">${escapeHtml(p.description)}</span>` : ''}
    </div>`;
  }).join('');

  const count = q ? `${filtered.length} of ${items.length}` : `${items.length} prompt${items.length === 1 ? '' : 's'}`;
  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml/escapeAttr above.
  pane.innerHTML = `<div class="pr-list">
      <div class="pr-list-head"><span>Library</span><span>${escapeHtml(count)}</span></div>
      <div class="pr-items" aria-label="Prompts">
        ${rows}
        <button class="pr-new" type="button">${PR_PLUS_SVG}New prompt</button>
      </div>
    </div>
    <div class="pr-detail">
      <div class="pr-detail-head">
        <div class="pr-detail-heading">
          <div class="pr-eyebrow">Prompt${active.disabled ? '<span class="pr-pill">off</span>' : ''}</div>
          <h2 class="pr-detail-title">${escapeHtml(active.name)}</h2>
          ${active.description ? `<div class="pr-detail-desc">${escapeHtml(active.description)}</div>` : ''}
          <div class="pr-detail-path" title="${escapeAttr(active.mdPath)}">${escapeHtml(active.mdPath)}</div>
        </div>
        <div class="pr-detail-actions">
          <button class="pr-iconbtn pr-delete" type="button" title="Delete prompt" aria-label="Delete prompt">${PR_TRASH_SVG}</button>
          <button class="pr-run pr-run-btn" type="button" title="Send into chat">Run${PR_ARROW_SVG}</button>
        </div>
      </div>
      <pre class="pr-body is-muted">Loading…</pre>
    </div>`;

  const selectRow = (md) => {
    if (!md || md === selectedPromptMd) return;
    selectedPromptMd = md;
    paintPrompts(items, filter);
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
  const delBtn = pane.querySelector('.pr-delete');
  if (delBtn) delBtn.addEventListener('click', () => deletePrompt(active.mdPath, active.name));
  fillPromptBody(active.mdPath);
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
    closeNewPrompt();
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
      ? 'an enabled skill is called automatically whenever the agent decides it fits'
      : 'switch off anything this agent should not see');
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
      <div class="sk-row-desc" title="${escapeAttr(sk.description || '')}">${escapeHtml(sk.description || 'No description.')}</div>
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
      // Reload rather than patch. Toggling renames the entry on disk, so its
      // path changes along with its state and whether it still passes the
      // filter; re-reading is the only version of that update which cannot go
      // stale.
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
      subEl.textContent = `Session history for ${sessionsAgent} is not available yet`;
    } else {
      // The hint reads as prose; the agent and its directory sit in a mono chip
      // that truncates, so a deep project path cannot widen the head.
      const where = `${sessionsAgent} sessions at ${sessionsDir || ''}`;
      // eslint-disable-next-line no-unsanitized/property -- Agent and path are escaped here.
      subEl.innerHTML = '<span>Click a session to preview, Resume to continue</span>'
        + (sessionsDir ? `<span class="ss-path" title="${escapeAttr(where)}">${escapeHtml(where)}</span>` : '')
        + hiddenHTML;
    }
    sessionsSubOwned = true;
  }
  if (res.supported === false) {
    // eslint-disable-next-line no-unsanitized/property -- Static, agent name escaped.
    $('#sessions-list').innerHTML = sessionsEmptyCard({
      title: 'Not available for this agent',
      msg: `Husk does not read ${escapeHtml(sessionsAgent)} sessions yet. Switch the active agent to claude or copilot to browse sessions.`,
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

// Which listed sessions are actually agents a chat started, keyed by session id,
// plus the parent each one belongs to. The list of sessions on disk cannot tell
// them apart: an agent is a fork of its chat, so it inherits that chat's title
// and looks like a peer conversation. The tool's own agent listing is
// authoritative, so ask it rather than inferring from transcripts.
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
  // An agent is a fork of its chat, so it carries that chat's title and sits in
  // the list as a peer conversation with the same name. Show it under the chat
  // that started it instead. Only when that chat is actually in view: reparenting
  // a row onto something not on screen would remove it with nowhere to go.
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
    // A chat and its agents are one card: the chat keeps the card's surface and
    // the agents hang off it, so containment survives both theme families where
    // a fill of their own would invert between them.
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

  showDetail({
    eyebrow: `${sessionsAgent} session`,
    title: d.title,
    sub: d.id,
    meta,
    body,
    actions: [
      { label: '↻ Resume this session', kind: 'primary', onClick: () => resumeSessionInChat({ ...d, owner: d.owner || sessionsAgent }) },
      d.prdpath ? { label: 'Open PRD', kind: 'ghost', onClick: () => window.husk.fs.open(d.prdpath) } : null,
      { label: 'Open files', kind: 'ghost', onClick: () => window.husk.fs.open(d.path) },
    ].filter(Boolean),
  });
}

// Build the active agent's "resume session" command. claude takes a positional
// id (claude --resume <id>); copilot takes an attached value (copilot
// --resume=<id>). Anything else falls back to the claude form.
// Build the resume command for the agent that OWNS the session. Returns
// null when that agent has no session-resume form; callers must handle
// null rather than run some other agent's binary against a foreign id.
// A short, display-only rendering of the resume command. The command that is
// actually run comes from main, because gemini resumes by position in its own
// session list and only main can resolve that against what is on disk now.
function resumeCommandLabel(agent, id) {
  if (agent === 'claude') return `claude --resume ${id}`;
  if (agent === 'copilot') return `copilot --resume=${id}`;
  if (agent === 'gemini') return `gemini --resume ${id}`;
  return null;
}

async function resumeSessionInChat(d) {
  // The session's OWNING agent decides the resume command. Every list
  // entry carries its owner; the active config is only a last resort
  // (an owner-less entry from an older render).
  const agent = (d.owner
    || (cfg && cfg.agentCommand ? cfg.agentCommand : 'claude')).trim().split(/\s+/)[0].toLowerCase();
  let cmd = null;
  try {
    const r = await window.husk.sessions.resumeCommand({ agent, id: d.id, cwd: d.project || '' });
    if (r && r.ok && r.command) cmd = r.command;
    else if (r && r.error) { toast(r.error, 'error'); return; }
  } catch (_) { /* fall through to the unsupported message */ }
  if (!cmd) {
    toast(`Resume is not supported for ${agent} sessions`, 'error');
    return;
  }
  closeDetail();
  setPage('chat');
  const previousHeader = {
    chatSub: $('#chat-sub') ? $('#chat-sub').textContent : '',
    spAgent: $('#sp-agent') ? $('#sp-agent').textContent : '',
    spSessionId: $('#sp-session-id') ? $('#sp-session-id').textContent : '',
  };
  const cmdShort = resumeCommandLabel(agent, d.id.slice(0, 8)) || cmd;
  const cwd = d.project || null;
  toast(`Resuming ${d.id.slice(0, 8)}… (cwd: ${cwd || huskHome})`, 'success');
  $('#chat-sub').textContent = `${cmdShort} · ${cwd || huskHome}`;
  if ($('#sp-agent')) $('#sp-agent').textContent = cmdShort;
  if ($('#sp-session-id')) $('#sp-session-id').textContent = `${d.id.slice(0, 8)} · ${cwd || huskHome}`;
  // Resume in a fresh tab so the current chat keeps running alongside it.
  const tab = await openNewChatTab({ command: cmd, cwd, skipContext: true, resumeAttempt: { agent, id: d.id, previousHeader } });
  // Link the tab to the resumed session so future renames persist, and restore
  // a custom name if this session was renamed before. The default label stays
  // "Chat N" otherwise; the header title stays "Chat".
  if (tab) {
    tab.agentId = d.id;
    try {
      const res = await window.husk.sessions.resolveLiveTitle({ knownAgentId: d.id });
      if (res && res.ok && res.custom && res.title) tab.customTitle = res.title;
    } catch (_) {}
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

// Files follows the workspace. Whatever folder the agent is working in is the
// folder this page shows, so opening Files never means re-finding the project
// that is already open in the chat. Open-folder is a detour from that, held
// for the session only: pinning a different project ends it.
let fxRootOverride = null;
function fxDefaultRoot() {
  const active = projectsCache.find((p) => p && p.id === activeProjectId);
  if (active && active.path) return active.path;
  return (cfg && (cfg.agentCwd || cfg.treeRoot)) || huskHome || null;
}
function fxCurrentRoot() { return fxRootOverride || fxDefaultRoot(); }

// Called when the pinned project changes: drop the detour and repaint if the
// page is on screen. Files that were listed under the old project would other-
// wise stay up while the chat has already moved.
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
  const sub = $('#files-sub'); if (sub) sub.textContent = root || '';
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
  // File index. Distinguish "genuinely empty" from "the index call failed"
  // (e.g. the main process is older than this renderer and lacks the handler,
  // which happens after a renderer-only reload) so the empty state is honest.
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

// Keyboard navigation over whatever the list is currently showing.
//
// The list has two render modes: a nested tree while browsing, and a flat list
// once you search or switch to Changed. The previous handler walked fx.results,
// which tree mode leaves empty, and it was bound to the search input's keydown,
// so the arrows the footer advertises did nothing unless that box already had
// focus. Both paths now navigate the rendered rows.
// Which region the keys drive: the file list, or one of the two overview
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

// One cursor for the whole page. Clearing every pane first is what stops a
// mouse click and the keyboard each leaving a highlight behind, which read as
// two files being selected at once.
function fxClearCursor() {
  ['list', 'ov0', 'ov1'].forEach((p) => {
    const host = fxPaneEl(p);
    if (host) host.querySelectorAll('.is-active-key').forEach((el) => el.classList.remove('is-active-key'));
  });
}

// The cursor IS the focus. Overview rows are buttons and take a native focus
// ring on Tab, while list rows are divs driven by a class, so keeping the two
// separate meant Tab and the arrows each left their own highlight and the page
// showed two selected rows. Moving focus with the cursor collapses them into
// one thing that both inputs drive.
//
// Roving tabindex: the cursor row is the single tab stop for its pane, so
// tabbing in lands on the cursor rather than walking every row.
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

// Tab moves focus without going through fxSetCursor, so mirror it back onto
// the cursor. Setting the class only, never focus, so this cannot recurse.
// When Tab carries focus out of all three panes the cursor is dropped too,
// otherwise a stale highlight sits in the list while the real focus ring is on
// some other control, which reads as two selected things again.
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
  // Step over panes that render nothing. A clean working tree leaves the first
  // overview column empty, and stopping there would strand the cursor on a
  // column with no rows and no way forward.
  for (let i = at + delta; i >= 0 && i < chain.length; i += delta) {
    const rows = fxNavRows(chain[i]);
    if (rows.length) {
      fxSetCursor(rows[0], chain[i]);
      rows[0].scrollIntoView({ block: 'nearest' });
      return;
    }
  }
}

// Enter opens a file and expands or collapses a folder, matching what a click
// on the same row does.
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
// With no file selected the preview pane shows an overview of the folder
// instead of a placeholder: what git says changed, the files a person opens
// first in an unfamiliar repo, and the type mix. Every row opens a file and
// every type chip applies the extension filter, so the pane is a starting
// point rather than a sign that says "start somewhere else".
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
// falls back to its shallowest files, which is what a person opens first when
// the folder is not a repo they recognize.
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
// Live re-highlighting re-tokenizes the whole file per keystroke, which lags on
// very large files. Past this size the backdrop stays plain-escaped (still
// aligned, just uncolored) so typing never stutters.
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

// Render highlighted code with a line-number gutter. highlightLines returns one
// self-contained, span-balanced, XSS-safe HTML string per source line (all input
// entity-escaped; only the highlighter's own span markup is HTML).
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
    // Only defer to a field the user can actually see. xterm parks focus in a
    // hidden helper textarea belonging to the chat page, and nothing blurs it
    // when you navigate away, so after Ctrl+K or Alt+N the active element is a
    // textarea on a page that is no longer showing. Treating that as "typing"
    // swallowed every arrow key on this page.
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
function bindPrefs() {
  $('#pref-agent').value = cfg.agentCommand || '';
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
  $('#chat-sub').textContent = `${cmdShort} · ${cfg.agentCwd || huskHome}`;
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
// The text is read from xterm's RENDERED GRID, not the raw byte stream. A
// full-screen agent (e.g. copilot in the alternate screen) streams its reply
// while redrawing the screen with cursor positioning, which interleaves UI
// chrome (status bar, spinner, prompt) into the byte stream; only the final
// grid has each line cleanly on its own row. So we wait for output to settle
// (the reply has stopped streaming), then scan the grid for the recap row.
// Spoken at most once per user turn, and each unique line at most once.
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
// Preferences modal: open/close + nav switching
function openPrefsModal() {
  const modal = $('#prefs-modal');
  const backdrop = $('#prefs-backdrop');
  if (!modal) return;
  modal.hidden = false;
  backdrop.hidden = false;
  bindPrefs(); // refresh form values each open
}
function closePrefsModal() {
  const modal = $('#prefs-modal');
  const backdrop = $('#prefs-backdrop');
  if (!modal) return;
  modal.hidden = true;
  backdrop.hidden = true;
  // Closing Preferences abandons any unsaved appearance preview, so the UI
  // never keeps wearing a theme that was not committed.
  revertAppearancePreview();
}
(function wirePrefsModal() {
  // Gear icon in rail opens modal
  const btnOpen = $('#btn-open-prefs');
  if (btnOpen) btnOpen.addEventListener('click', openPrefsModal);

  // Close button inside modal
  const btnClose = $('#prefs-close');
  if (btnClose) btnClose.addEventListener('click', closePrefsModal);

  // Backdrop click closes
  const backdrop = $('#prefs-backdrop');
  if (backdrop) backdrop.addEventListener('click', closePrefsModal);

  // ESC key closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#prefs-modal')?.hidden) closePrefsModal();
  });

  // Nav switching. Items without a section (Release Notes) act as commands
  // and leave the active panel untouched.
  const nav = $('#prefs-nav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const item = e.target.closest('.prefs-nav-item');
      if (!item) return;
      const section = item.dataset.prefsSection;
      if (!section) return;
      $$('.prefs-nav-item').forEach((el) => el.classList.remove('active'));
      item.classList.add('active');
      $$('.pref-section').forEach((el) => el.classList.toggle('active', el.dataset.prefsSection === section));
    });
  }
  $('#prefs-release-notes')?.addEventListener('click', async () => {
    let ver = '';
    try { ver = ((await window.husk.updates.get()) || {}).current || ''; } catch (_) {}
    if (!whatsNewFor(ver)) ver = latestWhatsNewVersion();
    if (ver) showWhatsNew(ver);
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
    : ['claude', 'copilot', 'codex', 'aider'].includes(vendor) ? '--model'
    : '';
}
function isUsableModelValue(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 90) return false;
  if (/\s/.test(raw)) return false;
  if (/not logged in|use \/login|authenticate|plan:|session:|aic used|context\b/i.test(raw)) return false;
  // Reject config-path and doc tokens (claude/settings.json, claude-api)
  // so garbage saved by older parses cannot re-enter the dropdown or save.
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
      // The label already names the model. Appending the raw id repeated it in
      // a second vocabulary and pushed the useful half of longer rows out of
      // the control's width, so the id moves to the tooltip.
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

// ─── Update pill (topbar) ───────────────────────────────────────────────────────
// One element drives every state: idle, checking, up-to-date, available,
// downloading (n%), ready (restart to install), error. The dot pulses only
// when there's something for the user to do.
let updateState = { status: 'idle', current: 'v?' };
function paintUpdatePill() {
  const btn = $('#btn-update');
  const text = $('#tv-text');
  const dot = btn ? btn.querySelector('.tv-dot') : null;
  if (!btn) return;
  const s = updateState || { status: 'idle' };
  const cur = s.current ? (s.current.startsWith('v') ? s.current : 'v' + s.current) : '';
  const next = s.version ? ('v' + s.version) : '';
  const baseLabel = cur ? `Husk ${cur}` : 'Husk';
  let label;
  let title;
  let showDot = false;
  switch (s.status) {
    case 'checking':
      label = `${baseLabel} · checking…`; title = 'Looking for a new version'; break;
    case 'available':
      label = `${next} available →`; title = `Update from ${cur} to ${next}`; showDot = true; break;
    case 'downloading':
      label = `downloading ${s.percent || 0}%`; title = 'Downloading update'; break;
    case 'ready':
      label = 'restart to update'; title = `${next} ready, click to install and relaunch`; showDot = true; break;
    case 'up-to-date':
      label = `${baseLabel} · check for updates ↻`; title = `You're up to date (${cur}) · click to recheck`; break;
    case 'error':
      label = `${baseLabel} · check for updates ↻`; title = `Update check failed: ${s.error || 'unknown'}`; break;
    case 'idle':
    default:
      label = `${baseLabel} · check for updates ↻`; title = 'Click to check for updates';
  }
  text.textContent = label;
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
  // Every render starts from a clean, enabled CTA. The download click
  // disables it while downloading; when the status then flips to ready
  // this re-render must re-enable it, or the "Restart and install"
  // button stays greyed out and the update cannot be applied.
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
      // macOS can't auto-install: the app is unsigned (no Apple Developer ID),
      // so Squirrel.Mac would download the dmg and then quitAndInstall would
      // fail silently. Send the user to the dmg download and show the command
      // that lets Gatekeeper open the unsigned build.
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
  const btn = $('#btn-update');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('#update-pop');
      if (!pop) return;
      if (pop.hidden) openUpdatePop(); else pop.hidden = true;
    });
  }
  const close = $('#up-close');
  if (close) close.addEventListener('click', () => { const p = $('#update-pop'); if (p) p.hidden = true; });
  window.addEventListener('click', (e) => {
    const pop = $('#update-pop');
    if (!pop || pop.hidden) return;
    if (e.target.closest('#update-pop') || e.target.closest('#btn-update')) return;
    pop.hidden = true;
  });
}
window.husk.updates.onStatus((s) => {
  updateState = s;
  paintUpdatePill();
  const pop = $('#update-pop');
  if (pop && !pop.hidden) openUpdatePop();
});
(async () => {
  try { updateState = (await window.husk.updates.get()) || updateState; } catch (_) {}
  paintUpdatePill();
})();

// ─── Topbar buttons ─────────────────────────────────────────────────────────────
$('#btn-restart').addEventListener('click', restartPty);
// Theme selection lives only in Preferences (full picker).
// Attaching a file puts its path in the agent's input and stops there. A real
// PTY cannot draw an attachment chip inside the agent's own prompt, so the path
// is the attachment; the sentence around it belongs to the user. The path is
// absolute (every CLI can open it as written) and quoted when it holds
// whitespace. Nothing is submitted: the user types their question and presses
// Enter, exactly as they would after attaching a file anywhere else.
function chatFileRef(filePath) {
  const p = String(filePath || '');
  return /\s/.test(p) ? `"${p}" ` : `${p} `;
}

async function attachFileToChat(filePath) {
  const ref = chatFileRef(filePath);
  if (!ref.trim()) return;
  // The welcome screen can still be up over a chat that is already running,
  // and launching a second agent there would spawn a PTY the path never
  // reaches. A live tab means write to it and clear the overlay instead.
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

// ─── Rail "In context" list ─────────────────────────────────────────────────────
// Tracks files the user shared with the agent during THIS Husk session only.
// We deliberately do NOT enumerate ~/.claude/MEMORY/CONTEXT/ from disk, because
// that directory may contain files left over from other sessions or other
// projects. The sidebar should reflect "what I shared with this agent right
// now", not "everything that has ever been written to the context dir".
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
function refreshContextList() {
  const wrap = $('#rail-context-list');
  if (!wrap) return;
  if (!sessionContext.length) {
    wrap.innerHTML = '<div class="rail-sub-empty">Nothing shared yet. Drop a file or click +.</div>';
    return;
  }
  // eslint-disable-next-line no-unsanitized/property -- Session context fields are escaped via escapeHtml/escapeAttr.
  wrap.innerHTML = sessionContext.map((it) => `
    <div class="rail-sub-item" data-path="${escapeAttr(it.path)}" data-name="${escapeAttr(it.name)}" title="${escapeAttr(it.name)}, click to re-share with the agent">
      <span class="rsi-dot"></span>
      <span class="rsi-name">${escapeHtml(it.name)}</span>
      <button class="rsi-remove" data-remove="1" title="Remove from this session"></button>
    </div>
  `).join('');
  wrap.querySelectorAll('.rail-sub-item').forEach((el) => {
    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-remove]')) {
        // Remove from sidebar AND delete the copy in CONTEXT/. The original
        // source file on the user's disk is not touched.
        removeFromSessionContext(el.dataset.path);
        try { await window.husk.context.remove(el.dataset.path); } catch (_) {}
        toast(`Removed: ${el.dataset.name}`, 'success');
        return;
      }
      attachFileToChat(el.dataset.path);
    });
  });
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
// Anything in this set that is still enabled is "Loaded" (live in the agent
// right now). Anything enabled but NOT in the snapshot is "Pending", the
// user added or re-enabled it since launch and a restart is required.
const loadedMcpSnapshot = new Set();
function snapshotLoadedMcps(servers) {
  loadedMcpSnapshot.clear();
  (servers || []).forEach((s) => { if (s.enabled) loadedMcpSnapshot.add(s.id); });
  refreshLoadedMcpsBadge();
  // If the user is on the MCP page, repaint so Pending → Loaded transitions
  // visibly without needing to navigate away and back.
  if (currentPage === 'mcp') paintMcpSections();
}
// Live connection status from the active agent's CLI. id -> 'connected'
// | 'failed' | 'auth' | 'disabled'. Some agents (copilot today) do not
// expose a programmatic health command; the renderer falls back to a
// neutral "configured" pill on those rows.
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
async function renderMcp() {
  await reloadMcpInventory();
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
    // Some agents (copilot today) do not expose a programmatic health
    // probe. Don't claim the row's state is unknown, it's just that we
    // cannot probe it from outside the REPL. Show a neutral pill.
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
// Apply pending MCP changes by silently respawning the agent. The agent re-reads
// ~/.claude.json on startup, so this is the cheapest path to "loaded". We do
// this behind the scenes after install / toggle / remove, then the snapshot
// repaints the MCP page so the user sees Pending → Loaded without lifting a
// finger. Skipped if no PTY has ever started (welcome screen still up).
async function applyMcpChange(label) {
  const inv = await reloadMcpInventory();
  if (!TABS.size) {
    // No live agent yet. Snapshot lazily; whenever the user clicks Launch /
    // Start building, the new MCPs load on first start (shown as Loaded).
    snapshotLoadedMcps(inv);
    if (currentPage === 'mcp') paintMcpSections();
    return;
  }
  // PTY is live. Do NOT restart automatically: a restart kills any unsent draft
  // in the chat input. Leave the running agent untouched so the draft survives;
  // the change shows as Pending (snapshot is unchanged) and applies on the next
  // agent restart (Restart button), which is when the snapshot is recaptured.
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
  });
}
function paintMcpSections() {
  const wrap = $('#mcp-installed');
  const enabled = mcpInstalled.filter((s) => s.enabled);
  const disabled = mcpInstalled.filter((s) => !s.enabled);
  const loaded   = enabled.filter((s) => loadedMcpSnapshot.has(s.id));
  const pending  = enabled.filter((s) => !loadedMcpSnapshot.has(s.id));

  if (!mcpInstalled.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="es-icon">⊟</div><div class="es-msg">No MCP servers yet. Pick one below to give the agent a new ability.</div></div>';
    return;
  }

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

// State for the custom MCP modal. Lives across renders of the modal
// body so the foot button can stay contextually wired without a re-
// lookup. mode is 'add' | 'edit'; activeTab is 'stdio' | 'http';
// view is 'paste' | 'form'; parsedItems holds the last successful
// parse result while paste is open (drives the foot button label).
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

// renderMcpModal builds the body content for both Add and Edit flows.
// Add: starts in form view, server-name input editable, paste view
//      reachable via a small toggle button. Foot primary button shows
//      `Install N server(s)` while paste view holds a valid JSON, or
//      `Install` while form view is active.
// Edit: starts in form view, pre-filled, no paste view. The server-name
//      input is editable; changing it renames the entry (the adapter
//      rewrites the JSON key). Foot primary button is `Save changes`.
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
// Every catalog card already carries a category badge. Until now it was
// decoration: 272 plugins rendered as one flat alphabetical grid with no way
// to narrow them except free text.
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

  // Nothing installed and no marketplace to install from: the two sections
  // would each render their own icon and their own message, and the second
  // would contradict the first. One full-height state with one action instead.
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
    // The grid used to stop at 120 and tell you to narrow the search. Measured
    // on a 272-plugin catalog, building and laying out all of them costs 44ms
    // against 20ms for 120, and 600 costs 48ms: the cap saved 24ms of one-time
    // paint and hid 152 plugins behind advice the category chips replaced.
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

// One CLI mutation with busy handling. Afterwards only the installed
// list is re-fetched: enable/disable/uninstall/update cannot change the
// marketplace catalogs, so the cached catalog repaints as-is (no
// redundant IPC, no loading flash).
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
  if (cfgBtn) cfgBtn.addEventListener('click', () => { closeAgentMenu(); openPrefsModal(); });
}
function openAgentMenu() {
  // Paint instantly from cache, then re-detect so an agent installed after
  // Husk launched (e.g. a fresh `npm i -g @google/gemini-cli`) shows as
  // available without a restart. refreshAgentMenu repaints when it resolves.
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
$('#ce-launch').addEventListener('click', () => launchAgent());
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

// Order mirrors the rail so muscle memory carries over. Shortcut hints show
// the real bindings, which are Alt+digit (see the digit map in the global
// keydown handler): Alt+1 chat, Alt+2 skills, Alt+3 sessions, Alt+4 files,
// Alt+5 mcp, Alt+6 preferences. The Alt modifier is shown explicitly so a
// user does not press a bare digit on the chat page, where it falls through
// to the focused terminal as literal input instead of switching pages.
const PALETTE_ACTIONS = [
  { icon: ICONS.chat,        label: 'Switch to Chat',                 run: () => setPage('chat'),        shortcut: 'Alt 1' },
  // Ahead of the pages, because three entries answer "agent" and the palette
  // preselects the first: someone hunting a running agent was landing on the
  // page of agent definitions instead. The rail order below is untouched.
  { icon: ICONS.agents,      label: 'Find a running agent',           run: () => openAgentSwitch(), shortcut: 'Alt+A' },
  { icon: ICONS.agents,      label: 'Switch to Agents',               run: () => setPage('agents') },
  { icon: ICONS.workflows,   label: 'Switch to Workflows',            run: () => setPage('workflows') },
  { icon: ICONS.autopilot,    label: 'Switch to Autopilot',             run: () => setPage('autopilot') },
  { icon: ICONS.projects,    label: 'Switch to Projects',             run: () => setPage('projects') },
  { icon: ICONS.prompts,     label: 'Switch to Prompts',              run: () => setPage('prompts') },
  { icon: ICONS.skills,      label: 'Switch to Skills',               run: () => setPage('skills'),      shortcut: 'Alt 2' },
  { icon: ICONS.sessions,    label: 'Switch to Sessions',             run: () => setPage('sessions'),    shortcut: 'Alt 3' },
  { icon: ICONS.files,       label: 'Switch to Files',                run: () => setPage('files'),       shortcut: 'Alt 4' },
  { icon: ICONS.mcp,         label: 'Switch to MCP',                  run: () => setPage('mcp'),         shortcut: 'Alt 5' },
  { icon: ICONS.plugins,     label: 'Switch to Plugins',              run: () => setPage('plugins') },
  { icon: ICONS.preferences, label: 'Switch to Preferences',          run: () => openPrefsModal(), shortcut: 'Alt 6' },
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
// A chat can start agents that keep working after it moves on. They are their
// own sessions, so the only way to reach one has been to leave Husk and drive
// the CLI's picker by hand. This is that picker, owned by Husk.
// `view` is the list actually on screen. Every index handed back by a click, an
// arrow or a digit means a position in that, never in the unfiltered set.
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
  if (!a || !a.running) return 'is-done';
  return a.state === 'blocked' ? 'is-blocked' : 'is-running';
}

// Only the waiting state is worded urgently; the other two label themselves
// quietly so one marker in the list carries the thing that needs a human.
function agentStateWord(a) {
  if (!a || !a.running) return 'done';
  return a.state === 'blocked' ? 'needs you' : 'working';
}

// What the agent is doing right now.
function agentSubtitle(a) {
  if (a.detail) return a.detail;
  if (a.needs) return a.needs;
  if (a.intent) return a.intent;
  return a.running ? 'starting up' : 'no activity recorded';
}

// The title is what a person recognises, so it leads. It cannot stand alone:
// every agent a chat starts inherits that chat's title, so the id rides the
// second line as the field that is guaranteed to differ between siblings.
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
  // No cwd: main scopes to the active chat's directory, which is the one whose
  // agents the user is asking about.
  try { res = await window.husk.bgAgents.list({}); } catch (err) { res = { ok: false, error: (err && err.message) || 'could not reach the agent list' }; }
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

// The switcher is behind a chord nobody discovers on their own, so the topbar
// carries a standing count. It stands down only when this project has no agents
// at all: hiding it once the last one finishes takes the only way in with it,
// at exactly the moment there is a finished agent worth reading.
function paintTopbarAgents(res) {
  const el = $('#topbar-agents');
  if (!el) return;
  const agents = res && res.ok !== false && res.supported !== false && Array.isArray(res.agents) ? res.agents : [];
  const live = agents.filter((a) => a && a.running);
  const blocked = live.filter((a) => a.state === 'blocked').length;
  if (!agents.length) { el.hidden = true; return; }
  el.hidden = false;
  const n = live.length || agents.length;
  $('#topbar-agents-count').textContent = String(n);
  $('#topbar-agents-word').textContent = n === 1 ? 'agent' : 'agents';
  const needs = $('#topbar-agents-needs');
  needs.hidden = !blocked;
  needs.textContent = blocked ? `${blocked} needs you` : '';
  el.classList.toggle('is-blocked', !!blocked);
  el.classList.toggle('is-running', !!live.length && !blocked);
  el.classList.toggle('is-idle', !live.length);
  if (!live.length) el.title = `${n} finished agent${n === 1 ? '' : 's'} in this project (Alt+A)`;
  else if (blocked) el.title = `${blocked} of ${n} running agent${n === 1 ? '' : 's'} is waiting on you (Alt+A)`;
  else el.title = `${n} agent${n === 1 ? '' : 's'} running in this project (Alt+A)`;
}

async function refreshTopbarAgents() {
  if (!$('#topbar-agents')) return;
  let res = null;
  try { res = await window.husk.bgAgents.list({}); } catch (_) { res = null; }
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
    // Shape-preserving placeholders: the list has known geometry, so a spinner
    // would say less than the rows it is about to be replaced by. A label
    // placeholder rides along because the loaded list is banded.
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

// A running agent belongs to its worker and cannot be resumed like a chat; the
// tool refuses and says so. Its own agent view is the supported way in, and it
// opens straight onto this agent when told which one. A finished agent has no
// worker left, so it resumes normally.
async function openBgAgent(a) {
  if (agentOpening) return;                    // the tab takes a round trip to appear, so one press is one tab
  agentOpening = true;
  try {
    let res = null;
    try {
      res = await window.husk.bgAgents.openCommand({
        id: a.id, sessionId: a.sessionId, running: !!a.running, cwd: a.cwd || '',
      });
    } catch (err) { res = { ok: false, error: (err && err.message) || 'could not open that agent' }; }
    if (!res || !res.ok) {
      toast((res && res.error) || 'could not open that agent', 'error');
      return;
    }
    setPage('chat');
    const tab = await openNewChatTab({
      command: res.command,
      env: res.env || null,
      cwd: a.cwd || null,
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
$('#topbar-agents').addEventListener('click', () => {
  if ($('#agent-switch').hidden) openAgentSwitch(); else closeAgentSwitch();
});
$('#btn-palette').addEventListener('click', openPalette);
// On the chat page, if focus is on the page body (nothing focused) and a
// printable/edit key is pressed, focus the active terminal first so the
// keystroke goes to it. Capture phase runs before the character is committed,
// so the keystroke reaches the terminal.
document.addEventListener('keydown', (e) => {
  if (currentPage !== 'chat' || !term) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target !== document.body) return;
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
    const map = { '1': 'chat', '2': 'skills', '3': 'sessions', '4': 'files', '5': 'mcp' };
    if (map[e.key]) { e.preventDefault(); setPage(map[e.key]); }
    if (e.key === '6') { e.preventDefault(); openPrefsModal(); }
    // Alt-keyed like the rest of the chrome so it never eats terminal input.
    if (String(e.key || '').toLowerCase() === 'a') {
      e.preventDefault();
      if ($('#agent-switch') && $('#agent-switch').hidden) openAgentSwitch(); else closeAgentSwitch();
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

// Minimal, safe markdown -> HTML. Escapes ALL html first, then layers
// formatting on the already-safe string. Used for workflow step output,
// which is untrusted AI text. Order matters: escape before any tag insertion.
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
// banner vocabularies are matched: an install carried over from the older
// layout still emits the old one.
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
// First-launch onboarding: a three-step full-window flow (welcome → pick CLI →
// preferences). Step 2 detects installed CLI agents on PATH (claude, copilot,
// codex, aider, gemini), lets the user pick one and install missing ones inline
// via npm / pipx. Step 3 sets theme / accent / rail. Finishing persists
// agentCommand, agentName, theme, accent, railExpanded, and firstRunDone.
// Re-openable from Preferences with { replay: true } (does not touch
// firstRunDone). Resolves when the flow is dismissed.
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

  // Skip must not silently commit an agent command that does not exist on
  // this machine: the user's first chat would be a dead terminal. Warn when
  // nothing is installed and nothing was picked.
  async function skipWithGuard() {
    const anyInstalled = !!(detection && Array.isArray(detection.agents) && detection.agents.some((a) => a && a.available));
    if (!selectedCmd && !anyInstalled) {
      const proceed = await openConfirmDialog({
        title: 'No agent CLI found',
        bodyHtml: 'Husk drives a terminal AI agent (claude, copilot, codex, aider...), and none was detected on this system. You can skip now, but chat will not work until one is installed. You can reopen this setup anytime from Preferences.',
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
  await refreshStats();
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
  refreshTopbarAgents();
  setInterval(() => {
    if (document.hidden) return;
    refreshTopbarAgents();
  }, 20000);

  // With skipWelcome on, boot goes straight to a chat, so the welcome screen
  // must never paint. Adding it unconditionally here made it flash for the
  // duration of the reattachSessions() IPC roundtrip before being removed.
  const autoChat = cfg.skipWelcome && !(reloadState && reloadState.suppressAutoChat);
  if (!autoChat) $('#chat-empty').classList.add('show');

  // A renderer reload keeps the main-process PTYs alive; reattach to any open
  // chats so a refresh does not wipe them. Only when there are none do we fall
  // through to the cold-boot behavior (welcome state, or an immediate fresh
  // chat if the user opted to skip the welcome).
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
// The chat header has an Autopilot button that opens a start-dialog. The
// renderer collects goal + caps, asks the supervisor (via IPC) to start a
// run, then shows a live banner above the chat with a Cancel button. When
// the run ends (naturally, by cap, or by user), the supervisor sends an
// autopilot:ended event with the summary; the renderer opens a review
// modal with the diff and a one-click Revert.
let autopilotActive = false;
let autopilotLastSession = null;
// True while a run is being started (snapshot capture + spawn). During this
// window the wizard must not be dismissable: a stray backdrop click or Esc
// must not hide it mid-capture.
let autopilotStarting = false;
// Swarm: all currently active runs. N=1 → existing single-run UX unchanged (ISC-33).
const activeRuns = new Map(); // runId → { runId, sessionId, workspaceRoot, goal, startedAt, caps, budget }
let focusedRunId = null;      // which run the detail pane displays
const autopilotModelDecisions = new Map(); // runId/role → { model, tier, reason }
// '_solo' is a renderer-side placeholder key for legacy starts that carried no
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
// Read one cap field. Empty -> default. A typed 0 is kept as 0, which
// the budget meter treats as "no cap for this metric". Negative or
// non-numeric is invalid: fall back to the default and flag it so the UI
// and the engine never disagree silently.
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
  // Cost guard: caps are PER AGENT, so a team multiplies them; and an
  // uncapped run can burn tokens fast. Confirm before launching without a
  // dollar limit; for a capped team, state the fleet ceiling so "$5" never
  // surprises as $20.
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
  // Stopping a run is destructive to in-flight work, so confirm first.
  // This is the explicit Stop action; the chat autopilot button opens the
  // run view instead, so a stray click cannot end a run by accident.
  // A collab run stops the whole team (main process ends every run in the
  // group); say so in the dialog. Chat sessions are never touched.
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
  // Mount the real Kernel into the hero art once (the slot lives in the hero).
  const kSlot = document.querySelector('.aut-kernel-slot');
  if (kSlot && !kSlot.querySelector('svg')) mountEmptyKernel(kSlot);
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
      const icon = document.createElement('div');
      icon.className = 'aut-preset-icon';
      // eslint-disable-next-line no-unsanitized/property -- inline SVG from a static constant, no user input
      icon.innerHTML = p.icon;
      const title = document.createElement('div');
      title.className = 'aut-preset-title';
      title.textContent = p.title;
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
      card.appendChild(icon);
      card.appendChild(title);
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

// Open the Start-run modal prefilled with a past run's goal + caps.
// Used by the small Rerun button on Recent Runs rows and by the
// Rerun button in review-mode footer. Falls back to defaults if the
// past row lacks caps (older audit logs).
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
// The card is drawn with the Canvas 2D API (no external lib, no network, CSP-
// safe) using a fixed dark palette so it looks identical wherever it is shared,
// independent of the app theme. It shows the agents, their headline metrics,
// and the winner; it never includes the repo path or file names.
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
async function refreshAutopilotHistory() {
  const list = $('#aut-recent');
  const meta = $('#aut-recent-meta');
  const heroRuns = $('#aut-hero-runs');
  const heroFiles = $('#aut-hero-files');
  const heroSpend = $('#aut-hero-spend');
  const heroStats = $('#aut-hero-stats');
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
    if (heroStats) heroStats.hidden = true;
    return;
  }
  const runs = r.runs || [];
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!runs.length) {
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'No prior runs in this project.';
    list.appendChild(empty);
    if (meta) meta.textContent = 'no runs yet';
    // A row of three zeros is a 128px band of nothing. The strip only earns
    // its space once there is a number worth reading.
    if (heroStats) heroStats.hidden = true;
    if (heroRuns) heroRuns.textContent = '0';
    if (heroFiles) heroFiles.textContent = '0';
    if (heroSpend) heroSpend.textContent = '$0';
    return;
  }
  if (heroStats) heroStats.hidden = false;
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
    // Generous hit zone: a full-height label strip on the row's left
    // edge. The row itself opens the run on click, so selection needs a
    // forgiving target; the label toggles the checkbox natively anywhere
    // in the strip.
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
    m2.textContent = `${fmtRelTime(when)} · ${memberText}${run.sessionId.slice(5, 17)}`;
    main.appendChild(goal);
    main.appendChild(m2);
    const files = document.createElement('div');
    files.className = 'aut-recent-files';
    files.textContent = run.fileCount > 0 ? `${run.fileCount} files` : 'no changes';
    const pill = document.createElement('div');
    pill.className = 'aut-recent-pill';
    pill.dataset.status = run.haltReason || run.status || 'ended';
    pill.textContent = run.haltReason || run.status || 'ended';
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
  if (meta) meta.textContent = `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`;
  if (heroRuns) heroRuns.textContent = String(runs.length);
  if (heroFiles) heroFiles.textContent = String(totalFiles);
  if (heroSpend) heroSpend.textContent = formatDollars(totalSpend);
  updateBulkDeleteUi();
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

// Load a past run into the live layout in REVIEW mode. Same panes
// (goal, rings, files, activity) but values are frozen and the
// footer shows Revert / Start-new instead of Stop. Activity feed
// for past runs is summarized (line text is not retained in the
// audit log, only event kinds + char counts).
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

// Autopilot live state. Driven by autopilot:started / autopilot:budget /
// autopilot:activity IPC events plus a 4s poll of autopilot:liveDiff. The
// activity stream is produced in the main process from each run's OWN
// transcript (or its PTY as a fallback), so the feed is always the selected
// run's data, never the focused chat terminal's. Idle detection, nudges, and
// auto-end also live in main next to the run PTYs.
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
// Swarm bar: shown when N > 1 concurrent runs active. Each card lets the user
// switch the detail pane focus, monitor per-run spend, and cancel individually (ISC-23, 25, 32).
// Agents card: one row per agent (live, ended, orchestrator-planned) in
// the cockpit's left rail. Row: color dot, role, state; below it the
// current action and elapsed/$/files. Click focuses/maximizes the lane.
function renderRunCards() {
  const list = document.getElementById('aut-fleet-list');
  if (!list) return;
  // Rebuild the DOM only when the set of agents changes; budget ticks
  // patch the existing nodes in place (updateRunCardsLive) so clicks
  // never land on a node destroyed mid-frame.
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
// Read-only card for a finished agent (persisted post-run record).
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
  // While a run is active OR a review is open, the header Start
  // button is replaced by the status pill; showing both is
  // contradictory.
  if (startBtn) startBtn.hidden = showLive;
  if (stopBtnTop) stopBtnTop.hidden = !autopilotActive;
  // Revert needs a pre-run snapshot. Runs started with the snapshot toggle
  // off carry hasSnapshot === false, so the Revert button stays hidden even
  // in review (older runs without the field are treated as snapshotted).
  const reviewHasSnapshot = !(autopilotReviewData && autopilotReviewData.summary
    && autopilotReviewData.summary.hasSnapshot === false);
  // A retained run has a live worktree awaiting Apply/Discard. Its changes are
  // NOT in the workspace yet, so the snapshot-era buttons (Revert/Rerun/New)
  // are hidden in favor of Apply/Discard. Historical reviews (worktree already
  // gone) keep the snapshot-era buttons.
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
// Close the topmost open modal the way the modal itself would: its own
// close button when it has one (state cleanup runs), else the backdrop
// click contract every modal follows. The confirm dialog manages its own
// promise lifecycle and Esc handling, so it is left alone.
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
    // Open modals are closed by the document-level Esc closer (it runs
    // first in the capture chain); acting here too would close two
    // stacked layers on one keypress.
    if (paletteOpen() || anyModalOpen()) return;
    if (typing) return;
    if (autopilotPageVisible() && autopilotReview) { exitReviewMode(); e.preventDefault(); }
  } else if (e.key === 'ArrowLeft' && e.altKey && !typing) {
    if (globalBack()) e.preventDefault();
  } else if (e.key === 'ArrowRight' && e.altKey && !typing) {
    if (globalForward()) e.preventDefault();
  }
});
function enterReviewMode({ sessionId, workspaceRoot, summary, retained = false, runId = null, members = null }) {
  // Remember the hub scroll position so back returns to the same spot
  // in the runs list.
  const pageEl0 = document.querySelector('.page-autopilot');
  if (pageEl0 && !autopilotReview) autopilotHubScroll = pageEl0.scrollTop;
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
  // Goal lives in the start_run row (summary.goal). The run_summary
  // payload (s) carries final meter/diff but not the goal. Use the
  // start_run goal as truth; fall back ONLY if even that is missing.
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
  renderTimeline();
  paintAutopilotBanner();
}
// Conclusion card appended to the feed when a run is reviewed: why it
// ended, the final numbers, and the agent's last narration as its report.
// Older summaries loaded from History lack finalMessage; the card then
// shows outcome and metrics only.
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
// Fleet Receipt: one shareable card summarizing the whole fleet -- total
// spend, what landed, and the waste the governor caught. Built from the
// autopilot:receipt IPC and rendered in the review lane. Reuses the
// conclusion card's classes so it inherits the theme; adds a Copy button
// so the headline is one click from a tweet.
async function showFleetReceipt(members) {
  try {
    const runs = (Array.isArray(members) ? members : []).filter((m) => m && m.sessionId);
    if (!runs.length) return;
    const res = await window.husk.autopilot.receipt({ runs });
    if (!res || !res.ok || !res.receipt) return;
    renderFleetReceipt(res.receipt);
    // For a real fleet, the MISSION panel must show the FLEET total, not the
    // single reviewed agent -- otherwise the panel (one agent) and the
    // receipt (all agents) disagree and the user cannot tell which is real.
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
  card.style.borderLeft = `2px solid ${incomplete ? 'var(--warn, #f59e0b)' : 'var(--accent, #67e8f9)'}`;

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
  // Always render as $X.YY so the unit is unambiguous. Under a cent
  // we still show two decimal places ($0.00) rather than a different
  // glyph (the cents sign rendered as a fallback square in some fonts).
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
    // The headline is the quantity the cap ring measures, so the two agree.
    // Cache reads sit outside it: they are the cached prefix re-sent on every
    // request, so across 160 requests they reach millions while the context
    // window never grows, and folding them in would read as work that happened.
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
    // The headline is the quantity the cap ring measures, so the two agree.
    // Cache reads sit outside it: they are the cached prefix re-sent on every
    // request, so across a fleet they reach millions while the context window
    // never grows, and folding them in would read as work that happened.
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
// Cache-aware token split under the headline count. Cache reads dominate the
// raw token number but bill at a tenth, so showing the split is how the user
// sees the dollar figure is real, not a flat per-token guess. 'exact' means
// the numbers came from the agent's structured transcript (input/output/cache
// deltas), 'approx' means a status-line cumulative or a chars/4 estimate.
function renderTokenBreakdown(brk) {
  const box = document.getElementById('aut-token-breakdown');
  if (!box) return;
  const total = brk.input + brk.output + brk.cw + brk.cr;
  if (!total) { box.hidden = true; return; }
  box.hidden = false;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = formatTokens(v); };
  // The headline counts every tier, so a cancelled 27s run can read half a
  // million tokens while the model generated almost nothing. Cache writes are
  // the context each agent loads before doing any work, and across a fleet they
  // are the bulk of the number. Splitting them out under the count is what
  // stops it being read as work that happened.
  const split = document.getElementById('aut-page-split-tokens');
  if (split) {
    const generated = brk.input + brk.output;
    const context = brk.cw + brk.cr;
    if (context > generated) {
      split.hidden = false;
      // Say what each quantity IS, because the totals invite the wrong reading.
      // Context is loaded once per agent and is small. Cache reads are that same
      // prefix re-sent on every request, so they climb into the millions across a
      // few hundred requests while the context window never grows. Saying "6.1M
      // context" implied 6.1M was loaded, which contradicted the per-agent figure
      // printed beside it.
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
// Spinner dedupe: claude cycles glyphs ("* Foo...", "+ Foo...",
// "· Foo...") to indicate liveness. Treat lines with the same
// semantic content (after stripping leading non-word chars) as one
// row that flashes on each tick instead of appending duplicates.
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
// SPAWNED AGENTS panel keeps showing what each agent did (model, tokens, cost,
// cache split, files, how it ended) after the run instead of going blank.
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
  // The count belongs to this card, so it reports what this card renders. The
  // run-log feed counts a different stream, and sourcing the number from there
  // puts a non-zero count above an empty timeline on a reviewed run.
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
// Legacy entry point: route untyped lines into a lane. Tool lines carry
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
  // The rail passes the owning run's session explicitly: in a team every
  // agent has its own worktree, so the focused session is the wrong one
  // for every lane but the focused agent's.
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
  // While a run is active this button takes the user to the run view, it
  // does NOT stop the run. Stopping is the explicit Stop button on the
  // autopilot page (which confirms).
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
      // starts after all workers ended, so liveRunCount() is briefly zero;
      // keep those ended workers or fleet tokens/files collapse to "integrator
      // only" mid-run.
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
          // Apply/Discard rather than the snapshot-era Revert.
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
        // Name the exit code so an unexpected death (vs a clean quit) is
        // legible: a run that vanishes the instant a chat agent launches
        // reads as "agent exited (code N)", not a silent disappearance.
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

// Dedicated Autopilot page buttons. The header Start and the empty-state
// CTA both open the existing start-run modal. The Stop button cancels
// the active run (SIGINT into the PTY via the IPC handler).
$('#aut-page-start') && $('#aut-page-start').addEventListener('click', () => {
  if (autopilotActive) { toast('A run is already active', 'info'); return; }
  openAutopilotStart();
});
$('#aut-page-start-2') && $('#aut-page-start-2').addEventListener('click', () => {
  if (autopilotActive) return;
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
  // Pull the real goal + caps from the start_run row (now surfaced
  // at top level on the summary payload). Do NOT fall back to
  // autopilotState.goal: that holds the display string which may be
  // the placeholder "(no goal recorded)" for runs missing data.
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

// Global ESC handler: closes any visible `.modal` element. This is the
// universal "ESC dismisses the wizard" contract, applied across every
// modal Husk has today (create agent, create MCP, edit MCP, install
// from repo, import agents, create project, create prompt, create
// skill, confirm prompts, first-run wizard) and every modal we ship
// in the future without per-dialog wiring. Per-modal ESC handlers
// (palette, sessions detail-panel, skill modal close) run first
// because they were registered earlier; if they have already hidden
// their target, this handler finds nothing to do.
//
// We skip on composition events so an IME's ESC-to-dismiss-popup
// keeps working without closing the surrounding modal.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return;
  let open = $$('.modal:not([hidden])');
  // The autopilot wizard is locked while a run is launching; Esc must not
  // tear it down mid-capture.
  if (autopilotStarting) open = open.filter((m) => m.id !== 'autopilot-start-modal');
  if (!open.length) return;
  // DOM order is install-order for these dialogs; the LAST visible
  // one is the most recently opened (e.g. a confirm-modal layered on
  // top of a create-modal). Close just that one so a confirm dismisses
  // before its parent.
  open[open.length - 1].hidden = true;
});

requestAnimationFrame(() => boot());
