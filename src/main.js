// Husk: Electron main process.
// Wraps a configurable agent CLI via node-pty and exposes pages: chat, skills, sessions, files, preferences.

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const pty = require('node-pty');

const { shJoin } = require('./lib/shell-quote');
const { resolveInside, isInside } = require('./lib/path-confine');
const { parseAgentMd } = require('./lib/agent-md');
const wfLib = require('./lib/workflow-graph');
const { buildSpawnSpec } = require('./lib/pty-spawn');
const AgentInject = require('./lib/agent-inject');
const { createMouseModeStripper } = require('./lib/term-mouse');
const { wheelSequence, wheelSteps } = require('./lib/wheel-seq');
const { agentFileName, renderAgentMd } = require('./lib/agent-file');
const { parseShellPathOutput, MARKER_START, MARKER_END } = require('./lib/user-path');
const { getAdapter: getMcpAdapter } = require('./lib/mcp');

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
    const child = spawn(shellBin, ['-ilc', `echo "${MARKER_START}$PATH${MARKER_END}"`], { timeout: 5000 });
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
const {
  sanitizeGraph,
  migrateWorkflow,
  graphToOrderedSteps,
  wfIsAiRouted,
  wfRouteInstruction,
  wfResolveNext,
  isAllowedAgentCommand,
} = wfLib;

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOME = os.homedir();
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

// ─── Multi-session registry ────────────────────────────────────────────────
// Each chat tab owns its own PTY child, output buffer, mouse-mode stripper,
// and listener disposables, so several agents run in parallel. `sessions`
// maps the renderer's sessionId to that state; `activeSessionId` is the
// focused tab. The `ptyProc` / `activePtyCwd` / `ptyLastDataAt` mirrors below
// always track the active session, so the autonomy + stats code (which
// operates on "the current agent") needs no per-call session plumbing.
const sessions = new Map();
let activeSessionId = null;
let sessionSeq = 0;
// Mirrors of the active session. setActiveSession() and the active session's
// onData keep these in sync; autonomy/stats read them directly.
let ptyProc = null;
let activePtyCwd = null;
// Timestamp of the last byte the active agent emitted, used to detect when
// its TUI has settled before we paste an autonomy goal into it.
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
  agentCommand: 'claude',
  agentName: 'Husk',
  showSystemView: false,
  treeRoot: HOME,
  showHidden: false,
  theme: 'dark',
  accent: 'orange',
  railExpanded: true,
  statusCollapsed: false,
  voice: { enabled: false, name: 'en_US-amy-medium', rate: 1.0 },
  skipWelcome: false,
  recap: true,
  // PAI is the bundled Claude-Code-only assistant framework Husk drops into
  // ~/.claude/. Defaults to enabled so existing Claude users get it on
  // first run, but Copilot-only users can switch it off to skip the
  // bootstrap, kill the statusline tick, and drop the PAI/Algorithm
  // reference from the Husk identity prompt.
  paiEnabled: true,
  profiles: DEFAULT_PROFILES,
  activeProfileId: null,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
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

// ─── PAI bootstrap (packaged binaries) ───────────────────────────────────────
// When Husk runs from a packaged binary (electron-builder output), there is no
// install.sh to copy libs/pai into ~/.claude/. We do it here on first launch.
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
    const slPath = path.join(CLAUDE_DIR, 'statusline-command.sh');
    if (!fs.existsSync(slPath)) return;
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
  // statusline-command.sh is PAI's status feeder. Skip the tick entirely
  // when the user has disabled PAI: no script, no caches, no need to run.
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
// mirrors the inline fetch the PAI statusline does each render, but the
// statusline never persisted those numbers, so Husk's stats reader was
// always seeing a phantom file. Writing the cache here makes the existing
// stats:get path light up.
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
function applyPaiState(active) {
  PaiState.applyPaiState(path.join(HOME, '.claude'), active);
}

function bootstrapPaiIfNeeded() {
  // Hard opt-out: when the user has disabled PAI in Preferences, we do not
  // touch ~/.claude/ on launch. Pre-existing files stay where they are
  // (Husk never removes user files behind their back); the user can clean
  // ~/.claude/{PAI,agents,skills,hooks}/ manually if they want.
  if (config.paiEnabled === false) return;
  try {
    const claudeDir = path.join(HOME, '.claude');

    // Locate the bundled PAI tree.
    // Packaged: app.isPackaged && process.resourcesPath/pai/ exists.
    // Dev:      <repo>/libs/pai/ relative to __dirname (which is <repo>/src/).
    const candidates = [];
    if (app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'pai'));
    }
    candidates.push(path.join(__dirname, '..', 'libs', 'pai'));

    let bundle = null;
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.existsSync(path.join(c, 'CLAUDE.md.template'))) {
        bundle = c; break;
      }
    }
    if (!bundle) return;

    fs.mkdirSync(claudeDir, { recursive: true });

    // CLAUDE.md: only copy when the user does NOT already have one. This
    // protects user customizations across upgrades.
    const claudemdDst = path.join(claudeDir, 'CLAUDE.md');
    if (!fs.existsSync(claudemdDst)) {
      const tpl = fs.existsSync(path.join(bundle, 'CLAUDE.md.template'))
        ? path.join(bundle, 'CLAUDE.md.template')
        : path.join(bundle, 'CLAUDE.md');
      if (fs.existsSync(tpl)) fs.copyFileSync(tpl, claudemdDst);
    }

    // Framework subdirs: merge missing children into existing dirs (cp -Rn
    // semantics). Each subdir is checked independently of CLAUDE.md, so a
    // user who already has ~/.claude/CLAUDE.md (claude code creates it) still
    // receives the bundled skills, agents, and hooks. Missing entries are
    // added without ever overwriting a file the user already has.
    for (const sub of ['PAI', 'agents', 'hooks', 'lib', 'skills']) {
      const src = path.join(bundle, sub);
      const dst = path.join(claudeDir, sub);
      if (!fs.existsSync(src)) continue;
      if (!fs.existsSync(dst)) copyDirRecursiveSync(src, dst);
      else copyMissingChildrenSync(src, dst);
    }

    const blockSrc = path.join(bundle, 'blocklist.json');
    const blockDst = path.join(claudeDir, 'blocklist.json');
    if (fs.existsSync(blockSrc) && !fs.existsSync(blockDst)) fs.copyFileSync(blockSrc, blockDst);
    const slSrc = path.join(bundle, 'statusline-command.sh');
    const slDst = path.join(claudeDir, 'statusline-command.sh');
    if (fs.existsSync(slSrc) && !fs.existsSync(slDst)) {
      fs.copyFileSync(slSrc, slDst);
      try { fs.chmodSync(slDst, 0o755); } catch (_) {}
    }
  } catch (err) {
    console.error('[husk] PAI bootstrap failed:', err && err.message);
  }
}

// Like cp -Rn at the immediate-children level: for each top-level entry in
// src, copy it to dst only when the destination entry does not exist. Never
// recurses into existing destination subtrees, so user-edited files inside
// already-present skills are never touched.
function copyMissingChildrenSync(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (fs.existsSync(d)) continue;
    if (entry.isDirectory()) copyDirRecursiveSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    // ignore symlinks/devices
  }
}

function copyDirRecursiveSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
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
    backgroundColor: '#0b0d12',
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
    { role: 'reload' },
    ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', accelerator: 'F12' }, { type: 'separator' }]),
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
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
  // Fallback: reap a last-known orphan group even if the map is already empty
  // (e.g. every session's pty was nulled by onExit).
  if (!sessions.size && lastPtyPid) reapPid(lastPtyPid);
  sessions.clear();
  ptyProc = null;
  activeSessionId = null;
  lastPtyPid = 0;
}

// ─── PTY ─────────────────────────────────────────────────────────────────────────

function spawnPty(cols = 100, rows = 30, overrideCmd = null, overrideCwd = null, sessionId = null) {
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
    if (s.pty) try { s.pty.kill(); } catch (_) {}
  }
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
  });
  const bunBin = path.join(HOME, '.bun', 'bin');
  if (env.PATH && !env.PATH.includes(bunBin)) env.PATH = `${bunBin}:${env.PATH}`;

  const rawCmd = (overrideCmd || config.agentCommand || 'claude').trim();

  // Tokenize the user's agent command into program + extra args. Naive
  // whitespace split is fine for the vast majority of cases (most users type
  // 'claude' or 'claude --some-flag'); if someone sets an agent command with
  // shell-quoted args we will mistokenize, but that is a corner case.
  const userTokens = rawCmd.split(/\s+/).filter(Boolean);
  let agentExe = userTokens.shift() || 'claude';
  let agentArgs = userTokens;

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
  // Note for claude: Husk deliberately does not inject --settings
  // <ephemeral-temp-file>. claude treats that temp file as the canonical
  // settings and writes folder-trust changes into it; regenerating the temp
  // file from the user's real settings.json on the next launch would blow the
  // trust away.
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
    if (!s.flushScheduled) { s.flushScheduled = true; setImmediate(() => flushSessionData(s)); }
    // Autonomy + the TUI-settle detector operate on the focused agent only.
    if (id === activeSessionId) { ptyLastDataAt = s.lastDataAt; autonomyTap(data); }
  });
  s.exitDisposable = s.pty.onExit(({ exitCode }) => {
    flushSessionData(s);
    if (mainWindow) mainWindow.webContents.send('pty:exit', { sessionId: id, code: exitCode });
    s.pty = null;
    if (id === activeSessionId) ptyProc = null;
    // If an autonomy run was live on the focused agent, the process just
    // died. Close the run so its 1s meter interval stops, the budget stops
    // ticking wall-clock against a dead process, and a new run can start (the
    // "already active" guard would otherwise block forever).
    if (activeRunner && !autonomyFinishing && id === activeSessionId) {
      if (mainWindow) mainWindow.webContents.send('autonomy:halt', { reason: 'agent-exited' });
      finishActiveRun({ reason: 'agent-exited' });
    }
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
    const st = fs.statSync(p);
    if (st.mtimeMs !== _claudeJsonCache.mtime) {
      _claudeJsonCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
    return _claudeJsonCache.data;
  } catch (_) { return null; }
}

// ~/.claude/settings.json holds the configured model (e.g. "claude-fable-5[1m]")
// (the same source Claude Code shows in its startup banner). Reading it gives a
// never-stale, auto-updating model id without hardcoding anything. Cached by
// mtime so the status poll only reparses when the file actually changes.
let _claudeSettingsCache = { mtime: 0, data: null };
function readClaudeSettings() {
  try {
    const p = path.join(CLAUDE_DIR, 'settings.json');
    const st = fs.statSync(p);
    if (st.mtimeMs !== _claudeSettingsCache.mtime) {
      _claudeSettingsCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
    return _claudeSettingsCache.data;
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
function resolveContextWindow(cwd, model, ctxTokens) {
  const stripTier = (id) => id.replace(/\[[^\]]*\]/g, '');
  const is1m = (id) => /\[1m\]/i.test(id);
  const bare = stripTier(model || '');
  try {
    // Explicit 1M tier on the id itself.
    if (is1m(model || '')) return 1000000;
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
    const encoded = activePtyCwd.replace(/[/\\:]/g, '-');
    const dir = path.join(projectsDir, encoded);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(dir, f);
        try { const st = fs.statSync(p); return { p, mtime: st.mtimeMs, size: st.size }; } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    const latest = files[0].p;
    // Cap the read. A session JSONL grows for the whole conversation and
    // can reach many megabytes; reading and parsing the entire file on
    // every status poll stalls the main thread. Read at most the last
    // CAP bytes (dropping the first partial line) so the cost stays
    // bounded. For large sessions the turn/char numbers become a
    // recent-tail estimate, which is acceptable for a coarse readout.
    const CAP = 1024 * 1024;
    let raw;
    const sz = files[0].size;
    if (Number.isFinite(sz) && sz > CAP) {
      const fd = fs.openSync(latest, 'r');
      try {
        const buf = Buffer.alloc(CAP);
        fs.readSync(fd, buf, 0, CAP, sz - CAP);
        const tail = buf.toString('utf8');
        const nl = tail.indexOf('\n');
        raw = (nl >= 0 ? tail.slice(nl + 1) : tail).split('\n').filter(Boolean);
      } finally { fs.closeSync(fd); }
    } else {
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
    // Prefer the configured model from settings.json (what Claude Code shows in
    // its banner) over the transcript model. The transcript lags (no model
    // until the first assistant turn) and the newest-by-mtime file can belong
    // to a different/older session, which would make the panel show a stale model.
    // settings.json is authoritative, never stale, and auto-updates on change.
    const settingsModel = ((readClaudeSettings() || {}).model || '').trim();
    const effModel = settingsModel || model;
    // The model id carries the context tier (e.g. "[1m]"); resolve the window
    // from it plus the user's actual model/license selection.
    const ctxWindow = resolveContextWindow(activePtyCwd, effModel, ctxTokens);
    const ctxPct = ctxWindow ? Math.round((ctxTokens / ctxWindow) * 1000) / 10 : 0;
    return { turns, chars, tokens: Math.round(chars / 4), file: latest, model: effModel, ctxTokens, ctxWindow, ctxPct };
  } catch (_) { return null; }
}

// Resolve the target session for a channel: the named session when it
// exists, else the focused one. Keeps single-arg callers (write/resize with
// no sessionId) working against the active agent.
function targetSession(sessionId) {
  return (sessionId && sessions.get(sessionId)) || activeSession();
}
ipcMain.handle('pty:start', (_e, { cols, rows, command, cwd, sessionId } = {}) => spawnPty(cols, rows, command || null, cwd || null, sessionId || null));
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
ipcMain.on('pty:setActive', (_e, sessionId) => { if (sessions.has(sessionId)) setActiveSession(sessionId); });
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

// ─── Autonomy Mode IPC ────────────────────────────────────────────────────
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

const Autonomy = require('./lib/autonomy');
const electronApp = require('electron');
let activeRunner = null;
// Guards finishActiveRun against re-entry: an agent crash (onExit) and a
// user cancel can both try to close the same run at once.
let autonomyFinishing = false;
function autonomyStorageRoot() {
  return path.join(app.getPath('userData'), 'autonomy');
}
function autonomyCrypto() {
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

// Autonomy PTY tap: while a run is active, every chunk of agent
// output is buffered and flushed once per quarter-second. The
// flush appends an `agent_output` event to the hash-chained audit
// log, feeds char count into the budget meter (cost estimate), and
// broadcasts cleaned-up activity lines + live budget state to the
// renderer for the activity panel. Batching keeps the audit log
// from getting one row per stdout byte and keeps IPC traffic sane.
let autonomyOutputBuf = '';
let autonomyOutputFlushTimer = null;
const AUT_OUTPUT_FLUSH_MS = 250;

function autonomyTap(data) {
  if (!activeRunner) return;
  autonomyOutputBuf += data;
  if (!autonomyOutputFlushTimer) {
    autonomyOutputFlushTimer = setTimeout(flushAutonomyOutput, AUT_OUTPUT_FLUSH_MS);
  }
}

// Tail of the last flush: any partial line (no trailing \n) is
// carried forward so the next chunk can complete it. Without this
// the feed shows mid-line fragments like "*ie" "*rn" "*ei" because
// the PTY arrives byte-by-byte during agent streaming.
let autonomyLineTail = '';
let autonomyLastTailEmit = '';
let autonomyLastTailEmitAt = 0;

function flushAutonomyOutput() {
  autonomyOutputFlushTimer = null;
  if (!activeRunner) { autonomyOutputBuf = ''; autonomyLineTail = ''; return; }
  const chunk = autonomyOutputBuf;
  autonomyOutputBuf = '';
  if (!chunk) return;
  // Audit-only event: still record chunks for the tamper-evident
  // log (size + timestamp), but do NOT feed chars to the budget
  // meter. The chars/4 estimate is wildly wrong for TUI agents
  // because PTY bytes include cursor escapes, color codes, and
  // in-place repaints (5-10x the actual semantic content). Token
  // counts now come exclusively from the agent's own status line
  // (parsed in the renderer via parseAgentTokenStatus). If the
  // agent never reports tokens, the meter stays at 0 -- honest.
  try {
    activeRunner.recordEvent({
      kind: 'agent_output',
      ts: new Date().toISOString(),
      payload: { chars: chunk.length },
    });
  } catch (_) {}
  // NOTE: this flush does not parse the byte stream into activity rows.
  // That approach is fundamentally wrong for TUI
  // agents (claude in particular): the PTY stream is a sequence of
  // commands to a terminal emulator, not a log. Stripping ANSI and
  // splitting on \n produces fragments because the emulator's job
  // is to INTERPRET cursor positioning, overwrites, and alternate
  // screen buffers into a final rendered grid.
  //
  // The renderer owns an xterm.js emulator that does exactly that
  // rendering for the chat view. The activity feed snapshots
  // that already-rendered grid (see renderer's snapshotTermForAutonomy).
  //
  // This flush does two real jobs:
  //   1. Append one agent_output audit row per chunk so the budget
  //      meter sees char counts (cost estimate stays accurate).
  //   2. Broadcast the live budget state to the renderer so the
  //      rings keep updating in lockstep with token spend.
  if (mainWindow) {
    mainWindow.webContents.send('autonomy:budget', activeRunner.budgetState());
  }
}

// Printed by the agent (per the autonomy directive) when the goal is fully
// done. The renderer watches for this exact marker on its own line so a real
// finish is detected positively, instead of guessing from terminal idle,
// which previously mistook "waiting for the user's answer" for "complete".
const AUTONOMY_COMPLETE_SENTINEL = '<<HUSK_AUTONOMY_COMPLETE>>';

// Wrap a user goal in an autonomous-operator preamble. An autonomy run is
// unattended: the agent must make its own decisions and never block on input.
// Without this the agent behaves like an interactive session, asks a
// clarifying question (e.g. "which tech stack?"), and stalls, which the
// watchdog then reads as a finished run.
function buildAutonomyGoal(goal) {
  return [
    '[AUTONOMOUS MODE] You are running unattended. No human is available to answer questions.',
    'Operate fully autonomously from start to finish:',
    '1. NEVER ask the user questions and never wait for input, confirmation, or approval. There is nobody to respond; assume a sensible "yes" and continue.',
    '2. Make every decision yourself (tech stack, architecture, libraries, file layout, naming). When a choice is ambiguous, pick the most sensible mainstream default, state the assumption in one line, and proceed immediately.',
    '3. Do not hand back a plan and stop. Plan if useful, then implement every part end to end.',
    '4. Keep working continuously until the goal is fully achieved and verified.',
    '5. ONLY when the goal is completely finished, print this exact marker alone on its own line: ' + AUTONOMY_COMPLETE_SENTINEL,
    '',
    'GOAL: ' + String(goal),
  ].join('\n');
}

function injectGoalToPty(goal) {
  if (!ptyProc) return false;
  try {
    const body = String(goal).replace(/\r/g, ' ').replace(/\n/g, ' ');
    if (getAgentKind() === 'claude') {
      // claude routes raw keystrokes through its TUI hotkey handler (SPACE
      // toggles a mode, "/" opens the command palette), so the goal must
      // arrive as one bracketed-paste block (CSI 200~ / CSI 201~). A
      // separate Enter after the paste commits submits it.
      ptyProc.write('\x1b[200~' + body + '\x1b[201~');
      setTimeout(() => { try { if (ptyProc) ptyProc.write('\r'); } catch (_) {} }, 120);
    } else {
      // Other agents (verified with copilot) DO accept a bracketed paste
      // but do NOT submit on the Enter that follows it: their composer
      // treats that Enter as a newline, so the goal just sits in the input
      // and the run does nothing. Typing the goal directly keeps the input
      // in its normal single-line state where Enter submits.
      ptyProc.write(body);
      setTimeout(() => { try { if (ptyProc) ptyProc.write('\r'); } catch (_) {} }, 150);
    }
    return true;
  } catch (_) { return false; }
}

function sigintPty() {
  if (!ptyProc) return;
  try { ptyProc.write('\x03'); } catch (_) {}
}

// Resolve once the agent's TUI looks ready for input: it has emitted
// output and then gone quiet for a short settle window, or maxMs has
// elapsed. Pasting the goal before the input field has mounted makes the
// run silently do nothing, so a fixed wall-clock guess is not safe on a
// slow cold start.
function whenAgentReady(maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const settleMs = 350; // quiet period after last output = TUI settled
    const minWaitMs = Math.min(250, maxMs);
    const check = () => {
      const now = Date.now();
      if (now - start >= maxMs) return resolve('timeout');
      const sawOutput = ptyLastDataAt >= start - 50;
      const quietFor = now - ptyLastDataAt;
      if (sawOutput && quietFor >= settleMs && (now - start) >= minWaitMs) return resolve('ready');
      setTimeout(check, 80);
    };
    setTimeout(check, minWaitMs);
  });
}

ipcMain.handle('autonomy:start', async (_e, payload = {}) => {
  if (activeRunner) return { ok: false, error: 'an autonomy run is already active' };
  // Autonomy requires an active project. The whole feature is built
  // around "snapshot a scoped workspace, watch the agent change it,
  // let the user revert" - none of that makes sense outside a project.
  // Refuse here at the IPC layer; the renderer separately gates the
  // dialog open so this is the belt-and-suspenders check.
  const activeProj = Array.isArray(config.projects) && config.activeProjectId
    ? config.projects.find((p) => p && p.id === config.activeProjectId)
    : null;
  if (!activeProj || !activeProj.path) {
    return { ok: false, error: 'pick an active project first; autonomy runs inside a project' };
  }
  const workspaceRoot = activeProj.path;
  if (!fs.existsSync(workspaceRoot)) return { ok: false, error: 'active project path no longer exists' };
  // Belt and suspenders: never let workspaceRoot resolve to HOME.
  if (path.resolve(workspaceRoot) === path.resolve(HOME)) {
    return { ok: false, error: 'autonomy refuses to snapshot the entire home folder' };
  }
  const sessionId = 'auto-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const { encrypt, decrypt } = autonomyCrypto();

  // Snapshot off-cycle via the async path so the main process keeps
  // painting while we walk the workspace. Progress events surface
  // file counts into the renderer's start dialog.
  const onProgress = (info) => {
    if (mainWindow) mainWindow.webContents.send('autonomy:snapshot-progress', info);
  };
  // Snapshot is opt-in. When the user turns it off (they manage state with
  // git), skip the workspace walk entirely: the run still gets an audit log
  // and budget caps, but diff/revert are unavailable for it.
  const wantSnapshot = payload.snapshot !== false;
  let snap;
  if (wantSnapshot) {
    try {
      snap = await Autonomy.snapshot.captureSnapshotAsync(workspaceRoot, autonomyStorageRoot(), sessionId, {
        encrypt,
        onProgress,
      });
    } catch (err) {
      return { ok: false, error: `snapshot crashed: ${err && err.message || String(err)}` };
    }
    if (!snap.ok) return { ok: false, error: snap.error };
  } else {
    snap = { ok: true, manifest: null, fileCount: 0 };
  }

  // Derive the agent name from the configured command so the budget
  // meter prices the run correctly. Vendor-billed agents (copilot, codex,
  // aider, gemini) carry a $0 rate so the dollar cap does not fire on a
  // fabricated Sonnet-priced cost; claude falls through to the default
  // model rate.
  const agentName = (config.agentCommand || 'claude').trim().split(/\s+/)[0]
    .split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  const vendorBilled = ['copilot', 'codex', 'aider', 'gemini'].includes(agentName);
  const r = Autonomy.supervisor.startRun({
    sessionId,
    workspaceRoot,
    storageRoot: autonomyStorageRoot(),
    goal: typeof payload.goal === 'string' ? payload.goal.slice(0, 4096) : null,
    agent: payload.agent || agentName,
    modelId: payload.modelId || (vendorBilled ? agentName : null),
    caps: payload.caps,
    encrypt, decrypt,
    skipSnapshot: true,
    snapshotManifest: snap.manifest,
  });
  if (!r.ok) return { ok: false, error: r.error };
  activeRunner = r.runner;
  // Periodic wall-clock tick so even idle runs respect the minutes cap
  // and the live UI keeps a fresh budget readout. Halt fires SIGINT
  // into the PTY so the agent stops at the cap, not "eventually".
  activeRunner._tickInterval = setInterval(() => {
    if (!activeRunner) return;
    const s = activeRunner.tickClock();
    if (mainWindow) mainWindow.webContents.send('autonomy:budget', s);
    if (s.hitCap) {
      // Cap reached. Stop this interval immediately so we do not inject
      // a SIGINT and re-broadcast a halt every second (the meter keeps
      // reporting hitCap once a cap is crossed). Interrupt the agent
      // once, tell the renderer once, and finalize the run so it leaves
      // the active state instead of sitting "Running" forever. The agent
      // stays alive at its prompt; SIGINT interrupts the current turn, it
      // does not kill the PTY.
      try { clearInterval(activeRunner._tickInterval); } catch (_) {}
      sigintPty();
      if (mainWindow) mainWindow.webContents.send('autonomy:halt', { reason: 'budget', cap: s.hitCap });
      finishActiveRun({ reason: 'budget', cap: s.hitCap });
    }
  }, 1000);
  const goal = typeof payload.goal === 'string' ? payload.goal.slice(0, 4096) : '';
  if (mainWindow) mainWindow.webContents.send('autonomy:started', { sessionId, workspaceRoot, fileCount: snap.fileCount, goal });
  // If no PTY is running yet (user jumped straight to Autonomy
  // without ever opening Chat), spawn one in the project's cwd and
  // extend the inject delay so the agent's banner finishes rendering
  // before we paste the goal as input. Without this the goal lands
  // in a non-existent stdin and the run appears to do nothing.
  const ptyJustBooted = !ptyProc;
  if (ptyJustBooted) {
    try { spawnPty(100, 30, null, workspaceRoot); } catch (_) {}
  }
  if (goal) {
    const deliver = () => {
      const ok = injectGoalToPty(buildAutonomyGoal(goal));
      // Surface delivery to the activity feed so the user has explicit
      // feedback that the goal reached the agent. Without this, an
      // agent that thinks silently for a while looks identical to a
      // run that failed to start.
      if (mainWindow) {
        mainWindow.webContents.send('autonomy:activity', {
          lines: [ok ? 'Goal delivered to agent. Waiting for first response...' : 'Could not deliver goal: no agent process available.'],
          at: Date.now(),
        });
      }
    };
    if (ptyJustBooted) {
      // Cold start: wait for the freshly spawned agent's banner to
      // render and settle before pasting, with a hard fallback so the
      // goal is always delivered even if the readiness signal never
      // arrives.
      whenAgentReady(6000).then(deliver);
    } else {
      // Agent already running in Chat: a short delay is enough for the
      // bracketed paste to land in the existing input.
      setTimeout(deliver, 400);
    }
  }
  return { ok: true, sessionId, workspaceRoot, fileCount: snap.fileCount, goal };
});

ipcMain.handle('autonomy:event', (_e, event = {}) => {
  if (!activeRunner) return { ok: false, error: 'no active run' };
  const r = activeRunner.recordEvent(event);
  return r;
});

// Push a stalled autonomous agent to keep going on its own. Called by the
// renderer watchdog when the agent goes quiet without printing the completion
// marker (the classic "it asked a question and is waiting" stall). Capped on
// the renderer side so a genuinely stuck run still ends.
ipcMain.handle('autonomy:nudge', () => {
  if (!activeRunner) return { ok: false, error: 'no active run' };
  const ok = injectGoalToPty(
    'Continue autonomously. Do not ask questions or wait for input. Pick a sensible default for any open decision, '
    + 'state it in one line, and keep working until the goal is complete. When fully done, print '
    + AUTONOMY_COMPLETE_SENTINEL + ' alone on its own line.'
  );
  return { ok };
});

ipcMain.handle('autonomy:cancel', (_e, detail = {}) => {
  if (!activeRunner) return { ok: false, error: 'no active run' };
  sigintPty();
  activeRunner.cancel(detail);
  return finishActiveRun();
});

ipcMain.handle('autonomy:end', (_e, detail = {}) => {
  if (!activeRunner) return { ok: false, error: 'no active run' };
  return finishActiveRun(detail);
});

async function finishActiveRun(detail) {
  if (!activeRunner || autonomyFinishing) return { ok: false, error: 'no active run' };
  autonomyFinishing = true;
  const runner = activeRunner;
  try {
    try { clearInterval(runner._tickInterval); } catch (_) {}
    // Drain any pending PTY tap output so the final agent_output event
    // makes it into the audit log before we close the runner.
    try { if (autonomyOutputFlushTimer) { clearTimeout(autonomyOutputFlushTimer); autonomyOutputFlushTimer = null; } } catch (_) {}
    try { flushAutonomyOutput(); } catch (_) {}
    autonomyOutputBuf = '';
    autonomyLineTail = '';
    autonomyLastTailEmit = '';
    autonomyLastTailEmitAt = 0;
    // endRunAsync walks the end-of-run diff off the main thread so the
    // UI does not freeze hashing the workspace at run end.
    try { await runner.endRunAsync(detail || null); } catch (_) {}
    const sessionId = runner.sessionId;
    const workspaceRoot = runner.workspaceRoot;
    activeRunner = null;
    const { decrypt } = autonomyCrypto();
    let sum;
    try {
      sum = await Autonomy.supervisor.summarizeRunAsync({
        sessionId, workspaceRoot, storageRoot: autonomyStorageRoot(), decrypt,
      });
    } catch (err) {
      sum = { ok: false, error: (err && err.message) || String(err) };
    }
    // Carry the run identity on the payload so the renderer can enter
    // review / revert / rerun even when its own autonomyLastSession was
    // lost (e.g. the renderer reloaded while the run was active).
    if (sum && typeof sum === 'object') { sum.sessionId = sessionId; sum.workspaceRoot = workspaceRoot; }
    if (mainWindow) mainWindow.webContents.send('autonomy:ended', sum);
    return { ok: true, sessionId, summary: sum };
  } finally {
    activeRunner = null;
    autonomyFinishing = false;
  }
}

ipcMain.handle('autonomy:status', () => {
  if (!activeRunner) return { ok: true, active: false };
  return {
    ok: true,
    active: true,
    sessionId: activeRunner.sessionId,
    state: activeRunner.getState(),
    budget: activeRunner.budgetState(),
  };
});

// The restore/diff target for a session is the directory the snapshot
// was captured from, recorded in its manifest. Never trust a caller-
// supplied workspaceRoot for a destructive revert: an empty value used
// to fall back to HOME, and the restore deletes every file not in the
// snapshot, so a wrong root would wipe an unrelated directory.
function manifestWorkspaceRoot(sessionId) {
  try {
    const mp = path.join(autonomyStorageRoot(), 'sessions', sessionId, 'snapshot.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to autonomy storage
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    return (m && typeof m.workspaceRoot === 'string' && m.workspaceRoot) ? m.workspaceRoot : null;
  } catch (_) { return null; }
}

ipcMain.handle('autonomy:revert', (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  const workspaceRoot = manifestWorkspaceRoot(sessionId);
  if (!workspaceRoot) return { ok: false, error: 'snapshot manifest has no workspace root; cannot revert safely' };
  const { decrypt } = autonomyCrypto();
  return Autonomy.supervisor.revertRun({
    sessionId,
    workspaceRoot,
    storageRoot: autonomyStorageRoot(),
    decrypt,
    preserveExtras: !!payload.preserveExtras,
  });
});

// Renderer-side terminal snapshot parser reports the agent's own
// cumulative token count here. claude prints "↓ 1.5k tokens" in its
// status line; we treat that as truth and override the chars/4
// estimate the budget meter would otherwise produce. Cap firing
// also uses the authoritative number when present.
ipcMain.handle('autonomy:reportTokens', (_e, payload = {}) => {
  if (!activeRunner) return { ok: false };
  const n = Number(payload && payload.tokens);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  try { activeRunner.setReportedTokens(n); } catch (_) {}
  // Re-broadcast budget so the rings update immediately to the new
  // authoritative number instead of waiting for the next 1s tick.
  if (mainWindow) mainWindow.webContents.send('autonomy:budget', activeRunner.budgetState());
  return { ok: true };
});

// History of past autonomy runs in the active project. Scans the
// per-session manifests under the autonomy storage dir, returns
// the most recent N. Each session manifest carries workspaceRoot;
// we filter to the requested workspace so each project sees its
// own history.
ipcMain.handle('autonomy:history', async (_e, payload = {}) => {
  const wantWorkspace = String(payload && payload.workspaceRoot || '').trim() || null;
  const sessionsDir = path.join(autonomyStorageRoot(), 'sessions');
  let entries = [];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- sessionsDir bounded to userData
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return { ok: true, runs: [] };
  }
  const runs = [];
  for (const sid of entries) {
    try {
      const manifestPath = path.join(sessionsDir, sid, 'snapshot.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
      if (!fs.existsSync(manifestPath)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (wantWorkspace && manifest.workspaceRoot && path.resolve(manifest.workspaceRoot) !== path.resolve(wantWorkspace)) continue;
      const auditPath = path.join(sessionsDir, sid, 'audit.jsonl');
      let goal = null;
      let status = 'unknown';
      let haltReason = null;
      let fileCount = 0;
      let endedAt = null;
      let dollars = 0;
      let tokens = 0;
      let caps = null;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
      if (fs.existsSync(auditPath)) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to sessionsDir
        const raw = fs.readFileSync(auditPath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        for (const ln of lines) {
          try {
            const row = JSON.parse(ln);
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
      runs.push({
        sessionId: sid,
        capturedAt: manifest.capturedAt || null,
        endedAt,
        workspaceRoot: manifest.workspaceRoot || null,
        goal,
        caps,
        status,
        haltReason,
        fileCount,
        dollars,
        tokens,
      });
    } catch (_) {}
  }
  runs.sort((a, b) => {
    const ka = new Date(a.endedAt || a.capturedAt || 0).getTime();
    const kb = new Date(b.endedAt || b.capturedAt || 0).getTime();
    return kb - ka;
  });
  return { ok: true, runs: runs.slice(0, 24) };
});

// Delete a past run: removes its session directory (manifest, audit log,
// and all snapshot blobs). Refuses an active run and validates the
// sessionId so the recursive remove can only ever touch a single session
// folder under the autonomy storage root.
ipcMain.handle('autonomy:deleteRun', (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return { ok: false, error: 'invalid sessionId' };
  }
  if (activeRunner && activeRunner.sessionId === sessionId) {
    return { ok: false, error: 'cannot delete the run that is still active' };
  }
  const dir = path.join(autonomyStorageRoot(), 'sessions', sessionId);
  const root = path.join(autonomyStorageRoot(), 'sessions');
  // Belt and suspenders: the resolved target must sit directly under the
  // sessions root and not be the root itself.
  const resolved = path.resolve(dir);
  if (resolved === path.resolve(root) || path.dirname(resolved) !== path.resolve(root)) {
    return { ok: false, error: 'path escapes autonomy storage' };
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
ipcMain.handle('autonomy:fileDiff', async (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  const workspaceRoot = String(payload && payload.workspaceRoot || '').trim();
  const relPath = String(payload && payload.path || '').trim();
  if (!sessionId || !workspaceRoot || !relPath) {
    return { ok: false, error: 'sessionId, workspaceRoot, path required' };
  }
  // Path traversal guard: reuse the snapshot joinSafely contract.
  const safeWorkspace = path.resolve(workspaceRoot);
  const safeAbs = path.resolve(safeWorkspace, relPath);
  if (!(safeAbs === safeWorkspace || safeAbs.startsWith(safeWorkspace + path.sep))) {
    return { ok: false, error: 'path escapes workspace' };
  }
  const storageRoot = autonomyStorageRoot();
  const sessDir = path.join(storageRoot, 'sessions', sessionId);
  const manifestPath = path.join(sessDir, 'snapshot.json');
  let manifest;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to storageRoot
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `could not read manifest: ${err.message}` };
  }
  const entry = manifest.entries && manifest.entries[relPath];

  let before = '';
  let beforeBytes = 0;
  let beforeTooLarge = false;
  if (entry && entry.type === 'file' && /^[a-f0-9]{64}$/.test(entry.sha || '')) {
    const blobPath = path.join(sessDir, 'blobs', entry.sha);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to storageRoot
      let buf = fs.readFileSync(blobPath);
      const { decrypt } = autonomyCrypto();
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
// from the Autonomy page. Uses the async walker so we never freeze
// the main process for a multi-second diff. No sessionId required:
// the active runner owns one.
ipcMain.handle('autonomy:liveDiff', async () => {
  if (!activeRunner) return { ok: false, error: 'no active run' };
  try {
    const res = await Autonomy.snapshot.diffWorkspaceAsync(
      activeRunner.workspaceRoot,
      autonomyStorageRoot(),
      activeRunner.sessionId,
    );
    return res;
  } catch (err) {
    return { ok: false, error: err && err.message || String(err) };
  }
});

ipcMain.handle('autonomy:summary', async (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  const { decrypt } = autonomyCrypto();
  // Diff the recorded workspace only, never a caller-supplied path, so this
  // read cannot be used to enumerate an arbitrary directory tree. Use the
  // async walker so loading a past run from history does not freeze the UI.
  const workspaceRoot = manifestWorkspaceRoot(sessionId);
  return Autonomy.supervisor.summarizeRunAsync({
    sessionId,
    workspaceRoot,
    storageRoot: autonomyStorageRoot(),
    decrypt,
  });
});

// ─── Config IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => ({ ...config }));
ipcMain.handle('config:set', (_e, partial) => {
  const paiChanged = Object.prototype.hasOwnProperty.call(partial || {}, 'paiEnabled')
    && partial.paiEnabled !== config.paiEnabled;
  config = { ...config, ...partial };
  saveConfig(config);
  if (paiChanged) {
    // Park or restore ~/.claude/CLAUDE.md so the next agent restart actually
    // sees (or no longer sees) the PAI mode-banner instructions. The
    // statusline tick is best-effort kicked back in / off; bootstrap on disk
    // is left as-is; bringing PAI back on a future launch will repair any
    // missing pieces via bootstrapPaiIfNeeded.
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

function isOnPath(binName) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
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
    description: 'Restrict the agent to one folder. Claude already reads and writes files; this MCP confines it to a path you pick.',
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

// Every mcp:* handler routes through the per-agent adapter selected
// by config.agentCommand. claude and copilot are fully wired; codex,
// aider, gemini, and unknown agents fall through to a stub that
// surfaces "not supported" without misreading another agent's config.
function activeMcpAdapter() {
  return getMcpAdapter(config.agentCommand);
}

ipcMain.handle('mcp:list', () => {
  const result = activeMcpAdapter().list();
  return { ...result, agent: activeMcpAdapter().agent, supportsWrite: activeMcpAdapter().supportsWrite, supportsLiveStatus: activeMcpAdapter().supportsLiveStatus };
});

ipcMain.handle('mcp:health', () => activeMcpAdapter().health());
ipcMain.handle('mcp:add', (_e, payload = {}) => activeMcpAdapter().add(payload));
ipcMain.handle('mcp:update', (_e, payload = {}) => {
  const adapter = activeMcpAdapter();
  if (typeof adapter.update !== 'function') return { ok: false, error: 'Edit not supported for this CLI' };
  const { id, ...rest } = payload || {};
  return adapter.update(id, rest);
});
ipcMain.handle('mcp:remove', (_e, id) => activeMcpAdapter().remove(id));
ipcMain.handle('mcp:toggle', (_e, id) => activeMcpAdapter().toggle(id));

// addMany takes a list of canonical payloads (each already split into
// command/args + transport per the buildServerEntry contract) and tries
// to add() each one. Returns a per-id status map so the renderer can
// show which succeeded vs. which already existed vs. which errored.
ipcMain.handle('mcp:addMany', (_e, payload = {}) => {
  const adapter = activeMcpAdapter();
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  if (!items.length) return { ok: false, error: 'no items supplied' };
  const results = {};
  let installed = 0;
  for (const item of items) {
    if (!item || !item.id) {
      results[item && item.id ? item.id : '_anon_'] = { status: 'error', error: 'missing id' };
      continue;
    }
    const r = adapter.add(item);
    if (r.ok) { results[item.id] = { status: 'installed' }; installed++; }
    else if (/already exists/i.test(r.error || '')) results[item.id] = { status: 'exists', error: r.error };
    else results[item.id] = { status: 'error', error: r.error };
  }
  return { ok: true, results, installed, total: items.length };
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

ipcMain.handle('stats:get', () => {
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  const skills = safeCount(skillsDir, (d) => d.isDirectory());
  const workflowsDir = path.join(CLAUDE_DIR, 'workflows');
  const workflows = safeCount(workflowsDir, (e) => e.isFile() && e.name.endsWith('.md'))
                  + safeCount(workflowsDir, (e) => e.isDirectory());
  const hooksDir = path.join(CLAUDE_DIR, 'hooks');
  const hooks = safeCount(hooksDir, (e) => e.isFile() && e.name.endsWith('.hook.ts'));
  const workDir = path.join(CLAUDE_DIR, 'MEMORY', 'WORK');
  const sessions = safeCount(workDir, (e) => e.isDirectory());
  const ratings = countLines(path.join(CLAUDE_DIR, 'MEMORY', 'LEARNING', 'SIGNALS', 'ratings.jsonl'));
  const researchDir = path.join(CLAUDE_DIR, 'MEMORY', 'RESEARCH');
  const research = safeCount(researchDir, (e) => e.isDirectory());

  // Reads from the same caches the statusline-command.sh consumes
  const stateDir = path.join(CLAUDE_DIR, 'MEMORY', 'STATE');
  const usage = readJSON(path.join(stateDir, 'usage-cache.json'), {});
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

  return {
    skills, workflows, hooks, sessions, ratings, research,
    huskVer: app.getVersion(),
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
      session: readActiveSessionStats(),
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
        return { source: 'claude', name, id: dirName, path: dir, mdPath, description, disabled };
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

function loadWorkflows() {
  try {
    if (!fs.existsSync(WORKFLOWS_PATH)) return [];
    return JSON.parse(fs.readFileSync(WORKFLOWS_PATH, 'utf8'));
  } catch (_) { return []; }
}

function saveWorkflows(list) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(WORKFLOWS_PATH, JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch (_) {}
}

// In-memory active runs: runId -> { workflow, steps state, currentChild }
const activeRuns = new Map();

ipcMain.handle('workflows:list', () => loadWorkflows().map(migrateWorkflow));

// Environment for spawned one-shot CLI agents (workflow steps, prompt
// generation). Mirrors the PTY env so PAI hooks resolve: ~/.bun/bin must be
// on PATH or every bun-based SessionEnd hook fails with 'bun: not found'.
function buildAgentEnv() {
  const env = Object.assign({}, process.env, { CLAUDE_DIR, HUSK_HOST: '1' });
  const bunBin = path.join(HOME, '.bun', 'bin');
  if (env.PATH && !env.PATH.includes(bunBin)) env.PATH = `${bunBin}:${env.PATH}`;
  return env;
}

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
  if (!id) return { ok: false, error: 'missing id' };
  saveWorkflows(loadWorkflows().filter((w) => w.id !== id));
  return { ok: true };
});

ipcMain.handle('workflows:run', (event, workflowId) => {
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
  try { if (run.currentChild) run.currentChild.kill('SIGTERM'); } catch (_) {}
  return { ok: true };
});

// ─── Workflow graph model ─────────────────────────────────────────────────────
// A workflow is a graph of step nodes connected by edges. Edges carry a
// routing condition (used by the 2b branch engine; 2a treats all as 'always').

function wfEmit(event, channel, data) {
  try { if (!event.sender.isDestroyed()) event.sender.send(channel, data); } catch (_) {}
}

async function executeWorkflow(event, workflow, run) {
  // Yield so ipcMain.handle can return the runId to the renderer before we
  // emit any step events. Without this, wf:node:start fires before the
  // renderer has set activeRunId and events get silently dropped.
  await new Promise((resolve) => setImmediate(resolve));

  const graph = sanitizeGraph(workflow.graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hasIncoming = new Set(graph.edges.map((e) => e.to));
  let node = graph.nodes.find((n) => !hasIncoming.has(n.id)) || graph.nodes[0];

  let previousOutput = '';
  let prevName = '';
  const visited = new Set();
  const MAX_NODES = 64; // cycle / runaway guard

  while (node && !visited.has(node.id) && visited.size < MAX_NODES) {
    if (run.status === 'stopped') break;
    visited.add(node.id);
    const step = node;
    const stepState = run.stepStates[node.id] || (run.stepStates[node.id] = { status: 'pending', output: '' });
    stepState.status = 'running';
    wfEmit(event, 'wf:node:start', { runId: run.id, nodeId: node.id });

    const cmd = (step.agentCommand || config.agentCommand || 'claude').trim().split(/\s+/)[0];

    // The resolved cmd may come from step.agentCommand (already
    // checked by sanitizeNode) or from config.agentCommand. Apply the
    // same allowlist here so both paths agree.
    if (!isAllowedAgentCommand(cmd)) {
      wfEmit(event, 'wf:node:activity', {
        runId: run.id,
        nodeId: node.id,
        kind: 'error',
        text: `Step "${node.name}" needs one of ${Array.from(wfLib.ALLOWED_AGENT_COMMANDS).join(', ')}; got "${cmd}".`,
      });
      wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: node.id, ok: false });
      wfEmit(event, 'wf:run:done', { runId: run.id, ok: false, error: 'unsupported_agent_command' });
      return;
    }

    let prompt = step.prompt;
    if (previousOutput) {
      if (prompt.includes('{{previousOutput}}')) {
        prompt = prompt.replace(/\{\{previousOutput\}\}/g, previousOutput);
      } else if (step.passContext !== 'none') {
        const ctx = step.passContext === 'last50'
          ? previousOutput.split('\n').slice(-50).join('\n')
          : previousOutput;
        prompt = `${prompt}\n\n[Output from previous step "${prevName}"]\n${ctx}`;
      }
    }

    const useStreamJson = cmd === 'claude';
    let wfSystem = 'You are running as an automated workflow step. Respond with only the direct result of the task. Do not use status banners, mode headers, structured output scaffolding, or voice notification commands. Plain, direct output only.';
    // If this node has 2+ branches with no explicit conditions, it routes by
    // its own decision: tell it to end with a ROUTE: directive.
    if (wfIsAiRouted(graph, node.id)) {
      const targets = graph.edges
        .filter((e) => e.from === node.id)
        .map((e) => byId.get(e.to))
        .filter(Boolean)
        .map((n) => n.name);
      if (targets.length >= 2) wfSystem += wfRouteInstruction(targets);
    }
    const args = useStreamJson
      ? ['-p', prompt, '--append-system-prompt', wfSystem, '--output-format', 'stream-json', '--verbose']
      : ['-p', prompt, '--append-system-prompt', wfSystem];

    const nid = node.id;
    const activity = (kind, text) => {
      wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: nid, kind, text: String(text || '') });
    };

    let resultText = '';
    let lineBuf = '';
    let sawAnyEvent = false;

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildAgentEnv() });
    run.currentChild = child;
    activity('status', 'Starting the CLI agent...');

    child.stdout.on('data', (d) => {
      if (!useStreamJson) {
        resultText += d.toString();
        activity('text', d.toString());
        return;
      }
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
    child.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) activity('error', t);
    });

    const killTimer = setTimeout(() => {
      activity('error', 'Step timed out after 5 minutes, killing the agent.');
      try { child.kill('SIGKILL'); } catch (_) {}
    }, 300000);

    await new Promise((resolve) => {
      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (useStreamJson && !sawAnyEvent && resultText === '') {
          activity('error', 'No output from the agent. It may need authentication or stream-json is unsupported.');
        }
        stepState.status = run.status === 'stopped' ? 'cancelled' : (code === 0 ? 'done' : 'failed');
        stepState.output = resultText;
        wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: nid, status: stepState.status, output: resultText });
        resolve();
      });
      child.on('error', (e) => {
        clearTimeout(killTimer);
        activity('error', e.message);
        stepState.status = 'failed';
        wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: nid, status: 'failed' });
        resolve();
      });
    });

    if (stepState.status === 'failed') { run.status = 'failed'; break; }
    if (run.status === 'stopped') break;

    previousOutput = resultText;
    prevName = step.name;

    // Resolve the next step: AI-decided ROUTE directive, or text conditions.
    const next = wfResolveNext(graph, node, resultText, byId);
    if (next && next.edge) {
      const target = byId.get(next.edge.to);
      if (next.decision && target) {
        wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: node.id, kind: 'status', text: `Routing decision: continue to "${target.name}"` });
      }
      wfEmit(event, 'wf:edge:taken', { runId: run.id, edgeId: next.edge.id, from: next.edge.from, to: next.edge.to });
      node = target || null;
    } else {
      if (next && next.decision === 'END') {
        wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: node.id, kind: 'status', text: 'Routing decision: end the workflow' });
      }
      node = null;
    }
  }

  if (run.status === 'running') run.status = 'done';
  run.finishedAt = new Date().toISOString();
  wfEmit(event, 'wf:run:done', { runId: run.id, status: run.status });
  activeRuns.delete(run.id);
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
];

// Native agents directory per CLI. Both claude and copilot load the same
// markdown agent format from these locations, so a Husk agent written into
// each installed CLI's dir is usable in whichever CLI the user runs.
const CLAUDE_AGENTS_DIR = path.join(HOME, '.claude', 'agents');
const COPILOT_AGENTS_DIR = path.join(HOME, '.copilot', 'agents');
function installedAgentDirs() {
  const out = [];
  try { if (fs.existsSync(path.join(HOME, '.claude'))) out.push(CLAUDE_AGENTS_DIR); } catch (_) {}
  try { if (fs.existsSync(path.join(HOME, '.copilot'))) out.push(COPILOT_AGENTS_DIR); } catch (_) {}
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
// repoAgents:install with the user's selection.

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

ipcMain.handle('repoAgents:pickDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an agent-pack repository',
    properties: ['openDirectory'],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle('repoAgents:scan', (_e, payload = {}) => {
  const root = String((payload && payload.root) || '').trim();
  if (!root || !path.isAbsolute(root)) {
    return { ok: false, error: 'absolute path required' };
  }
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { ok: false, error: 'directory does not exist' };
    }
    const resolved = resolveRepoAgentsDir(root);
    const skillsDir = resolveRepoSkillsDir(root);
    const existingProfileNames = new Set(
      getProfiles().map((p) => String(p.name || '').toLowerCase())
    );
    const agents = [];
    if (resolved) {
      for (const entry of fs.readdirSync(resolved.dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(resolved.ext)) continue;
        try {
          const fp = path.join(resolved.dir, entry.name);
          const text = fs.readFileSync(fp, 'utf8');
          const parsed = parseAgentMd(text);
          const name = (parsed.name || stripAgentExt(entry.name)).slice(0, 64);
          agents.push({
            filename: entry.name,
            name,
            description: (parsed.description || '').slice(0, 256),
            bodyLength: (parsed.body || '').length,
            alreadyInClaude: fs.existsSync(path.join(CLAUDE_DIR, 'agents', entry.name)),
            alreadyImported: existingProfileNames.has(name.toLowerCase()),
          });
        } catch (_) {}
      }
      agents.sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
      ok: true,
      root,
      agents,
      hasSkillsDir: !!skillsDir,
    };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('repoAgents:install', (_e, payload = {}) => {
  const root = String((payload && payload.root) || '').trim();
  const picks = Array.isArray(payload && payload.picks) ? payload.picks : [];
  const installToClaudeAgents = payload.installToClaudeAgents !== false;
  const activate = !!payload.activate;
  if (!root || !path.isAbsolute(root)) return { ok: false, error: 'absolute path required' };
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, error: 'directory does not exist' };
  }
  if (!picks.length) return { ok: false, error: 'nothing selected' };
  const resolved = resolveRepoAgentsDir(root);
  if (!resolved) return { ok: false, error: 'no agents directory found in repo' };
  const agentsDir = resolved.dir;
  const claudeAgentsDir = path.join(CLAUDE_DIR, 'agents');
  try { fs.mkdirSync(claudeAgentsDir, { recursive: true }); } catch (_) {}
  const list = getProfiles().slice();
  const importedIds = [];
  const copiedToClaude = [];
  for (const pick of picks) {
    const fname = String((pick && pick.filename) || '');
    if (!fname.endsWith('.md') || fname.includes('/') || fname.includes('\\') || fname.includes('..')) continue;
    const src = path.join(agentsDir, fname);
    if (!fs.existsSync(src)) continue;
    try {
      const text = fs.readFileSync(src, 'utf8');
      const parsed = parseAgentMd(text);
      const name = (parsed.name || stripAgentExt(fname)).slice(0, 64);
      if (installToClaudeAgents) {
        const dest = path.join(claudeAgentsDir, fname);
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
const WRITE_TARGETS = new Set(['claude', 'copilot']);
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
  // Escape backslashes BEFORE quotes so we don't leave half-escaped pairs:
  //   raw: foo\"bar    naive: foo\\"bar (broken, closes the JSON string)
  //   escape \\ first:  foo\\\"bar -> when YAML parses double-quoted, it sees foo\"bar
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
  if (fs.existsSync(newPath)) return { ok: false, error: 'Target already exists' };
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
// mirroring sessions:list.

const Plugins = require('./lib/plugins');

const PLUGIN_CLI_TIMEOUT_MS = 180000; // installs may git-clone
const PLUGIN_CLI_OUTPUT_CAP = 65536;

function pluginsSupported() { return getAgentKind() === 'claude'; }

// Resolve a validated installed plugin's install path, confined to the
// plugins root. Returns null when unknown or outside the root (a
// tampered registry must not turn the editor into an arbitrary-fs API).
function pluginInstallPath(id) {
  if (!Plugins.isSafePluginId(id)) return null;
  const inst = Plugins.readInstalled(CLAUDE_DIR).find((p) => p.id === id);
  if (!inst || !inst.installPath) return null;
  if (!Plugins.isInsidePluginsRoot(CLAUDE_DIR, inst.installPath)) return null;
  return inst.installPath;
}

ipcMain.handle('plugins:list', () => {
  if (!pluginsSupported()) return { ok: true, supported: false, plugins: [] };
  return { ok: true, supported: true, plugins: Plugins.readInstalled(CLAUDE_DIR) };
});

ipcMain.handle('plugins:catalog', () => {
  if (!pluginsSupported()) return { ok: true, supported: false, catalog: [] };
  return { ok: true, supported: true, catalog: Plugins.readCatalog(CLAUDE_DIR) };
});

ipcMain.handle('plugins:run', (_e, payload = {}) => {
  if (!pluginsSupported()) return { ok: false, error: 'the active agent has no plugin system' };
  const verb = String(payload.action || '');
  // buildPluginCliArgs owns the verb allowlist AND the id validation
  // (isSafePluginId): null means one of them failed. The id rides as a
  // single argv element with no shell, so neither flags nor
  // metacharacters can ride along.
  const argv = Plugins.buildPluginCliArgs(verb, String(payload.id || ''));
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
  // lstat, not stat: a marketplace plugin can ship a symlink pointing
  // outside its own dir; following it would turn the editor into a
  // read-anything API. Refuse links outright.
  let st;
  try { st = fs.lstatSync(abs); } catch (_) { return { ok: false, error: 'file not found' }; }
  if (!st.isFile()) return { ok: false, error: 'not a regular file' };
  if (!Plugins.isEditableFile(abs, st.size)) return { ok: false, error: 'file is binary or too large to edit' };
  try { return { ok: true, content: fs.readFileSync(abs, 'utf8') }; }
  catch (err) { return { ok: false, error: err.message }; }
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
  // Same symlink refusal as readFile: only ever write through a path
  // that is currently a regular file inside the plugin dir.
  let st;
  try { st = fs.lstatSync(abs); } catch (_) { return { ok: false, error: 'file not found' }; }
  if (!st.isFile()) return { ok: false, error: 'not a regular file' };
  try {
    fs.writeFileSync(abs, content);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
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

// Parse the head of a claude session JSONL for the fields Husk titles a
// session by: claude's own ai-title, the first user message, a queued prompt,
// the start timestamp, and the original working directory. Returns null if the
// file cannot be read.
function parseSessionHead(fullPath) {
  let aiTitle = ''; let userMessage = ''; let queueContent = '';
  let startedISO = ''; let originalCwd = '';
  try {
    const text = readHead(fullPath, 32768);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (!startedISO && obj.timestamp) startedISO = obj.timestamp;
      if (!originalCwd && typeof obj.cwd === 'string') originalCwd = obj.cwd;
      if (!aiTitle && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') aiTitle = obj.aiTitle.trim();
      if (!userMessage && obj.type === 'user' && obj.message) {
        const c = obj.message.content;
        if (typeof c === 'string') userMessage = c.trim();
        else if (Array.isArray(c)) {
          const tp = c.find((p) => p && p.type === 'text' && typeof p.text === 'string');
          if (tp) userMessage = tp.text.trim();
        }
      }
      if (!queueContent && obj.type === 'queue-operation' && typeof obj.content === 'string') queueContent = obj.content.trim();
      if (aiTitle && startedISO && userMessage && originalCwd) break;
    }
  } catch (_) { return null; }
  return { aiTitle, userMessage, queueContent, startedISO, originalCwd };
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
function readCopilotWorkspace(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
    const o = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) o[m[1]] = m[2].trim();
    }
    return o;
  } catch (_) { return null; }
}

// List copilot sessions from ~/.copilot/session-state/<uuid>/, normalized to
// the same shape the renderer consumes for claude sessions. Copilot stores the
// session name, cwd, and timestamps in each session's workspace.yaml.
function listCopilotSessions() {
  const root = path.join(HOME, '.copilot', 'session-state');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (_) { return []; }
  const out = [];
  for (const d of dirs) {
    const full = path.join(root, d.name);
    const ws = readCopilotWorkspace(full);
    if (!ws || !ws.id) continue;
    let mtime = Date.parse(ws.updated_at) || 0;
    let sizeBytes = 0;
    try { const st = fs.statSync(path.join(full, 'events.jsonl')); sizeBytes = st.size; if (!mtime) mtime = st.mtimeMs; }
    catch (_) { if (!mtime) { try { mtime = fs.statSync(full).mtimeMs; } catch (_e) {} } }
    const startedMs = Date.parse(ws.created_at) || mtime;
    const name = (ws.name && ws.name !== 'null') ? ws.name.slice(0, 120) : '';
    out.push({
      id: ws.id,
      project: ws.cwd || '',
      projectPath: ws.cwd || '',
      originalCwd: ws.cwd || '',
      path: full,
      title: name || '(unnamed session)',
      firstMessage: name,
      prdSlug: '', prdPhase: '', prdProgress: '', prdPath: '',
      startedISO: ws.created_at || new Date(mtime || 0).toISOString(),
      startedMs,
      sizeBytes,
      mtime,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// List the active agent's saved sessions. Husk is tool-agnostic: the source
// (and on-disk format) depends on which CLI is active. claude keeps JSONL
// transcripts under ~/.claude/projects; copilot keeps per-session folders under
// ~/.copilot/session-state. Agents we do not yet read return an empty list with
// supported:false so the UI can say so instead of erroring.
ipcMain.handle('sessions:list', () => {
  const agent = activeAgentName();
  if (agent === 'copilot') {
    return { ok: true, agent, supported: true, sessionsDir: path.join(HOME, '.copilot', 'session-state'), sessions: listCopilotSessions() };
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
  for (const { id, project: projName, fullPath, st } of top) {
    {
      // Read first 32KB and pull priority-ranked title + the original cwd
      let startedISO = '';
      let aiTitle = '';
      let userMessage = '';
      let queueContent = '';
      let originalCwd = '';
      let sawAssistant = false;
      let headComplete = false;
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
          if (!aiTitle && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
            aiTitle = obj.aiTitle.trim();
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

      const firstMessage = (aiTitle || userMessage || queueContent || '').slice(0, 220);

      const sessionStartMs = startedISO ? Date.parse(startedISO) : st.mtimeMs;
      const matchedPrd = matchPrd(sessionStartMs);

      // Authoritative cwd is what the JSONL recorded; fall back to decoded project name
      const cwdAuthoritative = originalCwd || decodeProjectPath(projName);

      out.push({
        id,
        project: projName,
        projectPath: cwdAuthoritative,
        originalCwd: originalCwd || '',
        path: fullPath,
        title: matchedPrd ? matchedPrd.task : (firstMessage || '(empty)'),
        firstMessage: firstMessage || '',
        prdSlug: matchedPrd ? matchedPrd.slug : '',
        prdPhase: matchedPrd ? matchedPrd.phase : '',
        prdProgress: matchedPrd ? matchedPrd.progress : '',
        prdPath: matchedPrd ? matchedPrd.prdPath : '',
        startedISO: startedISO || new Date(st.mtimeMs).toISOString(),
        startedMs: sessionStartMs,
        sizeBytes: st.size,
        mtime: st.mtimeMs,
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
  return { ok: true, agent: 'claude', supported: true, sessionsDir: projectsDir, sessions: deduped };
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
    const list = listCopilotSessions();
    const known = String((payload && payload.knownAgentId) || '');
    if (known) {
      const hit = list.find((x) => x.id === known);
      const custom = customFor(known);
      if (hit || custom != null) {
        return { ok: true, agentId: known, custom: custom != null, title: custom != null ? custom : (hit ? hit.title : '') };
      }
      return { ok: false };
    }
    const s = sessions.get(String((payload && payload.huskSessionId) || ''));
    if (!s || !s.cwd) return { ok: false };
    const startedAt = s.startedAt || 0;
    const exclude = new Set(Array.isArray(payload && payload.excludeAgentIds) ? payload.excludeAgentIds : []);
    let best = null;
    for (const x of list) {
      if (exclude.has(x.id)) continue;
      if (x.originalCwd && x.originalCwd !== s.cwd) continue;
      if (isFinite(x.startedMs) && x.startedMs < startedAt - 60_000) continue;
      if (!best || x.startedMs < best.startedMs) best = x;
    }
    if (!best) return { ok: false };
    const custom = customFor(best.id);
    return { ok: true, agentId: best.id, custom: custom != null, title: custom != null ? custom : best.title };
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
      return { ok: true, agentId: known, custom: custom != null, title: custom != null ? custom : sessionTitleFrom(parseSessionHead(full)) };
    }
    const custom = customFor(known);
    return custom != null ? { ok: true, agentId: known, custom: true, title: custom } : { ok: false };
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
  return { ok: true, agentId: best.id, custom: custom != null, title: custom != null ? custom : sessionTitleFrom(best.info) };
});

// Save (or clear, when name is empty) a user's custom name for an agent
// session, keyed by the stable claude session id so it survives restarts.
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
        ? 'Permanently delete this claude session?'
        : `Permanently delete ${safe.length} claude sessions?`,
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

// ─── Voice (local TTS, no API keys) ─────────────────────────────────────────────
//
// Two backends:
//   - Linux: Piper (downloaded into ~/.local/share/husk/piper, ~50 MB)
//   - macOS: built-in `say` command. No install needed, no download. The Linux
//     Piper binary is x86_64 ELF and won't run on Darwin anyway, so the darwin
//     branch uses `say` and never attempts to install Piper, which would throw
//     'spawn Unknown system error -8' from the running-not-runnable binary.

const IS_MAC = process.platform === 'darwin';

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
const PIPER_BIN = path.join(PIPER_DIR, 'piper');
const VOICES_DIR = path.join(PIPER_DIR, 'voices');

const PIPER_RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz';
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
      const tarPath = path.join(os.tmpdir(), 'piper-husk.tar.gz');
      await runStep('curl', ['-fsSL', '-o', tarPath, PIPER_RELEASE], 'Downloading Piper binary');
      await runStep('tar', ['-xzf', tarPath, '-C', HUSK_DATA], 'Extracting Piper');
      try { fs.unlinkSync(tarPath); } catch (_) {}
      try { fs.chmodSync(PIPER_BIN, 0o755); } catch (_) {}
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

// Listen on 127.0.0.1:8888 with a silent sink so external TTS POSTs do
// not produce sound while Husk is running. If the port is already held
// by another process we leave it alone and continue without the sink.
// Released cleanly on quit.
let nullVoiceServer = null;
function startNullVoiceServer() {
  return new Promise((resolve) => {
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
    server.listen(8888, '127.0.0.1', () => {
      nullVoiceServer = server;
      resolve();
    });
  });
}
function stopNullVoiceServer() {
  if (nullVoiceServer) { try { nullVoiceServer.close(); } catch (_) {} nullVoiceServer = null; }
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
function stopAutoUpdater() {
  if (updaterInitialTimer) { clearTimeout(updaterInitialTimer); updaterInitialTimer = null; }
  if (updaterPeriodicTimer) { clearInterval(updaterPeriodicTimer); updaterPeriodicTimer = null; }
}
let updateState = { status: 'idle', current: app.getVersion() };

function sendUpdateStatus(extra = {}) {
  updateState = { ...updateState, ...extra };
  if (mainWindow) mainWindow.webContents.send('update:status', updateState);
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
  autoUpdater.on('error', (err) => sendUpdateStatus({
    status: 'error',
    error: (err && err.message) || String(err),
  }));

  // Fire one check shortly after launch and again every 6 hours. Both are
  // stored and unref'd so they can be cleared at quit and never pin the event
  // loop open after the window closes (which left the main process alive).
  updaterInitialTimer = setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 4000);
  updaterInitialTimer.unref();
  updaterPeriodicTimer = setInterval(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 6 * 60 * 60 * 1000);
  updaterPeriodicTimer.unref();
}

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
  // Quit current app, install update, relaunch. forceRunAfter true so the
  // user does not have to relaunch manually.
  setImmediate(() => { try { updaterInstance.quitAndInstall(false, true); } catch (_) {} });
  return { ok: true };
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
// instead of spawning another process tree (which is how we ended up with
// piles of orphans burning the inotify_user_instances limit).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
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
    createWindow();
    setupAutoUpdater();
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
