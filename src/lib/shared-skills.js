'use strict';

const path = require('node:path');

const DISABLED_PREFIX = '_disabled_';

function skillLocations(home, kiroHome) {
  return {
    shared: path.join(home, '.agents', 'skills'),
    claude: path.join(home, '.claude', 'skills'),
    kiro: path.join(kiroHome || path.join(home, '.kiro'), 'skills'),
  };
}

function isLink(fs, target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch (_) { return false; }
}

function linkDir(fs, source, target, platform) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, platform === 'win32' ? 'junction' : 'dir');
}

function isSkillDirectory(fs, root, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(root, entry.name)).isDirectory(); } catch (_) { return false; }
}

// Keep one physical library at ~/.agents/skills, which Codex, Copilot and
// Gemini discover directly. Claude and Kiro use native per-agent roots, so
// Husk exposes shared entries there with directory links. Existing skill
// directories are preserved and take precedence over a shared link.
function prepareSharedSkills({ fs, home, platform = process.platform, kiroHome } = {}) {
  if (!fs || !home) throw new TypeError('fs and home are required');
  const roots = skillLocations(home, kiroHome);
  const disabledRoot = path.join(home, '.config', 'husk', 'skills-disabled');
  fs.mkdirSync(path.dirname(roots.shared), { recursive: true });

  if (!fs.existsSync(roots.shared) && fs.existsSync(roots.claude) && !isLink(fs, roots.claude)) {
    fs.renameSync(roots.claude, roots.shared);
  } else {
    fs.mkdirSync(roots.shared, { recursive: true });
  }

  // Disabled directories must live outside every native discovery root.
  fs.mkdirSync(disabledRoot, { recursive: true });
  for (const root of [roots.shared, ...(isLink(fs, roots.claude) ? [] : [roots.claude])]) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.startsWith(DISABLED_PREFIX)) continue;
      const source = path.join(root, ent.name);
      const target = path.join(disabledRoot, ent.name);
      if (fs.existsSync(target)) continue;
      try { fs.renameSync(source, target); } catch (_) {}
    }
  }

  // Adopt pre-existing Claude skills as shared links without moving or
  // rewriting their content. This makes a skill installed before Husk's
  // shared library available to agents that read ~/.agents/skills.
  if (fs.existsSync(roots.claude) && !isLink(fs, roots.claude)) {
    let entries = [];
    try { entries = fs.readdirSync(roots.claude, { withFileTypes: true }); } catch (_) {}
    for (const ent of entries) {
      if (!isSkillDirectory(fs, roots.claude, ent) || ent.name.startsWith(DISABLED_PREFIX)) continue;
      const source = path.join(roots.claude, ent.name);
      const target = path.join(roots.shared, ent.name);
      if (!fs.existsSync(target)) {
        try { linkDir(fs, source, target, platform); } catch (_) {}
      }
    }
  }

  for (const root of [roots.claude, roots.kiro]) {
    if (isLink(fs, root)) continue;
    fs.mkdirSync(root, { recursive: true });
    let nativeEntries = [];
    try { nativeEntries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    for (const ent of nativeEntries) {
      const target = path.join(root, ent.name);
      if (!isLink(fs, target)) continue;
      let linked = '';
      try { linked = path.resolve(path.dirname(target), fs.readlinkSync(target)); } catch (_) {}
      if (linked.startsWith(path.resolve(roots.shared) + path.sep) && !fs.existsSync(target)) {
        try { fs.unlinkSync(target); } catch (_) {}
      }
    }
    let entries = [];
    try { entries = fs.readdirSync(roots.shared, { withFileTypes: true }); } catch (_) {}
    for (const ent of entries) {
      if (!isSkillDirectory(fs, roots.shared, ent) || ent.name.startsWith(DISABLED_PREFIX)) continue;
      const target = path.join(root, ent.name);
      if (fs.existsSync(target)) continue;
      if (isLink(fs, target)) { try { fs.unlinkSync(target); } catch (_) {} }
      try { linkDir(fs, path.join(roots.shared, ent.name), target, platform); } catch (_) {}
    }
  }
  return roots;
}

module.exports = { DISABLED_PREFIX, skillLocations, prepareSharedSkills };
