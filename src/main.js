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
const { resolveInside, isInside, realParentInside, realPathInside } = require('./lib/path-confine');
const { openCommand: bgOpenCommand, controlArgs: bgControlArgs } = require('./lib/bg-agent-open');
const { isLive: agentIsLive } = require('./lib/agent-state');
const StatuslineTrust = require('./lib/statusline-trust');
const { parseAgentMd } = require('./lib/agent-md');
const wfLib = require('./lib/workflow-graph');
const { buildSpawnSpec, withCopilotContextDir } = require('./lib/pty-spawn');
const AgentInject = require('./lib/agent-inject');
const { createMouseModeStripper } = require('./lib/term-mouse');
const { wheelSequence, wheelSteps } = require('./lib/wheel-seq');
const { agentFileName, renderAgentMd, isHuskManaged, agentMdBody } = require('./lib/agent-file');
const { parseShellPathOutput, MARKER_START, MARKER_END } = require('./lib/user-path');
const { pickResumeSessionId } = require('./lib/claude-session');
const { parsePorcelain } = require('./lib/git-porcelain');
const { parseGitStatus, groupBoard } = require('./lib/workspace-state');
const { getAdapter: getMcpAdapter } = require('./lib/mcp');
const SharedMcp = require('./lib/mcp/shared');
const { deriveCopilotSessionTitleFromEventsText } = require('./lib/copilot-session-title');

// A GUI-launched Electron app inherits a minimal PATH that omits the
// npm-global, homebrew, and bun install directories where agent CLIs live.
// Read the user's shell PATH so later spawns can find their binaries. Runs
// asynchronously because an interactive login shell sources the full rc chain
// (nvm, pyenv, conda init), which can take seconds; agent spawns happen on
// user action, well after this resolves.
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
// an absolute path so the spawn does not depend on the child's PATH. It walks
// envPath first (cheap, no subprocess), then asks a login shell `command -v`
// (POSIX) / `where` (win32), which sources the user's full rc chain. Returns exe
// unchanged when it is already a path, already resolvable, or when the lookup
// fails, so the subprocess only runs on the fallback path.
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
  layoutGraph,
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
// GPU acceleration safe defaults for desktop Electron 32
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
// Each chat tab owns its own PTY child, output buffer, mouse-mode stripper and
// listener disposables, so several agents run in parallel. `sessions` maps the
// renderer's sessionId to that state; `activeSessionId` is the focused tab. The
// mirrors below always track the active session, so the autopilot + stats code
// needs no per-call session plumbing.
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

// An agent's system prompt is a whole document, not a field: the ones people
// actually write run to tens of thousands of characters, so this bound sits far
// above any real prompt.
const AGENT_PROMPT_MAX = 262144;
const AGENT_NAME_MAX = 64;
const AGENT_DESC_MAX = 1024;

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
  // ~/.claude/. Enabled by default; switching it off skips the bootstrap, stops
  // the statusline tick, and drops the framework reference from the Husk
  // identity prompt. The key name is part of the stored config contract.
  paiEnabled: true,
  profiles: DEFAULT_PROFILES,
  activeProfileId: null,
  // Map of encoded-cwd -> the last claude session id Husk bound there. On a
  // fresh app boot the in-memory tab->session binding is gone, so this lets a
  // launch resume the ongoing discussion for that project instead of minting a
  // new session and splitting one conversation across many transcripts.
  lastClaudeSessions: {},
  // Map of project path -> { mcpServerId: 'on' | 'off' }. A server with no
  // entry inherits the global list, so a project nobody has customized runs
  // the CLI's own set untouched. See src/lib/project-mcp.js.
  projectMcp: {},
};

// The theme an install shows when its config file carries no `theme` key, so it
// keeps the look it is already displaying.
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
    // A config file on disk means an existing install: pin the theme it already
    // shows when the file carries none.
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
    // writeFileSync applies mode only when it creates the file, so set the mode
    // on the file and its directory explicitly.
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (_) {}
    try { fs.chmodSync(CONFIG_DIR, 0o700); } catch (_) {}
    return true;
  } catch (_) { return false; }
}

let config = loadConfig();

// ─── Framework bootstrap (packaged binaries) ─────────────────────────────────
// A packaged binary has no install.sh, so libs/lifeos is copied into ~/.claude/
// here on first launch. In dev mode the bundle path does not exist and
// install.sh handles it.
// ~/.config/husk/prompts/ is seeded from the bundled curated set on first
// launch. A file that already exists in the destination is left alone.
// The statusline script runs periodically so the caches it writes
// (location-cache.json, weather-cache.json, model-cache.txt) stay fresh while
// Husk is open. It does not write usage-cache.json, so Husk fetches the 5h / 7d
// limits itself. See refreshAnthropicUsageCache below.
let statuslineTimer = null;

// Runs the framework's statusline script, pinned by path and content.
const STATUSLINE_CANDIDATES = () => [
  path.join(CLAUDE_DIR, 'LIFEOS', 'LIFEOS_StatusLine.sh'),
  path.join(CLAUDE_DIR, 'PAI', 'statusline-command.sh'),
  path.join(CLAUDE_DIR, 'statusline-command.sh'),
];

let statuslineRefusedOnce = false;

// sha256 of a regular file, or null. The kind, the size and the bytes are all
// read from one descriptor. O_NOFOLLOW refuses a symlink at open, O_NONBLOCK
// keeps a fifo from parking the open until someone writes to it.
function statuslineDigest(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > 4 * 1024 * 1024) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally { fs.closeSync(fd); }
}

// Returns the script to run, or null. The rule lives in lib/statusline-trust.
function statuslineScriptToRun() {
  const pin = (config.statuslineTrust && typeof config.statuslineTrust === 'object')
    ? config.statuslineTrust
    : null;
  const verdict = StatuslineTrust.decide(STATUSLINE_CANDIDATES(), pin, statuslineDigest);

  if (verdict.pin) { config.statuslineTrust = verdict.pin; saveConfig(config); }

  // Logged once per run rather than every tick.
  if (verdict.reason && !statuslineRefusedOnce) {
    statuslineRefusedOnce = true;
    const why = {
      [StatuslineTrust.REFUSE_APPEARED]: 'appeared on a machine that had none when Husk last looked.',
      [StatuslineTrust.REFUSE_CHANGED]: 'no longer matches the copy Husk last trusted.',
      [StatuslineTrust.REFUSE_MALFORMED]: 'could not be checked against a readable trust record.',
    }[verdict.reason] || 'did not pass its trust check.';
    console.warn('husk: the statusline script was not run because it ' + why
      + ' Clear statuslineTrust in the Husk config to approve the current file.');
  }
  return verdict.run;
}

function refreshStatuslineCacheOnce() {
  try {
    const slPath = statuslineScriptToRun();
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

// Reads the plan usage endpoint with the user's claude credential and writes the
// result into ~/.claude/MEMORY/STATE/usage-cache.json, which the stats:get path
// reads from. The statusline makes the same request each render but persists
// nothing, so Husk owns the cache write.
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

// Hostname and path are literals, the cache write copies a fixed allowlist of
// fields each coerced to a primitive, and the destination path is fixed.
// Requests past 5s are dropped.
function _coerceISOTimestamp(s) {
  if (typeof s !== 'string') return '';
  // RFC 3339-ish timestamp: digits, dashes, T, colons, dot, plus, Z.
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
      // Bound the body size.
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
        // Carry scalar fields forward from a prior write: ws_cost_dollars and
        // session_cost come from a stop hook rather than from every render.
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
        // Allowlisted, type-coerced fields only.
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

// Digests of every CLAUDE.md template Husk has shipped, so the toggle parks the
// live file only while it still matches Husk's own untouched scaffold. Older
// entries stay listed for installs that never upgraded theirs.
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

// The vendored bundle carries no bun lockfiles, by rule. The per-skill tools are
// optional and a user who opts in resolves current versions. The package.json
// files stay, since they are what makes that resolve possible.

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
  // Hard opt-out: with the framework disabled in Preferences, ~/.claude/ is
  // left untouched on launch. Pre-existing files stay where they are, and the
  // user can clean ~/.claude/{LIFEOS,agents,skills,hooks}/ themselves.
  if (config.paiEnabled === false) return;
  try {
    const claudeDir = path.join(HOME, '.claude');

    // A framework already laid out under ~/.claude/PAI/ owns its own CLAUDE.md
    // imports, so that install is left alone entirely.
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
    // semantics), checked independently of CLAUDE.md, so an install that
    // already has ~/.claude/CLAUDE.md still receives the bundled skills, agents
    // and hooks. LIFEOS is spelled in caps to match the @LIFEOS/... imports
    // CLAUDE.md carries, since any other spelling dangles on a case-sensitive
    // filesystem.
    for (const sub of ['LIFEOS', 'agents', 'commands', 'hooks', 'skills']) {
      const src = path.join(bundle, sub);
      const dst = path.join(claudeDir, sub);
      if (!fs.existsSync(src)) continue;
      if (!fs.existsSync(dst)) copyDirRecursiveSync(src, dst);
      else copyMissingChildrenSync(src, dst);
    }

    // The identity scaffold lands inside the runtime tree so the @LIFEOS/USER/...
    // imports resolve without a symlink. Every shipped file is a blank template.
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

// Like cp -Rn at the immediate-children level: copy each top-level entry in src
// to dst only when the destination entry does not exist. Never recurses into an
// existing destination subtree.
function copyMissingChildrenSync(src, dst) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isFile() && BUNDLE_INSTRUCTION_FILES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (fs.existsSync(d)) continue;
    // A disabled skill is renamed to _disabled_<name>, and counts as already
    // present so the original is not re-added beside it.
    if (fs.existsSync(path.join(dst, DISABLED_PREFIX + entry.name))) continue;
    if (entry.isDirectory()) copyDirRecursiveSync(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
    // ignore symlinks/devices
  }
}

// Agent-instruction files the bundle carries for the upstream project's own
// repo. They stay in the bundle and are never copied into a user's ~/.claude/,
// where writing the instructions is the user's business.
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
    // Low enough that the responsive breakpoints engage, so the app stays
    // usable in a small window.
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
      // DevTools available when running from source (./run.sh, npm start),
      // disabled in shipped builds.
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
  // A bare Alt press moves focus to the application menu bar, which then
  // swallows keystrokes until Escape. Swallow bare Alt before the menu sees it;
  // Alt+key combos still arrive as their own events (input.key is the combo
  // key), so terminal Alt-sequences keep working.
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

  // Top-level navigation requests go to the default browser, and the main
  // window stays on its loaded index.html.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  // The View submenu drops the DevTools toggle in shipped builds, where
  // webPreferences.devTools is false.
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
    // terminal, shows the percent), so `registerAccelerator: false` keeps the
    // menu roles from binding them too. Menu clicks still work.
    { role: 'resetZoom', registerAccelerator: false },
    { role: 'zoomIn', registerAccelerator: false },
    { role: 'zoomOut', registerAccelerator: false },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    // `paste` keeps `registerAccelerator: false` so Ctrl/Cmd+V binds once:
    // xterm already pastes on the native browser paste event.
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste', registerAccelerator: false }, { role: 'selectAll' }] },
    { label: 'View', submenu: viewSubmenu },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));

  mainWindow.on('closed', () => {
    killPtyTree();
    mainWindow = null;
  });
}

// SIGKILL one session's whole process group, so `script` + agent (and any
// children) die together. Killing an already-dead group is a no-op.
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

function spawnPty(cols = 100, rows = 30, overrideCmd = null, overrideCwd = null, sessionId = null, resumeLast = false) {
  // Target an existing session (Restart replaces just that tab's child) or
  // create a new one (New Chat passes a fresh id so the running agents keep
  // going). Falls back to the active session, then a generated id.
  const id = sessionId || activeSessionId || ('s' + (++sessionSeq));
  let s = sessions.get(id);
  if (!s) {
    s = newSession(id);
  } else {
    // Restart-in-place: dispose the previous child's node-pty listeners before
    // dropping the reference, drop buffered output, and kill the old child.
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
  // file. startedAt gates the lock (see readActiveSessionStats): only a file
  // written at or after this spawn gets pinned.
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
  });
  const bunBin = path.join(HOME, '.bun', 'bin');
  if (env.PATH && !env.PATH.includes(bunBin)) env.PATH = `${bunBin}:${env.PATH}`;
  // ~/.local/bin is where the native installers land, and a GUI/desktop launch
  // inherits a PATH that omits it. augmentUserPathAsync recovers it from a
  // login shell asynchronously, so force-prepend it here the same way as bun.
  const localBin = path.join(HOME, '.local', 'bin');
  if (env.PATH && !env.PATH.includes(localBin)) env.PATH = `${localBin}:${env.PATH}`;

  const rawCmd = (overrideCmd || config.agentCommand || 'claude').trim();

  // Tokenize the user's agent command into program + extra args. A naive
  // whitespace split covers the common forms ('claude', 'claude --some-flag').
  const userTokens = rawCmd.split(/\s+/).filter(Boolean);
  let agentExe = userTokens.shift() || 'claude';
  let agentArgs = userTokens;
  // A subcommand runs a different program under the same binary: `claude agents`
  // manages background agents and takes none of the chat flags. Decided from the
  // command as typed, since injected flags are prepended below, and only the
  // first token counts so a flag's bare value is not mistaken for one.
  const isSubcommand = agentArgs.length > 0 && !String(agentArgs[0]).startsWith('-');

  if (agentBaseName(agentExe) === 'kiro-cli' && (!agentArgs.length || String(agentArgs[0]).startsWith('-'))) {
    agentArgs = ['chat', ...agentArgs];
  }

  // Resolve a bare program name to an absolute path up front (which/where via a
  // login shell if needed) so the spawn does not depend on the child PATH being
  // correct. No-op when already a path or already on env.PATH.
  agentExe = resolveAgentExe(agentExe, env.PATH);

  // Deliver Husk's session directives (identity name, the speech-balloon line
  // the desktop reads aloud, recap on/off) through each agent's own instruction
  // channel: claude takes --append-system-prompt here, copilot needs a project
  // instructions file written below once cwd is resolved. See
  // src/lib/agent-inject.js. Skipped when the user already passed --settings and
  // on Windows. For claude the statusline override rides --settings as inline
  // JSON, which claude merges over the user's settings.json.
  const isWin32 = process.platform === 'win32';
  let injectionPlan = { method: 'none' };
  if (!isWin32 && !isSubcommand && !agentArgs.includes('--settings')) {
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
  // Pointing Husk at a project subdirectory rather than $HOME is what lets
  // claude offer its three-option, durable "remember this folder" trust prompt.
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
  // Selecting a repo-installed agent does not change the working directory: the
  // agent is loaded by its CLI natively and the cwd stays whatever the user
  // configured (agentCwd / active project / home).
  if (overrideCwd) {
    try {
      if (fs.existsSync(overrideCwd) && fs.statSync(overrideCwd).isDirectory()) {
        cwd = overrideCwd;
      } else {
        // The original project dir is gone. claude --resume keys sessions to the
        // original cwd path, so recreate it as an empty dir.
        try { fs.mkdirSync(overrideCwd, { recursive: true }); cwd = overrideCwd; } catch (_) {}
      }
    } catch (_) {}
  }

  agentArgs = withCopilotContextDir({
    agentExe,
    agentArgs,
    contextDir: path.join(CLAUDE_DIR, 'MEMORY', 'CONTEXT'),
  });

  // Narrow this launch to the MCP servers the folder wants. Only customized
  // folders get flags; everywhere else the CLI reads its own config. Nothing on
  // disk is rewritten.
  if (!isSubcommand) {
    const mcpArgs = projectMcpLaunchArgs(agentExe, cwd, agentArgs);
    if (mcpArgs.length) agentArgs = [...agentArgs, ...mcpArgs];
  }

  // Bind this tab to a definite claude session id so stats/recent/resume read
  // exactly this tab's transcript: --resume supplies it on a resume, and a new
  // chat mints one and passes --session-id. Windows is skipped because its spawn
  // may fall back to `cmd.exe /c <rawCmd>`, which ignores agentArgs.
  // The encoding matches the agent CLI's own project-dir form (all
  // non-alphanumerics become dashes), since lastClaudeSessions is keyed on it.
  const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const resumeMatch = (rawCmd || '').match(/--resume[=\s]+([A-Za-z0-9][A-Za-z0-9-]{6,})/);
  const isClaudeAgent = agentExe === 'claude' || agentExe.endsWith('/claude') || agentExe.endsWith('\\claude');
  if (resumeMatch) {
    s.claudeSessionId = resumeMatch[1];
  } else if (isClaudeAgent && !isWin32 && !isSubcommand && !agentArgs.includes('--session-id') && !agentArgs.includes('--resume')) {
    // Keep one discussion in one transcript across restarts. Within a process
    // the tab reuses its own claudeSessionId; across an app restart a launch
    // continuation (resumeLast) rebinds to the last claude session recorded for
    // this cwd. A brand-new chat gets its own fresh session.
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
      // written: the CLI opens a fresh transcript under a new id. Snapshot the
      // directory so the successor can be identified later.
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
        // treat a missing file as empty.
        let existing = '';
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to cwd
        try { existing = fs.readFileSync(fileAbs, 'utf8'); } catch (_) {}
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to cwd
        fs.writeFileSync(fileAbs, AgentInject.mergeSessionBlock(existing, injectionPlan.body));
      }
    } catch (_) {}
  }

  // Refresh the HUSK-SESSION block in every other managed instruction file that
  // already carries one, since agent CLIs read each other's files (copilot also
  // reads AGENTS.md / GEMINI.md). Only existing files with Husk's markers are
  // touched; nothing is created here.
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
  //            <rawCmd> only when no candidate exists, so a command string
  //            that names no file on disk still runs
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
  // restart-in-place keeps the first launch time.
  if (!s.startedAt) s.startedAt = Date.now();
  lastPtyPid = s.pty.pid;
  // Coalesce PTY output: buffer the chunks a chatty agent emits per tick and
  // flush once per microtask, so the renderer receives one message per burst
  // instead of one IPC send per chunk.
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

// Read the most-recent claude session JSONL for the active PTY cwd and return a
// coarse usage estimate: turn count plus a chars/4 token estimate. The agent
// process owns the real token counter and writes it to usage-cache.json only
// when the framework statusline is wired up.
let _claudeJsonCache = { mtime: 0, data: null };
function readClaudeJson() {
  try {
    const p = path.join(HOME, '.claude.json');
    // Stat and read through one open descriptor.
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

// Per-project trust. Claude Code reads a workspace's saved permissions once the
// folder is trusted (projects[cwd].hasTrustDialogAccepted in ~/.claude.json).
// Husk surfaces this as an explicit, user-initiated "trust this folder" action.
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
    // Stat and read through one open descriptor.
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
// tier suffix already stripped, and null for an unknown family. Claude models
// report their 200K default tier here; the 1M tier is a "[1m]" suffix handled by
// resolveContextWindow. Sources verified 2026-06: Anthropic models reference
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
// records only the bare model id (e.g. "claude-opus-4-8"); the 1M tier is a
// "[1m]" suffix Claude Code persists in ~/.claude.json under
// projects[cwd].lastModelUsage. Prefer an explicit 1M tier, else the family's
// base size, else infer. Claude Code also accepts short aliases in settings.json
// ("opus", "sonnet", "haiku", "opusplan"), which are expanded to a canonical
// family id before matching, tier suffix preserved. Full ids and unknown values
// pass through untouched.
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
    // Recover the tier from Claude Code's usage record. lastModelUsage is
    // written on session end, so check the active project first, then the full
    // history; a model ever run on the 1M tier reports 1M.
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
    // write into one project dir at once, so each tab binds to its own file and
    // keeps reading it until that file disappears.
    const sess = activeSessionId ? sessions.get(activeSessionId) : null;
    let latest = null;
    if (sess && sess.resumedTranscript) {
      // A resumed tab was handed the id of the conversation to continue, and the
      // CLI writes the continuation to a new file. The live file is the one that
      // was not in the directory when this tab spawned, written by an
      // interactive session: hooks and title generators spawn their own sessions
      // into the same directory, so arrival order alone is not enough.
      // Earliest-first among the survivors, since the tab's transcript precedes
      // any agent it goes on to spawn.
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
    // Cap the read. A session JSONL grows for the whole conversation and can
    // reach many megabytes, so read at most the last CAP bytes and drop the
    // first partial line. For large sessions the turn/char numbers become a
    // recent-tail estimate.
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
    // Live context-window occupancy. Claude Code records per-turn token usage on
    // each assistant message; the current context is the most recent assistant
    // turn's input + cache-creation + cache-read tokens.
    let ctxTokens = 0;
    for (const line of raw) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' || obj.type === 'assistant') turns++;
        // The agent records the model on each assistant turn; keep the most
        // recent so a mid-session switch is reflected. Claude Code's
        // "<synthetic>" placeholder (used on resume-injected turns) is skipped.
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
    // Model preference. settings.json holds the model the user selected and is
    // the value the CLI's own picker reports. Transcripts are used for turn
    // counts and occupancy, which are per-file by nature, and for the model only
    // when settings names none.
    const settingsModel = ((readClaudeSettings() || {}).model || '').trim();
    let effModel = settingsModel || model;
    // Model label fallback, DISPLAY ONLY. When neither settings.json nor this
    // tab's own transcript names a model, borrow one from the newest transcript
    // in the project dir just for the label. Occupancy and turn counts above
    // stay tied to this tab's own transcript.
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
    // from it plus the user's model selection. ctxTokens is the real occupancy
    // from claude's own per-turn usage (input + cache_read + cache_creation),
    // read from the latest usage record in the file's tail.
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
ipcMain.handle('pty:start', (_e, { cols, rows, command, cwd, sessionId, resumeLast } = {}) => spawnPty(cols, rows, command || null, cwd || null, sessionId || null, !!resumeLast));
// List the chat PTYs that are still alive, so a reloaded renderer can rebuild
// its tabs and reattach instead of orphaning them and minting a fresh chat.
ipcMain.handle('pty:list', () => {
  const list = [];
  for (const [id, s] of sessions) {
    if (!s.pty) continue;
    // Only mark a claude session resumable when its transcript exists: a chat
    // that exited before writing leaves no .jsonl, and `claude --resume <id>`
    // then reports "No conversation found".
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
// resize to the new viewport and re-mark it active. Used for agents that cannot
// resume a session; claude chats are resumed instead. No scrollback replay: a
// PTY byte stream is terminal-control sequences, not a log.
ipcMain.handle('pty:reattach', (_e, { sessionId, cols, rows, activate } = {}) => {
  const s = sessions.get(sessionId);
  if (!s || !s.pty) return { ok: false, error: 'no live session' };
  // The reloaded terminal is empty and this stream carries no history, so the
  // repaint has to come from the agent. A full-screen agent redraws on SIGWINCH,
  // which the kernel raises only when the size actually changes.
  //
  // Stepping to a neighbouring size and back produces that change. The two steps
  // are separated in time because on Linux the agent runs under `script`, which
  // handles the signal asynchronously and reads whatever the size is by the time
  // it looks. The correct size is what the agent is left sitting at.
  const c = Math.max(2, Number(cols) || 0);
  const r = Math.max(2, Number(rows) || 0);
  if (cols && rows) {
    try { s.pty.resize(c > 2 ? c - 1 : c + 1, r); } catch (_) {}
    setTimeout(() => {
      // The session can close, or be resized again, while the gap elapses.
      const live = sessions.get(sessionId);
      if (live && live.pty) { try { live.pty.resize(c, r); } catch (_) {} }
    }, 60);
  }
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
// The supervisor module owns one autonomous-run lifecycle: snapshot, audit log,
// budget meter, halt-on-cap. main.js wires it through IPC and tracks the active
// runner, so one session id only ever has one run.
//
// Encryption: electron safeStorage wraps the OS keychain APIs (libsecret /
// macOS Keychain / Windows DPAPI). When `isEncryptionAvailable` reports true,
// every snapshot-store and audit-log blob is wrapped with it. On a headless or
// dev build it reports false, blobs are written plain inside the Husk user-data
// dir, and the supervisor reports the run as "trusted-by-rewind".

const Autopilot = require('./lib/autonomy');
const AgentOneShot = require('./lib/agent-oneshot');
const { withAutopilotArgs } = require('./lib/autopilot-args');
const AutopilotStatus = require('./lib/autopilot-status');
const AutopilotQuestion = require('./lib/autopilot-question');
const { applyWorkerChangesToIntegrator, applyWorkersWhenIntegratorEmpty } = require('./lib/autopilot-integrate');
const { groupHistoryRuns } = require('./lib/autopilot-history');
const AuditView = require('./lib/autonomy/audit-view');
const LineStats = require('./lib/autopilot-linestats');
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

const { applyWorktreeChanges, isSafeRelPath: isSafeApplyRelPath } = require('./lib/autopilot-apply');
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
// operator applies or discards it, so the agent's changes stay reviewable. The
// registry is a small JSON file, so retained worktrees survive an app restart
// and each entry names its worktree path and origin workspace.
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

// Startup reconciliation for crash-orphaned worktrees. A crash or force-quit
// during a live run never reaches finishRun, so its worktree is left under
// autopilot-worktrees/ with no retained-runs entry. On startup the runs Map is
// empty, so every worktree dir not in the retained registry is such an orphan: a
// clean one is pruned, and one with real changes is retained so the review UI
// surfaces it. Fully guarded so a reconcile failure never blocks startup.
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

// Parse an agent's own cumulative token counter out of raw PTY output (codex
// "1,234 tokens used", "total tokens: 56k"). Context gauges ("152k/200k tokens")
// and per-turn stream counters ("↓ 1.5k tokens") are not matched: they report
// the loaded window, not consumption.
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
// Generous quiet windows: a run PTY can go byteless for a long stretch during a
// silent tool call (build, test suite) with a static busy marker on screen, so
// these thresholds only trip on runs that are genuinely parked.
const AP_RUN_NUDGE_PAUSE_MS = 45000;
const AP_RUN_IDLE_END_MS = 120000;
const AP_RUN_MAX_NUDGES = 5;
const AP_INTEGRATOR_MAX_NUDGES = 2;
const AP_INTEGRATOR_IDLE_END_MS = 60000;
const AP_RUN_STARTUP_STALL_MS = 180000;

// Agents sometimes paraphrase the completion sentinel ("Goal fully met",
// "audit complete", "Stopping.") instead of printing it verbatim, so a quiet
// agent whose last narration reads as a completion claim finishes the run.
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
// Each run streams its own activity to the renderer, keyed by runId. The primary
// source is the agent's session transcript (jsonl) under the run's worktree
// project dir: structured narration plus authoritative token usage. Agents that
// write no transcript fall back to ANSI-stripped complete lines from the run's
// PTY, deduped per run.
// Project-dir name the agent CLI uses for a cwd's transcripts: every
// non-alphanumeric character becomes a dash, dots included.
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
// {kind: 'thought'|'tool', text}. Assistant text is the agent's live narration;
// tool_use becomes a tool item and updates the run's "current tool" state for
// the fleet strip. Token usage feeds the run's meter.
function runTranscriptEntryToLines(r, obj) {
  const lines = [];
  const msg = obj && obj.message;
  if (!msg || obj.type !== 'assistant') return lines;
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        // Keep the agent's latest narration: it becomes the run conclusion shown
        // in review and is the authoritative surface for the completion
        // sentinel, since the PTY view wraps and decorates lines.
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
        // Feed the governor a stable action signature (tool + target) so it can
        // catch a genuine loop.
        try { r.runner.reportAction(`${part.name}:${actionHash || detail}`); } catch (_) {}
        lines.push({ kind: 'tool', text: `→ ${toolText}`.slice(0, 320) });
      }
    }
  }
  // Pin the meter's billing rate to the model that produced this turn, since the
  // start-time model may be a tier alias. Cheap and idempotent, so feed it every
  // turn.
  if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>'
      && r.runner && typeof r.runner.setModel === 'function') {
    try { r.runner.setModel(msg.model); } catch (_) {}
    r.observedModel = msg.model;
  }
  const usage = msg.usage;
  if (usage) {
    // Exact per-turn usage, fed one tier at a time: fresh input and output at
    // their rates, cache writes at 1.25x input, cache reads at 0.1x input. Cache
    // reads are billed but excluded from the token cap basis inside the meter,
    // so a cap of "200k tokens" means fresh work.
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
  // One handle serves both the size check and the read.
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
      // Rotation guard: the agent starts a fresh jsonl on compaction/clear, so
      // a pinned file that stops growing while a newer sibling exists re-pins to
      // the newer file. Token reporting stays monotonic.
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
  // narrating raw PTY lines, so the two sources never overlap.
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
    // Parity with transcript agents: keep the latest narrative-looking line as
    // the run's last words, so completion-claim detection and the end-of-run
    // final report work for every CLI.
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

// Submission verifier: the injected goal's trailing Enter can be consumed by a
// still-mounting TUI, leaving the goal sitting unsubmitted in the composer. The
// agent writes its session transcript only after a real submit, so transcript
// presence is the submit signal; until it appears, resend a bare Enter every few
// seconds. Idempotent and capped.
function ensureRunGoalSubmitted(runId) {
  const r = runs.get(runId);
  if (!r || r.goalSubmitted || !r.goalInjectedAt) return;
  // Submit-proof: a non-empty transcript. The user message row is written at
  // submit time, so bytes in the file mean the goal went through, while a
  // pre-created empty file keeps the resend loop alive.
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

// Idle watchdog, per run, observing the run's own PTY and transcript rather than
// a chat terminal. While the busy marker is on screen the agent is working. Once
// it has worked and gone quiet without printing the completion sentinel, nudge
// it to continue; after the nudges are spent and it stays quiet, end the run as
// idle.
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
  // CLI-neutral working signal: any PTY bytes in the last few seconds mean the
  // agent is alive (spinners, tool output, repaints). The busy-marker regex is a
  // stronger, earlier signal on top of it.
  if (now - (r.lastPtyDataAt || 0) < 6000) return;
  const workGoneMs = r.workingSeenAt ? now - r.workingSeenAt : Infinity;
  if (workGoneMs < 6000) return;
  // Completion claim: the agent said it is done in plain words and went quiet,
  // so the run finishes as complete. Only the tail of the last message counts,
  // since "task done, moving on to X" mid-message is progress narration.
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

// Per-run output flush: buffer this run's PTY bytes and, once per quarter
// second, append one agent_output audit row (size and timestamp only) and
// re-broadcast the run's budget state so its rings stay live. Char counts are
// audit-only, since the chars/4 estimate is wildly wrong for TUI agents;
// authoritative token counts come from the agent's own status line, parsed here
// from the run's raw output. Past the cap the transcript file is rewritten from
// its second half, so the newest output survives and the file stays bounded.
const RUN_TRANSCRIPT_CAP = 2 * 1024 * 1024;
function appendRunTranscript(r, chunk) {
  let fd = null;
  try {
    const sessionId = r.runner && r.runner.sessionId;
    if (!sessionId) return;
    const file = path.join(autopilotStorageRoot(), 'sessions', String(sessionId), 'transcript.log');
    // One descriptor for the whole append-and-trim, so both act on the same
    // file. A missing session directory turns into the throw this already
    // swallows.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to the run's own session dir
    fd = fs.openSync(file, 'a+');
    fs.appendFileSync(fd, chunk);
    const size = fs.fstatSync(fd).size;
    if (size > RUN_TRANSCRIPT_CAP) {
      const keep = Math.floor(RUN_TRANSCRIPT_CAP / 2);
      const buf = Buffer.alloc(keep);
      fs.readSync(fd, buf, 0, keep, size - keep);
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, buf, 0, keep, 0);
    }
  } catch (_) { /* a convenience file; never break a run over it */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} } }
}

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
  // The audit row carries this chunk's size, not its text, so the chain stays
  // small and every row still hashes over the whole of the one before it. The
  // readable output goes to the transcript beside the audit log, where it
  // survives the run ending, navigating away, and restarting the app.
  appendRunTranscript(r, chunk);
  if (mainWindow) mainWindow.webContents.send('autopilot:budget', {
    runId,
    ...r.runner.budgetState(),
    governor: (typeof r.runner.governorState === 'function') ? r.runner.governorState() : null,
  });
  // Submit-proof for agents without a transcript: the composer echo of an
  // injected goal accounts for roughly its own length in PTY bytes, so sustained
  // output well past that means the agent is answering. Transcript agents get
  // the non-empty-transcript proof in ensureRunGoalSubmitted.
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
  // Busy-marker tracking for the idle watchdog: the marker on screen means the
  // agent is mid-generation or mid-tool, so nudges hold off.
  if (AP_RUN_WORKING_RE.test(clean)) r.workingSeenAt = Date.now();
  // Feed fallback for agents without a transcript (no-op once one exists).
  streamRunPtyLines(runId, clean);
  // Token meter fallback for agents without a structured transcript: scan for
  // the agent's own cumulative counter and keep the running max, since status
  // lines flicker. Once a transcript streams, its per-turn deltas take over.
  if (!r.transcriptPath) {
    let maxTok = -1;
    for (const line of clean.split('\n')) {
      const parsed = parseRunTokenStatus(line);
      if (parsed != null && parsed > maxTok) maxTok = parsed;
    }
    if (maxTok >= 0 && maxTok > (r.maxReportedTokens || 0)) {
      // Plausibility filter on the parsed counter, since this scans the whole
      // output rather than a status-line region. Reject an implausible absolute
      // value or a jump too large to be one run's real growth; the true counter
      // climbs smoothly and re-registers on the next flush.
      const prev = r.maxReportedTokens || 0;
      const ABS_CEIL = 50_000_000;              // above any real single-run cumulative
      const plausible = maxTok <= ABS_CEIL
        && (prev === 0 ? maxTok <= 2_000_000     // first sighting: a context ceiling
                       : maxTok <= prev * 8 + 1_000_000); // later: bounded growth
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
      // Preserve the agent's exit code, which separates a clean quit (0) from a
      // crash (non-zero), so the audit trail records how the agent left.
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
    // The injected text contains the completion sentinel and the TUI echoes
    // pasted text, so timestamp the injection for the PTY sentinel scan.
    r.lastInjectAt = Date.now();
    const body = String(text).replace(/\r/g, ' ').replace(/\n/g, ' ');
    // Submit-proof bookkeeping for agents without a transcript: output volume
    // well beyond the composer echo of this text means the agent is answering
    // (see flushRunOutput).
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
    // A queued run that fails to start is still accounted to its collab group,
    // so the team's remaining-counter keeps moving and the integrator spawns.
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
// unattended, so the agent makes its own decisions and never blocks on input.
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
// One orchestrator call decomposes the goal into 2..K sub-goals, each becoming a
// normal isolated run labeled with its role. When the last worker finishes, an
// integrator run merges every worker worktree into its own, which becomes the
// single Apply target. This tracker is the only dedicated state; everything else
// rides the existing run model the way raceId does.
const collabGroups = new Map(); // groupId -> { goal, caps, snapshot, workspaceRoot, remaining, workers, integratorSpawned }
// Set while the collab orchestrator is planning (before any worker run
// exists), so Stop can cancel that phase instead of reporting no active run.
let activePlanning = null;

function newRunId() {
  return 'ap-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

ipcMain.handle('autopilot:startCollab', async (_e, payload = {}) => {
  // Any throw lands as a visible error in the renderer rather than a rejected
  // invoke.
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
  // The planner runs as a detached child with no entry in `runs`, so track it
  // here and let autopilot:cancel kill it during the 1-2 min plan window.
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
  const vendorBilled = ['copilot', 'codex', 'aider', 'gemini', 'kiro-cli'].includes(agentName);
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
    // stat(size+mtime) per changed file catches repeated edits to the same file,
    // and a stat failure falls back to status. Throttled and guarded so at most
    // one diff walk per run is in flight.
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
        // submission and resend Enter until it does, and arm the idle watchdog
        // now rather than on the first banner bytes.
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
  // Resolve the target run. With an explicit id, cancel exactly that run;
  // without one, fall back only when a single run is active.
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
  // Stop the whole autopilot team: every live run in this run's collab group,
  // queued members that have not started, and the group tracker. Only
  // autopilot-owned run PTYs are touched; chat sessions live elsewhere.
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
// the end-of-run diff, summarize while the worktree still exists, tear down its
// PTY, then retain the worktree and register it for later apply/discard.
// Broadcasts autopilot:ended, guards re-entry via the per-run `finishing` flag,
// and drains the pending queue on exit so a freed slot starts the next run.
// Removal happens only on an explicit apply or discard.
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
    // Retain the worktree for review. A run isolated in the managed root is
    // retained with its diff so Apply/Discard can act later; a run that ran
    // in-place has nothing to retain.
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

// Apply is the only step that leaves the isolated worktree and writes into the
// user's real project, and the worktree is removed right after a successful
// apply. So the destination side is captured before the apply, scoped to exactly
// the paths about to be written. Paths that do not exist yet are recorded as
// absent, which is what lets the undo delete files the run added.
function applyUndoSessionId(sessionId) {
  return `${sessionId}-preapply`;
}

// Returns the undo session id on success, or null when there was nothing to
// capture. A failure is reported to the caller rather than swallowed, so
// applying without a usable undo stays the operator's decision.
function captureApplyUndo(sessionId, workspaceRoot, changes) {
  if (!isSafeAutopilotSessionId(sessionId) || !workspaceRoot) {
    return { ok: false, error: 'run has no session id or workspace root; cannot record an undo point' };
  }
  const undoId = applyUndoSessionId(sessionId);
  if (!isSafeAutopilotSessionId(undoId)) return { ok: false, error: 'invalid undo session id' };
  const paths = (Array.isArray(changes) ? changes : [])
    .map((c) => c && c.path)
    .filter((p) => isSafeApplyRelPath(p) && p !== AutopilotStatus.STATUS_FILE);
  if (!paths.length) return { ok: true, undoId: null };
  const { encrypt } = autopilotCrypto();
  try {
    const res = Autopilot.snapshot.captureSnapshot(
      workspaceRoot, autopilotStorageRoot(), undoId, { paths, encrypt },
    );
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'undo snapshot failed' };
    return { ok: true, undoId };
  } catch (err) {
    return { ok: false, error: `undo snapshot crashed: ${(err && err.message) || String(err)}` };
  }
}

// Apply a retained run's changes into its origin workspace. A complete success
// removes the worktree and registry entry; a partial failure keeps them so the
// unapplied work remains reviewable/retryable.
ipcMain.handle('autopilot:applyRun', async (_e, payload = {}) => {
  const runId = String(payload && payload.runId || '').trim();
  const entry = getRetained(runId);
  if (!entry) return { ok: false, error: 'no retained run with that id' };
  // While a collab team is still active, worker worktrees are the integrator's
  // inputs and the integrator is the intended Apply target. After the group
  // ends, workers become normal retained runs.
  if (entry.groupId && collabGroups.has(entry.groupId) && !entry.isIntegrator) {
    return { ok: false, error: 'this run is part of an active team; wait for the integrator to finish, then apply its result' };
  }
  const undo = captureApplyUndo(entry.sessionId, entry.workspaceRoot, entry.changes || []);
  if (!undo.ok) return { ok: false, runId, applied: [], failed: [], error: `${undo.error}; nothing was applied` };
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
  // A worker's worktree is an integrator input while the team is still live.
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
  const undo = captureApplyUndo(winner.sessionId, winner.workspaceRoot, winner.changes || []);
  if (!undo.ok) return { ok: false, runId, applied: [], failed: [], discarded: 0, error: `${undo.error}; nothing was applied` };
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

// The restore/diff target for a session is the directory the snapshot was
// captured from, recorded in its manifest, so a revert takes its root from
// there rather than from the caller.
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
  const storageRoot = autopilotStorageRoot();
  // Once a run has been applied, the thing to undo is the write into the
  // project. The pre-apply manifest is written only by an apply, so its presence
  // selects it, and it describes the later of the two events.
  const undoId = applyUndoSessionId(sessionId);
  const targetId = Autopilot.snapshot.hasSnapshot(storageRoot, undoId) ? undoId : sessionId;
  const workspaceRoot = manifestWorkspaceRoot(targetId);
  if (!workspaceRoot) return { ok: false, error: 'snapshot manifest has no workspace root; cannot revert safely' };
  // A run whose only manifest names a worktree that Apply removed has nothing to
  // restore into, so say that rather than recreating a directory nobody reads.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- workspaceRoot comes from the manifest, not the caller
  if (!fs.existsSync(workspaceRoot)) {
    return { ok: false, error: 'the directory this snapshot was taken from no longer exists, so there is nothing to revert' };
  }
  const { decrypt } = autopilotCrypto();
  const res = Autopilot.supervisor.revertRun({
    sessionId: targetId,
    workspaceRoot,
    storageRoot,
    decrypt,
    preserveExtras: !!payload.preserveExtras,
  });
  // Tell the renderer which of the two things it just undid.
  return (res && typeof res === 'object')
    ? { ...res, scope: targetId === undoId ? 'apply' : 'run', workspaceRoot }
    : res;
});

// The renderer's terminal snapshot parser reports the agent's own cumulative
// token count here (claude prints "↓ 1.5k tokens" in its status line). It
// overrides the meter's chars/4 estimate and drives cap firing.
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
      let changes = { added: 0, modified: 0, deleted: 0 };
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
              // The recorded diff is the stable one: it describes the workspace
              // as the run left it, so the row's change mix survives later edits.
              changes = { added: 0, modified: 0, deleted: 0 };
              for (const change of (Array.isArray(row.payload.diff) ? row.payload.diff : [])) {
                const kind = change && change.status;
                if (kind === 'added') changes.added += 1;
                else if (kind === 'deleted') changes.deleted += 1;
                else changes.modified += 1;
              }
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
        changes,
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

// Delete a past run: removes its session directory (manifest, audit log and all
// snapshot blobs). Refuses an active run, and the sessionId is validated so the
// recursive remove touches a single session folder under the storage root.
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
  // The resolved target sits directly under the sessions root and is not the
  // root itself.
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
  // The run's files live in its own worktree, so the workspace resolves from the
  // session record (manifest, else the run_identity audit row) rather than from
  // the caller, which carries the origin project as a label. The caller value is
  // a fallback for legacy sessions with no recorded root.
  const workspaceRoot = manifestWorkspaceRoot(sessionId)
    || String(payload && payload.workspaceRoot || '').trim();
  if (!workspaceRoot) return { ok: false, error: 'no workspace recorded for this session' };
  // Confines the resolved file to the workspace.
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
      if (!realPathInside(safeAbs, safeWorkspace)) {
        return { ok: false, error: 'path escapes workspace' };
      }
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
  // Diff the recorded workspace rather than a caller-supplied path, using the
  // async walker so loading a past run from history does not freeze the UI.
  const workspaceRoot = manifestWorkspaceRoot(sessionId);
  return Autopilot.supervisor.summarizeRunAsync({
    sessionId,
    workspaceRoot,
    storageRoot: autopilotStorageRoot(),
    decrypt,
  });
});

// Read-only page of the hash-chained audit log for one session, projected into
// the four columns the audit table paints. The whole log is parsed to tally the
// filter chips, and only the requested page crosses the bridge, newest first.
const AUDIT_PAGE_MAX = 200;
ipcMain.handle('autopilot:auditEvents', async (_e, payload = {}) => {
  const sessionId = String(payload && payload.sessionId || '').trim();
  if (!sessionId) return { ok: false, error: 'sessionId required' };
  if (!isSafeAutopilotSessionId(sessionId)) return { ok: false, error: 'invalid sessionId' };
  const storageRoot = autopilotStorageRoot();
  const { decrypt } = autopilotCrypto();
  const read = Autopilot.audit.readAuditLog(storageRoot, sessionId, { decrypt });
  if (!read.ok) return { ok: false, error: read.error };
  const records = Array.isArray(read.records) ? read.records : [];
  const kinds = AuditView.auditKindCounts(records);
  const wantKind = String(payload && payload.kind || '').trim();
  const matching = wantKind ? records.filter((r) => r && r.kind === wantKind) : records;
  const limit = Math.min(Math.max(Math.floor(Number(payload && payload.limit) || 50), 1), AUDIT_PAGE_MAX);
  const events = matching
    .slice(Math.max(0, matching.length - limit))
    .reverse()
    .map((r) => AuditView.projectAuditRow(r));
  const chain = Autopilot.audit.verifyAuditChain(storageRoot, sessionId);
  return {
    ok: true,
    events,
    total: records.length,
    filtered: matching.length,
    kinds,
    chain: { valid: !!chain.valid, brokenAtIndex: chain.brokenAtIndex },
  };
});

// Read-only line-count deltas for finished runs, one entry per session the
// caller names. A session whose recorded workspace is gone reports null, so a
// row shows the counts it can stand behind and nothing else.
const RUN_STATS_MAX_SESSIONS = 12;
const RUN_STATS_MAX_FILES = 200;
const RUN_STATS_MAX_BYTES = 512 * 1024;
ipcMain.handle('autopilot:runStats', async (_e, payload = {}) => {
  const ids = (Array.isArray(payload && payload.sessionIds) ? payload.sessionIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && isSafeAutopilotSessionId(id))
    .slice(0, RUN_STATS_MAX_SESSIONS);
  if (!ids.length) return { ok: false, error: 'sessionIds required' };
  const storageRoot = autopilotStorageRoot();
  const { decrypt } = autopilotCrypto();
  const stats = {};
  for (const sessionId of ids) {
    stats[sessionId] = null;
    const workspaceRoot = manifestWorkspaceRoot(sessionId);
    if (!workspaceRoot) continue;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- workspaceRoot comes from the session record
      if (!fs.existsSync(workspaceRoot)) continue;
    } catch (_) { continue; }
    let manifest = null;
    try {
      const manifestPath = path.join(storageRoot, 'sessions', sessionId, 'snapshot.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to the storage root
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) { manifest = null; }
    let changes = [];
    try {
      const diff = await Autopilot.snapshot.diffWorkspaceAsync(workspaceRoot, storageRoot, sessionId);
      changes = (diff && diff.ok && Array.isArray(diff.changes)) ? diff.changes : [];
    } catch (_) { changes = []; }
    const out = LineStats.emptyRunStats();
    if (changes.length > RUN_STATS_MAX_FILES) out.truncated = true;
    const safeWorkspace = path.resolve(workspaceRoot);
    for (const change of changes.slice(0, RUN_STATS_MAX_FILES)) {
      const rel = change && typeof change.path === 'string' ? change.path : '';
      if (!rel) continue;
      const abs = path.resolve(safeWorkspace, rel);
      if (!(abs === safeWorkspace || abs.startsWith(safeWorkspace + path.sep))) continue;
      let before = '';
      let after = '';
      let skipped = false;
      const entry = manifest && manifest.entries && manifest.entries[rel];
      if (entry && entry.type === 'file' && /^[a-f0-9]{64}$/.test(entry.sha || '')) {
        try {
          const blobPath = path.join(storageRoot, 'sessions', sessionId, 'blobs', entry.sha);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to the storage root
          let buf = await fs.promises.readFile(blobPath);
          if (typeof decrypt === 'function') { try { buf = decrypt(buf); } catch (_) {} }
          if (buf.length > RUN_STATS_MAX_BYTES) skipped = true;
          else before = buf.toString('utf8');
        } catch (_) { skipped = true; }
      }
      if (change.status !== 'deleted') {
        try {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to the workspace above
          const buf = await fs.promises.readFile(abs);
          if (buf.length > RUN_STATS_MAX_BYTES) skipped = true;
          else after = buf.toString('utf8');
        } catch (_) { skipped = true; }
      }
      if (skipped) { out.truncated = true; continue; }
      LineStats.addFileDelta(out, change.status, LineStats.lineDelta(before, after));
    }
    stats[sessionId] = out;
  }
  return { ok: true, stats };
});

// Read back the transcript written during a run. Bounded by the caller so a
// review panel never pulls two megabytes into the renderer at once; the tail is
// what a human reads, so that is what is returned.
ipcMain.handle('autopilot:transcript', async (_e, payload = {}) => {
  const sessionId = String((payload && payload.sessionId) || '').trim();
  // A session id starts with an alphanumeric and carries only [A-Za-z0-9._-].
  if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return { ok: false, error: 'bad sessionId' };
  const maxBytes = Math.min(Math.max(Number(payload.maxBytes) || 262144, 4096), 1048576);
  try {
    const file = path.join(autopilotStorageRoot(), 'sessions', sessionId, 'transcript.log');
    // Resolve both sides and require the file to sit under sessions/. The real
    // path is used where there is something to resolve, and the lexical form
    // where there is not.
    const sessionsRoot = path.join(autopilotStorageRoot(), 'sessions');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are built from the storage root
    const realOf = (target) => { try { return fs.realpathSync(target); } catch (_) { return path.resolve(target); } };
    const realRoot = realOf(sessionsRoot);
    const realFile = realOf(file);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
      return { ok: false, error: 'bad sessionId' };
    }
    // The run may still be appending, so the size comes from the descriptor.
    let fd;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to sessions/ above
    try { fd = fs.openSync(file, 'r'); } catch (_) {
      return { ok: true, text: '', bytes: 0, truncated: false };
    }
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, size - len));
      return { ok: true, text: buf.toString('utf8'), bytes: size, truncated: size > len };
    } finally { try { fs.closeSync(fd); } catch (_) {} }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// Fleet Receipt: aggregate a set of finished runs into one shareable summary
// (total spend, what landed, and the waste the governor caught). The renderer
// passes the fleet it launched as [{ sessionId, agent, model }]; each run is
// summarized from its own audit log and folded into the receipt. Pure
// aggregation lives in autonomy/receipt.
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
  return { exe, base, args: tokens.slice(1) };
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

function runKiroModelProbe(agentCommand) {
  return new Promise((resolve) => {
    const head = safeAgentCommandHead(agentCommand);
    if (!head) return resolve({ ok: false, output: '', error: 'active agent is not supported for model discovery' });
    const env = Object.assign(buildAgentEnv(), { NO_COLOR: '1', HUSK_MODEL_PROBE: '1' });
    const exe = resolveAgentExe(head.exe, env.PATH);
    const args = [...(head.args || [])];
    if (!args.length || String(args[0]).startsWith('-')) args.unshift('chat');
    args.push('--list-models', '--format', 'json');
    let child;
    try {
      child = spawn(exe, args, {
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
    }, Math.min(MODEL_PROBE_TIMEOUT_MS, 8000));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => done({ ok: false, output, error: (err && err.message) || String(err) }));
    child.on('close', () => done({ ok: output.trim().length > 0, output, error: output.trim() ? '' : 'model list exited with no output' }));
  });
}

// What the CLI itself calls a model, taken from the catalog its own /model
// picker produced. The catalog carries the provider's own wording, so a model
// Husk has never heard of arrives correctly named the day it ships, where an
// alias like "opus[1m]" would otherwise read as a bare "Opus".
//
// Returns '' for a full versioned id such as claude-opus-5, whose id-derived
// name is already right, and '' before the catalog has been read. Both cases
// leave the id-derived name in place.
function catalogModelLabel(id, command = null) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const head = safeAgentCommandHead(command || config.agentCommand || 'claude');
  if (!head) return '';
  const cached = modelCatalogCache.get(`${head.base}:${head.exe}`);
  const live = cached && cached.value && Array.isArray(cached.value.models) ? cached.value.models : null;
  // The live catalog exists only once something has driven the CLI's picker in a
  // terminal, so fall back to the names already known for this vendor rather
  // than spawning the agent binary to title a row.
  const models = (live && live.length) ? live : fallbackModelsFor(head.base);
  if (!models || !models.length) return '';
  // Compare with the context tier and vendor prefix removed, so "opus[1m]",
  // "opus" and "claude-opus-5" all reach the same catalog row.
  const key = (s) => String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/^claude-/, '');
  const want = key(raw);
  const hit = models.find((m) => key(m.value) === want);
  if (!hit) return '';
  // Catalog labels read "Opus 5 With 1M Context · Best for everyday use". The
  // panel wants the model's name: not the blurb, and not the context tier, which
  // it reports on its own row. The dropdown keeps the full wording.
  return String(hit.label || '').split('·')[0]
    .replace(/\bwith\s+1m\s+context\b/ig, '')
    .replace(/\(1m context\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function discoverModelCatalog({ refresh = false, command = null, fast = false } = {}) {
  // `command` lets a caller ask for a specific vendor's models, since a workflow
  // step can run a different agent than the active one. Falls back to the active
  // agent when omitted.
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
  // takes seconds. Callers use fast for the dropdown and pass refresh only on an
  // explicit reload.
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
    : (vendor === 'kiro-cli' ? await runKiroModelProbe(rawCommand) : await runSlashModelProbe(rawCommand, vendor));
  const probeOutput = probe.output || '';
  const authBlocked = (vendor === 'copilot' && /not logged in to select a model|use \/login to authenticate/i.test(probeOutput))
    || (vendor === 'kiro-cli' && /not logged in|opening browser|kiro-cli login/i.test(probeOutput));
  const partialCopilotCatalog = vendor === 'copilot' && !/Model\b[\s\S]{0,80}\bReasoning/i.test(probeOutput);
  const liveModels = (authBlocked || partialCopilotCatalog) ? [] : parseModelCatalog(probeOutput, vendor);
  const savedModels = savedRoutingModels(vendor);
  const fallbackModels = (!liveModels.length && !authBlocked) ? fallbackModelsFor(vendor) : [];
  const models = uniqueModels([...liveModels, ...fallbackModels, ...savedModels]);
  const value = Object.assign(base, {
    models,
    source: liveModels.length ? (vendor === 'aider' || vendor === 'kiro-cli' ? 'list-models' : 'slash-model') : (fallbackModels.length ? 'fallback' : (savedModels.length ? 'saved' : 'none')),
    sourceLabel: liveModels.length
      ? (vendor === 'aider' ? 'Read from aider --list-models' : (vendor === 'kiro-cli' ? 'Read from kiro-cli chat --list-models' : 'Read from /model'))
      : (fallbackModels.length ? 'Known provider catalog' : (savedModels.length ? 'Saved selections' : 'No models discovered')),
    error: (liveModels.length || fallbackModels.length) ? '' : (authBlocked
      ? (vendor === 'kiro-cli' ? 'Kiro requires login before it will list models.' : 'Copilot requires login before it will list models.')
      : (partialCopilotCatalog ? 'Copilot model picker did not finish loading. Refresh models to retry.' : ((probe && probe.error) || 'No models were found in the provider output.'))),
  });
  modelCatalogCache.set(cacheKey, { cachedAt: Date.now(), value });
  return value;
}

ipcMain.handle('models:list', async (_e, opts = {}) => discoverModelCatalog({ refresh: !!(opts && opts.refresh), fast: !!(opts && opts.fast), command: opts && opts.command ? String(opts.command) : null }));

// ─── Config IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => ({ ...config }));
// Config keys the renderer may not write.
const CONFIG_KEYS_MAIN_OWNS = new Set(['statuslineTrust']);

ipcMain.handle('config:set', (_e, partial) => {
  const incoming = {};
  for (const key of Object.keys(partial || {})) {
    if (!CONFIG_KEYS_MAIN_OWNS.has(key)) incoming[key] = partial[key];
  }
  const paiChanged = Object.prototype.hasOwnProperty.call(incoming, 'paiEnabled')
    && incoming.paiEnabled !== config.paiEnabled;
  config = { ...config, ...incoming };
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
// first-launch wizard can show which ones are installed. Cheap synchronous PATH
// walk, no subprocess. On Windows PATHEXT (.cmd, .bat, .exe) is walked too,
// because npm-installed CLIs land as <name>.cmd shims and Win32 file lookup does
// not auto-append PATHEXT.
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
  {
    id: 'kiro-cli', label: 'Kiro CLI', command: 'kiro-cli',
    docs: 'https://kiro.dev',
  },
];

// loginShellPath() returns the PATH a login+interactive shell produces, which
// sources .profile/.bashrc and so includes ~/.local/bin, nvm, and the like. A
// GUI/desktop launch inherits a stripped PATH, so a bare process.env.PATH check
// misreports CLIs installed in ~/.local/bin as missing. Cached: one subprocess
// for the whole session. Returns '' on win32 or on failure.
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

// extraAgentBinDirs() are user-install locations a GUI/desktop launch's PATH
// omits and a login shell does not reliably restore (bash login shells read
// .bash_profile, not .profile/.bashrc). These are the same dirs the agent spawn
// force-prepends, so "FOUND" in the wizard implies the spawn resolves the CLI.
function extraAgentBinDirs() {
  if (process.platform === 'win32') return [];
  return [path.join(HOME, '.local', 'bin'), path.join(HOME, '.bun', 'bin')];
}

// Absolute path of a command on PATH, or null.
function resolveOnPath(binName) {
  const isWin = process.platform === 'win32';
  // Union of the inherited PATH, the login-shell PATH (nvm/pyenv), and the known
  // user-install dirs, deduped in order.
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
        if (isWin) return p;
        if (st.mode & 0o111) return p;
      } catch (_) {}
    }
  }
  return null;
}

function isOnPath(binName) {
  return resolveOnPath(binName) !== null;
}

// On Windows, resolves a bare command name to its absolute path on PATH.
// Returns the name unchanged on POSIX, or when it is not found.
function spawnName(binName) {
  if (process.platform !== 'win32') return binName;
  return resolveOnPath(binName) || binName;
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
      // spawn looks the tool up via PATH, with PATHEXT resolution on Windows.
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
// ~/.claude.json's `mcpServers` object is the source of truth (Claude Code's
// user-scoped MCP config). A disabled entry moves to a Husk-private key
// `_huskMcpDisabled`, so a toggle hides it from claude and keeps the config.
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

// ─── Per-project MCP selection ──────────────────────────────────────────────
// The global list above says which servers exist; this says which of them a
// given folder runs. Husk stores the mapping itself rather than using any one
// CLI's project scope, because the CLIs disagree on whether they have one and
// none of them can subtract a global server for a single folder.

const ProjectMcp = require('./lib/project-mcp');

const projectMcpDir = () => path.join(app.getPath('userData'), 'project-mcp');

// The effective set for one folder, plus per-server provenance for the UI.
function resolveProjectMcp(cwd) {
  const servers = (() => {
    try {
      const r = SharedMcp.list(config.agentCommand, { sync: false });
      return (r && Array.isArray(r.servers)) ? r.servers : [];
    } catch (_) { return []; }
  })();
  return ProjectMcp.resolveEffective(servers, ProjectMcp.overridesFor(config.projectMcp, cwd));
}

// Flags that pin one launch to the folder's resolved set. Writes the config
// file the flags point at when the CLI needs one.
function projectMcpLaunchArgs(agentExe, cwd, existingArgs) {
  try {
    const resolved = resolveProjectMcp(cwd);
    if (!resolved.customized) return [];
    const forFile = ProjectMcp.serversForConfigFile(agentExe, resolved);
    const configFile = forFile.length ? ProjectMcp.writeConfigFile(projectMcpDir(), cwd, forFile) : null;
    return ProjectMcp.buildLaunchArgs({ agentExe, resolved, configFile, existingArgs });
  } catch (_) { return []; }
}

ipcMain.handle('projectMcp:get', (_e, cwd) => {
  const resolved = resolveProjectMcp(cwd);
  return {
    ok: true,
    path: ProjectMcp.normalizeProjectPath(cwd),
    rows: resolved.rows,
    effective: resolved.servers.map((s) => s.id),
    customized: resolved.customized,
    // Tells the UI whether the active CLI can honor a per-folder set at all.
    supported: !!ProjectMcp.agentKind(config.agentCommand),
  };
});

ipcMain.handle('projectMcp:set', (_e, payload = {}) => {
  const { path: cwd, id, state } = payload;
  const key = ProjectMcp.normalizeProjectPath(cwd);
  if (!key) return { ok: false, error: 'No project path' };
  if (!id) return { ok: false, error: 'No server id' };
  const map = { ...(config.projectMcp || {}) };
  const entry = { ...(map[key] || {}) };
  // Inherit is the absence of an entry, so the folder keeps following the
  // global list instead of pinning today's value forever.
  if (state === ProjectMcp.STATE_ON || state === ProjectMcp.STATE_OFF) entry[id] = state;
  else delete entry[id];
  if (Object.keys(entry).length) map[key] = entry;
  else delete map[key];
  config = { ...config, projectMcp: map };
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('projectMcp:clear', (_e, cwd) => {
  const key = ProjectMcp.normalizeProjectPath(cwd);
  if (!key) return { ok: false, error: 'No project path' };
  const map = { ...(config.projectMcp || {}) };
  delete map[key];
  config = { ...config, projectMcp: map };
  saveConfig(config);
  return { ok: true };
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

// Resolve the active agent CLI's version by running `<cmd> --version`, using the
// agent spawn env so the command resolves against the user's real PATH. Every
// result (including empty) is cached, so each CLI is probed at most once per app
// session rather than on every stats poll.
const _agentVersionCache = {};
function getAgentVersion(cmd) {
  if (cmd in _agentVersionCache) return _agentVersionCache[cmd];
  let v = '';
  try {
    const out = require('child_process').execFileSync(cmd, ['--version'], { timeout: 4000, encoding: 'utf8', env: buildAgentEnv() });
    const m = String(out).match(/\d+\.\d+(?:\.\d+)?/);
    v = m ? m[0] : String(out).trim().split('\n')[0].slice(0, 40);
  } catch (_) { v = ''; }
  _agentVersionCache[cmd] = v;
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
// <COPILOT_HOME>/session-state/<uuid>/events.jsonl: the live model (from
// session.model_change), the turn count, and the summed output tokens. Copilot
// logs no input/context-window totals, so ctxTokens/ctxWindow stay 0 and the
// panel omits the Context Window row. Picks the newest session whose workspace
// cwd matches the active chat's cwd.
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
    // Open once and size/read through the same descriptor. On a huge transcript
    // keep only the trailing CAP bytes.
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
  // The model, per-session context and plan-usage caches come from ~/.claude
  // state and describe the Claude CLI only, so they are read solely when the
  // active agent is claude.
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
      // Session model/turns read from each agent's own transcript, so the figure
      // belongs to the active agent: claude from ~/.claude, copilot from
      // ~/.copilot.
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
        // The directory's own mtime is when its files were written, i.e. the
        // install. Enabling or disabling renames the directory, and a rename
        // touches the parent rather than the entry.
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
// Runs outlive the process, so a workflow can report how its last run went.
const WORKFLOW_RUNS_PATH = path.join(CONFIG_DIR, 'workflow-runs.json');
const WF_RUNS_MAX = 200;
// Only the newest runs keep their step output, so a long history does not turn
// into a log archive on disk.
const WF_RUNS_WITH_LOGS = 20;
const WF_STEP_LOG_CHARS = 12000;

function loadWorkflows() {
  try {
    if (!fs.existsSync(WORKFLOWS_PATH)) return [];
    // The Array.isArray guard matches loadWorkflowRuns below: anything that
    // parses to a non-array reads as an empty list, so the workflows page shows
    // an empty grid the user can rebuild from.
    const list = JSON.parse(fs.readFileSync(WORKFLOWS_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
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
        // Whether the per-step timer killed this step, recorded as a fact rather
        // than inferred later from a duration near the timeout.
        timedOut: st.timedOut === true,
        // The vendor's own token report for this step, kept verbatim. Only
        // claude is run with stream-json, so this is absent for other agents
        // and the receipt says so.
        usage: st.usage || null,
        entries,
        truncated: entries.length < log.entries.length,
      };
    });
    const failed = steps.find((st) => st.status === 'failed');
    // The fingerprint of the graph as it ran, not as it stands now: a receipt
    // names the program it was earned on, and a workflow with an edited step is
    // a different program under the same id. Recomputed here rather than read
    // from the artifact, because a locally authored workflow has none.
    let graphHash = null;
    try {
      const h = WorkflowArtifact.graphHash(workflow.graph);
      if (h && h.ok) graphHash = h.hash;
    } catch (_) { /* a graph we cannot fingerprint still gets its history row */ }
    // The machine these steps ran on, recorded now rather than assembled at
    // publish time: the agents the graph named, the platform, and the Husk that
    // drove it. agentResolved is a single name because the schema holds it to
    // one, so it records the agent that ran the most steps while
    // requires.agentCommands lists them all.
    const agentCounts = new Map();
    for (const n of nodes) {
      const base = AgentOneShot.agentBaseName(n.agentCommand || config.agentCommand || 'claude');
      if (base) agentCounts.set(base, (agentCounts.get(base) || 0) + 1);
    }
    const agentResolved = [...agentCounts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
    let environment = null;
    try {
      // git decides, not the presence of a .git entry: a directory can carry an
      // empty .git and not be a repository. Failing the question means this is
      // not a work tree, which makes both fields below true.
      let vcs = 'none';
      let tracked = '0';
      if (run.cwd) {
        const git = (args) => require('child_process').execFileSync('git', args, {
          cwd: run.cwd, encoding: 'utf8', timeout: 4000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
        try {
          if (String(git(['rev-parse', '--is-inside-work-tree']) || '').trim() === 'true') {
            vcs = 'git';
            // Bucketed, never exact: a reader only needs to know whether this
            // ran against something their size.
            const n = String(git(['ls-files']) || '').split('\n').filter(Boolean).length;
            tracked = n === 0 ? '0'
              : n <= 100 ? '1-100'
                : n <= 1000 ? '100-1k'
                  : n <= 10000 ? '1k-10k'
                    : n <= 100000 ? '10k-100k' : '100k+';
          }
        } catch (_) { /* not a work tree, or no git: the defaults above are the honest answer */ }
      }
      environment = {
        agentResolved: agentResolved ? agentResolved[0] : 'claude',
        // Left empty rather than guessed: Husk does not ask the CLI its version.
        agentVersion: '',
        os: process.platform,
        huskVersion: app.getVersion(),
        workspace: { vcs, trackedFiles: tracked, languages: [] },
      };
    } catch (_) {
      // Anything that could not be measured means no environment block at all,
      // so the receipt carries one fewer author claim.
      environment = null;
    }
    const entry = {
      id: run.id,
      workflowId: run.workflowId,
      graphHash,
      environment,
      // Which session under the autonomy storage root holds this run's chained
      // log, or null for a run with none. The publisher reads this to find the
      // rows it may attach; a row without it stays author-stated.
      auditSessionId: (run.audit && run.audit.sessionId) || null,
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
    wfPruneRunLogs(trimmed);
  } catch (_) { /* history is a nicety; never fail a run over it */ }
}

// Drop the log directories of runs the history no longer holds.
//
// The history is capped at WF_RUNS_MAX and the logs are not, so this keeps the
// two in step: a run that fell off the end of the list can no longer be
// published from.
//
// Only directories whose name is exactly the `run-<digits>` shape this feature
// mints are considered, so an autopilot session (`auto-<base36>-<hex>`) is never
// a candidate. And only a bounded number go per call, since this runs at the end
// of a run on the main thread.
const WF_LOG_PRUNE_MAX = 16;
const WF_RUN_SESSION_RE = /^run-[0-9]{1,20}$/;

function wfPruneRunLogs(history) {
  try {
    const keep = new Set();
    for (const row of history) {
      if (row && typeof row.auditSessionId === 'string') keep.add(row.auditSessionId);
    }
    const sessionsRoot = path.join(autopilotStorageRoot(), 'sessions');
    let entries;
    try { entries = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch (_) { return; }
    let removed = 0;
    for (const entry of entries) {
      if (removed >= WF_LOG_PRUNE_MAX) break;
      if (!entry.isDirectory()) continue;
      if (!WF_RUN_SESSION_RE.test(entry.name)) continue;
      if (keep.has(entry.name)) continue;
      try {
        fs.rmSync(path.join(sessionsRoot, entry.name), { recursive: true, force: true });
        removed += 1;
      } catch (_) { /* a directory we cannot remove is not worth a second attempt */ }
    }
  } catch (_) { /* pruning is housekeeping; it never costs a run its history */ }
}

// Write through a temp file and rename, so a crash mid-write leaves the previous
// file intact: rename is atomic within a filesystem.
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
// figure. Claude bills per token only when ANTHROPIC_API_KEY is set; otherwise
// the run goes through a subscription, a flat monthly fee with usage limits. The
// other CLIs are metered by their own account, which Husk cannot see.
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

    const child = require('child_process').spawn(cmd, AgentOneShot.oneShotArgs(cmd, prompt), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildAgentEnv(),
    });

    // Hard timeout. The spawn `timeout` option is unreliable when the CLI
    // catches SIGTERM, so force-kill with SIGKILL and resolve regardless.
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

// The single place a workflow record is minted. Installing an imported artifact
// goes through this function rather than around it, so the field list below
// stays the only shape that reaches workflows.json. That is what lets an
// artifact's own requires and receipts blocks live in a sidecar file keyed on
// the id this returns, instead of widening every write path to carry them.
function createWorkflowRecord(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const validTriggers = ['manual', 'ai-suggested'];
  const entry = {
    id,
    name: String(p.name || 'New Workflow').slice(0, 80),
    description: String(p.description || '').slice(0, 256),
    graph: sanitizeGraph(p.graph),
    trigger: validTriggers.includes(p.trigger) ? p.trigger : 'manual',
    // Where this workflow came from, stated on the record rather than inferred
    // from whether a sidecar row can be found. A row can be absent in three
    // ways: a duplicate carries every prompt, an install can finish with its row
    // never reaching disk, and an unreadable store answers for every workflow at
    // once.
    //
    // Only workflows:install passes 'imported'. An artifact's fields are
    // projected onto an allowlist long before they arrive here, and
    // workflows:update carries its own whitelist which omits this.
    origin: p.origin === 'imported' ? 'imported' : 'local',
    createdAt: now,
    updatedAt: now,
  };
  saveWorkflows([...loadWorkflows(), entry]);
  return entry;
}

ipcMain.handle('workflows:create', (_e, payload = {}) => createWorkflowRecord(payload));

// Duplicating carries the origin and drops the consent.
//
// The row travels, so the copy is still a stranger's work, and consentedAt is
// null, so the reader confirms it once on its own terms. The decision lives here
// rather than in the renderer so every caller gets it.
ipcMain.handle('workflows:duplicate', (_e, payload = {}) => {
  const sourceId = String((payload && payload.workflowId) || '').trim();
  if (!sourceId) return { ok: false, error: 'workflowId required' };
  const source = loadWorkflows().find((w) => w && w.id === sourceId);
  if (!source) return { ok: false, error: 'no workflow with that id' };

  const migrated = migrateWorkflow(source);
  const copy = createWorkflowRecord({
    name: `${migrated.name || 'Workflow'} copy`.slice(0, 80),
    description: migrated.description,
    graph: migrated.graph,
    trigger: migrated.trigger,
    // Carried on the record as well as through the sidecar copy below, because
    // the sidecar copy depends on the source's row being readable and this does
    // not.
    origin: migrated.origin === 'imported' ? 'imported' : 'local',
  });

  const row = sidecarFor(sourceId);
  if (row && row.origin === 'imported') {
    writeSidecar({
      workflowId: copy.id,
      origin: 'imported',
      artifact: row.artifact || null,
      boundCwd: row.boundCwd || null,
      installedAt: row.installedAt || null,
      consentedAt: null,
    });
  }
  return { ok: true, workflow: copy, sidecar: sidecarFor(copy.id) };
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
  // The sidecar row goes with the workflow, so a row never outlives the workflow
  // it describes and cannot be inherited by a later id.
  pruneSidecarStore();
  return { ok: true };
});

// Tidy coordinates for a graph, computed from its shape alone: columns by
// depth, branches stacked, columns centred. Pure and read-only — the caller
// decides whether the result is ever saved.
ipcMain.handle('workflows:layout', (_e, payload = {}) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  try {
    return { ok: true, graph: layoutGraph(p.graph) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'layout failed' };
  }
});

// opts is the second argument and carries the run's working directory. An
// imported workflow must have one. Locally authored workflows pass opts nothing
// and keep wfRunStep's own fallback chain.
ipcMain.handle('workflows:run', (event, workflowId, opts = {}) => {
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

  // The gate runs against the directory as it is right now rather than as it was
  // at install time, and the probes are three syscalls.
  const sidecar = sidecarFor(workflowId);
  const requested = (opts && typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : null;
  const boundCwd = requested || (sidecar && sidecar.boundCwd) || null;
  const resolvedCwd = boundCwd ? path.resolve(boundCwd) : null;
  const gate = WorkflowInstall.runGateDecision(Object.assign(
    {
      sidecar,
      cwd: resolvedCwd,
      // The record's own account of where it came from, and whether the store
      // that would hold its consent row could be read. Together these separate
      // "locally authored" from "imported, and the row is missing".
      recordOrigin: workflow.origin === 'imported' ? 'imported' : 'local',
      storeUnreadable: loadSidecarStore().unreadable === true,
    },
    wfxDirFacts(resolvedCwd),
  ));
  if (!gate.ok) {
    return { ok: false, error: gate.message, code: gate.code, message: gate.message, detail: gate.detail, workflowId };
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
    // null for a locally authored workflow, which is what keeps wfRunStep's
    // own fallback chain in play for everything with no bound directory.
    cwd: gate.cwd,
    // Whether the instructions this run executes were written by somebody else.
    // Read once here, where the sidecar is already in hand for the consent gate,
    // rather than per step: the answer holds for the whole run. Either source is
    // enough, so a duplicate of an imported workflow keeps the same answer.
    untrusted: workflow.origin === 'imported' || !!(sidecar && sidecar.origin === 'imported'),
  };
  activeRuns.set(runId, runState);
  executeWorkflow(event, workflow, runState);
  return { ok: true, runId, cwd: gate.cwd };
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

// Re-attach to a run already in flight, since the renderer can be reloaded, or
// the user can navigate away and back, while the agent keeps working in the main
// process.
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

// ─── Portable workflows ───────────────────────────────────────────────────────
//
// A workflow becomes one .husk.json you can commit, and someone else's file
// shows you exactly what it will run on your machine before you press Run.
// This section owns the four things that need the main process: writing a file
// out, reading a file in, checking what that file needs against this machine,
// and gating a run.
//
// Everything inside the file, including its own graphHash and receipts, was
// written elsewhere. Every check lives in src/lib/workflow-artifact.js where it
// is unit tested against deliberately awkward fixtures, and nothing here
// re-implements one: this file supplies the syscalls those checks are about and
// hands the results to pure functions.
//
// Two rules the handlers below keep.
//
// No value from a manifest reaches mcp:add, mcp:addMany or mcp:parseSnippet on
// any code path. requires.mcpServers carries a name, an optional fingerprint and
// a boolean and nothing else. The preflight's fix affordance is a label the
// renderer turns into a click that opens the empty MCP form.
//
// Every read of a cloned tree is confined, and every path component of it is
// lstat-ed.

const WorkflowArtifact = require('./lib/workflow-artifact');
const WorkflowReceipt = require('./lib/workflow-receipt');
const WorkflowInstall = require('./lib/workflow-install');

// One row per workflow that came from a file, keyed on the local workflow id.
// Deliberately a separate file from workflows.json: see createWorkflowRecord
// above for why the record's field whitelist must never widen to hold this.
const WORKFLOW_ARTIFACTS_PATH = path.join(CONFIG_DIR, 'workflow-artifacts.json');

// Bounds on walking a cloned repository, in three directions at once: how deep
// the walk goes, how many entries it looks at in total, and how many candidates
// it collects.
const WFX_SCAN_DEPTH = 3;
const WFX_SCAN_ENTRIES = 4000;
const WFX_MAX_CANDIDATES = 32;
const WFX_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'vendor', 'target']);

function loadSidecarStore() {
  try {
    if (!fs.existsSync(WORKFLOW_ARTIFACTS_PATH)) return WorkflowInstall.normalizeStore(null);
    return WorkflowInstall.normalizeStore(JSON.parse(fs.readFileSync(WORKFLOW_ARTIFACTS_PATH, 'utf8')));
  } catch (_) {
    // An unreadable store is not the same answer as a readable empty one, so it
    // says which it is. It degrades to empty rather than throwing, since taking
    // the workflows page down over this one file is its own kind of outage, and
    // the run gate treats a record that calls itself imported with no readable
    // row as a refusal.
    const empty = WorkflowInstall.normalizeStore(null);
    empty.unreadable = true;
    return empty;
  }
}

function saveSidecarStore(store) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeJsonAtomic(WORKFLOW_ARTIFACTS_PATH, WorkflowInstall.normalizeStore(store));
    return true;
  } catch (_) { return false; }
}

function sidecarFor(workflowId) {
  if (typeof workflowId !== 'string' || !workflowId) return null;
  const store = loadSidecarStore();
  return Object.prototype.hasOwnProperty.call(store.rows, workflowId) ? store.rows[workflowId] : null;
}

// Returns the row on success and null when it did not reach disk, so a caller
// can tell a recorded install from one whose row failed to persist.
function writeSidecar(row) {
  if (!row || !row.workflowId) return null;
  const store = loadSidecarStore();
  store.rows[row.workflowId] = row;
  return saveSidecarStore(store) ? row : null;
}

// Called after any workflow disappears, so a row never outlives the workflow it
// describes. Duplicating is handled by workflows:duplicate, which copies the row
// and clears its consent.
function pruneSidecarStore() {
  try {
    const live = loadWorkflows().map((w) => w && w.id).filter((id) => typeof id === 'string');
    const pruned = WorkflowInstall.pruneStore(loadSidecarStore(), live);
    if (pruned.removed > 0) saveSidecarStore(pruned.store);
    return pruned.removed;
  } catch (_) { return 0; }
}

// ─── machine facts ───────────────────────────────────────────────────────────

// The three directory probes the preflight rows and the run gate both read.
// Kept together so the sheet and the gate always agree about a path.
function wfxDirFacts(cwd) {
  const facts = { cwdIsDir: false, cwdIsHome: false, cwdInWorkTree: false };
  if (typeof cwd !== 'string' || !cwd) return facts;
  const abs = path.resolve(cwd);
  facts.cwdIsHome = abs === path.resolve(HOME);
  try { facts.cwdIsDir = fs.statSync(abs).isDirectory(); } catch (_) { facts.cwdIsDir = false; }
  if (facts.cwdIsDir) facts.cwdInWorkTree = wfxInWorkTree(abs);
  return facts;
}

function wfxInWorkTree(abs) {
  try {
    const out = execFileSync('git', ['-C', abs, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() === 'true';
  } catch (_) { return false; }
}

// The top of the work tree the directory sits in, for the export dialog's
// default path. A bare repository or a detached directory has none, and the
// caller falls back rather than inventing one.
function wfxGitRoot(abs) {
  try {
    const out = execFileSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const root = out.trim();
    return root ? root : null;
  } catch (_) { return null; }
}

// The MCP servers configured here, reduced to the two fields a comparison is
// allowed to see. env is dropped before the fingerprint is taken and never
// leaves this function, and a fingerprint over it would mismatch for everyone
// anyway, since two people never share an API key.
function wfxLocalMcpServers() {
  try {
    const r = SharedMcp.list(config.agentCommand, { sync: false });
    const servers = (r && Array.isArray(r.servers)) ? r.servers : [];
    return servers
      .filter((s) => s && s.enabled !== false)
      .map((s) => ({ name: String(s.id || ''), fingerprint: WorkflowInstall.mcpFingerprint(s) }));
  } catch (_) { return []; }
}

// The skills installed here, fingerprinted by the bytes of their markdown. A
// disabled skill is left out rather than reported as present-but-off: from the
// workflow's point of view a skill the agent will not load is not there.
//
// Both the directory name and the display name are offered, since a manifest is
// author-declared prose and the format does not say which one the author wrote.
function wfxLocalSkills() {
  const out = [];
  const seen = new Set();
  const push = (id, fingerprint) => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, fingerprint });
  };
  try {
    const items = [...listClaudeSkills(), ...listHuskPrompts()];
    for (const it of items) {
      if (!it || it.disabled) continue;
      let fingerprint = null;
      try { fingerprint = WorkflowInstall.skillFingerprint(fs.readFileSync(it.mdPath)); } catch (_) {}
      push(it.id, fingerprint);
      push(it.name, fingerprint);
    }
  } catch (_) {}
  return out;
}

// Marker file existence in the bound directory. The names come out of a file, so
// each one is resolved through resolveInside rather than path.join.
function wfxMarkerFiles(cwd, markers) {
  const found = {};
  if (typeof cwd !== 'string' || !cwd) return found;
  for (const marker of (Array.isArray(markers) ? markers : [])) {
    if (typeof marker !== 'string' || !marker) continue;
    try { found[marker] = fs.existsSync(resolveInside(cwd, marker)); }
    catch (_) { found[marker] = false; }
  }
  return found;
}

// ─── confined reads of a cloned tree ─────────────────────────────────────────

// A path is safe to read out of a clone when it resolves inside the clone and no
// component of it, from the root down to the leaf, is a symlink, so every
// component is walked rather than only the file itself.
function wfxResolveConfined(root, rel) {
  const abs = resolveInside(root, rel);
  const rootAbs = path.resolve(root);
  const parts = path.relative(rootAbs, abs).split(path.sep).filter(Boolean);
  let walk = rootAbs;
  for (const part of parts) {
    walk = path.join(walk, part);
    const st = fs.lstatSync(walk);
    if (st.isSymbolicLink()) throw new Error('refusing to follow a symlink inside the cloned repository');
  }
  return abs;
}

// Find the .husk.json files in a cloned tree, bounded in depth, in total entries
// looked at, and in candidates collected. Symlinked entries are skipped rather
// than followed, so the walk stays inside the tree and always terminates.
function wfxFindArtifacts(root) {
  const rootAbs = path.resolve(root);
  const found = [];
  let seen = 0;
  const walk = (dir, rel, depth) => {
    if (depth > WFX_SCAN_DEPTH || found.length >= WFX_MAX_CANDIDATES || seen >= WFX_SCAN_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found.length >= WFX_MAX_CANDIDATES || seen >= WFX_SCAN_ENTRIES) return;
      seen += 1;
      if (entry.isSymbolicLink()) continue;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (WFX_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), entryRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.husk.json')) continue;
      found.push({ relPath: entryRel, depth });
    }
  };
  walk(rootAbs, '', 0);
  // Shallowest first, then alphabetical, so the choice is deterministic across
  // machines and the surface can name the file it read.
  found.sort((a, b) => (a.depth - b.depth) || a.relPath.localeCompare(b.relPath));
  const preferred = found.find((f) => f.relPath === 'workflow.husk.json');
  if (preferred) {
    found.splice(found.indexOf(preferred), 1);
    found.unshift(preferred);
  }
  return found;
}

function wfxRefuse(code, message, detail, stage) {
  return {
    ok: false,
    stage: stage || 'source',
    code,
    message: String(message),
    detail: (detail === undefined || detail === null) ? null : String(detail).slice(0, 512),
  };
}

// The file is opened once and its kind, size and bytes all come from that one
// descriptor: an oversized file is refused by asking the filesystem how big it
// is rather than by reading it. parseArtifact repeats the size test on the
// string it gets, which covers the drag-drop path where there is no file to open.
function wfxReadArtifactAt(absPath) {
  let fd;
  // O_NONBLOCK keeps a fifo from parking the open until someone writes to it.
  try { fd = fs.openSync(absPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0)); } catch (err) {
    return wfxRefuse('unreadable', 'that file could not be opened', err && err.message);
  }
  let bytes;
  let size = 0;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return wfxRefuse('not-a-file', 'that path is not a file', absPath);
    size = st.size;
    if (size > WorkflowArtifact.MAX_ARTIFACT_BYTES) {
      return wfxRefuse('too-large',
        `that file is ${size} bytes and a Husk workflow may be ${WorkflowArtifact.MAX_ARTIFACT_BYTES}`,
        `${size} bytes`);
    }
    bytes = fs.readFileSync(fd);
  } catch (err) {
    return wfxRefuse('unreadable', 'that file could not be read', err && err.message);
  } finally { fs.closeSync(fd); }
  // The validator's answer travels back exactly as it came, refusal code and
  // all, since a surface keys its title and its recovery advice off that code.
  const result = WorkflowArtifact.parseArtifact(bytes);
  if (!result.ok) return Object.assign({ stage: 'validate' }, result);
  // chainCheck is this machine's finding rather than a field of the file, and it
  // rides beside the artifact so the sheet gets both in one round trip.
  return { ok: true, artifact: result.artifact, warnings: result.warnings, chainCheck: result.chainCheck, bytes: size };
}

// ─── IPC: read an artifact ───────────────────────────────────────────────────

// payload: { source: 'repo' | 'file', url?, path? }
//
// The repo path reuses cloneRepo, the app's one network primitive here: git
// clone and nothing else. Every read below goes through wfxResolveConfined.
ipcMain.handle('workflows:artifactRead', async (_e, payload = {}) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const source = p.source === 'file' ? 'file' : 'repo';

  if (source === 'file') {
    const raw = typeof p.path === 'string' ? p.path.trim() : '';
    if (!raw) return wfxRefuse('no-path', 'pick a .husk.json file to read', null);
    const abs = path.resolve(raw.startsWith('~/') ? path.join(HOME, raw.slice(2)) : raw);
    const read = wfxReadArtifactAt(abs);
    if (!read.ok) return read;
    return {
      ok: true,
      artifact: read.artifact,
      warnings: read.warnings,
      chainCheck: read.chainCheck,
      bytes: read.bytes,
      source: { kind: 'file', path: abs, relPath: path.basename(abs), root: null, url: null, candidates: [] },
    };
  }

  const url = typeof p.url === 'string' ? p.url.trim() : '';
  if (!url) return wfxRefuse('no-url', 'paste the https URL of a repository', null);
  const cloned = await cloneRepo(url, 'agent-repos');
  if (!cloned.ok) return wfxRefuse('clone-failed', cloned.error || 'that repository could not be cloned', url);

  const candidates = wfxFindArtifacts(cloned.root);
  if (!candidates.length) {
    return wfxRefuse('no-artifact-found',
      'that repository has no .husk.json in it',
      'Husk looks three directories deep for a file whose name ends in .husk.json');
  }
  let abs;
  try { abs = wfxResolveConfined(cloned.root, candidates[0].relPath); }
  catch (err) { return wfxRefuse('unsafe-path', 'that file is a link rather than a file, so Husk will not read it', err && err.message); }

  const read = wfxReadArtifactAt(abs);
  if (!read.ok) return Object.assign(read, { relPath: candidates[0].relPath });
  return {
    ok: true,
    artifact: read.artifact,
    warnings: read.warnings,
    chainCheck: read.chainCheck,
    bytes: read.bytes,
    source: {
      kind: 'repo',
      path: abs,
      relPath: candidates[0].relPath,
      root: cloned.root,
      url,
      candidates: candidates.map((c) => c.relPath),
      // Whether these bytes came off the network just now or out of a clone that
      // could not be refreshed. The sheet says which, since a fingerprint
      // recomputed from a copy of unknown age is a fact about the copy.
      stale: cloned.stale === true,
      staleReason: cloned.stale === true ? (cloned.staleReason || null) : null,
      fetchedAt: cloned.stale === true ? (cloned.fetchedAt || null) : null,
    },
  };
});

// The file picker for the install sheet's second source. Filtered to json,
// because a native filter cannot express the double extension .husk.json.
ipcMain.handle('workflows:pickArtifactFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a workflow file',
    properties: ['openFile'],
    filters: [{ name: 'Husk workflow', extensions: ['json'] }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// ─── IPC: preflight ──────────────────────────────────────────────────────────

// payload: { artifact?, workflowId?, cwd? }
//
// The artifact is revalidated even though it just came back from
// workflows:artifactRead, since it crossed into the renderer and back.
// Revalidation is microseconds, and the projection it returns is the one every
// check below reads.
ipcMain.handle('workflows:preflight', (_e, payload = {}) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const stored = typeof p.workflowId === 'string' ? sidecarFor(p.workflowId) : null;
  const candidate = p.artifact || (stored && stored.artifact) || null;
  if (!candidate) return wfxRefuse('not-artifact', 'there is nothing to check yet', null, 'validate');

  const checked = WorkflowArtifact.validateArtifact(candidate);
  if (!checked.ok) return Object.assign({ stage: 'validate' }, checked);
  const artifact = checked.artifact;

  const cwdRaw = (typeof p.cwd === 'string' && p.cwd) ? p.cwd : (stored && stored.boundCwd) || null;
  const cwd = cwdRaw ? path.resolve(cwdRaw) : null;
  const dirFacts = wfxDirFacts(cwd);

  const agentsOnPath = {};
  for (const name of (artifact.requires.agentCommands || [])) agentsOnPath[name] = isOnPath(name);

  const facts = Object.assign({
    agentsOnPath,
    mcpServers: wfxLocalMcpServers(),
    skills: wfxLocalSkills(),
    markerFiles: wfxMarkerFiles(cwd, artifact.requires.workspace.markerFiles),
    cwd,
    huskVersion: app.getVersion(),
  }, dirFacts);

  const result = WorkflowInstall.evaluatePreflight(artifact, facts);
  if (!result.ok) return wfxRefuse('not-artifact', result.error, null, 'validate');
  return {
    ok: true,
    checks: result.checks,
    blocking: result.blocking,
    cautions: result.cautions,
    oks: result.oks,
    // Recomputed on this pass rather than carried over from the read, for the
    // same reason the artifact itself is: a finding is worth the moment it was
    // made.
    chainCheck: checked.chainCheck,
    cwd,
    huskVersion: app.getVersion(),
  };
});

// ─── IPC: install ────────────────────────────────────────────────────────────

// payload: { artifact, cwd, source? }
//
// One call rather than a create followed by a sidecar write, so there is never a
// window where the workflow exists and its row does not.
ipcMain.handle('workflows:install', (_e, payload = {}) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const checked = WorkflowArtifact.validateArtifact(p.artifact);
  if (!checked.ok) return Object.assign({ stage: 'validate' }, checked);
  const artifact = checked.artifact;

  const cwd = (typeof p.cwd === 'string' && p.cwd) ? path.resolve(p.cwd) : null;
  if (!cwd) return wfxRefuse('cwd-required', 'pick the directory this workflow will run in', null, 'install');
  const dirFacts = wfxDirFacts(cwd);
  if (dirFacts.cwdIsHome) return wfxRefuse('cwd-is-home', 'Husk will not bind an imported workflow to your home directory', cwd, 'install');
  if (!dirFacts.cwdIsDir) return wfxRefuse('cwd-not-a-directory', 'that path is not a directory', cwd, 'install');
  if (artifact.requires.workspace.vcs === 'git' && !dirFacts.cwdInWorkTree) {
    return wfxRefuse('cwd-not-a-work-tree', 'this workflow declares it needs git, and that directory is not inside a work tree', cwd, 'install');
  }

  const workflow = createWorkflowRecord({
    name: artifact.name,
    description: artifact.description || '',
    // The canonical n0..nk ids and the quantised layout come straight across,
    // and sanitizeGraph runs over them inside createWorkflowRecord.
    graph: artifact.graph,
    trigger: 'manual',
    // The one call site that may say this. It is what keeps the gate honest when
    // the sidecar row is missing for any reason.
    origin: 'imported',
  });

  const row = WorkflowInstall.sidecarRow({
    workflowId: workflow.id,
    origin: 'imported',
    artifact,
    boundCwd: cwd,
    installedAt: new Date().toISOString(),
    // Installing writes a file and executes nothing, so consent is asked for at
    // the first Run and recorded here when it is given.
    consentedAt: null,
  });
  // An install whose sidecar row did not reach disk is not an install, so the
  // record is removed rather than left behind half-installed.
  if (!writeSidecar(row)) {
    try { saveWorkflows(loadWorkflows().filter((w) => w && w.id !== workflow.id)); } catch (_) {}
    return wfxRefuse('sidecar-write-failed',
      'the workflow could not be marked as imported, so nothing was installed',
      null, 'install');
  }
  return { ok: true, workflow, sidecar: row };
});

// ─── IPC: the sidecar ────────────────────────────────────────────────────────

// Every row at once, because the workflows grid paints every card in one pass
// and asking per card would be one IPC round trip per workflow on every
// repaint. The rows carry the whole artifact, which is bounded at a megabyte
// each by the reader that let them in.
//
// Each row travels with this machine's own finding about the log inside it,
// under `chainCheck`, recomputed on every read rather than stored: a tier above
// "author states" is something this machine did, just now, to the bytes in front
// of it.
ipcMain.handle('workflows:sidecars', () => {
  const rows = loadSidecarStore().rows;
  const sidecars = {};
  for (const id of Object.keys(rows)) {
    const row = rows[id];
    sidecars[id] = Object.assign({}, row, { chainCheck: wfxChainCheckFor(row && row.artifact) });
  }
  return { ok: true, sidecars };
});

// The answer for one stored artifact, in the four-field shape the surfaces
// read: { checked, valid, agrees, detail }. A workflow with no artifact, or one
// whose receipts ship no log, gets checked:false, which is the honest answer to
// "was there anything here to check" and leaves every figure author-stated.
function wfxChainCheckFor(artifact) {
  const unchecked = { checked: false, valid: null, agrees: null, detail: null };
  if (!artifact || !Array.isArray(artifact.receipts) || !artifact.receipts.length) return unchecked;
  try {
    let answer = unchecked;
    for (const receipt of artifact.receipts) {
      const check = WorkflowArtifact.checkReceiptEvidence(receipt);
      if (!check.checked) continue;
      // The first failure decides it for the file: an honest receipt beside one
      // contradicted by its own log does not earn a tier.
      if (check.valid !== true || check.agrees !== true) return check;
      answer = check;
    }
    return answer;
  } catch (_) {
    return unchecked;
  }
}

// Recording consent. The timestamp is written before the run starts rather
// than after it finishes, so a run that crashes does not ask again for
// something the user already read and agreed to.
ipcMain.handle('workflows:consent', (_e, payload = {}) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const row = sidecarFor(p.workflowId);
  if (!row) return wfxRefuse('no-sidecar', 'that workflow did not come from a file, so there is nothing to consent to', null, 'consent');
  if (row.consentedAt) return { ok: true, consentedAt: row.consentedAt, sidecar: row };
  row.consentedAt = new Date().toISOString();
  writeSidecar(row);
  return { ok: true, consentedAt: row.consentedAt, sidecar: row };
});

// Rebinding the directory. Changing it clears nothing: consent was given to a
// set of prompts, not to a folder, and the folder is named in the run header
// before the first step spawns either way.
ipcMain.handle('workflows:bindCwd', (_e, payload = {}) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const row = sidecarFor(p.workflowId);
  if (!row) return wfxRefuse('no-sidecar', 'that workflow did not come from a file', null, 'bind');
  const cwd = (typeof p.cwd === 'string' && p.cwd) ? path.resolve(p.cwd) : null;
  if (!cwd) return wfxRefuse('cwd-required', 'pick a directory', null, 'bind');
  const dirFacts = wfxDirFacts(cwd);
  if (dirFacts.cwdIsHome) return wfxRefuse('cwd-is-home', 'Husk will not bind an imported workflow to your home directory', cwd, 'bind');
  if (!dirFacts.cwdIsDir) return wfxRefuse('cwd-not-a-directory', 'that path is not a directory', cwd, 'bind');
  row.boundCwd = cwd;
  writeSidecar(row);
  return { ok: true, boundCwd: cwd, sidecar: row };
});

// ─── IPC: receipts ───────────────────────────────────────────────────────────

// The local run figures for every saved workflow, keyed on workflow id, in one
// call. Every card on the grid carries a receipts strip and the grid paints in
// one pass, so this follows workflows:sidecars rather than asking per card.
//
// The figures are aggregated against the fingerprint of the graph as it stands
// now, so editing a step drops the strip back to empty. That is the point of
// fingerprinting a run: those numbers were earned by a different program.
ipcMain.handle('workflows:receipts', () => {
  const runs = loadWorkflowRuns();
  const aggregates = {};
  for (const raw of loadWorkflows()) {
    try {
      const workflow = migrateWorkflow(raw);
      if (!workflow || typeof workflow.id !== 'string') continue;
      const fingerprint = WorkflowArtifact.graphHash(workflow.graph);
      if (!fingerprint || !fingerprint.ok) continue;
      const r = wfxReceiptsFor(workflow, fingerprint.hash, runs);
      if (r.summary && r.summary.runs > 0) aggregates[workflow.id] = r.summary;
    } catch (_) {
      // One unreadable workflow costs itself its strip and nothing else, since
      // the grid is drawn from this map.
    }
  }
  return { ok: true, aggregates };
});

// ─── IPC: export ─────────────────────────────────────────────────────────────

// The receipts a published file would carry, aggregated from local run
// history, and the same figures the card's own receipts strip reads.
//
// `receipts` is the wire form and is empty unless the aggregate is publishable.
// `summary` is the local form and is present whenever the runs could be read at
// all, which is what the strip needs: a single run is a number a reader may see
// on their own machine before it is a claim worth publishing.
//
// runs is passed in by callers that already hold the history, because
// loadWorkflowRuns parses the whole file and the workflows grid asks this
// question once per card.
//
// opts.attachLog asks for the runs' own audit rows to travel with the figures,
// which changes where the figures come from: with a log attached the receipt is
// built from the log, over exactly the runs whose rows are in it, so the reader
// recomputes the same numbers they were sent.
function wfxReceiptsFor(workflow, graphHash, runs, opts) {
  const attachLog = !!(opts && opts.attachLog);
  const agg = WorkflowReceipt.aggregateRuns(Array.isArray(runs) ? runs : loadWorkflowRuns(), {
    workflowId: workflow.id,
    graphHash,
    historyMax: WF_RUNS_MAX,
    stepTimeoutMs: WF_STEP_TIMEOUT_MS,
  });
  if (!agg.ok) return { receipts: [], summary: null, reason: agg.error };
  const a = agg.aggregate;
  const summary = {
    runs: a.runs,
    sourceRuns: a.sourceRuns,
    excluded: a.excluded,
    runsWindowed: a.runsWindowed,
    outcomes: a.outcomes,
    outcomeBasis: a.outcomeBasis,
    medianDurationMs: a.medianDurationMs,
    medianDurationN: a.medianDurationN,
    // Kept off the wire by aggregateRuns and carried here on purpose: two runs
    // are a range by the copy rule, and a range needs both ends.
    durationRangeMs: a.durationRangeMs,
    durationCensored: a.durationCensored,
    medianTokens: a.medianTokens,
    medianTokensN: a.medianTokensN,
    precision: a.precision,
    publishable: a.publishable,
    publishBlockers: a.publishBlockers,
  };
  if (!a.publishable) {
    return {
      receipts: [],
      summary,
      // Runs are stamped with the fingerprint of the graph they executed, so an
      // unhashed row cannot be attached to this graph or any other. Saying which
      // of the two reasons applies is what the publisher can act on.
      reason: a.excluded.unhashed > 0
        ? 'some runs in your history were recorded before Husk stamped a run with the graph it executed, so they cannot be attached to this fingerprint'
        : `nothing publishable yet: ${a.publishBlockers.join(', ')}`,
    };
  }
  // The environment is taken from the runs themselves rather than from this
  // machine as it stands now: recordWorkflowRun stamps each row as it finishes,
  // so the most recent matching row describes a machine that executed this
  // fingerprint. A row without the stamp contributes nothing, and the receipt
  // ships without an environment block.
  const matching = (Array.isArray(runs) ? runs : loadWorkflowRuns()).filter((r) => r
    && r.workflowId === workflow.id
    && r.graphHash === graphHash
    && r.environment && typeof r.environment === 'object');

  // With a log attached the figures are the log's, so the aggregate above
  // becomes only the local summary the publish sheet shows. A refusal travels
  // back rather than being downgraded to a quiet evidence:"none".
  const evidence = attachLog
    ? wfxCollectEvidence(workflow, graphHash, Array.isArray(runs) ? runs : loadWorkflowRuns())
    : null;
  if (evidence && !evidence.ok) return { receipts: [], summary, reason: null, refusal: evidence.refusal };
  const figures = evidence ? evidence.figures : a;

  // With evidence attached, the machine described is one of the machines the
  // attached rows came from. The environment stays an author claim either way,
  // and the session id of a run is its run id, so the pairing costs one lookup.
  const attached = evidence ? new Set(evidence.chain.sessionIds) : null;
  const described = attached ? matching.filter((r) => attached.has(r.id)) : matching;
  const environment = described.length ? described[0].environment : null;

  // Derived from what the receipt says rather than randomly, so republishing an
  // unchanged history produces an unchanged file. A format meant to be committed
  // next to code should not churn when nothing happened.
  const receiptId = `rcp_${crypto.createHash('sha256').update([
    graphHash,
    String(figures.runs),
    (figures.window && figures.window.firstRunAt) || '',
    (figures.window && figures.window.lastRunAt) || '',
  ].join(' ')).digest('hex').slice(0, 16)}`;

  const receipt = {
    id: receiptId,
    graphHash,
    runs: figures.runs,
    // A log carries no view of the history it was drawn from, so this stays the
    // aggregate's answer either way: a fact about the publisher's run list
    // rather than about the rows in the envelope, and never recomputed.
    runsWindowed: a.runsWindowed || (evidence ? evidence.windowed : false),
    window: figures.window,
    outcomes: figures.outcomes,
    outcomeBasis: figures.outcomeBasis,
    medianDurationMs: figures.medianDurationMs,
    durationCensored: figures.durationCensored,
    medianTokens: figures.medianTokens,
    // No log is shipped unless the publisher asks for one, so a receipt on its
    // own is an author claim and says so through this field.
    evidence: evidence ? 'inline' : 'none',
    chain: evidence ? evidence.chain : null,
  };
  if (environment) receipt.environment = environment;

  return {
    receipts: [receipt],
    summary,
    reason: null,
    warnings: evidence ? evidence.warnings : [],
  };
}

// One run's chained log, read off disk and bounded.
//
// The session id comes out of workflow-runs.json, so it is charset-checked
// before it is joined onto a path. The size is asked of the filesystem before
// the bytes are read, as in the artifact reader.
//
// The two ways this fails are two different sentences for the publisher, so they
// come back as two different reasons: a log that is simply missing, and one
// larger than a published file may carry, whose size the publisher can be told
// next to the budget it passed.
function wfxReadRunLog(sessionId) {
  if (typeof sessionId !== 'string' || !WF_RUN_SESSION_RE.test(sessionId)) {
    return { ok: false, reason: 'unreadable', bytes: 0 };
  }
  const file = path.join(autopilotStorageRoot(), 'sessions', sessionId, 'audit.jsonl');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'unreadable', bytes: 0 };
    if (st.size > WorkflowArtifact.MAX_CHAIN_BYTES) return { ok: false, reason: 'too-large', bytes: st.size };
    const raw = fs.readFileSync(fd, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (!lines.length) return { ok: false, reason: 'unreadable', bytes: st.size };
    return { ok: true, lines, bytes: st.size };
  } catch (_) {
    return { ok: false, reason: 'unreadable', bytes: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The evidence a publish may attach: whole sessions, newest first, each one
// walked here before it is offered to anybody.
//
// Sessions go in whole or not at all. A chain is a sequence of rows that hash
// into each other, so half of one is a chain that fails on arrival and collapses
// the receipt it came with. Whole sessions also keep the arithmetic honest,
// since the receipt is then rebuilt from exactly what is in the envelope.
//
// The budget is a refusal, never a trim, because trimming breaks the chain. Over
// budget, the publisher is told both numbers and can publish the same figures
// without the log.
function wfxCollectEvidence(workflow, graphHash, runs) {
  const warnings = [];
  const rows = (Array.isArray(runs) ? runs : []).filter((r) => r
    && r.workflowId === workflow.id
    && r.graphHash === graphHash
    && typeof r.auditSessionId === 'string');
  if (!rows.length) {
    return {
      ok: false,
      refusal: wfxRefuse('evidence-unavailable',
        'none of the runs behind these figures left a log Husk can attach',
        'a run records one only under a Husk that writes them, so the next run of this workflow will have one',
        'export'),
    };
  }

  // The history arrives newest first and a chain is written oldest first, so the
  // selection is taken off the front and reversed below, leaving a reader
  // walking the rows in the order they happened.
  const selected = [];
  let broken = 0;
  let oversize = 0;
  let oversizeBytes = 0;
  for (const row of rows) {
    if (selected.length >= WorkflowArtifact.MAX_CHAIN_SESSIONS) break;
    const read = wfxReadRunLog(row.auditSessionId);
    if (!read.ok) {
      if (read.reason === 'too-large') { oversize += 1; oversizeBytes = Math.max(oversizeBytes, read.bytes); }
      broken += 1;
      continue;
    }
    const walk = WorkflowArtifact.verifyArtifactChain(read.lines, row.auditSessionId, { graphHash });
    // A local log that does not check out is dropped rather than shipped, since
    // it would fail the same walk on the reader's machine. The publisher is told
    // how many were set aside.
    if (!walk.valid) { broken += 1; continue; }
    selected.push({ sessionId: row.auditSessionId, lines: read.lines });
  }
  if (!selected.length) {
    if (oversize === broken) {
      return {
        ok: false,
        refusal: wfxRefuse('evidence-too-large',
          'the log for these runs is larger than a published file may carry, so nothing was written',
          `one run's log alone is ${oversizeBytes} bytes, against a budget of ${WorkflowArtifact.MAX_CHAIN_BYTES} for every log in the file. Publishing without the log writes the same figures as author-stated.`,
          'export'),
      };
    }
    return {
      ok: false,
      refusal: wfxRefuse('evidence-unavailable',
        'the logs behind these figures do not hold together on this machine, so there is nothing to attach',
        `${broken} log${broken === 1 ? '' : 's'} could not be read, or did not check out on this machine`,
        'export'),
    };
  }
  if (broken > 0) {
    warnings.push({
      code: 'evidence-partial',
      message: `${broken} run log${broken === 1 ? ' was' : 's were'} unreadable and left out, so these figures cover the runs whose rows are attached`,
    });
  }
  // Two different reasons a run can be missing from the figures, and they get
  // two different sentences. Above: its log could not be read. Here: the loop
  // stopped at the session cap before it looked, which is what a publisher with
  // a long history hits and what makes the receipt a claim about the recent
  // past.
  const unexamined = rows.length - (selected.length + broken);
  const windowed = selected.length < rows.length;
  if (unexamined > 0) {
    warnings.push({
      code: 'evidence-windowed',
      message: `these figures cover the ${selected.length} most recent runs, which are the ones whose logs travel with the file`,
    });
  }

  selected.reverse();
  const lines = [];
  let bytes = 0;
  for (const session of selected) {
    for (const line of session.lines) {
      lines.push(line);
      bytes += Buffer.byteLength(line, 'utf8');
    }
  }
  if (bytes > WorkflowArtifact.MAX_CHAIN_BYTES || lines.length > WorkflowArtifact.MAX_CHAIN_LINES) {
    return {
      ok: false,
      refusal: wfxRefuse('evidence-too-large',
        'the logs for these runs are larger than a published file may carry, so nothing was written',
        `${bytes} bytes across ${lines.length} rows, against a budget of ${WorkflowArtifact.MAX_CHAIN_BYTES} bytes across ${WorkflowArtifact.MAX_CHAIN_LINES}. Publishing without the log writes the same figures as author-stated.`,
        'export'),
    };
  }

  // Walked once more as the single chain the file will carry, since that is the
  // arrangement the reader walks.
  const sessionIds = selected.map((s) => s.sessionId);
  const walk = WorkflowArtifact.verifyArtifactChain(lines, sessionIds, { graphHash });
  if (!walk.valid) {
    return {
      ok: false,
      refusal: wfxRefuse('evidence-unavailable',
        'the log Husk assembled for this file does not hold together, so nothing was written',
        `${walk.reason} (${walk.predicate})`,
        'export'),
    };
  }
  const derived = WorkflowReceipt.figuresFromChain(walk.sessions);
  if (!derived.ok) {
    return {
      ok: false,
      refusal: wfxRefuse('evidence-unavailable', 'the figures for this file could not be recomputed from its own log', derived.error, 'export'),
    };
  }
  if (!derived.figures.publishable) {
    return {
      ok: false,
      refusal: wfxRefuse('evidence-unavailable',
        'the attached runs do not add up to a receipt that can be published',
        `nothing publishable yet: ${derived.figures.publishBlockers.join(', ')}`,
        'export'),
    };
  }

  return {
    ok: true,
    warnings,
    windowed,
    figures: derived.figures,
    chain: {
      sessionIds,
      head: walk.head,
      lineCount: lines.length,
      lines,
    },
  };
}

// The path a published file defaults to. A workflow bound to a work tree
// belongs in that tree, committed next to the code its prompts assume, which
// is the whole premise of the format. Anything else falls back to the
// downloads folder rather than to a repo the workflow has nothing to do with.
function wfxDefaultExportPath(workflow, sidecar) {
  const fileName = WorkflowInstall.artifactFileName(workflow && workflow.name);
  const bound = sidecar && sidecar.boundCwd ? sidecar.boundCwd : null;
  if (bound) {
    const root = wfxGitRoot(bound);
    if (root) return path.join(root, '.husk', 'workflows', fileName);
  }
  let downloads = HOME;
  try { downloads = app.getPath('downloads') || HOME; } catch (_) {}
  return path.join(downloads, fileName);
}

// A .husk.json is meant to be committed, so it is written as an ordinary repo
// file: 0644, two-space JSON, and a trailing newline. writeJsonAtomic writes
// 0600 into a 0700 directory, which is right for the config folder it was built
// for and wrong for a file everyone who checks the repo out has to read.
function wfxWriteArtifactAtomic(target, artifact) {
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, target);
  return Buffer.byteLength(text, 'utf8');
}

// payload: { workflowId, targetPath?, notes?, publisher?, revision?, attachLog? }
//
// targetPath skips the dialog, which is what a republish onto an already
// chosen file wants: the second publish of the same workflow writes
// immediately and offers an Undo rather than asking the same question again.
ipcMain.handle('workflows:export', async (_e, payload = {}) => {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const raw = loadWorkflows().find((w) => w.id === p.workflowId);
  if (!raw) return wfxRefuse('not-found', 'that workflow is not in your list any more', p.workflowId, 'export');
  const workflow = migrateWorkflow(raw);

  // The one refusal that names a step before the builder phrases it, because it
  // is the refusal a user can act on: a step with no agent resolves at run time
  // to whatever the reader's config says, so the receipt would describe a
  // different program.
  const unbound = ((workflow.graph && workflow.graph.nodes) || [])
    .filter((n) => n && !n.agentCommand)
    .map((n) => ({ id: n.id, name: String(n.name || 'Step').slice(0, 64) }));
  if (unbound.length) {
    return Object.assign(wfxRefuse('bad-agent',
      `the step "${unbound[0].name}" does not say which agent it runs, so a published file could not say what it does`,
      unbound.map((s) => s.name).join(', '), 'export'),
    { step: unbound[0], steps: unbound });
  }

  const sidecar = sidecarFor(p.workflowId);
  const prior = sidecar && sidecar.artifact ? sidecar.artifact : null;
  const fingerprint = WorkflowArtifact.graphHash(workflow.graph);
  const receipts = fingerprint.ok
    ? wfxReceiptsFor(workflow, fingerprint.hash, null, { attachLog: p.attachLog === true })
    : { receipts: [], summary: null, reason: fingerprint.error };
  // The toggle is answered rather than absorbed: a publisher who asked for the
  // log is told when it could not be attached.
  if (receipts.refusal) return receipts.refusal;

  const built = WorkflowArtifact.buildArtifact(workflow, {
    huskVersion: app.getVersion(),
    // Republishing keeps the artifact's identity and moves its revision, so a
    // reader can tell a new version of a workflow they know from a different
    // workflow that happens to share a name.
    artifactId: (typeof p.artifactId === 'string' && p.artifactId) || (prior && prior.artifactId) || undefined,
    revision: Number.isSafeInteger(p.revision) ? p.revision : ((prior && prior.revision ? prior.revision : 0) + 1),
    publisher: p.publisher === undefined ? null : p.publisher,
    notes: typeof p.notes === 'string' ? p.notes : null,
    requires: (p.requires && typeof p.requires === 'object') ? p.requires : (prior ? prior.requires : undefined),
    receipts: receipts.receipts,
  });
  if (!built.ok) return Object.assign({ stage: 'export' }, built, { step: null });

  const warnings = (built.warnings || []).slice();
  // What the evidence collector set aside on the way to this file: logs it could
  // not read, and runs whose logs did not fit in the envelope. Both are
  // statements about which runs the figures cover, so they travel with them.
  for (const w of (receipts.warnings || [])) warnings.push(w);
  if (receipts.reason) {
    warnings.push({ code: 'no-receipts', message: receipts.reason });
  }

  let target = (typeof p.targetPath === 'string' && p.targetPath) ? path.resolve(p.targetPath) : null;
  if (!target) {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Export workflow',
      defaultPath: wfxDefaultExportPath(workflow, sidecar),
      filters: [{ name: 'Husk workflow', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true, stage: 'export', code: 'cancelled', message: 'export cancelled', detail: null };
    target = r.filePath;
  }

  let bytes;
  try { bytes = wfxWriteArtifactAtomic(target, built.artifact); }
  catch (err) { return wfxRefuse('write-failed', 'that file could not be written', err && err.message, 'export'); }

  return {
    ok: true,
    path: target,
    bytes,
    artifact: built.artifact,
    warnings,
    receiptSummary: receipts.summary,
  };
});

// ─── Workflow graph model ─────────────────────────────────────────────────────
// A workflow is a graph of step nodes connected by edges. Edges carry a
// routing condition (used by the 2b branch engine; 2a treats all as 'always').

// Per-node scrollback. A run outlives the window that started it, and a node's
// terminal can be opened long after the node finished, so the output lives here
// rather than only in the event that announced it. Bounded, because a chatty
// agent would otherwise grow it forever.
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

// Broadcast, not point-to-point: the window that asked for the run is not
// necessarily the window that needs to watch it.
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

// ─── the run log ──────────────────────────────────────────────────────────────
//
// Every workflow run writes a hash-chained audit log, the same append-only JSONL
// the autonomy supervisor writes, through the same module. There is one chain
// implementation in this app and this uses it rather than growing a second one.
//
// The log is what lets a stranger's Husk recompute a receipt's figures from rows
// it re-hashes locally, and the tier of a figure it recomputes is "matches the
// shipped log". That is the ceiling: the chain is anchored at a public genesis
// constant with no signature, so a passing chain means this JSONL is internally
// consistent and nothing more.
//
// Row 1 is the binding, immediately after row 0 opens the session, and it
// carries the graphHash the run executed. Keeping it inside the chain is the
// point: a log moved onto another workflow's receipt names the wrong
// fingerprint, and moving it costs a rehash of every row after it.
//
// A row carries a node id, a step name already in the graph beside it, a status,
// a duration and the vendor's token report. No working directory, no prompt
// text, no agent output, since these rows get committed to a public repo.
// Nothing here is large enough to spill into the blob store either, and a
// blob_ref row reads as an opaque hash (the blobs go through safeStorage and are
// bound to this machine's keychain), dropping a step out of the recomputed
// figures.
const WF_AUDIT_ROWS = {
  start: WorkflowArtifact.ROW_START,
  binding: WorkflowArtifact.ROW_BINDING,
  stepStart: 'step_start',
  stepEnd: 'step_end',
  summary: WorkflowArtifact.ROW_SUMMARY,
};

// Open the log for one run and write the two rows that open a session. Returns
// the writer, or null when anything at all went wrong.
//
// Null is a run with no receipt and nothing else: the workflow still executes,
// the history row is still written, and the publish sheet says there is no log
// to attach.
function wfOpenRunAudit(run, workflow, graph) {
  try {
    // A run id is `run-${Date.now()}`, already inside the character set audit.js
    // confines a session directory to, so the log lands beside the autopilot
    // sessions under one storage root with no id translation. The `run-` prefix
    // is what tells the two apart on disk: autopilot mints `auto-<base36>-<hex>`,
    // and the prune below only touches ours.
    const opened = Autopilot.audit.createAuditLog(autopilotStorageRoot(), run.id, {});
    if (!opened.ok) return null;
    const fingerprint = WorkflowArtifact.graphHash(workflow.graph);
    // No fingerprint, no log: a chain whose binding row cannot name the graph it
    // ran is a chain no receipt may be built on.
    if (!fingerprint.ok) return null;
    const writer = opened.writer;
    const started = writer.append({
      kind: WF_AUDIT_ROWS.start,
      payload: {
        startedAt: run.startedAt,
        steps: graph.nodes.length,
        os: process.platform,
        huskVersion: app.getVersion(),
      },
    });
    if (!started.ok) return null;
    const bound = writer.append({ kind: WF_AUDIT_ROWS.binding, payload: { graphHash: fingerprint.hash } });
    if (!bound.ok) return null;
    return { writer, sessionId: run.id, graphHash: fingerprint.hash };
  } catch (_) {
    return null;
  }
}

// One row, appended to a run's log if it has one. Every call site is a place
// something already happened, so a failure here is swallowed: a full disk must
// not take down a run that is otherwise working, and a log that stops mid-run
// fails the reader's terminal-row check.
function wfAudit(run, kind, payload) {
  if (!run || !run.audit) return;
  try { run.audit.writer.append({ kind, payload }); } catch (_) {}
}

// A finished step, in the shape figuresFromChain reads back. `ms` and the
// vendor's usage record are the two figures a receipt is built from, and
// timedOut is what keeps a censored median from being quoted as a median.
function wfAuditStepEnd(run, node, state) {
  const st = state || {};
  wfAudit(run, WF_AUDIT_ROWS.stepEnd, {
    nodeId: node.id,
    status: typeof st.status === 'string' ? st.status : 'failed',
    ms: Number.isFinite(st.ms) ? st.ms : 0,
    timedOut: st.timedOut === true,
    usage: st.usage || null,
  });
}

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
  // Steps run the agent found on PATH, by name only. A name carrying a path
  // separator is refused here, and isAllowedAgentCommand then holds the basename
  // to the agents Husk knows how to drive (workflow-graph.js:35-41).
  if (/[\\/]/.test(cmd)) {
    activity('error', `Step "${step.name}" names an agent by path ("${cmd}"). Steps run the agent found on your PATH, by name only.`);
    stepState.status = 'failed';
    stepState.ms = Date.now() - stepState.startedAt;
    wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: step.id, status: 'failed' });
    return { status: 'failed', output: '' };
  }
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
  const modelFlag = step.model ? modelFlagFor(cmd) : null;
  const modelArgs = (modelFlag && step.model) ? [modelFlag, String(step.model)] : [];
  if (cmd === 'claude') {
    args = ['-p', prompt, '--append-system-prompt', wfSystem, '--output-format', 'stream-json', '--verbose'];
    if (modelArgs.length) args = [...args, ...modelArgs];
  } else {
    args = AgentOneShot.oneShotArgs(cmd, `${wfSystem}\n\n${prompt}`, { untrusted: run.untrusted === true, modelArgs });
  }

  let resultText = '';
  let lineBuf = '';
  let sawAnyEvent = false;
  // run.cwd is set only for a workflow that came from a file, where the
  // directory was chosen at install, stored in the sidecar, and re-probed by the
  // gate on this Run press. Everything authored here leaves run.cwd null and
  // falls through the chain below instead.
  const wfCwd = run.cwd || activePtyCwd || (config && config.treeRoot) || HOME;
  // spawnName resolves the allowlisted name to the file it refers to.
  const child = spawn(spawnName(cmd), args, { cwd: wfCwd, stdio: ['ignore', 'pipe', 'pipe'], env: buildAgentEnv() });
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
      // The result event is the only place the vendor states what the step cost.
      // Kept verbatim in the vendor's own spelling; workflow-receipt.js reads
      // both the camelCase and snake_case tiers, so nothing here normalizes.
      if (ev && ev.type === 'result' && ev.usage && typeof ev.usage === 'object') {
        stepState.usage = ev.usage;
      }
      handleStreamEvent(ev, activity, (txt) => { resultText = txt; });
    }
  });
  child.stderr.on('data', (d) => { const t = d.toString().trim(); if (t) activity('error', t); });

  const killTimer = setTimeout(() => {
    activity('error', 'Step timed out after 5 minutes, killing the agent.');
    // Recorded before the kill, because the close handler cannot tell a step
    // stopped by the timer from one that failed on its own, and a receipt has to
    // count its censored runs before it quotes a median.
    stepState.timedOut = true;
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

  // Opened before the first step so the binding row is written before anything
  // has run, and against the graph this scheduler is about to walk rather than
  // whatever the store says later.
  run.audit = wfOpenRunAudit(run, workflow, graph);

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
    // A skipped step is logged with the rest, so the log describes the same
    // workflow the run history row lists and a reader counting step rows counts
    // the program whose fingerprint sits in row 1.
    wfAuditStepEnd(run, n, run.stepStates[n.id]);
    wfEmit(event, 'wf:node:done', { runId: run.id, nodeId: n.id, status: 'skipped' });
    // A skipped node takes none of its outgoing edges.
    graph.edges.filter((e) => e.from === n.id).forEach((e) => { if (edgeState.get(e.id) === 'pending') edgeState.set(e.id, 'skipped'); });
    if (reason) { /* reason reserved for future surfacing */ }
  };

  const finish = () => {
    if (run.status === 'running') run.status = anyFailed ? 'failed' : 'done';
    run.finishedAt = new Date().toISOString();
    run.currentNodeId = null;
    // The terminal row, written before the history row it has to agree with. Its
    // presence is what tells a reader the log reaches its end, which genesis
    // anchoring alone cannot show since the anchor covers the head.
    wfAudit(run, WF_AUDIT_ROWS.summary, {
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      ms: run.startedAt ? (new Date(run.finishedAt) - new Date(run.startedAt)) : 0,
      steps: graph.nodes.length,
    });
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
    // The step rows are written here rather than inside wfRunStep, which has
    // three exits. The scheduler has one place a step begins and two where one
    // ends, and both already read the step's own state.
    wfAudit(run, WF_AUDIT_ROWS.stepStart, {
      nodeId: n.id,
      name: n.name || '',
      agent: AgentOneShot.agentBaseName(n.agentCommand || config.agentCommand || 'claude') || '',
      model: n.model || null,
    });
    wfRunStep(event, run, graph, byId, n, ctx).then(({ status, output }) => {
      wfAuditStepEnd(run, n, run.stepStates[n.id]);
      try { wfSettleNode(n, status, output); } catch (err) {
        wfEmit(event, 'wf:node:activity', { runId: run.id, nodeId: n.id, kind: 'error', text: `scheduler error: ${err && err.message}` });
        anyFailed = true;
      }
      pump();
    }).catch((err) => {
      running.delete(n.id); nodeDone.add(n.id); anyFailed = true;
      // A step that crashed still ended, and the log says so: a step_start with
      // no step_end is a shape the reader refuses.
      wfAuditStepEnd(run, n, Object.assign({}, run.stepStates[n.id], { status: 'failed' }));
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
        resolve({ ok: true, name: String(parsed.name || '').slice(0, AGENT_NAME_MAX), description: String(parsed.description || '').slice(0, AGENT_DESC_MAX), systemPrompt: String(parsed.systemPrompt || '').slice(0, AGENT_PROMPT_MAX) });
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
// Mirror every user (non-builtin) agent profile into each installed CLI's agents
// dir. The stored record is the source of truth for every tool, so the file is
// rendered from the profile and written over whatever is there, and an edited
// name, description or system prompt reaches disk. The blast radius matches
// delete: a file whose name slugs to the same basename is replaced by the record.
function syncAgentFiles() {
  try {
    const dirs = installedAgentDirs();
    if (!dirs.length) return;
    const profiles = getProfiles().filter((p) => p && !p.builtin && (p.systemPrompt || p.name));
    for (const p of profiles) {
      const fname = agentFileName(p.name);
      const content = renderAgentMd(p);
      const newBody = agentMdBody(content);
      for (const dir of dirs) {
        const target = path.join(dir, fname);
        try {
          // mkdir recursive is idempotent.
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is a fixed CLI agents dir, fname is slugified
          fs.mkdirSync(dir, { recursive: true });
          let existing = null;
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to a CLI agents dir + slugified basename
          try { existing = fs.readFileSync(target, 'utf8'); } catch (_) {}
          // A file Husk rendered is Husk's to update, so an edit reaches disk.
          // Anything else belongs to the user or to the tool that installed it,
          // and is only ever extended, never traded for a shorter body.
          if (existing && !isHuskManaged(existing) && agentMdBody(existing).length > newBody.length) continue;
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded to a CLI agents dir + slugified basename
          fs.writeFileSync(target, content, { mode: 0o600 });
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
            description: (parsed.description || '').slice(0, AGENT_DESC_MAX),
            systemPrompt: (parsed.body || '').slice(0, AGENT_PROMPT_MAX),
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
        name: (parsed.name || fname.replace(/\.md$/, '')).slice(0, AGENT_NAME_MAX),
        description: (parsed.description || '').slice(0, AGENT_DESC_MAX),
        systemPrompt: (parsed.body || '').slice(0, AGENT_PROMPT_MAX),
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

// Two spellings of one repository are one repository: a trailing .git and a
// trailing slash are punctuation, not identity. Anything else is a different
// remote and a checkout that carries it is not the answer to this URL.
function sameGitRemote(a, b) {
  const norm = (s) => String(s || '').trim().replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

// When a reused clone was last brought up to date. FETCH_HEAD is written by
// every fetch and pull, so its mtime is the moment this checkout last agreed
// with the remote. A clone that has never been pulled has none, and the
// directory's own mtime is then the clone itself.
function repoFetchedAt(dest) {
  for (const rel of ['.git/FETCH_HEAD', '.git']) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- managed clone under userData
      return fs.statSync(path.join(dest, rel)).mtime.toISOString();
    } catch (_) { /* try the next one */ }
  }
  return null;
}

// Clone an https repo URL into a managed userData directory and return the
// local path. The clone persists because installed agents keep repoRoot as
// their working directory. An existing clone is refreshed with a fast-forward
// pull instead of re-cloning. Validation and error wording live in
// src/lib/repo-agents.js. GIT_TERMINAL_PROMPT=0 makes private repos fail fast
// instead of hanging on a credential prompt.
//
// Resolves { ok: true, root, stale, staleReason?, fetchedAt? }. `stale` labels a
// copy returned after a pull that did not succeed, so the surface can say the
// fingerprint was recomputed from a checkout of unknown age. The copy is still
// returned, since an older checkout beats no checkout with no network.
const RepoAgents = require('./lib/repo-agents');
// Clones url into userData/<bucket>, reusing the checkout when it matches.
function cloneRepo(url, bucket) {
  return new Promise((resolve) => {
    const v = RepoAgents.validateRepoUrl(url);
    if (!v.ok) return resolve(v);
    const clonesRoot = path.join(app.getPath('userData'), bucket || 'agent-repos');
    const dest = path.join(clonesRoot, v.dirName);
    const { execFile } = require('child_process');
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

    const cloneFresh = () => {
      try { fs.mkdirSync(clonesRoot, { recursive: true }); } catch (err) {
        return resolve({ ok: false, error: 'Husk cannot write to its data folder (permission denied).' });
      }
      execFile('git', ['clone', '--depth', '1', v.url, dest], { timeout: 120000, env: gitEnv }, (err) => {
        if (err) {
          try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
          return resolve({ ok: false, error: RepoAgents.friendlyCloneError(err) });
        }
        resolve({ ok: true, root: dest, stale: false });
      });
    };

    if (!fs.existsSync(path.join(dest, '.git'))) return cloneFresh();

    // Reuse is conditional on the checkout being the repository that was asked
    // for: the folder name carries a digest of the URL, and the remote is
    // checked before the clone is read.
    execFile('git', ['-C', dest, 'remote', 'get-url', 'origin'], { timeout: 15000, env: gitEnv }, (rErr, stdout) => {
      if (rErr || !sameGitRemote(stdout, v.url)) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
        return cloneFresh();
      }
      execFile('git', ['-C', dest, 'pull', '--ff-only'], { timeout: 60000, env: gitEnv }, (pErr) => {
        if (!pErr) return resolve({ ok: true, root: dest, stale: false });
        resolve({
          ok: true,
          root: dest,
          stale: true,
          staleReason: RepoAgents.friendlyCloneError(pErr),
          fetchedAt: repoFetchedAt(dest),
        });
      });
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
    const cloned = await cloneRepo(root, 'agent-repos');
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
            const name = (parsed.name || stripAgentExt(entry.name)).slice(0, AGENT_NAME_MAX);
            agents.push({
              filename: entryRel,
              name,
              description: (parsed.description || '').slice(0, AGENT_DESC_MAX),
              bodyLength: (parsed.body || '').length,
              // Keyed on the file syncAgentFiles will write.
              alreadyInClaude: fs.existsSync(path.join(CLAUDE_DIR, 'agents', agentFileName(name))),
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
  const installToAllAgents = payload.installToAllAgents !== false;
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
  const skippedExisting = [];
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
      if (installToAllAgents) {
        const dest = path.join(claudeAgentsDir, basename);
        // Never replaces an agent the user already has; collisions are reported.
        try {
          fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
          copiedToClaude.push(dest);
        } catch (err) {
          if (err && err.code === 'EEXIST') skippedExisting.push(basename);
        }
      }
      const id = `profile-imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      list.push({
        id,
        name,
        description: (parsed.description || '').slice(0, AGENT_DESC_MAX),
        systemPrompt: (parsed.body || '').slice(0, AGENT_PROMPT_MAX),
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
  if (installToAllAgents) {
    try { syncAgentFiles(); distributedTo.push(...installedAgentDirs()); } catch (_) {}
  }
  return {
    ok: true,
    imported: importedIds.length,
    importedIds,
    copiedToClaude,
    // Names the repository shares with agents the user already had. Those files
    // were left alone, and the list says which.
    skippedExisting,
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

// Scans a repository for mcp-servers/, cloning it first when given a URL.
ipcMain.handle('repoMcp:scan', async (_e, payload = {}) => {
  let root = String((payload && payload.root) || '').trim();
  if (!root) return { ok: false, error: 'a repository URL or a folder path is required' };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(root)) {
    const cloned = await cloneRepo(root, 'mcp-repos');
    if (!cloned.ok) return cloned;
    root = cloned.root;
  } else if (!path.isAbsolute(root)) {
    return { ok: false, error: 'a repository URL or an absolute folder path is required' };
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
    // --ignore-scripts holds the install to fetching packages. MCP servers that
    // need a native build run it through the explicit `build` script below.
    const args = script === 'install'
      ? ['install', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['run', script];
    let proc;
    try {
      // The command is resolved from PATH rather than left as a bare name.
      proc = spawn(spawnName('npm'), args, { cwd: dir, env: process.env, windowsHide: true });
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
//   kiro-cli → snippet only (kiro-cli mcp add), no write yet
//
// Per-target results are independent. A failure in one does not block
// the others. The renderer paints a per-target status pill from the
// returned `results` map.
const SNIPPET_TARGETS = new Set(['codex', 'aider', 'kiro-cli']);
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
        : (target === 'kiro-cli' ? RepoMcp.renderKiroSnippet(serverId, spec) : RepoMcp.renderAiderSnippet(serverId, spec));
      results[target] = { status: 'snippet', snippet };
      continue;
    }
    // Real write path: hand off to the per-CLI adapter. add() refuses
    // duplicates, which is surfaced as an "already installed" status.
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
    name: String(payload.name || 'New Agent').slice(0, AGENT_NAME_MAX),
    description: String(payload.description || '').slice(0, AGENT_DESC_MAX),
    systemPrompt: String(payload.systemPrompt || '').slice(0, AGENT_PROMPT_MAX),
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
      name: payload.name !== undefined ? String(payload.name).slice(0, AGENT_NAME_MAX) : p.name,
      description: payload.description !== undefined ? String(payload.description).slice(0, AGENT_DESC_MAX) : p.description,
      systemPrompt: payload.systemPrompt !== undefined ? String(payload.systemPrompt).slice(0, AGENT_PROMPT_MAX) : p.systemPrompt,
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

// Replaces the active set in one write. The renderer computes the target set,
// so a bulk change over a filtered view costs one config write instead of N.
ipcMain.handle('profiles:setActive', (_e, ids) => {
  const known = new Set(getProfiles().map((p) => p.id));
  const next = (Array.isArray(ids) ? ids : []).filter((id) => known.has(id));
  writeActiveIds(next);
  return { ok: true, activeIds: next };
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
// one round trip, and never persisted, so the stored project record stays the
// small thing the user created. The renderer paints the list first and enriches
// when this lands.
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
    // git decides; the .git entry is the fallback when git cannot be reached.
    let hasGitEntry = false;
    try { hasGitEntry = fs.existsSync(path.join(p.path, '.git')); } catch (_) {}
    try {
      const txt = execFileSync('git', ['-C', p.path, 'status', '--porcelain=v1', '--branch'], {
        encoding: 'utf8', stdio: 'pipe', timeout: 4000, maxBuffer: 4 * 1024 * 1024,
      });
      st.isGit = true;
      Object.assign(st, parseGitStatus(txt));
    } catch (_) {
      st.isGit = hasGitEntry;
    }
  }
  return { ok: true, states, groups: groupBoard(projects, states, Date.now()) };
});

// Workspace-only detail for one project: the latest commit and the MCP servers
// this folder actually runs. Kept out of projects:state because the board never
// shows these; one git call per project would be paid for nothing.
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
    // What the agent actually gets in this folder: the global list with this
    // project's overrides applied. Each row carries where it came from so the
    // panel can separate an inherited server from one this project chose.
    const resolved = resolveProjectMcp(p.path);
    out.mcpServers = resolved.servers.map((s) => s.id).slice(0, 24);
    out.mcpRows = resolved.rows.filter((r) => r.on).slice(0, 24).map((r) => ({ id: r.id, source: r.source }));
    out.mcpExcluded = resolved.excluded.slice(0, 24);
    out.mcpCustomized = resolved.customized;
    out.mcpSupported = !!ProjectMcp.agentKind(config.agentCommand);
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
// both the supplied path and the prompts directory, then requiring the resolved
// file to live directly under it.
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

// Frontmatter plus body for one prompt, rendered the way create writes it so
// an edited file is byte-identical in shape to a freshly created one.
function renderPromptMd(name, description, content) {
  const safeDesc = String(description).trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const body = String(content || '').trim() || `# ${name}\n\n${String(description).trim()}\n`;
  return `---\nname: ${name}\ndescription: "${safeDesc}"\n---\n\n${body}\n`;
}

// Resolve a caller-supplied prompt path against the prompts directory.
function resolvePromptPath(mdPath) {
  if (!mdPath || typeof mdPath !== 'string') return { error: 'Missing path' };
  const root = path.resolve(HUSK_PROMPTS_DIR);
  const target = path.resolve(mdPath);
  if (!target.startsWith(root + path.sep)) return { error: 'Refusing to touch a file outside the prompts directory' };
  return { target, root };
}

// Edit an existing prompt in place. A renamed prompt moves to the file its new
// name implies, and a disabled one stays disabled, so editing never silently
// switches a prompt back on.
ipcMain.handle('prompts:update', (_e, payload = {}) => {
  const { mdPath, name, description, content } = payload;
  const resolved = resolvePromptPath(mdPath);
  if (resolved.error) return { ok: false, error: resolved.error };
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: 'Name must be lowercase letters, digits, dashes; start with a letter.' };
  }
  if (!description || !String(description).trim()) {
    return { ok: false, error: 'Description is required.' };
  }
  try {
    const { target, root } = resolved;
    const disabled = target.endsWith('.disabled');
    const nextPath = path.join(root, `${name}.md${disabled ? '.disabled' : ''}`);
    const body = renderPromptMd(name, description, content);
    if (nextPath === target) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to the prompts dir above
      fs.writeFileSync(target, body, { mode: 0o644 });
    } else {
      // A rename claims the new name through the create itself: 'wx' fails when
      // the file exists. The enabled and disabled forms are both claimed, since
      // they are the same prompt.
      const twin = nextPath.endsWith('.disabled')
        ? nextPath.slice(0, -'.disabled'.length)
        : `${nextPath}.disabled`;
      let fd;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are inside the prompts dir
        fd = fs.openSync(nextPath, 'wx', 0o644);
      } catch (err) {
        if (err && err.code === 'EEXIST') return { ok: false, error: `A prompt named "${name}" already exists.` };
        throw err;
      }
      // The other form of the same name is claimed the same way, then given
      // straight back.
      let twinFd;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are inside the prompts dir
        twinFd = fs.openSync(twin, 'wx', 0o644);
      } catch (err) {
        try { fs.closeSync(fd); } catch (_) {}
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are inside the prompts dir
        try { fs.unlinkSync(nextPath); } catch (_) {}
        if (err && err.code === 'EEXIST') return { ok: false, error: `A prompt named "${name}" already exists.` };
        throw err;
      }
      try { fs.closeSync(twinFd); } catch (_) {}
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths are inside the prompts dir
      try { fs.unlinkSync(twin); } catch (_) {}
      try { fs.writeSync(fd, body); } finally { try { fs.closeSync(fd); } catch (_) {} }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to the prompts dir above
      fs.unlinkSync(target);
    }
    return { ok: true, id: path.basename(nextPath), path: nextPath, mdPath: nextPath };
  } catch (err) {
    // A prompt that is not there is reported by the operation that reached for
    // it.
    if (err && err.code === 'ENOENT') return { ok: false, error: 'Prompt file not found' };
    return { ok: false, error: err.message };
  }
});

// Create a new Husk prompt. Always writes to HUSK_PROMPTS_DIR regardless of
// agentKind, unlike skills:create, which routes by agent.
ipcMain.handle('prompts:create', (_e, payload = {}) => {
  const { name, description, content } = payload;
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: 'Name must be lowercase letters, digits, dashes; start with a letter.' };
  }
  if (!description || !description.trim()) {
    return { ok: false, error: 'Description is required.' };
  }
  const md = renderPromptMd(name, description, content);
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
  // Confined to the skills and prompts roots.
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
  // Escape backslashes before quotes so YAML double-quoted strings parse.
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
    // Atomic create-if-not-exists via O_EXCL. Throws EEXIST when the path is
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

// Resolve a validated installed plugin's install path, confined to the plugins
// root. Returns null when unknown or outside the root.
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
  // buildPluginCliArgs owns the verb allowlist and the id validation
  // (isSafePluginId); null means one of them failed. The id rides as a single
  // argv element with no shell.
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
  // Confine to the plugin dir, then read through one descriptor.
  if (!realPathInside(abs, installPath)) return { ok: false, error: 'file not found' };
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
  if (!realPathInside(abs, installPath)) return { ok: false, error: 'file not found' };
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

// Decode an encoded project dir name back to a real on-disk path. The CLI's
// encoding turns '/' into '-', so a directory name containing a literal dash
// reads the same as a separator. Try the all-slash interpretation first, then BFS
// over "merge adjacent segments with a dash" combinations and return the first
// that exists.
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

// Whether a transcript holds any human-typed turn, used to tell a real chat
// (keep) from a purely SDK-driven background transcript (hide) when the 32KB
// head was inconclusive. A real chat's first human turn can sit past the head
// when an SDK context turn was prepended, so the whole file is scanned. Past the
// cap a file is kept rather than hidden.
const HUMAN_SCAN_CAP = 4 * 1024 * 1024;
function transcriptHasHumanTurn(fullPath, fileSize) {
  if (fileSize > HUMAN_SCAN_CAP) return true;
  let text = '';
  try { text = fs.readFileSync(fullPath, 'utf8'); } catch (_) { return true; }
  return text.includes('"kind":"human"') || text.includes('"promptSource":"typed"');
}

// Agents append a title entry to the transcript once the conversation earns a
// name, and further entries as they refine it. Both land wherever the
// conversation had reached, which in a long session is far past the head.
//
// Scan forward from wherever the last read stopped and keep the newest title, so
// a poll costs the bytes appended since the previous poll rather than the size of
// the whole transcript.
//
// The shape of the entry differs per CLI, so a dialect supplies a cheap
// substring to prefilter lines on and an extractor to pull the title out.
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

  // Open once and measure the descriptor, so the size and the bytes describe the
  // same file.
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
  // cwd and a fresh timestamp, but never emit that preamble.
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
        // "<command-name>", a caveat banner, a system-reminder), which are not
        // human messages, and keep scanning for a real one.
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
// Copilot session state is polled from several places (title sync, Recent list,
// stats), so both readers below are cached on file identity (size + mtime):
// unchanged files parse once, and a poll cycle degrades to stat() calls.
const copilotWorkspaceCache = new Map(); // dir -> { sig, ws }
const copilotTitleCache = new Map(); // dir -> { sig, value }
const COPILOT_CACHE_MAX = 4000;

function readCopilotWorkspace(dir) {
  const yamlPath = path.join(dir, 'workspace.yaml');
  // The cache signature and the contents both come from one descriptor.
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
    // The CLI creates a session directory at launch and writes events.jsonl only
    // once the conversation starts, so a chat opened and closed without a turn
    // leaves a directory that holds nothing and cannot be resumed. It is listed
    // only for callers that bind a live tab to its session.
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
      // Tab discovery prefers a session that carries content, since an empty one
      // can never earn a name.
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

  // A PRD is created moments after the session that runs it starts, so match
  // only near the session start rather than anywhere in its lifetime.
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
      // promptSource "typed" / origin.kind "human" on at least one turn, and a
      // purely SDK-driven background transcript carries only "sdk". Accumulated
      // across every turn in the head, since an SDK context turn can be
      // prepended to a real chat.
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
          // Short-circuit only when the head is partial (a big file), where the
          // title fields are already in hand. For a small file that fits
          // entirely in the window, keep scanning so sawAssistant is decided
          // over the whole file, which the receipt-skip below reads.
          if (!headComplete && aiTitle && startedISO && userMessage && originalCwd) break;
        }
      } catch (_) {}
      // Husk drives claude over the SDK, and every enqueued prompt also writes a
      // tiny queue-operation receipt file with no assistant turn, shadowing a
      // prompt that ran in the real session file. A file whose whole head fits
      // in the read window and carries no assistant turn is such a receipt: skip
      // it, since real conversations always have assistant output.
      if (headComplete && !sawAssistant) continue;

      // The Sessions list is for chats the user actually held. Husk also spawns
      // claude over the SDK for background work (framework hooks that shell out
      // to `claude --print`, the autopilot and workflow orchestrators), and each
      // leaves a transcript in this same projects dir. A transcript with SDK
      // turns and no human turn anywhere is such a run: skip it. When the head
      // was inconclusive on a larger file, scan the whole file first, since a
      // real chat can open with a prepended SDK context turn. Files that predate
      // promptSource carry no signal and are kept.
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

  // Deduplicate Claude's shadow/sidecar JSONL files: one conversation can persist
  // several (queue snapshots, resume shadows) sharing the same first user prompt
  // and ai-title. Group by (project, title, firstMessage) and keep the largest,
  // since the canonical session grows past its shadows.
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
      // session under session-state, since this path polls every few seconds per
      // open tab. The id is validated before it is joined onto a path.
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
    // started. Two rules pick between them.
    //
    // The tab launches the CLI, so its session cannot predate it. Sessions that
    // started before the tab belong to an earlier chat and are only considered
    // when nothing started after it, with a little slack for clock skew.
    //
    // Prefer a session that carries content. The CLI can create several session
    // directories for one chat and write the conversation into only the last, so
    // the empty ones left behind can never earn a name.
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
      // cwd and this minute, and carry a title describing a different
      // conversation.
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
//
// A session a background agent is still holding is the one case where the
// resume form is not the answer. The CLI owns that transcript for as long as
// the agent lives and refuses a second reader, so the command that opens it is
// an attach, and the command that opens a copy of it forks. Both are named
// here, where the state is, rather than guessed by a surface after the refusal
// has already been printed into a terminal.
ipcMain.handle('sessions:resumeCommand', async (_e, payload = {}) => {
  const agent = String(payload.agent || activeAgentName()).trim().toLowerCase();
  const id = String(payload.id || '');
  if (!id) return { ok: false, error: 'no session id' };
  if (agent === 'claude') {
    const holder = await sessionHolder(id);
    const fork = `claude --resume ${id} --fork-session`;
    if (holder && holder.kind === 'background') {
      return {
        ok: true,
        mode: 'attach',
        command: `claude attach ${holder.id}`,
        forkCommand: fork,
        agentId: holder.id,
        agentName: holder.name,
        agentState: holder.state,
        cwd: holder.cwd,
      };
    }
    // A chat open in another window. There is no id to attach to, so the copy
    // is the only way in, and it is named as a copy rather than offered as a
    // resume that would be refused.
    if (holder) {
      return {
        ok: true,
        mode: 'fork',
        command: fork,
        forkCommand: fork,
        agentName: holder.name,
        cwd: holder.cwd,
      };
    }
    return { ok: true, mode: 'resume', command: `claude --resume ${id}` };
  }
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
// top-level sessions rather than turns inside the chat, so they surface as peers
// in a naive session listing, and the CLI points at its own picker rather than
// resuming one while it is still running.

// The parent a background agent was forked from. Two records carry it and
// neither is sufficient alone: the transcript's snake_case `session_id` names
// the process that wrote the line, so on a forked file it keeps naming the
// parent while `sessionId` names the child, but only once the agent has written
// a turn. The daemon roster is exact from spawn and dropped at exit. Together
// they cover the whole lifetime.
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

// Where a session's transcript actually lives. An agent can belong to any
// project on the machine (the map lists them all), so the lookup starts at the
// project dir its own cwd names and then scans the projects root once. Bounded:
// one readdir over a directory with one entry per project.
function bgFindTranscript(sessionId, cwdHint) {
  const id = String(sessionId || '');
  if (!/^[0-9a-fA-F-]{16,}$/.test(id)) return '';
  const name = `${id}.jsonl`;
  const projRoot = path.join(CLAUDE_DIR, 'projects');
  if (cwdHint) {
    const p = path.join(projRoot, String(cwdHint).replace(/[^a-zA-Z0-9]/g, '-'), name);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const dir of fs.readdirSync(projRoot)) {
      const p = path.join(projRoot, dir, name);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return '';
}

// The working directory a transcript was recorded in, read off its head lines.
// Resuming from anywhere else makes the CLI deny the session exists.
function bgTranscriptCwd(transcript) {
  try {
    const head = readHead(transcript, 256 * 1024);
    for (const line of head.split('\n')) {
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) { try { return JSON.parse(`"${m[1]}"`); } catch (_) { return m[1]; } }
    }
  } catch (_) {}
  return '';
}

// The CLI's own inventory of what it is running, parsed once. Both the fleet
// list and the question "is this session busy" read the same answer, so the two
// can never disagree about which agent is live.
async function bgAgentRows({ cwd = '', all = false, allProjects = false, timeout = 8000 } = {}) {
  const args = ['agents', '--json'];
  // Background agents belong to the machine, not to one project. The fleet
  // surfaces ask for all of them; anything scoped passes its own directory.
  if (cwd && !allProjects) args.push('--cwd', cwd);
  if (all) args.push('--all');
  const env = buildAgentEnv();
  const exe = resolveAgentExe('claude', env.PATH);
  let raw = '';
  try {
    raw = await new Promise((resolve, reject) => {
      execFile(exe, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout || ''));
      });
    });
  } catch (err) {
    return { ok: false, rows: [], error: (err && err.message) || 'could not list agents' };
  }
  let rows = [];
  try { rows = JSON.parse(raw); } catch (_) {
    return { ok: false, rows: [], error: 'agent list was not readable' };
  }
  return { ok: true, rows: Array.isArray(rows) ? rows : [] };
}

// Whether a process is still there. Signal 0 delivers nothing and only asks;
// EPERM is a process this user does not own, which is still a process.
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}

// Who is holding a session right now, when anybody is. A held session cannot be
// resumed: the CLI will not open a second reader on a transcript a live process
// is writing, and says so instead of opening.
//
// The test is the process, not the reported state. A background agent that has
// finished its turn reports state "done" and keeps its pid, because the agent
// is idle rather than gone, and it holds the session for exactly as long as
// that process lives. Reading the state word here would call that session free
// and hand back a command the CLI refuses. An interactive row is a chat open
// somewhere else, which is held the same way and has no agent id to attach to.
//
// The probe is short and every failure answers "nobody is holding it". A slow
// or missing CLI must not turn opening a session into a stall, and the resume
// that answer falls back to is what this path did before the question existed.
async function sessionHolder(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const res = await bgAgentRows({ all: true, allProjects: true, timeout: 3000 });
  if (!res.ok) return null;
  for (const r of res.rows) {
    if (!r || String(r.sessionId || '') !== id) continue;
    if (!pidAlive(r.pid)) continue;
    const background = r.kind === 'background';
    return {
      kind: background ? 'background' : 'interactive',
      // Only a background agent has an id the CLI will attach to.
      id: background ? String(r.id || id.slice(0, 8)) : '',
      sessionId: id,
      name: String(r.name || '').slice(0, 120),
      state: String(r.state || ''),
      status: String(r.status || ''),
      cwd: String(r.cwd || ''),
    };
  }
  return null;
}

ipcMain.handle('bgAgents:list', async (_e, payload = {}) => {
  const agent = activeAgentName();
  // A CLI with no agent concept reports that it has none.
  if (agent !== 'claude') return { ok: true, supported: false, agents: [] };
  const cwd = String((payload && payload.cwd) || activePtyCwd || '').trim();
  const listed = await bgAgentRows({
    cwd,
    all: !!(payload && payload.all),
    allProjects: !!(payload && payload.allProjects),
  });
  if (!listed.ok) return { ok: false, supported: true, agents: [], error: listed.error };
  const rows = listed.rows;
  if (!rows.length) return { ok: true, supported: true, agents: [], chats: [] };
  // The chats an agent can descend from. They are listed alongside agents but
  // are not agents, so they travel separately and only the graph reads them.
  const chats = rows
    .filter((r) => r && r.kind === 'interactive' && r.sessionId)
    .map((r) => ({
      id: String(r.sessionId).slice(0, 8),
      sessionId: String(r.sessionId),
      name: String(r.name || '').slice(0, 120),
      cwd: String(r.cwd || ''),
      status: String(r.status || ''),
      startedAt: Number(r.startedAt) || 0,
    }));
  const agents = rows
    .filter((r) => r && r.kind === 'background' && r.sessionId)
    .map((r) => {
      const shortId = String(r.id || String(r.sessionId).slice(0, 8));
      const job = bgAgentJobState(shortId);
      // Resolved against the agent's own project, not the asking chat's, so an
      // agent from another project still finds its transcript.
      const transcript = bgFindTranscript(String(r.sessionId), String(r.cwd || '') || cwd);
      let lastActivityAt = 0;
      if (transcript) { try { lastActivityAt = Math.round(fs.statSync(transcript).mtimeMs); } catch (_) {} }
      return {
        id: shortId,
        sessionId: String(r.sessionId),
        name: String(r.name || '').slice(0, 120),
        cwd: String(r.cwd || ''),
        // Live means working or waiting on the user. Every other reported
        // state has stopped.
        running: agentIsLive(r.state),
        // A live agent is reached by attaching to it; a stopped one resumes
        // from its transcript like any other chat.
        attachable: agentIsLive(r.state),
        // Whether the session is spoken for, which is a different question from
        // whether the agent is mid-turn. An idle agent still owns its
        // transcript for as long as its process lives, and the CLI refuses to
        // resume a session anything is holding.
        held: pidAlive(r.pid),
        status: String(r.status || ''),
        state: String(r.state || ''),
        detail: job.detail || '',
        intent: job.intent || '',
        needs: job.needs || '',
        tokens: job.tokens || 0,
        startedAt: Number(r.startedAt) || 0,
        updatedAt: Math.max(job.updatedAt || 0, lastActivityAt),
        parentSessionId: transcript ? bgAgentParent(String(r.sessionId), path.dirname(transcript)) : '',
        // An agent can be listed and running with nothing on disk yet, so the
        // caller must not treat a missing transcript as a missing agent.
        hasTranscript: !!transcript,
        transcript,
      };
    });
  return { ok: true, supported: true, agents, chats };
});

// The tail of one agent's conversation, compacted to what a human skims: what
// it said last, which tools it reached for, what it was asked. Read fresh per
// call off the transcript tail, so the detail pane can poll it while the agent
// works and the feed moves in near real time.
const BG_PEEK_TAIL_BYTES = 192 * 1024;
ipcMain.handle('bgAgents:peek', (_e, payload = {}) => {
  const sessionId = String((payload && payload.sessionId) || '').trim();
  if (!/^[0-9a-fA-F-]{16,}$/.test(sessionId)) return { ok: false, error: 'no session' };
  const transcript = bgFindTranscript(sessionId, String((payload && payload.cwd) || ''));
  if (!transcript) return { ok: true, entries: [], model: '', empty: true };
  let text = '';
  let size = 0;
  try {
    const fd = fs.openSync(transcript, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    try {
      size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - BG_PEEK_TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(size, BG_PEEK_TAIL_BYTES));
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8', 0, n);
      // A mid-file start lands inside a line; drop the partial one.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const entries = [];
  let model = '';
  const clip = (s, max) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
  };
  // One-line summary of a tool call: the argument a human would use to name
  // it. Paths keep their tail, the interesting part, rather than the noise
  // of a temp prefix.
  const toolArg = (input) => {
    if (!input || typeof input !== 'object') return '';
    for (const k of ['file_path', 'path']) {
      if (typeof input[k] === 'string' && input[k]) {
        const segs = input[k].split(/[\\/]/).filter(Boolean);
        return clip(segs.slice(-2).join('/'), 72);
      }
    }
    const keys = ['command', 'pattern', 'query', 'url', 'description', 'prompt'];
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return clip(input[k], 80);
    return '';
  };
  for (const line of text.split('\n')) {
    if (!line || line.length > 2 * 1024 * 1024) continue;
    let o = null;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o !== 'object') continue;
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (typeof c === 'string' && c.trim()) {
        entries.push({ kind: 'user', text: clip(c, 200), ts });
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (part && part.type === 'text' && String(part.text || '').trim()) {
            entries.push({ kind: 'user', text: clip(part.text, 200), ts });
            break;
          }
        }
      }
    } else if (o.type === 'assistant' && o.message) {
      if (typeof o.message.model === 'string') model = o.message.model;
      const c = o.message.content;
      if (!Array.isArray(c)) continue;
      for (const part of c) {
        if (!part) continue;
        if (part.type === 'text' && String(part.text || '').trim()) {
          entries.push({ kind: 'assistant', text: clip(part.text, 240), ts });
        } else if (part.type === 'tool_use') {
          entries.push({ kind: 'tool', tool: clip(part.name, 40), text: toolArg(part.input), ts });
        }
      }
    }
  }
  return { ok: true, entries: entries.slice(-24), model, empty: entries.length === 0 };
});

// How to reach one agent, validated before it is handed back the way copilot and
// gemini already are, so the command opens onto something.
ipcMain.handle('bgAgents:openCommand', (_e, payload = {}) => {
  const agent = activeAgentName();
  if (agent !== 'claude') return { ok: false, error: `background agents are not available for ${agent}` };
  const id = String((payload && payload.id) || '').trim();
  const sessionId = String((payload && payload.sessionId) || '').trim();
  // The transcript names the only directory the CLI will resume this session
  // from. Found wherever it lives, so opening works from any project, and the
  // tab is told to start there instead of in the asking chat's directory.
  const hint = String((payload && payload.cwd) || activePtyCwd || '');
  const transcript = sessionId ? bgFindTranscript(sessionId, hint) : '';
  return bgOpenCommand({
    id,
    sessionId,
    attach: !!(payload && payload.attach),
    transcript,
    cwd: (transcript && bgTranscriptCwd(transcript)) || String((payload && payload.cwd) || ''),
  });
});

// End one agent. `stop` halts the worker and keeps the conversation; `remove`
// discards the job and its worktree.
ipcMain.handle('bgAgents:control', async (_e, payload = {}) => {
  const agent = activeAgentName();
  if (agent !== 'claude') return { ok: false, error: `background agents are not available for ${agent}` };
  const plan = bgControlArgs(payload && payload.action, payload && payload.id);
  if (!plan.ok) return plan;
  const env = buildAgentEnv();
  const exe = resolveAgentExe('claude', env.PATH);
  try {
    const out = await new Promise((resolve, reject) => {
      execFile(exe, plan.args, { env, timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message || '').trim() || 'the agent did not stop'));
        else resolve(String(stdout || '').trim());
      });
    });
    return { ok: true, action: plan.args[0], id: plan.args[1], message: out.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'the agent did not stop' };
  }
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

// Reads a PRD, confined to the work directory.
ipcMain.handle('sessions:read', (_e, prdPath) => {
  if (typeof prdPath !== 'string' || !prdPath) return { ok: false, error: 'Missing path' };
  const workDir = path.join(CLAUDE_DIR, 'MEMORY', 'WORK');
  if (!isInside(workDir, prdPath) || !realPathInside(prdPath, workDir)) {
    return { ok: false, error: 'Refusing to read outside the work directory' };
  }
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
  // Only removes files inside the CONTEXT dir.
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
    // Require a plain file name: no leading "..", no separators, no control
    // characters.
    const baseName = path.basename(sourcePath);
    if (!baseName || baseName.startsWith('..') || /[\/\\]/.test(baseName)) {
      return { ok: false, error: 'Invalid file name' };
    }
    if (/[\x00-\x1F\x7F-\x9F]/.test(baseName)) {
      return { ok: false, error: 'That file name contains control characters' };
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
    const buf = fs.readFileSync(sourcePath);
    const fd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
      | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
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
// Backs the Files page: a fuzzy-searchable index, inline preview, and git
// decoration. Every read is confined under `root` via path-confine.
const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024; // 2 MB: past this the renderer would jank
const FILE_INDEX_MAX = 20000;                    // cap the flat index so search stays instant
const { detectLanguage } = require('./lib/lang-detect');

// A path is safe to read when it resolves inside root. resolveInside throws on
// an absolute path, one that climbs out of root, or one carrying a null byte,
// and all three become a uniform error.
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
  // confinedAbs proves the path string is inside root; canonicalize and re-check
  // so the resolved target is inside root too.
  try {
    const real = fs.realpathSync(abs);
    if (!isInside(path.resolve(root), real)) return { ok: false, error: 'path outside root' };
  } catch (_) { return { ok: false, error: 'could not resolve path' }; }
  // Open without following a final-component symlink, then stat and read through
  // the same handle, so the canonicalized path checked above and the bytes
  // returned are the same file object. O_NOFOLLOW is POSIX-only; elsewhere the
  // realpath check above is the guard.
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
// symlink-guarded like readFile. Takes an optional `expectMtimeMs`: when the file
// on disk has changed since the editor loaded it, the write is refused as a
// conflict unless `force` is set.
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
    // New file: confine its parent instead.
    if (!realParentInside(abs, root)) return { ok: false, error: 'path outside root' };
  }
  try {
    let current = null;
    try { current = fs.lstatSync(abs); } catch (_) { current = null; }
    if (current) {
      if (current.isSymbolicLink()) return { ok: false, error: 'path is a symbolic link' };
      if (!current.isFile()) return { ok: false, error: 'not a file' };
      if (!force && typeof expectMtimeMs === 'number' && Math.abs(current.mtimeMs - expectMtimeMs) > 1) {
        return { ok: false, error: 'conflict', reason: 'This file changed on disk since you opened it (the agent may have edited it). Reload to see the new version, or save anyway to overwrite it.' };
      }
    }
    const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC
      | (fs.constants.O_NOFOLLOW || 0), 0o644);
    try { fs.writeFileSync(fd, content, 'utf8'); } finally { fs.closeSync(fd); }
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

// Unified git diff for one file (staged + unstaged). Path confined, and passed
// as a pathspec after `--`.
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
//   - macOS: the built-in `say` command, with no install or download. The Piper
//     binary is x86_64 ELF and does not run on Darwin, so the darwin branch uses
//     `say` and never installs Piper.

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
// Expected sha256 of the release assets above.
const PIPER_SHA256 = IS_WIN
  ? 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea'
  : 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992';
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
      // Private staging directory per install.
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husk-piper-'));
      const archivePath = path.join(stageDir, IS_WIN ? 'piper.zip' : 'piper.tar.gz');
      const cleanup = () => { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {} };
      try {
        await runStep('curl', ['-fsSL', '-o', archivePath, PIPER_RELEASE], 'Downloading Piper binary');

        // Checked before extraction.
        const got = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
        if (got !== PIPER_SHA256) {
          return { ok: false, error: 'The downloaded voice engine did not match its expected checksum, so it was discarded. Nothing was installed.' };
        }

        await runStep('tar', ['-xf', archivePath, '-C', HUSK_DATA], 'Extracting Piper');
      } finally { cleanup(); }
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
  // No web installer is shipped, so the feed may not name one.
  autoUpdater.disableWebInstaller = true;

  // Route the updater's log to a file. It defaults to `console`, whose output is
  // unreachable for a GUI-launched app.
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

  // Fire one check shortly after launch and again every 6 hours. Both timers are
  // stored and unref'd so they can be cleared at quit and never pin the event
  // loop open after the window closes.
  updaterInitialTimer = setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 4000);
  updaterInitialTimer.unref();
  updaterPeriodicTimer = setInterval(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 6 * 60 * 60 * 1000);
  updaterPeriodicTimer.unref();
}

// Synchronous on purpose. The preload reads this at document start and stamps
// the theme onto <body> the moment it exists, which is what keeps a light
// install from painting index.html's baked-in dark default first.
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
  // relaunch by hand. Called inline and reported on: on Linux the install shells
  // out to the package manager through pkexec, and those failures reach the
  // renderer rather than being swallowed here.
  updateInstallAttempted = true;
  try {
    updaterInstance.quitAndInstall(false, true);
    // A successful install quits the app, so reaching this line means the
    // package manager declined. electron-updater reports that through its
    // 'error' event, which the handler above turns into an 'install' failure.
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

// Only one Husk at a time. A second launch focuses the existing window instead
// of spawning another process tree.
const gotLock = app.requestSingleInstanceLock();
// The running instance records its version here so a second launch can tell a
// repeat double-click (same version: focus and stay silent) from a launch of a
// different version (warn, since the new binary quits and the running window
// takes focus).
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
  });
  app.on('window-all-closed', () => {
    killPtyTree(); stopNullVoiceServer(); stopStatuslineRefresh(); stopUsageRefresh(); stopAutoUpdater();
    // Exit hard. app.quit()'s graceful teardown waits for the GPU and renderer
    // processes to exit, which on a real compositor can hang and leave the main
    // process alive with no window. app.exit() terminates immediately.
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
