// Husk: Electron main process.
// Wraps a configurable agent CLI via node-pty and exposes pages: chat, skills, sessions, files, preferences.

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const pty = require('node-pty');

const { shJoin } = require('./lib/shell-quote');
const { resolveInside, isInside } = require('./lib/path-confine');
const { parseAgentMd } = require('./lib/agent-md');
const wfLib = require('./lib/workflow-graph');
const { buildSpawnSpec, withCopilotContextDir } = require('./lib/pty-spawn');
const AgentInject = require('./lib/agent-inject');
const { createMouseModeStripper } = require('./lib/term-mouse');
const { wheelSequence, wheelSteps } = require('./lib/wheel-seq');
const { agentFileName, renderAgentMd } = require('./lib/agent-file');
const { parseShellPathOutput, MARKER_START, MARKER_END } = require('./lib/user-path');
const { pickResumeSessionId } = require('./lib/claude-session');
const { parsePorcelain } = require('./lib/git-porcelain');
const { parseGitStatus, groupBoard } = require('./lib/workspace-state');
const { getAdapter: getMcpAdapter } = require('./lib/mcp');
const SharedMcp = require('./lib/mcp/shared');
const { deriveCopilotSessionTitleFromEventsText } = require('./lib/copilot-session-title');

// On macOS in particular, a GUI-launched Electron app inherits a
// minimal PATH that does not include the npm-global, homebrew, or bun
// install directories where users keep their agent CLIs. Read the
// user's actual shell PATH so subsequent spawns can find their
// binaries.
//
// This runs ASYNCHRONOUSLY: an interactive login shell sources the
// user's full rc chain (nvm, pyenv, conda init), which can take
// hundreds of ms to seconds. Doing it with spawnSync at module load
// froze the whole process before the window appeared. Agent spawns
// happen on user action, well after this resolves, so async is safe.
function augmentUserPathAsync() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const shellBin = (typeof process.env.SHELL === 'string' && process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
  try {
    const child = spawn(shellBin, ['-ilc', `echo "${MARKER_START}\${PATH}${MARKER_END}"`], { timeout: 5000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => {});
    child.on('close', () => {
      const p = parseShellPathOutput(out);
      if (p) process.env.PATH = p;
    });
  } catch (_) {}
}
augmentUserPathAsync();

// resolveAgentExe(exe, envPath) turns a bare program name (e.g. 'claude') into
// an absolute path so the spawn never depends on the child's PATH being right.
// A GUI/desktop launch inherits a systemd PATH that omits ~/.local/bin etc, so
// a bare 'claude' would not resolve even though it is installed. Strategy:
//   1. walk envPath ourselves (cheap, no subprocess)
//   2. fall back to asking a login shell `command -v` (POSIX) / `where` (win32),
//      which sources the user's full rc chain and finds CLIs the inherited PATH
//      misses -- this is the `which claude` / `where claude` lookup.
// Returns exe unchanged when it is already a path, already resolvable, or when
// the lookup fails (let the spawn surface the real error). The subprocess only
// runs in the failure path, so a healthy PATH pays nothing.
function resolveAgentExe(exe, envPath) {
  if (typeof exe !== 'string' || !exe) return exe;
  if (path.isAbsolute(exe) || exe.includes('/') || exe.includes('\\')) return exe;
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  const asExecFile = (p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() && (isWin || (st.mode & 0o111)) ? p : null;
    } catch (_) { return null; }
  };

  // 1. Walk the PATH we are about to hand the child.
  for (const dir of (envPath || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const hit = asExecFile(path.join(dir, exe + ext));
      if (hit) return hit;
    }
  }

  // 2. Ask a login shell where it lives (which/where through the user's rc chain).
  try {
    const { spawnSync } = require('child_process');
    let res;
    if (isWin) {
      res = spawnSync('where', [exe], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    } else {
      const shellBin = (typeof process.env.SHELL === 'string' && process.env.SHELL) ? process.env.SHELL : '/bin/bash';
      const quotedExe = shJoin(exe, []);
      res = spawnSync(shellBin, ['-ilc', `command -v -- ${quotedExe}`], { encoding: 'utf8', timeout: 4000 });
    }
    const lines = ((res && res.stdout) || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const hit = asExecFile(line);
      if (hit) return hit;
    }
  } catch (_) {}

  return exe;
}

const {
  sanitizeGraph,
  migrateWorkflow,
  graphToOrderedSteps,
  wfRouteInstruction,
  wfResolveNext,
  wfEdgeMatches,
  isAllowedAgentCommand,
} = wfLib;

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOME = os.homedir();
const COPILOT_DIR = process.env.COPILOT_HOME || path.join(HOME, '.copilot');
const CONFIG_DIR = path.join(HOME, '.config', 'husk');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const HUSK_PROMPTS_DIR = path.join(CONFIG_DIR, 'prompts');

function getAgentKind() {
  const cmd = (config.agentCommand || 'claude').trim().split(/\s+/)[0].toLowerCase();
  return cmd === 'claude' ? 'claude' : 'generic';
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// GPU acceleration hints. Electron on Linux often falls back to software
// compositing when --no-sandbox is set or the GPU sits on a blocklist,
// that's the "feels like 30Hz" symptom. These three switches push it to
// the GPU path. Safe defaults for desktop Electron 32.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow = null;
let lastReloadRequestAt = 0;
let rendererRouteState = { page: 'chat', activeTabId: null, ts: 0 };
let pendingRendererReloadState = null;

function normalizeRendererPage(page) {
  return [
    'chat', 'agents', 'workflows', 'autopilot', 'projects', 'prompts',
    'skills', 'sessions', 'files', 'mcp', 'plugins',
  ].includes(page) ? page : 'chat';
}

function reloadMainWindow() {
  if (!mainWindow) return;
  const now = Date.now();
  if (now - lastReloadRequestAt < 900) return;
  lastReloadRequestAt = now;
  pendingRendererReloadState = {
    page: normalizeRendererPage(rendererRouteState.page),
    activeTabId: rendererRouteState.activeTabId || null,
    ts: now,
    suppressAutoChat: true,
  };
  try {
    mainWindow.webContents.send('app:reload-in-place');
    setTimeout(() => {
      try { if (mainWindow) mainWindow.webContents.reload(); } catch (_) {}
    }, 40).unref();
  } catch (_) {
    try { mainWindow.webContents.reload(); } catch (_e) {}
  }
}

// ─── Multi-session registry ────────────────────────────────────────────────
// Each chat tab owns its own PTY child, output buffer, mouse-mode stripper,
// and listener disposables, so several agents run in parallel. `sessions`
// maps the renderer's sessionId to that state; `activeSessionId` is the
// focused tab. The `ptyProc` / `activePtyCwd` / `ptyLastDataAt` mirrors below
// always track the active session, so the autopilot + stats code (which
// operates on "the current agent") needs no per-call session plumbing.
const sessions = new Map();
let activeSessionId = null;
let sessionSeq = 0;
// Mirrors of the active session. setActiveSession() and the active session's
// onData keep these in sync; autopilot/stats read them directly.
let ptyProc = null;
let activePtyCwd = null;
// Timestamp of the last byte the active agent emitted, used to detect when
// its TUI has settled before we paste an autopilot goal into it.
let ptyLastDataAt = 0;
// The most recent PTY child's pid across all sessions, kept even after a
// session's pty is nulled, so killPtyTree can still reap an orphaned group.
let lastPtyPid = 0;

function newSession(id) {
  const s = {
    id,
    pty: null,
    pid: 0,
    cwd: null,
    dataBuf: '',
    flushScheduled: false,
    dataDisposable: null,
    exitDisposable: null,
    // Neutralize a TUI's mouse-tracking modes per session so the terminal
    // stays locally selectable. See src/lib/term-mouse.js.
    mouseStripper: createMouseModeStripper(),
    // Mirror of the stripper's mouse-reporting state, pushed to the renderer
    // so it knows whether to forward the wheel to this session's agent.
    lastMouseOn: false,
    lastDataAt: 0,
  };
  sessions.set(id, s);
  return s;
}

function activeSession() { return activeSessionId ? sessions.get(activeSessionId) : null; }

function setActiveSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  activeSessionId = id;
  ptyProc = s.pty || null;
  activePtyCwd = s.cwd || null;
  ptyLastDataAt = s.lastDataAt || 0;
  // Re-sync the renderer's wheel-forward gate to this session's mouse mode.
  if (mainWindow) mainWindow.webContents.send('pty:mouse-mode', { sessionId: id, on: !!s.lastMouseOn });
}

// Per-session output coalescing: buffer the chatty PTY stream and flush once
// per microtask so the renderer gets one tagged message per burst instead of
// one IPC send per chunk.
function flushSessionData(s) {
  s.flushScheduled = false;
  if (!s.dataBuf) return;
  const data = s.dataBuf;
  s.dataBuf = '';
  const clean = s.mouseStripper.strip(data);
  const mouseOn = s.mouseStripper.isMouseOn();
  if (mouseOn !== s.lastMouseOn) {
    s.lastMouseOn = mouseOn;
    if (mainWindow) mainWindow.webContents.send('pty:mouse-mode', { sessionId: s.id, on: mouseOn });
  }
  if (mainWindow && clean) mainWindow.webContents.send('pty:data', { sessionId: s.id, data: clean });
}

// ─── Config ──────────────────────────────────────────────────────────────────────

const DEFAULT_PROFILES = [
  {
    id: 'builtin-code-review',
    name: 'Code Reviewer',
    description: 'Focused on correctness, edge cases, and clean code principles.',
    systemPrompt: 'You are a senior code reviewer. Prioritize correctness, security, edge cases, and readability. Point out specific line numbers. Suggest concrete improvements. Be direct and concise.',
    builtin: true,
    autoSelect: false,
  },
  {
    id: 'builtin-documentation',
    name: 'Documentation Writer',
    description: 'Writes clear, structured docs, READMEs, and API references.',
    systemPrompt: 'You are a technical writer. Write clear, structured documentation. Use headers, examples, and code blocks. Assume the reader is a developer who needs to understand quickly. Avoid jargon without explanation.',
    builtin: true,
    autoSelect: false,
  },
  {
    id: 'builtin-security',
    name: 'Security Auditor',
    description: 'Audits for vulnerabilities, OWASP risks, and insecure patterns.',
    systemPrompt: 'You are a security engineer specializing in application security. Identify vulnerabilities, insecure patterns, and OWASP Top 10 risks. Reference CVEs and CWEs where relevant. Provide remediation steps, not just findings.',
    builtin: true,
    autoSelect: false,
  },
];

const DEFAULT_CONFIG = {
  firstRunDone: false,
  // The app version the user last saw the "What's new" page for. When it
  // differs from the running version (e.g. after an update), the What's new
  // page is shown once, then this is updated.
  lastSeenVersion: null,
  agentCommand: 'claude',
  agentName: 'Husk',
  showSystemView: false,
  treeRoot: HOME,
  showHidden: false,
  // Applies to a first install only. An existing install keeps whatever theme it
  // already has, via the pin in loadConfig.
  theme: 'light',
  accent: 'orange',
  railExpanded: true,
  statusCollapsed: false,
  voice: { enabled: false, name: 'en_US-amy-medium', rate: 1.0 },
  skipWelcome: false,
  recap: true,
  // LifeOS is the bundled Claude-Code-only assistant framework Husk drops into
  // ~/.claude/. Defaults to enabled so existing Claude users get it on
  // first run, but Copilot-only users can switch it off to skip the
  // bootstrap, kill the statusline tick, and drop the framework reference
  // from the Husk identity prompt. The key keeps its original name: renaming
  // it would silently re-enable the framework for anyone who had turned it off.
  paiEnabled: true,
  profiles: DEFAULT_PROFILES,
  activeProfileId: null,
  // Map of encoded-cwd -> the last claude session id Husk bound there. On a
  // fresh app boot the in-memory tab->session binding is gone, so this lets a
  // launch resume the ongoing discussion for that project instead of minting a
  // new session and splitting one conversation across many transcripts.
  lastClaudeSessions: {},
};

// The theme a config was running under before `theme` became a stored key. Any
// config file that predates the key was showing this, so it is what that install
// keeps.
const PRE_EXISTING_THEME = 'midnight';

// Themes whose --term-light token is 1 in styles.css. The renderer derives the
// light/dark family from that token once the stylesheet is live; the window and
// the preload need the answer before any of that exists, so it is mirrored here.
const LIGHT_THEMES = new Set(['light', 'sepia']);
// Each theme's --bg, used for the window's own paint. Only the two families are
// needed: the window is only visible behind the app for the first frame.
const THEME_BG = { light: '#fafafa', sepia: '#f3ead6' };
const DARK_BG = '#0c0a09';

function themeBackground(theme) {
  return THEME_BG[theme] || (LIGHT_THEMES.has(theme) ? THEME_BG.light : DARK_BG);
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // A config file on disk means this is an existing install, and an update must
    // never move its theme. Where the file carries no theme, pin the one it was
    // already showing so the new-install default cannot reach it.
    if (!Object.prototype.hasOwnProperty.call(stored, 'theme')) {
      stored.theme = PRE_EXISTING_THEME;
    }
    return { ...DEFAULT_CONFIG, ...stored };
  } catch (_) { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    // Tighten any pre-existing-but-loose perms left over from before this guard.
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_) {}
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch (_) {}
    return true;
  } catch (_) { return false; }
}

let config = loadConfig();

// ─── Framework bootstrap (packaged binaries) ─────────────────────────────────
// When Husk runs from a packaged binary (electron-builder output), there is no
// install.sh to copy libs/lifeos into ~/.claude/. We do it here on first launch.
// In dev mode the bundle path won't exist; install.sh handles it.
// Seed ~/.config/husk/prompts/ from the bundled curated set on first launch.
// Never overwrites: a file that already exists in the destination is left
// alone so user-edited prompts survive across upgrades.
// Periodically run ~/.claude/statusline-command.sh so the side-effect caches
// it does write (location-cache.json, weather-cache.json, model-cache.txt)
// stay fresh while Husk is open. Note the script does NOT write
// usage-cache.json; the 5h / 7d Anthropic limits are only fetched live each
// CLI render, so Husk has to mirror that fetch itself. See
// refreshAnthropicUsageCache below.
let statuslineTimer = null;
function refreshStatuslineCacheOnce() {
  try {
    // Current layout ships the statusline inside LIFEOS/; the two older ones
    // kept it under PAI/ and at the root. An install upgraded in place can be
    // on any of them, so probe newest first and take whichever exists.
    const slPath = [
      path.join(CLAUDE_DIR, 'LIFEOS', 'LIFEOS_StatusLine.sh'),
      path.join(CLAUDE_DIR, 'PAI', 'statusline-command.sh'),
      path.join(CLAUDE_DIR, 'statusline-command.sh'),
    ].find((p) => fs.existsSync(p));
    if (!slPath) return;
    const cwd = activePtyCwd || HOME;
    // Stub session JSON for the claude-statusline contract; missing fields
    // fall back to env defaults inside the script.
    const stub = JSON.stringify({ workspace: { current_dir: cwd }, session_id: 'husk-bg' });
    const child = spawn('/bin/bash', [slPath], {
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 10000,
      cwd,
      env: process.env,
    });
    try { child.stdin.write(stub); child.stdin.end(); } catch (_) {}
    child.on('error', () => {});
  } catch (_) {}
}
function startStatuslineRefresh() {
  if (statuslineTimer) return;
  // The statusline script is the framework's status feeder. Skip the tick
  // entirely when the user has disabled it: no script, no caches, no need.
  if (config.paiEnabled === false) return;
  // Kick off once on startup, then every 30s.
  refreshStatuslineCacheOnce();
  statuslineTimer = setInterval(refreshStatuslineCacheOnce, 30000);
  // unref so this tick alone never keeps the process alive past quit.
  statuslineTimer.unref();
}
function stopStatuslineRefresh() {
  if (statuslineTimer) { clearInterval(statuslineTimer); statuslineTimer = null; }
}

// Hit the Anthropic OAuth usage endpoint with the user's claude credential
// and write the result into ~/.claude/MEMORY/STATE/usage-cache.json. This
// mirrors the inline fetch the PAI statusline does each render. The statusline
// does not persist what it fetches, so Husk owns the cache write that the
// stats:get path reads from.
function readClaudeOauthToken() {
  try {
    if (process.platform === 'darwin') {
      const out = require('child_process').execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString().trim();
      const cj = JSON.parse(out);
      return (cj.claudeAiOauth && cj.claudeAiOauth.accessToken) || '';
    }
    const credPath = path.join(HOME, '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) return '';
    const cj = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return (cj.claudeAiOauth && cj.claudeAiOauth.accessToken) || '';
  } catch (_) { return ''; }
}

// Security context (responding to CodeQL js/file-access-to-http and
// js/http-to-file-access on this function):
//
// 1. The OAuth token sourced from ~/.claude/.credentials.json is sent ONLY
//    to api.anthropic.com (hardcoded hostname + path; no user input flows
//    into the URL). This mirrors what the bundled PAI statusline-command.sh
//    already does on every render.
// 2. The response body is JSON.parse'd; the cache write is restricted to a
//    fixed allowlist of fields, each coerced to a primitive type (Number,
//    String, ISO timestamp). The destination path is path.join(CLAUDE_DIR,
//    'MEMORY', 'STATE', 'usage-cache.json'), no part of which is derived
//    from the response.
// 3. No raw nested objects from the response land in the cache, so even if
//    the upstream response were tampered with, only typed scalars persist.
//
// As a defensive timeout, anything past 5s is dropped.
function _coerceISOTimestamp(s) {
  if (typeof s !== 'string') return '';
  // RFC 3339-ish timestamp: digits, dashes, T, colons, dot, plus, Z.
  // Reject anything outside that grammar to keep file content predictable.
  return /^[0-9T:\-+.Z]{1,40}$/.test(s) ? s : '';
}

function refreshAnthropicUsageCache() {
  const token = readClaudeOauthToken();
  if (!token) return;
  const https = require('https');
  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/api/oauth/usage',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    timeout: 5000,
  }, (res) => {
    let body = '';
    let bodyLen = 0;
    res.on('data', (chunk) => {
      bodyLen += chunk.length;
      // Cap body size to bound the attacker (server) influence on memory.
      if (bodyLen > 256 * 1024) { res.destroy(); return; }
      body += chunk;
    });
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) return;
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object' || !data.five_hour) return;
        const fh = data.five_hour || {};
        const sd = data.seven_day || null;
        const cacheDir = path.join(CLAUDE_DIR, 'MEMORY', 'STATE');
        fs.mkdirSync(cacheDir, { recursive: true });
        const cachePath = path.join(cacheDir, 'usage-cache.json');
        // Preserve scalar fields from a prior write (the slow admin API
        // populates ws_cost_dollars + session_cost via a stop hook, not on
        // every render). Only typed primitives are preserved, never raw
        // objects from the prior cache.
        let priorWsDollars = 0;
        let priorSessionCost = '';
        try {
          const prior = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          if (prior && typeof prior.ws_cost_dollars !== 'undefined') {
            priorWsDollars = String(prior.ws_cost_dollars).slice(0, 16);
          }
          if (prior && typeof prior.session_cost === 'string') {
            priorSessionCost = prior.session_cost.slice(0, 32);
          }
        } catch (_) {}
        const wsCents = data.workspace_cost && typeof data.workspace_cost.month_used_cents === 'number'
          ? data.workspace_cost.month_used_cents
          : null;
        const wsCostDollars = wsCents !== null ? (wsCents / 100).toFixed(2) : priorWsDollars;
        const sessionCost = typeof data.session_cost === 'string'
          ? data.session_cost.slice(0, 32)
          : priorSessionCost;
        // Allowlisted, type-coerced fields only. No raw response objects.
        const cache = {
          usage_5h: Number(fh.utilization || 0),
          usage_7d: Number(sd && sd.utilization || 0),
          reset_5h_clock: _coerceISOTimestamp(fh.resets_at),
          reset_7d_clock: sd ? _coerceISOTimestamp(sd.resets_at) : '',
          ws_cost_dollars: String(wsCostDollars).slice(0, 16),
          session_cost: sessionCost,
          fetched_at: new Date().toISOString(),
        };
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      } catch (_) {}
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
  req.end();
}

let usageTimer = null;
function startUsageRefresh() {
  if (usageTimer) return;
  refreshAnthropicUsageCache();
  usageTimer = setInterval(refreshAnthropicUsageCache, 30000);
  // unref so this tick alone never keeps the process alive past quit.
  usageTimer.unref();
}
function stopUsageRefresh() {
  if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
}

function bootstrapHuskPromptsIfNeeded() {
  try {
    const candidates = [];
    if (app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'installer', 'prompts'));
    }
    candidates.push(path.join(__dirname, '..', 'installer', 'prompts'));
    let bundle = null;
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) { bundle = c; break; }
    }
    if (!bundle) return;
    fs.mkdirSync(HUSK_PROMPTS_DIR, { recursive: true });
    for (const entry of fs.readdirSync(bundle, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const dst = path.join(HUSK_PROMPTS_DIR, entry.name);
      // Skip if either the active file OR a user-disabled variant exists.
      if (fs.existsSync(dst) || fs.existsSync(dst + '.disabled')) continue;
      try { fs.copyFileSync(path.join(bundle, entry.name), dst); } catch (_) {}
    }
  } catch (err) {
    console.error('[husk] prompt bootstrap failed:', err && err.message);
  }
}

// Park or restore ~/.claude/CLAUDE.md based on the current paiEnabled state.
// Implementation lives in src/lib/pai-state.js so it can be unit-tested
// without spinning up Electron.
const PaiState = require('./lib/pai-state');

// Digests of every CLAUDE.md template Husk has shipped. The toggle parks the
// live file only when it still matches one of these, which is how we tell our
// own untouched scaffold apart from a file the user wrote or edited. Older
// entries stay listed forever so an install that never upgraded its scaffold
// is still recognised as ours.
const SHIPPED_CLAUDE_MD_DIGESTS = [
  // LifeOS 7.1.1, the template in the current bundle. Read at call time rather
  // than hard-coded so it cannot drift from the file we actually ship.
];
function shippedClaudeMdDigests() {
  const digests = [...SHIPPED_CLAUDE_MD_DIGESTS];
  try {
    const bundle = findBundledFramework();
    if (bundle) {
      const tpl = path.join(bundle, 'CLAUDE.template.md');
      if (fs.existsSync(tpl)) digests.push(PaiState.digestOf(fs.readFileSync(tpl, 'utf8')));
    }
  } catch (_) {}
  return digests;
}
function applyPaiState(active) {
  PaiState.applyPaiState(path.join(HOME, '.claude'), active, {
    templateDigests: shippedClaudeMdDigests(),
  });
}

// Per-install state the runtime writes into but the bundle never ships. The
// directories have to exist before the first run or the framework has nowhere
// to put its own output.
const LIFEOS_MEMORY_SUBDIRS = ['WORK', 'KNOWLEDGE', 'LEARNING', 'STATE', 'OBSERVABILITY', 'SKILLS'];

// The vendored bundle carries no bun lockfiles, by rule. Nothing here ever
// installs from them: the per-skill tools are optional and the user resolves
// them if and when they want one. A lockfile we never install from still pins
// exact versions, so all it can do over time is hold the tree to dependency
// versions that have since had advisories filed against them. Dropping them
// means a user who does opt in resolves current versions instead. Keep the
// package.json files, they are what makes that resolve possible.

// Locate the bundled framework.
// Packaged: app.isPackaged && process.resourcesPath/lifeos/ exists.
// Dev:      <repo>/libs/lifeos/ relative to __dirname (which is <repo>/src/).
function findBundledFramework() {
  const candidates = [];
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'lifeos'));
  }
  candidates.push(path.join(__dirname, '..', 'libs', 'lifeos'));
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, 'CLAUDE.template.md'))) return c;
  }
  return null;
}

function bootstrapPaiIfNeeded() {
  // Hard opt-out: when the user has disabled the framework in Preferences, we
  // do not touch ~/.claude/ on launch. Pre-existing files stay where they are
  // (Husk never removes user files behind their back); the user can clean
  // ~/.claude/{LIFEOS,agents,skills,hooks}/ manually if they want.
  if (config.paiEnabled === false) return;
  try {
    const claudeDir = path.join(HOME, '.claude');

    // An install predating this version has the older framework laid out under
    // ~/.claude/PAI/ with a CLAUDE.md whose imports point into it. Dropping the
    // new tree beside it would leave two frameworks side by side and a routing
    // file addressing only the old one, so leave that install alone entirely.
    // Removing it is the user's call, not ours.
    if (fs.existsSync(path.join(claudeDir, 'PAI'))) return;

    const bundle = findBundledFramework();
    if (!bundle) return;

    fs.mkdirSync(claudeDir, { recursive: true });

    // CLAUDE.md: only copy when the user does NOT already have one. This
    // protects user customizations across upgrades.
    const claudemdDst = path.join(claudeDir, 'CLAUDE.md');
    if (!fs.existsSync(claudemdDst)) {
      const tpl = path.join(bundle, 'CLAUDE.template.md');
      if (fs.existsSync(tpl)) fs.copyFileSync(tpl, claudemdDst);
    }

    // Framework subdirs: merge missing children into existing dirs (cp -Rn
    // semantics). Each subdir is checked independently of CLAUDE.md, so a
    // user who already has ~/.claude/CLAUDE.md (claude code creates it) still
    // receives the bundled skills, agents, and hooks. Missing entries are
    // added without ever overwriting a file the user already has.
    // LIFEOS is spelled in caps to match the @LIFEOS/... imports CLAUDE.md
    // carries: on a case-sensitive filesystem any other spelling dangles.
    for (const sub of ['LIFEOS', 'agents', 'commands', 'hooks', 'skills']) {
      const src = path.join(bundle, sub);
      const dst = path.join(claudeDir, sub);
      if (!fs.existsSync(src)) continue;
      if (!fs.existsSync(dst)) copyDirRecursiveSync(src, dst);
      else copyMissingChildrenSync(src, dst);
    }

    // The identity scaffold lands inside the runtime tree so the @LIFEOS/USER/...
    // imports resolve without a symlink. Every shipped file is a blank template;
    // copyMissingChildren means an answered one is never overwritten.
    const userSrc = path.join(bundle, 'USER');
    const userDst = path.join(claudeDir, 'LIFEOS', 'USER');
    if (fs.existsSync(userSrc)) {
      if (!fs.existsSync(userDst)) copyDirRecursiveSync(userSrc, userDst);
      else copyMissingChildrenSync(userSrc, userDst);
    }

    for (const sub of LIFEOS_MEMORY_SUBDIRS) {
      fs.mkdirSync(path.join(claudeDir, 'LIFEOS', 'MEMORY', sub), { recursive: true });
    }
  } catch (err) {
    console.error('[husk] framework bootstrap failed:', err && err.message);
  }
}

// Like cp -Rn at the immediate-children level: for each top-level entry in
// src, copy it to dst only when the destination entry does not exist. Never
// recurses into existing destination subtrees, so user-edited files inside
// already-present skills are never touched.
function copyMissingChildrenSync(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isFile() && BUNDLE_INSTRUCTION_FILES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (fs.existsSync(d)) continue;
    // A skill the user disabled is renamed to _disabled_<name>. Treat that as
    // already present so the original is not re-added alongside the disabled
    // copy.
    if (fs.existsSync(path.join(dst, DISABLED_PREFIX + entry.name))) continue;
    if (entry.isDirectory()) copyDirRecursiveSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    // ignore symlinks/devices
  }
}

// Agent-instruction files carried inside the bundle. The upstream project
// keeps these for its own repo, where they steer whoever is editing the
// framework. Copied into a user's ~/.claude/ they become standing orders that
// person never wrote, in the exact place the CLI looks for their own. Writing
// their instructions is their business, so these stay in the bundle.
const BUNDLE_INSTRUCTION_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);

function copyDirRecursiveSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isFile() && BUNDLE_INSTRUCTION_FILES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursiveSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    // ignore symlinks/devices
  }
}

// ─── Window ──────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    // Low enough that the responsive breakpoints (which collapse the rail and
    // drop the side panels) actually engage, so the app stays fully usable in
    // a small window instead of clipping its chrome.
    minWidth: 720,
    minHeight: 520,
    // The window paints this before the renderer has run, so it has to match the
    // theme about to be applied or the app opens on a frame of the wrong colour.
    backgroundColor: themeBackground(config.theme),
    title: 'Husk',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      zoomFactor: 1.0,
      // DevTools available when running from source (./run.sh, npm start)
      // so the maintainer can debug, locked in shipped builds so end users
      // cannot open the inspector via F12, Ctrl+Shift+I, the View menu,
      // or programmatic openDevTools.
      devTools: !app.isPackaged,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Any URL the renderer tries to open as a new window (xterm link
  // clicks, anchor targets, window.open) is routed to the user's
  // default browser. Husk never spawns a secondary Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  // A bare Alt press moves focus to the application menu bar, which
  // silently swallows every keystroke after it until the user hits
  // Escape; in a terminal-first app that reads as "typing broke".
  // Swallow bare Alt before the menu sees it. Alt+key combos still
  // arrive as their own events (input.key is the combo key), so
  // terminal Alt-sequences keep working.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    const code = String(input.code || '');
    if ((input.control || input.meta) && (key === 'r' || code === 'KeyR')) {
      event.preventDefault();
      if (!input.isAutoRepeat) mainWindow.webContents.send('app:reload-shortcut');
      return;
    }
    if (input.key === 'F5') {
      event.preventDefault();
      if (!input.isAutoRepeat) reloadMainWindow();
      return;
    }
    if (input.key === 'Alt' && !input.control && !input.shift && !input.meta) {
      event.preventDefault();
    }
  });

  // Belt-and-suspenders: also catch top-level navigation attempts so
  // the main window cannot be hijacked away from its loaded index.html.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  // The View submenu drops the DevTools toggle in shipped builds so the
  // menu does not advertise an entry that webPreferences.devTools:false
  // would silently no-op.
  const viewSubmenu = [
    {
      label: 'Reload',
      accelerator: 'CmdOrCtrl+R',
      // Custom click instead of role:reload: the renderer records the current
      // route as users navigate, so a main-process reload can come back there.
      click: reloadMainWindow,
    },
    ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', accelerator: 'F12' }, { type: 'separator' }]),
    // The renderer owns the Ctrl/Cmd +/-/0 keys (applies zoom, refits the
    // terminal, shows the percent). `registerAccelerator: false` keeps the menu
    // roles from binding the same accelerators, so the keys fire one path only.
    // Menu clicks still work.
    { role: 'resetZoom', registerAccelerator: false },
    { role: 'zoomIn', registerAccelerator: false },
    { role: 'zoomOut', registerAccelerator: false },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    // `paste` keeps `registerAccelerator: false` so Ctrl/Cmd+V is not bound twice:
    // xterm already pastes on the native browser paste event, and a second
    // `webContents.paste()` from the accelerator would duplicate the clipboard.
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste', registerAccelerator: false }, { role: 'selectAll' }] },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));

  mainWindow.on('closed', () => {
    killPtyTree();
    mainWindow = null;
  });
}

// Aggressive cleanup: SIGKILL the whole process group of the PTY child so
// `script` + `claude` (and any of its children) all die together. Without this,
// closing the Husk window leaves orphan claude/script processes around.
// SIGKILL one session's whole process group. `script` + agent (and any
// children) all die together; killing an already-dead group is a no-op.
function reapPid(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch (_) {}
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  }, 250).unref();
}

function killSession(s) {
  if (!s) return;
  try { if (s.dataDisposable) s.dataDisposable.dispose(); } catch (_) {}
  try { if (s.exitDisposable) s.exitDisposable.dispose(); } catch (_) {}
  s.dataDisposable = null;
  s.exitDisposable = null;
  reapPid((s.pty && s.pty.pid) || s.pid);
  if (s.pty) { try { s.pty.kill('SIGKILL'); } catch (_) {} }
  s.pty = null;
}

// Reap every live session. Used on window close / app quit so closing Husk
// leaves no orphan agent processes behind.
function killPtyTree() {
  for (const s of sessions.values()) killSession(s);
  try {
    for (const r of runs.values()) {
      try { clearInterval(r.tickInterval); } catch (_) {}
      try { if (r.flushTimer) clearTimeout(r.flushTimer); } catch (_) {}
      try { if (r._dataDisposable) r._dataDisposable.dispose(); } catch (_) {}
      try { if (r._exitDisposable) r._exitDisposable.dispose(); } catch (_) {}
      reapPid(r.pty && r.pty.pid);
      try { if (r.pty) r.pty.kill('SIGKILL'); } catch (_) {}
      r.pty = null;
    }
    runs.clear();
    pendingRuns.length = 0;
  } catch (_) {}
  // Fallback: reap a last-known orphan group even if the map is already empty
  // (e.g. every session's pty was nulled by onExit).
  if (!sessions.size && lastPtyPid) reapPid(lastPtyPid);
  sessions.clear();
  ptyProc = null;
  activeSessionId = null;
  lastPtyPid = 0;
}

// ─── PTY ─────────────────────────────────────────────────────────────────────────

// Transcript file names present in a project dir right now. Used to tell a
// resumed tab's successor transcript apart from the one it was resumed from.
function listTranscriptNames(projDir) {
  try {
    return fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
  } catch (_) { return []; }
}

// Whether a transcript belongs to a person typing in a terminal. Hooks, title
// generators and agent SDK calls all write into the same project directory and
// often land there before the chat's own first turn, so creation order cannot
// identify a tab's transcript. The CLI records how the session was entered:
// an interactive one is "cli", everything programmatic is "sdk-cli"/"sdk-py".
function isInteractiveTranscript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString('utf8', 0, n);
      if (/"entrypoint"\s*:\s*"sdk/.test(head)) return false;
      return /"entrypoint"\s*:\s*"cli"/.test(head);
    } finally { fs.closeSync(fd); }
  } catch (_) { return false; }
}

// The last claude session id Husk bound for a given project dir, so a fresh
// app boot can resume the ongoing discussion instead of starting a new one.
function lastClaudeSessionForCwd(encodedCwd, projDir) {
  const saved = (config.lastClaudeSessions && config.lastClaudeSessions[encodedCwd]) || null;
  return pickResumeSessionId(projDir, saved);
}

// Persist the claude session id bound for this project dir so the next boot
// resumes it. Coalesced (skips no-op writes); harmless if it fails.
function rememberClaudeSession(encodedCwd, sessionId) {
  if (!sessionId) return;
  const map = { ...(config.lastClaudeSessions || {}) };
  if (map[encodedCwd] === sessionId) return;
  map[encodedCwd] = sessionId;
  config = { ...config, lastClaudeSessions: map };
  saveConfig(config);
}

// Environment variables the renderer is allowed to set on a spawned agent.
// An allowlist rather than a passthrough: the renderer hands this straight to a
// child process, and names like PATH, LD_PRELOAD or NODE_OPTIONS decide which
// code runs, not merely how it behaves. Values are single-line and bounded so a
// crafted string cannot carry a newline into the environment block.
const SPAWN_ENV_ALLOW = new Set(['CLAUDE_AGENTS_SELECT']);
function sanitizeSpawnEnv(env) {
  if (!env || typeof env !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SPAWN_ENV_ALLOW.has(k)) continue;
    const value = String(v == null ? '' : v);
    if (!value || value.length > 200 || /[\r\n\0]/.test(value)) continue;
    out[k] = value;
  }
  return Object.keys(out).length ? out : null;
}

// extraEnv reaches the child process and nothing else. Attaching to a running
// background agent is selected by an environment variable the CLI reads at
// startup, so there is no command-line form to express it.
function spawnPty(cols = 100, rows = 30, overrideCmd = null, overrideCwd = null, sessionId = null, resumeLast = false, extraEnv = null) {
  // Target an existing session (Restart replaces just that tab's child) or
  // create a new one (New Chat passes a fresh id so the running agents keep
  // going). Falls back to the active session, then a generated id.
  const id = sessionId || activeSessionId || ('s' + (++sessionSeq));
  let s = sessions.get(id);
  if (!s) {
    s = newSession(id);
  } else {
    // Restart-in-place: dispose the previous child's listeners before we drop
    // the reference (otherwise each restart leaks a node-pty emitter
    // registration), drop any buffered output, and kill the old child.
    try { if (s.dataDisposable) s.dataDisposable.dispose(); } catch (_) {}
    try { if (s.exitDisposable) s.exitDisposable.dispose(); } catch (_) {}
    s.dataDisposable = null;
    s.exitDisposable = null;
    s.dataBuf = '';
    s.flushScheduled = false;
    s.mouseStripper.reset();
    if (s.lastMouseOn) { s.lastMouseOn = false; if (mainWindow) mainWindow.webContents.send('pty:mouse-mode', { sessionId: id, on: false }); }
    reapPid((s.pty && s.pty.pid) || s.pid);
    if (s.pty) try { s.pty.kill('SIGKILL'); } catch (_) {}
  }
  // Reset this session's transcript lock so it re-resolves its own session
  // file instead of inheriting the previous child's or a background agent's.
  // startedAt gates the lock (see readActiveSessionStats): only a file written
  // at or after this spawn gets pinned, so a fresh chat never sticks to a
  // stale or background transcript before its own file exists.
  s.startedAt = Date.now();
  s.transcript = null;
  const shellBin = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : (process.env.SHELL || '/bin/bash');
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLAUDE_DIR,
    // Marker so PAI hooks/statusline can suppress duplicate chrome
    // (status dashboard, neofetch banner, inline statusline) that Husk's
    // right panel already surfaces. PAI side checks $HUSK_HOST and
    // early-exits.
    HUSK_HOST: '1',
  }, extraEnv && typeof extraEnv === 'object' ? extraEnv : {});
  const bunBin = path.join(HOME, '.bun', 'bin');
  if (env.PATH && !env.PATH.includes(bunBin)) env.PATH = `${bunBin}:${env.PATH}`;
  // ~/.local/bin is where the native claude installer (and other user CLIs)
  // land, but a GUI/desktop launch inherits a systemd PATH that omits it.
  // augmentUserPathAsync recovers it from a login shell, but that's async and
  // racy against the first agent spawn. Force-prepend it the same way as bun.
  const localBin = path.join(HOME, '.local', 'bin');
  if (env.PATH && !env.PATH.includes(localBin)) env.PATH = `${localBin}:${env.PATH}`;

  const rawCmd = (overrideCmd || config.agentCommand || 'claude').trim();

  // Tokenize the user's agent command into program + extra args. Naive
  // whitespace split is fine for the vast majority of cases (most users type
  // 'claude' or 'claude --some-flag'); if someone sets an agent command with
  // shell-quoted args we will mistokenize, but that is a corner case.
  const userTokens = rawCmd.split(/\s+/).filter(Boolean);
  let agentExe = userTokens.shift() || 'claude';
  let agentArgs = userTokens;

  // Resolve a bare program name to an absolute path up front (which/where via a
  // login shell if needed) so the spawn does not depend on the child PATH being
  // correct. No-op when already a path or already on env.PATH.
  agentExe = resolveAgentExe(agentExe, env.PATH);

  // For claude commands, inject the Husk runtime context: a settings override
  // that silences the inline statusline, and an appended system prompt that
  // forces the agent to identify by the user's chosen agentName regardless of
  // any persona configured in the user's CLAUDE.md or memory files. Skip if
  // the user already passed --settings, or if we're on Windows (see the
  // platform switch below for why Windows uses cmd.exe /c without the inject).
  // Deliver Husk's session directives (identity name, the speech-balloon
  // line the desktop reads aloud, recap on/off) through each agent's own
  // instruction channel. claude takes a --append-system-prompt flag here;
  // copilot needs a project instructions file, written below once cwd is
  // resolved. See src/lib/agent-inject.js.
  //
  // Note for claude: the statusline override goes through --settings as an
  // inline JSON string. Claude merges it over the user's settings.json, while
  // folder trust remains in ~/.claude.json.
  const isWin32 = process.platform === 'win32';
  let injectionPlan = { method: 'none' };
  if (!isWin32 && !agentArgs.includes('--settings')) {
    injectionPlan = AgentInject.planInjection({
      agentCommand: rawCmd,
      agentName: config.agentName,
      paiEnabled: config.paiEnabled !== false,
      recap: config.recap,
    });
    if (Array.isArray(injectionPlan.args) && injectionPlan.args.length) {
      agentArgs = [...injectionPlan.args, ...agentArgs];
    }
  }

  // Default cwd policy (priority high -> low):
  //   1. explicit overrideCwd (used by Resume to re-enter a session's project)
  //   2. active project's path (config.activeProjectId)
  //   3. user-configured config.agentCwd in Preferences
  //   4. fall back to HOME
  // Why this matters: claude refuses to offer a permanent "remember this
  // folder" trust for $HOME because that would grant agent access to the
  // entire user profile. Pointing Husk at a project subdirectory restores
  // the three-option trust prompt and lets the user grant durable trust.
  let cwd = HOME;
  if (config.agentCwd && typeof config.agentCwd === 'string') {
    try {
      if (fs.existsSync(config.agentCwd) && fs.statSync(config.agentCwd).isDirectory()) {
        cwd = config.agentCwd;
      }
    } catch (_) {}
  }
  if (Array.isArray(config.projects) && config.activeProjectId) {
    const active = config.projects.find((p) => p && p.id === config.activeProjectId);
    if (active && active.path && typeof active.path === 'string') {
      try {
        if (fs.existsSync(active.path) && fs.statSync(active.path).isDirectory()) {
          cwd = active.path;
        }
      } catch (_) {}
    }
  }
  // Note: selecting a repo-installed agent does NOT change the working
  // directory. The agent is loaded by its CLI natively (Husk mirrors it into
  // each CLI's agents dir), and the cwd stays whatever the user configured
  // (agentCwd / active project / home). If a user wants the agent's relative
  // `skills/<id>/SKILL.md` reads to resolve, they point Working directory at
  // that repo themselves in Preferences.
  if (overrideCwd) {
    try {
      if (fs.existsSync(overrideCwd) && fs.statSync(overrideCwd).isDirectory()) {
        cwd = overrideCwd;
      } else {
        // Original project dir is gone (deleted or moved). claude --resume keys sessions to
        // the original cwd path, so we recreate it as an empty dir to let claude find the session.
        try { fs.mkdirSync(overrideCwd, { recursive: true }); cwd = overrideCwd; } catch (_) {}
      }
    } catch (_) {}
  }

  agentArgs = withCopilotContextDir({
    agentExe,
    agentArgs,
    contextDir: path.join(CLAUDE_DIR, 'MEMORY', 'CONTEXT'),
  });

  // Bind this tab to a definite claude session id so stats/recent/resume read
  // exactly this tab's transcript. On resume the id comes from --resume; for a
  // new claude chat we generate one and pass --session-id so claude writes a
  // known file, keeping each tab's transcript distinct even when several share
  // a cwd. Windows is skipped because its spawn may fall back to
  // `cmd.exe /c <rawCmd>`, which ignores agentArgs.
  // Must match the agent CLI's own project-dir encoding (all non-alphanumerics
  // become dashes, dots included); identical to the old form for paths without
  // dots, so existing lastClaudeSessions keys stay valid.
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const resumeMatch = (rawCmd || '').match(/--resume[=\s]+([A-Za-z0-9][A-Za-z0-9-]{6,})/);
  const isClaudeAgent = agentExe === 'claude' || agentExe.endsWith('/claude') || agentExe.endsWith('\\claude');
  // A subcommand runs a different program with its own flags: `claude agents`
  // manages background agents and rejects the session flags the chat form takes.
  // Only the bare chat invocation gets bound to a transcript.
  // Only the first token decides: a flag's value is also a bare word, so
  // `--permission-mode default` must not read as a subcommand.
  const isSubcommand = agentArgs.length > 0 && !String(agentArgs[0]).startsWith('-');
  if (resumeMatch) {
    s.claudeSessionId = resumeMatch[1];
  } else if (isClaudeAgent && !isWin32 && !isSubcommand && !agentArgs.includes('--session-id') && !agentArgs.includes('--resume')) {
    // Keep one discussion in one transcript across restarts (project switch, MCP
    // reload, manual restart). Within a process the tab reuses its own
    // claudeSessionId. Across a full app restart that in-memory id is gone, so
    // a boot/launch continuation (resumeLast) rebinds to the last claude
    // session recorded for this cwd and resumes it. A brand-new chat
    // (openNewChatTab) does not set resumeLast, so it gets its own fresh session.
    const projDir = path.join(CLAUDE_DIR, 'projects', encodedCwd);
    if (!s.claudeSessionId && resumeLast) {
      s.claudeSessionId = lastClaudeSessionForCwd(encodedCwd, projDir);
    }
    if (!s.claudeSessionId) s.claudeSessionId = crypto.randomUUID();
    let pinnedExists = false;
    try { pinnedExists = fs.existsSync(path.join(projDir, `${s.claudeSessionId}.jsonl`)); } catch (_) {}
    agentArgs = pinnedExists
      ? [...agentArgs, '--resume', s.claudeSessionId]
      : [...agentArgs, '--session-id', s.claudeSessionId];
    rememberClaudeSession(encodedCwd, s.claudeSessionId);
  } else {
    s.claudeSessionId = null;
  }
  if (s.claudeSessionId) {
    try {
      const projDir = path.join(CLAUDE_DIR, 'projects', encodedCwd);
      const pinned = path.join(projDir, `${s.claudeSessionId}.jsonl`);
      // Resume: the file exists already. New chat: it appears once claude starts
      // writing, so until then the session has no transcript and reads 0 context.
      const resumed = fs.existsSync(pinned);
      s.transcript = resumed ? pinned : null;
      // --resume names the conversation to continue, not the file that will be
      // written: the CLI opens a fresh transcript under a new id and leaves the
      // one it was handed frozen. Snapshot the directory so the successor is
      // identifiable later as the file that was not here when this tab spawned.
      s.resumedTranscript = resumed;
      s.priorTranscripts = resumed ? new Set(listTranscriptNames(projDir)) : null;
    } catch (_) { s.transcript = null; }
  }

  // Agents with no system-prompt flag (copilot) take their directives from a
  // project instructions file. Write a marker-managed HUSK-SESSION block into
  // it now that cwd is known. Non-destructive: only Husk's marked region is
  // touched; the user's own instructions are preserved.
  if (injectionPlan.filePath) {
    try {
      const fileAbs = path.join(cwd, injectionPlan.filePath);
      const dir = path.dirname(fileAbs);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fileAbs is cwd + a fixed relative path
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (injectionPlan.method === 'read-file') {
        // A Husk-owned file passed explicitly via --read; rewrite it fresh each
        // session (no user content to preserve).
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to cwd
        fs.writeFileSync(fileAbs, `${String(injectionPlan.body || '').trim()}\n`);
      } else {
        // A file the agent auto-reads (copilot, codex) that the user may also
        // own; merge Husk's marked block in non-destructively. Read directly and
        // treat a missing file as empty, rather than check-then-read (which races).
        let existing = '';
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to cwd
        try { existing = fs.readFileSync(fileAbs, 'utf8'); } catch (_) {}
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to cwd
        fs.writeFileSync(fileAbs, AgentInject.mergeSessionBlock(existing, injectionPlan.body));
      }
    } catch (_) {}
  }

  // Refresh the HUSK-SESSION block in every OTHER managed instruction file
  // that already carries one. Agent CLIs read each other's files (copilot
  // also reads AGENTS.md / GEMINI.md), so each block must state the current
  // directives regardless of which agent wrote it. Only files that exist
  // and already contain Husk's markers are touched; nothing is created here.
  if (injectionPlan.refresh && Array.isArray(injectionPlan.refresh.filePaths)) {
    for (const rel of injectionPlan.refresh.filePaths) {
      if (rel === injectionPlan.filePath) continue;
      try {
        const fileAbs = path.join(cwd, rel);
        let existing = null;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- cwd + a fixed relative path from the plan
        try { existing = fs.readFileSync(fileAbs, 'utf8'); } catch (_) {}
        if (existing === null || !existing.includes(AgentInject.HUSK_SESSION_START)) continue;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to cwd
        fs.writeFileSync(fileAbs, AgentInject.mergeSessionBlock(existing, injectionPlan.refresh.body));
      } catch (_) {}
    }
  }

  // Per-platform argv assembly (see src/lib/pty-spawn.js for the rules):
  //   darwin   pty.spawn(agentExe, agentArgs); no shell parser involved
  //   linux    pty.spawn('/usr/bin/script', ['-q', '-c', shJoin(...), '/dev/null'])
  //            because `claude --resume` needs the script setsid/TIOCSCTTY
  //            setup; argv inside the -c string is shell-escaped by shJoin
  //   win32    pty.spawn(resolved-via-PATHEXT, agentArgs) when the program
  //            name resolves to a real file; falls back to cmd.exe /c
  //            <rawCmd> only when no candidate exists (preserves legacy)
  const spec = buildSpawnSpec({
    platform: process.platform,
    agentExe,
    agentArgs,
    rawCmd,
    env,
    shell: shellBin,
    shJoin,
    scriptExists: process.platform === 'linux' && fs.existsSync('/usr/bin/script'),
  });

  s.pty = pty.spawn(spec.exe, spec.argv, { name: 'xterm-256color', cols, rows, cwd, env });
  s.pid = s.pty.pid;
  s.cwd = cwd;
  // First-launch time of this tab's session, used to match it to the claude
  // session file it creates (so the tab can show that session's title). A
  // restart-in-place keeps the original launch time.
  if (!s.startedAt) s.startedAt = Date.now();
  lastPtyPid = s.pty.pid;
  // Coalesce PTY output: a chatty agent (build logs, a big cat) emits
  // many chunks per tick. Buffer them and flush once per microtask so
  // the renderer receives one message per burst instead of one IPC send
  // per chunk, which otherwise floods the channel and janks the UI.
  s.dataDisposable = s.pty.onData((data) => {
    s.lastDataAt = Date.now();
    s.dataBuf += data;
    // Small rolling tail of raw output, kept so the status panel can read a
    // CLI's own status line (e.g. Copilot's "Session: N AIC used") without a
    // transcript. Capped so it never grows with the session.
    s.tailBuf = ((s.tailBuf || '') + data).slice(-8192);
    if (!s.flushScheduled) { s.flushScheduled = true; setImmediate(() => flushSessionData(s)); }
    // Autopilot + the TUI-settle detector operate on the focused agent only.
    if (id === activeSessionId) { ptyLastDataAt = s.lastDataAt; }
  });
  s.exitDisposable = s.pty.onExit(({ exitCode }) => {
    flushSessionData(s);
    if (mainWindow) mainWindow.webContents.send('pty:exit', { sessionId: id, code: exitCode });
    s.pty = null;
    if (id === activeSessionId) ptyProc = null;
    // Autopilot runs own dedicated PTYs (see spawnRunPty); this focused-chat
    // PTY exit does not touch any run. Each run's own PTY onExit closes it.
  });
  setActiveSession(id);
  return id;
}

// Read the most-recent claude session JSONL for the active PTY cwd and
// return a coarse usage estimate: turn count + a token estimate based on
// total content characters (chars/4 is the common heuristic). This is the
// only honest "session usage" Husk can show, since the agent process owns
// the real token counter and only writes it to usage-cache.json if PAI's
// statusline is wired up. No statusline → 0% forever.
let _claudeJsonCache = { mtime: 0, data: null };
function readClaudeJson() {
  try {
    const p = path.join(HOME, '.claude.json');
    // Stat and read through one open descriptor so both operate on the same
    // file even if the path is replaced between calls.
    const fd = fs.openSync(p, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (st.mtimeMs !== _claudeJsonCache.mtime) {
        _claudeJsonCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(fd, 'utf8')) };
      }
      return _claudeJsonCache.data;
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// Per-project trust. Claude Code ignores a workspace's saved permissions until
// the folder is trusted (projects[cwd].hasTrustDialogAccepted in ~/.claude.json),
// printing a warning on every start. Husk surfaces this as an explicit,
// user-initiated "trust this folder" action; it never sets trust silently.
function isCwdTrusted(cwd) {
  if (!cwd) return true;
  const j = readClaudeJson();
  if (!j || !j.projects || !j.projects[cwd]) return false;
  return !!j.projects[cwd].hasTrustDialogAccepted;
}
function acceptCwdTrust(cwd) {
  if (!cwd) return { ok: false, error: 'No working directory.' };
  try {
    const p = path.join(HOME, '.claude.json');
    let j = {};
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch (_) {}
    j.projects = j.projects || {};
    j.projects[cwd] = j.projects[cwd] || {};
    j.projects[cwd].hasTrustDialogAccepted = true;
    fs.writeFileSync(p, JSON.stringify(j, null, 2), { mode: 0o600 });
    _claudeJsonCache = { mtime: 0, data: null };
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
ipcMain.handle('claude:trust:status', (_e, cwd) => {
  const dir = cwd || activePtyCwd || HOME;
  return { cwd: dir, trusted: isCwdTrusted(dir) };
});
ipcMain.handle('claude:trust:accept', (_e, cwd) => acceptCwdTrust(cwd || activePtyCwd || HOME));

// ~/.claude/settings.json holds the configured model (e.g. "claude-fable-5[1m]")
// (the same source Claude Code shows in its startup banner). Reading it gives a
// never-stale, auto-updating model id without hardcoding anything. Cached by
// mtime so the status poll only reparses when the file actually changes.
let _claudeSettingsCache = { mtime: 0, data: null };
function readClaudeSettings() {
  try {
    const p = path.join(CLAUDE_DIR, 'settings.json');
    // Stat and read through one open descriptor so both operate on the same
    // file even if the path is replaced between calls.
    const fd = fs.openSync(p, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (st.mtimeMs !== _claudeSettingsCache.mtime) {
        _claudeSettingsCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(fd, 'utf8')) };
      }
      return _claudeSettingsCache.data;
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// Base context-window capacity (tokens) per model family, across the agents
// Husk can launch (claude, copilot, codex, gemini). The id is matched with its
// tier suffix already stripped. Returns null for an unknown family so the
// caller can fall back. Claude models report their 200K *default* tier here;
// the 1M tier is opt-in (a "[1m]" suffix) and handled by resolveContextWindow,
// not this table. Sources verified 2026-06: Anthropic models reference
// (Opus/Sonnet/Haiku 200K default, 1M tier); OpenAI Codex docs (GPT-5.x-Codex
// 400K product cap, GPT-4.1 1M, GPT-4o 128K, o-series 200K); Google Gemini docs
// (Gemini 2.x/3 = 1M); GitHub Copilot CLI docs (128K default, 1M extended).
const MODEL_CONTEXT_WINDOWS = [
  // Anthropic / Claude Opus: 1M context window (the Opus tier ships with the
  // long-context window, so it is the base here, not an opt-in [1m] tier).
  [/^claude-opus/, 1000000],
  // Anthropic / Claude: 200K default; 1M only when the [1m] tier is selected.
  [/^claude-/, 200000],
  // OpenAI / Codex CLI.
  [/^gpt-5.*codex/, 400000],
  [/^gpt-5/, 400000],
  [/^gpt-4\.1/, 1000000],
  [/^gpt-4o/, 128000],
  [/^gpt-4/, 128000],
  [/^o[1-9]/, 200000],          // o1 / o3 / o4 reasoning models
  [/codex/, 192000],
  // Google / Gemini CLI.
  [/^gemini-/, 1000000],
  // GitHub Copilot CLI: default tier (extended 1M is opt-in per request).
  [/copilot/, 128000],
];
function baseContextWindow(model) {
  const m = String(model || '').toLowerCase();
  for (const [re, size] of MODEL_CONTEXT_WINDOWS) if (re.test(m)) return size;
  return null;
}

// Resolve the live context-window size for the active model. The transcript
// records only the bare model id (e.g. "claude-opus-4-8"); the 1M tier is
// signalled by a "[1m]" suffix that Claude Code persists in ~/.claude.json
// under projects[cwd].lastModelUsage. So: prefer an explicit 1M tier (from the
// id or that usage record), else look up the family's base size, else infer.
// Claude Code accepts short model aliases in settings.json ("opus", "sonnet",
// "haiku", "opusplan"). The settings model is used whenever the transcript has
// not yet named one. A bare alias matches none of the claude-* family regexes,
// so expand known aliases to a canonical family id before matching; any tier suffix
// ("opus[1m]") is preserved. Full ids ("claude-opus-4-8", "gpt-5-codex") and
// unknown values pass through untouched.
function normalizeModelId(id) {
  const s = String(id || '').toLowerCase().trim();
  if (!s || s.includes('-')) return s; // full ids already contain a hyphen
  const tier = (s.match(/\[[^\]]*\]/) || [''])[0];
  const base = s.replace(/\[[^\]]*\]/g, '');
  const ALIAS = { opus: 'claude-opus', opusplan: 'claude-opus', sonnet: 'claude-sonnet', haiku: 'claude-haiku' };
  return ALIAS[base] ? ALIAS[base] + tier : s;
}

function resolveContextWindow(cwd, model, ctxTokens) {
  const norm = normalizeModelId(model);
  const stripTier = (id) => id.replace(/\[[^\]]*\]/g, '');
  const is1m = (id) => /\[1m\]/i.test(id);
  const bare = stripTier(norm);
  try {
    // Explicit 1M tier on the id itself.
    if (is1m(norm)) return 1000000;
    // Recover the tier from Claude Code's usage record. lastModelUsage is only
    // written on session end, so the active project is empty mid-session: check
    // it first, then the user's full history. If this model was ever run on the
    // 1M tier, honor 1M; that reflects the user's actual model and license.
    const projects = (readClaudeJson() || {}).projects || {};
    if (bare) {
      const tierFor = (usage) => {
        const matches = Object.keys(usage || {}).filter((k) => stripTier(k) === bare);
        if (!matches.length) return null;
        return matches.some(is1m) ? '1m' : 'base';
      };
      let tier = cwd && projects[cwd] ? tierFor(projects[cwd].lastModelUsage) : null;
      if (!tier) {
        for (const p of Object.values(projects)) {
          const t = tierFor(p.lastModelUsage);
          if (t === '1m') { tier = '1m'; break; }
          if (t === 'base') tier = 'base';
        }
      }
      if (tier === '1m') return 1000000;
    }
    // Known model family → its base context window.
    const base = baseContextWindow(bare);
    if (base) return base;
  } catch (_) {}
  // Unknown model: anything past the 200K base must be a 1M window.
  return ctxTokens > 200000 ? 1000000 : 200000;
}

function readActiveSessionStats() {
  try {
    if (!activePtyCwd) return null;
    const projectsDir = path.join(CLAUDE_DIR, 'projects');
    // Same encoding the agent CLI uses (all non-alphanumerics become dashes);
    // a narrower class breaks any project path containing a dot.
    const encoded = activePtyCwd.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = path.join(projectsDir, encoded);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(dir, f);
        try { const st = fs.statSync(p); return { p, mtime: st.mtimeMs, btime: st.birthtimeMs, size: st.size }; } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    // Resolve which transcript this tab reads. Several `claude` processes can
    // write into one project dir at once (the foreground chat plus background
    // agents), so each tab is bound to its own file. Once a tab's file is
    // resolved it keeps reading that one so the readout stays stable and grows
    // with the conversation; it re-resolves only when that file disappears.
    const sess = activeSessionId ? sessions.get(activeSessionId) : null;
    let latest = null;
    if (sess && sess.resumedTranscript) {
      // A resumed tab was handed the id of the conversation to continue, and the
      // CLI writes the continuation to a new file. Reading the id it was handed
      // reports the source conversation forever: its model, its turn count, its
      // occupancy, none of them moving. The live file is the one that was not in
      // the directory when this tab spawned, written by an interactive session.
      // The interactive test is what makes this reliable: hooks and title
      // generators spawn their own sessions into the same directory, and one of
      // them routinely appears before the chat's own first turn, so arrival
      // order alone picks a two-turn helper. Earliest-first among the survivors,
      // since the tab's transcript precedes any agent it goes on to spawn.
      const claimed = new Set();
      for (const o of sessions.values()) if (o !== sess && o.transcript) claimed.add(o.transcript);
      const prior = sess.priorTranscripts || new Set();
      const fresh = files
        .filter((f) => !prior.has(path.basename(f.p)) && !claimed.has(f.p))
        .sort((a, b) => (a.btime || a.mtime) - (b.btime || b.mtime))
        .find((f) => isInteractiveTranscript(f.p));
      if (fresh) {
        latest = fresh.p;
        sess.transcript = fresh.p;
        sess.claudeSessionId = path.basename(fresh.p, '.jsonl');
        sess.resumedTranscript = false;
        sess.priorTranscripts = null;
        rememberClaudeSession(encoded, sess.claudeSessionId);
      } else if (sess.transcript && fs.existsSync(sess.transcript)) {
        // Nothing new yet: keep showing the resumed conversation rather than a
        // blank panel, since that is what the pane is displaying too.
        latest = sess.transcript;
      }
    } else if (sess && sess.claudeSessionId) {
      // This tab owns exactly <claudeSessionId>.jsonl in its cwd, so tabs that
      // share a cwd stay distinct. The file appears on the chat's first turn;
      // until then there is nothing to read and the context reads 0.
      const pinned = path.join(dir, `${sess.claudeSessionId}.jsonl`);
      if (fs.existsSync(pinned)) { latest = pinned; sess.transcript = pinned; }
    } else if (sess && sess.transcript && fs.existsSync(sess.transcript)) {
      latest = sess.transcript;
    } else if (sess) {
      // Fallback for tabs with no pinned id (copilot, or claude on Windows):
      // adopt the newest transcript not already held by another live tab and
      // written at/after this tab spawned, so each tab keeps its own file.
      const claimed = new Set();
      for (const o of sessions.values()) if (o !== sess && o.transcript) claimed.add(o.transcript);
      const own = files.find((f) => f.mtime >= (sess.startedAt || 0) && !claimed.has(f.p));
      if (own) { latest = own.p; sess.transcript = own.p; }
    } else if (files[0]) {
      latest = files[0].p;
    }
    // Cap the read. A session JSONL grows for the whole conversation and
    // can reach many megabytes; reading and parsing the entire file on
    // every status poll stalls the main thread. Read at most the last
    // CAP bytes (dropping the first partial line) so the cost stays
    // bounded. For large sessions the turn/char numbers become a
    // recent-tail estimate, which is acceptable for a coarse readout.
    const CAP = 1024 * 1024;
    // Defaults to empty: a brand-new session with no owned transcript yet
    // reports 0 context/turns rather than another session's numbers.
    let raw = [];
    // Size of the file we actually settled on (the locked transcript may not be
    // the newest entry), so the tail-read slices the right byte range.
    let sz = 0;
    if (latest) try { sz = fs.statSync(latest).size; } catch (_) {}
    if (latest && Number.isFinite(sz) && sz > CAP) {
      const fd = fs.openSync(latest, 'r');
      try {
        const buf = Buffer.alloc(CAP);
        fs.readSync(fd, buf, 0, CAP, sz - CAP);
        const tail = buf.toString('utf8');
        const nl = tail.indexOf('\n');
        raw = (nl >= 0 ? tail.slice(nl + 1) : tail).split('\n').filter(Boolean);
      } finally { fs.closeSync(fd); }
    } else if (latest) {
      raw = fs.readFileSync(latest, 'utf8').split('\n').filter(Boolean);
    }
    let turns = 0;
    let chars = 0;
    let model = '';
    // Live context-window occupancy. Claude Code records per-turn token usage
    // on each assistant message; the current context is the most recent
    // assistant turn's input + cache-creation + cache-read tokens (the output
    // of that turn becomes input on the next). This mirrors the number the PAI
    // statusline shows from Claude Code's own context_window meter.
    let ctxTokens = 0;
    for (const line of raw) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' || obj.type === 'assistant') turns++;
        // The agent records the model on each assistant turn. Keep the most
        // recent one so a mid-session model switch is reflected. Agents that
        // do not write a session log simply never set this, and the UI hides
        // the row.
        // Skip Claude Code's "<synthetic>" placeholder model (used on
        // resume-injected turns) so the real model id is what survives.
        if (obj.message && typeof obj.message.model === 'string' && obj.message.model && obj.message.model !== '<synthetic>') model = obj.message.model;
        const usage = obj.message && obj.message.usage;
        if (usage) {
          const used = (usage.input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0)
            + (usage.cache_read_input_tokens || 0);
          if (used > 0) ctxTokens = used;
        }
        const content = obj.message && obj.message.content;
        if (typeof content === 'string') chars += content.length;
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === 'string') chars += part.length;
            else if (part && typeof part.text === 'string') chars += part.text.length;
          }
        }
      } catch (_) {}
    }
    // Model preference. settings.json is the model the user selected and the
    // same value the CLI's own picker reports, so it answers "what is this
    // running" directly and cannot name some other session. A transcript can
    // only answer it by first being the right transcript, and this directory
    // holds hundreds written by hooks, title generators and agent runs; picking
    // the wrong one reports a model the user never chose. Transcripts are used
    // for turn counts and occupancy, which are per-file by nature, and for the
    // model only when settings names none.
    const settingsModel = ((readClaudeSettings() || {}).model || '').trim();
    let effModel = settingsModel || model;
    // Model label fallback, DISPLAY ONLY. If neither settings.json nor this
    // tab's own transcript yielded a model (a brand-new tab before its first
    // turn, or a non-claude tab), borrow the model from the newest transcript
    // in the project dir just for the label. Occupancy and turn counts above
    // stay tied to this tab's own transcript, so a fresh chat never inherits
    // another session's context figures (e.g. a 381K window from a sibling).
    if (!effModel && files[0]) {
      try {
        const fsz = files[0].size;
        const MCAP = 64 * 1024;
        let mbuf;
        if (Number.isFinite(fsz) && fsz > MCAP) {
          const fd = fs.openSync(files[0].p, 'r');
          try { const b = Buffer.alloc(MCAP); fs.readSync(fd, b, 0, MCAP, fsz - MCAP); mbuf = b.toString('utf8'); } finally { fs.closeSync(fd); }
        } else {
          mbuf = fs.readFileSync(files[0].p, 'utf8');
        }
        const mlines = mbuf.split('\n');
        for (let i = mlines.length - 1; i >= 0 && !effModel; i--) {
          if (!mlines[i]) continue;
          try {
            const o = JSON.parse(mlines[i]);
            const m = o.message && o.message.model;
            if (typeof m === 'string' && m && m !== '<synthetic>') effModel = m;
          } catch (_) {}
        }
      } catch (_) {}
    }
    // The model id carries the context tier (e.g. "[1m]"); resolve the window
    // from it plus the user's actual model/license selection. ctxTokens is the
    // real occupancy from claude's own per-turn usage (input + cache_read +
    // cache_creation): the same figure the PAI statusline shows. This counts
    // the cached PAI base plus the conversation, read from the latest usage
    // record in the file's tail, so it stays correct even for huge transcripts.
    const ctxWindow = resolveContextWindow(activePtyCwd, effModel, ctxTokens);
    const ctxPct = ctxWindow ? Math.round((ctxTokens / ctxWindow) * 1000) / 10 : 0;
    return { turns, chars, tokens: Math.round(chars / 4), file: latest, model: effModel, modelLabel: catalogModelLabel(effModel), ctxTokens, ctxWindow, ctxPct };
  } catch (_) { return null; }
}

// Resolve the target session for a channel: the named session when it
// exists, else the focused one. Keeps single-arg callers (write/resize with
// no sessionId) working against the active agent.
function targetSession(sessionId) {
  return (sessionId && sessions.get(sessionId)) || activeSession();
}
ipcMain.handle('pty:start', (_e, { cols, rows, command, cwd, sessionId, resumeLast, env } = {}) => spawnPty(cols, rows, command || null, cwd || null, sessionId || null, !!resumeLast, sanitizeSpawnEnv(env)));
// List the chat PTYs that are still alive, so a reloaded renderer can rebuild
// its tabs and reattach instead of orphaning them and minting a fresh chat.
ipcMain.handle('pty:list', () => {
  const list = [];
  for (const [id, s] of sessions) {
    if (!s.pty) continue;
    // Only mark a claude session resumable if its transcript actually exists. A
    // chat whose claude exited 0 before writing leaves no .jsonl, and
    // `claude --resume <id>` on it fails with "No conversation found".
    let resumable = false;
    if (s.claudeSessionId && s.cwd) {
      try {
        const enc = s.cwd.replace(/[^a-zA-Z0-9]/g, '-');
        resumable = fs.existsSync(path.join(CLAUDE_DIR, 'projects', enc, `${s.claudeSessionId}.jsonl`));
      } catch (_) {}
    }
    list.push({ sessionId: id, cwd: s.cwd || null, claudeSessionId: s.claudeSessionId || null, resumable, active: id === activeSessionId });
  }
  return { ok: true, sessions: list, activeSessionId };
});
// Reattach a reloaded renderer tab to an existing PTY without disturbing it:
// resize to the new viewport and re-mark it active. Used only for agents that
// cannot resume a session (claude chats are resumed instead, which re-renders
// full history cleanly). No scrollback replay: a PTY byte stream is terminal-
// control sequences, not a log, and replaying it into a fresh terminal mangles.
ipcMain.handle('pty:reattach', (_e, { sessionId, cols, rows, activate } = {}) => {
  const s = sessions.get(sessionId);
  if (!s || !s.pty) return { ok: false, error: 'no live session' };
  try { if (cols && rows) s.pty.resize(Math.max(2, cols), Math.max(2, rows)); } catch (_) {}
  if (mainWindow) mainWindow.webContents.send('pty:mouse-mode', { sessionId, on: !!s.lastMouseOn });
  if (activate) setActiveSession(sessionId);
  return { ok: true, mouseOn: !!s.lastMouseOn, cwd: s.cwd || null, claudeSessionId: s.claudeSessionId || null };
});
ipcMain.on('pty:write', (_e, { data, sessionId } = {}) => {
  const s = targetSession(sessionId);
  if (s && s.pty) s.pty.write(data);
});
ipcMain.on('pty:resize', (_e, { cols, rows, sessionId } = {}) => {
  const s = targetSession(sessionId);
  if (s && s.pty) try { s.pty.resize(cols, rows); } catch (_) {}
});
// Forward the mouse wheel to a full-screen agent that has mouse reporting on,
// so the wheel scrolls the agent's transcript. Only the wheel is forwarded;
// click/drag tracking is stripped so drag-to-select stays local in xterm.
ipcMain.on('pty:wheel', (_e, { deltaY, deltaMode, col, row, sessionId } = {}) => {
  const s = targetSession(sessionId);
  if (!s || !s.pty || !s.lastMouseOn) return;
  const steps = wheelSteps(deltaY, deltaMode);
  if (!steps) return;
  const seq = wheelSequence(deltaY < 0, col, row);
  for (let i = 0; i < steps; i++) s.pty.write(seq);
});
ipcMain.handle('pty:restart', (_e, { cols, rows, command, cwd, sessionId } = {}) => {
  spawnPty(cols || 100, rows || 30, command || null, cwd || null, sessionId || activeSessionId || null);
  return true;
});
ipcMain.handle('pty:setActive', (_e, sessionId) => { if (sessions.has(sessionId)) setActiveSession(sessionId); return true; });

ipcMain.handle('ui:setRouteState', (_e, state = {}) => {
  rendererRouteState = {
    page: normalizeRendererPage(String(state.page || 'chat')),
    activeTabId: state.activeTabId ? String(state.activeTabId) : null,
    ts: Date.now(),
  };
  return true;
});

ipcMain.handle('ui:takeReloadState', () => {
  const state = pendingRendererReloadState;
  pendingRendererReloadState = null;
  if (!state || Date.now() - Number(state.ts || 0) > 60_000) return null;
  return state;
});

// Close exactly one session, leaving the others running. Promotes the next
// remaining session to active if the closed one was focused.
ipcMain.handle('pty:close', (_e, sessionId) => {
  const s = sessions.get(sessionId);
  if (!s) return false;
  killSession(s);
  sessions.delete(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
    ptyProc = null;
    activePtyCwd = null;
    const next = sessions.keys().next();
    if (!next.done) setActiveSession(next.value);
  }
  return true;
});

// ─── Autopilot Mode IPC ────────────────────────────────────────────────────
//
// The supervisor module owns one autonomous-run lifecycle: snapshot,
// audit log, budget meter, halt-on-cap. main.js wires it through IPC
// and tracks the active runner so multiple windows / a runaway
// renderer cannot start two runs at once over the same session id.
//
// Encryption: electron safeStorage wraps OS keychain APIs (libsecret /
// macOS Keychain / Windows DPAPI). When available we use it on every
// blob the snapshot store and the audit log write. The runtime
// check (`isEncryptionAvailable`) returns false on a headless / dev
// build, in which case blobs land in plaintext on disk inside the
// Husk user-data dir; the supervisor still reports the run as
// "trusted-by-rewind".

const Autopilot = require('./lib/autonomy');
const AgentOneShot = require('./lib/agent-oneshot');
const { withAutopilotArgs } = require('./lib/autopilot-args');
const AutopilotStatus = require('./lib/autopilot-status');
const AutopilotQuestion = require('./lib/autopilot-question');
const { applyWorkerChangesToIntegrator, applyWorkersWhenIntegratorEmpty } = require('./lib/autopilot-integrate');
const { groupHistoryRuns } = require('./lib/autopilot-history');
const electronApp = require('electron');
const { execFileSync } = require('child_process');

// runs-pool: concurrent Autopilot runs, each keyed by runId. Each run owns a
// dedicated PTY (separate from the focused chat PTY) and its own git worktree,
// so N runs execute side by side without sharing terminal state or files.
// Each entry: { runner, pty, _dataDisposable, _exitDisposable, worktreePath,
//               workspaceRoot, isWorktree, outputBuf, flushTimer, finishing,
//               tickInterval }
const runs = new Map();
const pendingRuns = []; // { runId, payload, workspaceRoot } queued past the concurrency cap
const AP_MAX_CONCURRENT = 4;
const AUT_OUTPUT_FLUSH_MS = 250;

const applyWorktreeChanges = require('./lib/autopilot-apply').applyWorktreeChanges;
const { rankRuns } = require('./lib/race-judge');
const Orchestrator = require('./lib/autopilot-orchestrator');
const { modelArgsFor, classifyTier } = require('./lib/model-routing');
const { agentBaseName } = require('./lib/agent-oneshot');
const {
  modelFlagFor,
  parseModelCatalog,
  providerLabel,
  titleFromId,
  uniqueModels,
  fallbackModelsFor,
  isModelValueUsable,
} = require('./lib/model-catalog');

function autopilotStorageRoot() {
  return path.join(app.getPath('userData'), 'autonomy');
}

// Retained-runs registry: a finished run keeps its worktree on disk until the
// operator applies or discards it, so the changes the agent made are reviewable
// and mergeable rather than thrown away on completion. The registry is a small
// JSON file so retained worktrees survive an app restart and orphans are
// discoverable (each entry names its worktree path + origin workspace).
function retainedRegistryPath() {
  return path.join(app.getPath('userData'), 'autopilot-retained.json');
}
function readRetained() {
  try {
    const j = JSON.parse(fs.readFileSync(retainedRegistryPath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}
function writeRetained(map) {
  try { fs.writeFileSync(retainedRegistryPath(), JSON.stringify(map, null, 2)); } catch (_) {}
}
function retainRun(runId, entry) {
  const map = readRetained();
  map[runId] = entry;
  writeRetained(map);
}
function getRetained(runId) {
  return readRetained()[runId] || null;
}
function dropRetained(runId) {
  const map = readRetained();
  if (map[runId]) { delete map[runId]; writeRetained(map); }
}
function autopilotCrypto() {
  try {
    if (electronApp.safeStorage && electronApp.safeStorage.isEncryptionAvailable()) {
      return {
        encrypt: (buf) => electronApp.safeStorage.encryptString(buf.toString('base64')),
        decrypt: (buf) => Buffer.from(electronApp.safeStorage.decryptString(buf), 'base64'),
      };
    }
  } catch (_) {}
  return { encrypt: null, decrypt: null };
}

// Create an isolated git worktree for a run so concurrent runs never touch
// each other's files or the operator's working tree. The worktree lives under
// a managed root in userData, never inside the project tree or HOME.
function createRunWorktree(runId, workspaceRoot) {
  const wtRoot = path.join(app.getPath('userData'), 'autopilot-worktrees');
  const wtPath = path.join(wtRoot, runId);
  // Refuse HOME
  if (path.resolve(workspaceRoot) === path.resolve(HOME)) {
    return { ok: false, error: 'worktree refused for home directory' };
  }
  // Check git repo
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: workspaceRoot, stdio: 'pipe' });
  } catch (_) {
    return { ok: false, error: 'project is not a git repository; Autopilot requires git for worktree isolation' };
  }
  // Confine wtPath under wtRoot (never inside project tree or HOME)
  const resolvedWt = path.resolve(wtPath);
  const resolvedWtRoot = path.resolve(wtRoot);
  if (!resolvedWt.startsWith(resolvedWtRoot + path.sep) && resolvedWt !== resolvedWtRoot) {
    return { ok: false, error: 'worktree path escapes managed root' };
  }
  const resolvedHome = path.resolve(HOME);
  if (resolvedWt === resolvedHome || resolvedWt.startsWith(resolvedHome + path.sep + '..')) {
    return { ok: false, error: 'worktree path resolves to HOME or above' };
  }
  try {
    fs.mkdirSync(wtRoot, { recursive: true });
    execFileSync('git', ['worktree', 'add', wtPath, 'HEAD'], { cwd: workspaceRoot, stdio: 'pipe' });
    return { ok: true, worktreePath: wtPath };
  } catch (err) {
    return { ok: false, error: `git worktree add failed: ${(err && err.message) || String(err)}` };
  }
}

function autopilotWorktreeRoot() {
  return path.join(app.getPath('userData'), 'autopilot-worktrees');
}

function isAutopilotWorkspacePath(p) {
  if (typeof p !== 'string' || !p.trim()) return false;
  try {
    const root = path.resolve(autopilotWorktreeRoot());
    const abs = path.resolve(p);
    if (abs === root || abs.startsWith(root + path.sep)) return true;
    return abs.split(path.sep).includes('autopilot-worktrees');
  } catch (_) {
    return false;
  }
}

// Remove a run's worktree. Prefer `git worktree remove` (also prunes the
// admin ref); fall back to a plain recursive delete if git refuses.
function removeRunWorktree(worktreePath, workspaceRoot) {
  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: workspaceRoot || path.dirname(worktreePath), stdio: 'pipe' });
  } catch (_) {
    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch (_) {}
  }
}

// Startup reconciliation for crash-orphaned worktrees. An app crash or
// force-quit during a live run never reaches finishRun, so its worktree is
// left under autopilot-worktrees/ with no retained-runs entry -- a silent
// disk leak, and the agent's work is invisible to Apply/Discard. On startup
// the runs Map is empty, so every worktree dir not in the retained registry
// is such an orphan. A provably-CLEAN orphan (no uncommitted changes) is
// safe to prune; an orphan with real changes is RETAINED so the review UI
// surfaces it and nothing the agent did is ever destroyed. Fully guarded so
// a reconcile failure can never block startup.
function reconcileOrphanWorktrees() {
  const wtRoot = path.join(app.getPath('userData'), 'autopilot-worktrees');
  let entries;
  try { entries = fs.readdirSync(wtRoot, { withFileTypes: true }); } catch (_) { return; }
  const retained = readRetained();
  let pruned = 0; let recovered = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const runId = ent.name;
    if (retained[runId]) continue;                 // already tracked for review
    const wtPath = path.join(wtRoot, runId);
    let workspaceRoot = null; let porcelain = null;
    try {
      // .git-common-dir points at the MAIN repo's .git; its parent is origin.
      const commonDir = execFileSync('git', ['-C', wtPath, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: 'pipe' }).trim();
      const absCommon = path.isAbsolute(commonDir) ? commonDir : path.resolve(wtPath, commonDir);
      workspaceRoot = path.dirname(absCommon);
      porcelain = execFileSync('git', ['-C', wtPath, 'status', '--porcelain=v1'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (_) {
      // Invalid worktree metadata is pruned from the retained-run directory.
      try { fs.rmSync(wtPath, { recursive: true, force: true }); pruned++; } catch (_) {}
      continue;
    }
    const changes = [];
    for (const c of parsePorcelain(porcelain)) {
      if (!c || c.status === 'ignored') continue;
      if (c.status === 'renamed') {
        if (c.oldPath) changes.push({ path: c.oldPath, status: 'deleted' });
        changes.push({ path: c.path, status: 'added' });
      } else if (c.status === 'copied') {
        changes.push({ path: c.path, status: 'added' });
      } else {
        changes.push({ path: c.path, status: c.status === 'untracked' ? 'added' : c.status });
      }
    }
    if (!changes.length) {
      removeRunWorktree(wtPath, workspaceRoot);      // clean: nothing to lose
      pruned++;
      continue;
    }
    // Orphan with real work: preserve it for review rather than delete.
    retainRun(runId, {
      runId, sessionId: runId, raceId: null, goal: null,
      groupId: null, role: null, isIntegrator: false, agent: null,
      worktreePath: wtPath, workspaceRoot, changes,
      metrics: { durationMs: 0, tokens: 0, dollars: 0, fileCount: changes.length },
      endedAt: new Date().toISOString(), recovered: true,
    });
    recovered++;
  }
  if (pruned || recovered) {
    try { console.log(`[autopilot] reconciled orphan worktrees: pruned ${pruned}, recovered ${recovered}`); } catch (_) {}
  }
}

// Parse an agent's own CUMULATIVE token counter out of raw PTY output
// (codex "1,234 tokens used", "total tokens: 56k"). Only explicit
// cumulative counters count. Context gauges ("152k/200k tokens") and
// per-turn stream counters ("↓ 1.5k tokens") are deliberately NOT
// matched: a context gauge reports the loaded window, not consumption,
// and does not belong in a usage meter.
function parseRunTokenStatus(text) {
  if (!text) return null;
  const toN = (raw, suffix) => {
    const n = parseFloat(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const mult = suffix && /m/i.test(suffix) ? 1_000_000 : (suffix && /k/i.test(suffix) ? 1000 : 1);
    return Math.floor(n * mult);
  };
  const used = text.match(/(\d[\d,.]*)\s*([kKmM]?)\s*tokens?\s+used\b/i);
  if (used) return toN(used[1], used[2]);
  const total = text.match(/total\s+tokens?\s*[:=]?\s*(\d[\d,.]*)\s*([kKmM]?)/i);
  if (total) return toN(total[1], total[2]);
  const usedColon = text.match(/tokens?\s+used\s*[:=]\s*(\d[\d,.]*)\s*([kKmM]?)/i);
  if (usedColon) return toN(usedColon[1], usedColon[2]);
  return null;
}

function parseRunModelStatus(text) {
  const src = String(text || '');
  let found = '';
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || !/(working|session:|plan:|context|reasoning|model)/i.test(line)) continue;
    let m = line.match(/\b(gpt-[0-9][A-Za-z0-9._-]*)\b/i);
    if (m) { found = m[1].toUpperCase(); continue; }
    m = line.match(/\bGPT[-\s]?([0-9](?:\.[0-9]+)?)(\s+mini)?\b/i);
    if (m) { found = `GPT-${m[1]}${m[2] ? ' mini' : ''}`; continue; }
    m = line.match(/\b(claude-(?:opus|sonnet|haiku|fable)[A-Za-z0-9._-]*)\b/i);
    if (m) { found = m[1]; continue; }
    m = line.match(/\bClaude\s+(Opus|Sonnet|Haiku|Fable)(?:\s+([0-9](?:\.[0-9]+)?))?\b/i);
    if (m) { found = `Claude ${m[1]}${m[2] ? ' ' + m[2] : ''}`; continue; }
    m = line.match(/\b(gemini-[A-Za-z0-9._-]*)\b/i);
    if (m) { found = m[1]; continue; }
    m = line.match(/\bGemini\s+([0-9](?:\.[0-9]+)?)(?:\s+([A-Za-z]+))?\b/i);
    if (m) { found = `Gemini ${m[1]}${m[2] ? ' ' + m[2] : ''}`; }
  }
  return found;
}

// Strip terminal escape sequences so token/sentinel scans see rendered text,
// not cursor movement and color commands.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '');
}

// Busy marker rendered by agent TUIs while generating or running a tool.
// Mirrors the renderer's detection; lives here because run PTYs have no
// renderer terminal and the idle watchdog below observes the run directly.
const AP_RUN_WORKING_RE = /esc to interrupt|\(\s*\d+\s*s\s*[·•.]|\bworking\b/i;
// Generous quiet windows: a run PTY can go byteless for a long stretch during
// a silent tool call (build, test suite) with a static busy marker on screen.
// Nudging too early types into the agent mid-tool; these thresholds only trip
// on runs that are genuinely parked.
const AP_RUN_NUDGE_PAUSE_MS = 45000;
const AP_RUN_IDLE_END_MS = 120000;
const AP_RUN_MAX_NUDGES = 5;
const AP_INTEGRATOR_MAX_NUDGES = 2;
const AP_INTEGRATOR_IDLE_END_MS = 60000;
const AP_RUN_STARTUP_STALL_MS = 180000;

// Agents sometimes paraphrase the completion sentinel ("Goal fully met",
// "audit complete", "Stopping.") instead of printing it verbatim. When the
// last narration reads as a completion claim and the agent has gone quiet,
// the run is treated as complete instead of nudged.
const AP_COMPLETION_CLAIM_RE = new RegExp(
  '\\b(goal (is )?(already )?(fully )?(met|achieved|complete)'
  + '|task (is )?(complete|finished|done)'
  + '|nothing (left|more) to do'
  + '|nothing (to (group|fix|report|change|commit)|remaining)'
  + '|no (open|remaining) (work|work items|markers|changes)'
  + '|work is (done|complete)'
  + '|report delivered'
  + '|deliverable is complete'
  + '|implementation (is )?complete'
  + '|audit complete'
  + '|fully done)\\b'
  + '|\\bstopping[.!]?\\s*$', 'i');
const AP_RUN_FEED_LINE_MAX = 300;

// ── Per-run activity source ─────────────────────────────────────────────────
// Each run streams its own activity to the renderer, keyed by runId. Primary
// source is the agent's session transcript (jsonl) written under the run's
// worktree project dir: clean structured narration (text + tool calls) plus
// authoritative token usage. Agents that write no transcript fall back to
// ANSI-stripped complete lines from the run's PTY, deduped per run, so the
// feed stays populated for any CLI.
// Project-dir name the agent CLI uses for a cwd's transcripts: every
// non-alphanumeric character becomes a dash, including dots in hidden
// directories. The same encoding is required to locate transcript tails.
function claudeProjectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function newestRunJsonl(r) {
  try {
    const encoded = claudeProjectDirName(r.worktreePath);
    const dir = path.join(CLAUDE_DIR, 'projects', encoded);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(dir, f);
        try { const st = fs.statSync(p); return { p, mtime: st.mtimeMs, size: st.size }; } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch (_) { return null; }
}

function pinRunTranscript(r, file, size) {
  r.transcriptPath = file;
  // If the PTY fallback already narrated the run's start, tail from EOF so
  // the transcript's replay of that same content is not emitted twice.
  r.transcriptOffset = r.ptyFallbackActive ? (size || 0) : 0;
  r.transcriptRemainder = '';
  r.transcriptStaleTicks = 0;
}

function findRunTranscript(r) {
  if (r.transcriptPath && fs.existsSync(r.transcriptPath)) return r.transcriptPath;
  // The worktree dir is unique to this run, so the newest file is its own.
  const newest = newestRunJsonl(r);
  if (newest) { pinRunTranscript(r, newest.p, newest.size); return r.transcriptPath; }
  return null;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

function hashToolInput(input) {
  const json = stableJson(input || {});
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

// Translate one transcript entry into structured feed items:
// {kind: 'thought'|'tool', text}. Assistant text is the agent's live
// narration (the dashboard's thinking stream); tool_use becomes a tool
// item and also updates the run's "current tool" state for the fleet
// strip. Token usage feeds the run's meter with the same figure the
// agent's own status line shows (context occupancy).
function runTranscriptEntryToLines(r, obj) {
  const lines = [];
  const msg = obj && obj.message;
  if (!msg || obj.type !== 'assistant') return lines;
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        // Keep the agent's latest narration: it becomes the run conclusion
        // shown in review, and it is the authoritative surface for the
        // completion sentinel (the PTY view wraps and decorates lines, so
        // exact-line matching there misses real finishes).
        const whole = part.text.trim();
        if (whole) {
          r.lastAssistantText = whole.slice(0, 4000);
          r.substantiveAt = Date.now();
          if (r.runId) redirectAutonomousQuestion(r.runId, whole);
        }
        if (!r.sentinelSeen && hasCompletionMarkerLine(part.text) && r.runId) {
          r.sentinelSeen = true;
          const rid = r.runId;
          setImmediate(() => finishRun(rid, { reason: 'agent_complete' }));
        }
        for (const ln of part.text.split('\n')) {
          const t = ln.trim();
          if (t.length > 2) lines.push({ kind: 'thought', text: t.slice(0, 320) });
        }
      } else if (part.type === 'tool_use' && part.name) {
        r.substantiveAt = Date.now();
        let detail = '';
        let actionHash = '';
        try {
          const inp = part.input || {};
          detail = String(inp.command || inp.file_path || inp.path || inp.pattern || inp.prompt || inp.description || '').slice(0, 140);
          actionHash = hashToolInput(inp);
        } catch (_) {}
        const toolText = `${part.name}${detail ? '  ' + detail : ''}`;
        r.lastToolText = toolText.slice(0, 180);
        r.lastToolAt = Date.now();
        // Feed the governor a stable action signature (tool + target) so it
        // can catch a genuine loop: the same tool on the same target four
        // times with no forward progress between them.
        try { r.runner.reportAction(`${part.name}:${actionHash || detail}`); } catch (_) {}
        lines.push({ kind: 'tool', text: `→ ${toolText}`.slice(0, 320) });
      }
    }
  }
  // Pin the meter's billing rate to the model that actually produced this
  // turn (transcript is ground truth; the start-time model may be a guess or
  // a tier alias). Cheap + idempotent, so feed it every turn.
  if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>'
      && r.runner && typeof r.runner.setModel === 'function') {
    try { r.runner.setModel(msg.model); } catch (_) {}
    r.observedModel = msg.model;
  }
  const usage = msg.usage;
  if (usage) {
    // Exact per-turn usage. Feed each tier separately so the meter bills it
    // precisely: fresh input + output at their rates, cache writes at 1.25x
    // input, cache reads at 0.1x input. Cache reads are billed (they cost a
    // tenth, not nothing) but excluded from the token cap basis inside the
    // meter, so a cap of "200k tokens" still means fresh work.
    const u = {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    };
    if ((u.input || u.output || u.cacheCreate || u.cacheRead) && r.runner && typeof r.runner.addUsage === 'function') {
      r.substantiveAt = Date.now();
      try { r.runner.addUsage(u); } catch (_) {}
    }
  }
  return lines;
}

function refreshRunCopilotStats(r) {
  if (!r || r.agent !== 'copilot') return;
  const now = Date.now();
  if (r._modelProbeAt && now - r._modelProbeAt < 5000) return;
  r._modelProbeAt = now;
  const stats = readCopilotSessionStats(r.worktreePath);
  if (!stats) return;
  r.tokensPartial = !!stats.partialTokens;
  if (stats.model) {
    r.observedModel = stats.model;
    try { if (r.runner && typeof r.runner.setModel === 'function') r.runner.setModel(stats.model); } catch (_) {}
  }
  if (!r.runner) return;
  const prev = r._copilotUsage || {};
  const delta = (key) => {
    const next = Number(stats[key]) || 0;
    const old = Number(prev[key]) || 0;
    return next > old ? next - old : 0;
  };
  const outputDelta = delta('outputTokens') + delta('reasoningTokens');
  const cacheCreateDelta = delta('cacheWriteTokens');
  const cacheReadDelta = delta('cacheReadTokens');
  if (outputDelta || cacheCreateDelta || cacheReadDelta) {
    r.substantiveAt = Date.now();
    try {
      r.runner.addUsage({
        output: outputDelta,
        cacheCreate: cacheCreateDelta,
        cacheRead: cacheReadDelta,
      });
    } catch (_) {}
  }
  r._copilotUsage = {
    outputTokens: Number(stats.outputTokens) || 0,
    reasoningTokens: Number(stats.reasoningTokens) || 0,
    cacheWriteTokens: Number(stats.cacheWriteTokens) || 0,
    cacheReadTokens: Number(stats.cacheReadTokens) || 0,
  };
  const reported = Math.max(
    Number(stats.currentTokens) || 0,
    (Number(stats.outputTokens) || 0)
      + (Number(stats.reasoningTokens) || 0)
      + (Number(stats.cacheWriteTokens) || 0),
  );
  if (reported > 0) {
    try { r.runner.setReportedTokens(reported); } catch (_) {}
  }
}

function statusSummaryLine(state) {
  const pct = Number.isFinite(state.progress) ? ` ${state.progress}%` : '';
  const step = state.currentStep || state.summary || '';
  return `Status ${state.status}${pct}${step ? ': ' + step : ''}`;
}

function pollRunStatusFile(runId) {
  const r = runs.get(runId);
  if (!r || !r.worktreePath || r.finishing) return;
  const res = AutopilotStatus.readStatus(r.worktreePath);
  if (!res.ok) return;
  if (res.signature && res.signature === r.statusFileSignature) return;
  r.statusFileSignature = res.signature;
  r.structuredStatus = res.state;
  r.substantiveAt = Date.now();
  r.lastFeedAt = Date.now();
  r.lastAssistantText = res.state.summary || res.state.currentStep || r.lastAssistantText || '';
  if (res.state.currentStep) {
    r.lastToolText = res.state.currentStep.slice(0, 180);
    r.lastToolAt = Date.now();
  }
  try {
    r.runner.recordEvent({
      kind: 'run_status',
      ts: new Date().toISOString(),
      payload: res.state,
    });
  } catch (_) {}
  if (mainWindow) {
    const lines = [statusSummaryLine(res.state)];
    if (res.state.blockers.length) lines.push(`Blockers: ${res.state.blockers.join('; ')}`.slice(0, 360));
    if (res.state.verification.passed === true && res.state.verification.commands.length) {
      lines.push(`Verified: ${res.state.verification.commands.join('; ')}`.slice(0, 360));
    }
    mainWindow.webContents.send('autopilot:activity', {
      runId,
      lines,
      items: lines.map((text) => ({ kind: 'status', text })),
      at: Date.now(),
    });
  }
  if (r.statusTerminalSeen) return;
  if (res.state.status === 'complete') {
    r.statusTerminalSeen = true;
    const reason = res.state.verification.passed === true ? 'agent_complete' : 'agent_unverified';
    setImmediate(() => finishRun(runId, { reason }));
  } else if (res.state.status === 'blocked' || res.state.status === 'failed') {
    r.statusTerminalSeen = true;
    setImmediate(() => finishRun(runId, {
      reason: res.state.status === 'blocked' ? 'agent_blocked' : 'agent_failed',
      status: res.state,
    }));
  }
}

// Read transcript bytes appended since the last tick and stream new feed
// lines to the renderer. Returns true when the transcript produced activity
// this tick (used by the idle watchdog as "the agent moved").
function tailRunTranscript(runId) {
  const r = runs.get(runId);
  if (!r) return false;
  const file = findRunTranscript(r);
  if (!file) return false;
  // One handle serves both the size check and the read, so the size can
  // never describe a different file than the bytes that follow.
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return false; }
  let chunk = '';
  try {
    let sz = 0;
    try { sz = fs.fstatSync(fd).size; } catch (_) { return false; }
    if (sz < (r.transcriptOffset || 0)) {
      // The pinned file shrank in place (rewritten/compacted). Resume from
      // its new end rather than replaying rewritten history into the feed.
      r.transcriptOffset = sz;
      r.transcriptRemainder = '';
      return false;
    }
    if (sz === (r.transcriptOffset || 0)) {
      // Rotation guard: the agent starts a fresh jsonl on compaction/clear.
      // A pinned file that stops growing while a newer sibling exists would
      // silently kill the feed mid-run; re-pin to the newer file. Token
      // reporting stays monotonic (maxReportedTokens only ever increases).
      r.transcriptStaleTicks = (r.transcriptStaleTicks || 0) + 1;
      if (r.transcriptStaleTicks >= 10) {
        const newest = newestRunJsonl(r);
        if (newest && newest.p !== r.transcriptPath) pinRunTranscript(r, newest.p, 0);
        else r.transcriptStaleTicks = 0;
      }
      return false;
    }
    r.transcriptStaleTicks = 0;
    try {
      const len = sz - (r.transcriptOffset || 0);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, r.transcriptOffset || 0);
      chunk = buf.toString('utf8');
    } catch (_) { return false; }
    r.transcriptOffset = sz;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
  const data = (r.transcriptRemainder || '') + chunk;
  const parts = data.split('\n');
  r.transcriptRemainder = parts.pop() || '';
  const lines = [];
  for (const rawLine of parts) {
    if (!rawLine.trim()) continue;
    try {
      const obj = JSON.parse(rawLine);
      lines.push(...runTranscriptEntryToLines(r, obj));
    } catch (_) {}
  }
  if (lines.length) {
    r.feedEverStreamed = true;
    r.lastFeedAt = Date.now();
    const capped = lines.slice(0, AP_RUN_FEED_LINE_MAX);
    if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
      runId,
      lines: capped.map((it) => it.text),
      items: capped,
      at: Date.now(),
    });
  }
  return lines.length > 0;
}

// Fallback feed for agents that write no transcript: complete ANSI-stripped
// lines from the run's PTY, deduped per run. Skipped once a transcript is
// streaming (the structured source reads far cleaner than TUI repaints).
function streamRunPtyLines(runId, clean) {
  const r = runs.get(runId);
  if (!r || r.transcriptPath) return;
  // Grace window: give the structured transcript a chance to appear before
  // narrating raw PTY lines, so the two sources never overlap. Only agents
  // that write no transcript at all fall through to this path.
  if (Date.now() - (r.spawnedAt || 0) < 8000) return;
  r.ptyFallbackActive = true;
  if (!r.ptySeenLines) { r.ptySeenLines = new Set(); r.ptySeenOrder = []; }
  const out = [];
  for (const rawLine of clean.split('\n')) {
    const t = rawLine.replace(/\r/g, '').trim();
    if (t.length < 3) continue;
    const norm = t.replace(/^[^A-Za-z0-9]+/, '').toLowerCase();
    if (!norm || r.ptySeenLines.has(norm)) continue;
    r.ptySeenLines.add(norm);
    r.ptySeenOrder.push(norm);
    while (r.ptySeenOrder.length > 400) r.ptySeenLines.delete(r.ptySeenOrder.shift());
    out.push(t.slice(0, 320));
  }
  if (out.length) {
    r.feedEverStreamed = true;
    r.lastFeedAt = Date.now();
    // Parity with transcript agents: keep the latest narrative-looking
    // line as the run's last words, so completion-claim detection and
    // the end-of-run final report work for every CLI, not only the
    // ones that write a structured transcript.
    for (let i = out.length - 1; i >= 0; i--) {
      const t = out[i];
      if (t.length >= 24 && !/^[→>$#]/.test(t)) {
        r.lastAssistantText = t.slice(0, 4000);
        if (!/^loading\b/i.test(t)) r.substantiveAt = Date.now();
        if (!AutopilotQuestion.isPermissionPrompt(t)) redirectAutonomousQuestion(runId, t);
        break;
      }
    }
    const capped = out.slice(0, AP_RUN_FEED_LINE_MAX);
    if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
      runId,
      lines: capped,
      items: capped.map((t) => ({ kind: 'output', text: t })),
      at: Date.now(),
    });
  }
}

// Submission verifier: the injected goal's trailing Enter can be consumed by
// a still-mounting TUI, leaving the goal sitting unsubmitted in the composer
// (proven by transcript forensics: submitted messages were goal+nudge
// concatenations). The agent writes its session transcript only after a real
// submit, so transcript presence IS the submit signal; until it appears,
// resend a bare Enter every few seconds. Idempotent: the text already sits in
// the composer, an extra Enter on an empty composer is a no-op. Capped so
// agents that never write transcripts get at most a few harmless keypresses.
function ensureRunGoalSubmitted(runId) {
  const r = runs.get(runId);
  if (!r || r.goalSubmitted || !r.goalInjectedAt) return;
  // Submit-proof: a NON-EMPTY transcript. The user message row is written at
  // submit time, so bytes in the file mean the goal went through; a merely
  // pre-created empty file must keep the resend loop alive.
  if (r.transcriptPath) {
    let sz = 0;
    try { sz = fs.statSync(r.transcriptPath).size; } catch (_) {}
    if (sz > 0) { r.goalSubmitted = true; return; }
  }
  const now = Date.now();
  if (now - r.goalInjectedAt < 5000) return;
  if ((r.injectResends || 0) >= 5) return;
  if (now - (r.lastResendAt || 0) < 5000) return;
  r.lastResendAt = now;
  r.injectResends = (r.injectResends || 0) + 1;
  try { if (r.pty) r.pty.write('\r'); } catch (_) {}
}

// Coarse live state for the dashboard fleet strip, derived from signals the
// watchdog already tracks. Order matters: done > starting > tool > working
// > quiet.
function runLiveState(r) {
  const now = Date.now();
  const structured = r.structuredStatus && r.structuredStatus.status;
  if (structured === 'complete') return 'done';
  if (structured === 'blocked' || structured === 'failed') return 'blocked';
  if (structured === 'running' && r.structuredStatus.currentStep) return 'working';
  if (r.sentinelSeen) return 'done';
  if (!r.goalSubmitted && !r.feedEverStreamed) return 'starting';
  if (r.lastToolAt && now - r.lastToolAt < 8000) return 'tool';
  if (now - (r.lastPtyDataAt || 0) < 6000) return 'working';
  const workGoneMs = r.workingSeenAt ? now - r.workingSeenAt : Infinity;
  if (workGoneMs < 6000) return 'working';
  return 'quiet';
}

// Idle watchdog, per run, observing the run's own PTY and transcript,
// never a chat terminal: a focused-terminal proxy can suppress nudges or
// end a healthy run. While the busy marker is on screen
// the agent is working. Once it has worked and gone quiet without printing
// the completion sentinel, nudge it to continue; after the nudges are spent
// and it stays quiet, end the run as idle.
function runIdleWatchdog(runId) {
  const r = runs.get(runId);
  if (!r || r.finishing || r.sentinelSeen) return;
  const now = Date.now();
  if (!r.substantiveAt && now - (r.spawnedAt || now) >= AP_RUN_STARTUP_STALL_MS) {
    if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
      runId,
      lines: ['Agent stayed at startup without producing work; ending the run.'],
      at: now,
    });
    try { r.runner.halt('stall', { signal: 'startup', reason: 'no model activity after startup' }); } catch (_) {}
    finishRun(runId, { reason: 'agent_startup_stall' });
    return;
  }
  if (!r.feedEverStreamed) return;
  const quietMs = now - (r.lastFeedAt || now);
  // CLI-neutral working signal: any PTY bytes in the last few seconds mean
  // the agent is alive (spinners, tool output, repaints), regardless of
  // whether its busy marker matches the known regex. The regex is a
  // stronger, earlier signal on top, never the sole gate.
  if (now - (r.lastPtyDataAt || 0) < 6000) return;
  const workGoneMs = r.workingSeenAt ? now - r.workingSeenAt : Infinity;
  if (workGoneMs < 6000) return;
  // Completion claim: the agent said it's done in plain words and went
  // quiet. Finish as complete; nudging a finished agent only makes it
  // re-declare completion in a loop.
  // Only the tail of the last message counts: "task done, moving on to X"
  // mid-message is progress narration, not a completion claim.
  if (quietMs >= AP_RUN_NUDGE_PAUSE_MS && r.lastAssistantText
      && AP_COMPLETION_CLAIM_RE.test(r.lastAssistantText.slice(-400))) {
    if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
      runId,
      lines: ['Agent declared the goal complete and went quiet; ending the run as finished.'],
      at: now,
    });
    finishRun(runId, { reason: 'agent_complete' });
    return;
  }
  const maxNudges = r.isIntegrator ? AP_INTEGRATOR_MAX_NUDGES : AP_RUN_MAX_NUDGES;
  const idleEndMs = r.isIntegrator ? AP_INTEGRATOR_IDLE_END_MS : AP_RUN_IDLE_END_MS;
  if (quietMs >= AP_RUN_NUDGE_PAUSE_MS && (r.nudgeCount || 0) < maxNudges) {
    r.nudgeCount = (r.nudgeCount || 0) + 1;
    r.lastFeedAt = now;
    if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
      runId,
      lines: [`Agent paused without finishing; nudging to continue autonomously (${r.nudgeCount}/${maxNudges}).`],
      at: now,
    });
    injectGoalToRunPty(runId, 'Continue working toward the goal autonomously. Decide for yourself; do not wait for input. Print the completion marker when fully done.');
  } else if (quietMs >= idleEndMs && (r.nudgeCount || 0) >= maxNudges) {
    if (mainWindow) mainWindow.webContents.send('autopilot:activity', { runId, lines: ['Agent stayed idle after nudges; ending the run.'], at: now });
    finishRun(runId, { reason: 'agent_idle' });
  }
}

// Per-run output flush: buffer this run's PTY bytes and, once per
// quarter-second, append one agent_output audit row (size + timestamp only,
// not fed to the budget meter) and re-broadcast the run's budget state so its
// rings stay live. Char counts are audit-only: the chars/4 estimate is wildly
// wrong for TUI agents (cursor escapes, color codes, in-place repaints), so
// authoritative token counts come from the agent's own status line, parsed
// here from the run's raw output (per-run PTYs have no renderer terminal).
function flushRunOutput(runId) {
  const r = runs.get(runId);
  if (!r) return;
  r.flushTimer = null;
  const chunk = r.outputBuf;
  r.outputBuf = '';
  if (!chunk) return;
  try {
    r.runner.recordEvent({
      kind: 'agent_output',
      ts: new Date().toISOString(),
      payload: { chars: chunk.length },
    });
  } catch (_) {}
  if (mainWindow) mainWindow.webContents.send('autopilot:budget', {
    runId,
    ...r.runner.budgetState(),
    governor: (typeof r.runner.governorState === 'function') ? r.runner.governorState() : null,
  });
  // Submit-proof for agents without a transcript: the composer echo of an
  // injected goal accounts for roughly its own length in PTY bytes, so
  // sustained output well past that means the agent is answering and the
  // Enter-resend loop must stop. Transcript agents get the stronger
  // non-empty-transcript proof in ensureRunGoalSubmitted.
  if (!r.goalSubmitted && r.goalInjectedAt) {
    r.bytesSinceInject = (r.bytesSinceInject || 0) + chunk.length;
    if (r.bytesSinceInject > (r.injectTextLen || 0) + 8000) r.goalSubmitted = true;
  }
  const clean = stripAnsi(chunk);
  r.permissionPromptTail = ((r.permissionPromptTail || '') + '\n' + clean).slice(-4000);
  handlePermissionPrompt(runId, r.permissionPromptTail);
  const statusModel = parseRunModelStatus(clean);
  if (statusModel) {
    r.observedModel = statusModel;
    try { r.runner.setModel(statusModel); } catch (_) {}
  }
  // Busy-marker tracking for the idle watchdog: the marker on screen means
  // the agent is mid-generation or mid-tool, so nudges must hold off.
  if (AP_RUN_WORKING_RE.test(clean)) r.workingSeenAt = Date.now();
  // Feed fallback for agents without a transcript (no-op once one exists).
  streamRunPtyLines(runId, clean);
  // Token meter fallback for agents without a structured transcript:
  // scan for the agent's own cumulative counter and keep the running
  // max (the meter is monotonic; status lines flicker). Once a
  // transcript streams, its exact per-turn deltas are authoritative
  // and the PTY scan stops.
  if (!r.transcriptPath) {
    let maxTok = -1;
    for (const line of clean.split('\n')) {
      const parsed = parseRunTokenStatus(line);
      if (parsed != null && parsed > maxTok) maxTok = parsed;
    }
    if (maxTok >= 0 && maxTok > (r.maxReportedTokens || 0)) {
      // Poison guard: this scans the agent's whole output, not a trusted
      // status-line region, so a line the agent PRINTS (editing a tokenizer,
      // cat-ing a benchmark log, echoing a cost report) can carry a huge
      // number. Because setReportedTokens is monotonic, one poisoned reading
      // would latch forever and SIGINT a healthy run on a fake budget cap.
      // Reject an implausible absolute value or a jump too large to be one
      // run's real growth; the true counter climbs smoothly and re-registers
      // on the next flush.
      const prev = r.maxReportedTokens || 0;
      const ABS_CEIL = 50_000_000;              // no real single-run cumulative reaches this
      const plausible = maxTok <= ABS_CEIL
        && (prev === 0 ? maxTok <= 2_000_000     // first sighting: a sane context ceiling
                       : maxTok <= prev * 8 + 1_000_000); // later: generous but bounded growth
      if (plausible) {
        r.maxReportedTokens = maxTok;
        try { r.runner.setReportedTokens(maxTok); } catch (_) {}
      }
    }
  }
  // Detect the completion sentinel that the agent prints when it's fully done.
  // Per-run PTYs live in the main process and have no renderer-side terminal,
  // so scan here instead of in the renderer.
  if (!r.sentinelSeen && hasCompletionMarkerLine(clean)) {
    // Ignore the echo window right after an injection: the pasted directive
    // itself quotes the marker.
    const recentlyInjected = Date.now() - (r.lastInjectAt || 0) < 10000;
    if (!recentlyInjected) {
      r.sentinelSeen = true;
      setImmediate(() => finishRun(runId, { reason: 'agent_complete' }));
    }
  }
}

// Spawn the dedicated agent PTY for a run inside its worktree. Mirrors the
// chat-PTY env setup (PATH augmentation, CLAUDE_DIR, HUSK_HOST) but wires the
// data/exit handlers to this run's buffer and lifecycle instead of the chat
// session's.
function spawnRunPty(runId, cwd) {
  const r = runs.get(runId);
  if (!r) return;
  const rawCmd = (r.agentCommandOverride || config.agentCommand || 'claude').trim();
  const userTokens = rawCmd.split(/\s+/).filter(Boolean);
  let agentExe = userTokens.shift() || 'claude';
  let agentArgs = withAutopilotArgs(agentExe, userTokens);
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLAUDE_DIR,
    HUSK_HOST: '1',
  });
  const bunBin = path.join(HOME, '.bun', 'bin');
  if (env.PATH && !env.PATH.includes(bunBin)) env.PATH = `${bunBin}:${env.PATH}`;
  const localBin = path.join(HOME, '.local', 'bin');
  if (env.PATH && !env.PATH.includes(localBin)) env.PATH = `${localBin}:${env.PATH}`;
  agentExe = resolveAgentExe(agentExe, env.PATH);
  const runPty = pty.spawn(agentExe, agentArgs, {
    name: 'xterm-256color', cols: 120, rows: 30,
    cwd,
    env,
  });
  r.pty = runPty;
  r._dataDisposable = runPty.onData((data) => {
    const rs = runs.get(runId);
    if (!rs) return;
    rs.lastPtyDataAt = Date.now();
    rs.outputBuf += data;
    if (!rs.flushTimer) {
      rs.flushTimer = setTimeout(() => flushRunOutput(runId), AUT_OUTPUT_FLUSH_MS);
    }
  });
  r._exitDisposable = runPty.onExit((ev) => {
    const rs = runs.get(runId);
    if (rs && !rs.finishing) {
      // Preserve the agent's exit code. A run "dying" unexpectedly (e.g. the
      // moment a second agent is launched in a chat tab) shows up here; the
      // code distinguishes a clean quit (0) from a crash (non-zero) so the
      // audit trail names WHY the agent left, not just that it did.
      const exitCode = ev && typeof ev.exitCode === 'number' ? ev.exitCode : null;
      const signal = ev && typeof ev.signal === 'number' ? ev.signal : null;
      if (mainWindow) mainWindow.webContents.send('autopilot:halt', { runId, reason: 'agent-exited', exitCode, signal });
      finishRun(runId, { reason: 'agent-exited', exitCode, signal });
    }
    try { if (r._dataDisposable) r._dataDisposable.dispose(); } catch (_) {}
    try { if (r._exitDisposable) r._exitDisposable.dispose(); } catch (_) {}
  });
}

// Deliver a goal/nudge into a run's PTY. claude needs a bracketed-paste block
// then a separate Enter (raw keystrokes hit its TUI hotkeys); other agents
// take the text directly then Enter to submit.
function injectGoalToRunPty(runId, text) {
  const r = runs.get(runId);
  if (!r || !r.pty) return false;
  try {
    // The injected text itself contains the completion sentinel (the
    // directive tells the agent to print it), and the TUI echoes pasted
    // text. Timestamp the injection so the PTY sentinel scan can ignore
    // the echo window.
    r.lastInjectAt = Date.now();
    const body = String(text).replace(/\r/g, ' ').replace(/\n/g, ' ');
    // Submit-proof bookkeeping for agents without a transcript: output
    // volume well beyond the composer echo of this text means the agent
    // is answering (see flushRunOutput).
    r.injectTextLen = body.length;
    r.bytesSinceInject = 0;
    const agentKind = (config.agentCommand || 'claude').trim().split(/\s+/)[0]
      .split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
    if (agentKind === 'claude') {
      r.pty.write('\x1b[200~' + body + '\x1b[201~');
      setTimeout(() => { try { if (r.pty) r.pty.write('\r'); } catch (_) {} }, 120);
    } else {
      r.pty.write(body);
      setTimeout(() => { try { if (r.pty) r.pty.write('\r'); } catch (_) {} }, 150);
    }
    return true;
  } catch (_) { return false; }
}

function redirectAutonomousQuestion(runId, text) {
  const r = runs.get(runId);
  if (!r || r.finishing) return false;
  if (!AutopilotQuestion.isAutonomousQuestion(text)) return false;
  const now = Date.now();
  if ((r.questionRedirects || 0) >= 3) return false;
  if (now - (r.lastQuestionRedirectAt || 0) < 8000) return false;
  r.questionRedirects = (r.questionRedirects || 0) + 1;
  r.lastQuestionRedirectAt = now;
  r.lastFeedAt = now;
  r.lastToolText = 'Answered autonomous prompt with a safe default';
  r.lastToolAt = now;
  const ok = injectGoalToRunPty(runId, AutopilotQuestion.buildQuestionRedirect());
  if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
    runId,
    lines: [`Agent asked for input; continuing autonomously (${r.questionRedirects}/3).`],
    items: [{ kind: 'status', text: `Agent asked for input; continuing autonomously (${r.questionRedirects}/3).` }],
    at: now,
  });
  return ok;
}

function handlePermissionPrompt(runId, text) {
  const r = runs.get(runId);
  if (!r || r.finishing || !AutopilotQuestion.isPermissionPrompt(text)) return false;
  const now = Date.now();
  if (now - (r.lastPermissionPromptAt || 0) < 5000) return false;
  r.lastPermissionPromptAt = now;
  r.permissionPromptResponses = (r.permissionPromptResponses || 0) + 1;
  const choice = AutopilotQuestion.permissionPromptChoice(text);
  try { if (r.pty) r.pty.write(choice + '\r'); } catch (_) {}
  r.lastFeedAt = now;
  r.lastToolText = 'Approved agent tool prompt';
  r.lastToolAt = now;
  if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
    runId,
    lines: ['Approved an agent tool prompt automatically.'],
    items: [{ kind: 'status', text: 'Approved an agent tool prompt automatically.' }],
    at: now,
  });
  return true;
}

// Interrupt the current agent turn in a run's PTY (SIGINT). Does not kill the
// PTY: the agent stays at its prompt.
function sigintRunPty(runId) {
  const r = runs.get(runId);
  if (!r || !r.pty) return;
  try { r.pty.write('\x03'); } catch (_) {}
}

// Resolve once a run's freshly-spawned PTY looks ready for input: it has
// emitted output then gone quiet for a short settle window, or maxMs elapsed.
// Pasting before the TUI input mounts silently drops the goal.
function whenRunPtyReady(runId, maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const settleMs = 350;
    const minWaitMs = Math.min(250, maxMs);
    let lastDataAt = start;
    const r = runs.get(runId);
    if (!r || !r.pty) return resolve('no-pty');
    // Track last data time via a temporary listener
    const tmpDisposable = r.pty.onData(() => { lastDataAt = Date.now(); });
    const check = () => {
      const now = Date.now();
      if (now - start >= maxMs) { try { tmpDisposable.dispose(); } catch (_) {} return resolve('timeout'); }
      const sawOutput = lastDataAt >= start - 50;
      const quietFor = now - lastDataAt;
      if (sawOutput && quietFor >= settleMs && (now - start) >= minWaitMs) {
        try { tmpDisposable.dispose(); } catch (_) {}
        return resolve('ready');
      }
      setTimeout(check, 80);
    };
    setTimeout(check, minWaitMs);
  });
}

function activeAutopilotRunCount() {
  return [...runs.values()].filter((r) => !r.finishing).length;
}

let drainingPendingRuns = false;

// After a run frees a slot (finish/cancel), start queued runs while capacity is
// available. A failed queued start must not strand every item behind it.
function drainPendingRun() {
  if (drainingPendingRuns) return;
  drainingPendingRuns = true;
  const pump = () => {
    if (!pendingRuns.length) { drainingPendingRuns = false; return; }
    const maxConcurrent = config.autopilotMaxConcurrent || AP_MAX_CONCURRENT;
    if (activeAutopilotRunCount() >= maxConcurrent) { drainingPendingRuns = false; return; }
    const next = pendingRuns.shift();
    if (!next) { drainingPendingRuns = false; return; }
    // A queued run that fails to start must still be accounted to its collab
    // group, or the team's remaining-counter stalls and the integrator never
    // spawns (the whole team would hang with no error surfaced).
    doStartRun(next.runId, next.payload, next.workspaceRoot)
      .then((res) => {
        if (!res || !res.ok) noteCollabStartFailure(next.payload, (res && res.error) || 'failed to start');
        pump();
      })
      .catch((err) => {
        noteCollabStartFailure(next.payload, (err && err.message) || 'failed to start');
        pump();
      });
  };
  pump();
}

// Printed by the agent (per the autopilot directive) when the goal is fully
// done. The renderer watches for this exact marker on its own line so a real
// finish is detected positively, instead of guessing from terminal idle.
const AUTOPILOT_COMPLETE_SENTINEL = '<<HUSK_AUTOPILOT_COMPLETE>>';
// Agents paraphrase the marker (AUTOPILOT_TASK_COMPLETE etc.), so match the
// whole family on a bare line, not the exact literal.
const AP_COMPLETE_BARE_LINE_RE = /^[^A-Za-z0-9]*(?:HUSK_)?AUTOPILOT_(?:TASK_)?COMPLETE[^A-Za-z0-9]*$/i;
function hasCompletionMarkerLine(text) {
  return String(text || '').split('\n').some((l) => AP_COMPLETE_BARE_LINE_RE.test(l.replace(/\r/g, '').trim()));
}

// Wrap a user goal in an autonomous-operator preamble. An autopilot run is
// unattended: the agent must make its own decisions and never block on input.
// Without this the agent behaves like an interactive session, asks a
// clarifying question (e.g. "which tech stack?"), and stalls, which the
// watchdog then reads as a finished run.
function buildAutopilotGoal(goal) {
  return [
    '[AUTONOMOUS MODE] You are running unattended. No human is available to answer questions.',
    'Operate fully autonomously from start to finish:',
    '1. NEVER ask the user questions and never wait for input, confirmation, or approval. There is nobody to respond; assume a sensible "yes" and continue.',
    '2. Make every decision yourself (tech stack, architecture, libraries, file layout, naming). When a choice is ambiguous, pick the most sensible mainstream default, state the assumption in one line, and proceed immediately.',
    '3. Do not hand back a plan and stop. Plan if useful, then implement every part end to end.',
    '4. Keep working continuously until the goal is fully achieved and verified.',
    '5. Maintain a JSON status file at the workspace root named ' + AutopilotStatus.STATUS_FILE + '.',
    '   Schema: {"status":"running|blocked|complete|failed","progress":0-100,"currentStep":"...","summary":"...","blockers":[],"files":[],"verification":{"passed":true|false,"commands":[],"notes":"..."}}.',
    '   Update it before work starts, after meaningful progress, and at the end.',
    '   Use "complete" only after verifying the original goal. Use "blocked" or "failed" when you cannot finish autonomously.',
    '6. ONLY when the goal is completely finished, print this exact marker alone on its own line: ' + AUTOPILOT_COMPLETE_SENTINEL,
    '',
    'GOAL: ' + String(goal),
  ].join('\n');
}

ipcMain.handle('autopilot:start', async (_e, payload = {}) => {
  const activeProj = Array.isArray(config.projects) && config.activeProjectId
    ? config.projects.find((p) => p && p.id === config.activeProjectId)
    : null;
  if (!activeProj || !activeProj.path) {
    return { ok: false, error: 'pick an active project first; autopilot runs inside a project' };
  }
  const workspaceRoot = activeProj.path;
  if (!fs.existsSync(workspaceRoot)) return { ok: false, error: 'active project path no longer exists' };
  if (path.resolve(workspaceRoot) === path.resolve(HOME)) {
    return { ok: false, error: 'autopilot refuses to snapshot the entire home folder' };
  }
  const runId = 'ap-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  // Downgrade a clearly mechanical solo task to the cheap model to save money;
  // leave reasoning tasks on the user's chosen model. Emit the decision to the
  // run log so the user sees which model was chosen and why.
  {
    const base = config.agentCommand || 'claude';
    const baseName = agentBaseName(base);
    const tier = classifyTier(payload.goal || '');
    const routed = !!(config.modelRouting && Object.keys(config.modelRouting).length);
    let model = `${baseName} (default)`;
    if (tier === 'cheap') {
      const modelArgs = modelArgsFor(baseName, 'cheap', config.modelRouting || {});
      if (modelArgs.length) { payload.agentCommand = `${base} ${modelArgs.join(' ')}`; model = modelArgs[modelArgs.length - 1]; }
    }
    if (mainWindow) mainWindow.webContents.send('autopilot:orchestrator', {
      runId, tier, model, autoSelected: !routed,
      reason: tier === 'cheap'
        ? `Task looks mechanical, spawning ${model} to save cost`
        : `Task needs reasoning, using ${model}`,
    });
  }
  const maxConcurrent = config.autopilotMaxConcurrent || AP_MAX_CONCURRENT;
  const activeCount = [...runs.values()].filter((r) => !r.finishing).length;
  if (activeCount >= maxConcurrent) {
    pendingRuns.push({ runId, payload, workspaceRoot });
    return { ok: true, runId, queued: true };
  }
  return doStartRun(runId, payload, workspaceRoot);
});

// ── Collab mode ─────────────────────────────────────────────────────────────
// One orchestrator call decomposes the goal into 2..K sub-goals (the planner
// decides the team size, not the user), each sub-goal becomes a normal
// isolated run labeled with its role, and when the last worker finishes an
// integrator run merges every worker worktree into its own, which becomes the
// single Apply target. The only dedicated state is this tracker; everything
// else rides the existing run model exactly like raceId does.
const collabGroups = new Map(); // groupId -> { goal, caps, snapshot, workspaceRoot, remaining, workers, integratorSpawned }
// Set while the collab orchestrator is planning (before any worker run
// exists), so Stop can cancel that phase instead of reporting no active run.
let activePlanning = null;

function newRunId() {
  return 'ap-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

ipcMain.handle('autopilot:startCollab', async (_e, payload = {}) => {
  // Any throw here must land as a visible error in the renderer, never a
  // rejected invoke that a UI path might swallow.
  try {
    return await startCollabTeam(payload);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

async function startCollabTeam(payload = {}) {
  const activeProj = Array.isArray(config.projects) && config.activeProjectId
    ? config.projects.find((p) => p && p.id === config.activeProjectId)
    : null;
  if (!activeProj || !activeProj.path) {
    return { ok: false, error: 'pick an active project first; autopilot runs inside a project' };
  }
  const workspaceRoot = activeProj.path;
  if (!fs.existsSync(workspaceRoot)) return { ok: false, error: 'active project path no longer exists' };
  if (path.resolve(workspaceRoot) === path.resolve(HOME)) {
    return { ok: false, error: 'autopilot refuses to snapshot the entire home folder' };
  }
  const goal = String(payload.goal || '').trim().slice(0, 4096);
  if (!goal) return { ok: false, error: 'a goal is required' };
  const maxConcurrent = config.autopilotMaxConcurrent || AP_MAX_CONCURRENT;
  if (maxConcurrent < 2) {
    return { ok: false, error: 'team mode needs at least 2 concurrent Autopilot slots; raise the Autopilot concurrency limit or start a solo run' };
  }
  // The planner runs as a detached child with no entry in `runs`, so make the
  // planning phase cancellable: track the child and let autopilot:cancel kill
  // it, otherwise Stop reports "no active run" for the 1-2 min plan window.
  let planChild = null;
  let planCancelled = false;
  activePlanning = { cancel: () => { planCancelled = true; try { planChild && planChild.kill('SIGKILL'); } catch (_) {} } };
  const plan = await Orchestrator.planCollab({
    goal,
    agentCommand: config.agentCommand || 'claude',
    cwd: workspaceRoot,
    maxAgents: Math.min(4, maxConcurrent),
    env: buildAgentEnv(),
    onChild: (c) => { planChild = c; if (planCancelled) { try { c.kill('SIGKILL'); } catch (_) {} } },
  });
  activePlanning = null;
  if (planCancelled) return { ok: false, error: 'planning cancelled' };
  if (!plan.ok) return { ok: false, error: `orchestrator: ${plan.error}` };
  const groupId = 'collab-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  // Resolve the model each agent will run on and attach a human-readable
  // reason, so the run log can explain every orchestrator decision.
  const routed = !!(config.modelRouting && Object.keys(config.modelRouting).length);
  const baseName0 = agentBaseName(config.agentCommand || 'claude');
  for (const a of plan.agents) {
    const args = modelArgsFor(baseName0, a.tier, config.modelRouting || {});
    a.model = args.length ? args[args.length - 1] : `${baseName0} (default)`;
    a.autoSelected = !routed;
    a.reason = a.tier === 'cheap'
      ? `looks mechanical, ${args.length ? 'spawning ' + a.model : 'using the default model'}`
      : `needs reasoning, using ${a.model}`;
  }
  if (mainWindow) {
    mainWindow.webContents.send('autopilot:collab-plan', { groupId, goal, agents: plan.agents });
    if (plan.warning) mainWindow.webContents.send('autopilot:collab-plan', { groupId, note: plan.warning, warning: true });
  }
  const fleetStartedAt = Date.now();
  collabGroups.set(groupId, {
    goal, caps: payload.caps, snapshot: payload.snapshot, workspaceRoot,
    startedAt: fleetStartedAt, remaining: plan.agents.length, workers: [], integratorSpawned: false,
  });
  const started = [];
  for (let i = 0; i < plan.agents.length; i++) {
    const a = plan.agents[i];
    const injectGoal = [
      `[COLLAB TEAM] You are the "${a.role}" agent, one of ${plan.agents.length} agents working in parallel on a shared goal, each in an isolated copy of the repository.`,
      `Shared goal: ${goal}`,
      `Your slice: ${a.subgoal}`,
      'Work ONLY your slice; teammates own everything else. Deliver your slice completely.',
    ].join(' ');
    const baseCmd = config.agentCommand || 'claude';
    const modelArgs = modelArgsFor(agentBaseName(baseCmd), a.tier, config.modelRouting || {});
    const workerCmd = modelArgs.length ? `${baseCmd} ${modelArgs.join(' ')}` : baseCmd;
    const p = { goal: a.subgoal, originalGoal: goal, fleetStartedAt, injectGoal, caps: payload.caps, snapshot: payload.snapshot, groupId, role: a.role, agentCommand: workerCmd, tier: a.tier };
    const runId = newRunId();
    const activeCount = [...runs.values()].filter((r) => !r.finishing).length;
    if (activeCount >= maxConcurrent) {
      pendingRuns.push({ runId, payload: p, workspaceRoot });
      started.push({ runId, role: a.role, queued: true });
      continue;
    }
    const res = await doStartRun(runId, p, workspaceRoot);
    if (!res || !res.ok) {
      noteCollabStartFailure(p, (res && res.error) || 'failed');
      started.push({ runId, role: a.role, error: (res && res.error) || 'failed' });
    } else {
      started.push({ runId, role: a.role, ok: true });
    }
  }
  if (!started.some((s) => s.ok || s.queued)) {
    collabGroups.delete(groupId);
    return { ok: false, error: 'no team member could start: ' + (started[0] && started[0].error || 'unknown') };
  }
  return { ok: true, groupId, agents: plan.agents, started };
}

// Called from finishRun for every run that carried a groupId. Workers are
// counted down; when the last one lands, spawn the integrator exactly once.
// The integrator's own finish clears the tracker.
function maybeAdvanceCollab(groupId, info) {
  if (!groupId) return;
  const g = collabGroups.get(groupId);
  if (!g) return;
  if (info.isIntegrator) { collabGroups.delete(groupId); return; }
  g.workers.push(info);
  g.remaining -= 1;
  checkCollabComplete(groupId);
}

// A worker (or the integrator) that never managed to START still has to be
// accounted, from both the immediate and the queued start paths.
function noteCollabStartFailure(payload, error) {
  const groupId = payload && payload.groupId;
  if (!groupId) return;
  const g = collabGroups.get(groupId);
  if (!g) return;
  if (payload.isIntegrator) {
    collabGroups.delete(groupId);
    if (mainWindow) mainWindow.webContents.send('autopilot:collab-plan', { groupId, terminal: true, integrator: true, note: `Integrator could not start (${String(error).slice(0, 120)}); each team member's result stays available in History.` });
    return;
  }
  g.remaining -= 1;
  if (mainWindow) mainWindow.webContents.send('autopilot:collab-plan', { groupId, role: payload.role || null, note: `Team member "${payload.role || 'agent'}" could not start (${String(error).slice(0, 120)}).` });
  checkCollabComplete(groupId);
}

function checkCollabComplete(groupId) {
  const g = collabGroups.get(groupId);
  if (!g) return;
  if (g.remaining > 0 || g.integratorSpawned) return;
  g.integratorSpawned = true;
  const contributed = g.workers.filter((w) => (w.fileCount || 0) > 0);
  if (!contributed.length) {
    if (mainWindow) mainWindow.webContents.send('autopilot:collab-plan', { groupId, terminal: true, note: 'No team member produced changes; skipping integration.' });
    collabGroups.delete(groupId);
    return;
  }
  const wtLines = g.workers.map((w) => `${w.role || 'agent'}: ${w.worktreePath} (${w.fileCount || 0} files changed)`);
  const inject = [
    `[COLLAB INTEGRATION] ${g.workers.length} agents worked in parallel on this shared goal, each in its own worktree of the same repository. Shared goal: ${g.goal}.`,
    `Worker worktrees: ${wtLines.join('; ')}.`,
    'Inspect each worker\'s changes with: git -C <worktree> diff HEAD.',
    'Bring the good work into YOUR current working directory: export each worker\'s diff and apply it here (git -C <worktree> diff HEAD | git apply), or re-edit the files directly when a patch does not apply cleanly. When workers touched the same code, reconcile by correctness, not order. Verify the combined result is coherent (build/tests where available). Your directory is the final deliverable.',
  ].join(' ');
  const p = {
    goal: `Integrate the team's parallel work: ${g.goal}`.slice(0, 4096),
    originalGoal: g.goal,
    fleetStartedAt: g.startedAt || Date.now(),
    preApplyWorkers: g.workers.map((w) => ({
      role: w.role || 'worker',
      worktreePath: w.worktreePath,
      changes: Array.isArray(w.changes) ? w.changes : [],
    })),
    injectGoal: inject,
    caps: g.caps, snapshot: g.snapshot,
    groupId, role: 'integrator', isIntegrator: true,
  };
  const runId = newRunId();
  const maxConcurrent = config.autopilotMaxConcurrent || AP_MAX_CONCURRENT;
  const activeCount = [...runs.values()].filter((r) => !r.finishing).length;
  if (activeCount >= maxConcurrent) {
    pendingRuns.push({ runId, payload: p, workspaceRoot: g.workspaceRoot });
  } else {
    doStartRun(runId, p, g.workspaceRoot)
      .then((res) => { if (!res || !res.ok) noteCollabStartFailure(p, (res && res.error) || 'failed to start'); })
      .catch((err) => noteCollabStartFailure(p, (err && err.message) || 'failed to start'));
  }
}

// Start one run: create its isolated worktree, snapshot it, spin up the
// supervisor runner + budget tick + dedicated PTY, then deliver the goal once
// the agent's TUI settles. Every early-exit path that has already created the
// worktree removes it before returning, so a failed start leaves nothing on
// disk.
async function doStartRun(runId, payload, workspaceRoot) {
  const wtResult = createRunWorktree(runId, workspaceRoot);
  if (!wtResult.ok) return { ok: false, error: wtResult.error };
  const runRoot = wtResult.worktreePath;
  const sessionId = 'auto-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const { encrypt, decrypt } = autopilotCrypto();
  const onProgress = (info) => {
    if (mainWindow) mainWindow.webContents.send('autopilot:snapshot-progress', { runId, ...info });
  };
  const wantSnapshot = payload.snapshot !== false;
  let snap;
  if (wantSnapshot) {
    try {
      snap = await Autopilot.snapshot.captureSnapshotAsync(runRoot, autopilotStorageRoot(), sessionId, { encrypt, onProgress });
    } catch (err) {
      removeRunWorktree(runRoot, workspaceRoot);
      return { ok: false, error: `snapshot crashed: ${(err && err.message) || String(err)}` };
    }
    if (!snap.ok) {
      removeRunWorktree(runRoot, workspaceRoot);
      return { ok: false, error: snap.error };
    }
  } else {
    snap = { ok: true, manifest: null, fileCount: 0 };
  }
  let preApplyResult = null;
  if (Array.isArray(payload.preApplyWorkers) && payload.preApplyWorkers.length) {
    preApplyResult = applyWorkerChangesToIntegrator(runRoot, payload.preApplyWorkers);
    const appliedCount = preApplyResult.applied.length;
    const failedCount = preApplyResult.failed.length;
    const line = `Preloaded ${appliedCount} worker change${appliedCount === 1 ? '' : 's'} into this integration worktree${failedCount ? `; ${failedCount} failed` : ''}.`;
    payload.injectGoal = `${payload.injectGoal || payload.goal || ''} ${line}`;
  }
  const agentName = (config.agentCommand || 'claude').trim().split(/\s+/)[0]
    .split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const vendorBilled = ['copilot', 'codex', 'aider', 'gemini'].includes(agentName);
  const originalGoal = (payload && typeof payload.originalGoal === 'string' && payload.originalGoal.trim())
    ? payload.originalGoal.trim().slice(0, 4096)
    : null;
  const auditGoal = originalGoal || (typeof payload.goal === 'string' ? payload.goal.slice(0, 4096) : null);
  const r = Autopilot.supervisor.startRun({
    sessionId, workspaceRoot: runRoot,
    storageRoot: autopilotStorageRoot(),
    goal: auditGoal,
    agent: payload.agent || agentName,
    modelId: payload.modelId || (vendorBilled ? agentName : null),
    caps: payload.caps,
    // Progress governor: halt a run that idles or loops so it stops
    // burning tokens on no forward progress. On by default; a caller can
    // pass governor:false to opt a run out.
    governor: payload.governor === false ? false : true,
    encrypt, decrypt,
    skipSnapshot: true,
    snapshotManifest: snap.manifest,
  });
  if (!r.ok) {
    removeRunWorktree(runRoot, workspaceRoot);
    return { ok: false, error: r.error };
  }
  const runState = {
    runId,
    runner: r.runner,
    pty: null, _dataDisposable: null, _exitDisposable: null,
    worktreePath: runRoot, workspaceRoot,
    outputBuf: '', flushTimer: null,
    transcriptPath: null, transcriptOffset: 0, transcriptRemainder: '', transcriptStaleTicks: 0,
    lastFeedAt: 0, lastPtyDataAt: 0, workingSeenAt: 0, nudgeCount: 0,
    feedEverStreamed: false, ptyFallbackActive: false, spawnedAt: Date.now(),
    maxReportedTokens: 0,
    finishing: false, tickInterval: null,
    raceId: (payload && typeof payload.raceId === 'string' && payload.raceId) ? payload.raceId : null,
    groupId: (payload && typeof payload.groupId === 'string' && payload.groupId) ? payload.groupId : null,
    role: (payload && typeof payload.role === 'string' && payload.role) ? payload.role.slice(0, 40) : null,
    isIntegrator: !!(payload && payload.isIntegrator),
    goalInjectedAt: 0, goalSubmitted: false, injectResends: 0, lastResendAt: 0,
    goal: typeof payload.goal === 'string' ? payload.goal.slice(0, 4096) : null,
    originalGoal: originalGoal || (typeof payload.goal === 'string' ? payload.goal.slice(0, 4096) : null),
    fleetStartedAt: Number(payload.fleetStartedAt) || 0,
    preApplyResult,
    preApplyWorkers: Array.isArray(payload.preApplyWorkers) ? payload.preApplyWorkers : [],
    agent: agentName,
    agentCommandOverride: (typeof payload.agentCommand === 'string' && payload.agentCommand.trim()) ? payload.agentCommand.trim() : null,
  };
  runs.set(runId, runState);
  // Forensics: tie this audit log to its pool identity and isolated worktree
  // so a session on disk can always be traced back to the run that produced it.
  try {
    r.runner.recordEvent({
      kind: 'run_identity',
      ts: new Date().toISOString(),
      payload: {
        runId,
        worktreePath: runRoot,
        workspaceRoot,
        groupId: runState.groupId,
        role: runState.role,
        isIntegrator: runState.isIntegrator,
        originalGoal: runState.originalGoal,
        fleetStartedAt: runState.fleetStartedAt || null,
        agent: runState.agent,
      },
    });
  } catch (_) {}
  runState.tickInterval = setInterval(() => {
    const rs = runs.get(runId);
    if (!rs) return;
    // Stream this run's own narration to the renderer feed, then make sure
    // the goal actually submitted, then check for stalls. All observe the
    // run directly (transcript + PTY), never a chat terminal.
    try { tailRunTranscript(runId); } catch (_) {}
    try { pollRunStatusFile(runId); } catch (_) {}
    try { ensureRunGoalSubmitted(runId); } catch (_) {}
    try { runIdleWatchdog(runId); } catch (_) {}
    try { refreshRunCopilotStats(rs); } catch (_) {}
    // Every ~20s, compute a content-sensitive signature of the worktree diff
    // off-thread and feed it to the governor as the forward-progress signal.
    // stat(size+mtime) per changed file is cheap and catches repeated edits
    // to the same file (which keep status='modified'); a stat failure falls
    // back to status so a missing file never fakes progress. Throttled and
    // guarded so at most one diff walk per run is ever in flight.
    rs._diffTick = (rs._diffTick || 0) + 1;
    if (rs._diffTick % 20 === 0 && !rs._diffPending) {
      rs._diffPending = true;
      Autopilot.snapshot.diffWorkspaceAsync(rs.worktreePath, autopilotStorageRoot(), rs.runner.sessionId)
        .then((d) => {
          const rr = runs.get(runId);
          if (!rr) return;
          let sig = '';
          if (d && d.ok && Array.isArray(d.changes)) {
            sig = d.changes.map((c) => {
              let meta = c.status;
              try {
                const st = fs.statSync(path.join(rr.worktreePath, c.path));
                meta = `${c.status}:${st.size}:${Math.round(st.mtimeMs)}`;
              } catch (_) { /* deleted/unreadable: status alone */ }
              return `${c.path}#${meta}`;
            }).sort().join('|');
          }
          try { rr.runner.reportProgress(sig); } catch (_) {}
        })
        .catch(() => {})
        .finally(() => { const rr = runs.get(runId); if (rr) rr._diffPending = false; });
    }
    const s = rs.runner.tickClock();
    // tickClock may internally halt the run on a governor stall; read the
    // governor state so the dashboard sees the idle/loop ramp and the halt
    // path below can act on it.
    const gov = (typeof rs.runner.governorState === 'function') ? rs.runner.governorState() : null;
    if (mainWindow) mainWindow.webContents.send('autopilot:budget', {
      runId, ...s,
      // Live telemetry for the dashboard: coarse state, current tool, and
      // nudge count ride the 1s budget tick instead of a separate channel.
      governor: gov,
      state: runLiveState(rs),
      nudges: rs.nudgeCount || 0,
      lastTool: rs.lastToolText || null,
      lastToolAt: rs.lastToolAt || 0,
      quietMs: Math.max(0, Date.now() - Math.max(rs.lastFeedAt || 0, rs.lastPtyDataAt || 0)),
      role: rs.role || null,
      agent: rs.agent || null,
      modelObserved: rs.observedModel || null,
      tokensPartial: !!rs.tokensPartial,
    });
    if (s.hitCap) {
      try { clearInterval(rs.tickInterval); } catch (_) {}
      sigintRunPty(runId);
      if (mainWindow) mainWindow.webContents.send('autopilot:halt', { runId, reason: 'budget', cap: s.hitCap });
      finishRun(runId, { reason: 'budget', cap: s.hitCap });
    } else if (gov && gov.stalled) {
      // The governor caught a stall (idle / loop / no-progress). The runner
      // is already halted; tear down the PTY and finish so the worktree is
      // retained and the run is bookable into the fleet receipt as "saved".
      try { clearInterval(rs.tickInterval); } catch (_) {}
      sigintRunPty(runId);
      if (mainWindow) mainWindow.webContents.send('autopilot:halt', { runId, reason: 'stall', signal: gov.stalled });
      finishRun(runId, { reason: 'stall', signal: gov.stalled });
    }
  }, 1000);
  spawnRunPty(runId, runRoot);
  const goal = typeof payload.goal === 'string' ? payload.goal.slice(0, 4096) : '';
  if (mainWindow) mainWindow.webContents.send('autopilot:started', {
    runId, sessionId, workspaceRoot: runRoot, fileCount: snap.fileCount, goal,
    originalGoal: runState.originalGoal || goal,
    fleetStartedAt: runState.fleetStartedAt || null,
    raceId: runState.raceId, groupId: runState.groupId, role: runState.role,
  });
  if (goal) {
    // Collab runs record the readable sub-goal but inject a richer team
    // directive (shared goal + own lane); other runs inject the goal itself.
    const injectText = (typeof payload.injectGoal === 'string' && payload.injectGoal) ? payload.injectGoal : goal;
    whenRunPtyReady(runId, 6000).then(() => {
      const ok = injectGoalToRunPty(runId, buildAutopilotGoal(injectText));
      const rs = runs.get(runId);
      if (ok && rs) {
        // The TUI may still be mounting when the paste lands, eating the
        // trailing Enter. Mark the injection so the per-run tick can verify
        // submission (the transcript only appears after a real submit) and
        // resend Enter until it does. Also arm the idle watchdog NOW: rescue
        // must never depend on banner bytes racing the fallback grace window.
        rs.goalInjectedAt = Date.now();
        rs.goalSubmitted = false;
        rs.feedEverStreamed = true;
        rs.lastFeedAt = Date.now();
      }
      if (mainWindow) mainWindow.webContents.send('autopilot:activity', {
        runId,
        lines: [ok ? 'Goal delivered to agent. Waiting for first response...' : 'Could not deliver goal: no agent process available.'],
        at: Date.now(),
      });
    });
  }
  return { ok: true, runId, sessionId, workspaceRoot: runRoot, fileCount: snap.fileCount, goal };
}

ipcMain.handle('autopilot:event', (_e, event = {}) => {
  const runId = String(event && event.runId || '').trim();
  const r = runId ? runs.get(runId) : [...runs.values()][0];
  if (!r) return { ok: false, error: 'no active run' };
  return r.runner.recordEvent(event);
});

// Push a stalled autonomous agent to keep going on its own. Called by the
// renderer watchdog when the agent goes quiet without printing the completion
// marker (the "it asked a question and is waiting" stall). Capped on
// the renderer side so a genuinely stuck run still ends.
ipcMain.handle('autopilot:nudge', (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  const r = runId ? runs.get(runId) : [...runs.values()][0];
  if (!r) return { ok: false, error: 'no active run' };
  const ok = injectGoalToRunPty(runId || [...runs.keys()][0],
    'Continue autonomously. Do not ask questions or wait for input. Pick a sensible default for any open decision, '
    + 'state it in one line, and keep working until the goal is complete. When fully done, print '
    + AUTOPILOT_COMPLETE_SENTINEL + ' alone on its own line.'
  );
  return { ok };
});

ipcMain.handle('autopilot:cancel', (_e, detail = {}) => {
  const runId = String(detail && detail.runId || '').trim();
  // No worker runs yet but the orchestrator is planning: cancel that phase.
  if (!runId && activePlanning) {
    try { activePlanning.cancel(); } catch (_) {}
    activePlanning = null;
    if (mainWindow) {
      mainWindow.webContents.send('autopilot:collab-plan', { note: 'Planning cancelled before the team started.' });
      mainWindow.webContents.send('autopilot:halt', { reason: 'user' });
    }
    return { ok: true, cancelledPlanning: true };
  }
  // Resolve the target run. With an explicit id, cancel exactly that run.
  // Without one, fall back ONLY when a single run is active; cancelling an
  // arbitrary "first" run when several are live could stop a run the user
  // never aimed at.
  let rid = null;
  let queuedIdx = -1;
  let queuedPayload = null;
  if (runId && !runs.has(runId)) {
    queuedIdx = pendingRuns.findIndex((p) => p && p.runId === runId);
    if (queuedIdx >= 0) queuedPayload = pendingRuns[queuedIdx] && pendingRuns[queuedIdx].payload;
  }
  if (runId && runs.has(runId)) rid = runId;
  else if (runId && queuedPayload && queuedPayload.groupId) {
    const activeSibling = [...runs.entries()]
      .find(([, run]) => run && run.groupId === queuedPayload.groupId && !run.finishing);
    if (activeSibling) rid = activeSibling[0];
  }
  else if (!runId && runs.size === 1) rid = [...runs.keys()][0];
  if (!rid && runId && queuedIdx >= 0) {
    const groupId = queuedPayload && queuedPayload.groupId;
    let cancelled = 0;
    if (groupId) {
      for (let i = pendingRuns.length - 1; i >= 0; i--) {
        const p = pendingRuns[i] && pendingRuns[i].payload;
        if (p && p.groupId === groupId) { pendingRuns.splice(i, 1); cancelled++; }
      }
      collabGroups.delete(groupId);
      if (mainWindow) mainWindow.webContents.send('autopilot:collab-plan', { groupId, terminal: true, cancelled: true, note: 'Team cancelled before all queued agents started.' });
    } else {
      pendingRuns.splice(queuedIdx, 1);
      cancelled = 1;
    }
    return { ok: true, runId, queued: true, cancelled };
  }
  const r = rid ? runs.get(rid) : null;
  if (!r || !rid) return { ok: false, error: runId ? 'run not found' : 'no active run' };
  // Stop the WHOLE autopilot team, not just the focused run: every live
  // run in this run's collab group, plus queued members that have not
  // started yet, plus the group tracker so no integrator spawns after the
  // stop. Only autopilot-owned run PTYs are touched; chat sessions live in
  // a separate registry and are never affected.
  const groupId = r.groupId || null;
  const targets = [rid];
  if (groupId) {
    for (const [id, run] of runs) {
      if (id !== rid && run.groupId === groupId && !run.finishing) targets.push(id);
    }
    for (let i = pendingRuns.length - 1; i >= 0; i--) {
      const p = pendingRuns[i] && pendingRuns[i].payload;
      if (p && p.groupId === groupId) pendingRuns.splice(i, 1);
    }
    collabGroups.delete(groupId);
    if (mainWindow) mainWindow.webContents.send('autopilot:collab-plan', { groupId, terminal: true, cancelled: true, note: 'Team stop requested.' });
    if (mainWindow && targets.length > 1) {
      mainWindow.webContents.send('autopilot:activity', {
        runId: rid,
        lines: [`Stop requested: ending ${targets.length} team agents.`],
        at: Date.now(),
      });
    }
  }
  let focusedResult = null;
  for (const id of targets) {
    const run = runs.get(id);
    if (!run || run.finishing) continue;
    sigintRunPty(id);
    try { run.runner.cancel(detail); } catch (_) {}
    const res = finishRun(id, { reason: 'user' });
    if (id === rid) focusedResult = res;
  }
  return focusedResult || { ok: true, runId: rid };
});

ipcMain.handle('autopilot:end', (_e, detail = {}) => {
  const runId = String(detail && detail.runId || '').trim();
  const rid = runId || [...runs.keys()][0];
  if (!rid || !runs.has(rid)) return { ok: false, error: 'no active run' };
  return finishRun(rid, detail);
});

// Close one run: stop its meter, drain its PTY output into the audit log, run
// the end-of-run diff, summarize WHILE THE WORKTREE STILL EXISTS, tear down its
// PTY, then RETAIN the worktree (it holds the agent's changes) and register it
// for later apply/discard. Broadcasts autopilot:ended. Guarded against re-entry
// (an agent crash and a user cancel can both target the same run) via the
// per-run `finishing` flag. On exit, drains the pending queue so a freed slot
// starts the next run.
//
// The order is summarize → retain, and removal only happens on explicit apply/discard.
async function finishRun(runId, detail) {
  const r = runs.get(runId);
  if (!r || r.finishing) return { ok: false, error: 'no active run' };
  r.finishing = true;
  try {
    try { clearInterval(r.tickInterval); } catch (_) {}
    if (r.flushTimer) { clearTimeout(r.flushTimer); r.flushTimer = null; }
    flushRunOutput(runId);
    r.outputBuf = '';
    try { refreshRunCopilotStats(r); } catch (_) {}
    if (r.isIntegrator && Array.isArray(r.preApplyWorkers) && r.preApplyWorkers.length) {
      try {
        const live = await Autopilot.snapshot.diffWorkspaceAsync(r.worktreePath, autopilotStorageRoot(), r.runner.sessionId);
        if (live && live.ok && Array.isArray(live.changes) && live.changes.length === 0) {
          r.preApplyResult = applyWorkersWhenIntegratorEmpty(live.changes, r.worktreePath, r.preApplyWorkers);
        }
      } catch (_) {}
    }
    try { await r.runner.endRunAsync(detail || null); } catch (_) {}
    const sessionId = r.runner.sessionId;
    const runRoot = r.worktreePath;
    const origRoot = r.workspaceRoot;
    const raceId = r.raceId || null;
    const groupId = r.groupId || null;
    const runRole = r.role || null;
    const wasIntegrator = !!r.isIntegrator;
    const runAgent = r.agent || null;
    const goal = r.goal || null;
    // Clean up PTY (but NOT the worktree; its files are the deliverable).
    try { if (r._dataDisposable) r._dataDisposable.dispose(); } catch (_) {}
    try { if (r._exitDisposable) r._exitDisposable.dispose(); } catch (_) {}
    try { if (r.pty) r.pty.kill(); } catch (_) {}
    runs.delete(runId);
    // Summarize while the worktree still exists so the diff can read real files.
    const { decrypt } = autopilotCrypto();
    let sum;
    try {
      sum = await Autopilot.supervisor.summarizeRunAsync({
        sessionId, workspaceRoot: runRoot, storageRoot: autopilotStorageRoot(), decrypt,
      });
    } catch (err) {
      sum = { ok: false, error: (err && err.message) || String(err) };
    }
    if (sum && typeof sum === 'object') {
      sum.runId = runId; sum.sessionId = sessionId; sum.workspaceRoot = runRoot; sum.raceId = raceId; sum.groupId = groupId; sum.role = runRole;
      sum.originalGoal = r.originalGoal || goal || null;
      if (r.fleetStartedAt) sum.fleetStartedAt = r.fleetStartedAt;
      // Conclusion payload for the review UI: why the run ended, how many
      // nudges it took, and the agent's last narration as its final report.
      sum.endReason = (detail && detail.reason) || 'ended';
      sum.nudges = r.nudgeCount || 0;
      sum.finalMessage = r.lastAssistantText || null;
      sum.modelObserved = r.observedModel || null;
      if (sum.summary && sum.summary.meter) sum.summary.meter.tokensPartial = !!r.tokensPartial;
      if (sum.summary && r.fleetStartedAt) sum.summary.fleetDurationMs = Math.max(0, Date.now() - r.fleetStartedAt);
    }
    // Retain the worktree for review. A run whose worktree is inside the
    // managed root (i.e. it really was isolated) is retained with its diff so
    // Apply/Discard can act later; a run that somehow ran in-place has nothing
    // to retain.
    if (runRoot && origRoot && runRoot !== origRoot) {
      const changes = (sum && Array.isArray(sum.diff)) ? sum.diff : [];
      const meter = (sum && sum.summary && sum.summary.meter) || {};
      retainRun(runId, {
        runId, sessionId, raceId, goal: r.originalGoal || goal, subgoal: goal,
        groupId, role: runRole, isIntegrator: wasIntegrator,
        agent: runAgent,
        worktreePath: runRoot,
        workspaceRoot: origRoot,
        changes,
        metrics: {
          durationMs: (sum && sum.summary && typeof sum.summary.durationMs === 'number') ? sum.summary.durationMs : 0,
          tokens: typeof meter.totalTokens === 'number' ? meter.totalTokens : 0,
          dollars: typeof meter.dollars === 'number' ? meter.dollars : 0,
          fileCount: changes.length,
        },
        fleetStartedAt: r.fleetStartedAt || null,
        endedAt: new Date().toISOString(),
      });
    }
    // Collab bookkeeping: count this worker down and spawn the integrator
    // when the team is done (or clear the tracker if this WAS the integrator).
    try {
      maybeAdvanceCollab(groupId, {
        runId, role: runRole, isIntegrator: wasIntegrator,
        worktreePath: runRoot,
        fileCount: (sum && Array.isArray(sum.diff)) ? sum.diff.length : 0,
        changes: (sum && Array.isArray(sum.diff)) ? sum.diff : [],
      });
    } catch (_) {}
    // If the group is still alive after bookkeeping, more team work follows
    // (siblings or the integrator that spawns asynchronously). The renderer
    // must not drop into review mode on this worker's partial slice.
    if (sum && typeof sum === 'object' && groupId && collabGroups.has(groupId)) sum.groupPending = true;
    if (mainWindow) mainWindow.webContents.send('autopilot:ended', sum);
    // Drain any queued runs
    drainPendingRun();
    return { ok: true, runId, sessionId, summary: sum };
  } finally {
    if (runs.has(runId)) { runs.delete(runId); }
    r.finishing = false;
  }
}

// Apply a retained run's changes into its origin workspace. A complete success
// removes the worktree and registry entry; a partial failure keeps them so the
// unapplied work remains reviewable/retryable.
ipcMain.handle('autopilot:applyRun', async (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  const entry = getRetained(runId);
  if (!entry) return { ok: false, error: 'no retained run with that id' };
  // While a collab team is still active, worker worktrees are the
  // integrator's inputs and the integrator is the intended Apply target;
  // applying a lone slice early ships partial work. After the group ends,
  // workers become normal retained runs (the integrator-failure fallback).
  if (entry.groupId && collabGroups.has(entry.groupId) && !entry.isIntegrator) {
    return { ok: false, error: 'this run is part of an active team; wait for the integrator to finish, then apply its result' };
  }
  const result = applyWorktreeChanges(entry.worktreePath, entry.workspaceRoot, entry.changes || []);
  if (!result.ok) return { ok: false, runId, applied: result.applied, failed: result.failed };
  try { removeRunWorktree(entry.worktreePath, entry.workspaceRoot); } catch (_) {}
  dropRetained(runId);
  return { ok: result.ok, runId, applied: result.applied, failed: result.failed };
});

// Discard a retained run: remove its worktree without applying anything.
ipcMain.handle('autopilot:discardRun', async (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  const entry = getRetained(runId);
  if (!entry) return { ok: false, error: 'no retained run with that id' };
  // Discarding a worker mid-team would delete a worktree the integrator is
  // about to read, silently dropping that agent's contribution.
  if (entry.groupId && collabGroups.has(entry.groupId) && !entry.isIntegrator) {
    return { ok: false, error: 'this run is part of an active team; its work feeds the integrator. Discard after the team finishes' };
  }
  try { removeRunWorktree(entry.worktreePath, entry.workspaceRoot); } catch (_) {}
  dropRetained(runId);
  return { ok: true, runId };
});

// List retained (finished, undecided) runs so the review UI can show them and
// orphans are discoverable across restarts.
ipcMain.handle('autopilot:retained', () => {
  const map = readRetained();
  return { ok: true, runs: Object.values(map) };
});

// Group retained runs into races (by raceId) and rank each race with the judge,
// so the comparison UI can show a head-to-head scorecard with a suggested
// winner. Runs without a raceId are returned loose (single reviews).
ipcMain.handle('autopilot:race', () => {
  const all = Object.values(readRetained());
  const byRace = new Map();
  const loose = [];
  for (const r of all) {
    if (r && r.raceId) {
      if (!byRace.has(r.raceId)) byRace.set(r.raceId, []);
      byRace.get(r.raceId).push(r);
    } else if (r) {
      loose.push(r);
    }
  }
  const races = [];
  for (const [raceId, group] of byRace) {
    const ranked = rankRuns(group);
    const goal = (group.find((g) => g.goal) || {}).goal || null;
    races.push({ raceId, goal, count: ranked.length, runs: ranked });
  }
  // Newest race first by the winner's endedAt (fall back to any run's).
  races.sort((a, b) => {
    const ta = new Date((a.runs[0] && a.runs[0].endedAt) || 0).getTime();
    const tb = new Date((b.runs[0] && b.runs[0].endedAt) || 0).getTime();
    return tb - ta;
  });
  return { ok: true, races, loose };
});

// Apply one run of a race and discard all its siblings in a single move after
// the winner lands cleanly. If the winner partially fails, every worktree stays
// retained so no candidate work is destroyed.
ipcMain.handle('autopilot:applyWinner', async (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  const winner = getRetained(runId);
  if (!winner) return { ok: false, error: 'no retained run with that id' };
  const result = applyWorktreeChanges(winner.worktreePath, winner.workspaceRoot, winner.changes || []);
  if (!result.ok) return { ok: false, runId, applied: result.applied, failed: result.failed, discarded: 0 };
  try { removeRunWorktree(winner.worktreePath, winner.workspaceRoot); } catch (_) {}
  dropRetained(runId);
  // Discard the losing siblings in the same race.
  let discarded = 0;
  if (winner.raceId) {
    for (const r of Object.values(readRetained())) {
      if (r && r.raceId === winner.raceId && r.runId !== runId) {
        try { removeRunWorktree(r.worktreePath, r.workspaceRoot); } catch (_) {}
        dropRetained(r.runId);
        discarded++;
      }
    }
  }
  return { ok: result.ok, runId, applied: result.applied, failed: result.failed, discarded };
});

ipcMain.handle('autopilot:status', (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  if (runId) {
    const r = runs.get(runId);
    if (!r) return { ok: true, active: false };
    return { ok: true, active: true, runId, sessionId: r.runner.sessionId, state: r.runner.getState(), budget: r.runner.budgetState() };
  }
  // No runId → return list of all active runs
  const active = [...runs.entries()].map(([rid, r]) => ({
    runId: rid, sessionId: r.runner.sessionId, state: r.runner.getState(), budget: r.runner.budgetState(),
  }));
  return { ok: true, active: active.length > 0, runs: active };
});

ipcMain.handle('autopilot:list', () => {
  const active = [...runs.entries()].map(([rid, r]) => ({
    runId: rid,
    sessionId: r.runner.sessionId,
    state: r.runner.getState(),
    budget: r.runner.budgetState(),
    worktreePath: r.worktreePath,
  }));
  return { ok: true, runs: active, queued: pendingRuns.length };
});

// The restore/diff target for a session is the directory the snapshot
// was captured from, recorded in its manifest. Never trust a caller-
// supplied workspaceRoot for a destructive revert: an empty value used
// to fall back to HOME, and the restore deletes every file not in the
// snapshot, so a wrong root would wipe an unrelated directory.
function manifestWorkspaceRoot(sessionId) {
  if (!isSafeAutopilotSessionId(sessionId)) return null;
  try {
    const mp = path.join(autopilotStorageRoot(), 'sessions', sessionId, 'snapshot.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to autopilot storage
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    if (m && typeof m.workspaceRoot === 'string' && m.workspaceRoot) return m.workspaceRoot;
  } catch (_) {}
  // Runs started with the snapshot toggle off write no manifest. The
  // run_identity audit row records the worktree the run executed in;
  // summarize can still read its diff and audit data from there.
  try {
    const ap = path.join(autopilotStorageRoot(), 'sessions', sessionId, 'audit.jsonl');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to autopilot storage
    const raw = fs.readFileSync(ap, 'utf8');
    for (const ln of raw.split('\n').slice(0, 20)) {
      if (!ln.trim()) continue;
      try {
        const row = JSON.parse(ln);
        if (row.kind === 'run_identity' && row.payload && typeof row.payload.worktreePath === 'string') {
          return row.payload.worktreePath;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

const AUTOPILOT_SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
function isSafeAutopilotSessionId(sessionId) {
  return typeof sessionId === 'string' && AUTOPILOT_SESSION_ID_RE.test(sessionId);
}

ipcMain.handle('autopilot:revert', (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  if (!isSafeAutopilotSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  const workspaceRoot = manifestWorkspaceRoot(sessionId);
  if (!workspaceRoot) return { ok: false, error: 'snapshot manifest has no workspace root; cannot revert safely' };
  const { decrypt } = autopilotCrypto();
  return Autopilot.supervisor.revertRun({
    sessionId,
    workspaceRoot,
    storageRoot: autopilotStorageRoot(),
    decrypt,
    preserveExtras: !!payload.preserveExtras,
  });
});

// Renderer-side terminal snapshot parser reports the agent's own
// cumulative token count here. claude prints "↓ 1.5k tokens" in its
// status line; we treat that as truth and override the chars/4
// estimate the budget meter would otherwise produce. Cap firing
// also uses the authoritative number when present.
ipcMain.handle('autopilot:reportTokens', (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  let rid = runId;
  if (!rid) {
    if (runs.size !== 1) {
      return { ok: false, error: runs.size ? 'runId required when multiple runs are active' : 'no active run' };
    }
    rid = [...runs.keys()][0];
  }
  const r = runs.get(rid);
  if (!r) return { ok: false, error: 'run not found' };
  const n = Number(payload && payload.tokens);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  try { r.runner.setReportedTokens(n); } catch (_) {}
  // Re-broadcast budget so the rings update immediately to the new
  // authoritative number instead of waiting for the next 1s tick.
  if (mainWindow) mainWindow.webContents.send('autopilot:budget', { runId: rid, ...r.runner.budgetState() });
  return { ok: true };
});

// History of past autopilot runs in the active project. Scans the
// per-session manifests under the autopilot storage dir, returns
// the most recent N. Each session manifest carries workspaceRoot;
// we filter to the requested workspace so each project sees its
// own history.
ipcMain.handle('autopilot:history', async (_e, payload = {}) => {
  const wantWorkspace = String(payload && payload.workspaceRoot || '').trim() || null;
  const sessionsDir = path.join(autopilotStorageRoot(), 'sessions');
  let entries = [];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- sessionsDir bounded to userData
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return { ok: true, runs: [] };
  }
  const pastRuns = [];
  const retainedBySession = new Map();
  for (const entry of Object.values(readRetained())) {
    if (entry && entry.sessionId) retainedBySession.set(entry.sessionId, entry);
  }
  for (const sid of entries) {
    try {
      // The snapshot manifest is optional (runs started with the snapshot
      // toggle off never write one), and for isolated runs its
      // workspaceRoot names the run's own worktree, not the project.
      // The run_identity audit row carries the origin workspace, so the
      // project filter reads that first.
      const manifestPath = path.join(sessionsDir, sid, 'snapshot.json');
      let manifest = {};
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
      if (fs.existsSync(manifestPath)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      }
      const auditPath = path.join(sessionsDir, sid, 'audit.jsonl');
      let goal = null;
      let status = 'unknown';
      let haltReason = null;
      let fileCount = 0;
      let endedAt = null;
      let startedAt = null;
      let dollars = 0;
      let tokens = 0;
      let caps = null;
      let originWorkspace = null;
      let groupId = null;
      let role = null;
      let isIntegrator = false;
      let runId = null;
      let agent = null;
      const retained = retainedBySession.get(sid) || null;
      if (retained) {
        groupId = retained.groupId || null;
        role = retained.role || null;
        isIntegrator = !!retained.isIntegrator;
        runId = retained.runId || null;
        agent = retained.agent || null;
        if (retained.goal) goal = retained.goal;
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
      if (fs.existsSync(auditPath)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
        const raw = fs.readFileSync(auditPath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        for (const ln of lines) {
          try {
            const row = JSON.parse(ln);
            if (!startedAt && row.ts) startedAt = row.ts;
            if (row.kind === 'run_identity' && row.payload && typeof row.payload.workspaceRoot === 'string') {
              originWorkspace = row.payload.workspaceRoot;
              groupId = row.payload.groupId || groupId;
              role = row.payload.role || role;
              isIntegrator = !!row.payload.isIntegrator || isIntegrator;
              runId = row.payload.runId || runId;
              agent = row.payload.agent || agent;
              if (row.payload.originalGoal && !goal) goal = row.payload.originalGoal;
            }
            if (row.kind === 'start_run' && row.payload) {
              if (typeof row.payload.goal === 'string') goal = row.payload.goal;
              if (row.payload.caps && typeof row.payload.caps === 'object') caps = row.payload.caps;
            }
            if (row.kind === 'run_summary' && row.payload) {
              status = row.payload.status || status;
              haltReason = row.payload.haltReason || haltReason;
              fileCount = Array.isArray(row.payload.diff) ? row.payload.diff.length : 0;
              endedAt = row.payload.endedAt || endedAt;
              if (row.payload.meter && typeof row.payload.meter.dollars === 'number') dollars = row.payload.meter.dollars;
              if (row.payload.meter && typeof row.payload.meter.totalTokens === 'number') tokens = row.payload.meter.totalTokens;
              if (!caps && row.payload.meter && row.payload.meter.caps) caps = row.payload.meter.caps;
            }
          } catch (_) {}
        }
      }
      // Pre-worktree sessions have no run_identity row; their manifest
      // workspaceRoot really is the project path.
      const runWorkspace = originWorkspace || manifest.workspaceRoot || null;
      if (wantWorkspace && runWorkspace && path.resolve(runWorkspace) !== path.resolve(wantWorkspace)) continue;
      pastRuns.push({
        sessionId: sid,
        capturedAt: manifest.capturedAt || startedAt || null,
        endedAt,
        workspaceRoot: runWorkspace,
        goal,
        caps,
        status,
        haltReason,
        fileCount,
        dollars,
        tokens,
        groupId,
        role,
        isIntegrator,
        runId,
        agent,
      });
    } catch (_) {}
  }
  const groupedRuns = groupHistoryRuns(pastRuns);
  groupedRuns.sort((a, b) => {
    const ka = new Date(a.endedAt || a.capturedAt || 0).getTime();
    const kb = new Date(b.endedAt || b.capturedAt || 0).getTime();
    return kb - ka;
  });
  return { ok: true, runs: groupedRuns.slice(0, 24) };
});

// Delete a past run: removes its session directory (manifest, audit log,
// and all snapshot blobs). Refuses an active run and validates the
// sessionId so the recursive remove can only ever touch a single session
// folder under the autopilot storage root.
ipcMain.handle('autopilot:deleteRun', (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  if (!sessionId || !isSafeAutopilotSessionId(sessionId)) {
    return { ok: false, error: 'invalid sessionId' };
  }
  const isActive = [...runs.values()].some((r) => r.runner && r.runner.sessionId === sessionId);
  if (isActive) {
    return { ok: false, error: 'cannot delete the run that is still active' };
  }
  const dir = path.join(autopilotStorageRoot(), 'sessions', sessionId);
  const root = path.join(autopilotStorageRoot(), 'sessions');
  // Belt and suspenders: the resolved target must sit directly under the
  // sessions root and not be the root itself.
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(root) || path.dirname(resolved) !== path.resolve(root)) {
    return { ok: false, error: 'path escapes autopilot storage' };
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- resolved confined to sessions root above
    fs.rmSync(resolved, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'delete failed' };
  }
});

// Per-file diff for a single touched file. Reads the pre-run blob
// from the snapshot store (decrypts if needed) and the live
// workspace file. Renderer computes the line-by-line diff for the
// modal viewer. Capped at 1 MB per side and 6000 lines per side so
// huge binary files do not blow up memory.
const FILE_DIFF_MAX_BYTES = 1024 * 1024;
const FILE_DIFF_MAX_LINES = 6000;
ipcMain.handle('autopilot:fileDiff', async (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  const relPath = String(payload && payload.path || '').trim();
  if (!sessionId || !relPath) {
    return { ok: false, error: 'sessionId and path required' };
  }
  if (!isSafeAutopilotSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  // The run's files live in its own worktree, so the workspace resolves
  // from the session record (manifest, else the run_identity audit row)
  // rather than from the caller: callers carry the origin project as a
  // label, and the "after" side of the diff only exists in the worktree.
  // Caller value is a fallback for legacy sessions with no recorded root.
  const workspaceRoot = manifestWorkspaceRoot(sessionId)
    || String(payload && payload.workspaceRoot || '').trim();
  if (!workspaceRoot) return { ok: false, error: 'no workspace recorded for this session' };
  // Path traversal guard: reuse the snapshot joinSafely contract.
  const safeWorkspace = path.resolve(workspaceRoot);
  const safeAbs = path.resolve(safeWorkspace, relPath);
  if (!(safeAbs === safeWorkspace || safeAbs.startsWith(safeWorkspace + path.sep))) {
    return { ok: false, error: 'path escapes workspace' };
  }
  const storageRoot = autopilotStorageRoot();
  const sessDir = path.join(storageRoot, 'sessions', sessionId);
  const manifestPath = path.join(sessDir, 'snapshot.json');
  // Snapshot-off runs write no manifest; every file then diffs as
  // added against an empty "before", which is the honest view.
  let manifest = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to storageRoot
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {}
  const entry = manifest && manifest.entries && manifest.entries[relPath];

  let before = '';
  let beforeBytes = 0;
  let beforeTooLarge = false;
  if (entry && entry.type === 'file' && /^[a-f0-9]{64}$/.test(entry.sha || '')) {
    const blobPath = path.join(sessDir, 'blobs', entry.sha);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to storageRoot
      let buf = fs.readFileSync(blobPath);
      const { decrypt } = autopilotCrypto();
      if (typeof decrypt === 'function') {
        try { buf = decrypt(buf); } catch (_) {}
      }
      beforeBytes = buf.length;
      if (buf.length > FILE_DIFF_MAX_BYTES) { beforeTooLarge = true; before = ''; }
      else before = buf.toString('utf8');
    } catch (err) {
      return { ok: false, error: `could not read pre-run blob: ${err.message}` };
    }
  }

  let after = '';
  let afterBytes = 0;
  let afterTooLarge = false;
  let exists = false;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeAbs bounded under safeWorkspace
    if (fs.existsSync(safeAbs)) {
      exists = true;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- safeAbs bounded
      const buf = fs.readFileSync(safeAbs);
      afterBytes = buf.length;
      if (buf.length > FILE_DIFF_MAX_BYTES) { afterTooLarge = true; after = ''; }
      else after = buf.toString('utf8');
    }
  } catch (err) {
    return { ok: false, error: `could not read workspace file: ${err.message}` };
  }

  // Status: added if no pre-run entry; deleted if entry but no live file; else modified.
  let status = 'modified';
  if (!entry) status = 'added';
  else if (!exists) status = 'deleted';

  // Line count guard - if either side too long, signal renderer to
  // show summary instead of inlining the diff.
  const linesBefore = before ? before.split('\n').length : 0;
  const linesAfter = after ? after.split('\n').length : 0;
  const tooLarge = beforeTooLarge || afterTooLarge || linesBefore > FILE_DIFF_MAX_LINES || linesAfter > FILE_DIFF_MAX_LINES;

  return {
    ok: true,
    path: relPath,
    status,
    before: tooLarge ? '' : before,
    after: tooLarge ? '' : after,
    beforeBytes,
    afterBytes,
    linesBefore,
    linesAfter,
    tooLarge,
  };
});

// Live diff while a run is active. Caller polls every few seconds
// from the Autopilot page. Uses the async walker so we never freeze
// the main process for a multi-second diff. Targets the run named by
// runId; falls back to the first active run when none is supplied.
ipcMain.handle('autopilot:liveDiff', async (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  const r = runId ? runs.get(runId) : [...runs.values()][0];
  if (!r) return { ok: false, error: 'no active run' };
  try {
    const res = await Autopilot.snapshot.diffWorkspaceAsync(
      r.runner.workspaceRoot,
      autopilotStorageRoot(),
      r.runner.sessionId,
    );
    return res;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('autopilot:summary', async (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  if (!isSafeAutopilotSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  const { decrypt } = autopilotCrypto();
  // Diff the recorded workspace only, never a caller-supplied path, so this
  // read cannot be used to enumerate an arbitrary directory tree. Use the
  // async walker so loading a past run from history does not freeze the UI.
  const workspaceRoot = manifestWorkspaceRoot(sessionId);
  return Autopilot.supervisor.summarizeRunAsync({
    sessionId,
    workspaceRoot,
    storageRoot: autopilotStorageRoot(),
    decrypt,
  });
});

// Fleet Receipt: aggregate a set of finished runs into one shareable
// summary (total spend, what landed, and the waste the governor caught).
// The renderer passes the fleet it launched as [{ sessionId, agent,
// model }]; each run is summarized from its own audit log (authoritative
// and resilient even after its worktree was applied or discarded), then
// folded into the receipt. Pure aggregation lives in autonomy/receipt.
ipcMain.handle('autopilot:receipt', async (_e, payload = {}) => {
  const items = Array.isArray(payload && payload.runs) ? payload.runs : [];
  if (!items.length) return { ok: false, error: 'runs required' };
  const { decrypt } = autopilotCrypto();
  const storageRoot = autopilotStorageRoot();
  const rows = [];
  for (const it of items) {
    const sessionId = String(it && it.sessionId || '').trim();
    if (!sessionId || !isSafeAutopilotSessionId(sessionId)) continue;
    try {
      const sum = await Autopilot.supervisor.summarizeRunAsync({
        sessionId,
        workspaceRoot: manifestWorkspaceRoot(sessionId),
        storageRoot,
        decrypt,
      });
      if (sum && sum.ok) {
        rows.push(Autopilot.receipt.fromSummary(sum, {
          agent: it.agent || null,
          model: it.model || null,
          fleetStartedAt: Number(it.fleetStartedAt) || Number(sum.fleetStartedAt) || 0,
        }));
      }
    } catch (_) { /* skip a run that cannot be summarized rather than fail the whole receipt */ }
  }
  const receipt = Autopilot.receipt.buildFleetReceipt(rows, {
    label: typeof payload.label === 'string' ? payload.label.slice(0, 80) : null,
  });
  return { ok: true, receipt };
});

// ─── Model catalog IPC ───────────────────────────────────────────────────────────

const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const MODEL_PROBE_TIMEOUT_MS = 11000;
const MODEL_PROBE_OUTPUT_CAP = 256 * 1024;
const modelCatalogCache = new Map();

function modelProbeCwd() {
  if (Array.isArray(config.projects) && config.activeProjectId) {
    const active = config.projects.find((p) => p && p.id === config.activeProjectId);
    if (active && active.path) {
      try {
        if (fs.existsSync(active.path) && fs.statSync(active.path).isDirectory()) return active.path;
      } catch (_) {}
    }
  }
  if (config.agentCwd && typeof config.agentCwd === 'string') {
    try {
      if (fs.existsSync(config.agentCwd) && fs.statSync(config.agentCwd).isDirectory()) return config.agentCwd;
    } catch (_) {}
  }
  return HOME;
}

function safeAgentCommandHead(agentCommand) {
  const tokens = String(agentCommand || 'claude').trim().split(/\s+/).filter(Boolean);
  const exe = tokens[0] || 'claude';
  const base = agentBaseName(exe);
  if (!modelFlagFor(base)) return null;
  return { exe, base };
}

function savedRoutingModels(vendor) {
  const entry = config.modelRouting && typeof config.modelRouting === 'object'
    ? config.modelRouting[vendor]
    : null;
  if (!entry || typeof entry !== 'object') return [];
  return uniqueModels(['cheap', 'smart']
    .map((k) => entry[k])
    .filter((value) => isModelValueUsable(value, vendor))
    .map((value) => ({ value, label: `${titleFromId(value)} (saved)` })));
}

function slashProbeArgs(vendor) {
  if (vendor === 'copilot') {
    return ['--no-color', '--no-auto-update', '--no-remote-export', '--no-custom-instructions', '--log-level', 'none', '--screen-reader'];
  }
  if (vendor === 'claude') {
    return ['--ax-screen-reader'];
  }
  if (vendor === 'gemini') {
    return ['--screen-reader', '--skip-trust'];
  }
  return [];
}

function runSlashModelProbe(agentCommand, vendor) {
  return new Promise((resolve) => {
    const head = safeAgentCommandHead(agentCommand);
    if (!head) return resolve({ ok: false, output: '', error: 'active agent is not supported for model discovery' });
    const env = Object.assign(buildAgentEnv(), {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      NO_COLOR: '1',
      HUSK_MODEL_PROBE: '1',
    });
    const exe = resolveAgentExe(head.exe, env.PATH);
    const args = slashProbeArgs(vendor);
    let child;
    try {
      child = pty.spawn(exe, args, {
        name: 'xterm-256color',
        cols: 160,
        rows: 48,
        cwd: modelProbeCwd(),
        env,
      });
    } catch (err) {
      return resolve({ ok: false, output: '', error: (err && err.message) || String(err) });
    }

    let output = '';
    let settled = false;
    const timers = [];
    const done = (result) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try { child.kill(); } catch (_) {}
      resolve(result);
    };
    // Slow-mounting TUIs eat the /model keystrokes if sent too early:
    // copilot needs the longest settle, claude a moderate one.
    const submitDelay = vendor === 'copilot' ? 2800 : (vendor === 'claude' ? 1800 : 900);
    timers.push(setTimeout(() => { try { child.write('/model\r'); } catch (_) {} }, submitDelay));
    timers.push(setTimeout(() => { try { child.write('\x1b'); } catch (_) {} }, submitDelay + 5200));
    timers.push(setTimeout(() => { try { child.write('\x03'); } catch (_) {} }, submitDelay + 5500));
    timers.push(setTimeout(() => {
      done({ ok: output.trim().length > 0, output, error: output.trim() ? '' : 'model picker produced no output' });
    }, MODEL_PROBE_TIMEOUT_MS));
    child.onData((d) => {
      if (output.length < MODEL_PROBE_OUTPUT_CAP) output += String(d);
    });
    child.onExit(() => {
      done({ ok: output.trim().length > 0, output, error: output.trim() ? '' : 'model picker exited with no output' });
    });
  });
}

function runAiderModelProbe(agentCommand) {
  return new Promise((resolve) => {
    const head = safeAgentCommandHead(agentCommand);
    if (!head) return resolve({ ok: false, output: '', error: 'active agent is not supported for model discovery' });
    const env = Object.assign(buildAgentEnv(), { NO_COLOR: '1', HUSK_MODEL_PROBE: '1' });
    const exe = resolveAgentExe(head.exe, env.PATH);
    let child;
    try {
      child = spawn(exe, ['--list-models', '', '--no-check-model-accepts-settings'], {
        cwd: modelProbeCwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ ok: false, output: '', error: (err && err.message) || String(err) });
    }
    let output = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve(result);
    };
    const collect = (d) => {
      if (output.length < MODEL_PROBE_OUTPUT_CAP) output += String(d);
    };
    const timer = setTimeout(() => {
      done({ ok: output.trim().length > 0, output, error: output.trim() ? '' : 'model list timed out' });
    }, MODEL_PROBE_TIMEOUT_MS);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => done({ ok: false, output, error: (err && err.message) || String(err) }));
    child.on('close', () => done({ ok: output.trim().length > 0, output, error: output.trim() ? '' : 'model list exited with no output' }));
  });
}

// What the CLI itself calls a model, taken from the catalog its own /model
// picker produced. Deriving a name from the id can only ever print what the id
// already spells out: the alias "opus[1m]" carries no version, so it reads as a
// bare "Opus" until a transcript turn happens to name the full id. The catalog
// is the provider's own wording, so a model Husk has never heard of arrives
// correctly named the day it ships.
//
// Returns '' for a full versioned id such as claude-opus-5, on purpose: the
// name derived from it is already right, and resolving it through an alias row
// would report whatever the alias points at today, relabelling an older session
// as the current model. '' is also the answer before the catalog has been read.
// Both cases leave the id-derived name in place.
function catalogModelLabel(id, command = null) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const head = safeAgentCommandHead(command || config.agentCommand || 'claude');
  if (!head) return '';
  const cached = modelCatalogCache.get(`${head.base}:${head.exe}`);
  const models = cached && cached.value && Array.isArray(cached.value.models) ? cached.value.models : null;
  if (!models || !models.length) return '';
  // Compare with the context tier and vendor prefix removed, so "opus[1m]",
  // "opus" and "claude-opus-5" all reach the same catalog row.
  const key = (s) => String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/^claude-/, '');
  const want = key(raw);
  const hit = models.find((m) => key(m.value) === want);
  if (!hit) return '';
  // Catalog labels read "Opus 5 With 1M Context · Best for everyday use". The
  // panel wants the model's name: not the blurb, and not the context tier,
  // which it already reports on its own row and which is a property of the
  // session rather than part of what the model is called. The dropdown keeps
  // the full wording, since choosing a tier is the point there.
  return String(hit.label || '').split('·')[0]
    .replace(/\bwith\s+1m\s+context\b/ig, '')
    .replace(/\(1m context\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function discoverModelCatalog({ refresh = false, command = null, fast = false } = {}) {
  // `command` lets a caller ask for a specific vendor's models (a workflow step
  // can run a different agent than the active one). Falls back to the active
  // agent when omitted, which is what the Autopilot page wants.
  const rawCommand = command || config.agentCommand || 'claude';
  const head = safeAgentCommandHead(rawCommand);
  const vendor = head ? head.base : agentBaseName(rawCommand);
  const flag = modelFlagFor(vendor);
  const base = {
    ok: true,
    vendor,
    providerLabel: providerLabel(vendor),
    command: head ? head.exe : String(rawCommand || '').trim().split(/\s+/)[0],
    supported: !!(head && flag),
    flag,
    models: [],
    source: 'none',
    sourceLabel: 'No live catalog',
  };
  if (!base.supported) {
    return Object.assign(base, {
      ok: false,
      error: head ? `${providerLabel(vendor)} does not expose a model flag Husk can route yet.` : 'Active agent command is not supported.',
    });
  }

  // Fast path: the known catalog plus any saved selections, with no live probe.
  // The live probe spawns the CLI in a PTY and drives its /model picker, which
  // takes seconds and can hang; a builder switching agents must not wait on that.
  // Callers use fast for the dropdown and pass refresh only on an explicit reload.
  if (fast && !refresh) {
    const cached = modelCatalogCache.get(`${vendor}:${head.exe}`);
    if (cached && cached.value && (cached.value.models || []).length) {
      return Object.assign({}, cached.value, { cached: true });
    }
    const known = uniqueModels([...fallbackModelsFor(vendor), ...savedRoutingModels(vendor)]);
    return Object.assign(base, {
      models: known,
      source: known.length ? 'fallback' : 'none',
      sourceLabel: known.length ? 'Known models. Refresh to read the live list.' : 'No models known; Refresh to read the live list.',
    });
  }

  const cacheKey = `${vendor}:${head.exe}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.cachedAt < MODEL_CATALOG_TTL_MS) {
    return Object.assign({}, cached.value, { cached: true });
  }

  const probe = vendor === 'aider'
    ? await runAiderModelProbe(rawCommand)
    : await runSlashModelProbe(rawCommand, vendor);
  const probeOutput = probe.output || '';
  const authBlocked = vendor === 'copilot' && /not logged in to select a model|use \/login to authenticate/i.test(probeOutput);
  const partialCopilotCatalog = vendor === 'copilot' && !/Model\b[\s\S]{0,80}\bReasoning/i.test(probeOutput);
  const liveModels = (authBlocked || partialCopilotCatalog) ? [] : parseModelCatalog(probeOutput, vendor);
  const savedModels = savedRoutingModels(vendor);
  const fallbackModels = (!liveModels.length && !authBlocked) ? fallbackModelsFor(vendor) : [];
  const models = uniqueModels([...liveModels, ...fallbackModels, ...savedModels]);
  const value = Object.assign(base, {
    models,
    source: liveModels.length ? (vendor === 'aider' ? 'list-models' : 'slash-model') : (fallbackModels.length ? 'fallback' : (savedModels.length ? 'saved' : 'none')),
    sourceLabel: liveModels.length
      ? (vendor === 'aider' ? 'Read from aider --list-models' : 'Read from /model')
      : (fallbackModels.length ? 'Known provider catalog' : (savedModels.length ? 'Saved selections' : 'No models discovered')),
    error: (liveModels.length || fallbackModels.length) ? '' : (authBlocked
      ? 'Copilot requires login before it will list models.'
      : (partialCopilotCatalog ? 'Copilot model picker did not finish loading. Refresh models to retry.' : ((probe && probe.error) || 'No models were found in the provider output.'))),
  });
  modelCatalogCache.set(cacheKey, { cachedAt: Date.now(), value });
  return value;
}

ipcMain.handle('models:list', async (_e, opts = {}) => discoverModelCatalog({ refresh: !!(opts && opts.refresh), fast: !!(opts && opts.fast), command: opts && opts.command ? String(opts.command) : null }));

// ─── Config IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => ({ ...config }));
ipcMain.handle('config:set', (_e, partial) => {
  const paiChanged = Object.prototype.hasOwnProperty.call(partial || {}, 'paiEnabled')
    && partial.paiEnabled !== config.paiEnabled;
  config = { ...config, ...partial };
  saveConfig(config);
  if (paiChanged) {
    // Park or restore ~/.claude/CLAUDE.md so the next agent restart sees the
    // selected PAI instruction state. The statusline tick follows the same
    // setting; bootstrap files on disk are left intact.
    applyPaiState(config.paiEnabled !== false);
    if (config.paiEnabled !== false) startStatuslineRefresh();
    else stopStatuslineRefresh();
  }
  return { ...config };
});

// Probe well-known CLI agents on PATH so the rail's quick-switcher and the
// first-launch wizard can show which ones are actually installed. Cheap
// synchronous PATH walk, no subprocess. On Windows we also walk PATHEXT
// (.cmd, .bat, .exe) because npm-installed CLIs land as <name>.cmd shims
// and Win32 file lookup does NOT auto-append PATHEXT.
const KNOWN_AGENTS = [
  {
    id: 'claude', label: 'Claude Code', command: 'claude',
    install: { tool: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
    docs: 'https://docs.anthropic.com/claude/docs/claude-code',
  },
  {
    id: 'copilot', label: 'GitHub Copilot CLI', command: 'copilot',
    install: { tool: 'npm', args: ['install', '-g', '@github/copilot'] },
    docs: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli',
  },
  {
    id: 'codex', label: 'OpenAI Codex CLI', command: 'codex',
    install: { tool: 'npm', args: ['install', '-g', '@openai/codex'] },
    docs: 'https://github.com/openai/codex',
  },
  {
    id: 'aider', label: 'Aider', command: 'aider',
    install: { tool: 'pipx', args: ['install', 'aider-chat'] },
    docs: 'https://aider.chat/docs/install.html',
  },
  {
    id: 'gemini', label: 'Gemini CLI', command: 'gemini',
    install: { tool: 'npm', args: ['install', '-g', '@google/gemini-cli'] },
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
];

// loginShellPath() returns the PATH a login+interactive shell produces (which
// sources .profile/.bashrc and so includes ~/.local/bin, nvm, etc). A
// GUI/desktop launch inherits a stripped systemd PATH, so a bare process.env
// .PATH check misreports CLIs like claude (installed in ~/.local/bin) as
// missing -- which is exactly what the first-launch wizard showed when Husk was
// started from the taskbar instead of a terminal. Cached: one subprocess for
// the whole session. Returns '' on win32 or on failure.
let _loginShellPathCache;
function loginShellPath() {
  if (_loginShellPathCache !== undefined) return _loginShellPathCache;
  _loginShellPathCache = '';
  if (process.platform === 'win32') return _loginShellPathCache;
  try {
    const { spawnSync } = require('child_process');
    const shellBin = (typeof process.env.SHELL === 'string' && process.env.SHELL) ? process.env.SHELL : '/bin/bash';
    const res = spawnSync(shellBin, ['-ilc', `echo "${MARKER_START}\${PATH}${MARKER_END}"`], { encoding: 'utf8', timeout: 5000 });
    const p = parseShellPathOutput((res && res.stdout) || '');
    if (p) _loginShellPathCache = p;
  } catch (_) {}
  return _loginShellPathCache;
}

// extraAgentBinDirs() are user-install locations that a GUI/desktop launch's
// PATH omits and that even a login shell does not reliably restore (bash login
// shells read .bash_profile, not .profile/.bashrc, so ~/.local/bin can be
// missing). These are the SAME dirs the agent spawn force-prepends, so that
// "FOUND" in the wizard always implies the spawn will actually resolve the CLI.
function extraAgentBinDirs() {
  if (process.platform === 'win32') return [];
  return [path.join(HOME, '.local', 'bin'), path.join(HOME, '.bun', 'bin')];
}

function isOnPath(binName) {
  const isWin = process.platform === 'win32';
  // Union of: the inherited PATH, the login-shell PATH (nvm/pyenv/etc), and the
  // known user-install dirs. Deduped in order, so detection is correct whether
  // Husk was launched from a terminal or the GUI.
  const seen = new Set();
  const dirs = [process.env.PATH || '', isWin ? '' : loginShellPath()]
    .flatMap((p) => p.split(path.delimiter))
    .concat(extraAgentBinDirs())
    .filter((d) => d && !seen.has(d) && seen.add(d));
  const candidates = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => binName + e)
    : [binName];
  for (const d of dirs) {
    for (const c of candidates) {
      try {
        const p = path.join(d, c);
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (isWin) return true;
        if (st.mode & 0o111) return true;
      } catch (_) {}
    }
  }
  return false;
}

ipcMain.handle('agents:detect', () => {
  // Probe the install tools too so the renderer can decide between Install
  // and 'Open install page'. npm and pipx are the most likely available.
  const tools = {
    npm: isOnPath('npm'),
    pipx: isOnPath('pipx'),
    pip: isOnPath('pip') || isOnPath('pip3'),
  };
  return {
    agents: KNOWN_AGENTS.map((a) => ({
      id: a.id,
      label: a.label,
      command: a.command,
      docs: a.docs,
      installer: a.install ? a.install.tool : null,
      installable: a.install ? !!tools[a.install.tool] : false,
      available: isOnPath(a.command),
    })),
    tools,
    platform: process.platform,
  };
});

// Run the install command for a known agent and stream progress lines back to
// the renderer over the 'agents:install:progress' event. Resolves with
// { ok, code, error? } when the subprocess exits.
ipcMain.handle('agents:install', async (_e, { id }) => {
  const def = KNOWN_AGENTS.find((a) => a.id === id);
  if (!def || !def.install) return { ok: false, error: 'unknown agent' };
  const { tool, args } = def.install;
  if (!isOnPath(tool)) return { ok: false, error: `${tool} is not installed; open the docs link to install ${def.label} manually.` };
  return new Promise((resolve) => {
    let proc;
    const send = (line) => {
      if (mainWindow) mainWindow.webContents.send('agents:install:progress', { id, line });
    };
    try {
      // shell:false. spawn looks the tool up via PATH; on Windows we also
      // get PATHEXT resolution since spawn calls ShellExecuteEx-equivalent.
      proc = spawn(tool, args, { shell: process.platform === 'win32', windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    send(`$ ${tool} ${args.join(' ')}`);
    proc.stdout.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => l && send(l)));
    proc.stderr.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => l && send(l)));
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      if (code === 0) {
        send('done.');
        resolve({ ok: true, code, available: isOnPath(def.command) });
      } else {
        send(`exited ${code}`);
        resolve({ ok: false, code, error: `${tool} exited with code ${code}` });
      }
    });
  });
});

// ─── MCP servers (~/.claude.json mcpServers) ────────────────────────────────────
// We treat ~/.claude.json's `mcpServers` object as the source of truth (Claude
// Code's user-scoped MCP config). For "disabled" state, we move entries to a
// Husk-private key `_huskMcpDisabled` so a toggle never loses configuration,
// just hides it from claude until re-enabled.
// Curated list of well-known MCP servers users can install in one click.
// Each entry can declare required env vars; the renderer prompts for them.
// Anything that requires a path uses kind:'path' so the renderer opens the
// directory picker.
const MCP_CATALOG = [
  {
    id: 'filesystem',
    name: 'Filesystem (sandbox)',
    description: 'Restrict the agent to one folder. The agent already reads and writes files; this MCP confines it to a path you pick.',
    icon: '▤',
    template: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<PATH>'] },
    inputs: [{ id: 'PATH', label: 'Folder the agent may access', kind: 'path', required: true }],
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Structured key-value memory the agent reuses across conversations. Cleaner than asking the agent to read its own notes file.',
    icon: '◎',
    template: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    inputs: [],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Typed GitHub API tools (search code, list issues, open PRs) over a personal token. No gh CLI needed.',
    icon: '⌘',
    template: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    inputs: [{ id: 'GITHUB_PERSONAL_ACCESS_TOKEN', label: 'GitHub Personal Access Token', kind: 'secret', required: true,
              hint: 'Create one at github.com/settings/tokens. Needs repo scope at minimum.' }],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Timezone-aware time tools. Useful when the agent needs to reason about dates in a specific zone.',
    icon: '◷',
    template: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-time'] },
    inputs: [],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Cleaner URL fetcher with HTML to text extraction. Easier on the agent than parsing raw HTML itself.',
    icon: '⇗',
    template: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-fetch'] },
    inputs: [],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Structured web search results (titles, snippets, URLs) without scraping a search page.',
    icon: '⊙',
    template: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'] },
    inputs: [{ id: 'BRAVE_API_KEY', label: 'Brave API Key', kind: 'secret', required: true,
              hint: 'Get a free key at api-dashboard.search.brave.com' }],
    envKeys: ['BRAVE_API_KEY'],
  },
];

ipcMain.handle('mcp:catalog', () => MCP_CATALOG);

// Health still routes through the active CLI because only that CLI can report
// live connection state. Configuration writes go through SharedMcp below:
// one Husk MCP set is mirrored to every write-capable vendor adapter, so
// switching claude <-> copilot <-> gemini does not require reinstalling MCPs.
function activeMcpAdapter() {
  return getMcpAdapter(config.agentCommand);
}

ipcMain.handle('mcp:list', () => {
  const active = activeMcpAdapter();
  const result = SharedMcp.list(config.agentCommand);
  return {
    ...result,
    agent: active.agent,
    activeAgent: active.agent,
    supportsWrite: true,
    supportsLiveStatus: active.supportsLiveStatus,
  };
});

ipcMain.handle('mcp:health', () => activeMcpAdapter().health());
ipcMain.handle('mcp:add', (_e, payload = {}) => SharedMcp.add(payload));
ipcMain.handle('mcp:update', (_e, payload = {}) => {
  // `id` is the (possibly edited) name from the form; `oldId` is the
  // original key. Locate by oldId, pass the new name as `newId` so the
  // shared layer can rewrite the JSON key when the two differ.
  const { id, oldId, ...rest } = payload || {};
  return SharedMcp.update(oldId || id, { ...rest, newId: id });
});
ipcMain.handle('mcp:remove', (_e, id) => SharedMcp.remove(id));
ipcMain.handle('mcp:toggle', (_e, id) => SharedMcp.toggle(id, config.agentCommand));

// addMany takes a list of canonical payloads (each already split into
// command/args + transport per the buildServerEntry contract) and tries
// to add() each one. Returns a per-id status map so the renderer can
// show which succeeded vs. which already existed vs. which errored.
ipcMain.handle('mcp:addMany', (_e, payload = {}) => {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!items.length) return { ok: false, error: 'no items supplied' };
  return SharedMcp.addMany(items);
});

// Lenient JSON parser surface. The renderer hands the raw textarea
// content; we return either { ok: true, entries: [{ id, payload }] }
// where each payload is already shapeEntry()-ed and ready for add()
// or update(), or { ok: false, error } for the user to fix and retry.
const McpJson = require('./lib/mcp-json');
ipcMain.handle('mcp:parseSnippet', (_e, payload = {}) => {
  const text = (payload && typeof payload.text === 'string') ? payload.text : '';
  const parsed = McpJson.parseLooseMcpJson(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  // Shape each entry, but tolerate per-entry errors so the renderer can
  // surface the bad ones and still proceed with the good ones.
  const items = [];
  const errors = [];
  for (const e of parsed.entries) {
    const shaped = McpJson.shapeEntry(e.id, e.entry);
    if (shaped.ok) items.push(shaped.payload);
    else errors.push({ id: e.id || '<unnamed>', error: shaped.error });
  }
  return { ok: true, items, errors };
});

// ─── Stats (statusline data) ─────────────────────────────────────────────────────

function safeCount(dir, predicate) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(predicate).length; }
  catch (_) { return 0; }
}
function readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } }
function countLines(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; } }

// Resolve the active agent CLI's version by running `<cmd> --version`. Uses the
// agent spawn env so the command resolves against the user's real PATH (a macOS
// GUI app starts with a minimal PATH that augmentUserPathAsync fills in shortly
// after launch). Only a successful lookup is cached, so an early poll that runs
// before the PATH is ready retries on the next poll instead of sticking.
const _agentVersionCache = {};
function getAgentVersion(cmd) {
  if (_agentVersionCache[cmd]) return _agentVersionCache[cmd];
  let v = '';
  try {
    const out = require('child_process').execFileSync(cmd, ['--version'], { timeout: 4000, encoding: 'utf8', env: buildAgentEnv() });
    const m = String(out).match(/\d+\.\d+(?:\.\d+)?/);
    v = m ? m[0] : String(out).trim().split('\n')[0].slice(0, 40);
  } catch (_) { v = ''; }
  if (v) _agentVersionCache[cmd] = v;
  return v;
}

// Compact git summary for the status panel: branch, ahead/behind, and the
// count of dirty (staged, unstaged, or untracked) paths. Vendor-neutral and
// fast; bounded by a short timeout so a slow repo never stalls the panel.
function gitSummary(cwd) {
  const dir = cwd || HOME;
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore', timeout: 1500 });
  } catch (_) { return { isRepo: false }; }
  try {
    const out = execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '--branch'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2500 });
    const lines = out.split('\n');
    let branch = '';
    let ahead = 0;
    let behind = 0;
    let dirty = 0;
    for (const ln of lines) {
      if (!ln) continue;
      if (ln.startsWith('## ')) {
        // "## main...origin/main [ahead 2, behind 1]" or "## HEAD (no branch)"
        const head = ln.slice(3);
        branch = head.split(/\.\.\.| \(|\s\[/)[0].trim();
        const am = head.match(/ahead (\d+)/); if (am) ahead = Number(am[1]);
        const bm = head.match(/behind (\d+)/); if (bm) behind = Number(bm[1]);
      } else {
        dirty += 1;
      }
    }
    return { isRepo: true, branch, ahead, behind, dirty };
  } catch (_) { return { isRepo: true, branch: '', ahead: 0, behind: 0, dirty: 0 }; }
}

// Session stats for a Copilot chat, read from its own transcript at
// <COPILOT_HOME>/session-state/<uuid>/events.jsonl. Returns the live model
// (from session.model_change), the turn count, and the summed output
// tokens Copilot records per assistant message. Copilot does not log
// input/context-window totals, so ctxTokens/ctxWindow stay 0 and the
// panel's Context Window row is correctly omitted for it. Picks the
// newest session whose workspace cwd matches the active chat's cwd.
function readCopilotSessionStats(cwd) {
  const root = path.join(COPILOT_DIR, 'session-state');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (_) { return null; }
  const wantCwd = cwd ? path.resolve(cwd) : null;
  let best = null;
  let bestMtime = -1;
  for (const d of dirs) {
    const full = path.join(root, d.name);
    const ws = readCopilotWorkspace(full);
    if (!ws) continue;
    if (wantCwd && ws.cwd && path.resolve(ws.cwd) !== wantCwd) continue;
    let mt = 0;
    try { mt = fs.statSync(path.join(full, 'events.jsonl')).mtimeMs; } catch (_) { continue; }
    if (mt > bestMtime) { bestMtime = mt; best = path.join(full, 'events.jsonl'); }
  }
  if (!best) return null;
  let raw = '';
  try {
    const CAP = 512 * 1024;
    // Open once and size/read through the same descriptor so the file can't
    // be swapped between the size check and the read (the path is resolved
    // a single time). On a huge transcript keep only the trailing CAP bytes.
    const fd = fs.openSync(best, 'r');
    try {
      const sz = fs.fstatSync(fd).size;
      const len = Math.min(sz, CAP);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, sz > CAP ? sz - CAP : 0);
      raw = b.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
  let model = '';
  let turns = 0;
  let outTokens = 0;
  let currentTokens = 0;
  let conversationTokens = 0;
  let systemTokens = 0;
  let toolDefinitionsTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let premiumRequests = 0;
  let apiDurationMs = 0;
  let totalNanoAiu = 0;
  let requestCount = 0;
  let metricOutputTokens = 0;
  const modelMetricTotals = new Map();
  const asNum = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    const t = o && o.type;
    const data = (o && o.data) || {};
    if (t === 'session.model_change' && typeof data.newModel === 'string') model = data.newModel;
    else if (t === 'user.message' || t === 'assistant.message') {
      turns += 1;
      if (t === 'assistant.message' && typeof data.model === 'string' && data.model) model = data.model;
    }
    if (typeof data.outputTokens === 'number') outTokens += data.outputTokens;
    if (t === 'session.shutdown') {
      if (typeof data.currentModel === 'string' && data.currentModel) model = data.currentModel;
      currentTokens = Math.max(currentTokens, asNum(data.currentTokens));
      conversationTokens = Math.max(conversationTokens, asNum(data.conversationTokens));
      systemTokens = Math.max(systemTokens, asNum(data.systemTokens));
      toolDefinitionsTokens = Math.max(toolDefinitionsTokens, asNum(data.toolDefinitionsTokens));
      premiumRequests = Math.max(premiumRequests, asNum(data.totalPremiumRequests));
      apiDurationMs = Math.max(apiDurationMs, asNum(data.totalApiDurationMs));
      totalNanoAiu = Math.max(totalNanoAiu, asNum(data.totalNanoAiu));
      const metrics = data.modelMetrics && typeof data.modelMetrics === 'object' ? data.modelMetrics : {};
      for (const [key, m] of Object.entries(metrics)) {
        if (!m || typeof m !== 'object') continue;
        const usage = m.usage && typeof m.usage === 'object' ? m.usage : {};
        const req = m.requests && typeof m.requests === 'object' ? m.requests : {};
        const prev = modelMetricTotals.get(key) || {};
        modelMetricTotals.set(key, {
          outputTokens: Math.max(asNum(prev.outputTokens), asNum(usage.outputTokens)),
          cacheReadTokens: Math.max(asNum(prev.cacheReadTokens), asNum(usage.cacheReadTokens)),
          cacheWriteTokens: Math.max(asNum(prev.cacheWriteTokens), asNum(usage.cacheWriteTokens)),
          reasoningTokens: Math.max(asNum(prev.reasoningTokens), asNum(usage.reasoningTokens)),
          requestCount: Math.max(asNum(prev.requestCount), asNum(req.count)),
          totalNanoAiu: Math.max(asNum(prev.totalNanoAiu), asNum(m.totalNanoAiu)),
        });
      }
    }
  }
  for (const m of modelMetricTotals.values()) {
    metricOutputTokens += asNum(m.outputTokens);
    cacheReadTokens += asNum(m.cacheReadTokens);
    cacheWriteTokens += asNum(m.cacheWriteTokens);
    reasoningTokens += asNum(m.reasoningTokens);
    requestCount += asNum(m.requestCount);
    totalNanoAiu = Math.max(totalNanoAiu, asNum(m.totalNanoAiu));
  }
  outTokens = Math.max(outTokens, metricOutputTokens);
  if (!model && turns === 0 && outTokens === 0 && currentTokens === 0) return null;
  return {
    model, turns, tokens: outTokens, outputTokens: outTokens,
    currentTokens, conversationTokens, systemTokens, toolDefinitionsTokens,
    cacheReadTokens, cacheWriteTokens, reasoningTokens,
    premiumRequests, requestCount, apiDurationMs, totalNanoAiu,
    ctxTokens: 0, ctxWindow: 0, ctxPct: 0, partialTokens: true,
  };
}

// Parse a CLI's own session usage counter out of its status line. Copilot
// prints "Session: N AIC used" (AI credits). Returns the number or null.
function parseAgentSessionUsage(agentCmd, tail) {
  if (!tail) return null;
  const clean = stripAnsi(tail);
  if (agentCmd === 'copilot') {
    // Keep the last occurrence: the status line is repainted, so the newest
    // frame in the tail holds the current count.
    let n = null;
    const re = /Session:\s*([\d,]+)\s*AIC used/gi;
    let m;
    while ((m = re.exec(clean)) !== null) n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Compact MCP summary for the status panel: how many servers the active
// agent has configured. Reads the agent's config only (cheap); live health
// stays on the MCP page where its async probe runs.
function mcpSummary() {
  try {
    const r = SharedMcp.list(config.agentCommand, { sync: false });
    const servers = (r && Array.isArray(r.servers)) ? r.servers : [];
    return {
      count: servers.length,
      enabled: servers.filter((s) => s.enabled !== false).length,
      supported: true,
    };
  } catch (_) { return { count: 0, enabled: 0, supported: false }; }
}

ipcMain.handle('stats:get', () => {
  const agentCmd = (config.agentCommand || 'claude').trim().split(/\s+/)[0].toLowerCase();
  // The model, per-session context, and plan-usage caches all come from
  // ~/.claude state and describe the Claude CLI only. For any other agent
  // they would surface a different, unrelated Claude session's model and
  // usage, so they are read solely when the active agent is claude.
  const agentIsClaude = agentCmd === 'claude';
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  const skills = safeCount(skillsDir, (d) => d.isDirectory());
  const workflowsDir = path.join(CLAUDE_DIR, 'workflows');
  const workflows = safeCount(workflowsDir, (e) => e.isFile() && e.name.endsWith('.md'))
                  + safeCount(workflowsDir, (e) => e.isDirectory());
  // Hooks are per-agent: Claude runs ~/.claude/hooks/*.hook.ts, Copilot
  // runs <COPILOT_HOME>/hooks/*.json. Count and expose whichever the active
  // agent uses; agents with no hook system report hooksApplicable false.
  let hooksDir = null;
  let hooks = 0;
  let hooksApplicable = false;
  if (agentIsClaude) {
    hooksDir = path.join(CLAUDE_DIR, 'hooks');
    hooks = safeCount(hooksDir, (e) => e.isFile() && e.name.endsWith('.hook.ts'));
    hooksApplicable = true;
  } else if (agentCmd === 'copilot') {
    hooksDir = path.join(COPILOT_DIR, 'hooks');
    hooks = safeCount(hooksDir, (e) => e.isFile() && e.name.endsWith('.json'));
    hooksApplicable = true;
  }
  const workDir = path.join(CLAUDE_DIR, 'MEMORY', 'WORK');
  const sessionsCount = safeCount(workDir, (e) => e.isDirectory());
  const ratings = countLines(path.join(CLAUDE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl'));
  const researchDir = path.join(CLAUDE_DIR, 'MEMORY', 'RESEARCH');
  const research = safeCount(researchDir, (e) => e.isDirectory());

  // Reads from the same caches the statusline-command.sh consumes
  const stateDir = path.join(CLAUDE_DIR, 'MEMORY', 'STATE');
  const usage = agentIsClaude ? readJSON(path.join(stateDir, 'usage-cache.json'), {}) : {};
  const location = readJSON(path.join(stateDir, 'location-cache.json'), {});
  const weather = readJSON(path.join(stateDir, 'weather-cache.json'), {});

  // Recent ratings: parse last N lines of ratings.jsonl, compute averages by window
  const ratingsPath = path.join(CLAUDE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl');
  const learning = { latest: null, latestSource: '', avg1h: null, avg1d: null, avg1w: null, avg1mo: null, recent: [], recentTs: [] };
  try {
    const raw = fs.readFileSync(ratingsPath, 'utf8').split('\n').filter(Boolean);
    const now = Date.now();
    const samples = [];
    for (let i = raw.length - 1; i >= 0 && samples.length < 200; i--) {
      try {
        const obj = JSON.parse(raw[i]);
        const ts = Date.parse(obj.timestamp);
        if (!isFinite(ts) || typeof obj.rating !== 'number') continue;
        samples.unshift({ ts, rating: obj.rating, source: obj.source || 'auto' });
      } catch (_) {}
    }
    if (samples.length) {
      learning.latest = samples[samples.length - 1].rating;
      learning.latestSource = samples[samples.length - 1].source;
      const avg = (within) => {
        const filt = samples.filter((s) => now - s.ts <= within);
        if (!filt.length) return null;
        const sum = filt.reduce((a, b) => a + b.rating, 0);
        return Math.round((sum / filt.length) * 10) / 10;
      };
      learning.avg1h = avg(60 * 60 * 1000);
      learning.avg1d = avg(24 * 60 * 60 * 1000);
      learning.avg1w = avg(7 * 24 * 60 * 60 * 1000);
      learning.avg1mo = avg(30 * 24 * 60 * 60 * 1000);
      // Recent 30 ratings for sparkline
      learning.recent = samples.slice(-30).map((s) => s.rating);
      // Timestamps for the chart's date axis (stocks-style x labels).
      learning.recentTs = samples.slice(-30).map((s) => s.ts);
    }
  } catch (_) {}

  const activeProject = (Array.isArray(config.projects) && config.activeProjectId)
    ? config.projects.find((p) => p && p.id === config.activeProjectId) : null;
  const cwd = activePtyCwd || (activeProject && activeProject.path) || HOME;
  return {
    skills, workflows, hooks, hooksApplicable, sessions: sessionsCount, ratings, research,
    agent: agentCmd, agentVersion: getAgentVersion(agentCmd),
    huskVer: app.getVersion(),
    workspace: {
      name: (activeProject && activeProject.name) || path.basename(cwd) || '',
      cwd,
      git: gitSummary(cwd),
    },
    mcp: mcpSummary(),
    claudeDir: CLAUDE_DIR, skillsDir, hooksDir,
    memoryDir: path.join(CLAUDE_DIR, 'MEMORY'),
    workflowsDir,
    sessionsDir: workDir,
    researchDir,
    // Rich statusline data
    location: {
      city: location.city || '',
      region: location.region || '',
    },
    weather: {
      temp: weather.temperature_2m || weather.temp || '',
      condition: weather.condition || weather.weather || '',
    },
    usage: {
      h5_pct: usage.usage_5h || usage.five_hour_pct || 0,
      h5_reset: usage.reset_5h_clock || usage.reset_5h || '',
      week_pct: usage.usage_7d || usage.weekly_pct || 0,
      week_reset: usage.reset_7d_clock || usage.reset_7d || '',
      api_cost: usage.ws_cost_dollars || 0,
      extra_used: usage.extra_used_dollars || 0,
      extra_limit: usage.extra_limit_dollars || 0,
      session_cost: usage.session_cost || '',
      cache_present: Object.keys(usage).length > 0,
      // Session model/turns read from each agent's OWN transcript, so the
      // figure always belongs to the active agent (never a different CLI's
      // session): claude from ~/.claude, copilot from ~/.copilot.
      session: agentIsClaude ? readActiveSessionStats()
        : (agentCmd === 'copilot' ? readCopilotSessionStats(activePtyCwd) : null),
      // A CLI's own session usage counter parsed from its status line
      // (Copilot's "N AIC used"). Null when the agent prints none.
      agentSession: (() => {
        const act = activeSessionId ? sessions.get(activeSessionId) : null;
        const n = act ? parseAgentSessionUsage(agentCmd, act.tailBuf) : null;
        return n == null ? null : { label: agentCmd === 'copilot' ? 'Session AIC' : 'Session usage', value: n };
      })(),
    },
    learning,
    home: HOME,
  };
});

// ─── Skills reader ──────────────────────────────────────────────────────────────

const DISABLED_PREFIX = '_disabled_';

function extractDescription(content) {
  const fm = content.match(/^---[\s\S]*?\ndescription:\s*(.+?)\n[\s\S]*?---/m);
  if (fm) return fm[1].trim().replace(/^["']|["']$/g, '');
  const stripped = content.replace(/^---[\s\S]*?---\n?/, '');
  for (const line of stripped.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t.slice(0, 220);
  }
  return '';
}

function listClaudeSkills() {
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dirName = e.name;
        const disabled = dirName.startsWith(DISABLED_PREFIX);
        const name = disabled ? dirName.slice(DISABLED_PREFIX.length) : dirName;
        const dir = path.join(skillsDir, dirName);
        let mdPath = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(mdPath)) {
          try {
            const child = fs.readdirSync(dir).find((f) => f.endsWith('.md'));
            if (child) mdPath = path.join(dir, child);
          } catch (_) {}
        }
        let description = '';
        try { description = extractDescription(fs.readFileSync(mdPath, 'utf8')); } catch (_) {}
        // The directory's own mtime is when its files were written, which is
        // the install. Enabling or disabling renames the directory, and a
        // rename touches the parent rather than the entry, so this survives
        // the switch being flipped.
        let installedAt = 0;
        try { installedAt = fs.statSync(dir).mtimeMs; } catch (_) {}
        return { source: 'claude', name, id: dirName, path: dir, mdPath, description, disabled, installedAt };
      });
  } catch (_) { return []; }
}

function listHuskPrompts() {
  if (!fs.existsSync(HUSK_PROMPTS_DIR)) return [];
  try {
    return fs.readdirSync(HUSK_PROMPTS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.md.disabled')))
      .map((e) => {
        const fileName = e.name;
        const disabled = fileName.endsWith('.disabled');
        const baseName = disabled ? fileName.slice(0, -'.disabled'.length) : fileName;
        const name = baseName.replace(/\.md$/, '');
        const mdPath = path.join(HUSK_PROMPTS_DIR, fileName);
        let description = '';
        try { description = extractDescription(fs.readFileSync(mdPath, 'utf8')); } catch (_) {}
        return { source: 'husk', name, id: fileName, path: mdPath, mdPath, description, disabled };
      });
  } catch (_) { return []; }
}

// ─── Profiles (saved agent configurations) ───────────────────────────────────

function getProfiles() {
  const stored = config.profiles;
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_PROFILES;
  return stored;
}

ipcMain.handle('profiles:list', () => getProfiles());

// ─── Workflows ────────────────────────────────────────────────────────────────

const WORKFLOWS_PATH = path.join(CONFIG_DIR, 'workflows.json');
// Runs outlive the process. Without this a workflow can never say whether it
// worked last night, which is the first thing anyone wants to know about one.
const WORKFLOW_RUNS_PATH = path.join(CONFIG_DIR, 'workflow-runs.json');
const WF_RUNS_MAX = 200;
// Only the newest runs keep their step output, so a long history does not turn
// into a log archive on disk.
const WF_RUNS_WITH_LOGS = 20;
const WF_STEP_LOG_CHARS = 12000;

function loadWorkflows() {
  try {
    if (!fs.existsSync(WORKFLOWS_PATH)) return [];
    return JSON.parse(fs.readFileSync(WORKFLOWS_PATH, 'utf8'));
  } catch (_) { return []; }
}

function loadWorkflowRuns() {
  try {
    if (!fs.existsSync(WORKFLOW_RUNS_PATH)) return [];
    const list = JSON.parse(fs.readFileSync(WORKFLOW_RUNS_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

// Newest first, capped. A summary only: the step scrollbacks stay in memory,
// since a history of every line every agent ever printed is not worth the disk.
function recordWorkflowRun(run, workflow) {
  try {
    const nodes = ((workflow.graph && workflow.graph.nodes) || []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const steps = Object.entries(run.stepStates || {}).map(([id, st]) => {
      // Keep enough of the scrollback to replay the step's terminal after a
      // restart, trimmed from the front so the tail (the result) survives.
      const log = (run.logs && run.logs.get(id)) || { entries: [] };
      const entries = [];
      let chars = 0;
      for (let i = log.entries.length - 1; i >= 0; i -= 1) {
        const e = log.entries[i];
        chars += (e.text || '').length;
        if (chars > WF_STEP_LOG_CHARS) break;
        entries.unshift({ kind: e.kind, text: e.text, seq: e.seq });
      }
      return {
        nodeId: id,
        name: (byId.get(id) || {}).name || 'Step',
        status: st.status,
        ms: st.ms || 0,
        entries,
        truncated: entries.length < log.entries.length,
      };
    });
    const failed = steps.find((st) => st.status === 'failed');
    const entry = {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: workflow.name || '',
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      ms: run.startedAt ? (new Date(run.finishedAt) - new Date(run.startedAt)) : 0,
      steps,
      edgesTaken: (run.edgesTaken || []).map((e) => ({ from: e.from, to: e.to })),
      failedStep: failed ? failed.name : '',
    };
    const list = loadWorkflowRuns();
    list.unshift(entry);
    const trimmed = list.slice(0, WF_RUNS_MAX).map((r, i) => (
      i < WF_RUNS_WITH_LOGS ? r : { ...r, steps: (r.steps || []).map((st) => ({ ...st, entries: undefined })) }
    ));
    writeJsonAtomic(WORKFLOW_RUNS_PATH, trimmed);
  } catch (_) { /* history is a nicety; never fail a run over it */ }
}

// Write through a temp file and rename, so a crash mid-write cannot leave a
// truncated file behind: rename is atomic within a filesystem.
function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function saveWorkflows(list) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeJsonAtomic(WORKFLOWS_PATH, list);
  } catch (_) {}
}

// In-memory active runs: runId -> { workflow, steps state, currentChild }
const activeRuns = new Map();
// A finished run keeps its scrollback so its nodes can still be opened and read
// after the flow ends. Bounded: the last few runs, not every run forever.
const finishedRuns = new Map();
const WF_FINISHED_RUNS_MAX = 5;

ipcMain.handle('workflows:list', () => loadWorkflows().map(migrateWorkflow));

// Environment for spawned one-shot CLI agents (workflow steps, prompt
// generation). Mirrors the PTY env so PAI hooks resolve: ~/.bun/bin must be
// on PATH or every bun-based SessionEnd hook fails with 'bun: not found'.
function buildAgentEnv() {
  const env = Object.assign({}, process.env, { CLAUDE_DIR, HUSK_HOST: '1' });
  const bunBin = path.join(HOME, '.bun', 'bin');
  if (env.PATH && !env.PATH.includes(bunBin)) env.PATH = `${bunBin}:${env.PATH}`;
  const localBin = path.join(HOME, '.local', 'bin');
  if (env.PATH && !env.PATH.includes(localBin)) env.PATH = `${localBin}:${env.PATH}`;
  return env;
}

// How the active agent is billed, so the UI can be honest about the dollar
// figure. Claude bills per token only when ANTHROPIC_API_KEY is set; without it
// the run goes through a Pro/Max subscription, which is a flat monthly fee with
// usage limits, not a per-token charge. The other CLIs are metered by their own
// account, which Husk cannot see, so they are reported as not-metered too.
ipcMain.handle('autopilot:billingMode', () => {
  const agent = (config.agentCommand || 'claude').trim().split(/\s+/)[0].toLowerCase();
  const base = agent.split(/[\\/]/).pop();
  const hasKey = !!(process.env.ANTHROPIC_API_KEY && String(process.env.ANTHROPIC_API_KEY).trim());
  // Only claude-on-an-API-key is truly pay-per-token in a way Husk can price.
  const metered = base === 'claude' && hasKey;
  return { metered, agent: base, hasApiKey: hasKey };
});

ipcMain.handle('workflows:generateStepPrompt', async (_e, description) => {
  if (!description || typeof description !== 'string') return { ok: false, error: 'description required' };
  const cmd = (config.agentCommand || 'claude').trim().split(/\s+/)[0];
  if (!isOnPath(cmd)) return { ok: false, error: `${cmd} not found on PATH` };
  const prompt = `Write a concise instruction prompt for an AI assistant. The user wants: "${description.slice(0, 400)}"

Return ONLY the prompt text, no explanations, no markdown, no quotes. Start with an action verb. Keep it 1-3 sentences.`;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };

    const child = require('child_process').spawn(cmd, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildAgentEnv(),
    });

    // Hard timeout. The spawn `timeout` option is unreliable when the CLI
    // catches SIGTERM, so we force-kill with SIGKILL and resolve regardless.
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      const text = out.trim();
      finish(text
        ? { ok: true, prompt: text.slice(0, 8192) }
        : { ok: false, error: 'Timed out after 90s. The CLI may be slow or need authentication.' });
    }, 90000);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      const text = out.trim();
      if (text.length > 0) finish({ ok: true, prompt: text.slice(0, 8192) });
      else finish({ ok: false, error: err.trim().slice(0, 300) || `exited ${code} with no output` });
    });
    child.on('error', (e) => { clearTimeout(killTimer); finish({ ok: false, error: e.message }); });
  });
});

ipcMain.handle('workflows:create', (_e, payload = {}) => {
  const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const validTriggers = ['manual', 'ai-suggested'];
  const entry = {
    id,
    name: String(payload.name || 'New Workflow').slice(0, 80),
    description: String(payload.description || '').slice(0, 256),
    graph: sanitizeGraph(payload.graph),
    trigger: validTriggers.includes(payload.trigger) ? payload.trigger : 'manual',
    createdAt: now,
    updatedAt: now,
  };
  const list = [...loadWorkflows(), entry];
  saveWorkflows(list);
  return entry;
});

ipcMain.handle('workflows:update', (_e, payload = {}) => {
  if (!payload.id) return { ok: false, error: 'missing id' };
  const list = loadWorkflows().map((w) => {
    if (w.id !== payload.id) return w;
    const migrated = migrateWorkflow(w);
    return {
      ...migrated,
      name: payload.name !== undefined ? String(payload.name).slice(0, 80) : migrated.name,
      description: payload.description !== undefined ? String(payload.description).slice(0, 256) : migrated.description,
      graph: payload.graph !== undefined ? sanitizeGraph(payload.graph) : migrated.graph,
      trigger: ['manual','ai-suggested'].includes(payload.trigger) ? payload.trigger : (migrated.trigger || 'manual'),
      updatedAt: new Date().toISOString(),
    };
  });
  saveWorkflows(list);
  return { ok: true };
});

ipcMain.handle('workflows:delete', (_e, id) => {
  const live = [...activeRuns.values()].find((r) => r.workflowId === id && r.status === 'running');
  if (live) return { ok: false, error: 'this workflow is running; stop it first' };
  if (!id) return { ok: false, error: 'missing id' };
  saveWorkflows(loadWorkflows().filter((w) => w.id !== id));
  return { ok: true };
});

ipcMain.handle('workflows:run', (event, workflowId) => {
  const already = [...activeRuns.values()].find((r) => r.status === 'running');
  if (already) {
    return { ok: false, error: 'a workflow is already running', runId: already.id, workflowId: already.workflowId };
  }
  const raw = loadWorkflows().find((w) => w.id === workflowId);
  if (!raw) return { ok: false, error: 'workflow not found' };
  const workflow = migrateWorkflow(raw);
  if (!workflow.graph || !workflow.graph.nodes || !workflow.graph.nodes.length) {
    return { ok: false, error: 'workflow has no steps' };
  }

  const runId = `run-${Date.now()}`;
  const runState = {
    id: runId,
    workflowId,
    status: 'running',
    stepStates: {},   // keyed by node id; branching means the path is dynamic
    currentChild: null,
    children: new Set(),   // every concurrently-running step, so Stop kills them all
    startedAt: new Date().toISOString(),
  };
  activeRuns.set(runId, runState);
  executeWorkflow(event, workflow, runState);
  return { ok: true, runId };
});

// Returns a context block to inject at session start for ai-suggested workflows.
// The AI reads this and knows when to suggest running a workflow.
ipcMain.handle('workflows:getSessionContext', () => {
  const suggested = loadWorkflows().map(migrateWorkflow).filter((w) => w.trigger === 'ai-suggested');
  if (!suggested.length) return null;
  const lines = suggested.map((w) => {
    const steps = graphToOrderedSteps(w.graph);
    const stepSummary = steps.map((s, i) => `  Step ${i + 1}: ${s.name}`).join('\n');
    return `- "${w.name}": ${w.description || steps.map((s) => s.name).join(' -> ')}\n${stepSummary}`;
  }).join('\n');
  return `[Husk Workflows available - suggest running when relevant]\n${lines}\nTo suggest: mention the workflow by name and tell the user to click Run in the Workflows tab.`;
});

ipcMain.handle('workflows:stop', (_e, runId) => {
  const run = activeRuns.get(runId);
  if (!run) return { ok: false, error: 'run not found' };
  run.status = 'stopped';
  for (const c of (run.children || [])) { try { c.kill('SIGTERM'); } catch (_) {} }
  return { ok: true };
});

// The scrollback for one node. Opening a node's terminal replays this before it
// starts following the live stream, so a node opened late still shows what it
// did, and closing the terminal loses nothing.
ipcMain.handle('workflows:nodeLog', (_e, payload) => {
  const { runId, nodeId } = payload || {};
  const run = activeRuns.get(runId) || finishedRuns.get(runId);
  if (!run) {
    const stored = loadWorkflowRuns().find((r) => r.id === runId);
    const step = stored && (stored.steps || []).find((st) => st.nodeId === nodeId);
    if (!step) return { ok: false, error: 'run not found' };
    return {
      ok: true,
      entries: step.entries || [],
      dropped: step.truncated ? 1 : 0,
      status: step.status,
      output: '',
      running: false,
    };
  }
  const log = (run.logs && run.logs.get(nodeId)) || { entries: [], dropped: 0 };
  const state = run.stepStates[nodeId] || { status: 'pending' };
  return {
    ok: true,
    entries: log.entries,
    dropped: log.dropped,
    status: state.status,
    output: state.output || '',
    running: run.currentNodeId === nodeId,
  };
});

// Re-attach to a run already in flight. The renderer can be reloaded (or the
// user can navigate away and back) while the agent keeps working in the main
// process; without this the run would continue with nothing watching it.
ipcMain.handle('workflows:runs', () => ({ ok: true, runs: loadWorkflowRuns() }));

ipcMain.handle('workflows:activeRun', () => {
  const run = [...activeRuns.values()].find((r) => r.status === 'running');
  if (!run) return { ok: true, run: null };
  return {
    ok: true,
    run: {
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      startedAt: run.startedAt,
      currentNodeId: run.currentNodeId || null,
      stepStates: Object.fromEntries(
        Object.entries(run.stepStates).map(([id, s]) => [id, { status: s.status }]),
      ),
      edgesTaken: run.edgesTaken || [],
      startedNodes: run.startedNodes || [],
    },
  };
});

// ─── Workflow graph model ─────────────────────────────────────────────────────
// A workflow is a graph of step nodes connected by edges. Edges carry a
// routing condition (used by the 2b branch engine; 2a treats all as 'always').

// Per-node scrollback. A run outlives the window that started it: the renderer
// can be reloaded, and a node's terminal can be opened long after the node has
// finished, so the output has to live here rather than only in the event that
// announced it. Bounded, because a chatty agent would otherwise grow forever.
const WF_LOG_MAX_ENTRIES = 4000;
const WF_LOG_MAX_CHARS = 400000;

function wfLogFor(run, nodeId) {
  if (!run.logs) run.logs = new Map();
  let log = run.logs.get(nodeId);
  if (!log) { log = { entries: [], chars: 0, dropped: 0 }; run.logs.set(nodeId, log); }
  return log;
}

function wfRecord(run, nodeId, entry) {
  const log = wfLogFor(run, nodeId);
  run.seq = (run.seq || 0) + 1;
  entry.seq = run.seq;
  log.entries.push(entry);
  log.chars += (entry.text || '').length;
  while (log.entries.length > WF_LOG_MAX_ENTRIES || log.chars > WF_LOG_MAX_CHARS) {
    const gone = log.entries.shift();
    if (!gone) break;
    log.chars -= (gone.text || '').length;
    log.dropped += 1;
  }
}

// Broadcast, not point-to-point. Sending only to event.sender means a renderer
// reload leaves the run executing with no way to see it: the window that asked
// for the run is not necessarily the window that needs to watch it.
function wfEmit(event, channel, data) {
  const run = data && data.runId ? activeRuns.get(data.runId) : null;
  if (run) {
    if (channel === 'wf:node:activity' && data.nodeId) {
      const entry = { t: Date.now(), kind: data.kind || 'text', text: String(data.text || '') };
      wfRecord(run, data.nodeId, entry);
      data.seq = entry.seq;   // the listener dedupes against the replayed buffer
    } else if (channel === 'wf:node:start' && data.nodeId) {
      run.currentNodeId = data.nodeId;
      wfLogFor(run, data.nodeId);
      if (!run.startedNodes) run.startedNodes = [];
      run.startedNodes.push({ nodeId: data.nodeId, at: Date.now() });
    } else if (channel === 'wf:node:done' && data.nodeId) {
      if (run.currentNodeId === data.nodeId) run.currentNodeId = null;
    } else if (channel === 'wf:edge:taken') {
      if (!run.edgesTaken) run.edgesTaken = [];
      run.edgesTaken.push({ edgeId: data.edgeId, from: data.from, to: data.to });
    }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    try { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, data); } catch (_) {}
  }
}

// How many steps may run at once. Agents are heavy, so parallel branches are
// bounded rather than unleashed.
const WF_MAX_PARALLEL = 4;
const WF_STEP_TIMEOUT_MS = 300000;

// Run one step to completion: build the prompt from its incoming context, spawn
// the agent, stream its output, and resolve with the result. Pure per-step; the
// scheduler owns ordering.
async function wfRunStep(event, run, graph, byId, step, incomingCtx) {
  const stepState = run.stepStates[step.id] || (run.stepStates[step.id] = { status: 'pending', output: '' });
  stepState.status = 'running';
  stepState.startedAt = Date.now();
  wfEmit(event, 'wf:node:start', { runId: run.id, nodeId: step.id });

  const activity = (kind, text) => {
    wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: step.id, kind, text: String(text || '') });
  };

  const cmd = (step.agentCommand || config.agentCommand || 'claude').trim().split(/\s+/)[0];
  if (!isAllowedAgentCommand(cmd)) {
    activity('error', `Step "${step.name}" needs one of ${Array.from(wfLib.ALLOWED_AGENT_COMMANDS).join(', ')}; got "${cmd}".`);
    stepState.status = 'failed';
    stepState.ms = Date.now() - stepState.startedAt;
    wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: step.id, status: 'failed' });
    return { status: 'failed', output: '' };
  }

  let prompt = step.prompt;
  const prevOutput = incomingCtx && incomingCtx.text ? incomingCtx.text : '';
  const prevName = incomingCtx && incomingCtx.from ? incomingCtx.from : '';
  if (prevOutput) {
    if (prompt.includes('{{previousOutput}}')) {
      prompt = prompt.replace(/\{\{previousOutput\}\}/g, prevOutput);
    } else if (step.passContext !== 'none') {
      const ctx = step.passContext === 'last50'
        ? prevOutput.split('\n').slice(-50).join('\n')
        : prevOutput;
      prompt = `${prompt}\n\n[Output from ${prevName ? `step "${prevName}"` : 'the previous steps'}]\n${ctx}`;
    }
  }

  const useStreamJson = cmd === 'claude';
  let wfSystem = 'You are running as an automated workflow step. Respond with only the direct result of the task. Do not use status banners, mode headers, structured output scaffolding, or voice notification commands. Plain, direct output only.';
  if (step.branchMode === 'ai') {
    const targets = graph.edges.filter((e) => e.from === step.id).map((e) => byId.get(e.to)).filter(Boolean).map((n) => n.name);
    if (targets.length >= 2) wfSystem += wfRouteInstruction(targets);
  }

  let args;
  if (cmd === 'claude') {
    args = ['-p', prompt, '--append-system-prompt', wfSystem, '--output-format', 'stream-json', '--verbose'];
  } else {
    args = AgentOneShot.oneShotArgs(cmd, `${wfSystem}\n\n${prompt}`);
  }
  if (step.model) {
    const flag = modelFlagFor(cmd);
    if (flag) args = [...args, flag, String(step.model)];
  }

  let resultText = '';
  let lineBuf = '';
  let sawAnyEvent = false;
  const wfCwd = activePtyCwd || (config && config.treeRoot) || HOME;
  const child = spawn(cmd, args, { cwd: wfCwd, stdio: ['ignore', 'pipe', 'pipe'], env: buildAgentEnv() });
  run.children.add(child);
  activity('status', step.model ? `Starting ${cmd} (${step.model})...` : `Starting ${cmd}...`);

  child.stdout.on('data', (d) => {
    if (!useStreamJson) { resultText += d.toString(); activity('text', d.toString()); return; }
    lineBuf += d.toString();
    let nl;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { activity('text', line); continue; }
      sawAnyEvent = true;
      handleStreamEvent(ev, activity, (txt) => { resultText = txt; });
    }
  });
  child.stderr.on('data', (d) => { const t = d.toString().trim(); if (t) activity('error', t); });

  const killTimer = setTimeout(() => {
    activity('error', 'Step timed out after 5 minutes, killing the agent.');
    try { child.kill('SIGKILL'); } catch (_) {}
  }, WF_STEP_TIMEOUT_MS);

  await new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(killTimer);
      run.children.delete(child);
      if (useStreamJson && !sawAnyEvent && resultText === '') {
        activity('error', 'No output from the agent. It may need authentication or stream-json is unsupported.');
      }
      stepState.status = run.status === 'stopped' ? 'cancelled' : (code === 0 ? 'done' : 'failed');
      stepState.ms = Date.now() - stepState.startedAt;
      stepState.output = resultText;
      wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: step.id, status: stepState.status, output: resultText });
      resolve();
    });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      run.children.delete(child);
      activity('error', e.message);
      stepState.status = 'failed';
      stepState.ms = Date.now() - stepState.startedAt;
      wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: step.id, status: 'failed' });
      resolve();
    });
  });

  return { status: stepState.status, output: resultText };
}

// Which outgoing edges a finished step activates. Two plain edges from a node
// both fire (parallel fan-out); conditional edges gate a branch. An AI-routed
// node picks exactly one by its ROUTE directive.
function wfActivatedEdges(graph, node, output, byId) {
  const out = graph.edges.filter((e) => e.from === node.id);
  if (!out.length) return { taken: [], decision: null };

  // AI routing is opt-in per node. Plain edges fan out in parallel by default.
  if (node.branchMode === 'ai' && out.length >= 2) {
    const res = wfResolveNext(graph, node, output, byId);
    if (res && res.edge) return { taken: [res.edge], decision: res.decision || (byId.get(res.edge.to) || {}).name };
    return { taken: [], decision: res && res.decision === 'END' ? 'END' : null };
  }

  const conditional = out.filter((e) => e.condition && (e.condition.type === 'contains' || e.condition.type === 'regex'));
  let anyCond = false;
  const taken = [];
  for (const e of conditional) {
    if (wfEdgeMatches(e.condition, output)) { taken.push(e); anyCond = true; }
  }
  for (const e of out) {
    const t = (e.condition && e.condition.type) || 'always';
    if (t === 'always') taken.push(e);
    else if (t === 'otherwise' && !anyCond) taken.push(e);
  }
  // Dedup, preserving order.
  const seen = new Set();
  return { taken: taken.filter((e) => (seen.has(e.id) ? false : seen.add(e.id))), decision: null };
}

// Dataflow scheduler. Nodes run when all their incoming edges have resolved and
// at least one was taken; independent ready nodes run concurrently. This is what
// gives parallel branches and join steps, on top of the conditional edges above.
async function executeWorkflow(event, workflow, run) {
  // Yield so ipcMain.handle returns the runId before any event fires.
  await new Promise((resolve) => setImmediate(resolve));

  const graph = sanitizeGraph(workflow.graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map(graph.nodes.map((n) => [n.id, []]));
  graph.edges.forEach((e) => { if (incoming.has(e.to)) incoming.get(e.to).push(e); });

  const edgeState = new Map(graph.edges.map((e) => [e.id, 'pending']));  // pending|taken|skipped
  const nodeDone = new Set();   // reached a terminal state (done|failed|skipped)
  const running = new Set();
  run.stepStates = {};
  graph.nodes.forEach((n) => { run.stepStates[n.id] = { status: 'pending', output: '' }; });

  let anyFailed = false;
  let resolveAll;
  const allSettled = new Promise((r) => { resolveAll = r; });

  const edgesInto = (nodeId) => incoming.get(nodeId) || [];
  const nodeReady = (n) => {
    if (nodeDone.has(n.id) || running.has(n.id)) return false;
    const inc = edgesInto(n.id);
    if (!inc.length) return true;                               // a root
    return inc.every((e) => edgeState.get(e.id) !== 'pending'); // all inputs resolved
  };

  // Context handed to a node: the outputs of its taken predecessors, joined.
  const contextFor = (n) => {
    const inc = edgesInto(n.id).filter((e) => edgeState.get(e.id) === 'taken');
    const parts = inc.map((e) => {
      const st = run.stepStates[e.from];
      const from = (byId.get(e.from) || {}).name || '';
      return st && st.output ? { from, text: st.output } : null;
    }).filter(Boolean);
    if (!parts.length) return { from: '', text: '' };
    if (parts.length === 1) return parts[0];
    return { from: '', text: parts.map((p) => `[${p.from}]\n${p.text}`).join('\n\n') };
  };

  const markSkipped = (n, reason) => {
    if (nodeDone.has(n.id)) return;
    run.stepStates[n.id].status = 'skipped';
    nodeDone.add(n.id);
    wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: n.id, status: 'skipped' });
    // A skipped node takes none of its outgoing edges.
    graph.edges.filter((e) => e.from === n.id).forEach((e) => { if (edgeState.get(e.id) === 'pending') edgeState.set(e.id, 'skipped'); });
    if (reason) { /* reason reserved for future surfacing */ }
  };

  const finish = () => {
    if (run.status === 'running') run.status = anyFailed ? 'failed' : 'done';
    run.finishedAt = new Date().toISOString();
    run.currentNodeId = null;
    recordWorkflowRun(run, workflow);
    wfEmit(event, 'wf:run:done', { runId: run.id, status: run.status });
    activeRuns.delete(run.id);
    run.children = new Set();
    finishedRuns.set(run.id, run);
    while (finishedRuns.size > WF_FINISHED_RUNS_MAX) finishedRuns.delete(finishedRuns.keys().next().value);
    resolveAll();
  };

  const pump = () => {
    if (run.status === 'stopped') {
      // Nothing new starts once stopped; wait for in-flight steps to settle.
      if (!running.size) finish();
      return;
    }
    // Skip any ready node whose inputs all resolved but none was taken.
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const n of graph.nodes) {
        if (!nodeReady(n)) continue;
        const inc = edgesInto(n.id);
        if (inc.length && !inc.some((e) => edgeState.get(e.id) === 'taken')) {
          markSkipped(n);
          progressed = true;
        }
      }
    }
    // Launch ready nodes up to the concurrency cap.
    for (const n of graph.nodes) {
      if (running.size >= WF_MAX_PARALLEL) break;
      if (!nodeReady(n)) continue;
      startNode(n);
    }
    if (!running.size && graph.nodes.every((n) => nodeDone.has(n.id))) finish();
    else if (!running.size && !graph.nodes.some((n) => nodeReady(n))) finish(); // deadlock guard
  };

  const startNode = (n) => {
    running.add(n.id);
    const ctx = contextFor(n);
    wfRunStep(event, run, graph, byId, n, ctx).then(({ status, output }) => {
      try { wfSettleNode(n, status, output); } catch (err) {
        wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: n.id, kind: 'error', text: `scheduler error: ${err && err.message}` });
        anyFailed = true;
      }
      pump();
    }).catch((err) => {
      running.delete(n.id); nodeDone.add(n.id); anyFailed = true;
      wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: n.id, kind: 'error', text: `step crashed: ${err && err.message}` });
      pump();
    });
  };

  const wfSettleNode = (n, status, output) => {
    {
      running.delete(n.id);
      nodeDone.add(n.id);
      if (status === 'failed') {
        anyFailed = true;
        graph.edges.filter((e) => e.from === n.id).forEach((e) => edgeState.set(e.id, 'skipped'));
      } else if (status === 'done') {
        const { taken, decision } = wfActivatedEdges(graph, n, output, byId);
        const takenIds = new Set(taken.map((e) => e.id));
        if (decision && decision !== 'END') {
          wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: n.id, kind: 'status', text: `Routing decision: continue to "${decision}"` });
        } else if (decision === 'END') {
          wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: n.id, kind: 'status', text: 'Routing decision: end the workflow' });
        }
        graph.edges.filter((e) => e.from === n.id).forEach((e) => {
          if (takenIds.has(e.id)) { edgeState.set(e.id, 'taken'); wfEmit(event, 'wf:edge:taken', { runId: run.id, edgeId: e.id, from: e.from, to: e.to }); }
          else edgeState.set(e.id, 'skipped');
        });
      } else {
        graph.edges.filter((e) => e.from === n.id).forEach((e) => edgeState.set(e.id, 'skipped'));
      }
    }
  };

  pump();
  await allSettled;
}

// Translates one claude stream-json event into activity feed lines.
function handleStreamEvent(ev, activity, setResult) {
  if (!ev || !ev.type) return;
  if (ev.type === 'system' && ev.subtype === 'init') {
    activity('status', `Agent ready (model: ${ev.model || 'default'})`);
  } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text && block.text.trim()) {
        activity('text', block.text.trim());
      } else if (block.type === 'tool_use') {
        const inp = block.input || {};
        const detail = inp.command || inp.file_path || inp.pattern || inp.description || inp.url || '';
        activity('tool', detail ? `${block.name}  ${String(detail).slice(0, 140)}` : block.name);
      }
    }
  } else if (ev.type === 'result') {
    if (ev.result) setResult(String(ev.result));
    const secs = Math.round((ev.duration_ms || 0) / 1000);
    activity('status', ev.is_error ? 'Agent finished with an error' : `Completed in ${secs}s`);
  }
}

ipcMain.handle('profiles:generate', async (_e, description) => {
  if (!description || typeof description !== 'string') return { ok: false, error: 'description required' };
  const cmd = (config.agentCommand || 'claude').trim().split(/\s+/)[0];
  if (!isOnPath(cmd)) return { ok: false, error: `${cmd} is not installed` };
  const prompt = `You are configuring an AI assistant profile. Based on this description: "${description.slice(0, 500)}"

Create an agent profile. Return ONLY valid JSON, no markdown fences, no explanation, with exactly these fields:
{"name":"short name 2-4 words","description":"one sentence what this agent does","systemPrompt":"detailed system prompt 2-5 sentences starting with You are..."}`;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = require('child_process').spawn(cmd, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code !== 0) { resolve({ ok: false, error: err.slice(0, 200) || `exit ${code}` }); return; }
      const match = out.match(/\{[\s\S]*\}/);
      if (!match) { resolve({ ok: false, error: 'AI did not return valid JSON' }); return; }
      try {
        const parsed = JSON.parse(match[0]);
        resolve({ ok: true, name: String(parsed.name || '').slice(0, 64), description: String(parsed.description || '').slice(0, 256), systemPrompt: String(parsed.systemPrompt || '').slice(0, 4096) });
      } catch (_) { resolve({ ok: false, error: 'Could not parse AI response' }); }
    });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
});

// Per-tool directories to scan for importable agents. To add a tool, append
// a { label, dir } entry. Files in each dir are parsed by parseAgentMd.
const AGENT_SOURCES = [
  { label: 'Claude Code', dir: path.join(HOME, '.claude', 'agents') },
  { label: 'GitHub Copilot', dir: path.join(COPILOT_DIR, 'agents') },
];

// Native agents directory per CLI. Both claude and copilot load the same
// markdown agent format from these locations, so a Husk agent written into
// each installed CLI's dir is usable in whichever CLI the user runs.
const CLAUDE_AGENTS_DIR = path.join(HOME, '.claude', 'agents');
const COPILOT_AGENTS_DIR = path.join(COPILOT_DIR, 'agents');
function installedAgentDirs() {
  const out = [];
  try { if (fs.existsSync(path.join(HOME, '.claude'))) out.push(CLAUDE_AGENTS_DIR); } catch (_) {}
  try { if (fs.existsSync(COPILOT_DIR)) out.push(COPILOT_AGENTS_DIR); } catch (_) {}
  return out;
}
// Mirror every user (non-builtin) agent profile into each installed CLI's
// agents dir. An existing file in the claude dir (the rich import source) is
// copied verbatim to preserve all of its frontmatter; otherwise the file is
// reconstructed from the profile. Existing targets are not overwritten, so a
// hand-edited agent file is never clobbered.
function syncAgentFiles() {
  try {
    const dirs = installedAgentDirs();
    if (!dirs.length) return;
    const profiles = getProfiles().filter((p) => p && !p.builtin && (p.systemPrompt || p.name));
    for (const p of profiles) {
      const fname = agentFileName(p.name);
      let content = null;
      const claudeFile = path.join(CLAUDE_AGENTS_DIR, fname);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fname is a slugified, traversal-free basename in a fixed dir
      try { if (fs.existsSync(claudeFile)) content = fs.readFileSync(claudeFile, 'utf8'); } catch (_) {}
      if (!content) content = renderAgentMd(p);
      for (const dir of dirs) {
        const target = path.join(dir, fname);
        try {
          // mkdir recursive is idempotent, and the 'wx' flag fails if the file
          // already exists. Both avoid a check-then-act race on the target.
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is a fixed CLI agents dir, fname is slugified
          fs.mkdirSync(dir, { recursive: true });
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to a CLI agents dir + slugified basename
          fs.writeFileSync(target, content, { flag: 'wx' });
        } catch (_) {}
      }
    }
  } catch (_) {}
}
function removeAgentFiles(name) {
  if (!name) return;
  const fname = agentFileName(name);
  for (const dir of installedAgentDirs()) {
    const target = path.join(dir, fname);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to a CLI agents dir + slugified basename
    try { if (fs.existsSync(target)) fs.unlinkSync(target); } catch (_) {}
  }
}

ipcMain.handle('profiles:listImportableAgents', () => {
  try {
    const existing = new Set(getProfiles().map((p) => String(p.name || '').toLowerCase()));
    const out = [];
    // Dedupe by agent name (case-insensitive). The same agent can appear as
    // more than one file in a dir (e.g. an original `Algorithm.md` plus a
    // slug-mirrored `algorithm.md`); list it once.
    const seen = new Set();
    for (const src of AGENT_SOURCES) {
      if (!fs.existsSync(src.dir)) continue;
      for (const entry of fs.readdirSync(src.dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        try {
          const text = fs.readFileSync(path.join(src.dir, entry.name), 'utf8');
          const parsed = parseAgentMd(text);
          const name = (parsed.name || entry.name.replace(/\.md$/, '')).slice(0, 64);
          const key = name.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            source: src.label,
            filename: entry.name,
            name,
            description: (parsed.description || '').slice(0, 256),
            systemPrompt: (parsed.body || '').slice(0, 4096),
            alreadyImported: existing.has(key),
          });
        } catch (_) {}
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, agents: out };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('profiles:importAgents', (_e, payload = {}) => {
  const picks = Array.isArray(payload && payload.picks) ? payload.picks : [];
  const activateAfter = !!(payload && payload.activate);
  if (!picks.length) return { ok: false, error: 'nothing to import' };
  const byLabel = new Map(AGENT_SOURCES.map((s) => [s.label, s]));
  const list = getProfiles().slice();
  const importedIds = [];
  for (const pick of picks) {
    const src = byLabel.get(pick && pick.source);
    const fname = String((pick && pick.filename) || '');
    if (!src || !fname.endsWith('.md') || fname.includes('/') || fname.includes('\\') || fname.includes('..')) continue;
    try {
      const text = fs.readFileSync(path.join(src.dir, fname), 'utf8');
      const parsed = parseAgentMd(text);
      const id = `profile-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      list.push({
        id,
        name: (parsed.name || fname.replace(/\.md$/, '')).slice(0, 64),
        description: (parsed.description || '').slice(0, 256),
        systemPrompt: (parsed.body || '').slice(0, 4096),
        autoSelect: false,
        builtin: false,
      });
      importedIds.push(id);
    } catch (_) {}
  }
  let nextConfig = { ...config, profiles: list };
  if (activateAfter && importedIds.length) {
    const prevActive = Array.isArray(config.activeProfileIds)
      ? config.activeProfileIds
      : (config.activeProfileId ? [config.activeProfileId] : []);
    const active = prevActive.slice();
    for (const id of importedIds) { if (!active.includes(id)) active.push(id); }
    nextConfig = { ...nextConfig, activeProfileIds: active, activeProfileId: active[0] || null };
  }
  config = nextConfig;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  syncAgentFiles();
  return { ok: true, imported: importedIds.length, importedIds };
});

// ─── Install-from-repo flow ───────────────────────────────────────────────
//
// Lets a user point Husk at a cloned "agent pack" repo
// whose agents live in one of two layouts:
//   <repoRoot>/.github/agents/<agent>.agent.md   VSCode/Copilot-native layout
//   <repoRoot>/agents/<agent>.md                 legacy flat layout
// Companion skills live under <repoRoot>/.github/skills/ or <repoRoot>/skills/.
// The .github layout lets VSCode and Copilot consume the agents natively
// without Husk, so it is preferred; the legacy layout stays supported.
//
// Install is agent-agnostic. It does not write any per-CLI instructions file;
// instead it relies on each CLI's own native agent loading:
//   1) Copy each picked agent into ~/.claude/agents/, then mirror every
//      imported agent into all installed CLIs' native agents dirs via
//      syncAgentFiles (claude ~/.claude/agents, copilot ~/.copilot/agents, ...).
//      Copilot also reads the repo's own .github/agents/ when launched there,
//      so no copilot-instructions injection is needed.
//   2) Create a Husk profile per picked agent stamped with repoRoot. The
//      spawnPty cwd resolver consumes that field so the active CLI runs
//      inside the repo, which makes the agent's relative `skills/<id>/SKILL.md`
//      reads resolve.
//
// The renderer is expected to call repoAgents:pickDir first (or pass an
// already-known root), then repoAgents:scan to populate the picker, then
// repoAgents:install with the user's selection. scan also accepts an https
// repo URL; it is cloned into userData/agent-repos and scanned from there.

// Resolve where importable agents live inside a pointed-at repo. The current
// VSCode/Copilot-native layout keeps them in <root>/.github/agents/*.agent.md;
// older packs use a flat <root>/agents/*.md. First existing match wins.
// Returns { dir, ext } or null when neither directory exists.
function resolveRepoAgentsDir(root) {
  const candidates = [
    { dir: path.join(root, '.github', 'agents'), ext: '.agent.md' },
    { dir: path.join(root, 'agents'), ext: '.md' },
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.dir) && fs.statSync(c.dir).isDirectory()) return c;
    } catch (_) {}
  }
  return null;
}

// Resolve the companion skills directory across both repo layouts.
function resolveRepoSkillsDir(root) {
  const candidates = [path.join(root, '.github', 'skills'), path.join(root, 'skills')];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch (_) {}
  }
  return null;
}

// Strip the agent-file extension (.agent.md or .md) to derive a fallback name
// when the file has no `name:` frontmatter field.
function stripAgentExt(filename) {
  return filename.replace(/\.agent\.md$/, '').replace(/\.md$/, '');
}

// Clone an https repo URL into a managed userData directory and return the
// local path. The clone persists because installed agents keep repoRoot as
// their working directory. An existing clone is refreshed with a best-effort
// fast-forward pull instead of re-cloning. Validation and error wording live
// in src/lib/repo-agents.js. GIT_TERMINAL_PROMPT=0 makes private repos fail
// fast instead of hanging on a credential prompt.
const RepoAgents = require('./lib/repo-agents');
function cloneAgentRepo(url) {
  return new Promise((resolve) => {
    const v = RepoAgents.validateRepoUrl(url);
    if (!v.ok) return resolve(v);
    const clonesRoot = path.join(app.getPath('userData'), 'agent-repos');
    const dest = path.join(clonesRoot, v.dirName);
    const { execFile } = require('child_process');
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (fs.existsSync(path.join(dest, '.git'))) {
      execFile('git', ['-C', dest, 'pull', '--ff-only'], { timeout: 60000, env: gitEnv }, () => resolve({ ok: true, root: dest }));
      return;
    }
    try { fs.mkdirSync(clonesRoot, { recursive: true }); } catch (err) {
      return resolve({ ok: false, error: 'Husk cannot write to its data folder (permission denied).' });
    }
    execFile('git', ['clone', '--depth', '1', v.url, dest], { timeout: 120000, env: gitEnv }, (err) => {
      if (err) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
        return resolve({ ok: false, error: RepoAgents.friendlyCloneError(err) });
      }
      resolve({ ok: true, root: dest });
    });
  });
}

ipcMain.handle('repoAgents:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an agent-pack repository',
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('repoAgents:scan', async (_e, payload = {}) => {
  let root = String((payload && payload.root) || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) {
    const cloned = await cloneAgentRepo(root);
    if (!cloned.ok) return cloned;
    root = cloned.root;
  } else {
    const v = RepoAgents.validateLocalRoot(root);
    if (!v.ok) return v;
    root = v.root;
  }
  try {
    const resolved = resolveRepoAgentsDir(root);
    const skillsDir = resolveRepoSkillsDir(root);
    const existingProfileNames = new Set(
      getProfiles().map((p) => String(p.name || '').toLowerCase())
    );
    const agents = [];
    if (resolved) {
      // Walk up to two levels below the agents dir; packs commonly group
      // agents in category subfolders (agents/core/*.md). filename is the
      // path relative to the agents dir so install can locate nested files.
      const walk = (dir, rel, depth) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (depth < 2) walk(path.join(dir, entry.name), entryRel, depth + 1);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(resolved.ext)) continue;
          try {
            const fp = path.join(dir, entry.name);
            const text = fs.readFileSync(fp, 'utf8');
            const parsed = parseAgentMd(text);
            const name = (parsed.name || stripAgentExt(entry.name)).slice(0, 64);
            agents.push({
              filename: entryRel,
              name,
              description: (parsed.description || '').slice(0, 256),
              bodyLength: (parsed.body || '').length,
              alreadyInClaude: fs.existsSync(path.join(CLAUDE_DIR, 'agents', entry.name)),
              alreadyImported: existingProfileNames.has(name.toLowerCase()),
            });
          } catch (_) {}
        }
      };
      walk(resolved.dir, '', 0);
      agents.sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
      ok: true,
      root,
      agents,
      hasSkillsDir: !!skillsDir,
    };
  } catch (err) { return { ok: false, error: RepoAgents.friendlyScanError(err) }; }
});

ipcMain.handle('repoAgents:install', (_e, payload = {}) => {
  const rootCheck = RepoAgents.validateLocalRoot((payload && payload.root) || '');
  if (!rootCheck.ok) return rootCheck;
  const root = rootCheck.root;
  const picks = Array.isArray(payload && payload.picks) ? payload.picks : [];
  const installToClaudeAgents = payload.installToClaudeAgents !== false;
  const activate = !!payload.activate;
  if (!picks.length) return { ok: false, error: 'Nothing selected. Tick at least one agent to install.' };
  const resolved = resolveRepoAgentsDir(root);
  if (!resolved) return { ok: false, error: 'No agents directory found in that repo.' };
  const agentsDir = resolved.dir;
  // Containment baseline for the picks below: the real (symlink-resolved)
  // agents dir, so the per-file check compares real paths on both sides.
  let realAgentsDir;
  try { realAgentsDir = fs.realpathSync(agentsDir); } catch (_) {
    return { ok: false, error: 'No agents directory found in that repo.' };
  }
  const claudeAgentsDir = path.join(CLAUDE_DIR, 'agents');
  try { fs.mkdirSync(claudeAgentsDir, { recursive: true }); } catch (_) {}
  const list = getProfiles().slice();
  const importedIds = [];
  const copiedToClaude = [];
  for (const pick of picks) {
    // filename may be nested relative to the agents dir (core/reviewer.md);
    // resolve it, including any symlinks, and require the real file to live
    // inside the agents dir.
    const fname = String((pick && pick.filename) || '');
    if (!fname.endsWith('.md') || fname.includes('\\') || fname.includes('..') || path.isAbsolute(fname)) continue;
    let src;
    try { src = fs.realpathSync(path.resolve(agentsDir, fname)); } catch (_) { continue; }
    if (!src.startsWith(realAgentsDir + path.sep)) continue;
    const basename = path.basename(fname);
    try {
      const text = fs.readFileSync(src, 'utf8');
      const parsed = parseAgentMd(text);
      const name = (parsed.name || stripAgentExt(basename)).slice(0, 64);
      if (installToClaudeAgents) {
        const dest = path.join(claudeAgentsDir, basename);
        try { fs.copyFileSync(src, dest); copiedToClaude.push(dest); } catch (_) {}
      }
      const id = `profile-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      list.push({
        id,
        name,
        description: (parsed.description || '').slice(0, 256),
        systemPrompt: (parsed.body || '').slice(0, 4096),
        autoSelect: false,
        builtin: false,
        repoRoot: root,
        sourceFilename: fname,
      });
      importedIds.push(id);
    } catch (_) {}
  }
  let nextConfig = { ...config, profiles: list };
  if (activate && importedIds.length) {
    const prevActive = Array.isArray(config.activeProfileIds)
      ? config.activeProfileIds
      : (config.activeProfileId ? [config.activeProfileId] : []);
    const active = prevActive.slice();
    for (const id of importedIds) { if (!active.includes(id)) active.push(id); }
    nextConfig = { ...nextConfig, activeProfileIds: active, activeProfileId: active[0] || null };
  }
  config = nextConfig;
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  // Agent-agnostic distribution: mirror the imported agents into every
  // installed CLI's native agents dir (claude, copilot, ...). Copilot also
  // reads the repo's own .github/agents/ when run there, so no per-CLI
  // instructions file is written.
  const distributedTo = [];
  if (installToClaudeAgents) {
    try { syncAgentFiles(); distributedTo.push(...installedAgentDirs()); } catch (_) {}
  }
  return {
    ok: true,
    imported: importedIds.length,
    importedIds,
    copiedToClaude,
    distributedTo,
  };
});

// ─── MCP install-from-repo flow ───────────────────────────────────────────
//
// Sibling of the repoAgents flow above. A user points Husk at a cloned
// repo that ships <root>/mcp-servers/<name>/, picks which servers to
// install AND which CLIs to install them into, and Husk handles the
// build (when needed) and the per-CLI config write.
//
// Pure scanning + spec-building lives in src/lib/repo-mcp.js so it can
// be unit-tested without spinning up Electron. The IPC layer below is
// the thin shell that connects the renderer to that module + the
// existing per-CLI MCP adapters in src/lib/mcp/.
//
// IPCs:
//   repoMcp:pickDir   native folder picker (same as repoAgents)
//   repoMcp:scan      scans <root>/mcp-servers/* and returns descriptions
//   repoMcp:build     runs npm install + npm run build inside one server
//   repoMcp:install   takes a built spec + a list of CLI targets, writes
//                     to each tool's MCP config via the existing adapters
//                     (or emits a config-snippet for tools we do not own
//                     a safe write path for yet, e.g. Codex/Aider)

const RepoMcp = require('./lib/repo-mcp');
const McpAdapters = require('./lib/mcp');

ipcMain.handle('repoMcp:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a repo that ships mcp-servers/',
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('repoMcp:scan', (_e, payload = {}) => {
  const root = String((payload && payload.root) || '').trim();
  if (!root || !path.isAbsolute(root)) {
    return { ok: false, error: 'absolute path required' };
  }
  return RepoMcp.scanRepoForMcpServers(root);
});

// Run `npm install` then (if the package declares it) `npm run build`
// inside one server directory. Streams a final stdout/stderr tail back
// to the renderer; no live event channel yet, keeps the wire surface
// minimal. Honors a 5-minute total wall-clock cap so a hung native
// build cannot freeze Husk.
ipcMain.handle('repoMcp:build', async (_e, payload = {}) => {
  const dir = String((payload && payload.dir) || '').trim();
  if (!dir || !path.isAbsolute(dir)) return { ok: false, error: 'absolute server dir required' };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: 'server dir does not exist' };
  }
  const pkgPath = path.join(dir, 'package.json');
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
  if (!pkg) return { ok: false, error: 'no readable package.json' };

  const cap = Date.now() + 5 * 60 * 1000;
  const runOnce = (script) => new Promise((resolve) => {
    // --ignore-scripts blocks preinstall/install/postinstall lifecycle hooks,
    // which would otherwise run arbitrary code from a repo the user merely
    // pointed at. MCP servers that genuinely need a native build run their
    // build via the explicit `build` script below, not install hooks.
    const args = script === 'install'
      ? ['install', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['run', script];
    let proc;
    try {
      proc = spawn('npm', args, { cwd: dir, env: process.env, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message, stdoutTail: '', stderrTail: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 8192) stdout = stdout.slice(-4096); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8192) stderr = stderr.slice(-4096); });
    const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, Math.max(1000, cap - Date.now()));
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve({ ok: true, stdoutTail: stdout, stderrTail: stderr });
      else resolve({ ok: false, error: `npm ${args.join(' ')} exited ${code}`, stdoutTail: stdout, stderrTail: stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(killer);
      resolve({ ok: false, error: err.message, stdoutTail: stdout, stderrTail: stderr });
    });
  });

  const stages = [];
  const installRes = await runOnce('install');
  stages.push({ stage: 'install', ...installRes });
  if (!installRes.ok) return { ok: false, stages };
  if (pkg.scripts && typeof pkg.scripts.build === 'string') {
    const buildRes = await runOnce('build');
    stages.push({ stage: 'build', ...buildRes });
    if (!buildRes.ok) return { ok: false, stages };
  }
  return { ok: true, stages };
});

// Targets and what each one does on install:
//   claude   → adapter.add() writes ~/.claude.json
//   copilot  → adapter.add() writes ~/.copilot/mcp-config.json
//   codex    → snippet only (TOML), no write yet
//   aider    → snippet only (CLI --mcp flag), no write yet
//
// Per-target results are independent. A failure in one does not block
// the others. The renderer paints a per-target status pill from the
// returned `results` map.
const SNIPPET_TARGETS = new Set(['codex', 'aider']);
const WRITE_TARGETS = new Set(['claude', 'copilot', 'gemini']);
const KNOWN_TARGETS = new Set([...SNIPPET_TARGETS, ...WRITE_TARGETS]);

ipcMain.handle('repoMcp:install', (_e, payload = {}) => {
  const summary = payload && payload.server;
  const envValues = (payload && payload.envValues) || {};
  const targets = Array.isArray(payload && payload.targets) ? payload.targets : [];
  const serverId = String((payload && payload.serverId) || (summary && summary.name) || '').trim();
  if (!summary || typeof summary !== 'object') return { ok: false, error: 'server summary required' };
  if (!serverId || !/^[a-zA-Z0-9_-]+$/.test(serverId)) {
    return { ok: false, error: 'serverId must match [a-zA-Z0-9_-]+' };
  }
  if (!targets.length) return { ok: false, error: 'pick at least one target' };

  const built = RepoMcp.buildServerSpec(summary, envValues);
  if (!built.ok) return { ok: false, error: built.error };
  const spec = built.spec;

  const results = {};
  for (const target of targets) {
    if (!KNOWN_TARGETS.has(target)) {
      results[target] = { status: 'error', error: 'unknown target' };
      continue;
    }
    if (SNIPPET_TARGETS.has(target)) {
      const snippet = target === 'codex'
        ? RepoMcp.renderCodexSnippet(serverId, spec)
        : RepoMcp.renderAiderSnippet(serverId, spec);
      results[target] = { status: 'snippet', snippet };
      continue;
    }
    // Real write path: hand off to the per-CLI adapter. add() refuses
    // duplicates by design; we surface that as a benign "already
    // installed" status instead of swallowing it.
    const adapter = McpAdapters.ADAPTERS[target];
    if (!adapter || !adapter.supportsWrite) {
      results[target] = { status: 'error', error: 'adapter does not support writes' };
      continue;
    }
    const addRes = adapter.add({
      id: serverId,
      transport: spec.transport,
      command: spec.command,
      args: spec.args,
      env: spec.env || {},
    });
    if (addRes.ok) results[target] = { status: 'installed', configPath: adapter.configPath };
    else if (/already exists/i.test(addRes.error || '')) results[target] = { status: 'exists', configPath: adapter.configPath };
    else results[target] = { status: 'error', error: addRes.error, configPath: adapter.configPath };
  }
  return { ok: true, serverId, spec, results };
});

ipcMain.handle('profiles:create', (_e, payload = {}) => {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry = {
    id,
    name: String(payload.name || 'New Agent').slice(0, 64),
    description: String(payload.description || '').slice(0, 256),
    systemPrompt: String(payload.systemPrompt || '').slice(0, 4096),
    autoSelect: !!payload.autoSelect,
    builtin: false,
  };
  const profiles = [...getProfiles(), entry];
  config = { ...config, profiles };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  syncAgentFiles();
  return entry;
});

ipcMain.handle('profiles:update', (_e, payload = {}) => {
  if (!payload.id) return { ok: false, error: 'missing id' };
  const prev = getProfiles().find((p) => p.id === payload.id);
  const profiles = getProfiles().map((p) => {
    if (p.id !== payload.id) return p;
    return {
      ...p,
      name: payload.name !== undefined ? String(payload.name).slice(0, 64) : p.name,
      description: payload.description !== undefined ? String(payload.description).slice(0, 256) : p.description,
      systemPrompt: payload.systemPrompt !== undefined ? String(payload.systemPrompt).slice(0, 4096) : p.systemPrompt,
      autoSelect: payload.autoSelect !== undefined ? !!payload.autoSelect : (p.autoSelect || false),
    };
  });
  config = { ...config, profiles };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  // If the name changed, drop the stale agent file before writing the new one.
  if (prev && payload.name !== undefined && String(payload.name).slice(0, 64) !== prev.name) removeAgentFiles(prev.name);
  syncAgentFiles();
  return { ok: true };
});

// Returns the active profile ids, falling back to the single-active
// field for configs that only set activeProfileId.
function getActiveIds() {
  const arr = Array.isArray(config.activeProfileIds) ? config.activeProfileIds : null;
  if (arr) return arr;
  return config.activeProfileId ? [config.activeProfileId] : [];
}
function writeActiveIds(ids) {
  config = { ...config, activeProfileIds: ids, activeProfileId: ids[0] || null };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
}

ipcMain.handle('profiles:delete', (_e, id) => {
  if (!id) return { ok: false, error: 'missing id' };
  const removed = getProfiles().find((p) => p.id === id);
  const profiles = getProfiles().filter((p) => p.id !== id);
  const active = getActiveIds().filter((a) => a !== id);
  config = { ...config, profiles, activeProfileIds: active, activeProfileId: active[0] || null };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  if (removed) removeAgentFiles(removed.name);
  return { ok: true };
});

// Activate adds the profile to the active set. Null clears all (legacy).
ipcMain.handle('profiles:activate', (_e, id) => {
  if (id == null) { writeActiveIds([]); return { ok: true, activeIds: [] }; }
  const profile = getProfiles().find((p) => p.id === id);
  if (!profile) return { ok: false, error: 'profile not found' };
  const active = getActiveIds();
  if (!active.includes(id)) active.push(id);
  writeActiveIds(active);
  return { ok: true, activeIds: active, profile };
});

ipcMain.handle('profiles:deactivate', (_e, id) => {
  if (!id) return { ok: false, error: 'missing id' };
  const active = getActiveIds().filter((a) => a !== id);
  writeActiveIds(active);
  return { ok: true, activeIds: active };
});

ipcMain.handle('profiles:deactivateAll', () => {
  writeActiveIds([]);
  return { ok: true, activeIds: [] };
});

// Select every profile (bulk).
ipcMain.handle('profiles:activateAll', () => {
  const ids = getProfiles().map((p) => p.id).filter(Boolean);
  writeActiveIds(ids);
  return { ok: true, activeIds: ids };
});

// Returns just the curated Husk prompts (the markdown files seeded from
// installer/prompts/ into ~/.config/husk/prompts/). The Skills page mixes
// these with Claude skills; the dedicated Prompts page wants only the prompts.
ipcMain.handle('prompts:list', () => {
  try {
    return { ok: true, prompts: listHuskPrompts() };
  } catch (err) {
    return { ok: false, error: err.message, prompts: [] };
  }
});

// ─── Projects IPC ──────────────────────────────────────────────────────────
// Projects are stored as { id, name, path, addedAt, lastUsedAt } in
// config.projects, with config.activeProjectId pointing at the current one.
// All persistence flows through config:set so the existing readJSON/write
// path stays the source of truth.

function _projectsList() {
  return Array.isArray(config.projects) ? config.projects : [];
}

ipcMain.handle('projects:list', () => {
  return {
    ok: true,
    projects: _projectsList(),
    activeProjectId: config.activeProjectId || null,
  };
});

ipcMain.handle('projects:create', (_e, payload = {}) => {
  const name = String(payload.name || '').trim().slice(0, 80);
  const projPath = String(payload.path || '').trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (!projPath) return { ok: false, error: 'Path is required.' };
  try {
    if (!fs.existsSync(projPath) || !fs.statSync(projPath).isDirectory()) {
      return { ok: false, error: 'Path is not a directory that exists.' };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const projects = _projectsList();
  if (projects.some((p) => p && p.path === projPath)) {
    return { ok: false, error: 'A project with that path already exists.' };
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = { id, name, path: projPath, addedAt: new Date().toISOString(), lastUsedAt: null };
  config = { ...config, projects: [...projects, entry] };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true, project: entry };
});

ipcMain.handle('projects:setActive', (_e, id) => {
  const projects = _projectsList();
  const found = projects.find((p) => p && p.id === id);
  if (!found) return { ok: false, error: 'Project not found.' };
  const stamped = projects.map((p) => p && p.id === id ? { ...p, lastUsedAt: new Date().toISOString() } : p);
  config = { ...config, projects: stamped, activeProjectId: id };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true, project: found };
});

ipcMain.handle('projects:clearActive', () => {
  config = { ...config, activeProjectId: null };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('projects:delete', (_e, id) => {
  const projects = _projectsList();
  if (!projects.some((p) => p && p.id === id)) return { ok: false, error: 'Project not found.' };
  const remaining = projects.filter((p) => p && p.id !== id);
  const newActive = config.activeProjectId === id ? null : config.activeProjectId;
  config = { ...config, projects: remaining, activeProjectId: newActive };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true };
});

// Newest transcript activity for a folder, best effort. Transcripts are keyed
// by encoded cwd on disk, so the mtime of the newest one is a cheap and honest
// "last session here" signal without opening a single file.
function lastSessionMsForCwd(cwd) {
  try {
    const dir = path.join(CLAUDE_DIR, 'projects', claudeProjectDirName(cwd));
    let newest = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.size > 0 && st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (_) {}
    }
    return newest || null;
  } catch (_) { return null; }
}

// Derived, per-project signal for the Projects board: what is going on in each
// folder right now. Computed on demand (page open, window focus), returned in
// one round trip, and NEVER persisted; the stored project record stays the
// small thing the user created. The renderer paints the list first and
// enriches when this lands, so a slow git call cannot hold the page hostage.
ipcMain.handle('projects:state', () => {
  const projects = _projectsList();
  const retainedRuns = Object.values(readRetained());
  const liveCwds = new Set();
  for (const [, s] of sessions) { if (s && s.pty && s.cwd) liveCwds.add(s.cwd); }
  const states = {};
  for (const p of projects) {
    if (!p || !p.id) continue;
    const st = {
      available: false, isGit: false, branch: null, ahead: 0, behind: 0,
      dirty: 0, conflicts: 0, live: false, retainedCount: 0, lastSessionMs: null,
    };
    states[p.id] = st;
    try { st.available = fs.existsSync(p.path) && fs.statSync(p.path).isDirectory(); } catch (_) {}
    if (!st.available) continue;
    st.live = liveCwds.has(p.path);
    // Retained runs are worktrees kept alive for an Apply/Discard decision;
    // each one is an open loop for the workspace it came from.
    st.retainedCount = retainedRuns.filter((r) => r && r.workspaceRoot === p.path).length;
    st.lastSessionMs = lastSessionMsForCwd(p.path);
    // .git can be a directory or, for worktrees and submodules, a file.
    try { st.isGit = fs.existsSync(path.join(p.path, '.git')); } catch (_) {}
    if (st.isGit) {
      try {
        const txt = execFileSync('git', ['-C', p.path, 'status', '--porcelain=v1', '--branch'], {
          encoding: 'utf8', stdio: 'pipe', timeout: 4000, maxBuffer: 4 * 1024 * 1024,
        });
        Object.assign(st, parseGitStatus(txt));
      } catch (_) {
        // A repo mid-rebase, or a machine without git, degrades to the
        // plain-folder display rather than an error.
      }
    }
  }
  return { ok: true, states, groups: groupBoard(projects, states, Date.now()) };
});

// Workspace-only detail for one project: the latest commit and the MCP
// servers scoped to this folder. Kept out of projects:state because the board
// never shows these; one git call per project would be paid for nothing.
ipcMain.handle('projects:inspect', (_e, id) => {
  const p = _projectsList().find((x) => x && x.id === id);
  if (!p) return { ok: false, error: 'Project not found.' };
  const out = { ok: true, lastCommit: null, mcpServers: [] };
  try {
    if (fs.existsSync(path.join(p.path, '.git'))) {
      const raw = execFileSync('git', ['-C', p.path, 'log', '-1', '--format=%s%x1f%ct'], {
        encoding: 'utf8', stdio: 'pipe', timeout: 4000,
      }).trim();
      const [subject, epoch] = raw.split('\x1f');
      if (subject) out.lastCommit = { subject: subject.slice(0, 200), ms: (Number(epoch) || 0) * 1000 };
    }
  } catch (_) { /* a repo with no commits yet has no latest commit */ }
  try {
    // Project-scoped MCP servers live under projects[cwd].mcpServers in the
    // CLI's own config; names only, the MCP page owns the editing.
    const entry = ((readClaudeJson() || {}).projects || {})[p.path] || {};
    out.mcpServers = Object.keys(entry.mcpServers || {}).slice(0, 24);
  } catch (_) {}
  return out;
});

// Stamp when the user last looked at a project's workspace. Separate from
// lastUsedAt (which means "launched the agent here") so a future
// since-you-were-here digest has an honest baseline to diff against.
ipcMain.handle('projects:markViewed', (_e, id) => {
  const projects = _projectsList();
  if (!projects.some((p) => p && p.id === id)) return { ok: false, error: 'Project not found.' };
  const stamped = projects.map((p) => p && p.id === id ? { ...p, lastViewedAt: new Date().toISOString() } : p);
  config = { ...config, projects: stamped };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true };
});

// Delete a Husk prompt. Confines the unlink to HUSK_PROMPTS_DIR by resolving
// both the supplied path and the prompts directory, then verifying that the
// resolved file lives directly under it. Symlink/traversal-proof.
ipcMain.handle('prompts:delete', (_e, mdPath) => {
  if (!mdPath || typeof mdPath !== 'string') return { ok: false, error: 'Missing path' };
  try {
    const promptsRoot = path.resolve(HUSK_PROMPTS_DIR);
    const target = path.resolve(mdPath);
    if (!target.startsWith(promptsRoot + path.sep)) {
      return { ok: false, error: 'Refusing to delete outside the prompts directory' };
    }
    if (!fs.existsSync(target)) return { ok: false, error: 'Prompt file not found' };
    fs.unlinkSync(target);
    // Also clear any disabled twin so the slot is fully reclaimed.
    try { fs.unlinkSync(target + '.disabled'); } catch (_) {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Create a new Husk prompt. Always writes to HUSK_PROMPTS_DIR regardless of
// agentKind (the existing skills:create handler routes by agent and would
// instead create a claude skill for claude users; we want prompts to be
// distinct).
ipcMain.handle('prompts:create', (_e, payload = {}) => {
  const { name, description, content } = payload;
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: 'Name must be lowercase letters, digits, dashes; start with a letter.' };
  }
  if (!description || !description.trim()) {
    return { ok: false, error: 'Description is required.' };
  }
  const safeDesc = description.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const body = (content || '').trim() || `# ${name}\n\n${description.trim()}\n`;
  const md = `---\nname: ${name}\ndescription: "${safeDesc}"\n---\n\n${body}\n`;
  try {
    fs.mkdirSync(HUSK_PROMPTS_DIR, { recursive: true });
    const fileName = `${name}.md`;
    const mdPath = path.join(HUSK_PROMPTS_DIR, fileName);
    if (fs.existsSync(mdPath + '.disabled')) {
      return { ok: false, error: `A prompt named "${name}" already exists (disabled).` };
    }
    try {
      fs.writeFileSync(mdPath, md, { flag: 'wx', mode: 0o644 });
    } catch (e) {
      if (e && e.code === 'EEXIST') return { ok: false, error: `A prompt named "${name}" already exists.` };
      throw e;
    }
    return { ok: true, id: fileName, path: mdPath, mdPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:list', () => {
  try {
    const agentKind = getAgentKind();
    const claudeItems = listClaudeSkills();
    const huskItems = listHuskPrompts();
    const items = agentKind === 'claude'
      ? [...claudeItems, ...huskItems]
      : [...huskItems, ...claudeItems];
    items.sort((a, b) => a.name.localeCompare(b.name));
    // Back-compat: renderer reads `skills` field with same shape (id replaces dirName).
    const skills = items.map((it) => ({ ...it, dirName: it.id }));
    return { ok: true, agentKind, items, skills };
  } catch (err) { return { ok: false, error: err.message, items: [], skills: [] }; }
});

ipcMain.handle('skills:read', (_e, mdPath) => {
  // Confine reads to the two roots skills/prompts actually live under, so a
  // crafted mdPath cannot exfiltrate arbitrary files via the renderer bridge.
  if (typeof mdPath !== 'string' || !mdPath) return { ok: false, error: 'Missing path' };
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  if (!isInside(skillsDir, mdPath) && !isInside(HUSK_PROMPTS_DIR, mdPath)) {
    return { ok: false, error: 'Refusing to read outside skills/prompts directories' };
  }
  try { return { ok: true, content: fs.readFileSync(mdPath, 'utf8') }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('skills:create', (_e, { name, description, content }) => {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: 'Name must be lowercase letters, digits, dashes; start with a letter.' };
  }
  if (!description || !description.trim()) {
    return { ok: false, error: 'Description is required.' };
  }
  // Escape backslashes before quotes so YAML double-quoted strings parse
  // backslash-quote pairs correctly.
  const safeDesc = description.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const body = (content || '').trim() || `# ${name}\n\n${description.trim()}\n\n## When to use\n\nDescribe trigger conditions.\n\n## How to use\n\nDescribe steps.\n`;
  const md = `---\nname: ${name}\ndescription: "${safeDesc}"\n---\n\n${body}\n`;
  const agentKind = getAgentKind();
  try {
    if (agentKind === 'claude') {
      const dir = path.join(CLAUDE_DIR, 'skills', name);
      if (fs.existsSync(dir)) return { ok: false, error: `A skill named "${name}" already exists.` };
      fs.mkdirSync(dir, { recursive: true });
      const mdPath = path.join(dir, 'SKILL.md');
      fs.writeFileSync(mdPath, md);
      return { ok: true, source: 'claude', id: name, path: dir, mdPath };
    }
    fs.mkdirSync(HUSK_PROMPTS_DIR, { recursive: true });
    const fileName = `${name}.md`;
    const mdPath = path.join(HUSK_PROMPTS_DIR, fileName);
    if (fs.existsSync(mdPath + '.disabled')) {
      return { ok: false, error: `A prompt named "${name}" already exists.` };
    }
    // Atomic create-if-not-exists via O_EXCL avoids a TOCTOU race between an
    // existsSync probe and the writeFileSync. Throws EEXIST if the path is
    // already there.
    try {
      fs.writeFileSync(mdPath, md, { flag: 'wx', mode: 0o644 });
    } catch (e) {
      if (e && e.code === 'EEXIST') return { ok: false, error: `A prompt named "${name}" already exists.` };
      throw e;
    }
    return { ok: true, source: 'husk', id: fileName, path: mdPath, mdPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Toggle a Claude skill (dir rename) or a Husk prompt (file rename). Renderer
// passes the item's `id` (claude: dirName, husk: fileName) and `source` so we
// route correctly. Back-compat: callers using only `dirName` still work for
// claude items.
ipcMain.handle('skills:toggle', (_e, payload = {}) => {
  const { dirName, id, source } = payload;
  const itemId = id || dirName;
  if (!itemId) return { ok: false, error: 'No item id' };
  if (source === 'husk' || (!source && itemId.endsWith('.md') || itemId.endsWith('.md.disabled'))) {
    const isDisabled = itemId.endsWith('.disabled');
    const newName = isDisabled ? itemId.slice(0, -'.disabled'.length) : `${itemId}.disabled`;
    let oldPath, newPath;
    try {
      oldPath = resolveInside(HUSK_PROMPTS_DIR, itemId);
      newPath = resolveInside(HUSK_PROMPTS_DIR, newName);
    } catch (_) { return { ok: false, error: 'Invalid prompt name' }; }
    if (!fs.existsSync(oldPath)) return { ok: false, error: 'Prompt not found' };
    if (fs.existsSync(newPath)) return { ok: false, error: 'Target already exists' };
    try {
      fs.renameSync(oldPath, newPath);
      return { ok: true, source: 'husk', id: newName, dirName: newName, disabled: !isDisabled };
    } catch (err) { return { ok: false, error: err.message }; }
  }
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  const isDisabled = itemId.startsWith(DISABLED_PREFIX);
  const newDirName = isDisabled ? itemId.slice(DISABLED_PREFIX.length) : DISABLED_PREFIX + itemId;
  let oldPath, newPath;
  try {
    oldPath = resolveInside(skillsDir, itemId);
    newPath = resolveInside(skillsDir, newDirName);
  } catch (_) { return { ok: false, error: 'Invalid skill name' }; }
  if (!fs.existsSync(oldPath)) return { ok: false, error: 'Skill not found' };
  if (fs.existsSync(newPath)) {
    // Both the enabled and disabled copies are present. The target name is
    // already in the desired state, so drop the redundant source instead of
    // failing.
    try { fs.rmSync(oldPath, { recursive: true, force: true }); }
    catch (err) { return { ok: false, error: err.message }; }
    return { ok: true, source: 'claude', id: newDirName, dirName: newDirName, disabled: !isDisabled };
  }
  try {
    fs.renameSync(oldPath, newPath);
    return { ok: true, source: 'claude', id: newDirName, dirName: newDirName, disabled: !isDisabled };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ─── Plugins (agent-CLI plugin registry) ────────────────────────────────────
//
// Reads come straight from the registry files on disk (instant, no
// subprocess). Mutations shell out to the agent CLI so it remains the
// single writer of its own registry. Only agents with a plugin system
// are supported; everything else gets a graceful supported:false,
// mirroring sessions:list. Claude and Copilot both expose plugins, but
// their on-disk registries and supported verbs differ.

const Plugins = require('./lib/plugins');

const PLUGIN_CLI_TIMEOUT_MS = 180000; // installs may git-clone
const PLUGIN_CLI_OUTPUT_CAP = 65536;

function copilotCacheDir() {
  if (process.env.COPILOT_CACHE_HOME) return process.env.COPILOT_CACHE_HOME;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'copilot');
  const base = process.env.XDG_CACHE_HOME || path.join(HOME, '.cache');
  return path.join(base, 'copilot');
}

function activePluginContext() {
  const agent = agentBaseName(config.agentCommand || 'claude');
  if (agent === 'claude') return { agent, dir: CLAUDE_DIR, cacheDir: '' };
  if (agent === 'copilot') return { agent, dir: COPILOT_DIR, cacheDir: copilotCacheDir() };
  return null;
}

// Resolve a validated installed plugin's install path, confined to the
// plugins root. Returns null when unknown or outside the root (a
// tampered registry must not turn the editor into an arbitrary-fs API).
function pluginInstallPath(id) {
  if (!Plugins.isSafePluginId(id)) return null;
  const ctx = activePluginContext();
  if (!ctx) return null;
  const inst = Plugins.readInstalled(ctx.dir, ctx.agent, ctx.cacheDir).find((p) => p.id === id);
  if (!inst || !inst.installPath) return null;
  if (!Plugins.isInsidePluginsRoot(ctx.dir, inst.installPath, ctx.agent)) return null;
  return inst.installPath;
}

ipcMain.handle('plugins:list', () => {
  const ctx = activePluginContext();
  if (!ctx) return { ok: true, supported: false, plugins: [] };
  return {
    ok: true,
    supported: true,
    agent: ctx.agent,
    capabilities: Plugins.pluginCapabilities(ctx.agent),
    plugins: Plugins.readInstalled(ctx.dir, ctx.agent, ctx.cacheDir),
  };
});

ipcMain.handle('plugins:catalog', () => {
  const ctx = activePluginContext();
  if (!ctx) return { ok: true, supported: false, catalog: [] };
  return {
    ok: true,
    supported: true,
    agent: ctx.agent,
    capabilities: Plugins.pluginCapabilities(ctx.agent),
    catalog: Plugins.readCatalog(ctx.dir, ctx.agent, ctx.cacheDir),
  };
});

ipcMain.handle('plugins:run', (_e, payload = {}) => {
  const ctx = activePluginContext();
  if (!ctx) return { ok: false, error: 'the active agent has no plugin system' };
  const verb = String(payload.action || '');
  // buildPluginCliArgs owns the verb allowlist AND the id validation
  // (isSafePluginId): null means one of them failed. The id rides as a
  // single argv element with no shell, so neither flags nor
  // metacharacters can ride along.
  const argv = Plugins.buildPluginCliArgs(ctx.agent, verb, String(payload.id || ''));
  if (!argv) return { ok: false, error: 'invalid plugin action or identifier' };
  const cmd = (config.agentCommand || 'claude').trim().split(/\s+/)[0];
  if (!isAllowedAgentCommand(cmd)) return { ok: false, error: `agent command "${cmd}" is not allowlisted` };
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (res) => { if (!done) { done = true; resolve(res); } };
    let child;
    try {
      child = spawn(cmd, argv, { cwd: HOME, env: process.env, shell: false });
    } catch (err) {
      return finish({ ok: false, error: err.message });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish({ ok: false, error: `plugin ${verb} timed out`, output: out });
    }, PLUGIN_CLI_TIMEOUT_MS);
    const collect = (d) => { if (out.length < PLUGIN_CLI_OUTPUT_CAP) out += String(d); };
    if (child.stdout) child.stdout.on('data', collect);
    if (child.stderr) child.stderr.on('data', collect);
    child.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message, output: out }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0
        ? { ok: true, output: out }
        : { ok: false, error: `plugin ${verb} exited with code ${code}`, output: out });
    });
  });
});

ipcMain.handle('plugins:files', (_e, payload = {}) => {
  const installPath = pluginInstallPath(String(payload.id || ''));
  if (!installPath) return { ok: false, error: 'plugin not found' };
  return { ok: true, files: Plugins.listPluginFiles(installPath) };
});

ipcMain.handle('plugins:readFile', (_e, payload = {}) => {
  const installPath = pluginInstallPath(String(payload.id || ''));
  if (!installPath) return { ok: false, error: 'plugin not found' };
  let abs;
  try { abs = resolveInside(installPath, String(payload.relPath || '')); }
  catch (_) { return { ok: false, error: 'invalid file path' }; }
  // Open with O_NOFOLLOW so a symlink (a marketplace plugin could ship one
  // pointing outside its own dir) is refused, and stat + read through the one
  // descriptor so the regular-file check and the read see the same inode.
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
  catch (_) { return { ok: false, error: 'file not found' }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: 'not a regular file' };
    if (!Plugins.isEditableFile(abs, st.size)) return { ok: false, error: 'file is binary or too large to edit' };
    return { ok: true, content: fs.readFileSync(fd, 'utf8') };
  } catch (err) { return { ok: false, error: err.message }; }
  finally { fs.closeSync(fd); }
});

ipcMain.handle('plugins:writeFile', (_e, payload = {}) => {
  const installPath = pluginInstallPath(String(payload.id || ''));
  if (!installPath) return { ok: false, error: 'plugin not found' };
  const content = typeof payload.content === 'string' ? payload.content : null;
  if (content == null) return { ok: false, error: 'content required' };
  if (Buffer.byteLength(content, 'utf8') > Plugins.MAX_FILE_BYTES) {
    return { ok: false, error: 'content too large' };
  }
  let abs;
  try { abs = resolveInside(installPath, String(payload.relPath || '')); }
  catch (_) { return { ok: false, error: 'invalid file path' }; }
  if (!Plugins.isEditableName(abs)) return { ok: false, error: 'file type is not editable' };
  // Open the existing file with O_NOFOLLOW (no create, no symlink follow) and
  // write through that descriptor, so the regular-file guarantee and the write
  // target are the same inode even if the path is swapped after validation.
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0)); }
  catch (_) { return { ok: false, error: 'file not found' }; }
  try {
    if (!fs.fstatSync(fd).isFile()) return { ok: false, error: 'not a regular file' };
    fs.writeFileSync(fd, content);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
  finally { fs.closeSync(fd); }
});

ipcMain.handle('plugins:openFolder', (_e, payload = {}) => {
  const installPath = pluginInstallPath(String(payload.id || ''));
  if (!installPath) return { ok: false, error: 'plugin not found' };
  shell.openPath(installPath);
  return { ok: true };
});

// ─── Sessions reader (MEMORY/WORK/<slug>/PRD.md) ────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    out[k] = v;
  }
  return out;
}

// PRD listing API: enumerates work folders under MEMORY/WORK and returns frontmatter metadata.
ipcMain.handle('prds:list', () => {
  const workDir = path.join(CLAUDE_DIR, 'MEMORY', 'WORK');
  try {
    const slugs = fs.readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    const prds = slugs.map((slug) => {
      const dir = path.join(workDir, slug);
      const prd = path.join(dir, 'PRD.md');
      let fm = {}; let task = slug;
      try { fm = parseFrontmatter(fs.readFileSync(prd, 'utf8')); task = fm.task || slug; } catch (_) {}
      let mtime = 0;
      try { mtime = fs.statSync(prd).mtimeMs || fs.statSync(dir).mtimeMs; } catch (_) {}
      return { slug, task, phase: fm.phase || 'unknown', progress: fm.progress || '',
               effort: fm.effort || '', started: fm.started || '', updated: fm.updated || '',
               path: dir, prdPath: prd, mtime };
    });
    prds.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, prds };
  } catch (err) { return { ok: false, error: err.message, prds: [] }; }
});

// Decode an encoded project dir name back to a real on-disk path.
// Claude's encoding: cwd's path with '/' → '-'. Problem: directory names that contain
// literal dashes in directory names become indistinguishable from path separators.
// Strategy: try all-slash interpretation first; if it doesn't exist, BFS over "merge
// adjacent segments with a dash" combinations and return the first that exists.
const projectPathCache = new Map();
function decodeProjectPath(encoded) {
  if (!encoded) return '';
  if (projectPathCache.has(encoded)) return projectPathCache.get(encoded);

  const naive = '/' + encoded.replace(/^-/, '').replace(/-/g, '/');
  if (fs.existsSync(naive)) { projectPathCache.set(encoded, naive); return naive; }

  const inner = encoded.replace(/^-/, '');
  const parts = inner.split('-');
  const queue = [parts];
  const seen = new Set();
  while (queue.length) {
    const arr = queue.shift();
    const key = arr.join('§');
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = '/' + arr.join('/');
    try { if (fs.existsSync(candidate)) { projectPathCache.set(encoded, candidate); return candidate; } } catch (_) {}
    for (let i = 0; i < arr.length - 1; i++) {
      const next = [...arr.slice(0, i), arr[i] + '-' + arr[i + 1], ...arr.slice(i + 2)];
      queue.push(next);
    }
  }
  // Fallback: return naive form (won't exist, but at least readable)
  projectPathCache.set(encoded, naive);
  return naive;
}

// Read up to N bytes of a file from offset 0
function readHead(filePath, bytes) {
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(filePath, 'r');
  const n = fs.readSync(fd, buf, 0, bytes, 0);
  fs.closeSync(fd);
  return buf.toString('utf8', 0, n);
}

// Whether a transcript holds any human-typed turn. Used to tell a real chat
// (keep) from a purely SDK-driven background transcript (hide) when the 32KB
// head was inconclusive. A real chat's first human turn can sit past the head
// when an SDK context turn was prepended (PAI hooks inject one), so the whole
// file is scanned before anything is hidden. Bounded: past the cap a file is
// too big to verify cheaply and is kept, never hidden -- false-show is safe,
// false-hide loses a real conversation.
const HUMAN_SCAN_CAP = 4 * 1024 * 1024;
function transcriptHasHumanTurn(fullPath, fileSize) {
  if (fileSize > HUMAN_SCAN_CAP) return true;
  let text = '';
  try { text = fs.readFileSync(fullPath, 'utf8'); } catch (_) { return true; }
  return text.includes('"kind":"human"') || text.includes('"promptSource":"typed"');
}

// Agents append a title entry to the transcript once the conversation earns a
// name, and further entries as they refine it. Both land wherever the
// conversation had reached, which in a long session is hundreds of kilobytes past
// the head, so a title cannot be found by reading the head alone.
//
// Scan forward from wherever the last read stopped and keep the newest title.
// A poll then costs the bytes appended since the previous poll rather than the
// size of the whole transcript, which matters because this runs every few
// seconds for each open tab and transcripts reach tens of megabytes.
//
// The shape of the entry differs per CLI, so a dialect supplies a cheap substring
// to prefilter lines on and an extractor to pull the title out of a parsed one.
const TITLE_DIALECTS = Object.freeze({
  // claude: {"type":"ai-title","aiTitle":"..."}
  claude: {
    marker: '"ai-title"',
    extract: (o) => (o && o.type === 'ai-title' && typeof o.aiTitle === 'string' ? o.aiTitle : ''),
  },
  // gemini: {"$set":{"summary":"...", ...}}
  gemini: {
    marker: '"$set"',
    extract: (o) => (o && o.$set && typeof o.$set.summary === 'string' ? o.$set.summary : ''),
  },
});

const titleScanCache = new Map(); // `${dialect}:${path}` -> { size, mtimeMs, scanned, title }
const TITLE_CACHE_MAX = 300;

function latestTranscriptTitle(fullPath, dialectName) {
  const dialect = TITLE_DIALECTS[dialectName];
  if (!dialect) return '';

  const key = `${dialectName}:${fullPath}`;
  const prev = titleScanCache.get(key);

  // Open once and measure the descriptor. Sizing the read from a stat of the
  // path and then opening the path again reads whatever the name points at by
  // then, which need not be the file that was measured.
  let fd;
  try { fd = fs.openSync(fullPath, 'r'); } catch (_) { return ''; }

  let title = '';
  try {
    const st = fs.fstatSync(fd);
    // Resume from the previous read only when this is the same file, still
    // growing. A file that shrank was replaced, so start over.
    const resumable = prev && st.size >= prev.size;
    let scanned = resumable ? prev.scanned : 0;
    title = resumable ? prev.title : '';

    if (scanned < st.size) {
      const len = st.size - scanned;
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, scanned);
      const text = buf.toString('utf8', 0, n);
      // A read can land mid-line, so only consume up to the last newline and
      // leave the remainder for the next pass.
      const lastNl = text.lastIndexOf('\n');
      if (lastNl >= 0) {
        for (const line of text.slice(0, lastNl).split('\n')) {
          // Cheap prefilter: parsing every line of a large transcript is the
          // expensive part, and only these carry a title.
          if (line.indexOf(dialect.marker) === -1) continue;
          try {
            const found = String(dialect.extract(JSON.parse(line)) || '').trim();
            if (found) title = found;
          } catch (_) { /* a partial or malformed line is not a title */ }
        }
        scanned += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
      }
    }

    if (titleScanCache.size > TITLE_CACHE_MAX) titleScanCache.clear();
    titleScanCache.set(key, { size: st.size, mtimeMs: st.mtimeMs, scanned, title });
    return title;
  } catch (_) {
    return title;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function latestAiTitle(fullPath) {
  return latestTranscriptTitle(fullPath, 'claude');
}

// ─── gemini sessions ────────────────────────────────────────────────────────
// gemini keeps one directory per project under ~/.gemini/tmp/<name>/, holding a
// .project_root naming the cwd and chats/session-<stamp>-<short-id>.jsonl per
// session. A session file opens with a header line carrying sessionId and
// startTime, then appends message entries, and writes its generated name into a
// {"$set":{"summary":"..."}} entry once the conversation earns one.
const GEMINI_DIR = path.join(HOME, '.gemini');

function geminiProjectRoot(projectDir) {
  try { return fs.readFileSync(path.join(projectDir, '.project_root'), 'utf8').trim(); }
  catch (_) { return ''; }
}

// First real user turn, used as the title until gemini writes its summary. The
// content is an array of parts, matching the transcript on disk.
function geminiFirstUserMessage(fullPath) {
  try {
    for (const line of readHead(fullPath, 32768).split('\n')) {
      if (!line.trim() || line.indexOf('"user"') === -1) continue;
      let o;
      try { o = JSON.parse(line); } catch (_) { continue; }
      if (!o || o.type !== 'user') continue;
      const c = o.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const part = c.find((p) => p && typeof p.text === 'string' && p.text.trim());
        if (part) text = part.text;
      }
      text = String(text || '').replace(/\s+/g, ' ').trim();
      // Slash commands are not a conversation, so keep looking for a real turn.
      if (text && !text.startsWith('/')) return text.slice(0, 120);
    }
  } catch (_) { /* an unreadable transcript simply has no title */ }
  return '';
}

function listGeminiSessions(opts = {}) {
  const root = path.join(GEMINI_DIR, 'tmp');
  let projects = [];
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (_) { return []; }

  const out = [];
  for (const proj of projects) {
    const projDir = path.join(root, proj.name);
    const cwd = geminiProjectRoot(projDir);
    const chatsDir = path.join(projDir, 'chats');
    let files = [];
    try { files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.jsonl')); }
    catch (_) { continue; }

    for (const f of files) {
      const fullPath = path.join(chatsDir, f);
      let st;
      try { st = fs.statSync(fullPath); } catch (_) { continue; }
      if (!st.isFile()) continue;

      let head = null;
      try { head = JSON.parse(readHead(fullPath, 4096).split('\n')[0] || 'null'); } catch (_) { head = null; }
      const id = head && typeof head.sessionId === 'string' ? head.sessionId : '';
      if (!id) continue;

      const summary = latestTranscriptTitle(fullPath, 'gemini');
      const firstMessage = geminiFirstUserMessage(fullPath);
      // A transcript with no turn in it belongs to a chat that was opened and
      // closed without a word. It is not history, and callers that only need
      // history skip it. Resume-index and live-tab discovery pass includeEmpty
      // because both address sessions by position or by launch time.
      const hasContent = st.size > 0 && !!(summary || firstMessage);
      if (!hasContent && opts.includeEmpty !== true) continue;
      const startedMs = Date.parse((head && head.startTime) || '') || st.birthtimeMs || st.mtimeMs;

      out.push({
        id,
        project: proj.name,
        projectPath: cwd,
        originalCwd: cwd,
        path: fullPath,
        title: (summary || firstMessage || 'New Gemini chat').slice(0, 120),
        // True only for a name gemini generated, never the first-message fallback,
        // so a tab keeps its pending state until the session really earns a name.
        named: !!summary,
        firstMessage: firstMessage || summary || '',
        hasContent,
        prdSlug: '', prdPhase: '', prdProgress: '', prdPath: '',
        startedISO: new Date(startedMs).toISOString(),
        startedMs,
        sizeBytes: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// gemini resumes by position, not by id: `--resume <n>` where n indexes the
// project's sessions oldest-first, as `gemini --list-sessions` prints them. The
// index therefore has to be computed against the current list, since a new
// session shifts nothing but a deleted one would.
function geminiResumeIndex(sessionId, cwd) {
  const mine = listGeminiSessions({ includeEmpty: true })
    .filter((s) => !cwd || !s.originalCwd || s.originalCwd === cwd)
    .sort((a, b) => a.startedMs - b.startedMs);
  const at = mine.findIndex((s) => s.id === sessionId);
  return at === -1 ? 0 : at + 1;
}

// Read the last `bytes` of a file. Used to take a transcript's last-activity
// timestamp from its final entry, which reflects real activity more reliably
// than the file mtime (opening or scanning a session updates mtime).
function readTail(filePath, bytes, fileSize) {
  const len = Math.min(bytes, fileSize);
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, 'r');
  const n = fs.readSync(fd, buf, 0, len, fileSize - len);
  fs.closeSync(fd);
  return buf.toString('utf8', 0, n);
}
function lastActivityMs(filePath, fileSize, fallbackMs) {
  try {
    const tail = readTail(filePath, 8192, fileSize);
    let last = null;
    const re = /"timestamp":"([^"]+)"/g;
    let m;
    while ((m = re.exec(tail)) !== null) last = m[1];
    if (last) { const t = Date.parse(last); if (isFinite(t)) return t; }
  } catch (_) {}
  return fallbackMs;
}

// Parse the head of a claude session JSONL for the fields Husk titles a
// session by: claude's own ai-title, the first user message, a queued prompt,
// the start timestamp, and the original working directory. Returns null if the
// file cannot be read.
// True when a user-message body is a slash-command or system wrapper rather
// than a human sentence, so title derivation can skip it.
function isCommandWrapperText(t) {
  if (!t) return true;
  return /^<\/?(local-)?command[-a-z]*/i.test(t)
    || /^<command-(name|message|args)>/i.test(t)
    || /^<local-command-/i.test(t)
    || /^<system-reminder/i.test(t)
    || /^<user-prompt-submit-hook/i.test(t)
    || /^Caveat:/i.test(t);
}
function parseSessionHead(fullPath) {
  // The title is the one field that is not in the head: it is appended once the
  // conversation earns a name, so it is read from the whole transcript. The rest
  // describe how the session opened and are always in the first entries.
  let aiTitle = latestAiTitle(fullPath);
  let userMessage = ''; let queueContent = '';
  let startedISO = ''; let originalCwd = '';
  // An interactive session opens with the terminal preamble the CLI writes when
  // a person is driving it. One-shot helper runs (title generation, hooks that
  // summarise a conversation) land in the same project directory with the same
  // cwd and a fresh timestamp, but never emit that preamble. Without this the
  // two are indistinguishable, and a helper transcript can be mistaken for a
  // chat the user just started.
  let interactive = false;
  try {
    const text = readHead(fullPath, 32768);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj.type === 'mode' || obj.type === 'permission-mode' || obj.type === 'file-history-snapshot') interactive = true;
      if (!startedISO && obj.timestamp) startedISO = obj.timestamp;
      if (!originalCwd && typeof obj.cwd === 'string') originalCwd = obj.cwd;
      if (!userMessage && obj.type === 'user' && obj.message) {
        const c = obj.message.content;
        let text = '';
        if (typeof c === 'string') text = c.trim();
        else if (Array.isArray(c)) {
          const tp = c.find((p) => p && p.type === 'text' && typeof p.text === 'string');
          if (tp) text = tp.text.trim();
        }
        // Skip slash-command and system wrappers (e.g. "<local-command-...>",
        // "<command-name>", a caveat banner, a system-reminder). They are not a
        // human message and read as garbage titles; keep scanning for a real one.
        if (text && !isCommandWrapperText(text)) userMessage = text;
      }
      if (!queueContent && obj.type === 'queue-operation' && typeof obj.content === 'string') queueContent = obj.content.trim();
      if (interactive && aiTitle && startedISO && userMessage && originalCwd) break;
    }
  } catch (_) { return null; }
  return { aiTitle, userMessage, queueContent, startedISO, originalCwd, interactive };
}

// The display title a session would show, given its parsed head fields. Same
// priority the Sessions list uses: ai-title, else first user message, else a
// queued prompt.
function sessionTitleFrom(info) {
  if (!info) return '';
  return (info.aiTitle || info.userMessage || info.queueContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// The active agent program name (first token of the configured command,
// lowercased): 'claude', 'copilot', 'codex', 'aider', etc. Husk is
// tool-agnostic, so anything that reads agent-specific state keys off this.
function activeAgentName() {
  return (config.agentCommand || 'claude').trim().split(/\s+/)[0].toLowerCase();
}

// Parse a copilot session's workspace.yaml (a flat key: value file) into an
// object. Returns null if it cannot be read.
// Copilot session state is polled from several places (title sync, Recent
// list, stats). With hundreds of session dirs a naive pass rereads tens of MB
// per tick, so both readers below are cached on file identity (size + mtime):
// unchanged files parse once, and a poll cycle degrades to stat() calls.
const copilotWorkspaceCache = new Map(); // dir -> { sig, ws }
const copilotTitleCache = new Map(); // dir -> { sig, value }
const COPILOT_CACHE_MAX = 4000;

function readCopilotWorkspace(dir) {
  const yamlPath = path.join(dir, 'workspace.yaml');
  // The cache signature and the contents both come from one descriptor, so the
  // entry can never describe a different file than the one that was read.
  let fd;
  try { fd = fs.openSync(yamlPath, 'r'); } catch (_) { return null; }
  try {
    const st = fs.fstatSync(fd);
    const sig = `${st.size}:${st.mtimeMs}`;
    const hit = copilotWorkspaceCache.get(dir);
    if (hit && hit.sig === sig) return hit.ws;
    const text = fs.readFileSync(fd, 'utf8');
    const o = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) o[m[1]] = m[2].trim();
    }
    if (copilotWorkspaceCache.size > COPILOT_CACHE_MAX) copilotWorkspaceCache.clear();
    copilotWorkspaceCache.set(dir, { sig, ws: o });
    return o;
  } catch (_) { return null; }
  finally { try { fs.closeSync(fd); } catch (_) {} }
}

function readCopilotSessionTitle(dir) {
  try {
    const eventsPath = path.join(dir, 'events.jsonl');
    const fd = fs.openSync(eventsPath, 'r');
    try {
      const CAP = 192 * 1024;
      const st = fs.fstatSync(fd);
      const sz = st.size;
      const sig = `${sz}:${st.mtimeMs}`;
      const hit = copilotTitleCache.get(dir);
      if (hit && hit.sig === sig) return hit.value;
      const len = Math.min(sz, CAP);
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, 0);
      const raw = b.toString('utf8');
      const value = { ...deriveCopilotSessionTitleFromEventsText(raw), autopilot: containsAutopilotCopilotText(raw) };
      if (copilotTitleCache.size > COPILOT_CACHE_MAX) copilotTitleCache.clear();
      copilotTitleCache.set(dir, { sig, value });
      return value;
    } finally { fs.closeSync(fd); }
  } catch (_) {
    return { title: '', firstMessage: '', generatedTitle: '', sawAssistant: false, autopilot: false };
  }
}

function isAutopilotCopilotText(text) {
  const t = String(text || '').trim().replace(/^\|-\s*/, '').trim();
  return /^\[AUTONOMOUS MODE\]/.test(t)
    || /^\[COLLAB TEAM\]/.test(t)
    || /^\[COLLAB INTEGRATION\]/.test(t)
    || /^You are an orchestrator planning a team of autonomous coding agents\b/.test(t)
    || /^Integrate the team's parallel work:/i.test(t)
    || /^Continue autonomously\./i.test(t)
    || /^Continue working toward the goal autonomously\./i.test(t)
    || /^No human is available to answer questions\./i.test(t);
}

function containsAutopilotCopilotText(text) {
  const t = String(text || '');
  return /\[AUTONOMOUS MODE\]/.test(t)
    || /\[COLLAB TEAM\]/.test(t)
    || /\[COLLAB INTEGRATION\]/.test(t)
    || /You are an orchestrator planning a team of autonomous coding agents\b/.test(t)
    || /Integrate the team's parallel work:/i.test(t)
    || /\.husk-autopilot-status\.json/.test(t)
    || /No human is available to answer questions\./i.test(t)
    || /Continue autonomously\./i.test(t)
    || /Continue working toward the goal autonomously\./i.test(t);
}

function isAutopilotCopilotSession(ws, eventTitle) {
  return isAutopilotWorkspacePath(ws && ws.cwd)
    || !!(eventTitle && eventTitle.autopilot)
    || isAutopilotCopilotText(eventTitle && eventTitle.firstMessage)
    || isAutopilotCopilotText(eventTitle && eventTitle.title);
}

// List copilot sessions from <COPILOT_HOME>/session-state/<uuid>/, normalized to
// the same shape the renderer consumes for claude sessions. Copilot stores the
// cwd and timestamps in each session's workspace.yaml; names are often null,
// so derive a stable title from the event log's first user turn.
function listCopilotSessions(opts = {}) {
  const root = path.join(COPILOT_DIR, 'session-state');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (_) { return opts.withMeta ? { sessions: [], hiddenAutopilot: 0 } : []; }
  const out = [];
  let hiddenAutopilot = 0;
  for (const d of dirs) {
    const full = path.join(root, d.name);
    const ws = readCopilotWorkspace(full);
    if (!ws || !ws.id) continue;
    const eventTitle = readCopilotSessionTitle(full);
    if (isAutopilotCopilotSession(ws, eventTitle)) {
      hiddenAutopilot++;
      if (opts.includeAutopilot !== true) continue;
    }
    let mtime = Date.parse(ws.updated_at) || 0;
    let sizeBytes = 0;
    try { const st = fs.statSync(path.join(full, 'events.jsonl')); sizeBytes = st.size; if (!mtime) mtime = st.mtimeMs; }
    catch (_) { if (!mtime) { try { mtime = fs.statSync(full).mtimeMs; } catch (_e) {} } }
    const startedMs = Date.parse(ws.created_at) || mtime;
    const name = (ws.name && ws.name !== 'null') ? ws.name.slice(0, 120) : '';
    // The CLI creates a session directory the moment it launches and only writes
    // events.jsonl once the conversation starts, so a chat opened and closed
    // without a turn leaves a directory that holds nothing, can never earn a
    // name, and cannot be resumed. That is not history: it is listed only for
    // callers that bind a live tab to its session, which need every candidate.
    const hasContent = sizeBytes > 0 || !!name;
    if (!hasContent && opts.includeEmpty !== true) continue;
    const title = name || eventTitle.title || 'New Copilot chat';
    const firstMessage = eventTitle.firstMessage || name || '';
    out.push({
      id: ws.id,
      project: ws.cwd || '',
      projectPath: ws.cwd || '',
      originalCwd: ws.cwd || '',
      path: full,
      title,
      // True once the session carries a real name (the CLI's generated one or
      // a user rename), not the first-user-message fallback.
      named: !!(name || eventTitle.generatedTitle),
      firstMessage,
      prdSlug: '', prdPhase: '', prdProgress: '', prdPath: '',
      // Tab discovery prefers a session that carries content: a tab bound to an
      // empty one shows the pending dots forever.
      hasContent,
      startedISO: ws.created_at || new Date(mtime || 0).toISOString(),
      startedMs,
      sizeBytes,
      mtime,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  if (opts.withMeta) return { sessions: out, hiddenAutopilot };
  return out;
}

function sameResolvedPath(a, b) {
  if (!a || !b) return false;
  try { return path.resolve(a) === path.resolve(b); }
  catch (_) { return String(a) === String(b); }
}

function findCopilotSessionForResume(id, cwd) {
  const want = String(id || '');
  if (!want) return null;
  const targetCwd = String(cwd || '');
  const list = listCopilotSessions({ includeAutopilot: true, includeEmpty: true });
  return list.find((s) => {
    if (!s || s.id !== want) return false;
    return !targetCwd || !s.originalCwd || sameResolvedPath(s.originalCwd, targetCwd);
  }) || null;
}

// List the active agent's saved sessions. Husk is tool-agnostic: the source
// (and on-disk format) depends on which CLI is active. claude keeps JSONL
// transcripts under ~/.claude/projects; copilot keeps per-session folders under
// <COPILOT_HOME>/session-state. Agents we do not yet read return an empty list with
// supported:false so the UI can say so instead of erroring.
ipcMain.handle('sessions:list', () => {
  const agent = activeAgentName();
  if (agent === 'copilot') {
    const listed = listCopilotSessions({ withMeta: true });
    return {
      ok: true,
      agent,
      supported: true,
      sessionsDir: path.join(COPILOT_DIR, 'session-state'),
      currentCwd: activePtyCwd || '',
      sessions: listed.sessions,
      hiddenAutopilotSessions: listed.hiddenAutopilot,
    };
  }
  if (agent === 'gemini') {
    return {
      ok: true,
      agent,
      supported: true,
      sessionsDir: path.join(GEMINI_DIR, 'tmp'),
      currentCwd: activePtyCwd || '',
      sessions: listGeminiSessions(),
      hiddenAutopilotSessions: 0,
    };
  }
  if (agent !== 'claude') {
    return { ok: true, agent, supported: false, sessionsDir: '', sessions: [] };
  }
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  let projects = [];
  // A missing projects dir just means no sessions yet (e.g. a fresh install or
  // a machine that has never run claude). Return empty, not an error.
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (_) { return { ok: true, agent: 'claude', supported: true, sessionsDir: projectsDir, sessions: [] }; }

  // Pre-load PRDs for matching by timestamp
  let prds = [];
  try {
    const workDir = path.join(CLAUDE_DIR, 'MEMORY', 'WORK');
    const slugs = fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const s of slugs) {
      const prdPath = path.join(workDir, s.name, 'PRD.md');
      try {
        const fm = parseFrontmatter(fs.readFileSync(prdPath, 'utf8'));
        if (fm.started) {
          prds.push({ slug: s.name, task: fm.task || s.name, phase: fm.phase || '', progress: fm.progress || '', startedMs: Date.parse(fm.started), prdPath });
        }
      } catch (_) {}
    }
  } catch (_) {}

  // A PRD is created moments after the session that runs it starts, so
  // match only near the session START. Matching anywhere in the session
  // lifetime stamped one PRD's task onto every long-lived session whose
  // window happened to span it (including sessions of other projects),
  // making unrelated rows look like duplicates of one conversation.
  const PRD_MATCH_WINDOW_MS = 5 * 60_000;
  function matchPrd(sessionStartMs) {
    let best = null; let bestDiff = Infinity;
    for (const p of prds) {
      if (!isFinite(p.startedMs)) continue;
      const diff = Math.abs(p.startedMs - sessionStartMs);
      if (diff <= PRD_MATCH_WINDOW_MS && diff < bestDiff) { bestDiff = diff; best = p; }
    }
    return best;
  }

  // Pass 1: collect cheap stat for all files
  const candidates = [];
  for (const proj of projects) {
    const projPath = path.join(projectsDir, proj.name);
    let files = [];
    try { files = fs.readdirSync(projPath); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const fullPath = path.join(projPath, f);
      let st;
      try { st = fs.statSync(fullPath); } catch (_) { continue; }
      if (st.size === 0) continue;
      candidates.push({ id, project: proj.name, fullPath, st });
    }
  }
  // Sort by mtime desc, cap to 300 most-recent. Older sessions are still on disk if user wants them.
  candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const top = candidates.slice(0, 300);

  // Pass 2: read first 8KB for timestamp + first message preview
  const out = [];
  let hiddenAutopilot = 0;
  for (const { id, project: projName, fullPath, st } of top) {
    {
      // Read the first 32KB for how the session opened, and take the title from
      // the whole transcript: it is appended once the conversation earns a name,
      // which for a long session is far past the head.
      let startedISO = '';
      let aiTitle = latestAiTitle(fullPath);
      let userMessage = '';
      let queueContent = '';
      let originalCwd = '';
      let sawAssistant = false;
      let headComplete = false;
      // How this session's turns were authored. A human-typed chat carries
      // promptSource "typed" / origin.kind "human" on at least one turn; a
      // purely SDK-driven background transcript carries only "sdk". Accumulated
      // across every turn in the head, not just the first: an SDK context turn
      // can be prepended to a real chat, so one human turn anywhere keeps it.
      let sawHumanTurn = false;
      let sawSdkTurn = false;
      let sawPromptSource = false;
      try {
        const text = readHead(fullPath, 32768);
        headComplete = st.size <= 32768;
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch (_) { continue; }
          if (!sawAssistant && obj.type === 'assistant') sawAssistant = true;
          if (!startedISO && obj.timestamp) startedISO = obj.timestamp;
          if (!originalCwd && typeof obj.cwd === 'string') originalCwd = obj.cwd;
          if (obj.type === 'user') {
            const originKind = obj.origin && typeof obj.origin === 'object' ? obj.origin.kind : null;
            const ps = typeof obj.promptSource === 'string' ? obj.promptSource : null;
            if (ps) sawPromptSource = true;
            if (originKind === 'human' || ps === 'typed') sawHumanTurn = true;
            else if (ps === 'sdk') sawSdkTurn = true;
          }
          if (!userMessage && obj.type === 'user' && obj.message) {
            const c = obj.message.content;
            if (typeof c === 'string') userMessage = c.trim();
            else if (Array.isArray(c)) {
              const t = c.find((p) => p && p.type === 'text' && typeof p.text === 'string');
              if (t) userMessage = t.text.trim();
            }
          }
          if (!queueContent && obj.type === 'queue-operation' && typeof obj.content === 'string') {
            queueContent = obj.content.trim();
          }
          // Only short-circuit when the head is partial (a big file): we
          // already have the title fields and need not read the rest. For a
          // small file that fits entirely in the window, keep scanning so
          // sawAssistant is decided over the whole file (the receipt-skip
          // below depends on it).
          if (!headComplete && aiTitle && startedISO && userMessage && originalCwd) break;
        }
      } catch (_) {}
      // Husk drives claude over the SDK; every enqueued prompt also writes a
      // tiny queue-operation receipt file with no assistant turn. Those are
      // shadows of prompts that actually ran in the real session file, so
      // listing them produces a duplicate row per prompt. A file whose whole
      // head fits in the read window AND carries no assistant turn is such a
      // receipt: skip it. Real conversations always have assistant output.
      if (headComplete && !sawAssistant) continue;

      // The Sessions list is for chats the user actually held. Husk also spawns
      // claude over the SDK for its own background work -- PAI hooks that shell
      // out to `claude --print` for sentiment/context scoring, and the autopilot
      // and workflow orchestrators -- and every one of those leaves a transcript
      // in this same projects dir, each auto-titled differently, so one real
      // conversation sits among a crowd of look-alike SDK runs on disk.
      // A transcript with SDK turns and no human turn anywhere is such a
      // background run: skip it. If the head was inconclusive on a larger file,
      // scan the whole file first -- a real chat can open with a prepended SDK
      // context turn. Files that predate promptSource carry no signal and are
      // kept, so real history is never hidden.
      let background = sawSdkTurn && !sawHumanTurn && sawPromptSource;
      if (background && !headComplete) background = !transcriptHasHumanTurn(fullPath, st.size);
      if (background) continue;

      const firstMessage = (aiTitle || userMessage || queueContent || '').slice(0, 220);

      const sessionStartMs = startedISO ? Date.parse(startedISO) : st.mtimeMs;
      const matchedPrd = matchPrd(sessionStartMs);

      // Authoritative cwd is what the JSONL recorded; fall back to decoded project name
      const cwdAuthoritative = originalCwd || decodeProjectPath(projName);
      if (isAutopilotWorkspacePath(cwdAuthoritative)) {
        hiddenAutopilot++;
        continue;
      }

      out.push({
        id,
        project: projName,
        projectPath: cwdAuthoritative,
        originalCwd: originalCwd || '',
        path: fullPath,
        title: matchedPrd ? matchedPrd.task : (firstMessage || '(empty)'),
        // True once the transcript carries a generated title, not just the
        // first user message standing in for one.
        named: !!aiTitle || !!matchedPrd,
        firstMessage: firstMessage || '',
        prdSlug: matchedPrd ? matchedPrd.slug : '',
        prdPhase: matchedPrd ? matchedPrd.phase : '',
        prdProgress: matchedPrd ? matchedPrd.progress : '',
        prdPath: matchedPrd ? matchedPrd.prdPath : '',
        startedISO: startedISO || new Date(st.mtimeMs).toISOString(),
        startedMs: sessionStartMs,
        sizeBytes: st.size,
        // Last-activity from the transcript's final entry; tracks real activity
        // more reliably than the file mtime.
        mtime: lastActivityMs(fullPath, st.size, st.mtimeMs),
      });
    }
  }

  // Deduplicate Claude's shadow/sidecar JSONL files. For a single conversation
  // Claude can persist multiple files (queue snapshots, resume shadows) that share
  // the same first user prompt and ai-title. Group by (project, title, firstMessage)
  // and keep only the largest file, the canonical session always grows past its shadows.
  const dedup = new Map();
  for (const s of out) {
    const key = `${s.project}${(s.title || '').toLowerCase()}${(s.firstMessage || '').slice(0, 200).toLowerCase()}`;
    const cur = dedup.get(key);
    if (!cur || s.sizeBytes > cur.sizeBytes
        || (s.sizeBytes === cur.sizeBytes && s.mtime > cur.mtime)) {
      dedup.set(key, s);
    }
  }
  const deduped = [...dedup.values()].sort((a, b) => b.mtime - a.mtime);
  // currentCwd is the live working directory of the active chat. The renderer
  // uses it to scope the rail's Recent list to this project, so only this
  // project's sessions appear there.
  return {
    ok: true,
    agent: 'claude',
    supported: true,
    sessionsDir: projectsDir,
    currentCwd: activePtyCwd || '',
    sessions: deduped,
    hiddenAutopilotSessions: hiddenAutopilot,
  };
});

// Resolve the agent-session title for a LIVE chat tab so the tab can show the
// same name the Sessions list shows instead of a generic "Chat N". Two modes:
//   knownAgentId  -> refresh the title for an already-linked session, and
//                    return a user-set custom name when one is saved.
//   huskSessionId -> discover which agent session this tab spawned, by matching
//                    the tab's resolved cwd and launch time against the claude
//                    session files, skipping ids that other tabs already own.
ipcMain.handle('sessions:resolveLiveTitle', (_e, payload = {}) => {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const names = (config.sessionNames && typeof config.sessionNames === 'object') ? config.sessionNames : {};
  const customFor = (id) => (Object.prototype.hasOwnProperty.call(names, id) ? names[id] : null);
  const agent = activeAgentName();

  if (agent === 'copilot') {
    const known = String((payload && payload.knownAgentId) || '');
    if (known) {
      // Known id: read exactly that session's dir instead of scanning every
      // session under session-state (this path polls every few seconds per
      // open tab). The id came from our own discovery, but validate it anyway
      // so the path join can never escape the session-state root.
      const custom = customFor(known);
      let hit = null;
      if (/^[A-Za-z0-9][A-Za-z0-9-]{5,80}$/.test(known)) {
        const dir = path.join(COPILOT_DIR, 'session-state', known);
        const ws = readCopilotWorkspace(dir);
        if (ws && ws.id) {
          const eventTitle = readCopilotSessionTitle(dir);
          const name = (ws.name && ws.name !== 'null') ? ws.name.slice(0, 120) : '';
          let sizeBytes = 0;
          try { sizeBytes = fs.statSync(path.join(dir, 'events.jsonl')).size; } catch (_) { sizeBytes = 0; }
          hit = {
            title: name || eventTitle.title || 'New Copilot chat',
            named: !!(name || eventTitle.generatedTitle),
            hasContent: sizeBytes > 0 || !!name,
          };
        }
      }
      if (hit || custom != null) {
        return {
          ok: true, agentId: known, custom: custom != null,
          title: custom != null ? custom : (hit ? hit.title : ''),
          named: custom != null || !!(hit && hit.named),
          // Still bound to an empty session, which cannot earn a name. Keep the
          // binding open so discovery can move the tab to the real session.
          provisional: custom == null && !(hit && hit.hasContent),
        };
      }
      return { ok: false };
    }
    // Discovery has to see empty sessions too: a tab that just launched owns one
    // until the first turn writes events.jsonl, and the provisional binding is
    // what lets the tab move to the real session once it does.
    const list = listCopilotSessions({ includeEmpty: true });
    const s = sessions.get(String((payload && payload.huskSessionId) || ''));
    if (!s || !s.cwd) return { ok: false };
    const startedAt = s.startedAt || 0;
    const exclude = new Set(Array.isArray(payload && payload.excludeAgentIds) ? payload.excludeAgentIds : []);

    // Candidates are the sessions in this tab's cwd that this tab could have
    // started. Two rules pick between them, and both matter:
    //
    // The tab launches the CLI, so its session cannot predate it. Sessions that
    // started before the tab belong to an earlier chat, and are only considered
    // when nothing started after it (the window keeps a little slack for clock
    // skew, but a session from a chat a minute ago must not win).
    //
    // Prefer a session that carries content. The CLI can create several session
    // directories for one chat and only write the conversation into the last, so
    // the empty ones left behind can never earn a name: a tab bound to one shows
    // the pending dots for good.
    const candidates = [];
    for (const x of list) {
      if (exclude.has(x.id)) continue;
      if (x.originalCwd && x.originalCwd !== s.cwd) continue;
      if (isFinite(x.startedMs) && x.startedMs < startedAt - 60_000) continue;
      candidates.push(x);
    }
    if (!candidates.length) return { ok: false };
    const pick = (pool) => pool.reduce((a, b) => (!a || b.startedMs < a.startedMs ? b : a), null);
    const startedAfter = candidates.filter((x) => !isFinite(x.startedMs) || x.startedMs >= startedAt);
    const pool = startedAfter.length ? startedAfter : candidates;
    const best = pick(pool.filter((x) => x.hasContent)) || pick(pool);
    if (!best) return { ok: false };

    const custom = customFor(best.id);
    return {
      ok: true, agentId: best.id, custom: custom != null,
      title: custom != null ? custom : best.title,
      named: custom != null || !!best.named,
      // The only candidate was an empty session, so this binding is a guess. The
      // renderer keeps probing so the tab can move to the real session once the
      // conversation starts writing.
      provisional: custom == null && !best.hasContent,
    };
  }

  if (agent === 'gemini') {
    const known = String((payload && payload.knownAgentId) || '');
    const list = listGeminiSessions({ includeEmpty: true });
    if (known) {
      const custom = customFor(known);
      const hit = list.find((x) => x.id === known) || null;
      if (hit || custom != null) {
        return {
          ok: true, agentId: known, custom: custom != null,
          title: custom != null ? custom : (hit ? hit.title : ''),
          named: custom != null || !!(hit && hit.named),
          provisional: custom == null && !(hit && hit.hasContent),
        };
      }
      return { ok: false };
    }

    // Same rules as copilot: a tab cannot own a session that predates it, and a
    // session carrying content beats an empty one that merely started earlier.
    const s = sessions.get(String((payload && payload.huskSessionId) || ''));
    if (!s || !s.cwd) return { ok: false };
    const startedAt = s.startedAt || 0;
    const exclude = new Set(Array.isArray(payload && payload.excludeAgentIds) ? payload.excludeAgentIds : []);
    const candidates = list.filter((x) => {
      if (exclude.has(x.id)) return false;
      if (x.originalCwd && x.originalCwd !== s.cwd) return false;
      if (isFinite(x.startedMs) && x.startedMs < startedAt - 60_000) return false;
      return true;
    });
    if (!candidates.length) return { ok: false };
    const pick = (pool) => pool.reduce((a, b) => (!a || b.startedMs < a.startedMs ? b : a), null);
    const startedAfter = candidates.filter((x) => !isFinite(x.startedMs) || x.startedMs >= startedAt);
    const pool = startedAfter.length ? startedAfter : candidates;
    const best = pick(pool.filter((x) => x.hasContent)) || pick(pool);
    if (!best) return { ok: false };
    const custom = customFor(best.id);
    return {
      ok: true, agentId: best.id, custom: custom != null,
      title: custom != null ? custom : best.title,
      named: custom != null || !!best.named,
      provisional: custom == null && !best.hasContent,
    };
  }

  if (agent !== 'claude') return { ok: false };

  const known = String((payload && payload.knownAgentId) || '');
  if (known) {
    let projects = [];
    try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { projects = []; }
    for (const proj of projects) {
      const full = path.join(projectsDir, proj.name, known + '.jsonl');
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      if (!st.isFile()) continue;
      const custom = customFor(known);
      const head = parseSessionHead(full);
      return {
        ok: true, agentId: known, custom: custom != null,
        title: custom != null ? custom : sessionTitleFrom(head),
        named: custom != null || !!(head && head.aiTitle),
      };
    }
    const custom = customFor(known);
    return custom != null ? { ok: true, agentId: known, custom: true, title: custom, named: true } : { ok: false };
  }

  const huskId = String((payload && payload.huskSessionId) || '');
  const s = sessions.get(huskId);
  if (!s || !s.cwd) return { ok: false };
  const startedAt = s.startedAt || 0;
  const exclude = new Set(Array.isArray(payload && payload.excludeAgentIds) ? payload.excludeAgentIds : []);

  let projects = [];
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { return { ok: false }; }
  let best = null;
  for (const proj of projects) {
    const projPath = path.join(projectsDir, proj.name);
    let files = [];
    try { files = fs.readdirSync(projPath); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      if (exclude.has(id)) continue;
      const full = path.join(projPath, f);
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.size === 0) continue;
      // Cheap window filter: the file this tab created was last written at or
      // after the tab launched. 10s slack absorbs clock skew.
      if (st.mtimeMs < startedAt - 10_000) continue;
      const info = parseSessionHead(full);
      if (!info) continue;
      // Only a real chat can back a tab. Helper runs share this directory, this
      // cwd and this minute, and they carry a title describing whatever chat
      // they were summarising, so binding to one renames the tab after a
      // different conversation.
      if (!info.interactive) continue;
      if (info.originalCwd && info.originalCwd !== s.cwd) continue;
      const startedMs = info.startedISO ? Date.parse(info.startedISO) : st.mtimeMs;
      // Must have begun around or after this tab launched (not a resumed older
      // session, which keeps its original earlier start timestamp).
      if (isFinite(startedMs) && startedMs < startedAt - 60_000) continue;
      // The tab spawned exactly one session; among unclaimed sessions in this
      // cwd, pick the earliest one that began after launch.
      if (!best || startedMs < best.startedMs) best = { id, startedMs, info };
    }
  }
  if (!best) return { ok: false };
  const custom = customFor(best.id);
  return {
    ok: true, agentId: best.id, custom: custom != null,
    title: custom != null ? custom : sessionTitleFrom(best.info),
    named: custom != null || !!(best.info && best.info.aiTitle),
  };
});

// Save (or clear, when name is empty) a user's custom name for an agent
// session, keyed by the stable claude session id so it survives restarts.
// The command that resumes a session, built where the session state lives.
// claude and copilot resume by id, so the string is fixed. gemini resumes by
// position in its own list, so the index has to be resolved against the sessions
// on disk right now rather than baked into a stale render.
ipcMain.handle('sessions:resumeCommand', (_e, payload = {}) => {
  const agent = String(payload.agent || activeAgentName()).trim().toLowerCase();
  const id = String(payload.id || '');
  if (!id) return { ok: false, error: 'no session id' };
  if (agent === 'claude') return { ok: true, command: `claude --resume ${id}` };
  if (agent === 'copilot') {
    const hit = findCopilotSessionForResume(id, String(payload.cwd || ''));
    if (!hit) return { ok: false, error: 'that copilot session is no longer listed' };
    if (!hit.hasContent) return { ok: false, error: 'Copilot is still creating that session; try again in a moment' };
    return { ok: true, command: `copilot --resume=${id}` };
  }
  if (agent === 'gemini') {
    const index = geminiResumeIndex(id, String(payload.cwd || ''));
    if (!index) return { ok: false, error: 'that gemini session is no longer listed' };
    return { ok: true, command: `gemini --resume ${index}` };
  }
  return { ok: false, error: `resume is not supported for ${agent} sessions` };
});

// ─── Background agents ───────────────────────────────────────────────────────
// A chat can start agents that keep working on their own. They are separate
// top-level sessions, not turns inside the chat, which is why they surface as
// peers in a naive session listing and why resuming one the ordinary way fails:
// the CLI refuses while the agent is still running and points at its own picker.

// The parent a background agent was forked from. Two records carry it and
// neither is sufficient alone. The transcript's snake_case `session_id` is the
// id of the process that wrote the line, so on a forked file it keeps naming
// the parent while `sessionId` names the child; it is exact, but only once the
// agent has written a turn. The daemon roster is exact from the moment of
// spawn, and is dropped the moment the worker exits. Together they cover the
// whole lifetime.
function bgAgentParent(sessionId, projDir) {
  try {
    const roster = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'daemon', 'roster.json'), 'utf8'));
    const workers = (roster && roster.workers) || {};
    for (const w of Object.values(workers)) {
      if (!w || w.sessionId !== sessionId) continue;
      const launch = w.dispatch && w.dispatch.launch;
      if (launch && launch.fork && typeof launch.sessionId === 'string') {
        return path.basename(launch.sessionId).replace(/\.jsonl$/, '');
      }
    }
  } catch (_) {}
  try {
    // Bounded: the first line carrying session_id sits within a couple of MB
    // even when early turns drag large attachments with them.
    const head = readHead(path.join(projDir, `${sessionId}.jsonl`), 2 * 1024 * 1024);
    for (const line of head.split('\n')) {
      const m = line.match(/"session_id":"([0-9a-f-]{16,})"/);
      if (m && m[1] !== sessionId) return m[1];
    }
  } catch (_) {}
  return '';
}

// Durable per-agent state. Survives the worker, unlike the roster, and is where
// the one-line "what it is doing" comes from.
function bgAgentJobState(shortId) {
  if (!shortId) return {};
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'jobs', shortId, 'state.json'), 'utf8'));
    return {
      state: j.state || '',
      detail: typeof j.detail === 'string' ? j.detail.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
      intent: typeof j.intent === 'string' ? j.intent.replace(/\s+/g, ' ').trim().slice(0, 400) : '',
      needs: typeof j.needs === 'string' ? j.needs.slice(0, 160) : '',
      tokens: Number(j.tokens) || 0,
      updatedAt: Number(j.updatedAt) || 0,
    };
  } catch (_) { return {}; }
}

ipcMain.handle('bgAgents:list', async (_e, payload = {}) => {
  const agent = activeAgentName();
  // Tool-agnostic by construction: a CLI with no agent concept reports that it
  // has none, rather than the UI naming a vendor it happens to know about.
  if (agent !== 'claude') return { ok: true, supported: false, agents: [] };
  const cwd = String((payload && payload.cwd) || activePtyCwd || '').trim();
  const args = ['agents', '--json'];
  if (cwd) args.push('--cwd', cwd);
  if (payload && payload.all) args.push('--all');
  const env = buildAgentEnv();
  const exe = resolveAgentExe('claude', env.PATH);
  let raw = '';
  try {
    raw = await new Promise((resolve, reject) => {
      execFile(exe, args, { env, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout || ''));
      });
    });
  } catch (err) {
    return { ok: false, supported: true, agents: [], error: (err && err.message) || 'could not list agents' };
  }
  let rows = [];
  try { rows = JSON.parse(raw); } catch (_) {
    return { ok: false, supported: true, agents: [], error: 'agent list was not readable' };
  }
  if (!Array.isArray(rows)) return { ok: true, supported: true, agents: [] };
  const projDir = cwd ? path.join(CLAUDE_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')) : '';
  const agents = rows
    .filter((r) => r && r.kind === 'background' && r.sessionId)
    .map((r) => {
      const shortId = String(r.id || String(r.sessionId).slice(0, 8));
      const job = bgAgentJobState(shortId);
      const transcript = projDir ? path.join(projDir, `${r.sessionId}.jsonl`) : '';
      return {
        id: shortId,
        sessionId: String(r.sessionId),
        name: String(r.name || '').slice(0, 120),
        cwd: String(r.cwd || ''),
        // A pid means a live worker. Attaching is only valid then; once it is
        // gone the session resumes like any other chat.
        running: r.pid != null,
        status: String(r.status || ''),
        state: String(r.state || job.state || ''),
        detail: job.detail || '',
        intent: job.intent || '',
        needs: job.needs || '',
        tokens: job.tokens || 0,
        startedAt: Number(r.startedAt) || 0,
        updatedAt: job.updatedAt || 0,
        parentSessionId: projDir ? bgAgentParent(String(r.sessionId), projDir) : '',
        // An agent can be listed and running with nothing on disk yet, so the
        // caller must not treat a missing transcript as a missing agent.
        hasTranscript: !!(transcript && fs.existsSync(transcript)),
        transcript,
      };
    });
  return { ok: true, supported: true, agents };
});

// How to reach one agent. Validated before it is handed back, the way copilot
// and gemini already are: returning a command blind is what produces a tab that
// opens onto nothing.
ipcMain.handle('bgAgents:openCommand', (_e, payload = {}) => {
  const agent = activeAgentName();
  if (agent !== 'claude') return { ok: false, error: `background agents are not available for ${agent}` };
  const id = String((payload && payload.id) || '').trim();
  const sessionId = String((payload && payload.sessionId) || '').trim();
  if (!id && !sessionId) return { ok: false, error: 'no agent selected' };
  if (payload && payload.running) {
    // A running agent is owned by its worker; the CLI refuses --resume against
    // one and says so. Its own fleet view is the supported way in, and it opens
    // straight onto this agent when told which one.
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,}$/.test(id)) return { ok: false, error: 'that agent has no id to attach to' };
    return { ok: true, mode: 'attach', command: 'claude agents', env: { CLAUDE_AGENTS_SELECT: id } };
  }
  if (!/^[0-9a-fA-F-]{16,}$/.test(sessionId)) return { ok: false, error: 'that agent has no session to resume' };
  const cwd = String((payload && payload.cwd) || activePtyCwd || '');
  const projDir = path.join(CLAUDE_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  if (!fs.existsSync(path.join(projDir, `${sessionId}.jsonl`))) {
    return { ok: false, error: 'that agent finished without leaving a transcript' };
  }
  return { ok: true, mode: 'resume', command: `claude --resume ${sessionId}` };
});

ipcMain.handle('sessions:rename', (_e, payload = {}) => {
  const agentId = String((payload && payload.agentId) || '');
  if (!agentId) return { ok: false };
  const name = String((payload && payload.name) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const names = (config.sessionNames && typeof config.sessionNames === 'object') ? { ...config.sessionNames } : {};
  if (name) names[agentId] = name; else delete names[agentId];
  config = { ...config, sessionNames: names };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true, name };
});

ipcMain.handle('sessions:read', (_e, prdPath) => {
  try { return { ok: true, content: fs.readFileSync(prdPath, 'utf8') }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Permanently delete one or more claude session JSONL files.
// Native confirm dialog runs in main; renderer just hands over paths.
ipcMain.handle('sessions:delete', async (_e, payload) => {
  const paths = Array.isArray(payload?.paths) ? payload.paths : [];
  if (!paths.length) return { ok: false, error: 'No sessions selected' };

  const projectsDir = path.resolve(path.join(CLAUDE_DIR, 'projects'));
  const safe = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const resolved = path.resolve(p);
    // Must live under ~/.claude/projects and be a .jsonl file
    if (!resolved.startsWith(projectsDir + path.sep)) continue;
    if (!resolved.endsWith('.jsonl')) continue;
    safe.push(resolved);
  }
  if (!safe.length) return { ok: false, error: 'No valid session paths' };

  if (payload?.confirm !== false) {
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      title: 'Delete sessions',
      message: safe.length === 1
        ? 'Permanently delete this session?'
        : `Permanently delete ${safe.length} sessions?`,
      detail: safe.map((p) => path.basename(p)).slice(0, 10).join('\n')
        + (safe.length > 10 ? `\n…and ${safe.length - 10} more` : ''),
    });
    if (r.response !== 1) return { ok: false, cancelled: true };
  }

  const failed = [];
  let deleted = 0;
  for (const p of safe) {
    try { fs.unlinkSync(p); deleted++; }
    catch (err) { failed.push({ path: p, error: err.message }); }
  }
  return { ok: failed.length === 0, deleted, failed };
});

// Find the closest claude session (by file mtime/ctime) to a PRD's started timestamp.
// Claude stores sessions at ~/.claude/projects/<encoded-cwd>/<UUID>.jsonl
ipcMain.handle('sessions:findClaudeId', (_e, { startedISO, slug }) => {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const target = startedISO ? Date.parse(startedISO) : NaN;
  if (!isFinite(target)) return { ok: false, error: 'No valid start timestamp on PRD' };

  const candidates = [];
  try {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    for (const p of projects) {
      const projPath = path.join(projectsDir, p.name);
      let files = [];
      try { files = fs.readdirSync(projPath); } catch (_) { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -6);
        const full = path.join(projPath, f);
        try {
          const st = fs.statSync(full);
          // Use min(ctime, mtime) so we approximate the session's original creation time.
          const start = Math.min(st.ctimeMs, st.mtimeMs);
          candidates.push({ id, project: p.name, path: full, start, mtime: st.mtimeMs });
        } catch (_) {}
      }
    }
  } catch (err) { return { ok: false, error: err.message }; }

  if (!candidates.length) return { ok: false, error: 'No claude session files found in ~/.claude/projects/' };

  // Find candidate with start closest to target (PRD started)
  let best = null; let bestDiff = Infinity;
  for (const c of candidates) {
    const diff = Math.abs(c.start - target);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  // Threshold: within 10 minutes is a high-confidence match
  const confident = bestDiff < 10 * 60 * 1000;
  return {
    ok: true,
    id: best.id,
    project: best.project,
    path: best.path,
    diffMs: bestDiff,
    confident,
  };
});

// ─── File system actions ─────────────────────────────────────────────────────────

ipcMain.handle('fs:open', (_e, p) => { if (!p) return false; shell.openPath(p); return true; });

// Files in the agent's "context" tray (~/.claude/MEMORY/CONTEXT/). Listed
// under the Chat section in the rail so the user can see at a glance what
// they have shared with the agent, click to re-inject, or remove.
ipcMain.handle('context:list', () => {
  const ctxDir = path.join(CLAUDE_DIR, 'MEMORY', 'CONTEXT');
  try {
    if (!fs.existsSync(ctxDir)) return { ok: true, items: [] };
    const items = fs.readdirSync(ctxDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => {
        const p = path.join(ctxDir, e.name);
        let size = 0; let mtime = 0;
        try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        return { name: e.name, path: p, size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, items };
  } catch (err) { return { ok: false, error: err.message, items: [] }; }
});

ipcMain.handle('context:remove', (_e, filePath) => {
  if (!filePath) return { ok: false, error: 'No path' };
  const ctxDir = path.join(CLAUDE_DIR, 'MEMORY', 'CONTEXT');
  // Defense in depth: only allow removal inside the CONTEXT dir.
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(ctxDir) + path.sep)) {
    return { ok: false, error: 'Refusing to remove outside CONTEXT/' };
  }
  try { fs.unlinkSync(resolved); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('fs:dropFile', async (_e, { sourcePath, kind }) => {
  if (!sourcePath || typeof sourcePath !== 'string') return { ok: false, error: 'No source path' };
  if (!fs.existsSync(sourcePath)) return { ok: false, error: 'Source not found' };
  try {
    // path.basename normalizes ".." segments to "..", so we also reject any
    // basename starting with "..", a literal "/", or a "\", defense in depth.
    const baseName = path.basename(sourcePath);
    if (!baseName || baseName.startsWith('..') || /[\/\\]/.test(baseName)) {
      return { ok: false, error: 'Invalid file name' };
    }
    let destDir; let dest;
    if (kind === 'skill') {
      const skillName = baseName.replace(/\.md$/i, '');
      if (!/^[A-Za-z0-9._-]+$/.test(skillName)) return { ok: false, error: 'Invalid skill name' };
      destDir = path.resolve(path.join(CLAUDE_DIR, 'skills', skillName));
      const skillsRoot = path.resolve(path.join(CLAUDE_DIR, 'skills'));
      if (!destDir.startsWith(skillsRoot + path.sep)) return { ok: false, error: 'Refusing path outside skills/' };
      fs.mkdirSync(destDir, { recursive: true });
      dest = path.join(destDir, 'SKILL.md');
    } else {
      destDir = path.resolve(path.join(CLAUDE_DIR, 'MEMORY', 'CONTEXT'));
      const resolvedDest = path.resolve(path.join(destDir, baseName));
      if (!resolvedDest.startsWith(destDir + path.sep)) return { ok: false, error: 'Refusing path outside CONTEXT/' };
      fs.mkdirSync(destDir, { recursive: true });
      dest = resolvedDest;
    }
    fs.copyFileSync(sourcePath, dest);
    return { ok: true, dest };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('dialog:pickFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('fs:listDir', async (_e, { dir, showHidden }) => {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const filtered = entries.filter((e) => showHidden || !e.name.startsWith('.'));
    const dirs = filtered.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, isDir: true }));
    const files = filtered.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => ({ name: e.name, isDir: false }));
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, entries: [...dirs, ...files] };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('fs:home', () => HOME);

// ─── Files command-center IPC ────────────────────────────────────────────────
// Backs the redesigned Files page: a fuzzy-searchable index, inline preview,
// and git decoration. Every read is confined under `root` via path-confine so a
// crafted relative path can never escape the browsed directory.
const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024; // 2 MB: past this the renderer would jank
const FILE_INDEX_MAX = 20000;                    // cap the flat index so search stays instant
const { detectLanguage } = require('./lib/lang-detect');

// A path is safe to read when it resolves inside root. resolveInside throws on
// absolute/traversal/null-byte; we translate that into a uniform error.
function confinedAbs(root, rel) {
  if (rel === '' || rel === '.') return path.resolve(root);
  return resolveInside(root, rel);
}

// Flat file index for fuzzy search. Prefer `git ls-files` (fast, honors
// .gitignore) and fall back to a bounded manual walk for non-repos.
ipcMain.handle('fs:indexFiles', async (_e, { root, showHidden } = {}) => {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'root required' };
  const rootAbs = path.resolve(root);
  try {
    let files = null;
    try {
      const out = execFileSync('git', ['-C', rootAbs, 'ls-files', '--cached', '--others', '--exclude-standard'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      files = out.split('\n').filter(Boolean);
    } catch (_) { files = null; }
    let truncated = false;
    if (!files) {
      files = [];
      const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', '.next', 'out', 'coverage']);
      const walk = (absDir, rel) => {
        if (files.length >= FILE_INDEX_MAX) { truncated = true; return; }
        let ents;
        try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch (_) { return; }
        for (const ent of ents) {
          if (files.length >= FILE_INDEX_MAX) { truncated = true; return; }
          if (!showHidden && ent.name.startsWith('.')) continue;
          if (ent.isDirectory() && skip.has(ent.name)) continue;
          const childRel = rel ? rel + '/' + ent.name : ent.name;
          if (ent.isDirectory()) walk(path.join(absDir, ent.name), childRel);
          else if (ent.isFile()) files.push(childRel);
        }
      };
      walk(rootAbs, '');
    } else if (files.length > FILE_INDEX_MAX) {
      files = files.slice(0, FILE_INDEX_MAX);
      truncated = true;
    }
    if (!showHidden) files = files.filter((p) => !p.split('/').some((seg) => seg.startsWith('.')));
    return { ok: true, files, truncated };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Read one file for preview: confined, size-capped, binary-sniffed.
ipcMain.handle('fs:readFile', async (_e, { root, rel } = {}) => {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'root required' };
  if (typeof rel !== 'string' || !rel) return { ok: false, error: 'rel required' };
  let abs;
  try { abs = confinedAbs(root, rel); }
  catch (_) { return { ok: false, error: 'path outside root' }; }
  // Symlink guard: confinedAbs proves the path string is inside root, but a
  // symlink whose target is outside root would still be followed by readFile.
  // Canonicalize and re-check so a link like <root>/x -> /etc/passwd is refused.
  try {
    const real = fs.realpathSync(abs);
    if (!isInside(path.resolve(root), real)) return { ok: false, error: 'path outside root' };
  } catch (_) { return { ok: false, error: 'could not resolve path' }; }
  // Open without following a final-component symlink, then stat and read
  // through the SAME handle: the canonicalized path checked above and the
  // bytes returned are guaranteed to be the same file object, closing the
  // window in which the path could be swapped for a link out of the root.
  // O_NOFOLLOW is POSIX-only; on platforms without it the realpath check
  // above remains the guard.
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (err) { return { ok: false, error: err.message }; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    if (st.size > FILE_PREVIEW_MAX_BYTES) {
      return { ok: false, error: 'too-large', bytes: st.size, reason: `File is ${(st.size / 1048576).toFixed(1)} MB; open it in your editor.` };
    }
    const buf = Buffer.alloc(st.size);
    const read = fs.readSync(fd, buf, 0, st.size, 0);
    const data = read === st.size ? buf : buf.subarray(0, read);
    // Binary sniff: a NUL byte in the first 8 KB means not text.
    const scan = data.subarray(0, Math.min(data.length, 8192));
    if (scan.includes(0)) return { ok: false, error: 'binary', bytes: st.size, reason: 'Binary file (no text preview).' };
    const text = data.toString('utf8');
    const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    return { ok: true, text, lang: detectLanguage(rel, firstLine), bytes: st.size, truncated: false, mtimeMs: st.mtimeMs };
  } catch (err) { return { ok: false, error: err.message }; }
  finally { try { fs.closeSync(fd); } catch (_) {} }
});

// Write edited text back to a file for the inline editor. Confined and
// symlink-guarded like readFile. Takes an optional `expectMtimeMs`: when the
// file on disk has changed since the editor loaded it (for example the agent
// edited it), the write is refused as a conflict rather than clobbering the
// newer content, unless `force` is set.
ipcMain.handle('fs:writeFile', async (_e, { root, rel, content, expectMtimeMs, force } = {}) => {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'root required' };
  if (typeof rel !== 'string' || !rel) return { ok: false, error: 'rel required' };
  if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
  if (content.length > FILE_PREVIEW_MAX_BYTES) return { ok: false, error: 'content too large to save' };
  let abs;
  try { abs = confinedAbs(root, rel); }
  catch (_) { return { ok: false, error: 'path outside root' }; }
  try {
    const real = fs.realpathSync(abs);
    if (!isInside(path.resolve(root), real)) return { ok: false, error: 'path outside root' };
    abs = real;
  } catch (_) {
    // A brand-new file has no realpath yet; confinedAbs already proved the
    // string is inside root, so a create is allowed.
  }
  try {
    let current = null;
    try { current = fs.statSync(abs); } catch (_) { current = null; }
    if (current) {
      if (!current.isFile()) return { ok: false, error: 'not a file' };
      if (!force && typeof expectMtimeMs === 'number' && Math.abs(current.mtimeMs - expectMtimeMs) > 1) {
        return { ok: false, error: 'conflict', reason: 'This file changed on disk since you opened it (the agent may have edited it). Reload to see the new version, or save anyway to overwrite it.' };
      }
    }
    fs.writeFileSync(abs, content, 'utf8');
    const st = fs.statSync(abs);
    return { ok: true, bytes: st.size, mtimeMs: st.mtimeMs };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Git working-tree status for the whole root. Returns raw porcelain lines; the
// renderer parses them with lib/git-porcelain so parsing is unit-tested.
ipcMain.handle('fs:gitStatus', async (_e, { root } = {}) => {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'root required' };
  const rootAbs = path.resolve(root);
  try {
    execFileSync('git', ['-C', rootAbs, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
  } catch (_) { return { ok: true, isRepo: false, porcelain: '' }; }
  try {
    const out = execFileSync('git', ['-C', rootAbs, 'status', '--porcelain=v1'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: true, isRepo: true, porcelain: out };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Unified git diff for one file (staged + unstaged). Path confined; passed as a
// pathspec after `--` so it is never interpreted as a flag.
ipcMain.handle('fs:gitDiff', async (_e, { root, rel } = {}) => {
  if (typeof root !== 'string' || !root) return { ok: false, error: 'root required' };
  if (typeof rel !== 'string' || !rel) return { ok: false, error: 'rel required' };
  const rootAbs = path.resolve(root);
  try { confinedAbs(root, rel); } catch (_) { return { ok: false, error: 'path outside root' }; }
  try {
    const unstaged = execFileSync('git', ['-C', rootAbs, 'diff', '--', rel],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const staged = execFileSync('git', ['-C', rootAbs, 'diff', '--cached', '--', rel],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    let diff = (staged ? staged + '\n' : '') + unstaged;
    // An untracked file has no tracked diff. Show its whole content as added by
    // diffing against an empty tree; git diff --no-index exits non-zero when the
    // files differ, so read the diff from the thrown error's stdout.
    if (!diff.trim()) {
      const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null';
      try {
        execFileSync('git', ['-C', rootAbs, 'diff', '--no-index', '--', nullDev, rel],
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        if (e && typeof e.stdout === 'string' && e.stdout.trim()) diff = e.stdout;
      }
    }
    return { ok: true, diff };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ─── Voice (local TTS, no API keys) ─────────────────────────────────────────────
//
// Two backends:
//   - Linux: Piper (downloaded into ~/.local/share/husk/piper, ~50 MB)
//   - macOS: built-in `say` command. No install needed, no download. The Linux
//     Piper binary is x86_64 ELF and won't run on Darwin anyway, so the darwin
//     branch uses `say` and never attempts to install Piper, which would throw
//     'spawn Unknown system error -8' from the running-not-runnable binary.

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Detect WSL: /proc/version on WSL kernels contains "microsoft" or "wsl".
// Result is cached so /proc/version is only read once.
const IS_WSL = (() => {
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    return v.includes('microsoft') || v.includes('wsl');
  } catch (_) { return false; }
})();

// Under WSL the user's HOME is often /mnt/c/Users/…, a Windows-backed
// filesystem. Extracting Linux tarballs (which contain symlinks) onto it
// fails with "Invalid argument". When we detect that situation we compute
// a path that lives on the native Linux filesystem instead.
function getHuskDataDir() {
  if (!IS_MAC && IS_WSL && HOME.startsWith('/mnt/')) {
    // Honour $XDG_DATA_HOME if it is set and itself not Windows-mounted.
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && !xdg.startsWith('/mnt/')) return path.join(xdg, 'husk');
    // Derive a native /home/<user> from environment variables.
    const user = process.env.USER || process.env.LOGNAME;
    if (user) return path.join('/home', user, '.local', 'share', 'husk');
    // Last resort: use the system temp directory (universally writable).
    return path.join(os.tmpdir(), 'husk');
  }
  return path.join(HOME, '.local', 'share', 'husk');
}

const HUSK_DATA = getHuskDataDir();
const PIPER_DIR = path.join(HUSK_DATA, 'piper');
const PIPER_BIN = path.join(PIPER_DIR, IS_WIN ? 'piper.exe' : 'piper');
const VOICES_DIR = path.join(PIPER_DIR, 'voices');

const PIPER_RELEASE = IS_WIN
  ? 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip'
  : 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz';
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const MAC_SAY_BIN = '/usr/bin/say';
const MAC_DEFAULT_VOICE = 'Samantha';
// A small curated list of macOS system voices that ship by default. The
// renderer feeds these into the same dropdown that lists Piper voices on
// Linux, so the existing UI keeps working unchanged.
const MAC_SAY_VOICES = ['Samantha', 'Alex', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Victoria'];

function listInstalledVoices() {
  if (IS_MAC) return MAC_SAY_VOICES;
  try {
    return fs.readdirSync(VOICES_DIR)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.slice(0, -5));
  } catch (_) { return []; }
}

function piperReady() {
  if (IS_MAC) return fs.existsSync(MAC_SAY_BIN);
  return fs.existsSync(PIPER_BIN) && listInstalledVoices().length > 0;
}

ipcMain.handle('voice:status', () => ({
  installed: piperReady(),
  binaryPresent: IS_MAC ? fs.existsSync(MAC_SAY_BIN) : fs.existsSync(PIPER_BIN),
  voices: listInstalledVoices(),
  platform: process.platform,
  backend: IS_MAC ? 'say' : 'piper',
}));

function emitVoiceProgress(stage, detail) {
  if (mainWindow) mainWindow.webContents.send('voice:progress', { stage, detail });
}

function runStep(cmd, args, label) {
  return new Promise((resolve, reject) => {
    emitVoiceProgress('step', label);
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${label} failed: ${err.slice(0, 300)}`)));
    p.on('error', reject);
  });
}

ipcMain.handle('voice:install', async (_e, { voice = 'en_US-amy-medium' } = {}) => {
  // macOS uses the built-in `say` command. No download, no install.
  if (IS_MAC) {
    if (!fs.existsSync(MAC_SAY_BIN)) {
      return { ok: false, error: 'macOS say(1) not found at /usr/bin/say' };
    }
    emitVoiceProgress('done', 'macOS say is ready (no install needed)');
    return { ok: true, voices: listInstalledVoices(), backend: 'say' };
  }
  try {
    fs.mkdirSync(HUSK_DATA, { recursive: true });
    fs.mkdirSync(VOICES_DIR, { recursive: true });

    if (!fs.existsSync(PIPER_BIN)) {
      // Windows ships a .zip (piper.exe + DLLs + espeak-ng-data); Linux a
      // .tar.gz. `tar -xf` auto-detects both on Win10+ (bsdtar) and Linux.
      const archivePath = path.join(os.tmpdir(), IS_WIN ? 'piper-husk.zip' : 'piper-husk.tar.gz');
      await runStep('curl', ['-fsSL', '-o', archivePath, PIPER_RELEASE], 'Downloading Piper binary');
      await runStep('tar', ['-xf', archivePath, '-C', HUSK_DATA], 'Extracting Piper');
      try { fs.unlinkSync(archivePath); } catch (_) {}
      if (!IS_WIN) { try { fs.chmodSync(PIPER_BIN, 0o755); } catch (_) {} }
    }

    const onnxPath = path.join(VOICES_DIR, voice + '.onnx');
    const jsonPath = onnxPath + '.json';
    if (!fs.existsSync(onnxPath) || !fs.existsSync(jsonPath)) {
      const parts = voice.split('-');
      const lang = parts[0].split('_')[0];
      const locale = parts[0];
      const name = parts[1];
      const quality = parts[2];
      const url = `${VOICE_BASE}/${lang}/${locale}/${name}/${quality}/${voice}`;
      await runStep('curl', ['-fsSL', '-o', onnxPath, url + '.onnx'], `Downloading voice ${voice}`);
      await runStep('curl', ['-fsSL', '-o', jsonPath, url + '.onnx.json'], 'Downloading voice metadata');
    }

    emitVoiceProgress('done', 'Voice ready');
    return { ok: true, voices: listInstalledVoices() };
  } catch (err) {
    emitVoiceProgress('error', err.message);
    return { ok: false, error: err.message };
  }
});

let speakProc = null;
ipcMain.handle('voice:speak', async (_e, { text, voice, rate = 1.0 }) => {
  if (!text || !text.trim()) return { ok: false, error: 'Empty text' };

  if (IS_MAC) {
    if (!fs.existsSync(MAC_SAY_BIN)) return { ok: false, error: 'macOS say(1) not found' };
    if (speakProc) { try { speakProc.kill(); } catch (_) {} speakProc = null; }
    const sayVoice = (voice && MAC_SAY_VOICES.includes(voice)) ? voice : MAC_DEFAULT_VOICE;
    // say's -r is words per minute. Default ~175. Map our 0.5..1.6 scalar onto a sensible range.
    const wpm = Math.max(120, Math.min(280, Math.round(175 * (rate || 1.0))));
    const args = ['-v', sayVoice, '-r', String(wpm), text];
    const proc = spawn(MAC_SAY_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    speakProc = proc;
    proc.on('close', () => { if (speakProc === proc) speakProc = null; });
    proc.on('error', () => { if (speakProc === proc) speakProc = null; });
    return { ok: true };
  }

  if (!piperReady()) return { ok: false, error: 'Piper not installed' };

  const onnxPath = path.join(VOICES_DIR, (voice || 'en_US-amy-medium') + '.onnx');
  const jsonPath = onnxPath + '.json';
  if (!fs.existsSync(onnxPath)) return { ok: false, error: 'Voice file missing' };

  let sampleRate = 22050;
  try { sampleRate = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))?.audio?.sample_rate || 22050; } catch (_) {}

  // Stop any in-flight speech so we don't queue forever.
  if (speakProc) { try { speakProc.kill(); } catch (_) {} speakProc = null; }

  if (IS_WIN) {
    // Windows has no aplay/ffplay. Render to a temp WAV, then play it with the
    // built-in .NET SoundPlayer via PowerShell and delete it afterward. cwd is
    // PIPER_DIR so piper.exe finds its DLLs and espeak-ng-data.
    const wavPath = path.join(os.tmpdir(), `husk-voice-${Date.now()}.wav`);
    const winArgs = ['--model', onnxPath, '--output_file', wavPath];
    if (rate && rate !== 1.0) winArgs.push('--length-scale', String(1.0 / rate));
    const piper = spawn(PIPER_BIN, winArgs, { cwd: PIPER_DIR, stdio: ['pipe', 'ignore', 'ignore'] });
    speakProc = piper;
    try { piper.stdin.write(text); piper.stdin.end(); } catch (_) {}
    piper.on('error', () => { if (speakProc === piper) speakProc = null; });
    piper.on('close', (code) => {
      if (speakProc === piper) speakProc = null;
      if (code !== 0) { try { fs.unlinkSync(wavPath); } catch (_) {} return; }
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        `(New-Object Media.SoundPlayer -ArgumentList '${wavPath}').PlaySync(); Remove-Item -LiteralPath '${wavPath}'`],
        { stdio: 'ignore' });
      speakProc = ps;
      ps.on('close', () => { if (speakProc === ps) speakProc = null; });
      ps.on('error', () => { if (speakProc === ps) speakProc = null; });
    });
    return { ok: true };
  }

  const piperArgs = ['--model', onnxPath, '--output-raw'];
  if (rate && rate !== 1.0) piperArgs.push('--length-scale', String(1.0 / rate));

  const env = { ...process.env, LD_LIBRARY_PATH: PIPER_DIR };
  const piper = spawn(PIPER_BIN, piperArgs, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  speakProc = piper;

  const player = fs.existsSync('/usr/bin/aplay') ? '/usr/bin/aplay' : (fs.existsSync('/usr/bin/ffplay') ? '/usr/bin/ffplay' : null);
  if (!player) { piper.kill(); return { ok: false, error: 'No audio player found (need aplay or ffplay)' }; }

  const playerArgs = player.endsWith('aplay')
    ? ['-q', '-r', String(sampleRate), '-f', 'S16_LE', '-t', 'raw', '-']
    : ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', '-'];
  const aud = spawn(player, playerArgs, { stdio: ['pipe', 'ignore', 'ignore'] });

  piper.stdout.pipe(aud.stdin);
  piper.stdin.write(text);
  piper.stdin.end();

  piper.on('close', () => { speakProc = null; try { aud.stdin.end(); } catch (_) {} });
  return { ok: true };
});

ipcMain.handle('voice:stop', () => {
  if (speakProc) { try { speakProc.kill('SIGTERM'); } catch (_) {} speakProc = null; }
  return { ok: true };
});

ipcMain.handle('voice:uninstall', async () => {
  if (speakProc) { try { speakProc.kill('SIGTERM'); } catch (_) {} speakProc = null; }
  // macOS: nothing to uninstall (using built-in say). Just confirm.
  if (IS_MAC) return { ok: true, voices: listInstalledVoices() };
  try {
    if (fs.existsSync(PIPER_DIR)) fs.rmSync(PIPER_DIR, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Listen on the loopback voice-notification ports with a silent sink so the
// bundled PAI's TTS POSTs do not produce sound while Husk is running; Husk
// drives its own Piper/say voice instead. 8888 is the legacy port; 31337 is
// the port PAI v5 posts to. Ports already held by another process are skipped.
// Released cleanly on quit.
const VOICE_SINK_PORTS = [8888, 31337];
let nullVoiceServers = [];
function startNullVoiceServer() {
  const openSink = (port) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"status":"ok","silent":true}');
        });
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('husk-null-voice');
      }
    });
    server.on('error', () => resolve());
    server.listen(port, '127.0.0.1', () => {
      nullVoiceServers.push(server);
      resolve();
    });
  });
  return Promise.all(VOICE_SINK_PORTS.map(openSink));
}
function stopNullVoiceServer() {
  for (const server of nullVoiceServers) { try { server.close(); } catch (_) {} }
  nullVoiceServers = [];
}


// ─── Auto-update (electron-updater + GitHub Releases) ──────────────────────────
//
// Flow per platform:
//   Windows NSIS  full auto-update: check, download, quitAndInstall
//   AppImage      full auto-update (the AppImage runtime swaps in the new image)
//   macOS dmg     auto-update requires signing. On unsigned builds we surface
//                 the new version + a 'Download from GitHub' button, no install.
//   deb / rpm     not auto-updatable; same fallback as unsigned macOS.
//   dev mode      autoUpdater is disabled by electron-updater itself.
//
// Status events are pushed to the renderer over 'update:status'. The renderer
// renders a small version pill in the topbar that picks the right CTA based
// on which state we are in.

let updaterInstance = null;
let updaterInitialTimer = null;
let updaterPeriodicTimer = null;
let updaterLogPath = null;
function stopAutoUpdater() {
  if (updaterInitialTimer) { clearTimeout(updaterInitialTimer); updaterInitialTimer = null; }
  if (updaterPeriodicTimer) { clearInterval(updaterPeriodicTimer); updaterPeriodicTimer = null; }
}
let updateState = { status: 'idle', current: app.getVersion() };
let updateInstallAttempted = false;

function sendUpdateStatus(extra = {}) {
  updateState = { ...updateState, ...extra };
  if (mainWindow) mainWindow.webContents.send('update:status', updateState);
}

// How this copy of Husk was installed. electron-builder writes package-type next
// to the app for deb/rpm/pacman targets; its absence plus an APPIMAGE env var
// means AppImage. The renderer uses this to name the right manual update command
// when the automatic path cannot complete.
function huskPackageType() {
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
  } catch (_) {
    if (process.env.APPIMAGE) return 'appimage';
    return process.platform === 'darwin' ? 'dmg' : (process.platform === 'win32' ? 'nsis' : '');
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    sendUpdateStatus({ status: 'idle', dev: true });
    return;
  }
  let autoUpdater;
  try { autoUpdater = require('electron-updater').autoUpdater; }
  catch (err) {
    sendUpdateStatus({ status: 'error', error: 'updater module missing' });
    return;
  }
  updaterInstance = autoUpdater;
  autoUpdater.autoDownload = false;       // we choose when to download
  autoUpdater.autoInstallOnAppQuit = false;

  // Route the updater's log to a file. It defaults to `console`, whose output is
  // unreachable for a GUI-launched app, leaving field failures undiagnosable.
  try {
    const log = require('electron-log');
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    updaterLogPath = log.transports.file.getFile().path;
  } catch (_) { /* logging is best effort, never block the updater */ }

  // electron-updater renames the AppImage on disk when the existing filename
  // carries a version (AppImageUpdater.doInstall). The installer uses a stable
  // name so this rarely fires, but a hand-installed versioned AppImage still
  // needs its launcher repointed at the new file.
  autoUpdater.on('appimage-filename-updated', (newPath) => {
    try {
      const link = path.join(os.homedir(), '.local', 'bin', 'husk');
      if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
        fs.rmSync(link, { force: true });
      }
      fs.symlinkSync(newPath, link);
    } catch (_) { /* the app still updated; a stale symlink is not fatal */ }
  });

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({
    status: 'available',
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
    url: `https://github.com/DorShaer/Husk/releases/tag/v${info.version}`,
  }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ status: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus({
    status: 'downloading',
    percent: Math.round(p.percent || 0),
  }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({
    status: 'ready',
    version: info.version,
  }));
  // Tag which phase failed. A failed check and a failed install need different
  // copy: one cannot reach GitHub, the other was refused by the package manager
  // and has a manual command the user can run instead.
  autoUpdater.on('error', (err) => sendUpdateStatus({
    status: 'error',
    error: (err && err.message) || String(err),
    phase: updateInstallAttempted ? 'install' : 'check',
    packageType: huskPackageType(),
    logPath: updaterLogPath,
  }));

  // Fire one check shortly after launch and again every 6 hours. Both are
  // stored and unref'd so they can be cleared at quit and never pin the event
  // loop open after the window closes (which left the main process alive).
  updaterInitialTimer = setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 4000);
  updaterInitialTimer.unref();
  updaterPeriodicTimer = setInterval(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 6 * 60 * 60 * 1000);
  updaterPeriodicTimer.unref();
}

// Synchronous on purpose. The preload reads this at document start and stamps the
// theme onto <body> the moment it exists, which is what keeps a light install from
// painting index.html's baked-in dark default first. An async channel resolves too
// late to beat the first frame.
ipcMain.on('config:boot-theme', (e) => {
  e.returnValue = {
    theme: config.theme,
    accent: config.accent,
    mode: LIGHT_THEMES.has(config.theme) ? 'light' : 'dark',
  };
});

ipcMain.handle('update:get', () => updateState);

ipcMain.handle('update:check', async () => {
  // In dev mode there is no updater. Re-emit current state (preserving dev:true)
  // so the popover refreshes its dev-mode copy instead of looking dead.
  if (!updaterInstance) { sendUpdateStatus({}); return updateState; }
  try { await updaterInstance.checkForUpdates(); } catch (err) {
    sendUpdateStatus({ status: 'error', error: err.message });
  }
  return updateState;
});

ipcMain.handle('update:download', async () => {
  if (!updaterInstance) return { ok: false, error: 'no updater' };
  try { await updaterInstance.downloadUpdate(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('update:install', () => {
  if (!updaterInstance) return { ok: false, error: 'no updater' };
  // Quit, install, relaunch, with forceRunAfter so the user does not have to
  // relaunch by hand.
  //
  // Call this inline and report what it does. On Linux the install is a
  // synchronous shell out to the package manager through pkexec, which fails
  // when there is no polkit agent or the password prompt is dismissed. Those
  // failures must reach the renderer rather than being swallowed here.
  updateInstallAttempted = true;
  try {
    updaterInstance.quitAndInstall(false, true);
    // A successful install quits the app, so reaching this line means the package
    // manager declined. electron-updater reports that through its 'error' event,
    // which the handler above turns into an 'install' phase failure.
    return { ok: true };
  } catch (err) {
    const message = (err && err.message) || String(err);
    sendUpdateStatus({
      status: 'error',
      error: message,
      phase: 'install',
      packageType: huskPackageType(),
      logPath: updaterLogPath,
    });
    return { ok: false, error: message };
  }
});

ipcMain.handle('update:open-release', (_e, url) => {
  if (typeof url === 'string' && /^https:\/\/github\.com\/DorShaer\/Husk\/releases/.test(url)) {
    shell.openExternal(url);
    return { ok: true };
  }
  shell.openExternal('https://github.com/DorShaer/Husk/releases');
  return { ok: true };
});

// Open an http(s) URL in the user's default browser. Used by the
// terminal link click handler (xterm WebLinksAddon) and any future
// in-renderer surface that needs to surface a clickable URL.
ipcMain.handle('urls:openExternal', (_e, url) => {
  if (typeof url !== 'string') return { ok: false, error: 'invalid url' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'unsupported scheme' };
  shell.openExternal(url).catch(() => {});
  return { ok: true };
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────────

// Only allow one Husk at a time. A second launch focuses the existing window
// instead of spawning another process tree (which would pile up orphans
// burning the inotify_user_instances limit).
const gotLock = app.requestSingleInstanceLock();
// The running instance records its version here so a second launch can tell
// "user double-clicked again" (same version: just focus, stay silent) apart
// from "user launched a NEW version while the old one runs" (versions differ:
// warn the user, because the new binary quits and the OLD window gets focus).
const instanceInfoPath = () => path.join(app.getPath('userData'), 'instance.json');
if (!gotLock) {
  let runningVersion = null;
  try { runningVersion = JSON.parse(fs.readFileSync(instanceInfoPath(), 'utf8')).version || null; } catch (_) {}
  if (runningVersion && runningVersion !== app.getVersion()) {
    const { dialog } = require('electron');
    try {
      dialog.showErrorBox(
        'A different Husk version is already running',
        `You launched Husk v${app.getVersion()}, but v${runningVersion} is still running.\n\n`
        + 'The running window was focused instead. To switch versions, fully quit '
        + 'the running Husk first, then launch again.'
      );
    } catch (_) {}
  }
  app.quit();
} else {
  try { fs.writeFileSync(instanceInfoPath(), JSON.stringify({ version: app.getVersion(), pid: process.pid })); } catch (_) {}
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Surface main-process errors instead of swallowing them silently.
  process.on('uncaughtException', (err) => { try { console.error('[husk] uncaughtException:', err); } catch (_) {} });
  process.on('unhandledRejection', (err) => { try { console.error('[husk] unhandledRejection:', err); } catch (_) {} });

  app.whenReady().then(async () => {
    applyPaiState(config.paiEnabled !== false);
    bootstrapPaiIfNeeded();
    bootstrapHuskPromptsIfNeeded();
    // Make existing Husk agents available to every installed CLI (writes any
    // missing agent files into ~/.claude/agents and ~/.copilot/agents).
    syncAgentFiles();
    startStatuslineRefresh();
    startUsageRefresh();
    await startNullVoiceServer();
    // Recover or prune worktrees left behind by a crash before any new run
    // can create one. Guarded so it never blocks the window from opening.
    try { reconcileOrphanWorktrees(); } catch (_) {}
    createWindow();
    setupAutoUpdater();
    // Read the active CLI's model catalog once in the background so the status
    // panel can name the running model in the provider's own words from the
    // first poll. The probe drives the CLI's picker in a PTY and takes seconds,
    // so it must never sit in front of the window opening; until it lands the
    // panel falls back to the name derived from the model id.
    setTimeout(() => { discoverModelCatalog().catch(() => {}); }, 4000);
  });
  app.on('window-all-closed', () => {
    killPtyTree(); stopNullVoiceServer(); stopStatuslineRefresh(); stopUsageRefresh(); stopAutoUpdater();
    // Exit HARD. app.quit()'s graceful teardown can hang on a real compositor
    // (it waits for the GPU and renderer processes to exit), leaving the main
    // process alive with no window, the exact stacking we are preventing. An
    // unref'd timer fallback is not reliably serviced while that quit is stuck.
    // app.exit() terminates immediately and does not wait on the teardown.
    app.exit(0);
  });
  app.on('before-quit', () => { killPtyTree(); stopNullVoiceServer(); stopStatuslineRefresh(); stopUsageRefresh(); stopAutoUpdater(); });
  app.on('will-quit', () => { killPtyTree(); stopNullVoiceServer(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  process.on('SIGINT',  () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('SIGTERM', () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('SIGHUP',  () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('exit',    () => { killPtyTree(); stopNullVoiceServer(); });
}
