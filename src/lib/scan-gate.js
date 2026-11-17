'use strict';

// What Husk does with a scan of something an agent will read or run: the
// install and use decisions, the plain-words summary the dialog shows, and the
// background scan of items already in the library.

const path = require('node:path');
const Bundle = require('./market-bundle');
const Scan = require('./artifact-scan');
const { agentFileName, renderAgentMd } = require('./agent-file');
const { readBoundedFile } = require('./bounded-file');

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const KIND_LABEL = { skill: 'skill', agent: 'agent', workflow: 'workflow', mcp: 'MCP server', prompt: 'prompt' };

const REASONS = {
  'no-scanner': 'Not checked: connect Husk\'s security scanner in Preferences.',
  'scanner-not-found': 'Not checked: the connected scanner could not be found. Choose it again in Preferences.',
  timeout: 'Not checked: the scanner took too long to answer.',
  crashed: 'Not checked: the scanner stopped before it finished.',
  'unreadable-report': 'Not checked: the scanner\'s report could not be read.',
  'unreadable-item': 'Not checked: Husk could not read this item\'s files.',
};

// 'proceed' | 'ask' | 'block'. Silent is content typed into Husk's own form:
// it only interrupts when the scanner reports something.
function decide(scan, { silent = false } = {}) {
  if (!scan || scan.status !== 'scanned') return silent ? 'proceed' : 'ask';
  if (scan.verdict === 'block') return 'block';
  return scan.verdict === 'clear' ? 'proceed' : 'ask';
}

// Before running or enabling an item already in the library. Only a scanner
// finding interrupts, and a "use it anyway" answer holds for the same content.
function decideUse(scan, approved) {
  if (!scan || scan.status !== 'scanned' || scan.verdict === 'clear') return 'proceed';
  if (scan.verdict === 'block') return 'block';
  return approved ? 'proceed' : 'ask';
}

function where(loc) {
  const s = String(loc || '');
  const file = /(?:^|,\s*)(?:file|path):\s*([^,]+)/.exec(s);
  const line = /(?:^|,\s*)line:\s*(\d+)/.exec(s);
  if (file) return line ? `${file[1].trim()}, line ${line[1]}` : file[1].trim();
  return s;
}

function sevLabel(sev) {
  const s = String(sev || '').toUpperCase();
  return SEVERITY_ORDER.includes(s) ? s[0] + s.slice(1).toLowerCase() : 'Note';
}

// Plain-words view of a scan for the dialog and the item badges.
function describe(scan, { top = 5 } = {}) {
  if (!scan || scan.status !== 'scanned') {
    const reason = (scan && scan.reason) || 'no-scanner';
    return {
      state: 'unchecked',
      note: REASONS[reason] || 'Not checked: the scanner gave no usable answer.',
      connect: reason === 'no-scanner' || reason === 'scanner-not-found',
      findings: [], more: 0, reach: [],
    };
  }
  const rank = (f) => { const i = SEVERITY_ORDER.indexOf(String(f.severity).toUpperCase()); return i === -1 ? SEVERITY_ORDER.length : i; };
  const sorted = (scan.findings || []).slice().sort((a, b) => rank(a) - rank(b));
  const findings = sorted.slice(0, top).map((f) => ({
    severity: sevLabel(f.severity),
    title: f.title || f.category || f.id || 'Finding',
    detail: f.description || '',
    evidence: f.evidence || '',
    where: where(f.location),
  }));
  const caps = scan.capabilities || {};
  const list = (xs) => xs.slice(0, 6).join(', ') + (xs.length > 6 ? ` and ${xs.length - 6} more` : '');
  const reach = [];
  if (caps.commands && caps.commands.length) reach.push(`Runs commands: ${list(caps.commands)}`);
  if (caps.hosts && caps.hosts.length) reach.push(`Contacts: ${list(caps.hosts)}`);
  if (caps.files && caps.files.length) reach.push(`Reads or writes: ${list(caps.files)}`);
  const total = Number.isFinite(scan.findingCount) ? scan.findingCount : sorted.length;
  return {
    state: scan.verdict === 'block' ? 'blocked' : scan.verdict === 'clear' ? 'clear' : 'risky',
    note: null, connect: false, findings, more: Math.max(0, total - findings.length), reach,
  };
}

function kindLabel(kind) { return KIND_LABEL[kind] || 'item'; }

function hashFiles(files) {
  return Bundle.contentHash(files.map((f) => ({ path: f.path, sha256: Bundle.sha256Hex(f.content) })));
}

const md = (name, description, body) => {
  const esc = (s) => String(s || '').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return Buffer.from(`---\nname: ${String(name || '')}\ndescription: "${esc(description)}"\n---\n\n${String(body || '').trim()}\n`);
};
const json = (v) => Buffer.from(JSON.stringify(v, (k, x) => (k === 'x' || k === 'y' || k === 'position' ? undefined : x), 2));
const mcpFile = (servers) => [{ path: 'mcp.json', content: json({ mcpServers: servers }) }];

// What an install channel stages for the scanner. null means the channel is
// not gated for this payload. run(dir) installs from the staged folder when the
// handler can take it, else from the original payload.
function installSpec(channel, payload, { fs, resolveAgents, readAgentPicks } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  switch (channel) {
    case 'repoAgents:install': {
      const resolved = resolveAgents(String(p.root || ''));
      if (!resolved) throw new Error('No agents directory found');
      const collected = Bundle.collectDir(fs, resolved.dir);
      if (!collected.ok) throw new Error(collected.error);
      return { kind: 'agent', name: path.basename(String(p.root || 'agents')), files: collected.files.map((f) => ({ ...f, path: `agents/${f.path}` })), payloadFor: (dir) => ({ ...p, root: dir }) };
    }
    case 'workflows:install':
      return { kind: 'workflow', name: (p.artifact && p.artifact.name) || 'Workflow', files: [{ path: 'workflow.json', content: json(p.artifact || p) }] };
    case 'workflows:create':
      return { kind: 'workflow', name: p.name || 'New Workflow', silent: true, files: [{ path: 'workflow.json', content: json({ name: p.name, description: p.description, graph: p.graph }) }] };
    case 'mcp:addMany': {
      const items = Array.isArray(p.items) ? p.items : [];
      return { kind: 'mcp', name: items.map((i) => String((i && i.id) || 'server')).join(', ') || 'MCP configuration', files: mcpFile(Object.fromEntries(items.map((item, i) => [`${i}-${String((item && item.id) || 'server')}`, item]))) };
    }
    case 'mcp:add':
      return { kind: 'mcp', name: String(p.id || 'MCP server'), silent: true, files: mcpFile({ [String(p.id || 'server')]: p }) };
    case 'repoMcp:install':
      return { kind: 'mcp', name: String(p.serverId || (p.server && p.server.name) || 'MCP server'), files: mcpFile({ [String(p.serverId || 'server')]: p.server || {} }) };
    case 'skills:create':
      return { kind: 'skill', name: String(p.name || 'skill'), silent: true, files: [{ path: 'SKILL.md', content: md(p.name, p.description, p.content) }] };
    case 'prompts:create':
      return { kind: 'prompt', name: String(p.name || 'prompt'), silent: true, files: [{ path: `${String(p.name || 'prompt')}.md`, content: md(p.name, p.description, p.content) }] };
    case 'profiles:create':
      return { kind: 'agent', name: String(p.name || 'New Agent'), silent: true, files: [{ path: `agents/${agentFileName(p.name || 'New Agent')}`, content: Buffer.from(renderAgentMd(p)) }] };
    case 'profiles:importAgents': {
      const files = readAgentPicks(Array.isArray(p.picks) ? p.picks : []);
      if (!files.length) return null;
      return { kind: 'agent', name: files.length === 1 ? files[0].path.slice(7).replace(/\.md$/, '') : `${files.length} agents`, files };
    }
    case 'fs:dropFile': {
      if (p.kind !== 'skill' || typeof p.sourcePath !== 'string') return null;
      const base = path.basename(p.sourcePath);
      if (!/^[A-Za-z0-9._-]+$/.test(base) || base.startsWith('..')) return null;
      return { kind: 'skill', name: base.replace(/\.md$/i, ''), files: [{ path: base, content: readBoundedFile(p.sourcePath, Bundle.MAX_FILE_BYTES, fs) }], payloadFor: (dir) => ({ ...p, sourcePath: path.join(dir, base) }) };
    }
    default:
      return null;
  }
}

// Library items: [{ key, kind, id, name, read() -> files or null }].
function skillItems(skills, fs) {
  return skills.map((s) => ({
    key: `skill:${s.name}`, kind: 'skill', id: s.id, name: s.name,
    read: () => { const c = Bundle.collectDir(fs, fs.realpathSync(s.path)); return c.ok ? c.files : null; },
  }));
}
function agentItems(profiles) {
  return profiles.filter((p) => p && !p.builtin).map((p) => ({
    key: `agent:${p.id}`, kind: 'agent', id: p.id, name: p.name || p.id,
    read: () => [{ path: `agents/${agentFileName(p.name || 'agent')}`, content: Buffer.from(renderAgentMd(p)) }],
  }));
}
function workflowItems(workflows) {
  return workflows.filter((w) => w && w.id).map((w) => ({
    key: `workflow:${w.id}`, kind: 'workflow', id: w.id, name: w.name || w.id,
    read: () => [{ path: 'workflow.json', content: json({ name: w.name, description: w.description, graph: w.graph }) }],
  }));
}
function mcpItems(servers) {
  return servers.filter((s) => s && s.id).map((s) => {
    const { enabled, ...entry } = s;
    void enabled;
    return { key: `mcp:${s.id}`, kind: 'mcp', id: s.id, name: s.id, read: () => mcpFile({ [s.id]: entry }) };
  });
}

const slim = (scan) => ({
  status: scan.status, verdict: scan.verdict, reason: scan.reason || null,
  findings: (scan.findings || []).slice(0, 20), findingCount: scan.findingCount || 0, capabilities: scan.capabilities,
});

// Background scanner for what is already installed. One item at a time, a
// pause between scanner runs, results cached by content hash on disk.
function createLibrary({ fs, execFile, tmpRoot, getScanner, storePath, listItems, onUpdate = () => {}, pauseMs = 250 }) {
  let store = { scans: {}, approvals: {} };
  try {
    const raw = storePath ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : null;
    if (raw && typeof raw === 'object') store = { scans: raw.scans || {}, approvals: raw.approvals || {} };
  } catch (_) {}
  const results = new Map();
  let saveTimer = null;
  let notifyTimer = null;
  let running = null;
  let again = false;
  const save = () => {
    if (!storePath) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 }); } catch (_) {}
    }, 500);
    saveTimer.unref?.();
  };
  const notify = () => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; onUpdate(); }, 300);
    notifyTimer.unref?.();
  };
  function scannerId() {
    const s = getScanner();
    if (typeof s !== 'string' || !s || !path.isAbsolute(s)) return null;
    try { const st = fs.statSync(s); return st.isFile() ? `${s}:${st.size}:${st.mtimeMs}` : null; } catch (_) { return null; }
  }
  async function scanFiles(files) {
    const hash = hashFiles(files);
    const sid = scannerId();
    if (!sid) return { hash, scan: Scan.unscanned(getScanner() ? 'scanner-not-found' : 'no-scanner'), ran: false };
    const cacheKey = `${sid}\n${hash}`;
    if (store.scans[cacheKey]) return { hash, scan: store.scans[cacheKey], ran: false };
    const staged = Bundle.stageFiles(fs, files, tmpRoot);
    if (!staged.ok) return { hash, scan: Scan.unscanned('unreadable-item'), ran: false };
    try {
      const scan = await Scan.scanArtifact({ scanner: getScanner(), dir: staged.dir, contentHash: hash, fs, execFile, tmpRoot });
      if (scan.status === 'scanned') {
        const keys = Object.keys(store.scans);
        if (keys.length >= 4000) for (const k of keys.slice(0, keys.length - 3999)) delete store.scans[k];
        store.scans[cacheKey] = slim(scan);
        save();
      }
      return { hash, scan, ran: true };
    } finally { try { fs.rmSync(staged.dir, { recursive: true, force: true }); } catch (_) {} }
  }
  const readItem = (item) => { try { return item.read(); } catch (_) { return null; } };
  async function pass() {
    const sid = scannerId();
    let items;
    try { items = listItems(); } catch (_) { items = []; }
    const keys = new Set(items.map((i) => i.key));
    for (const k of [...results.keys()]) if (!keys.has(k)) results.delete(k);
    if (!sid) { results.clear(); notify(); return; }
    for (const item of items) {
      await new Promise((r) => setImmediate(r));
      const files = readItem(item);
      if (!files) { results.set(item.key, { kind: item.kind, name: item.name, hash: null, scan: Scan.unscanned('unreadable-item'), sid }); notify(); continue; }
      const hash = hashFiles(files);
      const prev = results.get(item.key);
      if (prev && prev.hash === hash && prev.sid === sid) continue;
      const { scan, ran } = await scanFiles(files);
      results.set(item.key, { kind: item.kind, name: item.name, hash, scan, sid });
      notify();
      if (ran && pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    notify();
  }
  function refresh() {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await pass(); } while (again); } finally { running = null; }
    })();
    return running;
  }
  function snapshot() {
    const items = {};
    for (const [key, r] of results) {
      if (r.scan.status === 'scanned' && r.scan.verdict === 'clear') continue;
      const d = describe(r.scan, { top: 3 });
      items[key] = { state: d.state, note: d.note, findings: d.findings, more: d.more, approved: !!(r.hash && store.approvals[r.hash]) };
    }
    const s = getScanner();
    return { scanner: !!scannerId(), reason: scannerId() ? null : (s ? 'scanner-not-found' : 'no-scanner'), items };
  }
  function approve(hash) { if (hash) { store.approvals[hash] = Date.now(); save(); } }
  // ask(details) resolves true for "use it anyway". Without ask, a flagged
  // item that has no approval is refused.
  async function checkUse(key, ask) {
    let items;
    try { items = listItems(); } catch (_) { items = []; }
    const item = items.find((i) => i.key === key);
    if (!item) return true;
    const files = readItem(item);
    if (!files) return true;
    const { hash, scan } = await scanFiles(files);
    results.set(key, { kind: item.kind, name: item.name, hash, scan, sid: scannerId() });
    notify();
    const d = decideUse(scan, !!store.approvals[hash]);
    if (d === 'proceed') return true;
    if (!ask) return false;
    const yes = await ask({ kind: item.kind, name: item.name, scan, blocked: d === 'block' });
    if (yes && d === 'ask') { approve(hash); notify(); return true; }
    return false;
  }
  // key -> hash for one kind, so an approved install can approve what it added.
  function hashes(kind) {
    const out = new Map();
    let items;
    try { items = listItems().filter((i) => i.kind === kind); } catch (_) { items = []; }
    for (const item of items) { const files = readItem(item); if (files) out.set(item.key, hashFiles(files)); }
    return out;
  }
  function approveNew(kind, before) {
    for (const [key, hash] of hashes(kind)) if (before.get(key) !== hash) approve(hash);
    refresh();
  }
  return { refresh, snapshot, checkUse, hashes, approveNew, approve, scanFiles, get running() { return !!running; } };
}

module.exports = {
  REASONS, decide, decideUse, describe, kindLabel, hashFiles, installSpec,
  skillItems, agentItems, workflowItems, mcpItems, createLibrary,
};
