// Renderer-safe API surface.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

// Default UI scale Husk mounts at, so the renderer comes up comfortable on
// every platform. User-driven zoom (Ctrl/Cmd +/-/0) layers on top of this.
const HUSK_BASE_ZOOM = 0;
try { webFrame.setZoomLevel(HUSK_BASE_ZOOM); } catch (_) {}

contextBridge.exposeInMainWorld('husk', {
  pty: {
    start: (size) => ipcRenderer.invoke('pty:start', size),
    write: (data) => ipcRenderer.send('pty:write', data),
    resize: (size) => ipcRenderer.send('pty:resize', size),
    restart: (opts) => ipcRenderer.invoke('pty:restart', opts || {}),
    onData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
    onExit: (cb) => ipcRenderer.on('pty:exit', (_e, code) => cb(code)),
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
    delete: (paths) => ipcRenderer.invoke('sessions:delete', { paths }),
  },
  prds: { list: () => ipcRenderer.invoke('prds:list') },
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
  autonomy: {
    start: (opts) => ipcRenderer.invoke('autonomy:start', opts || {}),
    event: (event) => ipcRenderer.invoke('autonomy:event', event || {}),
    cancel: (detail) => ipcRenderer.invoke('autonomy:cancel', detail || {}),
    end: (detail) => ipcRenderer.invoke('autonomy:end', detail || {}),
    status: () => ipcRenderer.invoke('autonomy:status'),
    revert: (opts) => ipcRenderer.invoke('autonomy:revert', opts || {}),
    summary: (opts) => ipcRenderer.invoke('autonomy:summary', opts || {}),
    onStarted: (cb) => ipcRenderer.on('autonomy:started', (_e, payload) => cb(payload)),
    onEnded: (cb) => ipcRenderer.on('autonomy:ended', (_e, payload) => cb(payload)),
    onHalt: (cb) => ipcRenderer.on('autonomy:halt', (_e, payload) => cb(payload)),
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
  },
});

