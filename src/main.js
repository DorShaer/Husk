// Husk: Electron main process.
// Wraps a configurable agent CLI via node-pty and exposes pages: chat, skills, sessions, files, preferences.

const { app, BrowserWindow, ipcMain, shell, dialog, webUtils, Menu } = require('electron');
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
// compositing when --no-sandbox is set or the GPU sits on a blocklist —
// that's the "feels like 30Hz" symptom. These three switches push it to
// the GPU path. Safe defaults for desktop Electron 32.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow = null;
let ptyProc = null;

// ─── Config ──────────────────────────────────────────────────────────────────────

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
  voice: { enabled: false, name: 'en_US-amy-medium', rate: 1.0 },
  skipWelcome: false,
  recap: true,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (_) { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch (_) { return false; }
}

let config = loadConfig();

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

// Build a temporary settings file that mirrors the user's ~/.claude/settings.json
// but with statusLine overridden to a no-op. Husk's right-panel becomes the visual
// statusline, so we want claude's TUI to NOT also render its own inline statusline.
function buildClaudeSettingsOverride() {
  try {
    const userSettings = readJSON(path.join(CLAUDE_DIR, 'settings.json'), {});
    const cloned = JSON.parse(JSON.stringify(userSettings));
    // Silence the inline statusline (Husk renders its own on the right panel).
    cloned.statusLine = { type: 'command', command: '/bin/true' };
    delete cloned.statusline;
    // Give skill descriptions room so claude does not silently drop them.
    // Default 0.01 is too tight when more than ~10 skills are installed.
    cloned.skillListingBudgetFraction = 0.05;
    const tmpDir = path.join(os.tmpdir(), 'husk');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'claude-settings.json');
    fs.writeFileSync(tmpFile, JSON.stringify(cloned, null, 2));
    return tmpFile;
  } catch (_) { return null; }
}

function spawnPty(cols = 100, rows = 30, overrideCmd = null, overrideCwd = null) {
  if (ptyProc) try { ptyProc.kill(); } catch (_) {}
  const shellBin = process.env.SHELL || '/bin/bash';
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLAUDE_DIR,
  });
  const bunBin = path.join(HOME, '.bun', 'bin');
  if (env.PATH && !env.PATH.includes(bunBin)) env.PATH = `${bunBin}:${env.PATH}`;

  let cmd = (overrideCmd || config.agentCommand || 'claude').trim();

  // For claude commands, inject the Husk runtime context: a settings override that
  // silences the inline statusline, and an appended system prompt that forces the
  // agent to identify as Claude inside Husk regardless of any persona configured
  // in the user's CLAUDE.md or memory files. Skip if user already passed --settings.
  if (cmd.startsWith('claude') && !/--settings\b/.test(cmd)) {
    const overridePath = buildClaudeSettingsOverride();
    const agentName = (config.agentName || 'Husk').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40) || 'Husk';
    const huskPromptParts = [
      `You are running inside Husk, a desktop wrapper. The user has named this agent ${agentName}. When asked your name or identity, respond as ${agentName} (no other persona). Use "🗣️ ${agentName}:" if you emit a speech-balloon line. Otherwise follow your normal CLAUDE.md, PAI/Algorithm, and memory-file instructions exactly — including the full reasoning, banner format, TASK/CHANGE/VERIFY structure, and recap behavior.`,
    ];
    if (config.recap === false) {
      huskPromptParts.push(`The user has disabled recaps in Husk. Suppress any "* recap:" line and end-of-response summary footer for this session.`);
    }
    const huskPrompt = huskPromptParts.join(' ');
    const escaped = huskPrompt.replace(/'/g, "'\\''");
    const inject = overridePath
      ? `--settings ${overridePath} --append-system-prompt '${escaped}'`
      : `--append-system-prompt '${escaped}'`;
    cmd = cmd.replace(/^claude\b/, `claude ${inject}`);
  }

  let cwd = HOME;
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
  //  - Linux: node-pty's bare spawn doesn't always do setsid + TIOCSCTTY,
  //    so we wrap with GNU script(1): `script -q -c <cmd> /dev/null`.
  //    This is what makes `claude --resume <id>` work without exit code 129.
  //  - macOS: node-pty handles the tty correctly on Darwin, AND BSD
  //    script(1) does NOT accept `-c` (it's "illegal option -- c"), so the
  //    Linux trick is actively harmful. We use `sh -c "<cmd>"` so quoting
  //    inside the command (e.g. claude's long --append-system-prompt) is
  //    parsed by the shell instead of being naively split on whitespace.
  //  - Windows: not supported (no PTY tty story we use).
  let exe; let argv;
  if (!cmd) {
    exe = shellBin; argv = ['-i'];
  } else if (process.platform === 'darwin') {
    exe = '/bin/sh';
    argv = ['-c', cmd];
  } else if (fs.existsSync('/usr/bin/script')) {
    exe = '/usr/bin/script';
    argv = ['-q', '-c', cmd, '/dev/null'];
  } else {
    exe = '/bin/sh';
    argv = ['-c', cmd];
  }

  ptyProc = pty.spawn(exe, argv, { name: 'xterm-256color', cols, rows, cwd, env });
  ptyProc.onData((data) => { if (mainWindow) mainWindow.webContents.send('pty:data', data); });
  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow) mainWindow.webContents.send('pty:exit', exitCode);
    ptyProc = null;
  });
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

// Probe well-known CLI agents on PATH so the rail's quick-switcher can show
// which ones are actually installed. Cheap synchronous PATH walk, no spawn.
const KNOWN_AGENTS = [
  { id: 'claude', label: 'Claude Code',  command: 'claude' },
  { id: 'copilot', label: 'GitHub Copilot CLI', command: 'copilot' },
  { id: 'codex', label: 'Codex CLI',  command: 'codex' },
  { id: 'aider',  label: 'Aider',  command: 'aider' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
];
function isOnPath(binName) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    try {
      const p = path.join(d, binName);
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return true;
    } catch (_) {}
  }
  return false;
}
ipcMain.handle('agents:detect', () => {
  return KNOWN_AGENTS.map((a) => ({ ...a, available: isOnPath(a.command) }));
});

// ─── MCP servers (~/.claude.json mcpServers) ────────────────────────────────────
// We treat ~/.claude.json's `mcpServers` object as the source of truth (Claude
// Code's user-scoped MCP config). For "disabled" state, we move entries to a
// Husk-private key `_huskMcpDisabled` so a toggle never loses configuration —
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
    fs.writeFileSync(CLAUDE_USER_CONFIG, JSON.stringify(obj, null, 2));
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
    huskVer: '0.2',
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
  const safeDesc = description.trim().replace(/"/g, '\\"');
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
    if (fs.existsSync(mdPath) || fs.existsSync(mdPath + '.disabled')) {
      return { ok: false, error: `A prompt named "${name}" already exists.` };
    }
    fs.writeFileSync(mdPath, md);
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
  // and keep only the largest file — the canonical session always grows past its shadows.
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
  if (!sourcePath || !fs.existsSync(sourcePath)) return { ok: false, error: 'Source not found' };
  try {
    const baseName = path.basename(sourcePath);
    let dest;
    if (kind === 'skill') {
      const skillName = baseName.replace(/\.md$/i, '');
      const skillDir = path.join(CLAUDE_DIR, 'skills', skillName);
      fs.mkdirSync(skillDir, { recursive: true });
      dest = path.join(skillDir, 'SKILL.md');
      fs.copyFileSync(sourcePath, dest);
    } else {
      const ctxDir = path.join(CLAUDE_DIR, 'MEMORY', 'CONTEXT');
      fs.mkdirSync(ctxDir, { recursive: true });
      dest = path.join(ctxDir, baseName);
      fs.copyFileSync(sourcePath, dest);
    }
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

const HUSK_DATA = path.join(HOME, '.local', 'share', 'husk');
const PIPER_DIR = path.join(HUSK_DATA, 'piper');
const PIPER_BIN = path.join(PIPER_DIR, 'piper');
const VOICES_DIR = path.join(PIPER_DIR, 'voices');

const PIPER_RELEASE = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz';
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

const IS_MAC = process.platform === 'darwin';
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
    await startNullVoiceServer();
    createWindow();
  });
  app.on('window-all-closed', () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  app.on('before-quit', () => { killPtyTree(); stopNullVoiceServer(); });
  app.on('will-quit', () => { killPtyTree(); stopNullVoiceServer(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  process.on('SIGINT',  () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('SIGTERM', () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('SIGHUP',  () => { killPtyTree(); stopNullVoiceServer(); app.quit(); });
  process.on('exit',    () => { killPtyTree(); stopNullVoiceServer(); });
}
