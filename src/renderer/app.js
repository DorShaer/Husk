// Husk renderer orchestrator.
// Pages: chat, skills, sessions, files, preferences.
// Includes: command palette, theme toggle, drag overlay, status panel.

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

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
function dismissNotif(card) {
  if (!card || card._dismissing) return;
  card._dismissing = true;
  if (card._timer) clearTimeout(card._timer);
  card.classList.add('is-out');
  setTimeout(() => { try { card.remove(); } catch (_) {} }, 200);
}
// Core entry. opts: { title, kind, prominent, ttl }
function notify(message, opts = {}) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const kind = opts.kind || '';
  const iconName = opts.icon || (opts.prominent ? 'done' : (kind || 'info'));
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
  // Cap the stack: drop the oldest beyond the limit.
  while (stack.children.length > NOTIF_MAX) dismissNotif(stack.lastElementChild);
  // Auto-dismiss with hover-to-pause.
  const ttl = opts.ttl || NOTIF_TTL[kind] || NOTIF_TTL[''];
  const arm = () => { card._timer = setTimeout(() => dismissNotif(card), ttl); };
  arm();
  card.addEventListener('mouseenter', () => { if (card._timer) clearTimeout(card._timer); });
  card.addEventListener('mouseleave', () => { if (!card._dismissing) arm(); });
  return card;
}
// Back-compatible API used across the renderer.
function toast(msg, kind = '') { notify(msg, { kind }); }
// Run-completion notification: a prominent card with a title.
function runEndBanner(msg, kind = '') {
  // Map the run outcome to a notification style.
  const k = kind === 'budget' ? 'warn' : (kind === 'stopped' ? '' : 'success');
  notify(msg, { kind: k, prominent: true, title: 'Autonomy run', icon: kind === 'budget' ? 'warn' : 'done', ttl: 6000 });
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
    '<div style="position:fixed;inset:0;background:#0b0d12;color:#fb7185;padding:24px;font-family:monospace;z-index:9999">Init failure: xterm or husk API not loaded.</div>');
  throw new Error('init failure');
}

// ─── State ───────────────────────────────────────────────────────────────────────
let cfg = null;
let huskHome = '~';
let lastStats = null;
let currentPage = 'chat';
let chatHasInput = false;

// ─── Terminal (persistent across page switches) ──────────────────────────────────
const term = new Terminal({
  cursorBlink: true,
  fontFamily: '"JetBrains Mono", "Fira Code", "Menlo", "Consolas", monospace',
  fontSize: 13,
  theme: themeForXterm(),
});
const fitAddon = new FitAddon.FitAddon();
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
const linksAddon = new WebLinksAddon.WebLinksAddon(openTerminalLink);
term.loadAddon(fitAddon);
term.loadAddon(linksAddon);
term.options.linkHandler = { activate: openTerminalLink };
term.open($('#terminal'));

// Wheel forwarding for full-screen agents. A TUI like copilot runs in the
// alternate screen (no terminal scrollback) and turns mouse reporting on so it
// can scroll its OWN transcript. Husk strips that reporting upstream so
// drag-to-select stays local, which also stops the agent from receiving the
// wheel. So when the agent has reporting on, forward only the wheel to it as
// scroll input; otherwise let xterm scroll its scrollback normally. Capture
// phase + passive:false so we intercept before xterm and can preventDefault.
let agentMouseOn = false;
window.husk.pty.onMouseMode((on) => { agentMouseOn = !!on; });
$('#terminal').addEventListener('wheel', (e) => {
  if (!agentMouseOn) return;
  const screen = $('#terminal').querySelector('.xterm-screen');
  if (!screen) return;
  const rect = screen.getBoundingClientRect();
  const cw = rect.width / term.cols || 1;
  const ch = rect.height / term.rows || 1;
  let col = Math.floor((e.clientX - rect.left) / cw) + 1;
  let row = Math.floor((e.clientY - rect.top) / ch) + 1;
  col = Math.min(Math.max(col, 1), term.cols);
  row = Math.min(Math.max(row, 1), term.rows);
  window.husk.pty.wheel({ deltaY: e.deltaY, deltaMode: e.deltaMode, col, row });
  e.preventDefault();
  e.stopPropagation();
}, { capture: true, passive: false });

function themeForXterm() {
  // The terminal runs a TUI agent that themes its output through the 16 ANSI
  // colors. Each app theme gets a matching palette so the output is readable
  // on its own background: a dark-on-light palette in light mode, a
  // light-on-dark one in dark mode. Read after body[data-theme] is set.
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ff7847';
  const isLight = document.body.getAttribute('data-theme') === 'light';
  if (isLight) {
    // Dark, saturated colors readable on a white background. The dim
    // greys agents use for hints (brightBlack) become a mid grey, not a
    // near-white that vanishes.
    return {
      background: '#ffffff', foreground: '#1f2328',
      cursor: accent, cursorAccent: '#ffffff',
      selectionBackground: '#cfe3ff',
      black: '#1f2328', red: '#cf222e', green: '#116329', yellow: '#7d4e00',
      blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
      brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#8250df',
      brightCyan: '#1b7c83', brightWhite: '#1f2328',
    };
  }
  return {
    background: '#0b0d12', foreground: '#e6e9ef',
    cursor: accent, cursorAccent: '#0b0d12',
    selectionBackground: '#2d3447',
    black: '#0b0d12', red: '#fb7185', green: '#4ade80', yellow: '#fbbf24',
    blue: '#818cf8', magenta: '#a78bfa', cyan: '#67e8f9', white: '#e6e9ef',
    brightBlack: '#475063', brightRed: '#fda4af', brightGreen: '#86efac',
    brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#c4b5fd',
    brightCyan: '#a5f3fc', brightWhite: '#f1f5f9',
  };
}

function fitNow() {
  if (currentPage !== 'chat') return;
  try {
    fitAddon.fit();
    const { cols, rows } = term;
    window.husk.pty.resize({ cols, rows });
  } catch (_) {}
}
// Refit on resize. A trailing debounce coalesces the rapid resize burst
// from a window drag into one fit so the terminal reflow stays smooth.
window.addEventListener('resize', debounce(fitNow, 80));
term.onData((d) => {
  chatHasInput = true;
  $('#chat-empty').classList.remove('show');
  // Enter (or pasted newline) ends a user turn; allow that turn's recap.
  if (/[\r\n]/.test(d)) armRecap();
  window.husk.pty.write(d);
  term.scrollToBottom();
});

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
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const meta = isMac ? e.metaKey : (e.ctrlKey && e.shiftKey);
  if (meta && (e.key === 'c' || e.key === 'C')) {
    if (term.hasSelection()) { copyTerminalSelection(); return false; }
  }
  return true;
});
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

// Coalesce PTY output into one xterm write per animation frame. A
// chatty agent emits many chunks in quick succession; writing each one
// separately (with its own scroll callback and speech scan) burned CPU
// and janked scrolling. Buffering to the next frame collapses a burst
// into a single write + single scroll + single speech scan.
let _termWriteBuf = '';
let _termFlushScheduled = false;
function _flushTermWrite() {
  _termFlushScheduled = false;
  if (!_termWriteBuf) return;
  const data = _termWriteBuf;
  _termWriteBuf = '';
  // Follow the tail only when the user is already pinned to the bottom. If they
  // scrolled up to read while the agent is still streaming, leave the viewport
  // where it is instead of yanking it back down on every chunk. (In the alt
  // screen there is no scrollback, so viewportY/baseY are both 0 and this stays
  // pinned -- copilot's own wheel-forwarded scrolling is unaffected.)
  const buf = term.buffer.active;
  const wasAtBottom = buf.viewportY >= buf.baseY;
  term.write(data, () => { if (wasAtBottom) term.scrollToBottom(); });
  detectAndSpeak(data);
}
window.husk.pty.onData((d) => {
  if (!chatHasInput) {
    chatHasInput = true;
    $('#chat-empty').classList.remove('show');
  }
  if (_restartInProgress) return;
  _termWriteBuf += d;
  if (!_termFlushScheduled) { _termFlushScheduled = true; requestAnimationFrame(_flushTermWrite); }
});
window.husk.pty.onExit((code) => {
  // Suppress the exit notice when we're tearing the old PTY down on purpose,
  // otherwise the line stitches into the new PTY's welcome banner.
  if (_restartInProgress) return;
  term.writeln(`\r\n\x1b[38;2;106;115;133m[agent exited code ${code}; click ↻ Restart]\x1b[0m`);
});

// Set true while we are killing the old PTY and spawning a new one. Renderer
// ignores all PTY output and exit events during this window so the dying
// PTY's tail output ("killing shell... killed", "[agent exited code 0]") and
// the new PTY's welcome banner do not interleave in xterm's single buffer.
let _restartInProgress = false;

function announceInTerminal(msg) {
  term.writeln(`\r\n\x1b[38;2;103;232;249m▸ ${msg}\x1b[0m`);
}

async function startPty() {
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
  await window.husk.pty.start({ cols, rows });
  term.focus();
  // Inject ai-suggested workflow context so the AI knows what workflows exist
  try {
    const wfCtx = await window.husk.workflows.getSessionContext();
    if (wfCtx) {
      setTimeout(() => {
        try { window.husk.pty.write(wfCtx + '\n'); } catch (_) {}
      }, 800);
    }
  } catch (_) {}
  // Snapshot which MCPs were enabled at launch so the MCP page can split
  // them into Loaded vs Pending, and the welcome screen can show what's live.
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
}
async function restartPty(opts = {}) {
  _restartInProgress = true;
  fitAddon.fit();
  const { cols, rows } = term;
  chatHasInput = false;
  resetSpeechState();
  clearSessionContext();
  // First wipe so any earlier scrollback is gone before kill output starts.
  try { term.reset(); } catch (_) { try { term.clear(); } catch (_) {} }
  await window.husk.pty.restart({ cols, rows, command: opts.command || null, cwd: opts.cwd || null });
  // Let the dying PTY drain its tail notice into the (suppressed) handlers
  // before we re-enable output. Claude's welcome banner takes >300ms to
  // produce, so a 200ms quiet window does not cut into it.
  await new Promise((r) => setTimeout(r, 200));
  // Second wipe: clears anything that wrote to the buffer despite suppression
  // (e.g. xterm internal sequences from the kill), so the new PTY's banner
  // starts on a clean canvas.
  try { term.reset(); } catch (_) {}
  _restartInProgress = false;
  // Respect the "Don't show this on next launch" toggle on restart too;
  // otherwise the welcome briefly flashes in (added here) and out again
  // (stripped by the first pty.onData tick once the new agent banner
  // arrives), which reads as a layout glitch.
  if (!cfg.skipWelcome) $('#chat-empty').classList.add('show');
  term.focus();
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
  if (!opts.silent) toast('New session', 'success');
}

// ─── Theme + accent ─────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  try { term.options.theme = themeForXterm(); } catch (_) {}
  // Theme icon swap is now handled via CSS based on body[data-theme]; the
  // legacy #theme-icon span is gone. This function intentionally only sets
  // the dataset attribute, the moon/sun SVGs are toggled by selectors.
}
function applyAccent(accent) {
  const valid = ['orange', 'cyan', 'indigo', 'emerald', 'rose'];
  const a = valid.includes(accent) ? accent : 'orange';
  document.body.dataset.accent = a;
  try { term.options.theme = themeForXterm(); } catch (_) {}
  $$('.accent-swatch').forEach((sw) => sw.classList.toggle('selected', sw.dataset.c === a));
}

// ─── Router ──────────────────────────────────────────────────────────────────────
function setPage(name) {
  if (!['chat', 'agents', 'workflows', 'autonomy', 'projects', 'prompts', 'skills', 'sessions', 'files', 'mcp', 'preferences'].includes(name)) name = 'chat';
  currentPage = name;
  document.body.dataset.page = name;
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== name; });
  $$('.rail-item').forEach((it) => it.classList.toggle('active', it.dataset.page === name));
  if (name === 'chat') { setTimeout(fitNow, 30); term.focus(); }
  if (name === 'agents') renderAgents();
  if (name === 'workflows') renderWorkflows();
  if (name === 'autonomy') renderAutonomyPage();
  if (name === 'projects') renderProjects();
  if (name === 'prompts') renderPrompts();
  if (name === 'skills') renderSkills();
  if (name === 'sessions') renderSessions();
  if (name === 'files') { $('#files-root').value = cfg.treeRoot; $('#files-hidden').checked = !!cfg.showHidden; renderTree(cfg.treeRoot); }
  if (name === 'mcp') renderMcp();
}

$$('.rail-item').forEach((b) => b.addEventListener('click', () => setPage(b.dataset.page)));

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
$('#rail-toggle').addEventListener('click', async () => {
  const expanded = document.body.dataset.rail === 'expanded';
  document.body.dataset.rail = expanded ? 'collapsed' : 'expanded';
  // Force-close the agent dropdown so it can never strand-open inside the
  // narrow collapsed rail (would render as a wrapping text column overlay).
  if (typeof closeAgentMenu === 'function') closeAgentMenu();
  syncRailToggleTitle();
  cfg = await window.husk.config.set({ railExpanded: !expanded });
  setTimeout(fitNow, 200);
});

const spToggle = $('#sp-toggle');
if (spToggle) {
  spToggle.addEventListener('click', async () => {
    const collapsed = document.body.dataset.status === 'collapsed';
    document.body.dataset.status = collapsed ? 'expanded' : 'collapsed';
    syncStatusToggleTitle();
    cfg = await window.husk.config.set({ statusCollapsed: !collapsed });
    setTimeout(fitNow, 200);
  });
}

// ─── Stats + status bar ──────────────────────────────────────────────────────────
async function refreshStats() {
  try {
    const s = await window.husk.stats.get();
    lastStats = s;
    $('#skills-sub').textContent = `${s.skills} skills installed at ~/.claude/skills/`;
    $('#sessions-sub').textContent = `claude sessions at ~/.claude/projects/ · click to preview, Resume to continue`;
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
function sparkHTML(values) {
  if (!values || !values.length) return '<div class="sp-spark"></div>';
  const max = 10;
  return `<div class="sp-spark">${values.map((v) => {
    const h = Math.max(8, Math.min(100, Math.round((v / max) * 100)));
    const color = ratingColor(v);
    return `<div class="sp-spark-bar" style="height:${h}%; background:${color};"></div>`;
  }).join('')}</div>`;
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
  // Pretty fallback: "Asia/Jerusalem" -> "Jerusalem", "America/New_York" -> "New York".
  const tzPretty = tz.includes('/') ? tz.split('/').pop().replace(/_/g, ' ') : tz;
  const headline = here || tzPretty || '';
  const weatherStr = s.weather && s.weather.temp
    ? `${s.weather.temp}°C${s.weather.condition ? ' · ' + s.weather.condition : ''}`
    : '';
  const u = s.usage || {};
  const L = s.learning || {};
  // The active agent's model, sourced from its session log. Trim a leading
  // vendor prefix so the readout stays compact (e.g. "opus-4-8"). Empty when
  // no model is known, which hides the row.
  const modelLabel = ((u.session && u.session.model) || '').replace(/^claude-/, '');

  const html = `
    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">◷</span><span>Where</span></div>
      <div class="sp-section-body">
        ${headline ? `<div><strong>${escapeHtml(headline)}</strong></div>` : ''}
        <div class="sp-row"><span class="sp-muted">Time</span><span class="sp-mono">${time}</span></div>
        ${weatherStr ? `<div class="sp-row"><span class="sp-muted">Weather</span><span class="sp-mono">${escapeHtml(weatherStr)}</span></div>` : ''}
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">▣</span><span>Build</span></div>
      <div class="sp-section-body">
        <div class="sp-row"><span class="sp-muted">Claude</span><span class="sp-mono">2.1.129</span></div>
        ${modelLabel ? `<div class="sp-row"><span class="sp-muted">Model</span><span class="sp-mono sp-accent" title="${escapeHtml((u.session && u.session.model) || '')}">${escapeHtml(modelLabel)}</span></div>` : ''}
        <div class="sp-row"><span class="sp-muted">Husk</span><span class="sp-mono">${escapeHtml(s.huskVer || '0.2')}</span></div>
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">⌬</span><span>Tools</span></div>
      <div class="sp-section-body">
        <div class="sp-row sp-clickable" data-open="skills"><span class="sp-muted">Skills</span><span class="sp-mono sp-accent">${escapeHtml(s.skills)}</span></div>
        <div class="sp-row sp-clickable" data-open="workflows"><span class="sp-muted">Workflows</span><span class="sp-mono sp-accent">${escapeHtml(s.workflows)}</span></div>
        <div class="sp-row sp-clickable" data-open="hooks"><span class="sp-muted">Hooks</span><span class="sp-mono sp-accent">${escapeHtml(s.hooks)}</span></div>
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">⏱</span><span>Usage</span></div>
      <div class="sp-section-body">
        ${u.cache_present ? `
        <div class="sp-row"><span class="sp-muted">5h</span><span class="sp-mono">${fmtPct(u.h5_pct)}</span></div>
        <div class="sp-progress"><div class="sp-progress-fill" style="width:${Math.min(100, u.h5_pct||0)}%"></div></div>
        ${u.h5_reset ? `<div class="sp-row"><span class="sp-muted">Resets</span><span class="sp-mono" title="${escapeHtml(u.h5_reset)}">${escapeHtml(fmtUntil(u.h5_reset))}</span></div>` : ''}
        <div class="sp-row" style="margin-top:6px;"><span class="sp-muted">Weekly</span><span class="sp-mono">${fmtPct(u.week_pct)}</span></div>
        <div class="sp-progress"><div class="sp-progress-fill" style="width:${Math.min(100, u.week_pct||0)}%"></div></div>
        ${u.week_reset ? `<div class="sp-row"><span class="sp-muted">Resets</span><span class="sp-mono" title="${escapeHtml(u.week_reset)}">${escapeHtml(fmtUntil(u.week_reset))}</span></div>` : ''}
        ` : `
        <div class="sp-row"><span class="sp-muted">5h / Weekly</span><span class="sp-mono sp-muted">warming up…</span></div>
        <div class="sp-row sp-tiny sp-muted">Refreshing every 30s from your Anthropic OAuth token; first sample takes a few seconds after launch.</div>
        `}
        ${u.session ? `
        <div class="sp-divider"></div>
        <div class="sp-row"><span class="sp-muted">Session turns</span><span class="sp-mono sp-accent">${escapeHtml(u.session.turns)}</span></div>
        <div class="sp-row"><span class="sp-muted">Session tokens</span><span class="sp-mono sp-accent">~${escapeHtml(fmtThousands(u.session.tokens))}</span></div>
        ` : ''}
        ${(u.api_cost || u.extra_used || u.session_cost) ? `
        <div class="sp-divider"></div>
        ${u.api_cost ? `<div class="sp-row"><span class="sp-muted">API</span><span class="sp-mono">$${escapeHtml(u.api_cost)}</span></div>` : ''}
        ${u.extra_limit ? `<div class="sp-row"><span class="sp-muted">Extra</span><span class="sp-mono">$${escapeHtml(u.extra_used)}/$${escapeHtml(u.extra_limit)}</span></div>` : ''}
        ${u.session_cost ? `<div class="sp-row"><span class="sp-muted">Session $</span><span class="sp-mono">${escapeHtml(String(u.session_cost))}</span></div>` : ''}
        ` : ''}
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">◎</span><span>Memory</span></div>
      <div class="sp-section-body">
        <div class="sp-row sp-clickable" data-open="sessions"><span class="sp-muted">Sessions</span><span class="sp-mono sp-accent">${s.sessions}</span></div>
        <div class="sp-row sp-clickable" data-open="ratings"><span class="sp-muted">Ratings</span><span class="sp-mono sp-accent">${s.ratings}</span></div>
        <div class="sp-row sp-clickable" data-open="work"><span class="sp-muted">Work</span><span class="sp-mono sp-accent">${s.sessions}</span></div>
        <div class="sp-row sp-clickable" data-open="research"><span class="sp-muted">Research</span><span class="sp-mono sp-accent">${s.research}</span></div>
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">✿</span><span>Learning</span></div>
      <div class="sp-section-body">
        ${L.latest != null ? `<div class="sp-row"><span class="sp-muted">Latest</span><span class="sp-mono" style="color:${ratingColor(L.latest)}; font-weight:600;">${L.latest} · ${escapeHtml(L.latestSource||'auto')}</span></div>` : ''}
        ${L.avg1h != null ? `<div class="sp-row"><span class="sp-muted">1h</span><span class="sp-mono" style="color:${ratingColor(L.avg1h)};">${L.avg1h}</span></div>` : ''}
        ${L.avg1d != null ? `<div class="sp-row"><span class="sp-muted">1d</span><span class="sp-mono" style="color:${ratingColor(L.avg1d)};">${L.avg1d}</span></div>` : ''}
        ${L.avg1w != null ? `<div class="sp-row"><span class="sp-muted">1w</span><span class="sp-mono" style="color:${ratingColor(L.avg1w)};">${L.avg1w}</span></div>` : ''}
        ${L.avg1mo != null ? `<div class="sp-row"><span class="sp-muted">1mo</span><span class="sp-mono" style="color:${ratingColor(L.avg1mo)};">${L.avg1mo}</span></div>` : ''}
        ${L.recent && L.recent.length ? sparkHTML(L.recent) : ''}
        ${(L.latest == null && L.avg1h == null && L.avg1d == null && L.avg1w == null && L.avg1mo == null) ? `<div class="sp-row sp-tiny sp-muted">No ratings yet · sessions you rate will land here.</div>` : ''}
      </div>
    </div>
  `;

  // eslint-disable-next-line no-unsanitized/property -- Template content is escaped or trusted static markup.
  $('#sp-content').innerHTML = html;
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
    });
  });
}

// ─── Projects page ─────────────────────────────────────────────────────────────
let projectsCache = [];
let activeProjectId = null;

async function renderProjects() {
  const grid = $('#projects-grid');
  if (!grid) return;
  // eslint-disable-next-line no-unsanitized/property -- Static loading template.
  grid.innerHTML = '<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">Loading projects…</div></div>';
  const res = await window.husk.projects.list();
  if (!res || !res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${escapeHtml((res && res.error) || 'Unknown error')}</div></div>`;
    return;
  }
  projectsCache = res.projects || [];
  activeProjectId = res.activeProjectId || null;
  paintProjects(projectsCache, ($('#projects-search') || {}).value || '');
}

function fmtRelTime(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!isFinite(t)) return iso;
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

function paintProjects(items, filter) {
  const grid = $('#projects-grid');
  if (!grid) return;
  const q = (filter || '').toLowerCase().trim();
  const filtered = q
    ? items.filter((p) => (p.name + ' ' + p.path).toLowerCase().includes(q))
    : items;
  if (!filtered.length) {
    const msg = q
      ? `No projects match "${escapeHtml(q)}"`
      : `No projects yet. Click + Add project to pin a folder.`;
    // eslint-disable-next-line no-unsanitized/property -- escapeHtml on dynamic part.
    grid.innerHTML = `<div class="empty-state"><div class="es-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg></div><div class="es-msg">${msg}</div></div>`;
    return;
  }
  const cards = filtered.map((p) => {
    const isActive = p.id === activeProjectId;
    return `
      <div class="project-card${isActive ? ' is-active' : ''}" data-id="${escapeHtml(p.id)}" tabindex="0">
        <button class="card-delete project-delete" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Delete project" aria-label="Delete project"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
        <div class="project-card-head">
          <div class="project-card-title">${escapeHtml(p.name)}</div>
          ${isActive ? '<span class="project-card-pill">active</span>' : ''}
        </div>
        <div class="project-card-path" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</div>
        <div class="project-card-meta">last used ${escapeHtml(fmtRelTime(p.lastUsedAt))}</div>
        <div class="project-card-actions">
          ${isActive ? `<button class="card-cta project-leave" title="Work with no project; the agent runs in your home folder">Switch to no project</button>` : ''}
          <button class="card-cta project-open" data-id="${escapeHtml(p.id)}" title="${isActive ? 'Restart the agent in this project' : 'Switch to this project'}">${isActive ? 'Reopen' : 'Open'}<svg class="card-cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
        </div>
      </div>
    `;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
  grid.innerHTML = cards;
  grid.querySelectorAll('.project-open').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openProject(e.currentTarget.dataset.id); }));
  grid.querySelectorAll('.project-leave').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); clearActiveProject(); }));
  grid.querySelectorAll('.project-delete').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProject(e.currentTarget.dataset.id, e.currentTarget.dataset.name); }));
  grid.querySelectorAll('.project-card').forEach((card) => card.addEventListener('click', (e) => {
    if (e.target.closest('.project-card-actions') || e.target.closest('.card-delete')) return;
    openProject(card.dataset.id);
  }));
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
  projectsCache = res.projects || [];
  activeProjectId = res.activeProjectId || null;
  updateActiveProjectChip();
  if (currentPage === 'projects') paintProjects(projectsCache, ($('#projects-search') || {}).value || '');
  // Refresh chat-sub since the agent cwd may have changed.
  try { cfg = await window.husk.config.get(); } catch (_) {}
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
  if (search) search.addEventListener('input', debounce(() => paintProjects(projectsCache, search.value), 120));

  const newBtn = document.getElementById('btn-projects-new');
  const modal = document.getElementById('new-project-modal');
  const nameEl = document.getElementById('npj-name');
  const pathEl = document.getElementById('npj-path');
  const pickEl = document.getElementById('npj-pick');
  const cancelBtn = document.getElementById('npj-cancel');
  const createBtn = document.getElementById('npj-create');
  // Renamed from `open` / `close` because in non-strict mode a function
  // declaration in a block hoists to the script scope and shadows the
  // global window.open / window.close. xterm's link click path calls
  // window.open(), so without the rename the local function was running
  // in place of the browser builtin and opening the project modal.
  function openProjectModal() {
    if (!modal) return;
    if (nameEl) nameEl.value = '';
    if (pathEl) pathEl.value = '';
    modal.hidden = false;
    setTimeout(() => { try { nameEl && nameEl.focus(); } catch (_) {} }, 30);
  }
  function closeProjectModal() { if (modal) modal.hidden = true; }
  async function submit() {
    let name = (nameEl && nameEl.value || '').trim();
    const projPath = (pathEl && pathEl.value || '').trim();
    if (!name && projPath) name = projPath.split('/').filter(Boolean).pop() || 'project';
    const res = await window.husk.projects.create({ name, path: projPath });
    if (!res || !res.ok) {
      const t = document.getElementById('toast');
      if (t) { t.textContent = (res && res.error) || 'Could not add project'; t.hidden = false; setTimeout(() => { t.hidden = true; }, 3500); }
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
    try { const picked = await window.husk.dialog2.pickDir(); if (picked && pathEl) pathEl.value = picked; } catch (_) {}
  });
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeProjectModal(); });

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
  wfShowView('list');
  const grid = $('#wf-grid');
  if (!grid) return;
  workflowsCache = await window.husk.workflows.list();
  paintWorkflowList();
}

function paintWorkflowList() {
  const grid = $('#wf-grid');
  if (!grid) return;
  if (!workflowsCache.length) {
    // eslint-disable-next-line no-unsanitized/property
    grid.innerHTML = `<div class="empty-state"><div class="es-icon"></div><div class="es-title">No workflows yet</div><div class="es-msg">Build a pipeline by chaining agents together. Each step feeds its output to the next.</div></div>`;
    return;
  }
  // eslint-disable-next-line no-unsanitized/property
  grid.innerHTML = workflowsCache.map((w) => `
    <div class="wf-card" data-id="${escapeHtml(w.id)}">
      <button class="card-delete wf-card-delete" data-id="${escapeHtml(w.id)}" data-name="${escapeHtml(w.name)}" title="Delete workflow" aria-label="Delete workflow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      <div class="wf-card-head">
        <div class="wf-card-title">${escapeHtml(w.name)}</div>
        <div class="wf-card-meta">
          ${(() => { const n = ((w.graph && w.graph.nodes) || []).length; return `<span class="wf-card-steps-count">${n} step${n !== 1 ? 's' : ''}</span>`; })()}
          ${w.trigger === 'ai-suggested' ? `<span class="wf-card-trigger-pill">AI suggested</span>` : ''}
        </div>
      </div>
      ${w.description ? `<div class="wf-card-desc">${escapeHtml(w.description)}</div>` : ''}
      <div class="wf-card-actions">
        <button class="ghost-link wf-edit-btn" data-id="${escapeHtml(w.id)}">Edit</button>
        <button class="card-cta wf-run-btn" data-id="${escapeHtml(w.id)}">Run<svg class="card-cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('.wf-run-btn').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); runWorkflow(e.currentTarget.dataset.id); }));
  grid.querySelectorAll('.wf-edit-btn').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openWorkflowBuilder(e.currentTarget.dataset.id); }));
  grid.querySelectorAll('.wf-card-delete').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deleteWorkflow(e.currentTarget.dataset.id, e.currentTarget.dataset.name); }));
}

async function deleteWorkflow(id, name) {
  const confirmed = await openConfirmDialog({
    title: 'Delete workflow?',
    bodyHtml: `Permanently delete <strong>${escapeHtml(name || 'this workflow')}</strong>.`,
    confirmLabel: 'Delete workflow',
  });
  if (!confirmed) return;
  await window.husk.workflows.delete(id);
  workflowsCache = workflowsCache.filter((w) => w.id !== id);
  paintWorkflowList();
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
    <div class="wf-cv-node-meta">${escapeHtml(data.agentCommand || 'default agent')}</div>
  </div>`;
}

// Create the Drawflow editor once, reuse it (clear between opens) so its
// container listeners are not duplicated.
// Edge conditions keyed by `${fromDfId}->${toDfId}`. Drawflow connections
// cannot carry custom data, so conditions live here and merge in on export.
const wfEdgeConditions = {};
let wfSelectedEdge = null;
function wfEdgeKey(from, to) { return `${from}->${to}`; }

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
  wfEditor.on('nodeSelected', (id) => { hideEdgePanel(); showNodePanel(id); });
  wfEditor.on('nodeUnselected', () => hideNodePanel());
  wfEditor.on('nodeRemoved', () => hideNodePanel());
  wfEditor.on('connectionSelected', (c) => { hideNodePanel(); showEdgePanel(c); });
  wfEditor.on('connectionUnselected', () => hideEdgePanel());
  wfEditor.on('connectionRemoved', (c) => { delete wfEdgeConditions[wfEdgeKey(c.output_id, c.input_id)]; });
}

function wfAddCanvasNode(data, x, y) {
  if (!wfEditor) return;
  const nodeData = {
    name: (data && data.name) || 'New Step',
    agentCommand: (data && data.agentCommand) || '',
    prompt: (data && data.prompt) || '',
    passContext: (data && data.passContext) || 'full',
  };
  const px = Number.isFinite(x) ? x : 60 + Math.round(Math.random() * 60);
  const py = Number.isFinite(y) ? y : 60 + Math.round(Math.random() * 60);
  wfEditor.addNode('step', 1, 1, px, py, 'wf-cv', nodeData, wfNodeHtml(nodeData));
}

function wfLoadGraph(graph) {
  if (!wfEditor) return;
  const idMap = {};
  (graph.nodes || []).forEach((n) => {
    const data = {
      name: n.name || 'Step',
      agentCommand: n.agentCommand || '',
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
  Object.keys(data).forEach((id) => {
    const n = data[id];
    const d = n.data || {};
    nodes.push({
      id: String(id),
      name: d.name || 'Step',
      agentCommand: d.agentCommand || null,
      prompt: d.prompt || '',
      passContext: d.passContext || 'full',
      x: n.pos_x, y: n.pos_y,
    });
    Object.keys(n.outputs || {}).forEach((ok) => {
      ((n.outputs[ok] || {}).connections || []).forEach((c) => {
        const cond = wfEdgeConditions[wfEdgeKey(id, c.node)] || { type: 'always', value: '' };
        edges.push({ id: `edge-${id}-${c.node}`, from: String(id), to: String(c.node), condition: cond });
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
  $('#wf-node-panel').hidden = false;
}

function hideNodePanel() {
  wfSelectedNodeId = null;
  const panel = $('#wf-node-panel');
  if (panel) panel.hidden = true;
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
  const data = {
    name: ($('#wf-np-name').value || 'Step').slice(0, 64),
    agentCommand: $('#wf-np-agent').value || '',
    prompt: $('#wf-np-prompt').value || '',
    passContext: $('#wf-np-context').value || 'full',
  };
  wfEditor.updateNodeDataFromId(wfSelectedNodeId, data);
  const nameEl = document.querySelector(`#node-${wfSelectedNodeId} .wf-cv-node-name`);
  const metaEl = document.querySelector(`#node-${wfSelectedNodeId} .wf-cv-node-meta`);
  if (nameEl) nameEl.textContent = data.name;
  if (metaEl) metaEl.textContent = data.agentCommand || 'default agent';
}

function openWorkflowBuilder(editId) {
  editingWorkflowId = editId || null;
  const existing = editId ? workflowsCache.find((w) => w.id === editId) : null;
  if ($('#wf-name-input')) $('#wf-name-input').value = existing ? existing.name : '';
  if ($('#wf-trigger-select')) $('#wf-trigger-select').value = existing ? (existing.trigger || 'manual') : 'manual';
  wfShowView('builder');
  hideNodePanel();
  hideEdgePanel();
  // Drawflow needs the container visible and sized before start().
  setTimeout(() => {
    wfEnsureEditor();
    const graph = (existing && existing.graph) ? existing.graph : { nodes: [], edges: [] };
    wfLoadGraph(graph);
    if (!graph.nodes || !graph.nodes.length) wfAddCanvasNode(null, 80, 80);
    try { $('#wf-name-input').focus(); } catch (_) {}
  }, 50);
}

async function saveWorkflow() {
  const name = (($('#wf-name-input') || {}).value || '').trim();
  if (!name) { toast('Workflow needs a name', 'error'); return; }
  const graph = wfExportGraph();
  if (!graph.nodes.length) { toast('Add at least one node', 'error'); return; }
  const trigger = (($('#wf-trigger-select') || {}).value) || 'manual';
  const payload = { name, graph, trigger };
  if (editingWorkflowId) {
    payload.id = editingWorkflowId;
    await window.husk.workflows.update(payload);
  } else {
    await window.husk.workflows.create(payload);
  }
  workflowsCache = await window.husk.workflows.list();
  wfShowView('list');
  paintWorkflowList();
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

function wfAppendActivity(nodeId, kind, text) {
  const feed = document.getElementById(`wf-activity-${nodeId}`);
  if (!feed) return;

  // Suppress PAI voice-notification tool calls outright.
  if (kind === 'tool' && /curl .*localhost:8888\/notify/.test(text)) return;
  if (kind === 'text') {
    text = stripPaiNoise(text);
    if (!text) return;
  }

  const emptyEl = feed.querySelector('.wf-activity-empty');
  if (emptyEl) emptyEl.remove();

  const row = document.createElement('div');
  row.className = `wf-act wf-act-${kind}`;
  const icon = document.createElement('div');
  icon.className = 'wf-act-icon';
  // eslint-disable-next-line no-unsanitized/property -- static SVG markup, no user input
  icon.innerHTML = wfActIcon(kind);
  const body = document.createElement('div');
  body.className = 'wf-act-body';

  if (kind === 'tool') {
    // "Bash  git diff" -> chip with tool name + muted args.
    const sp = text.indexOf('  ');
    const chip = document.createElement('span');
    chip.className = 'wf-tool-chip';
    chip.textContent = sp > 0 ? text.slice(0, sp) : text;
    body.appendChild(chip);
    if (sp > 0) {
      const arg = document.createElement('span');
      arg.className = 'wf-tool-arg';
      arg.textContent = text.slice(sp + 2);
      body.appendChild(arg);
    }
  } else if (kind === 'text') {
    // eslint-disable-next-line no-unsanitized/property -- renderMarkdown escapes all HTML first
    body.innerHTML = renderMarkdown(text);
  } else {
    body.textContent = text;
  }

  row.appendChild(icon);
  row.appendChild(body);
  feed.appendChild(row);
  // Auto-scroll only while the step is the live one.
  const node = document.getElementById(`wf-node-${nodeId}`);
  if (node && node.classList.contains('is-running')) feed.scrollTop = feed.scrollHeight;
}

function wfToggleNode(nodeId) {
  const node = document.getElementById(`wf-node-${nodeId}`);
  if (node) node.classList.toggle('is-collapsed');
}

function wfSetProgress(done, total, pctOverride) {
  const fill = $('#wf-progress-fill');
  const label = $('#wf-progress-label');
  const pct = pctOverride != null ? pctOverride : (total ? Math.round((done / total) * 100) : 0);
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${done} step${done !== 1 ? 's' : ''} run`;
}

let wfActiveRun = { total: 0, done: 0 };

async function runWorkflow(workflowId) {
  const workflow = workflowsCache.find((w) => w.id === workflowId);
  if (!workflow) return;

  wfClearTimers();
  wfLastRunningNode = null;
  const nameEl = $('#wf-run-name');
  const badge = $('#wf-run-status-badge');
  const stopBtn = $('#btn-stop-wf');
  const stepsEl = $('#wf-run-steps');
  if (nameEl) nameEl.textContent = workflow.name;
  if (badge) { badge.textContent = 'Running'; badge.className = 'wf-run-status-badge'; }
  if (stopBtn) stopBtn.hidden = false;
  wfShowView('run');

  const allNodes = wfAllNodes(workflow.graph);

  if (stepsEl) {
    wfActiveRun = { total: allNodes.length, done: 0 };
    wfSetProgress(0, allNodes.length);
    const caret = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
    const connArrow = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 16l7 7 7-7"/></svg>`;
    // eslint-disable-next-line no-unsanitized/property -- node name/prompt escaped via escapeHtml
    stepsEl.innerHTML = allNodes.map((step, i) => `
      ${i > 0 ? `<div class="wf-step-connector"><div class="wf-connector-arrow">${connArrow}</div></div>` : ''}
      <div class="wf-run-node is-pending is-collapsed" id="wf-node-${escapeAttr(step.id)}">
        <div class="wf-run-node-head" data-toggle="${escapeAttr(step.id)}">
          <div class="wf-run-node-status"></div>
          <div class="wf-run-node-titlewrap">
            <div class="wf-run-node-title">${escapeHtml(step.name)}</div>
            <div class="wf-run-node-prompt">${escapeHtml((step.prompt || '').split('\n')[0] || 'No prompt set')}</div>
          </div>
          <div class="wf-run-node-timer" id="wf-timer-${escapeAttr(step.id)}"></div>
          <div class="wf-run-node-state-label">Pending</div>
          <div class="wf-run-node-caret">${caret}</div>
        </div>
        <div class="wf-run-node-body">
          <div class="wf-run-activity" id="wf-activity-${escapeAttr(step.id)}">
            <div class="wf-activity-empty">Waiting...</div>
          </div>
          <div class="wf-run-result" id="wf-result-${escapeAttr(step.id)}" hidden>
            <div class="wf-run-result-label">Result</div>
            <div class="wf-run-result-body" id="wf-result-body-${escapeAttr(step.id)}"></div>
          </div>
        </div>
      </div>
    `).join('');
    stepsEl.querySelectorAll('[data-toggle]').forEach((head) =>
      head.addEventListener('click', () => wfToggleNode(head.dataset.toggle)));
  }

  const res = await window.husk.workflows.run(workflowId);
  if (!res || !res.ok) { toast(res ? res.error : 'Could not start workflow', 'error'); wfShowView('list'); return; }
  activeRunId = res.runId;
}

// IPC event handlers for live run updates (keyed by node id)
window.husk.workflows.onNodeStart((d) => {
  if (d.runId !== activeRunId) return;
  // Collapse whichever node was running so the new active one is the focus.
  if (wfLastRunningNode) {
    const prev = document.getElementById(`wf-node-${wfLastRunningNode}`);
    if (prev) prev.classList.add('is-collapsed');
  }
  wfLastRunningNode = d.nodeId;
  const node = document.getElementById(`wf-node-${d.nodeId}`);
  const label = node && node.querySelector('.wf-run-node-state-label');
  if (node) node.className = 'wf-run-node is-running';
  if (label) label.textContent = 'Running';
  const feed = document.getElementById(`wf-activity-${d.nodeId}`);
  if (feed) { const e = feed.querySelector('.wf-activity-empty'); if (e) e.remove(); }
  const startedAt = Date.now();
  const timerEl = document.getElementById(`wf-timer-${d.nodeId}`);
  const interval = setInterval(() => {
    if (timerEl) timerEl.textContent = `${Math.floor((Date.now() - startedAt) / 1000)}s`;
  }, 1000);
  wfStepTimers[d.nodeId] = { interval, startedAt };
  if (timerEl) timerEl.textContent = '0s';
});

window.husk.workflows.onNodeActivity((d) => {
  if (d.runId !== activeRunId) return;
  wfAppendActivity(d.nodeId, d.kind || 'status', d.text || '');
});

window.husk.workflows.onNodeDone((d) => {
  if (d.runId !== activeRunId) return;
  const node = document.getElementById(`wf-node-${d.nodeId}`);
  const label = node && node.querySelector('.wf-run-node-state-label');
  const cls = d.status === 'done' ? 'is-done' : d.status === 'cancelled' ? 'is-cancelled' : 'is-failed';
  const lbl = d.status === 'done' ? 'Done' : d.status === 'cancelled' ? 'Cancelled' : 'Failed';
  if (node) node.className = `wf-run-node ${cls}`;
  if (label) label.textContent = lbl;
  const t = wfStepTimers[d.nodeId];
  if (t) {
    clearInterval(t.interval);
    const timerEl = document.getElementById(`wf-timer-${d.nodeId}`);
    if (timerEl) timerEl.textContent = `${Math.floor((Date.now() - t.startedAt) / 1000)}s`;
    delete wfStepTimers[d.nodeId];
  }
  const cleaned = stripPaiNoise(d.output || '');
  if (cleaned) {
    const resWrap = document.getElementById(`wf-result-${d.nodeId}`);
    const resBody = document.getElementById(`wf-result-body-${d.nodeId}`);
    if (resBody) {
      // eslint-disable-next-line no-unsanitized/property -- renderMarkdown escapes all HTML first
      resBody.innerHTML = renderMarkdown(cleaned);
    }
    if (resWrap) resWrap.hidden = false;
  }
  wfActiveRun.done += 1;
  wfSetProgress(wfActiveRun.done, wfActiveRun.total);
});

// A branch was taken: the routing decision. The vertical run list does not
// draw edges, so this is informational; 2c surfaces it on the canvas.
window.husk.workflows.onEdgeTaken(() => {});

window.husk.workflows.onRunDone((d) => {
  if (d.runId !== activeRunId) return;
  activeRunId = null;
  wfClearTimers();
  // Any node never reached by the taken path is a skipped branch.
  document.querySelectorAll('#wf-run-steps .wf-run-node.is-pending').forEach((node) => {
    node.className = 'wf-run-node is-skipped is-collapsed';
    const label = node.querySelector('.wf-run-node-state-label');
    if (label) label.textContent = 'Skipped';
    const feed = node.querySelector('.wf-run-activity');
    if (feed) { const e = feed.querySelector('.wf-activity-empty'); if (e) e.textContent = 'Skipped by a branch condition.'; }
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
});

// Button wiring
$('#btn-new-workflow') && $('#btn-new-workflow').addEventListener('click', () => openWorkflowBuilder(null));
$('#btn-wf-builder-back') && $('#btn-wf-builder-back').addEventListener('click', () => { wfShowView('list'); paintWorkflowList(); });
$('#btn-save-workflow') && $('#btn-save-workflow').addEventListener('click', saveWorkflow);
$('#btn-add-wf-node') && $('#btn-add-wf-node').addEventListener('click', () => wfAddCanvasNode(null));
$('#btn-wf-run-back') && $('#btn-wf-run-back').addEventListener('click', () => { wfShowView('list'); });
// Node config panel
['wf-np-name', 'wf-np-agent', 'wf-np-context', 'wf-np-prompt'].forEach((id) => {
  const el = $(`#${id}`);
  if (el) { el.addEventListener('input', wfSyncPanelToNode); el.addEventListener('change', wfSyncPanelToNode); }
});
$('#wf-node-panel-close') && $('#wf-node-panel-close').addEventListener('click', hideNodePanel);
$('#wf-edge-panel-close') && $('#wf-edge-panel-close').addEventListener('click', hideEdgePanel);
$('#wf-ec-type') && $('#wf-ec-type').addEventListener('change', wfSyncEdgePanel);
$('#wf-ec-value') && $('#wf-ec-value').addEventListener('input', wfSyncEdgePanel);
$('#wf-np-delete') && $('#wf-np-delete').addEventListener('click', () => {
  if (wfEditor && wfSelectedNodeId != null) {
    wfEditor.removeNodeId('node-' + wfSelectedNodeId);
    hideNodePanel();
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
    <div class="agent-card${isActive ? ' is-active' : ''}" data-id="${escapeHtml(p.id)}" role="button" aria-pressed="${isActive}" tabindex="0" title="${isActive ? 'Click to deactivate' : 'Click to activate'}">
      ${!p.builtin ? `
        <div class="agent-card-corner">
          <button class="agent-card-icon agent-edit" data-id="${escapeHtml(p.id)}" title="Edit agent" aria-label="Edit agent">${editIcon}</button>
          <button class="agent-card-icon is-danger agent-delete" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Delete agent" aria-label="Delete agent">${trashIcon}</button>
        </div>` : ''}
      <div class="agent-card-head">
        <div class="agent-card-title">${escapeHtml(p.name)}</div>
        ${isActive ? '<span class="agent-card-pill">Active</span>' : ''}
        ${p.builtin ? '<span class="agent-card-builtin">Built-in</span>' : ''}
      </div>
      ${p.description ? `<div class="agent-card-desc">${escapeHtml(p.description)}</div>` : ''}
      ${p.repoRoot ? `<div class="agent-card-repo" title="${escapeAttr(p.repoRoot)}">cwd: ${escapeHtml(p.repoRoot.replace(/^\/home\/[^/]+/, '~'))}</div>` : ''}
      ${p.systemPrompt ? `<div class="agent-card-prompt">${escapeHtml(p.systemPrompt)}</div>` : ''}
    </div>
  `;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property
  grid.innerHTML = cards;

  // Whole-card click toggles activation; clicks on inner buttons fall through.
  grid.querySelectorAll('.agent-card').forEach((card) => {
    const id = card.dataset.id;
    const toggle = () => {
      if (activeIds.has(id)) deactivateProfile(id);
      else activateProfile(id);
    };
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      // Skip toggle when the user just selected text inside the card.
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
  if (!name) { toast('Name is required', 'error'); return; }
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

// ─── Install agents from a cloned repo ───────────────────────────────────────────
// The repo is expected to ship agents/*.md (Claude-style frontmatter) and
// optionally skills/*.md. Husk copies each picked agent to ~/.claude/agents/
// (Claude path), writes the body into <repo>/.github/copilot-instructions.md
// inside HUSK-AGENTS markers (Copilot path), and stamps the resulting Husk
// profile with repoRoot. spawnPty consumes repoRoot as the cwd, so the agent's
// relative skills/<test_id>.md reads resolve when the chat launches.
let lastRepoScan = null;
function openRepoAgentsModal() {
  const modal = $('#repo-agents-modal');
  if (!modal) return;
  if ($('#ra-root')) $('#ra-root').value = '';
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
  setTimeout(() => { try { $('#ra-root').focus(); } catch (_) {} }, 0);
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
  el.textContent = text;
  el.className = 'ra-status' + (kind ? ' ra-status-' + kind : '');
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
  setRepoStatus('Scanning…');
  // eslint-disable-next-line no-unsanitized/property -- static loading placeholder
  listEl.innerHTML = `<div class="ai-empty">Looking for agents/*.md…</div>`;
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Install 0 agents';
  const res = await window.husk.repoAgents.scan(root);
  if (!res || !res.ok) {
    setRepoStatus(res && res.error ? res.error : 'Scan failed', 'error');
    // eslint-disable-next-line no-unsanitized/property -- error from local fs read, no html
    listEl.innerHTML = `<div class="ai-empty">${escapeHtml((res && res.error) || 'Could not scan that folder')}</div>`;
    lastRepoScan = null;
    return;
  }
  lastRepoScan = res;
  const skillsNote = res.hasSkillsDir
    ? `Found <code>${escapeHtml(root.replace(/\/+$/, ''))}/skills/</code>. Agents that read <code>skills/&lt;id&gt;.md</code> will work after install.`
    : `No <code>skills/</code> directory at this root. Agents will install but any <code>skills/&lt;id&gt;.md</code> read will fail until you add one.`;
  const copilotNote = res.copilotInstructionsExists
    ? (res.copilotHasUserContent
        ? `<code>.github/copilot-instructions.md</code> already exists with content. Husk only modifies the HUSK-AGENTS block; everything outside is preserved.`
        : `<code>.github/copilot-instructions.md</code> already exists but is effectively empty. Husk will rewrite the HUSK-AGENTS block.`)
    : `<code>.github/copilot-instructions.md</code> will be created.`;
  // eslint-disable-next-line no-unsanitized/property -- both branches use escapeHtml on dynamic parts
  setRepoStatus('');
  const statusEl = $('#ra-status');
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = 'ra-status ra-status-info';
    // eslint-disable-next-line no-unsanitized/property -- static + escapeHtml above
    statusEl.innerHTML = `<div>${skillsNote}</div><div>${copilotNote}</div>`;
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
      : (a.alreadyInClaude ? `<span class="ai-row-source">in ~/.claude/agents</span>` : '');
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
  const writeCopilotInstructions = !!($('#ra-copilot') && $('#ra-copilot').checked);
  const activate = !!($('#ra-activate') && $('#ra-activate').checked);
  const res = await window.husk.repoAgents.install({
    root, picks, installToClaudeAgents, writeCopilotInstructions, activate,
  });
  if (!res || !res.ok) {
    toast((res && res.error) || 'Install failed', 'error');
    if (btn) btn.disabled = false;
    return;
  }
  if (res.copilotWriteError) {
    toast(`Imported ${res.imported}, but Copilot instructions write failed: ${res.copilotWriteError}`, 'error');
  } else {
    const parts = [`Installed ${res.imported} agent${res.imported !== 1 ? 's' : ''}`];
    if (installToClaudeAgents && res.copiedToClaude && res.copiedToClaude.length) parts.push(`copied to ~/.claude/agents/`);
    if (writeCopilotInstructions && res.copilotInstructionsPath) parts.push(`Copilot instructions written`);
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
$('#ra-browse') && $('#ra-browse').addEventListener('click', browseForRepoRoot);
$('#ra-confirm') && $('#ra-confirm').addEventListener('click', confirmRepoAgentsInstall);
$('#ra-root') && $('#ra-root').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = ($('#ra-root').value || '').trim();
    if (v) scanRepoRoot(v);
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
$('#btn-deactivate-all') && $('#btn-deactivate-all').addEventListener('click', () => deactivateAllProfiles());
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
async function renderPrompts() {
  const grid = $('#prompts-grid');
  if (!grid) return;
  // eslint-disable-next-line no-unsanitized/property -- Static loading template.
  grid.innerHTML = '<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">Loading prompts…</div></div>';
  const res = await window.husk.prompts.list();
  if (!res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${escapeHtml(res.error || 'Unknown error')}</div></div>`;
    return;
  }
  promptsCache = res.prompts || [];
  paintPrompts(promptsCache, ($('#prompts-search') || {}).value || '');
}

function paintPrompts(items, filter) {
  const grid = $('#prompts-grid');
  if (!grid) return;
  const q = (filter || '').toLowerCase().trim();
  const filtered = q
    ? items.filter((p) => (p.name + ' ' + (p.description || '')).toLowerCase().includes(q))
    : items;
  if (!filtered.length) {
    const msg = q ? `No prompts match "${escapeHtml(q)}"` : 'No prompts yet. Drop markdown files in ~/.config/husk/prompts/';
    // eslint-disable-next-line no-unsanitized/property -- escapeHtml above; rest is static.
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">${msg}</div></div>`;
    return;
  }
  const cards = filtered.map((p) => `
    <div class="prompt-card${p.disabled ? ' is-disabled' : ''}" data-md="${escapeHtml(p.mdPath)}" tabindex="0">
      <button class="card-delete prompt-delete" data-md="${escapeHtml(p.mdPath)}" data-name="${escapeHtml(p.name)}" title="Delete prompt" aria-label="Delete prompt"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>
      <div class="prompt-card-head">
        <div class="prompt-card-title">${escapeHtml(p.name)}</div>
        ${p.disabled ? '<span class="prompt-card-pill">disabled</span>' : ''}
      </div>
      <div class="prompt-card-body">${escapeHtml(p.description || '')}</div>
      <div class="prompt-card-actions">
        <button class="ghost-link prompt-preview" data-md="${escapeHtml(p.mdPath)}" title="Preview body">Preview</button>
        <button class="card-cta prompt-run" data-md="${escapeHtml(p.mdPath)}" title="Send into chat">Run<svg class="card-cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
      </div>
    </div>
  `).join('');
  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml above.
  grid.innerHTML = cards;
  grid.querySelectorAll('.prompt-run').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); runPrompt(e.currentTarget.dataset.md); }));
  grid.querySelectorAll('.prompt-preview').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); previewPrompt(e.currentTarget.dataset.md); }));
  grid.querySelectorAll('.prompt-delete').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deletePrompt(e.currentTarget.dataset.md, e.currentTarget.dataset.name); }));
  /* Whole-card click previews; explicit Run button commits. Clicking inside
     the actions row routes to the right button via stopPropagation above. */
  grid.querySelectorAll('.prompt-card').forEach((card) => card.addEventListener('click', (e) => {
    if (e.target.closest('.prompt-card-actions') || e.target.closest('.card-delete')) return;
    const md = card.dataset.md;
    if (md) previewPrompt(md);
  }));
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

async function previewPrompt(mdPath) {
  if (!mdPath) return;
  const res = await window.husk.skills.read(mdPath);
  if (!res.ok) return;
  const body = (res.content || '').replace(/^---[\s\S]*?---\n?/, '').trim();
  // Reuse the existing detail panel scaffolding if present; fall back to alert.
  const eyebrow = $('#dp-eyebrow'); const title = $('#dp-title'); const sub = $('#dp-sub'); const bodyEl = $('#dp-body'); const panel = $('#detail-panel');
  if (panel && title && bodyEl) {
    if (eyebrow) eyebrow.textContent = 'Prompt';
    title.textContent = mdPath.split('/').pop().replace(/\.md$/, '');
    if (sub) sub.textContent = mdPath;
    bodyEl.textContent = body;
    document.body.dataset.detail = 'open';
    panel.hidden = false;
  }
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
  function openNewPrompt() {
    if (!modal) return;
    if (nameEl) nameEl.value = '';
    if (descEl) descEl.value = '';
    if (bodyEl) bodyEl.value = '';
    modal.hidden = false;
    setTimeout(() => { try { nameEl && nameEl.focus(); } catch (_) {} }, 30);
  }
  function closeNewPrompt() { if (modal) modal.hidden = true; }
  async function submitNewPrompt() {
    const name = (nameEl && nameEl.value || '').trim();
    const description = (descEl && descEl.value || '').trim();
    const content = bodyEl && bodyEl.value || '';
    const res = await window.husk.prompts.create({ name, description, content });
    if (!res || !res.ok) {
      const t = document.getElementById('toast');
      if (t) { t.textContent = (res && res.error) || 'Could not create prompt'; t.hidden = false; setTimeout(() => { t.hidden = true; }, 3500); }
      return;
    }
    closeNewPrompt();
    await renderPrompts();
  }
  if (newBtn) newBtn.addEventListener('click', openNewPrompt);
  if (cancelBtn) cancelBtn.addEventListener('click', closeNewPrompt);
  if (createBtn) createBtn.addEventListener('click', submitNewPrompt);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeNewPrompt(); });
}

// ─── Skills page ──────────────────────────────────────────────────────────────
let skillsCache = [];
let agentKindCache = 'claude';
async function renderSkills() {
  const grid = $('#skills-grid');
  // eslint-disable-next-line no-unsanitized/property -- Static loading template.
  grid.innerHTML = '<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">Loading…</div></div>';
  const res = await window.husk.skills.list();
  if (!res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${escapeHtml(res.error || 'Unknown error')}</div></div>`;
    return;
  }
  skillsCache = res.skills;
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
    railItem.title = 'Skills';
    const lbl = railItem.querySelector('.ri-label');
    if (lbl) lbl.textContent = 'Skills';
  }
  const skillsTitle = document.querySelector('.page-skills .page-title');
  if (skillsTitle) skillsTitle.textContent = 'Skills';
  const skillsSub = document.querySelector('.page-skills .page-sub');
  if (skillsSub) skillsSub.textContent = agentKindCache === 'claude'
    ? 'auto-loaded by claude · click Use to inject manually'
    : 'click Use to inject any skill into the chat';
}
async function injectPromptToChat(content) {
  if (!content) return;
  const trimmed = String(content).replace(/^---[\s\S]*?---\n?/, '').trim();
  if (!trimmed) return;
  setPage('chat');
  // If the welcome screen is still up (no PTY yet), launch the agent with this
  // prompt as the initial input. Otherwise just paste into the running PTY.
  const welcomeUp = $('#chat-empty')?.classList.contains('show');
  if (welcomeUp) {
    await launchAgent({ initialPrompt: trimmed });
    return;
  }
  setTimeout(() => {
    try { window.husk.pty.write(trimmed); } catch (_) {}
    try { term.focus(); } catch (_) {}
  }, 60);
}
function paintSkills(list, query) {
  const grid = $('#skills-grid');
  const q = (query || '').toLowerCase().trim();
  const filtered = q ? list.filter((s) => (s.name + ' ' + (s.description || '')).toLowerCase().includes(q)) : list;
  if (!filtered.length) {
    const msg = list.length ? `No skills match "${escapeHtml(query)}"` : 'No skills yet. Drop a .md file or use ＋.';
    // eslint-disable-next-line no-unsanitized/property -- Message content is escaped above.
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">${msg}</div></div>`;
    return;
  }
  // eslint-disable-next-line no-unsanitized/property -- Skill fields are escaped via escapeHtml/escapeAttr.
  grid.innerHTML = filtered.map((sk) => {
    const sourceBadge = sk.source === 'husk'
      ? '<span class="sk-badge sk-badge-husk" title="Husk-managed prompt">prompt</span>'
      : '<span class="sk-badge sk-badge-claude" title="Claude skill (auto-loaded by claude)">skill</span>';
    return `
    <div class="skill-card${sk.disabled ? ' disabled' : ''}" data-id="${escapeAttr(sk.id)}" data-source="${escapeAttr(sk.source)}" data-dirname="${escapeAttr(sk.dirName || sk.id)}" data-mdpath="${escapeAttr(sk.mdPath)}" data-path="${escapeAttr(sk.path)}" data-name="${escapeAttr(sk.name)}">
      <div class="sk-row1">
        <div class="sk-name"><span class="sk-icon">⌬</span><span>${escapeHtml(sk.name)}</span>${sourceBadge}</div>
        <div class="sk-actions">
          <button class="ghost-btn sk-use" data-use="1" title="Inject this prompt into the active chat">Use ▶</button>
          <button class="toggle ${sk.disabled ? '' : 'on'}" data-toggle="1" title="${sk.disabled ? 'Enable' : 'Disable'}"></button>
        </div>
      </div>
      <div class="sk-desc">${escapeHtml(sk.description || 'No description.')}</div>
      <div class="sk-path">${escapeHtml(sk.path)}</div>
    </div>`;
  }).join('');
  grid.querySelectorAll('.skill-card').forEach((c) => {
    c.addEventListener('click', (e) => {
      if (e.target.closest('[data-toggle]') || e.target.closest('[data-use]')) return;
      openSkillDetail(c.dataset);
    });
  });
  grid.querySelectorAll('.skill-card .sk-use').forEach((u) => {
    u.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = u.closest('.skill-card');
      const r = await window.husk.skills.read(card.dataset.mdpath);
      if (!r.ok) { toast(r.error || 'Could not read', 'error'); return; }
      injectPromptToChat(r.content);
      toast(`Injected: ${card.dataset.name}`, 'success');
    });
  });
  grid.querySelectorAll('.skill-card .toggle').forEach((t) => {
    t.addEventListener('click', async (e) => {
      e.stopPropagation();
      const card = t.closest('.skill-card');
      const id = card.dataset.id || card.dataset.dirname;
      const source = card.dataset.source || 'claude';
      const wasOn = t.classList.contains('on');
      // Optimistic flip, CSS transition needs the same node, not a re-rendered one.
      t.classList.toggle('on');
      card.classList.toggle('disabled');
      const result = await window.husk.skills.toggle({ id, source, dirName: id });
      if (result.ok) {
        // The dir/file was renamed on disk. Update the data-id and data-dirname
        // so the next click targets the new path.
        card.dataset.id = result.id || result.dirName;
        card.dataset.dirname = result.dirName || result.id;
        t.classList.toggle('on', !result.disabled);
        card.classList.toggle('disabled', !!result.disabled);
        t.title = `${result.disabled ? 'Enable' : 'Disable'} skill`;
        toast(`${card.dataset.name} ${result.disabled ? 'disabled' : 'enabled'} · restart agent to apply`, 'success');
        refreshStats();
      } else {
        // Revert.
        t.classList.toggle('on', wasOn);
        card.classList.toggle('disabled', !wasOn);
        toast(result.error || 'Toggle failed', 'error');
      }
    });
  });
}
$('#skills-search').addEventListener('input', debounce((e) => paintSkills(skillsCache, e.target.value), 120));
$('#btn-skills-refresh').addEventListener('click', renderSkills);
$('#btn-skills-open').addEventListener('click', () => lastStats && window.husk.fs.open(lastStats.skillsDir));
$('#btn-skills-new').addEventListener('click', openCreateSkillModal);

function openCreateSkillModal() {
  $('#ns-name').value = '';
  $('#ns-desc').value = '';
  $('#ns-content').value = '';
  $('#new-skill-modal').hidden = false;
  setTimeout(() => $('#ns-name').focus(), 50);
}
function closeCreateSkillModal() { $('#new-skill-modal').hidden = true; }
$('#ns-cancel').addEventListener('click', closeCreateSkillModal);
$('#new-skill-modal').addEventListener('click', (e) => { if (e.target.id === 'new-skill-modal') closeCreateSkillModal(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#new-skill-modal').hidden) closeCreateSkillModal();
});

async function submitCreateSkill() {
  const name = $('#ns-name').value.trim().toLowerCase();
  const description = $('#ns-desc').value.trim();
  const content = $('#ns-content').value;
  if (!name) { toast('Name is required', 'error'); $('#ns-name').focus(); return; }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    toast('Name must be lowercase letters, digits, dashes; start with a letter.', 'error');
    $('#ns-name').focus(); return;
  }
  if (!description) { toast('Description is required', 'error'); $('#ns-desc').focus(); return; }
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
        if (r.ok) { toast(`${name} ${r.disabled ? 'disabled' : 'enabled'} · restart agent to apply`, 'success'); closeDetail(); renderSkills(); refreshStats(); }
        else toast(r.error || 'Toggle failed', 'error');
      }},
      { label: 'Edit in OS', kind: 'ghost', onClick: () => window.husk.fs.open(mdpath) },
      { label: 'Open folder', kind: 'ghost', onClick: () => window.husk.fs.open(skPath) },
    ],
  });
}

// ─── Sessions page ───────────────────────────────────────────────────────────────
let sessionsCache = [];
let sessionsSelectMode = false;
const sessionsSelected = new Set();
async function renderSessions() {
  const list = $('#sessions-list');
  list.innerHTML = '<div class="empty-state"><div class="es-icon">⊕</div><div class="es-msg">Loading sessions…</div></div>';
  const res = await window.husk.sessions.list();
  if (!res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    list.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${escapeHtml(res.error || 'Unknown error')}</div></div>`;
    return;
  }
  sessionsCache = res.sessions;
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

function paintSessions(list, query) {
  const ul = $('#sessions-list');
  const q = (query || '').toLowerCase().trim();
  const filtered = q ? list.filter((s) =>
    (s.title + ' ' + s.id + ' ' + s.projectPath + ' ' + (s.prdPhase || '')).toLowerCase().includes(q)
  ) : list;
  if (!filtered.length) {
    const msg = list.length ? `No sessions match "${escapeHtml(query)}"` : 'No claude sessions yet. Start a chat to create one.';
    // eslint-disable-next-line no-unsanitized/property -- Message content is escaped above.
    ul.innerHTML = `<div class="empty-state"><div class="es-icon">⊕</div><div class="es-msg">${msg}</div></div>`;
    return;
  }
  ul.classList.toggle('select-mode', sessionsSelectMode);
  // eslint-disable-next-line no-unsanitized/property -- Session fields are escaped via escapeHtml/escapeAttr.
  ul.innerHTML = filtered.map((s) => {
    const phaseHTML = s.prdPhase
      ? `<span class="session-phase ${escapeAttr(s.prdPhase)}">${escapeHtml(s.prdPhase)}</span>`
      : `<span class="session-phase">chat</span>`;
    const progressHTML = s.prdProgress ? `<span class="session-progress">${escapeHtml(s.prdProgress)}</span>` : '';
    const checked = sessionsSelected.has(s.path) ? 'checked' : '';
    const checkboxHTML = sessionsSelectMode
      ? `<label class="session-check"><input class="ai-check" type="checkbox" tabindex="-1" ${checked} data-path="${escapeAttr(s.path)}" /><span class="ai-check-box"></span></label>`
      : '';
    return `
      <button class="session-row${sessionsSelected.has(s.path) ? ' selected' : ''}" data-id="${escapeAttr(s.id)}" data-title="${escapeAttr(s.title)}" data-project="${escapeAttr(s.projectPath)}" data-path="${escapeAttr(s.path)}" data-prdpath="${escapeAttr(s.prdPath)}" data-started="${escapeAttr(s.startedISO)}" data-mtime="${s.mtime}" data-size="${s.sizeBytes}" data-phase="${escapeAttr(s.prdPhase || '')}" data-progress="${escapeAttr(s.prdProgress || '')}">
        ${checkboxHTML}
        <div class="session-task">
          <strong>${escapeHtml(s.title)}</strong>
          <span class="session-slug">${escapeHtml(s.projectPath)} · ${escapeHtml(s.id.slice(0, 8))}</span>
        </div>
        <span class="session-effort">${escapeHtml(timeAgo(s.mtime))}</span>
        ${progressHTML || `<span class="session-progress">${escapeHtml(fmtSize(s.sizeBytes))}</span>`}
        ${phaseHTML}
      </button>
    `;
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
}

function toggleSessionSelection(p) {
  if (!p) return;
  const wasSelected = sessionsSelected.has(p);
  if (wasSelected) sessionsSelected.delete(p);
  else sessionsSelected.add(p);
  // Update only the affected row in place. Repainting the whole list on
  // every checkbox click was an O(n) DOM teardown and listener rebind.
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
$('#btn-sessions-open').addEventListener('click', () => lastStats && window.husk.fs.open(lastStats.sessionsDir));
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
    eyebrow: 'Claude session',
    title: d.title,
    sub: d.id,
    meta,
    body,
    actions: [
      { label: '↻ Resume this session', kind: 'primary', onClick: () => resumeSessionInChat(d) },
      d.prdpath ? { label: 'Open PRD', kind: 'ghost', onClick: () => window.husk.fs.open(d.prdpath) } : null,
      { label: 'Open JSONL', kind: 'ghost', onClick: () => window.husk.fs.open(d.path) },
    ].filter(Boolean),
  });
}

async function resumeSessionInChat(d) {
  closeDetail();
  setPage('chat');
  try { term.clear(); term.reset(); } catch (_) {}
  const cmd = `claude --resume ${d.id}`;
  const cwd = d.project || null;
  toast(`Resuming ${d.id.slice(0, 8)}… (cwd: ${cwd || huskHome})`, 'success');
  $('#chat-sub').textContent = `claude --resume ${d.id.slice(0, 8)} · ${cwd || huskHome}`;
  if ($('#sp-agent')) $('#sp-agent').textContent = `claude --resume ${d.id.slice(0, 8)}`;
  if ($('#sp-session-id')) $('#sp-session-id').textContent = `${d.id.slice(0, 8)} · ${cwd || huskHome}`;
  fitAddon.fit();
  const { cols, rows } = term;
  chatHasInput = false;
  $('#chat-empty').classList.add('show');
  await window.husk.pty.restart({ cols, rows, command: cmd, cwd });
  term.focus();
  term.scrollToBottom();
}

// ─── Files page (tree) ───────────────────────────────────────────────────────────
function joinPath(a, b) { return a.endsWith('/') ? a + b : a + '/' + b; }
async function buildTreeNode(absPath, name, isDir) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row ' + (isDir ? 'is-dir' : 'is-file');
  const arrow = document.createElement('span');
  arrow.className = 'tree-arrow';
  arrow.textContent = isDir ? '▸' : ' ';
  row.appendChild(arrow);
  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = isDir ? '▤' : '◦';
  row.appendChild(icon);
  const nameEl = document.createElement('span');
  nameEl.className = 'tree-name';
  nameEl.textContent = name;
  nameEl.title = absPath;
  row.appendChild(nameEl);
  node.appendChild(row);
  if (isDir) {
    const children = document.createElement('div');
    children.className = 'tree-children';
    children.hidden = true;
    node.appendChild(children);
    let loaded = false;
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!loaded) {
        const res = await window.husk.fs.listDir(absPath, !!cfg.showHidden);
        if (res.ok) {
          for (const e2 of res.entries) {
            children.appendChild(await buildTreeNode(joinPath(absPath, e2.name), e2.name, e2.isDir));
          }
        } else {
          const err = document.createElement('div');
          err.className = 'tree-row';
          err.style.color = 'var(--rose)';
          err.textContent = `· ${res.error}`;
          children.appendChild(err);
        }
        loaded = true;
      }
      const isOpen = !children.hidden;
      children.hidden = isOpen;
      arrow.textContent = isOpen ? '▸' : '▾';
    });
  } else {
    row.addEventListener('click', () => window.husk.fs.open(absPath));
  }
  return node;
}
async function renderTree(root) {
  const treeEl = $('#tree');
  treeEl.innerHTML = '';
  $('#files-sub').textContent = `${root}`;
  if (!root) return;
  const res = await window.husk.fs.listDir(root, !!cfg.showHidden);
  if (!res.ok) {
    // eslint-disable-next-line no-unsanitized/property -- Error text is escaped before insertion.
    treeEl.innerHTML = `<div class="tree-row" style="color:var(--rose)">· ${escapeHtml(res.error || 'Unknown error')}</div>`;
    return;
  }
  for (const e of res.entries) {
    treeEl.appendChild(await buildTreeNode(joinPath(root, e.name), e.name, e.isDir));
  }
}
$('#btn-files-refresh').addEventListener('click', () => renderTree(cfg.treeRoot));
$('#files-hidden').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ showHidden: e.target.checked });
  renderTree(cfg.treeRoot);
});
$('#files-root').addEventListener('change', async (e) => {
  const v = e.target.value.trim();
  if (!v) return;
  cfg = await window.husk.config.set({ treeRoot: v });
  renderTree(v);
});

// ─── Preferences page ────────────────────────────────────────────────────────────
function bindPrefs() {
  $('#pref-agent').value = cfg.agentCommand || '';
  $('#pref-agent-name').value = cfg.agentName || 'Husk';
  if ($('#pref-agent-cwd')) $('#pref-agent-cwd').value = cfg.agentCwd || '';
  $('#pref-recap').checked = cfg.recap !== false;
  if ($('#pref-pai')) $('#pref-pai').checked = cfg.paiEnabled !== false;
  $('#pref-theme').value = cfg.theme || 'dark';
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
  // Snapshot the last rows of the rendered grid (same approach as the autonomy
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
  const theme = e.target.value;
  applyTheme(theme);
  persistConfig({ theme });
});
$$('.accent-swatch').forEach((sw) => sw.addEventListener('click', () => {
  applyAccent(sw.dataset.c);
  persistConfig({ accent: sw.dataset.c });
}));
$('#pref-rail').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ railExpanded: e.target.checked });
  document.body.dataset.rail = cfg.railExpanded ? 'expanded' : 'collapsed';
  setTimeout(fitNow, 200);
  toast('Saved', 'success');
});
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
  toast(`Recap ${cfg.recap ? 'enabled' : 'disabled'} · restart agent to apply`, 'success');
});
$('#pref-pai') && $('#pref-pai').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ paiEnabled: e.target.checked });
  const msg = cfg.paiEnabled
    ? 'PAI enabled · restart Husk to bootstrap, restart agent to load it'
    : 'PAI disabled · restart agent to drop the PAI prompt; existing ~/.claude/ files left in place';
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
    // eslint-disable-next-line no-unsanitized/property -- Dynamic values are escaped, remaining markup is static.
    body.innerHTML = `You're on <strong>${escapeHtml(cur)}</strong>. The new version is ready to install.`;
    cta.textContent = 'Install update';
    cta.onclick = async () => {
      cta.disabled = true; cta.textContent = 'Downloading…';
      const r = await window.husk.updates.download();
      if (!r.ok) {
        // Auto-download not supported here (likely unsigned macOS or .deb / .rpm).
        cta.textContent = 'Open releases page';
        cta.disabled = false;
        cta.onclick = () => { window.husk.updates.openRelease(s.url); pop.hidden = true; };
      }
    };
  } else if (s.status === 'ready') {
    title.textContent = `Husk ${next} is ready`;
    body.innerHTML = `Click below to relaunch Husk with the new version. Your current chat will end.`;
    cta.textContent = 'Restart and install';
    cta.onclick = () => window.husk.updates.install();
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
$('#btn-theme').addEventListener('click', () => {
  // Read the live DOM, not cfg: rapid clicks fire before the debounced
  // write resolves, so cfg.theme can be stale. The body attribute is the
  // source of truth for what is currently shown.
  const next = (document.body.dataset.theme === 'dark') ? 'light' : 'dark';
  applyTheme(next);
  const sel = $('#pref-theme'); if (sel) sel.value = next;
  persistConfig({ theme: next });
});
// Send a "please read this file" message to the agent so it actually
// ingests the dropped file. Both claude and copilot/codex/aider have a
// file-read tool, they will pick it up automatically. We send the
// message + newline so the agent receives it as a submitted prompt.
async function tellAgentAboutFile(filePath, displayName) {
  // If the welcome screen is still up, start the PTY first.
  const welcomeUp = $('#chat-empty')?.classList.contains('show');
  const message = `Please read the file I just shared: ${filePath}\n`;
  if (welcomeUp) {
    await launchAgent({ initialPrompt: message });
    return;
  }
  setPage('chat');
  setTimeout(() => {
    try { window.husk.pty.write(message); } catch (_) {}
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
      tellAgentAboutFile(el.dataset.path, el.dataset.name);
    });
  });
}
async function shareFilesViaPicker() {
  const paths = await window.husk.dialog.pickFile();
  if (!paths || !paths.length) return;
  for (const p of paths) {
    const name = p.split('/').pop();
    const result = await window.husk.fs.dropFile({ sourcePath: p, kind: 'context' });
    if (result.ok) {
      toast(`Shared with agent: ${name}`, 'success');
      announceInTerminal(`Shared file with agent: ${name}\r\n  → ${result.dest}`);
      addToSessionContext({ name, path: result.dest });
      await tellAgentAboutFile(result.dest, name);
    } else toast(`Failed: ${result.error}`, 'error');
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
  const top = r.sessions.slice(0, RAIL_RECENT_MAX);
  section.hidden = false;
  // eslint-disable-next-line no-unsanitized/property -- Recent session fields are escaped via escapeHtml/escapeAttr.
  wrap.innerHTML = top.map((s) => `
    <div class="rail-recent-item" data-id="${escapeAttr(s.id)}" data-project="${escapeAttr(s.projectPath)}" title="${escapeAttr(s.title)}\n${escapeAttr(s.projectPath)}">
      <span class="rri-title">${escapeHtml(s.title)}</span>
      <span class="rri-meta">${escapeHtml(timeAgo(s.mtime))}</span>
    </div>
  `).join('');
  wrap.querySelectorAll('.rail-recent-item').forEach((el) => {
    el.addEventListener('click', () => {
      resumeSessionInChat({ id: el.dataset.id, project: el.dataset.project });
    });
  });
}
$('#btn-recent-all').addEventListener('click', () => setPage('sessions'));

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
  if (h === 'disabled')  return '<span class="mcp-health mcp-health-unknown" title="Disabled by claude">disabled</span>';
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
  const welcomeUp = $('#chat-empty')?.classList.contains('show');
  if (welcomeUp) {
    // No live agent yet. Just refresh inventory and snapshot lazily; whenever
    // the user clicks Launch / Start building, the new MCPs load on first start.
    const inv = await reloadMcpInventory();
    snapshotLoadedMcps(inv);
    if (currentPage === 'mcp') paintMcpSections();
    return;
  }
  // PTY is live. Restart silently so the new MCP loads. The snapshot is
  // captured inside restartPty and repaints the MCP page on the way out.
  toast(`Reloading agent to apply ${label || 'MCP change'}…`, 'success');
  await restartPty({ silent: true });
  // Re-probe so the badge flips from "checking…" to connected/failed/auth.
  setTimeout(reloadMcpHealth, 1500);
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
// Edit: starts in form view, pre-filled, server-name input read-only,
//      no paste view (you cannot rename via edit). Foot primary button
//      is `Save changes`.
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
    ? 'Update the fields below and save. The server name is fixed.'
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
      <div class="mcp-input-group">
        <label>Transport</label>
        <div class="mcp-tabs">
          <button type="button" class="mcp-tab active" data-tab="stdio">Local command (stdio)</button>
          <button type="button" class="mcp-tab" data-tab="http">Remote (HTTP / SSE)</button>
        </div>
      </div>
      <div class="mcp-input-group">
        <label for="mig-custom-id">Server name</label>
        <input id="mig-custom-id" type="text" placeholder="my-server" autocomplete="off" ${isEdit ? 'readonly' : ''} />
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
    // Pre-fill the form from the existing server. Editing the name is
    // disallowed so the underlying adapter's update() can find the entry.
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
  const id = ($('#mig-custom-id').value || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) { toast('Invalid server name', 'error'); return; }
  const tab = mcpModalState.activeTab;
  let payload;
  if (tab === 'http') {
    const url = ($('#mig-custom-url').value || '').trim();
    const transport = $('#mig-custom-type').value || 'http';
    const headersText = ($('#mig-custom-headers').value || '').trim();
    if (!url) { toast('URL required', 'error'); return; }
    const headers = {};
    if (headersText) {
      for (const line of headersText.split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    payload = { id, transport, url, headers };
  } else {
    const command = ($('#mig-custom-cmd').value || '').trim();
    const argsText = ($('#mig-custom-args').value || '').trim();
    const envText = ($('#mig-custom-env').value || '').trim();
    if (!command) { toast('Command required', 'error'); return; }
    const args = argsText ? argsText.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    const env = {};
    if (envText) {
      for (const line of envText.split('\n')) {
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    payload = { id, command, args, env };
  }
  const op = mcpModalState.mode === 'edit'
    ? await window.husk.mcp.update(payload)
    : await window.husk.mcp.add(payload);
  if (!op || !op.ok) { toast((op && op.error) || 'Save failed', 'error'); return; }
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

// ─── Agent quick-switch (rail pill + dropdown) ──────────────────────────────────
let agentMenuOpen = false;
let agentsCache = [];
function updateAgentPill() {
  const cmd = (cfg && cfg.agentCommand) ? cfg.agentCommand.trim().split(/\s+/)[0] : 'claude';
  $('#ra-name').textContent = cmd || 'agent';
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
  if (cfgBtn) cfgBtn.addEventListener('click', () => { closeAgentMenu(); setPage('preferences'); });
}
function openAgentMenu() {
  paintAgentMenu();
  $('#rail-agent-menu').hidden = false;
  agentMenuOpen = true;
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
$('#btn-new-session').addEventListener('click', () => restartPty());
function reportZoom(lvl) {
  const pct = Math.round(Math.pow(1.2, lvl) * 100);
  toast(`Zoom: ${pct}%`, 'success');
  setTimeout(fitNow, 30);
}
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
        toast(`Shared with agent: ${f.name}`, 'success');
        announceInTerminal(`Shared file with agent: ${f.name}\r\n  → ${result.dest}`);
        addToSessionContext({ name: f.name, path: result.dest });
        await tellAgentAboutFile(result.dest, f.name);
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
};

const PALETTE_ACTIONS = [
  { icon: ICONS.chat,        label: 'Switch to Chat',                 run: () => setPage('chat'),        shortcut: '1' },
  { icon: ICONS.skills,      label: 'Switch to Skills',               run: () => setPage('skills'),      shortcut: '2' },
  { icon: ICONS.sessions,    label: 'Switch to Sessions',             run: () => setPage('sessions'),    shortcut: '3' },
  { icon: ICONS.files,       label: 'Switch to Files',                run: () => setPage('files'),       shortcut: '4' },
  { icon: ICONS.mcp,         label: 'Switch to MCP',                  run: () => setPage('mcp'),         shortcut: '5' },
  { icon: ICONS.preferences, label: 'Switch to Preferences',          run: () => setPage('preferences'), shortcut: ',' },
  { icon: ICONS.restart,     label: 'Restart Agent',                  run: restartPty },
  { icon: ICONS.plus,        label: 'Share file (picker)',            run: shareFilesViaPicker },
  { icon: ICONS.plus,        label: 'New chat session',               run: () => restartPty() },
  { icon: ICONS.theme,       label: 'Toggle theme',                   run: () => $('#btn-theme').click() },
  { icon: ICONS.folder,      label: 'Open ~/.claude/MEMORY/WORK/',    run: () => lastStats && window.husk.fs.open(lastStats.sessionsDir) },
  { icon: ICONS.skills,      label: 'Open ~/.claude/skills/',         run: () => lastStats && window.husk.fs.open(lastStats.skillsDir) },
  { icon: ICONS.folder,      label: 'Open ~/.claude/hooks/',          run: () => lastStats && window.husk.fs.open(lastStats.hooksDir) },
];

let paletteSel = 0;
function openPalette() {
  $('#palette').hidden = false;
  $('#palette-input').value = '';
  paletteSel = 0;
  renderPalette('');
  $('#palette-input').focus();
}
function closePalette() { $('#palette').hidden = true; term.focus(); }
function renderPalette(query) {
  const q = query.toLowerCase().trim();
  const matches = PALETTE_ACTIONS.filter((a) => !q || a.label.toLowerCase().includes(q));
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
$('#btn-palette').addEventListener('click', openPalette);
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); }
  // Alt+1..6 page switch (Alt to avoid conflicting with terminal input)
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const map = { '1': 'chat', '2': 'skills', '3': 'sessions', '4': 'files', '5': 'mcp', '6': 'preferences' };
    if (map[e.key]) { e.preventDefault(); setPage(map[e.key]); }
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
    return ` CB${codeBlocks.length - 1} `;
  });
  const lines = s.split('\n');
  const out = [];
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const line of lines) {
    if (/^ CB\d+ $/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
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
  html = html.replace(/ CB(\d+) /g, (_m, i) => codeBlocks[Number(i)] || '');
  return html;
}
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// Drop PAI persona ceremony that leaks into workflow step output.
function stripPaiNoise(text) {
  return String(text || '')
    .split('\n')
    .filter((ln) => !/^[═=]{3,}.*PAI/.test(ln.trim()))
    .filter((ln) => !/Executing using PAI native mode/.test(ln))
    .join('\n')
    .trim();
}
function escapeAttr(s) { return escapeHtml(s); }

// ─── First-run modal + boot ──────────────────────────────────────────────────────
// First-launch wizard: detect installed CLI agents on PATH (claude, copilot,
// codex, aider, gemini), let the user pick one to use, install missing ones
// inline via npm / pipx, or open the docs page for manual install. Selecting
// an agent persists agentCommand + agentName + firstRunDone.
async function runFirstRunWizard() {
  const modal = $('#first-run');
  const list = $('#fr-agents');
  const log = $('#fr-log');
  const goBtn = $('#fr-go');
  const skipBtn = $('#fr-skip');
  const nameInput = $('#fr-name');
  modal.hidden = false;

  let detection = null;
  let selected = null;

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

  function paintAgents() {
    if (!detection || !detection.agents) {
      list.innerHTML = '<div class="fr-loading">No agents probed.</div>';
      return;
    }
    // If exactly one is available and nothing is selected, auto-pick it.
    const available = detection.agents.filter((a) => a.available);
    if (!selected && available.length >= 1) selected = available[0].command;
    // eslint-disable-next-line no-unsanitized/property -- Agent fields are escaped via escapeHtml/escapeAttr.
    list.innerHTML = detection.agents.map((a) => {
      const isSelected = selected === a.command;
      const action = a.available
        ? `<label class="fr-radio"><input type="radio" name="fr-agent" value="${escapeAttr(a.command)}" ${isSelected ? 'checked' : ''} /> use this</label>`
        : (a.installable
            ? `<button type="button" class="ghost-btn fr-install" data-id="${escapeAttr(a.id)}">Install</button>`
            : `<button type="button" class="ghost-btn" data-docs="${escapeAttr(a.docs || '')}">Open install page</button>`);
      const status = a.available
        ? '<span class="fr-status fr-status-ok">found</span>'
        : '<span class="fr-status fr-status-missing">not installed</span>';
      return `
        <div class="fr-agent" data-id="${escapeAttr(a.id)}">
          <div class="fr-agent-info">
            <span class="fr-agent-name">${escapeHtml(a.label)}</span>
            <span class="fr-agent-cmd">${escapeHtml(a.command)}</span>
          </div>
          ${status}
          <div class="fr-agent-action">${action}</div>
        </div>`;
    }).join('');
    list.querySelectorAll('input[name="fr-agent"]').forEach((r) => {
      r.addEventListener('change', () => { selected = r.value; updateGoBtn(); });
    });
    list.querySelectorAll('[data-docs]').forEach((b) => {
      b.addEventListener('click', () => {
        const url = b.getAttribute('data-docs');
        if (url) window.open(url, '_blank');
      });
    });
    list.querySelectorAll('.fr-install').forEach((b) => {
      b.addEventListener('click', () => installAgent(b.dataset.id, b));
    });
    updateGoBtn();
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
      // Re-probe and re-render so the radio appears for this agent.
      await refreshDetection();
      // If no agent was previously selected, auto-pick the just-installed one.
      if (!selected) selected = def.command;
      paintAgents();
    } else {
      btn.textContent = 'Retry';
      log.textContent += `\n[install failed] ${(r && r.error) || 'unknown error'}\n`;
    }
  }

  function updateGoBtn() {
    goBtn.disabled = !selected;
  }

  async function commit() {
    const name = (nameInput.value || '').trim().slice(0, 40) || 'Husk';
    const cmd = (selected || 'claude').trim();
    cfg = await window.husk.config.set({ agentCommand: cmd, agentName: name, firstRunDone: true });
    modal.hidden = true;
  }

  goBtn.addEventListener('click', commit);
  skipBtn.addEventListener('click', async () => {
    const name = (nameInput.value || '').trim().slice(0, 40) || 'Husk';
    cfg = await window.husk.config.set({ agentCommand: cfg.agentCommand || 'claude', agentName: name, firstRunDone: true });
    modal.hidden = true;
  });

  await refreshDetection();
  // Block boot until the modal is dismissed by Continue or Skip.
  await new Promise((resolve) => {
    const i = setInterval(() => { if (modal.hidden) { clearInterval(i); resolve(); } }, 100);
  });
}

async function boot() {
  cfg = await window.husk.config.get();
  try { huskHome = await window.husk.fs.home() || '~'; } catch (_) {}
  profilesCache = await window.husk.profiles.list();
  applyTheme(cfg.theme || 'dark');
  applyAccent(cfg.accent || 'orange');
  document.body.dataset.rail = cfg.railExpanded ? 'expanded' : 'collapsed';
  document.body.dataset.status = cfg.statusCollapsed ? 'collapsed' : 'expanded';
  syncRailToggleTitle();
  syncStatusToggleTitle();

  if (!cfg.firstRunDone) {
    await runFirstRunWizard();
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

  $('#chat-empty').classList.add('show');

  // Cold boot: show the welcome state and wait for the user to click Launch
  // (or a suggestion chip). If they previously checked "don't show this on
  // next launch", skip the welcome and start the agent immediately.
  if (cfg.skipWelcome) {
    $('#chat-empty').classList.remove('show');
    await startPty();
  }
}

async function launchAgent({ initialPrompt = null } = {}) {
  const skipBox = $('#ce-skip-next');
  if (skipBox && skipBox.checked && !cfg.skipWelcome) {
    cfg = await window.husk.config.set({ skipWelcome: true });
  }
  $('#chat-empty').classList.remove('show');
  await startPty();
  if (initialPrompt) {
    setTimeout(() => {
      armRecap();
      window.husk.pty.write(initialPrompt);
      term.focus();
    }, 250);
  }
}

// ─── Autonomy Mode ────────────────────────────────────────────────────────────
//
// The chat header has an Autonomy button that opens a start-dialog. The
// renderer collects goal + caps, asks the supervisor (via IPC) to start a
// run, then shows a live banner above the chat with a Cancel button. When
// the run ends (naturally, by cap, or by user), the supervisor sends an
// autonomy:ended event with the summary; the renderer opens a review
// modal with the diff and a one-click Revert.
let autonomyActive = false;
let autonomyLastSession = null;
// True while a run is being started (snapshot capture + spawn). During this
// window the wizard must not be dismissable: a stray backdrop click or Esc
// used to hide it mid-capture and leave the user unsure if the run survived.
let autonomyStarting = false;
function openAutonomyStart() {
  const hasProject = !!(activeProjectId && projectsCache.some((p) => p && p.id === activeProjectId));
  const noProj = $('#aut-no-project');
  const body = $('#aut-start-body');
  const foot = $('#aut-start-foot');
  if (noProj) noProj.hidden = hasProject;
  if (body) body.hidden = !hasProject;
  if (foot) foot.hidden = !hasProject;
  $('#autonomy-start-modal').hidden = false;
  if (hasProject) setTimeout(() => { try { $('#aut-goal').focus(); } catch (_) {} }, 0);
}
function closeAutonomyStart() {
  // Never tear down the wizard while a run is mid-launch.
  if (autonomyStarting) return;
  $('#autonomy-start-modal').hidden = true;
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
async function startAutonomy() {
  const goal = ($('#aut-goal').value || '').trim();
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
  const goBtn = $('#aut-start-go');
  const cancelBtn = $('#aut-start-cancel');
  const status = $('#aut-snapshot-status');
  const goLabelBefore = goBtn ? goBtn.textContent : 'Start run';
  autonomyStarting = true;
  if (goBtn) { goBtn.disabled = true; goBtn.textContent = snapshot ? 'Capturing snapshot...' : 'Starting run...'; }
  if (cancelBtn) cancelBtn.disabled = true;
  if (status) { status.hidden = false; status.textContent = snapshot ? 'Capturing workspace snapshot...' : 'Starting run...'; }
  try {
    const r = await window.husk.autonomy.start({ goal, caps, snapshot });
    if (!r || !r.ok) {
      toast((r && r.error) || 'Could not start autonomy', 'error');
      if (status) { status.hidden = true; status.textContent = ''; }
      return;
    }
    autonomyActive = true;
    autonomyLastSession = { sessionId: r.sessionId, workspaceRoot: r.workspaceRoot };
    autonomyState.startedAt = Date.now();
    resetAutonomyPanel();
    setAutonomyGoal(goal);
    setAutonomyCaps(caps);
    // Release the close guard before dismissing the wizard.
    autonomyStarting = false;
    closeAutonomyStart();
    try { setPage('autonomy'); } catch (_) {}
    paintAutonomyBanner();
    const fc = Number(r.fileCount) || 0;
    toast(snapshot ? `Autonomy running, snapshot of ${fc} files captured` : 'Autonomy running (no snapshot)', 'success');
  } finally {
    autonomyStarting = false;
    if (goBtn) { goBtn.disabled = false; goBtn.textContent = goLabelBefore; }
    if (cancelBtn) cancelBtn.disabled = false;
    if (status) { status.hidden = true; status.textContent = ''; }
  }
}
async function cancelAutonomy() {
  if (!autonomyActive) return;
  // Stopping a run is destructive to in-flight work, so confirm first.
  // This is the explicit Stop action; the chat autonomy button no longer
  // routes here (it opens the run view instead) so a stray click cannot
  // end a run by accident.
  const ok = await openConfirmDialog({
    title: 'Stop the autonomy run?',
    bodyHtml: 'The agent will be interrupted and the run will end. Your workspace changes are kept; you can review or revert them afterward.',
    confirmLabel: 'Stop run',
    cancelLabel: 'Keep running',
  });
  if (!ok) return;
  const r = await window.husk.autonomy.cancel({});
  if (!r || !r.ok) { toast((r && r.error) || 'Cancel failed', 'error'); return; }
}
// Curated preset goals. Each preset prefills the start-run modal so
// users have a clear first action instead of staring at a blank
// textarea. Caps are sensible defaults; user can edit before running.
const AUTONOMY_PRESETS = [
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
];

function renderAutonomyPage() {
  // Static parts: presets gallery. Re-rendered every visit so it
  // refreshes with workspace switches without bookkeeping.
  const grid = $('#aut-preset-grid');
  if (grid) {
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    for (const p of AUTONOMY_PRESETS) {
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
  refreshAutonomyHistory();
  // Restore the live/running (or review) view on every visit so a run
  // started earlier is never hidden behind the empty/presets state.
  paintAutonomyBanner();
}

function loadPresetIntoStartModal(p) {
  openAutonomyStart();
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
  if (autonomyActive) { toast('A run is already active', 'info'); return; }
  // Exit any review session so the modal opens cleanly.
  if (autonomyReview) {
    autonomyReview = false;
    autonomyReviewData = null;
    paintAutonomyBanner();
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
  const ok = await openConfirmDialog({
    title: 'Delete this run?',
    bodyHtml: "This permanently removes the run's snapshot, audit log, and saved file versions. You will no longer be able to review or revert it.",
    confirmLabel: 'Delete run',
    cancelLabel: 'Keep',
  });
  if (!ok) return;
  const r = await window.husk.autonomy.deleteRun({ sessionId: run.sessionId });
  if (!r || !r.ok) { toast((r && r.error) || 'Could not delete run', 'error'); return; }
  toast('Run deleted', 'success');
  // If the deleted run is the one currently under review, leave review
  // mode; otherwise just refresh the list in place.
  if (autonomyReview && autonomyReviewData && autonomyReviewData.sessionId === run.sessionId) {
    exitReviewMode();
  } else {
    refreshAutonomyHistory();
  }
}
async function refreshAutonomyHistory() {
  const list = $('#aut-recent');
  const meta = $('#aut-recent-meta');
  const heroRuns = $('#aut-hero-runs');
  const heroFiles = $('#aut-hero-files');
  const heroSpend = $('#aut-hero-spend');
  if (!list) return;
  const active = projectsCache.find((p) => p && p.id === activeProjectId);
  const workspaceRoot = active && active.path ? active.path : null;
  let r;
  try { r = await window.husk.autonomy.history({ workspaceRoot }); }
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
  if (!runs.length) {
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'No prior runs in this project.';
    list.appendChild(empty);
    if (meta) meta.textContent = 'no runs yet';
    if (heroRuns) heroRuns.textContent = '0';
    if (heroFiles) heroFiles.textContent = '0';
    if (heroSpend) heroSpend.textContent = '$0';
    return;
  }
  let totalFiles = 0;
  let totalSpend = 0;
  for (const run of runs) {
    totalFiles += Number(run.fileCount) || 0;
    totalSpend += Number(run.dollars) || 0;
    const row = document.createElement('div');
    row.className = 'aut-recent-row';
    row.dataset.session = run.sessionId;
    const main = document.createElement('div');
    main.className = 'aut-recent-main';
    const goal = document.createElement('div');
    goal.className = 'aut-recent-goal';
    goal.textContent = run.goal || '(no goal recorded)';
    const m2 = document.createElement('div');
    m2.className = 'aut-recent-meta';
    const when = run.endedAt || run.capturedAt;
    m2.textContent = `${fmtRelTime(when)} · ${run.sessionId.slice(5, 17)}`;
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
    row.addEventListener('click', () => openAutonomyRunReview(run.sessionId, run.workspaceRoot));
    list.appendChild(row);
  }
  if (meta) meta.textContent = `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`;
  if (heroRuns) heroRuns.textContent = String(runs.length);
  if (heroFiles) heroFiles.textContent = String(totalFiles);
  if (heroSpend) heroSpend.textContent = formatDollars(totalSpend);
}

// Load a past run into the live layout in REVIEW mode. Same panes
// (goal, rings, files, activity) but values are frozen and the
// footer shows Revert / Start-new instead of Stop. Activity feed
// for past runs is summarized (line text is not retained in the
// audit log, only event kinds + char counts).
async function openAutonomyRunReview(sessionId, workspaceRoot) {
  try { setPage('autonomy'); } catch (_) {}
  try {
    const sum = await window.husk.autonomy.summary({ sessionId, workspaceRoot });
    if (!sum || !sum.ok) { toast((sum && sum.error) || 'Could not load run', 'error'); return; }
    enterReviewMode({ sessionId, workspaceRoot, summary: sum });
  } catch (err) {
    toast(`Could not load run: ${err && err.message || err}`, 'error');
  }
}

// Autonomy live state. Driven by autonomy:started / autonomy:budget
// IPC events, a 4s poll of autonomy:liveDiff, AND a terminal-buffer
// snapshotter that reads what xterm.js has rendered (the right
// source for "what the agent showed the user"). Parsing the raw
// PTY byte stream was the previous wrong approach: that stream is
// commands to a terminal emulator, not a log, so any naive line
// parse over it fragments TUI output. xterm has already done the
// hard work of rendering; we just read its buffer.
const AP_RING_C = 2 * Math.PI * 42; // r=42 on the big page rings
const AP_FEED_MAX_ROWS = 300;
const AP_DIFF_POLL_MS = 4000;
const AP_TERM_SNAP_MS = 1200;
const AP_TERM_SCAN_WINDOW = 60;
const AP_TERM_SEEN_MAX = 400;
// Auto-finalize a run when the agent appears idle. Two paths:
//   AP_IDLE_END_MS:      quiet + prompt detected -> end
//   AP_IDLE_END_HARD_MS: quiet for much longer -> end regardless of
//                        prompt detection (different agents render
//                        the prompt differently; this is the safety
//                        net so we never miss a finished run)
// Both gated by AP_MIN_EVENTS_BEFORE_AUTO_END so we never end a run
// that never started.
const AP_IDLE_END_MS = 10000;
const AP_IDLE_END_HARD_MS = 25000;
const AP_MIN_EVENTS_BEFORE_AUTO_END = 3;
// The agent's "working" indicator (claude renders "esc to interrupt" and
// a live "(12s . N tokens . ...)" status line while generating or running
// a tool). When it is present the agent is busy; when it has been gone
// this long the turn is finished. Driving auto-end off this is both
// faster (ends seconds after the agent returns to its prompt) and safer
// (a busy-but-quiet agent still shows the indicator, so it is not ended
// mid-flight).
const AP_WORK_GONE_MS = 6000;
// Busy markers across agents: claude renders "esc to interrupt" and a live
// "(12s . N tokens)" status; copilot renders a "Working" spinner label.
// Matching any of them keeps a run alive while the agent is generating.
const AP_WORKING_RE = /esc to interrupt|\(\s*\d+\s*s\s*[·•.]|\bworking\b/i;
let autonomyTermInterval = null;
let autonomyTermSeenLines = new Set();
let autonomyTermSeenOrder = [];
let autonomyLastActivityAt = 0;
// Last time the agent's working indicator was visible, and whether it has
// ever been seen this run. Both drive completion detection.
let autonomyWorkingSeenAt = 0;
let autonomyEverWorked = false;
let autonomyAutoEndTriggered = false;
let autonomyReview = false;
let autonomyReviewData = null;
let autonomyState = {
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
function paintAutonomyBanner() {
  const label = $('#autonomy-label');
  const pulse = $('#rail-aut-pulse');
  const empty = $('#aut-page-empty');
  const live = $('#aut-page-live');
  const status = $('#aut-page-status');
  const statusText = $('#aut-page-status-text');
  const startBtn = $('#aut-page-start');
  const stopBtnTop = $('#aut-page-stop-top');
  const reviewButtons = document.querySelectorAll('.aut-review-only');
  const backBtn = $('#aut-review-back');
  const pageEl = document.querySelector('.page-autonomy');
  const showLive = autonomyActive || autonomyReview;
  if (label) label.textContent = autonomyActive ? 'Autonomy ON' : 'Autonomy';
  if (pulse) pulse.hidden = !autonomyActive;
  if (empty) empty.hidden = showLive;
  if (live) live.hidden = !showLive;
  if (status) status.hidden = !showLive;
  if (pageEl) pageEl.classList.toggle('is-live', !!showLive);
  // While a run is active OR a review is open, the header Start
  // button is replaced by the status pill; showing both is
  // contradictory.
  if (startBtn) startBtn.hidden = showLive;
  if (stopBtnTop) stopBtnTop.hidden = !autonomyActive;
  // Revert needs a pre-run snapshot. Runs started with the snapshot toggle
  // off carry hasSnapshot === false, so the Revert button stays hidden even
  // in review (older runs without the field are treated as snapshotted).
  const reviewHasSnapshot = !(autonomyReviewData && autonomyReviewData.summary
    && autonomyReviewData.summary.hasSnapshot === false);
  reviewButtons.forEach((b) => {
    const isRevert = b.id === 'aut-review-revert';
    b.hidden = !autonomyReview || (isRevert && !reviewHasSnapshot);
  });
  if (backBtn) backBtn.hidden = !autonomyReview;
  // Status pill content shifts by mode.
  if (statusText) {
    if (autonomyActive) statusText.textContent = 'Running';
    else if (autonomyReview && autonomyReviewData) {
      const s = autonomyReviewData.summary && autonomyReviewData.summary.summary;
      const haltReason = (s && s.haltReason) || 'ended';
      statusText.textContent = haltReason === 'natural' ? 'Ended' : (haltReason.charAt(0).toUpperCase() + haltReason.slice(1));
    } else statusText.textContent = '';
  }
  // Re-style the status pill in review mode (no accent pulse).
  if (status) status.classList.toggle('is-review', !autonomyActive && autonomyReview);
  if (autonomyActive) {
    if (!autonomyState.tickerId) {
      autonomyState.tickerId = setInterval(updateAutonomyElapsed, 1000);
      updateAutonomyElapsed();
    }
    startLiveDiffPoll();
    startAutonomyTermSnapshotter();
  } else {
    if (autonomyState.tickerId) { clearInterval(autonomyState.tickerId); autonomyState.tickerId = null; }
    stopLiveDiffPoll();
    stopAutonomyTermSnapshotter();
  }
}
function exitReviewMode() {
  autonomyReview = false;
  autonomyReviewData = null;
  resetAutonomyPanel();
  paintAutonomyBanner();
  refreshAutonomyHistory();
}
function enterReviewMode({ sessionId, workspaceRoot, summary }) {
  autonomyActive = false;
  autonomyReview = true;
  autonomyReviewData = { sessionId, workspaceRoot, summary };
  resetAutonomyPanel();
  const s = summary && summary.summary;
  // Goal lives in the start_run row (summary.goal). The run_summary
  // payload (s) carries final meter/diff but not the goal. Use the
  // start_run goal as truth; fall back ONLY if even that is missing.
  const realGoal = (summary && typeof summary.goal === 'string' && summary.goal) || (s && s.goal) || null;
  setAutonomyGoal(realGoal || '(no goal recorded for this run)');
  // Caps: start_run row first, then meter.caps, then current defaults.
  const caps = (summary && summary.caps) || (s && s.meter && s.meter.caps) || autonomyState.caps;
  setAutonomyCaps(caps);
  // Show a frozen elapsed timer = the final duration.
  const ms = (s && s.durationMs) || 0;
  const elSec = Math.floor(ms / 1000);
  const elMin = Math.floor(elSec / 60);
  const elapsedTxt = elMin === 0 ? `${elSec}s` : `${elMin}m ${String(elSec % 60).padStart(2, '0')}s`;
  const headEl = $('#aut-page-elapsed'); if (headEl) headEl.textContent = elapsedTxt;
  // Paint rings with final values.
  const finalBudget = (s && s.meter) || null;
  if (finalBudget) {
    autonomyState.startedAt = Date.now() - ms;
    updateAutonomyBudget(finalBudget);
  }
  // Touched files = final diff from the run.
  const diff = (summary && summary.diff) || [];
  autonomyState.files = diff.slice();
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
  pushActivity(lines);
  paintAutonomyBanner();
}
function setAutonomyGoal(goal) {
  autonomyState.goal = goal || '(no goal provided)';
  const el = $('#aut-page-goal-text');
  if (el) el.textContent = autonomyState.goal;
}
function setAutonomyCaps(caps) {
  autonomyState.caps = Object.assign({ minutes: 60, tokens: 200000, dollars: 5 }, caps || {});
  const c = autonomyState.caps;
  const tc = $('#aut-page-cap-time'); if (tc) tc.textContent = c.minutes > 0 ? `of ${c.minutes}m` : 'no time limit';
  const ko = $('#aut-page-cap-tokens'); if (ko) ko.textContent = c.tokens > 0 ? `of ${formatTokens(c.tokens)}` : 'no token limit';
  const dc = $('#aut-page-cap-dollars'); if (dc) dc.textContent = c.dollars > 0 ? `of ${formatDollars(c.dollars)}` : 'no $ limit';
}
function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
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
function updateAutonomyBudget(b) {
  if (!b) return;
  autonomyState.budget = b;
  const caps = autonomyState.caps;
  const meters = document.querySelectorAll('.aut-page-meter');
  const elapsedMin = (Date.now() - autonomyState.startedAt) / 60000;
  const tv = $('#aut-page-val-time');
  if (tv) tv.textContent = elapsedMin < 1 ? `${Math.floor(elapsedMin * 60)}s` : `${elapsedMin.toFixed(1)}m`;
  updateRing('aut-page-ring-time', caps.minutes > 0 ? elapsedMin / caps.minutes : 0, meters[0]);
  const tk = Number(b.totalTokens) || 0;
  // The token figure is read from the agent's own status line and is an
  // approximation (per-turn / context-relative depending on the agent),
  // so mark it as approximate rather than presenting an exact count.
  const approx = !!(b.tokensReported || b.tokensEstimated);
  const tv2 = $('#aut-page-val-tokens');
  if (tv2) {
    tv2.textContent = (approx && tk > 0 ? '~' : '') + formatTokens(tk);
    tv2.title = approx ? 'Approximate, read from the agent status line' : '';
  }
  updateRing('aut-page-ring-tokens', caps.tokens > 0 ? tk / caps.tokens : 0, meters[1]);
  const usd = Number(b.dollars) || 0;
  const dv = $('#aut-page-val-dollars');
  if (dv) dv.textContent = formatDollars(usd);
  updateRing('aut-page-ring-dollars', caps.dollars > 0 ? usd / caps.dollars : 0, meters[2]);
}
function updateAutonomyElapsed() {
  if (!autonomyActive) return;
  const ms = Date.now() - autonomyState.startedAt;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  const tag = m === 0 ? `${r}s` : `${m}m ${String(r).padStart(2, '0')}s`;
  const headEl = $('#aut-page-elapsed'); if (headEl) headEl.textContent = tag;
  if (autonomyState.budget) updateAutonomyBudget(autonomyState.budget);
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

function pushActivity(lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  const feed = $('#aut-page-feed');
  if (!feed) return;
  const empty = feed.querySelector('.aut-page-feed-empty');
  if (empty) empty.remove();
  for (const raw of lines) {
    const text = String(raw).slice(0, 320);
    if (!text || text.length < 3) continue;
    const normalized = normalizeForSpinnerDedupe(text);
    const lastRow = feed.lastElementChild;
    if (lastRow && lastRow.dataset && lastRow.dataset.norm === normalized) {
      // Same spinner line, just a new glyph. Update text and flash
      // the row so the user sees the agent is still moving without
      // a new row landing every 100ms.
      const textEl = lastRow.querySelector('.ap-row-text');
      if (textEl) textEl.textContent = text;
      lastRow.classList.remove('is-spinning');
      // Force a reflow so the animation restart applies.
      void lastRow.offsetWidth;
      lastRow.classList.add('is-spinning');
      continue;
    }
    autonomyState.feed.push(text);
    autonomyState.eventCount += 1;
    autonomyLastActivityAt = Date.now();
    const row = document.createElement('div');
    row.className = `ap-feed-row ${classifyActivityLine(text)}`.trim();
    row.dataset.norm = normalized;
    const glyph = document.createElement('span');
    glyph.className = 'ap-row-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    const span = document.createElement('span');
    span.className = 'ap-row-text';
    span.textContent = text;
    row.appendChild(glyph);
    row.appendChild(span);
    feed.appendChild(row);
  }
  while (feed.children.length > AP_FEED_MAX_ROWS) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
  const ec = $('#aut-page-event-count');
  if (ec) ec.textContent = `${autonomyState.eventCount} ${autonomyState.eventCount === 1 ? 'event' : 'events'}`;
}
function renderTouchedFiles(changes) {
  const pane = $('#aut-page-files');
  const counter = $('#aut-page-files-count');
  if (!pane) return;
  while (pane.firstChild) pane.removeChild(pane.firstChild);
  if (!Array.isArray(changes) || !changes.length) {
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'No file changes yet.';
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
    row.addEventListener('click', () => openFileDiffModal(c.path, c.status));
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

async function openFileDiffModal(relPath, status) {
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
  let sessionId = autonomyLastSession && autonomyLastSession.sessionId;
  let workspaceRoot = autonomyLastSession && autonomyLastSession.workspaceRoot;
  if (autonomyReview && autonomyReviewData) {
    sessionId = autonomyReviewData.sessionId;
    workspaceRoot = autonomyReviewData.workspaceRoot;
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
    res = await window.husk.autonomy.fileDiff({ sessionId, workspaceRoot, path: relPath });
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
// Parse an agent's "N tokens" status indicator out of a rendered
// terminal line. claude format: "(30s · ↓ 1.5k tokens · ...)".
// codex format: "1234 tokens used". aider: "Tokens: ... sent, ...".
// Returns absolute cumulative token count or null.
function parseAgentTokenStatus(line) {
  if (!line) return null;
  // Match a number (with optional decimal + k/m suffix) immediately
  // before the word "tokens" (case-insensitive). Examples we WANT
  // to match: "1.5k tokens", "↓ 1.5k tokens", "2,300 tokens used",
  // "Tokens: 1234 sent" (handled by inverse below).
  // "152k/200k tokens" is context-used / context-window. The number
  // directly before "tokens" is the window SIZE, not usage, so prefer the
  // used side (the numerator) before falling through to the generic match.
  const ratio = line.match(/(\d[\d,\.]*)\s*([kKmM]?)\s*\/\s*\d[\d,\.]*\s*[kKmM]?\s*tokens?\b/i);
  if (ratio) return parseTokenNumber(ratio[1], ratio[2]);
  const after = line.match(/(\d[\d,\.]*)\s*([kKmM]?)\s*tokens?\b/);
  if (after) return parseTokenNumber(after[1], after[2]);
  const before = line.match(/tokens?\s*[:=]\s*(\d[\d,\.]*)\s*([kKmM]?)/i);
  if (before) return parseTokenNumber(before[1], before[2]);
  return null;
}
function parseTokenNumber(raw, suffix) {
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const mult = suffix && /m/i.test(suffix) ? 1_000_000 : (suffix && /k/i.test(suffix) ? 1000 : 1);
  return Math.floor(n * mult);
}

function rememberSeenLine(trimmed) {
  if (autonomyTermSeenLines.has(trimmed)) return false;
  autonomyTermSeenLines.add(trimmed);
  autonomyTermSeenOrder.push(trimmed);
  while (autonomyTermSeenOrder.length > AP_TERM_SEEN_MAX) {
    const old = autonomyTermSeenOrder.shift();
    autonomyTermSeenLines.delete(old);
  }
  return true;
}

// Snapshot xterm.js's rendered buffer and push net-new lines to the
// activity feed. We DO NOT use a row-index baseline because:
//   1. xterm.js scrollback eviction keeps buffer.length capped at
//      the scrollback setting; new content evicts old, so
//      `total > baseline` would never trigger after the cap.
//   2. TUI agents that swap to the alternate screen buffer change
//      what `buffer.active` points at; a baseline taken from the
//      normal buffer is invalid against the alternate.
// Content-based dedupe avoids both: read the LAST ~60 rows each
// tick and push only lines we have not surfaced yet (tracked in
// autonomyTermSeenLines, a Set of size AP_TERM_SEEN_MAX).
function snapshotTermForAutonomy() {
  if (!term || !term.buffer) return;
  const b = term.buffer.active;
  const total = b.length;
  if (total === 0) return;
  const start = Math.max(0, total - AP_TERM_SCAN_WINDOW);
  const newLines = [];
  for (let i = start; i < total; i++) {
    const ln = b.getLine(i);
    if (!ln) continue;
    const text = ln.translateToString(true);
    if (!text) continue;
    const trimmed = text.replace(/\s+$/, '').trim();
    if (trimmed.length < 2) continue;
    if (rememberSeenLine(trimmed)) newLines.push(trimmed);
  }
  if (newLines.length) pushActivity(newLines);
  // Token report: scan the LAST 200 rows for the agent's own status
  // line, take the MAX value seen. The meter is monotonic so a
  // larger number wins even if we hit older + newer rows on the
  // same pass; that means we always converge to the highest value
  // claude has rendered so far, surviving status-line flicker.
  const scanFrom = Math.max(0, total - 200);
  let maxReported = -1;
  for (let i = scanFrom; i < total; i++) {
    const ln = b.getLine(i);
    if (!ln) continue;
    const text = ln.translateToString(true);
    const parsed = parseAgentTokenStatus(text);
    if (parsed != null && parsed > maxReported) maxReported = parsed;
  }
  if (maxReported >= 0 && window.husk && window.husk.autonomy && window.husk.autonomy.reportTokens) {
    try { window.husk.autonomy.reportTokens(maxReported); } catch (_) {}
  }
  // Working-indicator detection drives completion. Scan the last rows for
  // the agent's "busy" marker; while it is present the agent is generating
  // or running a tool, so the run must not be auto-ended.
  let working = false;
  for (let i = Math.max(0, total - AP_TERM_SCAN_WINDOW); i < total; i++) {
    const ln = b.getLine(i);
    if (!ln) continue;
    if (AP_WORKING_RE.test(ln.translateToString(true))) { working = true; break; }
  }
  if (working) { autonomyWorkingSeenAt = Date.now(); autonomyEverWorked = true; }

  // Completion watchdog. Primary signal: the agent worked, then its
  // working indicator went away and stayed away, and the terminal looks
  // like it is back at a prompt. This ends the run within seconds of the
  // agent actually finishing, and cannot fire while the agent is busy.
  // The quiet-only hard net remains as a fallback for agents that show no
  // recognizable working indicator, but it too waits for "not working".
  if (autonomyActive && !autonomyAutoEndTriggered
      && autonomyState.eventCount >= AP_MIN_EVENTS_BEFORE_AUTO_END
      && autonomyLastActivityAt > 0) {
    const now = Date.now();
    const idleMs = now - autonomyLastActivityAt;
    const workGoneMs = autonomyWorkingSeenAt ? now - autonomyWorkingSeenAt : Infinity;
    const notWorking = !working && workGoneMs >= AP_WORK_GONE_MS;
    const finishedAfterWork = autonomyEverWorked && notWorking
      && (terminalLooksIdleAtPrompt() || idleMs >= AP_IDLE_END_MS);
    const quietFallback = notWorking && idleMs >= AP_IDLE_END_HARD_MS;
    if (finishedAfterWork || quietFallback) {
      autonomyAutoEndTriggered = true;
      finalizeAutonomyOnIdle();
    }
  }
}

function terminalLooksIdleAtPrompt() {
  if (!term || !term.buffer) return false;
  const b = term.buffer.active;
  const total = b.length;
  if (total === 0) return false;
  // Search the LAST 15 rows for ANY prompt-like row. Previously
  // this required the LAST non-blank row to be the prompt, but
  // claude renders input-area hints ("← for agents") BELOW the
  // prompt, so the strict version never matched. Relaxed search
  // is more forgiving and still rare to false-positive: prompt
  // characters in agent output are usually inside other tokens
  // (URL, code), not at the start of a short line.
  for (let i = total - 1; i >= Math.max(0, total - 15); i--) {
    const ln = b.getLine(i);
    if (!ln) continue;
    const text = ln.translateToString(true).replace(/\s+$/, '');
    if (!text) continue;
    const trimmed = text.trim();
    if (/^[>›❯❱│║┃]\s*$/.test(trimmed)) return true;
    if (/^[>›❯❱]\s/.test(trimmed) && trimmed.length < 60) return true;
    // claude often renders its prompt inside a box-drawing frame:
    // "│ >                                              │"
    if (/^[│║┃].*[>›❯❱].*[│║┃]\s*$/.test(trimmed)) return true;
  }
  return false;
}

async function finalizeAutonomyOnIdle() {
  if (!autonomyActive) return;
  try {
    // The top-center run-complete banner is shown by onEnded; no corner
    // toast here so the two do not duplicate.
    await window.husk.autonomy.end({ reason: 'agent_idle' });
  } catch (err) {
    // If the end call fails, allow another idle attempt next tick.
    autonomyAutoEndTriggered = false;
  }
}

function startAutonomyTermSnapshotter() {
  if (autonomyTermInterval) return;
  if (!term || !term.buffer) return;
  // Seed the seen-set with EVERY line currently in the buffer. That
  // is "what happened before this run". Only rows added afterwards
  // (goal echo, agent response, tool calls) will fail the dedupe
  // and surface in the feed.
  autonomyTermSeenLines = new Set();
  autonomyTermSeenOrder = [];
  autonomyLastActivityAt = Date.now();
  autonomyAutoEndTriggered = false;
  autonomyWorkingSeenAt = 0;
  autonomyEverWorked = false;
  const b = term.buffer.active;
  const total = b.length;
  for (let i = 0; i < total; i++) {
    const ln = b.getLine(i);
    if (!ln) continue;
    const text = ln.translateToString(true);
    if (!text) continue;
    const trimmed = text.replace(/\s+$/, '').trim();
    if (trimmed.length < 2) continue;
    rememberSeenLine(trimmed);
  }
  autonomyTermInterval = setInterval(snapshotTermForAutonomy, AP_TERM_SNAP_MS);
  // Fire one immediately so the goal echo (already on screen after
  // injection delay) surfaces without waiting a full tick.
  setTimeout(snapshotTermForAutonomy, 250);
}

function stopAutonomyTermSnapshotter() {
  if (autonomyTermInterval) clearInterval(autonomyTermInterval);
  autonomyTermInterval = null;
  autonomyTermSeenLines = new Set();
  autonomyTermSeenOrder = [];
}

async function pollLiveDiff() {
  if (!autonomyActive) return;
  try {
    const r = await window.husk.autonomy.liveDiff();
    if (!r || !r.ok) return;
    autonomyState.files = r.changes || [];
    renderTouchedFiles(autonomyState.files);
  } catch (_) {}
}
function startLiveDiffPoll() {
  if (autonomyState.diffPollId) return;
  pollLiveDiff();
  autonomyState.diffPollId = setInterval(pollLiveDiff, AP_DIFF_POLL_MS);
}
function stopLiveDiffPoll() {
  if (autonomyState.diffPollId) { clearInterval(autonomyState.diffPollId); autonomyState.diffPollId = null; }
}
function resetAutonomyPanel() {
  autonomyState.feed = [];
  autonomyState.eventCount = 0;
  autonomyState.budget = null;
  autonomyState.files = [];
  const feed = $('#aut-page-feed');
  if (feed) {
    while (feed.firstChild) feed.removeChild(feed.firstChild);
    const empty = document.createElement('div');
    empty.className = 'aut-page-feed-empty';
    empty.textContent = 'Waiting for the agent to begin...';
    feed.appendChild(empty);
  }
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
function openAutonomyEndModal(sum) {
  if (!sum || !sum.ok) { toast('Could not load run summary', 'error'); return; }
  const meta = $('#aut-end-meta');
  const diff = $('#aut-end-diff');
  const title = $('#aut-end-title');
  const status = (sum.summary && sum.summary.status) || 'ended';
  const haltReason = (sum.summary && sum.summary.haltReason) || 'natural';
  const durationMin = sum.summary && sum.summary.durationMs ? Math.round(sum.summary.durationMs / 60000 * 10) / 10 : 0;
  title.textContent = `Autonomy run ${status}`;
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
  $('#autonomy-end-modal').hidden = false;
}
function closeAutonomyEndModal() { $('#autonomy-end-modal').hidden = true; }
// Report a revert honestly: a non-empty warnings list means some files
// were NOT restored (decrypt failure, blob mismatch, fs error). The old
// unconditional "success" toast hid partial reverts, which is the exact
// trust violation the feature exists to prevent.
function reportRevertResult(r) {
  const restored = (r.restored || []).length;
  const warned = (r.warnings || []).length;
  if (warned) {
    toast(`Reverted ${restored} file${restored === 1 ? '' : 's'}; ${warned} could not be restored`, 'error');
  } else {
    toast(`Reverted ${restored} file${restored === 1 ? '' : 's'}`, 'success');
  }
}
async function revertAutonomy() {
  if (!autonomyLastSession) { toast('No run to revert', 'error'); return; }
  const ok = await openConfirmDialog({
    title: 'Revert every change from this autonomy run?',
    bodyHtml: 'Husk will restore the workspace to the pre-run snapshot. Files the agent created will be removed. This cannot be undone from the UI.',
    confirmLabel: 'Revert all',
    cancelLabel: 'Keep changes',
  });
  if (!ok) return;
  const r = await window.husk.autonomy.revert(autonomyLastSession);
  if (!r || !r.ok) { toast((r && r.error) || 'Revert failed', 'error'); return; }
  reportRevertResult(r);
  closeAutonomyEndModal();
}
$('#btn-autonomy') && $('#btn-autonomy').addEventListener('click', () => {
  // While a run is active this button takes the user to the run view, it
  // does NOT stop the run. Stopping is the explicit Stop button on the
  // autonomy page (which confirms). A second click here used to silently
  // cancel the run, which read as "open status" to users.
  if (autonomyActive) { try { setPage('autonomy'); } catch (_) {} return; }
  openAutonomyStart();
});
$('#aut-start-close') && $('#aut-start-close').addEventListener('click', closeAutonomyStart);
$('#aut-start-cancel') && $('#aut-start-cancel').addEventListener('click', closeAutonomyStart);
$('#aut-start-go') && $('#aut-start-go').addEventListener('click', startAutonomy);
$('#aut-goto-projects') && $('#aut-goto-projects').addEventListener('click', () => {
  closeAutonomyStart();
  try { setPage('projects'); } catch (_) {}
});
$('#aut-end-close') && $('#aut-end-close').addEventListener('click', closeAutonomyEndModal);
$('#aut-end-close-foot') && $('#aut-end-close-foot').addEventListener('click', closeAutonomyEndModal);
$('#aut-end-revert') && $('#aut-end-revert').addEventListener('click', revertAutonomy);
$('#autonomy-start-modal') && $('#autonomy-start-modal').addEventListener('click', (e) => { if (e.target === $('#autonomy-start-modal')) closeAutonomyStart(); });
$('#autonomy-end-modal') && $('#autonomy-end-modal').addEventListener('click', (e) => { if (e.target === $('#autonomy-end-modal')) closeAutonomyEndModal(); });

try {
  if (window.husk && window.husk.autonomy) {
    window.husk.autonomy.onStarted((info) => {
      autonomyActive = true;
      autonomyState.startedAt = Date.now();
      if (info && typeof info.goal === 'string' && info.goal) setAutonomyGoal(info.goal);
      paintAutonomyBanner();
    });
    window.husk.autonomy.onEnded((sum) => {
      autonomyActive = false;
      // Slide the active layout into review mode in place. The page
      // already shows the goal, rings, files and feed; don't open a
      // separate modal on top. Refreshes history so the just-ended
      // run appears in Recent runs immediately.
      if (sum && sum.ok) {
        const sid = (autonomyLastSession && autonomyLastSession.sessionId) || (sum.sessionId || '');
        const wr = (autonomyLastSession && autonomyLastSession.workspaceRoot) || (sum.workspaceRoot || '');
        enterReviewMode({ sessionId: sid, workspaceRoot: wr, summary: sum });
        // Announce the end top-center where the user is looking.
        const halt = (sum.summary && sum.summary.haltReason) || 'natural';
        if (halt === 'budget') runEndBanner('Run stopped at a budget cap', 'budget');
        else if (halt === 'user') runEndBanner('Run stopped', 'stopped');
        else if (halt === 'agent-exited') runEndBanner('Run ended: agent exited', 'stopped');
        else runEndBanner('Run complete', '');
      } else {
        paintAutonomyBanner();
      }
      refreshAutonomyHistory();
    });
    window.husk.autonomy.onHalt((info) => {
      // Report the real cause. A budget cap names the cap; an agent that
      // exited on its own is not a budget event and must not be labelled
      // "budget".
      let why, level;
      if (info && info.cap) { why = `${info.cap} cap reached`; level = 'error'; }
      else if (info && info.reason === 'agent-exited') { why = 'agent exited'; level = 'info'; }
      else { why = 'stopped'; level = 'error'; }
      toast(`Autonomy halted: ${why}`, level);
    });
    if (window.husk.autonomy.onSnapshotProgress) {
      window.husk.autonomy.onSnapshotProgress((info) => {
        const status = $('#aut-snapshot-status');
        if (!status || status.hidden) return;
        const n = Number(info && info.count) || 0;
        status.textContent = `Capturing workspace snapshot... ${n} files`;
      });
    }
    if (window.husk.autonomy.onActivity) {
      window.husk.autonomy.onActivity((info) => {
        // Main process is the source of truth for run liveness. The
        // renderer must accept activity events whenever main sends
        // them, even if a stale `autonomyActive` flag here disagrees
        // (which has happened during page transitions and after
        // process restarts).
        if (info && Array.isArray(info.lines)) pushActivity(info.lines);
      });
    }
    if (window.husk.autonomy.onBudget) {
      window.husk.autonomy.onBudget((b) => {
        if (!autonomyActive) return;
        updateAutonomyBudget(b);
      });
    }
  }
} catch (_) {}

// Dedicated Autonomy page buttons. The header Start and the empty-state
// CTA both open the existing start-run modal. The Stop button cancels
// the active run (SIGINT into the PTY via the IPC handler).
$('#aut-page-start') && $('#aut-page-start').addEventListener('click', () => {
  if (autonomyActive) { toast('A run is already active', 'info'); return; }
  openAutonomyStart();
});
$('#aut-page-start-2') && $('#aut-page-start-2').addEventListener('click', () => {
  if (autonomyActive) return;
  openAutonomyStart();
});
$('#aut-page-stop-top') && $('#aut-page-stop-top').addEventListener('click', () => cancelAutonomy());
$('#aut-jump-presets') && $('#aut-jump-presets').addEventListener('click', () => {
  const el = $('#aut-presets-section');
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#aut-diff-close') && $('#aut-diff-close').addEventListener('click', closeFileDiffModal);
$('#aut-diff-modal') && $('#aut-diff-modal').addEventListener('click', (e) => { if (e.target === $('#aut-diff-modal')) closeFileDiffModal(); });
$('#aut-review-back') && $('#aut-review-back').addEventListener('click', exitReviewMode);
$('#aut-review-new') && $('#aut-review-new').addEventListener('click', () => {
  exitReviewMode();
  openAutonomyStart();
});
$('#aut-review-rerun') && $('#aut-review-rerun').addEventListener('click', () => {
  if (!autonomyReviewData) return;
  // Pull the real goal + caps from the start_run row (now surfaced
  // at top level on the summary payload). Do NOT fall back to
  // autonomyState.goal: that holds the display string which may be
  // the placeholder "(no goal recorded)" for runs missing data.
  const summary = autonomyReviewData.summary;
  const sumPayload = summary && summary.summary;
  const goal = (summary && typeof summary.goal === 'string' && summary.goal) || null;
  const caps = (summary && summary.caps) || (sumPayload && sumPayload.meter && sumPayload.meter.caps) || null;
  if (!goal) { toast('That run has no goal text to rerun', 'error'); return; }
  rerunFromPastRun({ goal, caps });
});
$('#aut-review-revert') && $('#aut-review-revert').addEventListener('click', async () => {
  if (!autonomyReviewData) return;
  const ok = await openConfirmDialog({
    title: 'Revert every change from this autonomy run?',
    bodyHtml: 'Husk will restore the workspace to the pre-run snapshot. Files the agent created will be removed. This cannot be undone from the UI.',
    confirmLabel: 'Revert all',
    cancelLabel: 'Keep changes',
  });
  if (!ok) return;
  const r = await window.husk.autonomy.revert({
    sessionId: autonomyReviewData.sessionId,
    workspaceRoot: autonomyReviewData.workspaceRoot,
  });
  if (!r || !r.ok) { toast((r && r.error) || 'Revert failed', 'error'); return; }
  reportRevertResult(r);
  // Refresh the live diff view from disk so it reflects the revert.
  if (autonomyReviewData) {
    const sum = await window.husk.autonomy.summary({
      sessionId: autonomyReviewData.sessionId,
      workspaceRoot: autonomyReviewData.workspaceRoot,
    });
    if (sum && sum.ok) enterReviewMode({ ...autonomyReviewData, summary: sum });
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
  // The autonomy wizard is locked while a run is launching; Esc must not
  // tear it down mid-capture.
  if (autonomyStarting) open = open.filter((m) => m.id !== 'autonomy-start-modal');
  if (!open.length) return;
  // DOM order is install-order for these dialogs; the LAST visible
  // one is the most recently opened (e.g. a confirm-modal layered on
  // top of a create-modal). Close just that one so a confirm dismisses
  // before its parent.
  open[open.length - 1].hidden = true;
});

requestAnimationFrame(() => boot());
