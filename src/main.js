// Husk: Electron main process.
// Wraps a configurable agent CLI via node-pty and exposes pages: chat, skills, sessions, files, preferences.

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const pty = require('node-pty');

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
let ptyProc = null;

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
  // Kick off once on startup, then every 30s.
  refreshStatuslineCacheOnce();
  statuslineTimer = setInterval(refreshStatuslineCacheOnce, 30000);
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

function bootstrapPaiIfNeeded() {
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
    // semantics). This is the key fix: previously the whole bootstrap was
    // gated on CLAUDE.md absence, which meant users who had ever installed
    // claude code (which creates ~/.claude/CLAUDE.md) got NONE of the
    // bundled skills, agents, or hooks. Now each subdir is checked
    // independently and missing entries are added without ever overwriting
    // a file the user already has.
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
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Husk',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      zoomFactor: 1.0,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools', accelerator: 'F12' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
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
function killPtyTree() {
  if (!ptyProc) return;
  const pid = ptyProc.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch (_) {}
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  // Escalate to SIGKILL after a short grace period
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
    try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  }, 250);
  try { ptyProc.kill('SIGKILL'); } catch (_) {}
  ptyProc = null;
}

// ─── PTY ─────────────────────────────────────────────────────────────────────────

// POSIX-shell-quote one argument: 'value' with internal single-quotes escaped
// as '\\''. Use to serialize an (exe, argv) tuple back into a string we can
// hand to /bin/sh -c or /usr/bin/script -q -c. Not used on Windows.
function shJoin(exe, args) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return [exe, ...args.map(q)].join(' ');
}

function spawnPty(cols = 100, rows = 30, overrideCmd = null, overrideCwd = null) {
  if (ptyProc) try { ptyProc.kill(); } catch (_) {}
  const shellBin = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : (process.env.SHELL || '/bin/bash');
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLAUDE_DIR,
    // Marker so PAI hooks/statusline can suppress duplicate chrome (ATLAS
    // dashboard, neofetch banner, inline statusline) that Husk's right
    // panel already surfaces. PAI side checks $HUSK_HOST and early-exits.
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
  const isWin32 = process.platform === 'win32';
  if (!isWin32 && /^claude(\.cmd|\.exe)?$/i.test(agentExe) && !agentArgs.includes('--settings')) {
    // We deliberately no longer inject --settings <ephemeral-temp-file>.
    // That path made claude treat the temp file as the canonical settings,
    // wrote folder-trust changes there, and on next launch we regenerated
    // the temp file from the user's real settings.json, blowing the trust
    // away. claude also hid the "Yes, and remember" trust option because
    // it detected the ephemeral path.
    //
    // The price of dropping the override: claude renders its own inline
    // statusline at the bottom of the terminal, alongside Husk's right
    // panel. Acceptable duplication, the user gets persistent trust,
    // skill-listing budget reverts to the claude default.
    const agentName = (config.agentName || 'Husk').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) || 'Husk';
    const huskPromptParts = [
      `You are running inside Husk, a desktop wrapper. The user has named this agent ${agentName}. When asked your name or identity, respond as ${agentName} (no other persona). Use "🗣️ ${agentName}:" if you emit a speech-balloon line. Otherwise follow your normal CLAUDE.md, PAI/Algorithm, and memory-file instructions exactly. Including the full reasoning, banner format, TASK/CHANGE/VERIFY structure, and recap behavior.`,
    ];
    if (config.recap === false) {
      huskPromptParts.push(`The user has disabled recaps in Husk. Suppress any "* recap:" line and end-of-response summary footer for this session.`);
    }
    const huskPrompt = huskPromptParts.join(' ');
    agentArgs = ['--append-system-prompt', huskPrompt, ...agentArgs];
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

  // Establishing the controlling terminal is platform-specific:
  //  - Linux:   wrap with GNU script(1) `script -q -c <cmd> /dev/null` so
  //             node-pty gets a proper setsid + TIOCSCTTY (otherwise
  //             `claude --resume <id>` exits with code 129).
  //  - macOS:   sh -c <cmd>; node-pty handles the tty on Darwin, and BSD
  //             script(1) does NOT accept -c.
  //  - Windows: cmd.exe /c <user's raw agentCommand>. Direct pty.spawn of
  //             'claude' fails because Win32 CreateProcess does NOT honor
  //             PATHEXT, it only finds .exe, never .cmd / .bat / .ps1, and
  //             npm-installed CLIs land as claude.cmd shims. Going through
  //             cmd.exe means PATHEXT resolves and the .cmd is found.
  //             Trade-off: we can't safely inject our long --append-system-
  //             prompt because cmd.exe's quoting plus node-pty's argv-to-
  //             cmdline serializer would fragment it. v0.3.0 will resolve
  //             via `where claude` and re-enable injection.
  let exe; let argv;
  if (!rawCmd) {
    // No agent command configured at all: drop into an interactive shell.
    exe = shellBin;
    argv = isWin32 ? [] : ['-i'];
  } else if (isWin32) {
    exe = process.env.ComSpec || 'cmd.exe';
    argv = ['/c', rawCmd];
  } else {
    const cmdStr = shJoin(agentExe, agentArgs);
    if (process.platform === 'darwin') {
      exe = '/bin/sh';
      argv = ['-c', cmdStr];
    } else if (fs.existsSync('/usr/bin/script')) {
      exe = '/usr/bin/script';
      argv = ['-q', '-c', cmdStr, '/dev/null'];
    } else {
      exe = '/bin/sh';
      argv = ['-c', cmdStr];
    }
  }

  ptyProc = pty.spawn(exe, argv, { name: 'xterm-256color', cols, rows, cwd, env });
  activePtyCwd = cwd;
  ptyProc.onData((data) => { if (mainWindow) mainWindow.webContents.send('pty:data', data); });
  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow) mainWindow.webContents.send('pty:exit', exitCode);
    ptyProc = null;
  });
}

let activePtyCwd = null;

// Read the most-recent claude session JSONL for the active PTY cwd and
// return a coarse usage estimate: turn count + a token estimate based on
// total content characters (chars/4 is the common heuristic). This is the
// only honest "session usage" Husk can show, since the agent process owns
// the real token counter and only writes it to usage-cache.json if PAI's
// statusline is wired up. No statusline → 0% forever.
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
        try { return { p, mtime: fs.statSync(p).mtimeMs }; } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    const latest = files[0].p;
    const raw = fs.readFileSync(latest, 'utf8').split('\n').filter(Boolean);
    let turns = 0;
    let chars = 0;
    for (const line of raw) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' || obj.type === 'assistant') turns++;
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
    return { turns, chars, tokens: Math.round(chars / 4), file: latest };
  } catch (_) { return null; }
}

ipcMain.handle('pty:start', (_e, { cols, rows }) => { spawnPty(cols, rows); return true; });
ipcMain.on('pty:write', (_e, data) => { if (ptyProc) ptyProc.write(data); });
ipcMain.on('pty:resize', (_e, { cols, rows }) => { if (ptyProc) try { ptyProc.resize(cols, rows); } catch (_) {} });
ipcMain.handle('pty:restart', (_e, { cols, rows, command, cwd }) => {
  spawnPty(cols || 100, rows || 30, command || null, cwd || null);
  return true;
});

// ─── Config IPC ──────────────────────────────────────────────────────────────────

ipcMain.handle('config:get', () => ({ ...config }));
ipcMain.handle('config:set', (_e, partial) => {
  config = { ...config, ...partial };
  saveConfig(config);
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
const CLAUDE_USER_CONFIG = path.join(HOME, '.claude.json');

function readClaudeUserConfig() {
  try {
    if (!fs.existsSync(CLAUDE_USER_CONFIG)) return {};
    return JSON.parse(fs.readFileSync(CLAUDE_USER_CONFIG, 'utf8'));
  } catch (_) { return {}; }
}
function writeClaudeUserConfig(obj) {
  try {
    // Mode 600 because this file holds MCP API keys, OAuth tokens, and other
    // secrets in plaintext (mcpServers.<id>.env / .headers). Default umask
    // would leave it world-readable on multi-user systems.
    fs.writeFileSync(CLAUDE_USER_CONFIG, JSON.stringify(obj, null, 2), { mode: 0o600 });
    try { fs.chmodSync(CLAUDE_USER_CONFIG, 0o600); } catch (_) {}
    return true;
  } catch (_) { return false; }
}

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

function shapeServer(id, def, disabled) {
  // MCP servers come in two transport flavors:
  //   stdio     { command, args, env }
  //   http/sse  { type: 'http'|'sse', url, headers }
  // We surface both shapes to the renderer so it can render whichever fields
  // are relevant for the row.
  const isRemote = def && (def.type === 'http' || def.type === 'sse' || def.url);
  if (isRemote) {
    return {
      id,
      enabled: !disabled,
      transport: def.type || 'http',
      url: def.url || '',
      headers: def.headers || {},
    };
  }
  return {
    id,
    enabled: !disabled,
    transport: 'stdio',
    command: def.command || '',
    args: def.args || [],
    env: def.env || {},
  };
}

ipcMain.handle('mcp:catalog', () => MCP_CATALOG);

// Real connection state per MCP server. Husk shells out to `claude mcp list`,
// which returns each configured server with its actual runtime status (connected,
// failed, needs auth). Parsed into { id: 'connected' | 'failed' | 'auth' | 'unknown' }
// so the renderer can paint a real status badge on every row.
const ANSI_STRIP_RE = /\x1B\[[\d;?]*[A-Za-z]|\x1B\][^\x07]*\x07/g;
ipcMain.handle('mcp:health', () => {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('claude', ['mcp', 'list'], {
        env: process.env,
        timeout: 12000,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message, status: {} });
      return;
    }
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d.toString(); });
    proc.stderr.on('data', (d) => { buf += d.toString(); });
    proc.on('error', (err) => resolve({ ok: false, error: err.message, status: {} }));
    proc.on('close', () => {
      const clean = buf.replace(ANSI_STRIP_RE, '');
      const status = {};
      // claude mcp list lines look like:
      //   <server-id>    ✗ Failed to connect
      //   <server-id>    ✓ Connected
      //   <server-id>    ⚠ Needs authentication
      // We accept the human-readable form and a few variations.
      for (const raw of clean.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^([A-Za-z0-9._-]+)\s+(.*)$/);
        if (!m) continue;
        const id = m[1];
        const rest = m[2].toLowerCase();
        if (rest.includes('fail')) status[id] = 'failed';
        else if (rest.includes('connect')) status[id] = 'connected';
        else if (rest.includes('auth')) status[id] = 'auth';
        else if (rest.includes('disabled')) status[id] = 'disabled';
      }
      resolve({ ok: true, status });
    });
  });
});

ipcMain.handle('mcp:list', () => {
  const cfg = readClaudeUserConfig();
  const enabled = cfg.mcpServers || {};
  const disabled = cfg._huskMcpDisabled || {};
  const servers = [];
  for (const id of Object.keys(enabled)) servers.push(shapeServer(id, enabled[id], false));
  for (const id of Object.keys(disabled)) servers.push(shapeServer(id, disabled[id], true));
  servers.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, servers };
});

ipcMain.handle('mcp:add', (_e, payload = {}) => {
  const { id } = payload;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return { ok: false, error: 'Invalid server id' };
  const cfg = readClaudeUserConfig();
  cfg.mcpServers = cfg.mcpServers || {};
  if (cfg.mcpServers[id] || (cfg._huskMcpDisabled && cfg._huskMcpDisabled[id])) {
    return { ok: false, error: `MCP server "${id}" already exists` };
  }
  let entry;
  if (payload.transport === 'http' || payload.transport === 'sse' || payload.url) {
    if (!payload.url) return { ok: false, error: 'URL required for HTTP/SSE transport' };
    entry = { type: payload.transport || 'http', url: payload.url };
    if (payload.headers && Object.keys(payload.headers).length) entry.headers = payload.headers;
  } else {
    if (!payload.command) return { ok: false, error: 'Command required for stdio transport' };
    entry = { command: payload.command, args: Array.isArray(payload.args) ? payload.args : [] };
    if (payload.env && Object.keys(payload.env).length) entry.env = payload.env;
  }
  cfg.mcpServers[id] = entry;
  if (!writeClaudeUserConfig(cfg)) return { ok: false, error: 'Could not write ~/.claude.json' };
  return { ok: true };
});

ipcMain.handle('mcp:remove', (_e, id) => {
  if (!id) return { ok: false, error: 'No id' };
  const cfg = readClaudeUserConfig();
  if (cfg.mcpServers && cfg.mcpServers[id]) delete cfg.mcpServers[id];
  if (cfg._huskMcpDisabled && cfg._huskMcpDisabled[id]) delete cfg._huskMcpDisabled[id];
  writeClaudeUserConfig(cfg);
  return { ok: true };
});

ipcMain.handle('mcp:toggle', (_e, id) => {
  if (!id) return { ok: false, error: 'No id' };
  const cfg = readClaudeUserConfig();
  cfg.mcpServers = cfg.mcpServers || {};
  cfg._huskMcpDisabled = cfg._huskMcpDisabled || {};
  if (cfg.mcpServers[id]) {
    cfg._huskMcpDisabled[id] = cfg.mcpServers[id];
    delete cfg.mcpServers[id];
    writeClaudeUserConfig(cfg);
    return { ok: true, enabled: false };
  }
  if (cfg._huskMcpDisabled[id]) {
    cfg.mcpServers[id] = cfg._huskMcpDisabled[id];
    delete cfg._huskMcpDisabled[id];
    writeClaudeUserConfig(cfg);
    return { ok: true, enabled: true };
  }
  return { ok: false, error: 'Not found' };
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
  const learning = { latest: null, latestSource: '', avg1h: null, avg1d: null, avg1w: null, avg1mo: null, recent: [] };
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

ipcMain.handle('workflows:list', () => loadWorkflows());

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
      env: { ...process.env },
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
    steps: Array.isArray(payload.steps) ? payload.steps.map(sanitizeStep) : [],
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
    return {
      ...w,
      name: payload.name !== undefined ? String(payload.name).slice(0, 80) : w.name,
      description: payload.description !== undefined ? String(payload.description).slice(0, 256) : w.description,
      steps: Array.isArray(payload.steps) ? payload.steps.map(sanitizeStep) : w.steps,
      trigger: ['manual','ai-suggested'].includes(payload.trigger) ? payload.trigger : (w.trigger || 'manual'),
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
  const workflow = loadWorkflows().find((w) => w.id === workflowId);
  if (!workflow) return { ok: false, error: 'workflow not found' };
  if (!workflow.steps.length) return { ok: false, error: 'workflow has no steps' };

  const runId = `run-${Date.now()}`;
  const runState = {
    id: runId,
    workflowId,
    status: 'running',
    currentStep: 0,
    stepStates: workflow.steps.map((s) => ({ stepId: s.id, status: 'pending', output: '' })),
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
  const suggested = loadWorkflows().filter((w) => w.trigger === 'ai-suggested');
  if (!suggested.length) return null;
  const lines = suggested.map((w) => {
    const stepSummary = w.steps.map((s, i) => `  Step ${i + 1}: ${s.name}`).join('\n');
    return `- "${w.name}": ${w.description || w.steps.map((s) => s.name).join(' -> ')}\n${stepSummary}`;
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

function sanitizeStep(s) {
  return {
    id: s.id || `step-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    name: String(s.name || 'Step').slice(0, 64),
    agentCommand: String(s.agentCommand || '').slice(0, 128) || null,
    prompt: String(s.prompt || '').slice(0, 8192),
    passContext: ['full', 'last50', 'none'].includes(s.passContext) ? s.passContext : 'full',
  };
}

function wfEmit(event, channel, data) {
  try { if (!event.sender.isDestroyed()) event.sender.send(channel, data); } catch (_) {}
}

async function executeWorkflow(event, workflow, run) {
  // Yield so ipcMain.handle can return the runId to the renderer before we
  // emit any step events. Without this, wf:step:start fires before the
  // renderer has set activeRunId and events get silently dropped.
  await new Promise((resolve) => setImmediate(resolve));

  let previousOutput = '';

  for (let i = 0; i < workflow.steps.length; i++) {
    if (run.status === 'stopped') break;

    const step = workflow.steps[i];
    const stepState = run.stepStates[i];
    stepState.status = 'running';
    run.currentStep = i;
    wfEmit(event, 'wf:step:start', { runId: run.id, stepIndex: i });

    const cmd = (step.agentCommand || config.agentCommand || 'claude').trim().split(/\s+/)[0];

    // Build prompt: replace {{previousOutput}} placeholder or append context
    let prompt = step.prompt;
    if (i > 0 && previousOutput) {
      if (prompt.includes('{{previousOutput}}')) {
        prompt = prompt.replace(/\{\{previousOutput\}\}/g, previousOutput);
      } else if (step.passContext !== 'none') {
        const ctx = step.passContext === 'last50'
          ? previousOutput.split('\n').slice(-50).join('\n')
          : previousOutput;
        prompt = `${prompt}\n\n[Output from previous step "${workflow.steps[i - 1].name}"]\n${ctx}`;
      }
    }

    let output = '';
    const child = spawn(cmd, ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    });
    run.currentChild = child;

    child.stdout.on('data', (d) => {
      output += d.toString();
      stepState.output = output;
      wfEmit(event, 'wf:step:output', { runId: run.id, stepIndex: i, chunk: d.toString() });
    });
    child.stderr.on('data', (d) => {
      wfEmit(event, 'wf:step:output', { runId: run.id, stepIndex: i, chunk: d.toString() });
    });

    await new Promise((resolve) => {
      child.on('close', (code) => {
        stepState.status = run.status === 'stopped' ? 'cancelled' : (code === 0 ? 'done' : 'failed');
        stepState.finishedAt = new Date().toISOString();
        previousOutput = output;
        wfEmit(event, 'wf:step:done', { runId: run.id, stepIndex: i, status: stepState.status });
        resolve();
      });
      child.on('error', () => {
        stepState.status = 'failed';
        wfEmit(event, 'wf:step:done', { runId: run.id, stepIndex: i, status: 'failed' });
        resolve();
      });
    });

    if (stepState.status === 'failed') { run.status = 'failed'; break; }
  }

  if (run.status === 'running') run.status = 'done';
  run.finishedAt = new Date().toISOString();
  wfEmit(event, 'wf:run:done', { runId: run.id, status: run.status });
  activeRuns.delete(run.id);
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
  return entry;
});

ipcMain.handle('profiles:update', (_e, payload = {}) => {
  if (!payload.id) return { ok: false, error: 'missing id' };
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
  return { ok: true };
});

ipcMain.handle('profiles:delete', (_e, id) => {
  if (!id) return { ok: false, error: 'missing id' };
  const profiles = getProfiles().filter((p) => p.id !== id);
  const activeProfileId = config.activeProfileId === id ? null : config.activeProfileId;
  config = { ...config, profiles, activeProfileId };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true };
});

ipcMain.handle('profiles:activate', (_e, id) => {
  const profile = id ? getProfiles().find((p) => p.id === id) : null;
  if (id && !profile) return { ok: false, error: 'profile not found' };
  config = { ...config, activeProfileId: id || null };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  return { ok: true, profile: profile || null };
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
    const oldPath = path.join(HUSK_PROMPTS_DIR, itemId);
    if (!fs.existsSync(oldPath)) return { ok: false, error: 'Prompt not found' };
    const isDisabled = itemId.endsWith('.disabled');
    const newName = isDisabled ? itemId.slice(0, -'.disabled'.length) : `${itemId}.disabled`;
    const newPath = path.join(HUSK_PROMPTS_DIR, newName);
    if (fs.existsSync(newPath)) return { ok: false, error: 'Target already exists' };
    try {
      fs.renameSync(oldPath, newPath);
      return { ok: true, source: 'husk', id: newName, dirName: newName, disabled: !isDisabled };
    } catch (err) { return { ok: false, error: err.message }; }
  }
  // Claude skill (default).
  const skillsDir = path.join(CLAUDE_DIR, 'skills');
  const oldPath = path.join(skillsDir, itemId);
  if (!fs.existsSync(oldPath)) return { ok: false, error: 'Skill not found' };
  const isDisabled = itemId.startsWith(DISABLED_PREFIX);
  const newDirName = isDisabled ? itemId.slice(DISABLED_PREFIX.length) : DISABLED_PREFIX + itemId;
  const newPath = path.join(skillsDir, newDirName);
  if (fs.existsSync(newPath)) return { ok: false, error: 'Target already exists' };
  try {
    fs.renameSync(oldPath, newPath);
    return { ok: true, source: 'claude', id: newDirName, dirName: newDirName, disabled: !isDisabled };
  } catch (err) { return { ok: false, error: err.message }; }
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

// Walk all claude session JSONL files at ~/.claude/projects/*/*.jsonl
ipcMain.handle('sessions:list', () => {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  let projects = [];
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch (err) { return { ok: false, error: err.message, sessions: [] }; }

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

  function matchPrd(sessionStartMs, sessionEndMs) {
    let best = null; let bestDiff = Infinity;
    for (const p of prds) {
      if (!isFinite(p.startedMs)) continue;
      // PRD started should fall within session lifetime, OR be within 5 min
      const within = p.startedMs >= sessionStartMs - 60_000 && p.startedMs <= sessionEndMs + 60_000;
      const diff = Math.abs(p.startedMs - sessionStartMs);
      if (within && diff < bestDiff) { bestDiff = diff; best = p; }
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
      try {
        const text = readHead(fullPath, 32768);
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch (_) { continue; }
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
          if (aiTitle && startedISO && userMessage && originalCwd) break;
        }
      } catch (_) {}
      const firstMessage = (aiTitle || userMessage || queueContent || '').slice(0, 220);

      const sessionStartMs = startedISO ? Date.parse(startedISO) : st.mtimeMs;
      const matchedPrd = matchPrd(sessionStartMs, st.mtimeMs);

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
    const key = `${s.project}${(s.title || '').toLowerCase()}${(s.firstMessage || '').slice(0, 200)}`;
    const cur = dedup.get(key);
    if (!cur || s.sizeBytes > cur.sizeBytes
        || (s.sizeBytes === cur.sizeBytes && s.mtime > cur.mtime)) {
      dedup.set(key, s);
    }
  }
  const deduped = [...dedup.values()].sort((a, b) => b.mtime - a.mtime);
  return { ok: true, sessions: deduped };
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
//     Piper binary is x86_64 ELF and won't run on Darwin anyway, so attempting
//     to install Piper there used to throw 'spawn Unknown system error -8' from
//     the running-not-runnable binary. The darwin branch sidesteps that.

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

// Claim port 8888 with a silent sink so external TTS POSTs do not produce sound.
// Husk owns voice while it is running; whatever else listens on 8888 is freed and
// the port is reclaimed. Released cleanly on quit.
let nullVoiceServer = null;
function startNullVoiceServer() {
  return new Promise((resolve) => {
    const claim = spawn('bash', ['-c', 'lsof -ti:8888 -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null; true'], { stdio: 'ignore' });
    claim.on('close', () => {
      setTimeout(() => {
        const server = http.createServer((req, res) => {
          if (req.method === 'POST') { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok","silent":true}'); }); }
          else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('husk-null-voice'); }
        });
        server.on('error', () => resolve());
        server.listen(8888, '127.0.0.1', () => { nullVoiceServer = server; resolve(); });
      }, 200);
    });
    claim.on('error', () => resolve());
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

  // Fire one check shortly after launch and again every 6 hours.
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 4000);
  setInterval(() => { try { autoUpdater.checkForUpdates(); } catch (_) {} }, 6 * 60 * 60 * 1000);
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
    bootstrapPaiIfNeeded();
    bootstrapHuskPromptsIfNeeded();
    startStatuslineRefresh();
    startUsageRefresh();
    await startNullVoiceServer();
    createWindow();
    setupAutoUpdater();
  });
  app.on('window-all-closed', () => { killPtyTree(); stopNullVoiceServer(); stopStatuslineRefresh(); stopUsageRefresh(); app.quit(); });
  app.on('before-quit', () => { killPtyTree(); stopNullVoiceServer(); stopStatuslineRefresh(); stopUsageRefresh(); });
  app.on('will-quit', () => { killPtyTree(); stopNullVoiceServer(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  process.on('SIGINT',  () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('SIGTERM', () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('SIGHUP',  () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('exit',    () => { killPtyTree(); stopNullVoiceServer(); });
}
