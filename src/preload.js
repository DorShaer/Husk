// Renderer-safe API surface.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');
const { extractRecap } = require('./lib/recap-extract');
const { fuzzyFilter } = require('./lib/fuzzy');
const { highlight, highlightLines } = require('./lib/highlight');
const { parsePorcelain, statusBadge } = require('./lib/git-porcelain');

// Husk's default zoom. User-driven zoom (Ctrl/Cmd +/-/0) layers on top of this.
// -0.5 = zoom factor 1.2^-0.5 ≈ 0.91, which fits everything without scrolling.
const HUSK_BASE_ZOOM = -0.5;
try { webFrame.setZoomLevel(HUSK_BASE_ZOOM); } catch (_) {}

contextBridge.exposeInMainWorld('husk', {
  pty: {
    // sessionId threads through every channel so multiple PTYs run in
    // parallel; when omitted the main process targets the active session.
    start: (opts) => ipcRenderer.invoke('pty:start', opts || {}),
    list: () => ipcRenderer.invoke('pty:list'),
    reattach: (opts) => ipcRenderer.invoke('pty:reattach', opts || {}),
    write: (data, sessionId) => ipcRenderer.send('pty:write', { data, sessionId }),
    resize: (size, sessionId) => ipcRenderer.send('pty:resize', Object.assign({ sessionId }, size)),
    restart: (opts) => ipcRenderer.invoke('pty:restart', opts || {}),
    close: (sessionId) => ipcRenderer.invoke('pty:close', sessionId),
    setActive: (sessionId) => ipcRenderer.invoke('pty:setActive', sessionId),
    onData: (cb) => ipcRenderer.on('pty:data', (_e, p) => cb(p.sessionId, p.data)),
    onExit: (cb) => ipcRenderer.on('pty:exit', (_e, p) => cb(p.sessionId, p.code)),
    onMouseMode: (cb) => ipcRenderer.on('pty:mouse-mode', (_e, p) => cb(p.sessionId, p.on)),
    wheel: (payload, sessionId) => ipcRenderer.send('pty:wheel', Object.assign({ sessionId }, payload)),
  },
  // Extract the agent's recap line from rendered grid rows (pure, in-process).
  recap: {
    extract: (rows) => { try { return extractRecap(rows); } catch (_) { return null; } },
  },
  // Pure text helpers for the Files command-center, run in-process (no IPC):
  // fuzzy file search, syntax highlighting, and git porcelain parsing.
  text: {
    fuzzyFilter: (query, items, keyName) => {
      try { return fuzzyFilter(query, items, keyName ? (it) => it[keyName] : undefined); }
      catch (_) { return items || []; }
    },
    highlight: (code, lang) => { try { return highlight(code, lang); } catch (_) { return null; } },
    highlightLines: (code, lang) => { try { return highlightLines(code, lang); } catch (_) { return null; } },
    parseGitStatus: (porcelain) => { try { return parsePorcelain(porcelain); } catch (_) { return []; } },
    gitBadge: (status) => { try { return statusBadge(status); } catch (_) { return ''; } },
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial) => ipcRenderer.invoke('config:set', partial),
  },
  stats: { get: () => ipcRenderer.invoke('stats:get') },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    read: (mdPath) => ipcRenderer.invoke('skills:read', mdPath),
    toggle: (arg) => ipcRenderer.invoke('skills:toggle', typeof arg === 'string' ? { dirName: arg } : (arg || {})),
    create: (payload) => ipcRenderer.invoke('skills:create', payload),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    read: (prdPath) => ipcRenderer.invoke('sessions:read', prdPath),
    findClaudeId: (payload) => ipcRenderer.invoke('sessions:findClaudeId', payload),
    resolveLiveTitle: (payload) => ipcRenderer.invoke('sessions:resolveLiveTitle', payload),
    rename: (payload) => ipcRenderer.invoke('sessions:rename', payload),
    delete: (paths) => ipcRenderer.invoke('sessions:delete', { paths }),
  },
  prds: { list: () => ipcRenderer.invoke('prds:list') },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    catalog: () => ipcRenderer.invoke('plugins:catalog'),
    run: (action, id) => ipcRenderer.invoke('plugins:run', { action, id }),
    files: (id) => ipcRenderer.invoke('plugins:files', { id }),
    readFile: (id, relPath) => ipcRenderer.invoke('plugins:readFile', { id, relPath }),
    writeFile: (id, relPath, content) => ipcRenderer.invoke('plugins:writeFile', { id, relPath, content }),
    openFolder: (id) => ipcRenderer.invoke('plugins:openFolder', { id }),
  },
  prompts: {
    list: () => ipcRenderer.invoke('prompts:list'),
    create: (payload) => ipcRenderer.invoke('prompts:create', payload),
    delete: (mdPath) => ipcRenderer.invoke('prompts:delete', mdPath),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (payload) => ipcRenderer.invoke('projects:create', payload),
    setActive: (id) => ipcRenderer.invoke('projects:setActive', id),
    clearActive: () => ipcRenderer.invoke('projects:clearActive'),
    delete: (id) => ipcRenderer.invoke('projects:delete', id),
  },
  fs: {
    open: (p) => ipcRenderer.invoke('fs:open', p),
    dropFile: (payload) => ipcRenderer.invoke('fs:dropFile', payload),
    listDir: (dir, showHidden) => ipcRenderer.invoke('fs:listDir', { dir, showHidden }),
    home: () => ipcRenderer.invoke('fs:home'),
    indexFiles: (root, showHidden) => ipcRenderer.invoke('fs:indexFiles', { root, showHidden }),
    readFile: (root, rel) => ipcRenderer.invoke('fs:readFile', { root, rel }),
    writeFile: (opts) => ipcRenderer.invoke('fs:writeFile', opts || {}),
    gitStatus: (root) => ipcRenderer.invoke('fs:gitStatus', { root }),
    gitDiff: (root, rel) => ipcRenderer.invoke('fs:gitDiff', { root, rel }),
  },
  context: {
    list: () => ipcRenderer.invoke('context:list'),
    remove: (filePath) => ipcRenderer.invoke('context:remove', filePath),
  },
  agents: {
    detect: () => ipcRenderer.invoke('agents:detect'),
    install: (id) => ipcRenderer.invoke('agents:install', { id }),
    onInstallProgress: (cb) => ipcRenderer.on('agents:install:progress', (_e, p) => cb(p)),
  },
  workflows: {
    list: () => ipcRenderer.invoke('workflows:list'),
    create: (payload) => ipcRenderer.invoke('workflows:create', payload),
    update: (payload) => ipcRenderer.invoke('workflows:update', payload),
    delete: (id) => ipcRenderer.invoke('workflows:delete', id),
    run: (id) => ipcRenderer.invoke('workflows:run', id),
    stop: (runId) => ipcRenderer.invoke('workflows:stop', runId),
    generateStepPrompt: (desc) => ipcRenderer.invoke('workflows:generateStepPrompt', desc),
    getSessionContext: () => ipcRenderer.invoke('workflows:getSessionContext'),
    onNodeStart: (cb) => ipcRenderer.on('wf:node:start', (_e, d) => cb(d)),
    onNodeActivity: (cb) => ipcRenderer.on('wf:node:activity', (_e, d) => cb(d)),
    onNodeDone: (cb) => ipcRenderer.on('wf:node:done', (_e, d) => cb(d)),
    onEdgeTaken: (cb) => ipcRenderer.on('wf:edge:taken', (_e, d) => cb(d)),
    onRunDone: (cb) => ipcRenderer.on('wf:run:done', (_e, d) => cb(d)),
  },
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    create: (payload) => ipcRenderer.invoke('profiles:create', payload),
    update: (payload) => ipcRenderer.invoke('profiles:update', payload),
    delete: (id) => ipcRenderer.invoke('profiles:delete', id),
    activate: (id) => ipcRenderer.invoke('profiles:activate', id),
    activateAll: () => ipcRenderer.invoke('profiles:activateAll'),
    deactivate: (id) => ipcRenderer.invoke('profiles:deactivate', id),
    deactivateAll: () => ipcRenderer.invoke('profiles:deactivateAll'),
    generate: (description) => ipcRenderer.invoke('profiles:generate', description),
    listImportableAgents: () => ipcRenderer.invoke('profiles:listImportableAgents'),
    importAgents: (picks, activate) => ipcRenderer.invoke('profiles:importAgents', { picks, activate: !!activate }),
  },
  repoAgents: {
    pickDir: () => ipcRenderer.invoke('repoAgents:pickDir'),
    scan: (root) => ipcRenderer.invoke('repoAgents:scan', { root }),
    install: (opts) => ipcRenderer.invoke('repoAgents:install', opts || {}),
  },
  repoMcp: {
    pickDir: () => ipcRenderer.invoke('repoMcp:pickDir'),
    scan: (root) => ipcRenderer.invoke('repoMcp:scan', { root }),
    build: (dir) => ipcRenderer.invoke('repoMcp:build', { dir }),
    install: (opts) => ipcRenderer.invoke('repoMcp:install', opts || {}),
  },
  autopilot: {
    start: (opts) => ipcRenderer.invoke('autopilot:start', opts || {}),
    startCollab: (opts) => ipcRenderer.invoke('autopilot:startCollab', opts || {}),
    event: (event) => ipcRenderer.invoke('autopilot:event', event || {}),
    nudge: (payload) => ipcRenderer.invoke('autopilot:nudge', payload || {}),
    cancel: (detail) => ipcRenderer.invoke('autopilot:cancel', detail || {}),
    end: (detail) => ipcRenderer.invoke('autopilot:end', detail || {}),
    status: (payload) => ipcRenderer.invoke('autopilot:status', payload || {}),
    list: () => ipcRenderer.invoke('autopilot:list'),
    revert: (opts) => ipcRenderer.invoke('autopilot:revert', opts || {}),
    summary: (opts) => ipcRenderer.invoke('autopilot:summary', opts || {}),
    liveDiff: (opts) => ipcRenderer.invoke('autopilot:liveDiff', opts || {}),
    history: (opts) => ipcRenderer.invoke('autopilot:history', opts || {}),
    deleteRun: (opts) => ipcRenderer.invoke('autopilot:deleteRun', opts || {}),
    applyRun: (opts) => ipcRenderer.invoke('autopilot:applyRun', opts || {}),
    discardRun: (opts) => ipcRenderer.invoke('autopilot:discardRun', opts || {}),
    retained: () => ipcRenderer.invoke('autopilot:retained'),
    receipt: (opts) => ipcRenderer.invoke('autopilot:receipt', opts || {}),
    race: () => ipcRenderer.invoke('autopilot:race'),
    applyWinner: (opts) => ipcRenderer.invoke('autopilot:applyWinner', opts || {}),
    fileDiff: (opts) => ipcRenderer.invoke('autopilot:fileDiff', opts || {}),
    reportTokens: (n, runId) => ipcRenderer.invoke('autopilot:reportTokens', { tokens: n, runId: runId || undefined }),
    onStarted: (cb) => ipcRenderer.on('autopilot:started', (_e, payload) => cb(payload)),
    onEnded: (cb) => ipcRenderer.on('autopilot:ended', (_e, payload) => cb(payload)),
    onHalt: (cb) => ipcRenderer.on('autopilot:halt', (_e, payload) => cb(payload)),
    onSnapshotProgress: (cb) => ipcRenderer.on('autopilot:snapshot-progress', (_e, payload) => cb(payload)),
    onActivity: (cb) => ipcRenderer.on('autopilot:activity', (_e, payload) => cb(payload)),
    onCollabPlan: (cb) => ipcRenderer.on('autopilot:collab-plan', (_e, payload) => cb(payload)),
    onBudget: (cb) => ipcRenderer.on('autopilot:budget', (_e, payload) => cb(payload)),
  },
  mcp: {
    catalog: () => ipcRenderer.invoke('mcp:catalog'),
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (payload) => ipcRenderer.invoke('mcp:add', payload),
    addMany: (items) => ipcRenderer.invoke('mcp:addMany', { items }),
    update: (payload) => ipcRenderer.invoke('mcp:update', payload),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
    toggle: (id) => ipcRenderer.invoke('mcp:toggle', id),
    health: () => ipcRenderer.invoke('mcp:health'),
    parseSnippet: (text) => ipcRenderer.invoke('mcp:parseSnippet', { text }),
  },
  dialog2: {
    pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  },
  dialog: { pickFile: () => ipcRenderer.invoke('dialog:pickFile') },
  claudeTrust: {
    status: (cwd) => ipcRenderer.invoke('claude:trust:status', cwd),
    accept: (cwd) => ipcRenderer.invoke('claude:trust:accept', cwd),
  },
  voice: {
    status: () => ipcRenderer.invoke('voice:status'),
    install: (opts) => ipcRenderer.invoke('voice:install', opts || {}),
    speak: (payload) => ipcRenderer.invoke('voice:speak', payload),
    stop: () => ipcRenderer.invoke('voice:stop'),
    uninstall: () => ipcRenderer.invoke('voice:uninstall'),
    onProgress: (cb) => ipcRenderer.on('voice:progress', (_e, p) => cb(p)),
  },
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return null; } },
  urls: {
    openExternal: (url) => ipcRenderer.invoke('urls:openExternal', url),
  },
  updates: {
    get: () => ipcRenderer.invoke('update:get'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    openRelease: (url) => ipcRenderer.invoke('update:open-release', url),
    onStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  },
  ui: {
    zoomIn: () => { const lvl = Math.min(webFrame.getZoomLevel() + 0.5, 5); webFrame.setZoomLevel(lvl); return lvl; },
    zoomOut: () => { const lvl = Math.max(webFrame.getZoomLevel() - 0.5, -3); webFrame.setZoomLevel(lvl); return lvl; },
    // Reset returns to Husk's default UI scale, not the browser default.
    zoomReset: () => { webFrame.setZoomLevel(HUSK_BASE_ZOOM); return HUSK_BASE_ZOOM; },
    zoomGet: () => webFrame.getZoomLevel(),
    // Husk's base zoom level, so the renderer can label it as 100%.
    zoomBase: HUSK_BASE_ZOOM,
  },
});

