// Husk renderer orchestrator.
// Pages: chat, skills, sessions, files, preferences.
// Includes: command palette, theme toggle, drag overlay, status panel.

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ─── Toast ───────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
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
      resolve(window.confirm(title + '\n\n' + bodyHtml.replace(/<[^>]*>?/g, '')));
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
const linksAddon = new WebLinksAddon.WebLinksAddon();
term.loadAddon(fitAddon);
term.loadAddon(linksAddon);
term.open($('#terminal'));

function themeForXterm() {
  // Use the active CSS theme tokens. Read AFTER body[data-theme] is set.
  const root = getComputedStyle(document.body);
  return {
    background: root.getPropertyValue('--bg-1').trim() || '#0b0d12',
    foreground: root.getPropertyValue('--text').trim() || '#e6e9ef',
    cursor: root.getPropertyValue('--accent').trim() || '#67e8f9',
    cursorAccent: root.getPropertyValue('--bg-1').trim() || '#0b0d12',
    selectionBackground: root.getPropertyValue('--line-2').trim() || '#2d3447',
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
window.addEventListener('resize', fitNow);
term.onData((d) => {
  chatHasInput = true;
  $('#chat-empty').classList.remove('show');
  window.husk.pty.write(d);
  term.scrollToBottom();
});
window.husk.pty.onData((d) => {
  if (!chatHasInput) {
    chatHasInput = true;
    $('#chat-empty').classList.remove('show');
  }
  if (_restartInProgress) return;
  term.write(d, () => term.scrollToBottom());
  detectAndSpeak(d);
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
  $('#chat-empty').classList.add('show');
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
  if (!['chat', 'agents', 'workflows', 'projects', 'prompts', 'skills', 'sessions', 'files', 'mcp', 'preferences'].includes(name)) name = 'chat';
  currentPage = name;
  document.body.dataset.page = name;
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== name; });
  $$('.rail-item').forEach((it) => it.classList.toggle('active', it.dataset.page === name));
  if (name === 'chat') { setTimeout(fitNow, 30); term.focus(); }
  if (name === 'agents') renderAgents();
  if (name === 'workflows') renderWorkflows();
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
          <button class="card-cta project-open" data-id="${escapeHtml(p.id)}" title="Switch to this project">${isActive ? 'Reopen' : 'Open'}<svg class="card-cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>
        </div>
      </div>
    `;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property -- Every interpolation goes through escapeHtml.
  grid.innerHTML = cards;
  grid.querySelectorAll('.project-open').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openProject(e.currentTarget.dataset.id); }));
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
  if (search) search.addEventListener('input', () => paintProjects(projectsCache, search.value));

  const newBtn = document.getElementById('btn-projects-new');
  const modal = document.getElementById('new-project-modal');
  const nameEl = document.getElementById('npj-name');
  const pathEl = document.getElementById('npj-path');
  const pickEl = document.getElementById('npj-pick');
  const cancelBtn = document.getElementById('npj-cancel');
  const createBtn = document.getElementById('npj-create');
  function open() { if (!modal) return; if (nameEl) nameEl.value = ''; if (pathEl) pathEl.value = ''; modal.hidden = false; setTimeout(() => { try { nameEl && nameEl.focus(); } catch (_) {} }, 30); }
  function close() { if (modal) modal.hidden = true; }
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
    close();
    await refreshProjectsState();
    if (currentPage === 'projects') await renderProjects();
  }
  if (newBtn) newBtn.addEventListener('click', open);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  if (createBtn) createBtn.addEventListener('click', submit);
  if (pickEl) pickEl.addEventListener('click', async () => {
    try { const picked = await window.husk.dialog2.pickDir(); if (picked && pathEl) pathEl.value = picked; } catch (_) {}
  });
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

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
  const cards = profilesCache.map((p) => {
    const isActive = activeIds.has(p.id);
    return `
    <div class="agent-card${isActive ? ' is-active' : ''}" data-id="${escapeHtml(p.id)}">
      ${!p.builtin ? `<button class="card-delete agent-delete" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" title="Delete agent" aria-label="Delete agent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg></button>` : ''}
      <div class="agent-card-head">
        <div class="agent-card-title">${escapeHtml(p.name)}</div>
        ${isActive ? '<span class="agent-card-pill">Active</span>' : ''}
        ${p.builtin ? '<span class="agent-card-builtin">Built-in</span>' : ''}
      </div>
      ${p.description ? `<div class="agent-card-desc">${escapeHtml(p.description)}</div>` : ''}
      ${p.systemPrompt ? `<div class="agent-card-prompt">${escapeHtml(p.systemPrompt)}</div>` : ''}
      <div class="agent-card-actions">
        ${!p.builtin ? `<button class="ghost-link agent-edit" data-id="${escapeHtml(p.id)}">Edit</button>` : ''}
        <label class="agent-switch${p.autoSelect ? ' is-on' : ''}" title="When enabled, Husk activates this agent automatically based on context">
          <input type="checkbox" class="agent-autoselect-toggle" data-id="${escapeHtml(p.id)}" ${p.autoSelect ? 'checked' : ''} />
          Auto-select
        </label>
        ${isActive
          ? `<button class="ghost-btn agent-deactivate" data-id="${escapeHtml(p.id)}">Deactivate</button>`
          : `<button class="card-cta agent-activate" data-id="${escapeHtml(p.id)}">Activate<svg class="card-cta-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg></button>`}
      </div>
    </div>
  `;
  }).join('');
  // eslint-disable-next-line no-unsanitized/property
  grid.innerHTML = cards;

  grid.querySelectorAll('.agent-activate').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); activateProfile(e.currentTarget.dataset.id); }));
  grid.querySelectorAll('.agent-deactivate').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deactivateProfile(e.currentTarget.dataset.id); }));
  grid.querySelectorAll('.agent-edit').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); openAgentModal(e.currentTarget.dataset.id); }));
  grid.querySelectorAll('.agent-delete').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); deleteProfile(e.currentTarget.dataset.id, e.currentTarget.dataset.name); }));
  grid.querySelectorAll('.agent-autoselect-toggle').forEach((chk) => chk.addEventListener('change', async (e) => {
    e.stopPropagation();
    const id = e.currentTarget.dataset.id;
    const val = e.currentTarget.checked;
    profilesCache = profilesCache.map((p) => p.id === id ? { ...p, autoSelect: val } : p);
    await window.husk.profiles.update({ id, autoSelect: val });
    paintAgents();
  }));
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
  // eslint-disable-next-line no-unsanitized/property -- every interpolation escaped
  listEl.innerHTML = res.agents.map((a) => `
    <label class="ai-row${a.alreadyImported ? ' is-duplicate' : ''}">
      <input type="checkbox" class="ai-check" data-source="${escapeAttr(a.source)}" data-file="${escapeAttr(a.filename)}" ${a.alreadyImported ? 'disabled' : ''} />
      <span class="ai-check-box" aria-hidden="true"></span>
      <div class="ai-row-body">
        <div class="ai-row-name">${escapeHtml(a.name)}<span class="ai-row-source">${escapeHtml(a.source)}</span></div>
        ${a.description ? `<div class="ai-row-desc">${escapeHtml(a.description)}</div>` : ''}
      </div>
      ${a.alreadyImported ? `<span class="ai-row-pill">Already added</span>` : ''}
    </label>
  `).join('');

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
  const picks = Array.from(listEl.querySelectorAll('.ai-check:checked')).map((el) => ({ source: el.dataset.source, filename: el.dataset.file }));
  if (!picks.length) return;
  const btn = $('#ai-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
  const res = await window.husk.profiles.importAgents(picks);
  if (!res || !res.ok) { toast((res && res.error) || 'Import failed', 'error'); if (btn) btn.disabled = false; return; }
  toast(`Imported ${res.imported} agent${res.imported !== 1 ? 's' : ''}`, 'success');
  closeAgentsImportModal();
  profilesCache = await window.husk.profiles.list();
  paintAgents();
  updateAgentBanner();
}

$('#btn-import-agents') && $('#btn-import-agents').addEventListener('click', openAgentsImportModal);
$('#ai-close') && $('#ai-close').addEventListener('click', closeAgentsImportModal);
$('#ai-cancel') && $('#ai-cancel').addEventListener('click', closeAgentsImportModal);
$('#ai-confirm') && $('#ai-confirm').addEventListener('click', confirmAgentsImport);
$('#agents-import-modal') && $('#agents-import-modal').addEventListener('click', (e) => { if (e.target === $('#agents-import-modal')) closeAgentsImportModal(); });
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
  setTimeout(() => { try { window.husk.pty.write(body + '\n'); } catch (_) {} }, 60);
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
  if (search) search.addEventListener('input', () => paintPrompts(promptsCache, search.value));
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
$('#skills-search').addEventListener('input', (e) => paintSkills(skillsCache, e.target.value));
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
      ? `<span class="session-check"><input type="checkbox" tabindex="-1" ${checked} data-path="${escapeAttr(s.path)}" /></span>`
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
  if (sessionsSelected.has(p)) sessionsSelected.delete(p);
  else sessionsSelected.add(p);
  paintSessions(sessionsCache, $('#sessions-search').value);
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

$('#sessions-search').addEventListener('input', (e) => paintSessions(sessionsCache, e.target.value));
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

// Watch the PTY output for any of the agent's spoken-summary lines:
//   🗣️ <Name>: <one-line summary>     (PAI NATIVE/MINIMAL trailing line)
//   * recap: <one-line summary>        (Claude Code recap)
// and pipe whichever appears latest into local TTS. Each unique line is spoken
// at most once per session, TUIs redraw, so a time-based dedup misses.
const SPEECH_BALLOON_RE = /\u{1F5E3}\u{FE0F}?\s*[^\r\n:]{0,40}?:\s*([^\r\n]+)/gu;
const RECAP_RE = /(?:^|\n)\s*\*\s+recap:\s*([^\r\n]+)/gi;
const ANSI_RE = /\x1B\[[\d;?]*[A-Za-z]|\x1B\][^\x07]*\x07/g;
const SPOKEN_HISTORY_MAX = 32;
let speechBuf = '';
const spokenSet = new Set();
const spokenOrder = [];

function normalizeForDedup(text) {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
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
  speechBuf = '';
  spokenSet.clear();
  spokenOrder.length = 0;
}
function detectAndSpeak(chunk) {
  if (!cfg || !cfg.voice || !cfg.voice.enabled) return;
  if (cfg.recap === false) return;
  speechBuf += chunk;
  if (speechBuf.length > 16384) speechBuf = speechBuf.slice(-8192);
  const clean = speechBuf.replace(ANSI_RE, '');
  // Pick whichever match appears latest in the buffer (by index of the match).
  let latest = null;
  let latestIdx = -1;
  for (const re of [SPEECH_BALLOON_RE, RECAP_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clean)) !== null) {
      if (m.index > latestIdx) { latestIdx = m.index; latest = (m[1] || '').trim(); }
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  if (!latest) return;
  const key = normalizeForDedup(latest);
  if (!recordSpoken(key)) return;
  speak(latest);
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
$('#pref-theme').addEventListener('change', async (e) => {
  cfg = await window.husk.config.set({ theme: e.target.value });
  applyTheme(cfg.theme);
  toast(`Theme: ${cfg.theme} · saved`, 'success');
});
$$('.accent-swatch').forEach((sw) => sw.addEventListener('click', async () => {
  cfg = await window.husk.config.set({ accent: sw.dataset.c });
  applyAccent(cfg.accent);
  toast(`Accent: ${cfg.accent} · saved`, 'success');
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
$('#btn-theme').addEventListener('click', async () => {
  const next = (cfg.theme === 'dark') ? 'light' : 'dark';
  cfg = await window.husk.config.set({ theme: next });
  applyTheme(next);
  $('#pref-theme').value = next;
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
// Live connection status from `claude mcp list`. id -> 'connected' | 'failed' | 'auth' | 'disabled'
let mcpHealth = {};
let mcpHealthLoading = false;
async function reloadMcpInventory() {
  if (!mcpCatalog.length) mcpCatalog = (await window.husk.mcp.catalog()) || [];
  const r = await window.husk.mcp.list();
  mcpInstalled = (r && r.servers) || [];
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
    return '<span class="mcp-health mcp-health-unknown" title="Unknown, claude mcp list did not report status">unknown</span>';
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
    const x = row.querySelector('[data-remove]');
    if (t) t.addEventListener('click', async () => {
      const r = await window.husk.mcp.toggle(row.dataset.id);
      if (!r.ok) { toast(r.error || 'Toggle failed', 'error'); return; }
      toast(`${row.dataset.id} ${r.enabled ? 'enabled' : 'disabled'}`, 'success');
      await renderMcp();
      applyMcpChange(row.dataset.id);
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

function openMcpCustomModal() {
  $('#mcp-install-title').textContent = 'Install a custom MCP server';
  $('#mcp-install-sub').textContent = 'Paste a JSON snippet, or pick a transport and fill in the fields.';
  const fields = $('#mcp-install-fields');
  const codeStyle = "background:var(--bg-3); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:10px 12px; font-family:'JetBrains Mono', monospace; font-size:12px; resize:vertical;";
  // eslint-disable-next-line no-unsanitized/property -- Static modal template for MCP custom install form.
  fields.innerHTML = `
    <div class="mcp-paste-wrap" id="mcp-paste-wrap" hidden>
      <div class="mcp-input-group">
        <label for="mig-paste-json">Paste your MCP JSON</label>
        <textarea id="mig-paste-json" rows="8" spellcheck="false" placeholder='{
  "my-server": {
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer ..." }
  }
}' style="${codeStyle}"></textarea>
        <div class="mig-hint">Accepts the standard MCP entry shape, with or without an outer wrapper key.</div>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <button type="button" class="ghost-btn" id="mcp-paste-cancel">Cancel</button>
          <button type="button" class="btn-primary" id="mcp-paste-apply" style="flex:1;">Fill the form</button>
        </div>
      </div>
    </div>

    <div class="mcp-form-wrap" id="mcp-form-wrap">
      <button type="button" class="ghost-btn" id="mcp-paste-open" style="margin-bottom:10px;">Paste JSON instead</button>
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
      <div class="mig-hint">Letters, numbers, dashes. Used as the key in ~/.claude.json.</div>
    </div>

    <div data-tab-pane="stdio">
      <div class="mcp-input-group">
        <label for="mig-custom-cmd">Command</label>
        <input id="mig-custom-cmd" type="text" placeholder="npx" autocomplete="off" />
      </div>
      <div class="mcp-input-group">
        <label for="mig-custom-args">Arguments (one per line)</label>
        <textarea id="mig-custom-args" rows="3" placeholder="-y\n@my-org/my-mcp-server" style="${codeStyle}"></textarea>
      </div>
      <div class="mcp-input-group">
        <label for="mig-custom-env">Environment variables (KEY=value, one per line)</label>
        <textarea id="mig-custom-env" rows="3" placeholder="API_KEY=sk-..." style="${codeStyle}"></textarea>
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
        <textarea id="mig-custom-headers" rows="3" placeholder="Authorization: api-key your-token-here\nX-Other-Header: value" style="${codeStyle}"></textarea>
        <div class="mig-hint">Optional. Used for auth tokens and per-server headers.</div>
      </div>
    </div>
    </div>`;
  // Tab switching
  let activeTab = 'stdio';
  fields.querySelectorAll('.mcp-tab').forEach((t) => {
    t.addEventListener('click', () => {
      activeTab = t.dataset.tab;
      fields.querySelectorAll('.mcp-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === activeTab));
      fields.querySelectorAll('[data-tab-pane]').forEach((p) => { p.hidden = p.dataset.tabPane !== activeTab; });
    });
  });
  // Paste-JSON flow: parse a snippet and prefill the form fields.
  const setActiveTab = (tab) => {
    activeTab = tab;
    fields.querySelectorAll('.mcp-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === activeTab));
    fields.querySelectorAll('[data-tab-pane]').forEach((p) => { p.hidden = p.dataset.tabPane !== activeTab; });
  };
  $('#mcp-paste-open').addEventListener('click', () => {
    $('#mcp-paste-wrap').hidden = false;
    $('#mcp-form-wrap').hidden = true;
    setTimeout(() => $('#mig-paste-json').focus(), 30);
  });
  $('#mcp-paste-cancel').addEventListener('click', () => {
    $('#mcp-paste-wrap').hidden = true;
    $('#mcp-form-wrap').hidden = false;
  });
  $('#mcp-paste-apply').addEventListener('click', () => {
    const raw = ($('#mig-paste-json').value || '').trim();
    if (!raw) { toast('Paste a JSON snippet first', 'error'); return; }
    let parsed;
    try {
      // Be forgiving: accept fragments by wrapping with braces if needed,
      // and tolerate trailing commas a user copied from a larger object.
      const cleaned = raw.replace(/,(\s*[}\]])/g, '$1');
      parsed = JSON.parse(cleaned);
    } catch (e1) {
      try {
        parsed = JSON.parse('{' + raw.replace(/,(\s*[}\]])/g, '$1') + '}');
      } catch (e2) {
        toast(`Could not parse JSON: ${e1.message}`, 'error');
        return;
      }
    }
    // Normalise: accept either { name: { ... } } or a bare entry.
    let id = '';
    let entry = parsed;
    const keys = Object.keys(parsed || {});
    const looksLikeEntry = parsed && (parsed.command || parsed.url || parsed.type);
    if (!looksLikeEntry && keys.length === 1 && parsed[keys[0]] && typeof parsed[keys[0]] === 'object') {
      id = keys[0];
      entry = parsed[keys[0]];
    }
    if (id) $('#mig-custom-id').value = id.replace(/[^a-zA-Z0-9_-]/g, '-');
    if (entry.url || entry.type === 'http' || entry.type === 'sse') {
      setActiveTab('http');
      $('#mig-custom-type').value = entry.type === 'sse' ? 'sse' : 'http';
      $('#mig-custom-url').value = entry.url || '';
      const hdrs = entry.headers || {};
      $('#mig-custom-headers').value = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\n');
    } else {
      setActiveTab('stdio');
      $('#mig-custom-cmd').value = entry.command || '';
      $('#mig-custom-args').value = (entry.args || []).join('\n');
      const env = entry.env || {};
      $('#mig-custom-env').value = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    }
    $('#mcp-paste-wrap').hidden = true;
    $('#mcp-form-wrap').hidden = false;
    toast('Filled from JSON · review and click Install', 'success');
  });
  $('#mcp-install').hidden = false;
  $('#mcp-install-confirm').onclick = () => submitMcpCustom(() => activeTab);
  $('#mcp-install-cancel').onclick = () => { $('#mcp-install').hidden = true; };
}
async function submitMcpCustom(getActiveTab) {
  const id = ($('#mig-custom-id').value || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) { toast('Invalid server name', 'error'); return; }
  const tab = (getActiveTab && getActiveTab()) || 'stdio';
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
  const r = await window.husk.mcp.add(payload);
  if (!r.ok) { toast(r.error || 'Install failed', 'error'); return; }
  $('#mcp-install').hidden = true;
  toast(`Installed ${id}`, 'success');
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
      window.husk.pty.write(initialPrompt);
      term.focus();
    }, 250);
  }
}

requestAnimationFrame(() => boot());
