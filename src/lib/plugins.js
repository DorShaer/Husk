'use strict';

// Agent-CLI plugin registry reader for the Husk Plugins page.
//
// Read-only over the registry files an agent CLI maintains under its
// config dir (first supported source: ~/.claude/plugins). Mutations
// (install / uninstall / enable / disable / update) are NOT done here;
// main.js shells out to the agent CLI so the CLI stays the single
// writer of its own registry. This module only parses what is on disk
// into plain serializable shapes for the renderer.
//
// Everything is defensive: a missing or malformed registry file means
// "no plugins", never a throw. The renderer paints empty states.

const fs = require('fs');
const path = require('path');
const { isInside } = require('./path-confine');

// Plugin identifiers look like "name" or "name@marketplace". Both parts
// are slug-ish. The id is passed to the agent CLI as ONE argv element,
// so the only real risks are flag injection (leading dash) and control
// characters; the regex forbids both.
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const MAX_ID_LEN = 200;

// Editor guard rails: only obviously-text files, capped in size, so the
// inline editor never loads a binary blob or a giant artifact.
const TEXT_EXTS = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.yaml', '.yml', '.toml', '.sh', '.py', '.css', '.html', '.xml',
  '.svg', '.env', '.gitignore', '.cfg', '.ini',
]);
const MAX_FILE_BYTES = 512 * 1024;
// File-tree walk caps so a pathological plugin dir cannot hang the IPC.
const MAX_TREE_FILES = 400;
const MAX_TREE_DEPTH = 6;

function isSafePluginId(id) {
  return typeof id === 'string' && id.length <= MAX_ID_LEN && PLUGIN_ID_RE.test(id);
}

// All knowledge of the CLI's plugin command shape lives here, next to
// the registry-file knowledge, so a future second plugin-capable agent
// forks one module instead of chasing argv fragments through main.js.
// Returns the argv array (to spawn WITHOUT a shell) or null when the
// action or id is invalid.
const PLUGIN_CLI_VERBS = new Set(['install', 'uninstall', 'enable', 'disable', 'update']);
function buildPluginCliArgs(action, id) {
  if (!PLUGIN_CLI_VERBS.has(action)) return null;
  if (!isSafePluginId(id)) return null;
  return ['plugin', action, id];
}

function pluginsRoot(claudeDir) {
  return path.join(claudeDir, 'plugins');
}

function readJsonQuiet(p) {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- callers pass registry paths rooted in claudeDir
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

// Installed plugins, joined with the enabled map from settings.json.
// A plugin absent from enabledPlugins is disabled (verified against the
// CLI's own `plugin list` output).
function readInstalled(claudeDir) {
  const reg = readJsonQuiet(path.join(pluginsRoot(claudeDir), 'installed_plugins.json'));
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

function readMarketplaces(claudeDir) {
  const known = readJsonQuiet(path.join(pluginsRoot(claudeDir), 'known_marketplaces.json'));
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

// Union of every known marketplace's catalog. Entries carry which
// marketplace they came from so install can target name@marketplace.
function readCatalog(claudeDir) {
  const out = [];
  for (const mp of readMarketplaces(claudeDir)) {
    if (!mp.installLocation) continue;
    const manifest = readJsonQuiet(path.join(mp.installLocation, '.claude-plugin', 'marketplace.json'));
    const plugins = manifest && Array.isArray(manifest.plugins) ? manifest.plugins : [];
    for (const p of plugins) {
      if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name) continue;
      out.push({
        name: p.name,
        marketplace: mp.name,
        id: `${p.name}@${mp.name}`,
        description: typeof p.description === 'string' ? p.description : '',
        category: typeof p.category === 'string' ? p.category : '',
        author: p.author && typeof p.author.name === 'string' ? p.author.name : '',
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Name and size checks are separate so the write path (which sizes the
// incoming content, not the file on disk) can use the name half alone.
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
function isInsidePluginsRoot(claudeDir, absPath) {
  return isInside(pluginsRoot(claudeDir), absPath);
}

module.exports = {
  MAX_FILE_BYTES,
  isSafePluginId,
  buildPluginCliArgs,
  readInstalled,
  readMarketplaces,
  readCatalog,
  listPluginFiles,
  isEditableFile,
  isEditableName,
  isInsidePluginsRoot,
};
