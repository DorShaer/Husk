// Renderer-safe API surface.
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

// Default UI scale Husk mounts at, so the renderer comes up comfortable on
// every platform. User-driven zoom (Ctrl/Cmd +/-/0) layers on top of this.
const HUSK_BASE_ZOOM = 1;
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
  mcp: {
    catalog: () => ipcRenderer.invoke('mcp:catalog'),
    list: () => ipcRenderer.invoke('mcp:list'),
    add: (payload) => ipcRenderer.invoke('mcp:add', payload),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
    toggle: (id) => ipcRenderer.invoke('mcp:toggle', id),
    health: () => ipcRenderer.invoke('mcp:health'),
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

