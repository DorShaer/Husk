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
  term.write(d, () => term.scrollToBottom());
  detectAndSpeak(d);
});
window.husk.pty.onExit((code) => {
  term.writeln(`\r\n\x1b[38;2;106;115;133m[agent exited code ${code}; click ↻ Restart]\x1b[0m`);
});

function announceInTerminal(msg) {
  term.writeln(`\r\n\x1b[38;2;103;232;249m▸ ${msg}\x1b[0m`);
}

async function startPty() {
  fitAddon.fit();
  const { cols, rows } = term;
  await window.husk.pty.start({ cols, rows });
  term.focus();
  // Snapshot which MCPs were enabled at launch so the MCP page can split
  // them into Loaded vs Pending, and the welcome screen can show what's live.
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
}
async function restartPty(opts = {}) {
  fitAddon.fit();
  const { cols, rows } = term;
  chatHasInput = false;
  resetSpeechState();
  clearSessionContext();
  // Wipe scrollback + visible buffer so a new session shows a clean screen
  // even if the user hits New session multiple times in a row.
  try { term.reset(); } catch (_) { try { term.clear(); } catch (_) {} }
  await window.husk.pty.restart({ cols, rows, command: opts.command || null });
  $('#chat-empty').classList.add('show');
  term.focus();
  try { const inv = await reloadMcpInventory(); snapshotLoadedMcps(inv); } catch (_) {}
  if (!opts.silent) toast('New session', 'success');
}

// ─── Theme + accent ─────────────────────────────────────────────────────────────
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  try { term.options.theme = themeForXterm(); } catch (_) {}
  const icon = $('#theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☾' : '☀';
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
  if (!['chat', 'skills', 'sessions', 'files', 'mcp', 'preferences'].includes(name)) name = 'chat';
  currentPage = name;
  document.body.dataset.page = name;
  $$('.page').forEach((p) => { p.hidden = p.dataset.page !== name; });
  $$('.rail-item').forEach((it) => it.classList.toggle('active', it.dataset.page === name));
  if (name === 'chat') { setTimeout(fitNow, 30); term.focus(); }
  if (name === 'skills') renderSkills();
  if (name === 'sessions') renderSessions();
  if (name === 'files') { $('#files-root').value = cfg.treeRoot; $('#files-hidden').checked = !!cfg.showHidden; renderTree(cfg.treeRoot); }
  if (name === 'mcp') renderMcp();
}

$$('.rail-item').forEach((b) => b.addEventListener('click', () => setPage(b.dataset.page)));

// Rail expand/collapse
$('#rail-toggle').addEventListener('click', async () => {
  const expanded = document.body.dataset.rail === 'expanded';
  document.body.dataset.rail = expanded ? 'collapsed' : 'expanded';
  cfg = await window.husk.config.set({ railExpanded: !expanded });
  setTimeout(fitNow, 200);
});

// ─── Stats + status bar ──────────────────────────────────────────────────────────
async function refreshStats() {
  try {
    const s = await window.husk.stats.get();
    lastStats = s;
    if ($('#sp-foot')) $('#sp-foot').textContent = `Husk v${s.huskVer || '0.2'}`;
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
  const weatherStr = s.weather && s.weather.temp
    ? `${s.weather.temp}°C${s.weather.condition ? ' · ' + s.weather.condition : ''}`
    : '';
  const u = s.usage || {};
  const L = s.learning || {};

  const html = `
    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">◷</span><span>Where</span></div>
      <div class="sp-section-body">
        ${here ? `<div><strong>${escapeHtml(here)}</strong></div>` : ''}
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
        <div class="sp-row sp-clickable" data-open="skills"><span class="sp-muted">Skills</span><span class="sp-mono sp-accent">${s.skills}</span></div>
        <div class="sp-row sp-clickable" data-open="workflows"><span class="sp-muted">Workflows</span><span class="sp-mono sp-accent">${s.workflows}</span></div>
        <div class="sp-row sp-clickable" data-open="hooks"><span class="sp-muted">Hooks</span><span class="sp-mono sp-accent">${s.hooks}</span></div>
      </div>
    </div>

    <div class="sp-section">
      <div class="sp-section-head"><span class="sp-h-icon">⏱</span><span>Usage</span></div>
      <div class="sp-section-body">
        <div class="sp-row"><span class="sp-muted">5h</span><span class="sp-mono">${fmtPct(u.h5_pct)}</span></div>
        <div class="sp-progress"><div class="sp-progress-fill" style="width:${Math.min(100, u.h5_pct||0)}%"></div></div>
        ${u.h5_reset ? `<div class="sp-row"><span class="sp-muted">Resets</span><span class="sp-mono">${escapeHtml(u.h5_reset)}</span></div>` : ''}
        <div class="sp-row" style="margin-top:6px;"><span class="sp-muted">Weekly</span><span class="sp-mono">${fmtPct(u.week_pct)}</span></div>
        <div class="sp-progress"><div class="sp-progress-fill" style="width:${Math.min(100, u.week_pct||0)}%"></div></div>
        ${u.week_reset ? `<div class="sp-row"><span class="sp-muted">Resets</span><span class="sp-mono">${escapeHtml(u.week_reset)}</span></div>` : ''}
        ${(u.api_cost || u.extra_used || u.session_cost) ? `
        <div class="sp-divider"></div>
        ${u.api_cost ? `<div class="sp-row"><span class="sp-muted">API</span><span class="sp-mono">$${u.api_cost}</span></div>` : ''}
        ${u.extra_limit ? `<div class="sp-row"><span class="sp-muted">Extra</span><span class="sp-mono">$${u.extra_used}/$${u.extra_limit}</span></div>` : ''}
        ${u.session_cost ? `<div class="sp-row"><span class="sp-muted">Session</span><span class="sp-mono">${escapeHtml(String(u.session_cost))}</span></div>` : ''}
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
      </div>
    </div>
  `;

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

// ─── Prompts / Skills page ──────────────────────────────────────────────────────
let skillsCache = [];
let agentKindCache = 'claude';
async function renderSkills() {
  const grid = $('#skills-grid');
  grid.innerHTML = '<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">Loading…</div></div>';
  const res = await window.husk.skills.list();
  if (!res.ok) {
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${res.error}</div></div>`;
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
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">⌬</div><div class="es-msg">${msg}</div></div>`;
    return;
  }
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
      // Optimistic flip — CSS transition needs the same node, not a re-rendered one.
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
    list.innerHTML = `<div class="empty-state"><div class="es-icon">!</div><div class="es-msg">${res.error}</div></div>`;
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
    ul.innerHTML = `<div class="empty-state"><div class="es-icon">⊕</div><div class="es-msg">${msg}</div></div>`;
    return;
  }
  ul.classList.toggle('select-mode', sessionsSelectMode);
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
  toast(`Resuming ${d.id.slice(0, 8)}… (cwd: ${cwd || '$HOME'})`, 'success');
  $('#chat-sub').textContent = `claude --resume ${d.id.slice(0, 8)} · ${cwd || '$HOME'}`;
  if ($('#sp-agent')) $('#sp-agent').textContent = `claude --resume ${d.id.slice(0, 8)}`;
  if ($('#sp-session-id')) $('#sp-session-id').textContent = `${d.id.slice(0, 8)} · ${cwd || '$HOME'}`;
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
    treeEl.innerHTML = `<div class="tree-row" style="color:var(--rose)">· ${res.error}</div>`;
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
  $('#chat-sub').textContent = `${cmdShort} · ${cfg.treeRoot || ''}`;
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
    $('#pref-voice-name').innerHTML = s.voices.map((v) => `<option value="${v}">${v}</option>`).join('') || '<option>No voices</option>';
    $('#pref-voice-name').value = (cfg.voice && cfg.voice.name) || s.voices[0];
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
// at most once per session — TUIs redraw, so a time-based dedup misses.
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
  cfg = await window.husk.config.set({
    agentCommand: $('#pref-agent').value.trim(),
    agentName: name,
  });
  bindPrefs();
  // Agent change may flip claude → generic, so refresh the prompts label / list.
  renderSkills();
  updateAgentPill();
  paintAgentMenu();
  toast('Saved, restarting agent', 'success');
  await restartPty();
});
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
// file-read tool — they will pick it up automatically. We send the
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
  wrap.innerHTML = sessionContext.map((it) => `
    <div class="rail-sub-item" data-path="${escapeAttr(it.path)}" data-name="${escapeAttr(it.name)}" title="${escapeAttr(it.name)} — click to re-share with the agent">
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
// right now). Anything enabled but NOT in the snapshot is "Pending" — the
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
    return '<span class="mcp-health mcp-health-unknown" title="Unknown — claude mcp list did not report status">unknown</span>';
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
  agentsCache = Array.isArray(r) ? r : [];
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
$('#rail-agent-pill').addEventListener('click', (e) => {
  e.stopPropagation();
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
const PALETTE_ACTIONS = [
  { icon: '⌧', label: 'Switch to Chat',          run: () => setPage('chat'),         shortcut: '1' },
  { icon: '⌬', label: 'Switch to Skills',        run: () => setPage('skills'),       shortcut: '2' },
  { icon: '⊕', label: 'Switch to Sessions',      run: () => setPage('sessions'),     shortcut: '3' },
  { icon: '▤', label: 'Switch to Files',         run: () => setPage('files'),        shortcut: '4' },
  { icon: '⚙', label: 'Switch to Preferences',   run: () => setPage('preferences'),  shortcut: ',' },
  { icon: '↻', label: 'Restart Agent',           run: restartPty },
  { icon: '＋', label: 'Share file (picker)',     run: shareFilesViaPicker },
  { icon: '＋', label: 'New chat session',         run: () => restartPty() },
  { icon: '◐', label: 'Toggle theme',            run: () => $('#btn-theme').click() },
  { icon: '⊕', label: 'Open ~/.claude/MEMORY/WORK/', run: () => lastStats && window.husk.fs.open(lastStats.sessionsDir) },
  { icon: '⌬', label: 'Open ~/.claude/skills/',     run: () => lastStats && window.husk.fs.open(lastStats.skillsDir) },
  { icon: '◐', label: 'Open ~/.claude/hooks/',      run: () => lastStats && window.husk.fs.open(lastStats.hooksDir) },
  { icon: '↗', label: 'Reveal config file',         run: () => window.husk.fs.open(`${ /* HOME */ ''}`) || true },
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
  $('#dp-meta').innerHTML = meta
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v || '')}</dd>`)
    .join('');
  $('#dp-body').textContent = body;
  $('#dp-foot').innerHTML = '';
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
function escapeAttr(s) { return escapeHtml(s); }

// ─── First-run modal + boot ──────────────────────────────────────────────────────
async function boot() {
  cfg = await window.husk.config.get();
  applyTheme(cfg.theme || 'dark');
  applyAccent(cfg.accent || 'orange');
  document.body.dataset.rail = cfg.railExpanded ? 'expanded' : 'collapsed';

  if (!cfg.firstRunDone) {
    $('#first-run').hidden = false;
    setTimeout(() => { $('#fr-name').focus(); $('#fr-name').select(); }, 50);
    await new Promise((resolve) => {
      const submit = async () => {
        const cmd = $('#fr-cmd').value.trim() || 'claude';
        const name = ($('#fr-name').value || '').trim().slice(0, 40) || 'Husk';
        cfg = await window.husk.config.set({ agentCommand: cmd, agentName: name, firstRunDone: true });
        $('#first-run').hidden = true;
        resolve();
      };
      $('#fr-go').addEventListener('click', submit);
      $('#fr-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#fr-cmd').focus(); });
      $('#fr-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    });
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
