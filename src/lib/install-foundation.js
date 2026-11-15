'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Bundle = require('./market-bundle');
const Scan = require('./artifact-scan');
const { parseAgentMd } = require('./agent-md');
const { readBoundedFile } = require('./bounded-file');

function registerFoundation({ ipcMain, dialog, window, getConfig, setConfig, installers, agentDir, skillsDir, promptsDir, prepareSkills, resolveAgents, workflowExport, listWorkflows = () => [] }) {
  const cache = new Map();
  const pending = new Map();
  ipcMain.handle('scanner:choose', async () => {
    const picked = await dialog.showOpenDialog(window(), { title: 'Choose a local scanner executable', properties: ['openFile'] });
    if (picked.canceled || !picked.filePaths.length) return { ok: true, canceled: true };
    const scannerPath = picked.filePaths[0];
    if (!fs.statSync(scannerPath).isFile()) return { ok: false, error: 'Choose an executable file' };
    setConfig({ scannerPath }); cache.clear();
    return { ok: true, scannerPath };
  });
  ipcMain.handle('scanner:remove', () => { setConfig({ scannerPath: '' }); cache.clear(); return { ok: true }; });
  ipcMain.handle('installReview:answer', (event, { id, approved } = {}) => {
    const p = pending.get(id);
    if (!p || event.sender !== p.sender) return { ok: false };
    pending.delete(id); clearTimeout(p.timer); p.resolve(approved === true && !p.blocked);
    return { ok: true };
  });
  function review(details) {
    return new Promise((resolve) => {
      const win = window();
      if (!win || win.isDestroyed()) return resolve(false);
      const id = crypto.randomUUID();
      const sender = win.webContents;
      let timer;
      const finish = (approved) => {
        pending.delete(id); clearTimeout(timer);
        sender.removeListener('destroyed', cancel);
        sender.removeListener('did-start-navigation', navigating);
        resolve(approved);
      };
      const cancel = () => finish(false);
      const navigating = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancel(); };
      timer = setTimeout(cancel, 10 * 60 * 1000);
      timer.unref?.();
      sender.once('destroyed', cancel);
      sender.on('did-start-navigation', navigating);
      pending.set(id, { resolve: finish, sender, blocked: details.scan.verdict === 'block', timer });
      win.webContents.send('installReview:request', { ...details, id });
    });
  }
  async function gate(files, manifest, signature, install) {
    const staged = Bundle.stageFiles(fs, files, os.tmpdir());
    if (!staged.ok) return staged;
    try {
      const hashed = files.map((f) => ({ ...f, sha256: Bundle.sha256Hex(f.content) }));
      const scan = await Scan.scanArtifact({ scanner: getConfig().scannerPath, dir: staged.dir, contentHash: Bundle.contentHash(hashed), fs, execFile, tmpRoot: os.tmpdir(), cache });
      const unchanged = () => {
        const collected = Bundle.collectDir(fs, staged.dir);
        if (!collected.ok) return false;
        const current = collected.files.map((f) => ({ path: f.path, sha256: Bundle.sha256Hex(f.content) }));
        return Bundle.contentHash(current) === Bundle.contentHash(hashed);
      };
      if (!unchanged()) return { ok: false, error: 'The staged files changed during scanning. Import the item again.' };
      const approved = await review({ manifest, signature: signature || { state: 'unsigned' }, scan, files: files.map((f) => ({ path: f.path, text: f.content.toString('utf8') })) });
      if (!approved || Scan.gateDecision(scan) === 'block') return { ok: false, error: scan.verdict === 'block' ? 'Installation blocked by the scanner' : 'Installation canceled', canceled: true };
      if (!unchanged()) return { ok: false, error: 'The staged files changed during review. Import the item again.' };
      return await install(staged.dir);
    } finally { fs.rmSync(staged.dir, { recursive: true, force: true }); }
  }
  const genericManifest = (name, kind) => ({ name, kind, publisher: 'Not supplied', permissions: null });
  async function reviewInstall(channel, payload, handler, event) {
    try {
      if (channel === 'repoAgents:install') {
        const resolved = resolveAgents(String(payload.root || ''));
        if (!resolved) return { ok: false, error: 'No agents directory found' };
        const collected = Bundle.collectDir(fs, resolved.dir);
        if (!collected.ok) return collected;
        const files = collected.files.map((f) => ({ ...f, path: `agents/${f.path}` }));
        return await gate(files, genericManifest(path.basename(payload.root), 'agent'), null, (root) => handler(event, { ...payload, root }));
      }
      const file = channel === 'workflows:install' ? 'workflow.json' : 'mcp.json';
      const content = channel === 'mcp:addMany'
        ? { mcpServers: Object.fromEntries((Array.isArray(payload.items) ? payload.items : []).map((item, i) => [`${i}-${String(item.id || "server")}`, item])) }
        : payload.artifact || payload;
      const files = [{ path: file, content: Buffer.from(JSON.stringify(content)) }];
      return await gate(files, genericManifest(channel.startsWith('mcp:') ? 'MCP configuration' : 'Workflow', file === 'mcp.json' ? 'mcp' : 'workflow'), null, () => handler(event, payload));
    } catch (err) { return { ok: false, error: err.message }; }
  }
  async function installBundle(bundle, dir, opts, event) {
    const m = bundle.manifest;
    const text = bundle.files[0].content.toString('utf8');
    if (m.kind === 'agent') return installers.get('repoAgents:install')(event, { root: dir, picks: bundle.files.map((f) => ({ filename: f.path.slice(7) })), installToAllAgents: true });
    if (m.kind === 'mcp') {
      const parsed = require('./mcp-json').parseLooseMcpJson(text);
      if (!parsed.ok) return parsed;
      const entries = parsed.entries.map((e) => require('./mcp-json').shapeEntry(e.id, e.entry));
      if (entries.some((e) => !e.ok)) return { ok: false, error: 'Invalid MCP configuration' };
      return installers.get('mcp:addMany')(event, { items: entries.map((e) => e.payload) });
    }
    if (m.kind === 'workflow') return installers.get('workflows:install')(event, { artifact: JSON.parse(text), cwd: opts.cwd });
    const parsed = parseAgentMd(text);
    const input = { name: m.id, description: m.description || m.name, content: parsed.body || text };
    if (m.kind === 'prompt') return installers.get('prompts:create')(event, input);
    return installers.get('skills:create')(event, input, bundle.files);
  }
  ipcMain.handle('bundles:import', async (event) => {
    const picked = await dialog.showOpenDialog(window(), { title: 'Import a Husk bundle', properties: ['openFile'], filters: [{ name: 'Husk bundle', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePaths.length) return { ok: true, canceled: true };
    try {
      const file = picked.filePaths[0];
      const parsed = Bundle.parseBundle(readBoundedFile(file, Bundle.MAX_BUNDLE_BYTES), { trustedPublishers: getConfig().trustedPublishers });
      if (!parsed.ok) return parsed;
      const bundle = parsed.bundle;
      const opts = {};
      if (bundle.manifest.kind === 'workflow') {
        const folder = await dialog.showOpenDialog(window(), { title: 'Choose the workflow project folder', properties: ['openDirectory'] });
        if (folder.canceled || !folder.filePaths.length) return { ok: true, canceled: true };
        opts.cwd = folder.filePaths[0];
      }
      return await gate(bundle.files, bundle.manifest, bundle.signature, (dir) => installBundle(bundle, dir, opts, event));
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('bundles:items', (_event, { kind } = {}) => {
    if (kind === 'workflow') return listWorkflows().map((item) => ({ id: item.id, name: item.name || item.id }));
    const root = kind === 'skill' ? skillsDir : kind === 'agent' ? agentDir : kind === 'prompt' ? promptsDir : null;
    if (!root) return [];
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
    const out = [];
    for (const entry of entries) {
      const id = kind === 'skill' ? entry.name : entry.name.replace(/\.md$/, '');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) continue;
      if (kind === 'skill' ? !entry.isDirectory() : (!entry.isFile() || !entry.name.endsWith('.md'))) continue;
      try {
        const file = path.join(root, entry.name, ...(kind === 'skill' ? ['SKILL.md'] : []));
        const parsed = parseAgentMd(readBoundedFile(file, Bundle.MAX_FILE_BYTES).toString('utf8'));
        out.push({ id, name: parsed.name || id });
      } catch (_) {}
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
  ipcMain.handle('bundles:export', async (_event, { kind, id } = {}) => {
    try {
      let files;
      let name = String(id || '');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return { ok: false, error: 'Select a local item to export' };
      if (kind === 'workflow') {
        const artifact = workflowExport(id);
        if (!artifact) throw new Error('Workflow not found');
        files = [{ path: 'workflow.json', content: Buffer.from(JSON.stringify(artifact)) }];
        name = name.replace(/[^a-z0-9-]/g, '-');
      } else if (kind === 'skill') {
        const root = path.join(skillsDir, id);
        if (!fs.realpathSync(root).startsWith(fs.realpathSync(skillsDir) + path.sep)) throw new Error('Choose a local skill');
        const collected = Bundle.collectDir(fs, root);
        if (!collected.ok) return collected;
        files = collected.files;
      } else if (kind === 'agent' || kind === 'prompt') {
        const root = kind === 'agent' ? agentDir : promptsDir;
        const file = path.join(root, id + '.md');
        if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('Choose a local item');
        files = [{ path: kind === 'agent' ? `agents/${id}.md` : `${id}.md`, content: readBoundedFile(file, Bundle.MAX_FILE_BYTES) }];
      } else return { ok: false, error: 'Choose an agent, skill, workflow or prompt' };
      const packed = Bundle.packBundle({ id: name, name, kind, version: '1.0.0', publisher: 'Local export', description: '', permissions: { runsCommands: true, networkHosts: ['*'], fileAccess: 'write' } }, files);
      if (!packed.ok) return packed;
      const picked = await dialog.showSaveDialog(window(), { title: 'Export a Husk bundle', defaultPath: `${name}.husk.json` });
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
      fs.writeFileSync(picked.filePath, packed.text, { mode: 0o600 });
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });
  return { reviewInstall };
}
module.exports = { registerFoundation };
