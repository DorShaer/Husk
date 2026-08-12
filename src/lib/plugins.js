'use strict';

// Agent-CLI plugin registry reader for the Husk Plugins page.
//
// Read-only over the registry files an agent CLI maintains under its
// config dir (first supported sources: ~/.claude/plugins and
// ~/.copilot/installed-plugins). Mutations
// (install / uninstall / enable / disable / update) are NOT done here;
// main.js shells out to the agent CLI so the CLI stays the single
// writer of its own registry. This module only parses what is on disk
// into plain serializable shapes for the renderer.
//
// A missing or malformed registry file reads as "no plugins" rather than
// throwing, and the renderer paints empty states.

const fs = require('fs');
const path = require('path');
const { isInside } = require('./path-confine');

// Plugin identifiers look like "name" or "name@marketplace". Each part is a
// slug that starts with an alphanumeric and holds only word characters,
// dots, dashes and underscores.
const PLUGIN_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ID_LEN = 200;

// The inline editor opens obviously-text files, up to a size cap.
const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.yaml', '.yml', '.toml', '.sh', '.py', '.css', '.html', '.xml',
  '.svg', '.env', '.gitignore', '.cfg', '.ini',
]);
const MAX_FILE_BYTES = 512 * 1024;
// Caps on the file-tree walk.
const MAX_TREE_FILES = 400;
const MAX_TREE_DEPTH = 6;
const COPILOT_DEFAULT_MARKETPLACES = [
  { name: 'copilot-plugins', repo: 'github/copilot-plugins' },
  { name: 'awesome-copilot', repo: 'github/awesome-copilot' },
];

function isSafePluginId(id) {
  if (typeof id !== 'string' || !id.length || id.length > MAX_ID_LEN) return false;
  const parts = id.split('@');
  if (parts.length > 2) return false;
  return parts.every((p) => PLUGIN_PART_RE.test(p));
}

// The CLI's plugin command shape lives here, next to the registry-file
// knowledge. Returns the argv array, or null when the action or id is
// invalid.
const PLUGIN_CLI_VERBS = {
  claude: new Set(['install', 'uninstall', 'enable', 'disable', 'update']),
  copilot: new Set(['install', 'uninstall', 'update']),
};
function normalizeAgent(agent) {
  return agent === 'copilot' ? 'copilot' : 'claude';
}
function pluginCapabilities(agent) {
  const a = normalizeAgent(agent);
  return {
    canBrowse: true,
    canEdit: true,
    canEnableDisable: a === 'claude',
  };
}
function buildPluginCliArgs(agentOrAction, actionOrId, maybeId) {
  const hasAgent = arguments.length >= 3;
  const agent = hasAgent ? normalizeAgent(agentOrAction) : 'claude';
  const action = hasAgent ? actionOrId : agentOrAction;
  const id = hasAgent ? maybeId : actionOrId;
  const verbs = PLUGIN_CLI_VERBS[agent] || PLUGIN_CLI_VERBS.claude;
  if (!verbs.has(action)) return null;
  if (!isSafePluginId(id)) return null;
  return ['plugin', action, id];
}

function pluginsRoot(agentDir, agent = 'claude') {
  return normalizeAgent(agent) === 'copilot'
    ? path.join(agentDir, 'installed-plugins')
    : path.join(agentDir, 'plugins');
}

function readJsonQuiet(p) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- callers pass fixed agent registry/cache paths
    const raw = fs.readFileSync(p, 'utf8');
    try { return JSON.parse(raw); } catch (_) {}
    // Copilot's ~/.copilot/config.json starts with a managed-file // header.
    // Only trim leading non-JSON text; do not strip comments inside strings.
    const start = raw.search(/[\[{]/);
    return start > 0 ? JSON.parse(raw.slice(start)) : null;
  } catch (_) { return null; }
}

// Installed plugins, joined with the enabled map from settings.json.
// A plugin absent from enabledPlugins is disabled (verified against the
// CLI's own `plugin list` output).
function readClaudeInstalled(claudeDir) {
  const reg = readJsonQuiet(path.join(pluginsRoot(claudeDir, 'claude'), 'installed_plugins.json'));
  const settings = readJsonQuiet(path.join(claudeDir, 'settings.json'));
  const enabledMap = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? settings.enabledPlugins : {};
  const out = [];
  const plugins = reg && reg.plugins && typeof reg.plugins === 'object' ? reg.plugins : {};
  for (const id of Object.keys(plugins)) {
    const installs = Array.isArray(plugins[id]) ? plugins[id] : [];
    const inst = installs.find((x) => x && x.scope === 'user') || installs[0];
    if (!inst || typeof inst !== 'object') continue;
    const at = id.lastIndexOf('@');
    out.push({
      id,
      name: at > 0 ? id.slice(0, at) : id,
      marketplace: at > 0 ? id.slice(at + 1) : '',
      version: typeof inst.version === 'string' ? inst.version : '',
      installPath: typeof inst.installPath === 'string' ? inst.installPath : '',
      lastUpdated: inst.lastUpdated || inst.installedAt || '',
      enabled: enabledMap[id] === true,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readCopilotInstalled(copilotDir) {
  const state = readJsonQuiet(path.join(copilotDir, 'config.json'));
  const settings = readJsonQuiet(path.join(copilotDir, 'settings.json'));
  const enabledMap = settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object'
    ? settings.enabledPlugins : {};
  const out = [];
  const plugins = state && Array.isArray(state.installedPlugins) ? state.installedPlugins : [];
  for (const inst of plugins) {
    if (!inst || typeof inst !== 'object' || typeof inst.name !== 'string' || !inst.name) continue;
    const marketplace = typeof inst.marketplace === 'string' ? inst.marketplace : '';
    const id = marketplace ? `${inst.name}@${marketplace}` : inst.name;
    if (!isSafePluginId(id)) continue;
    const hasEnabledSetting = Object.prototype.hasOwnProperty.call(enabledMap, id);
    out.push({
      id,
      name: inst.name,
      marketplace,
      version: typeof inst.version === 'string' ? inst.version : '',
      installPath: typeof inst.cache_path === 'string' ? inst.cache_path : '',
      lastUpdated: inst.last_updated || inst.updated_at || inst.installed_at || '',
      enabled: hasEnabledSetting ? enabledMap[id] === true : inst.enabled !== false,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readInstalled(agentDir, agent = 'claude') {
  return normalizeAgent(agent) === 'copilot'
    ? readCopilotInstalled(agentDir)
    : readClaudeInstalled(agentDir);
}

function readClaudeMarketplaces(claudeDir) {
  const known = readJsonQuiet(path.join(pluginsRoot(claudeDir, 'claude'), 'known_marketplaces.json'));
  const out = [];
  if (!known || typeof known !== 'object') return out;
  for (const name of Object.keys(known)) {
    const m = known[name];
    if (!m || typeof m !== 'object') continue;
    out.push({
      name,
      repo: m.source && typeof m.source.repo === 'string' ? m.source.repo : '',
      installLocation: typeof m.installLocation === 'string' ? m.installLocation : '',
      lastUpdated: m.lastUpdated || '',
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function cacheDirForRepo(cacheDir, repo) {
  if (!cacheDir) return '';
  return path.join(cacheDir, 'marketplaces', String(repo || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
}

function readMarketplaceManifest(installLocation) {
  for (const rel of [
    path.join('.claude-plugin', 'marketplace.json'),
    path.join('.github', 'plugin', 'marketplace.json'),
    'marketplace.json',
  ]) {
    const manifest = readJsonQuiet(path.join(installLocation, rel));
    if (manifest && typeof manifest === 'object') return manifest;
  }
  return null;
}

function readCopilotMarketplaces(copilotDir, cacheDir) {
  const marketRoot = cacheDir ? path.join(cacheDir, 'marketplaces') : '';
  const out = [];
  const seen = new Set();
  const add = (name, repo, installLocation) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, repo: repo || '', installLocation: installLocation || '', lastUpdated: '' });
  };

  for (const mp of COPILOT_DEFAULT_MARKETPLACES) {
    add(mp.name, mp.repo, cacheDirForRepo(cacheDir || '', mp.repo));
  }

  const settings = readJsonQuiet(path.join(copilotDir, 'settings.json'));
  const extra = settings && settings.extraKnownMarketplaces;
  const addExtra = (name, value) => {
    if (!name) return;
    if (typeof value === 'string') {
      add(name, value, cacheDirForRepo(cacheDir || '', value));
    } else if (value && typeof value === 'object') {
      const repo = typeof value.repo === 'string' ? value.repo
        : (value.source && typeof value.source.repo === 'string' ? value.source.repo : '');
      const loc = typeof value.installLocation === 'string' ? value.installLocation
        : (repo ? cacheDirForRepo(cacheDir || '', repo) : '');
      add(typeof value.name === 'string' ? value.name : name, repo, loc);
    }
  };
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (typeof item === 'string') addExtra(item.split('/').pop(), item);
      else if (item && typeof item === 'object') addExtra(item.name, item);
    }
  } else if (extra && typeof extra === 'object') {
    for (const [name, value] of Object.entries(extra)) addExtra(name, value);
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is the agent-owned Copilot cache root
    for (const ent of fs.readdirSync(marketRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const loc = path.join(marketRoot, ent.name);
      const manifest = readMarketplaceManifest(loc);
      const name = manifest && typeof manifest.name === 'string' ? manifest.name : ent.name;
      add(name, '', loc);
    }
  } catch (_) {}

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readMarketplaces(agentDir, agent = 'claude', cacheDir = '') {
  return normalizeAgent(agent) === 'copilot'
    ? readCopilotMarketplaces(agentDir, cacheDir)
    : readClaudeMarketplaces(agentDir);
}

// Union of every known marketplace's catalog. Entries carry which
// marketplace they came from so install can target name@marketplace.
function readCatalog(agentDir, agent = 'claude', cacheDir = '') {
  const out = [];
  for (const mp of readMarketplaces(agentDir, agent, cacheDir)) {
    if (!mp.installLocation) continue;
    const manifest = normalizeAgent(agent) === 'copilot'
      ? readMarketplaceManifest(mp.installLocation)
      : readJsonQuiet(path.join(mp.installLocation, '.claude-plugin', 'marketplace.json'));
    const marketplace = manifest && typeof manifest.name === 'string' ? manifest.name : mp.name;
    const plugins = manifest && Array.isArray(manifest.plugins) ? manifest.plugins : [];
    for (const p of plugins) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name) continue;
      const id = `${p.name}@${marketplace}`;
      if (!isSafePluginId(id)) continue;
      out.push({
        name: p.name,
        marketplace,
        id,
        version: typeof p.version === 'string' ? p.version
          : (typeof p.latestVersion === 'string' ? p.latestVersion
            : (typeof p.latest_version === 'string' ? p.latest_version : '')),
        description: typeof p.description === 'string' ? p.description : '',
        category: typeof p.category === 'string' ? p.category : '',
        author: p.author && typeof p.author.name === 'string' ? p.author.name : '',
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Name and size checks are separate, so the write path can use the name
// half alone against the incoming content.
function isEditableName(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  const base = path.basename(relPath);
  return TEXT_EXTS.has(ext) || TEXT_EXTS.has(base.toLowerCase());
}

function isEditableFile(relPath, sizeBytes) {
  return isEditableName(relPath) && Number.isFinite(sizeBytes) && sizeBytes <= MAX_FILE_BYTES;
}

// Flat recursive file listing of one plugin's install dir. Returns
// rel paths with size + editable flag; depth and count capped.
function listPluginFiles(installPath) {
  const files = [];
  const walk = (dir, rel, depth) => {
    if (depth > MAX_TREE_DEPTH || files.length >= MAX_TREE_FILES) return;
    let dirents;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under installPath
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) { return; }
    for (const ent of dirents) {
      if (files.length >= MAX_TREE_FILES) return;
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const relChild = rel ? rel + '/' + ent.name : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        walk(abs, relChild, depth + 1);
      } else if (ent.isFile()) {
        let size = 0;
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- bounded under installPath
        try { size = fs.statSync(abs).size; } catch (_) { continue; }
        files.push({ path: relChild, size, editable: isEditableFile(relChild, size) });
      }
    }
  };
  walk(installPath, '', 0);
  // Binary compare, not localeCompare: file order must be deterministic
  // across machines and locales.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

// The editor's read/write confinement: the absolute file path must sit
// under the plugins root (cache installs live there).
function isInsidePluginsRoot(agentDir, absPath, agent = 'claude') {
  return isInside(pluginsRoot(agentDir, agent), absPath);
}

module.exports = {
  MAX_FILE_BYTES,
  isSafePluginId,
  pluginCapabilities,
  buildPluginCliArgs,
  readInstalled,
  readMarketplaces,
  readCatalog,
  listPluginFiles,
  isEditableFile,
  isEditableName,
  isInsidePluginsRoot,
};
