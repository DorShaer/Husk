'use strict';

const path = require('path');

// Joins root and name, returning an absolute path under root. Throws when name
// is empty, absolute, contains a null byte, or resolves outside root.
function resolveInside(root, name) {
  if (typeof root !== 'string' || !root) throw new Error('resolveInside: root required');
  if (typeof name !== 'string' || !name) throw new Error('resolveInside: name required');
  if (name.indexOf('\x00') !== -1) throw new Error('resolveInside: null byte');
  if (path.isAbsolute(name)) throw new Error('resolveInside: absolute path');
  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, name);
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) {
    throw new Error('resolveInside: outside root');
  }
  return candidate;
}

// True when target resolves under root, by string only.
function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  return targetAbs === rootAbs || targetAbs.startsWith(rootAbs + path.sep);
}

// True when target's parent directory, as the filesystem resolves it, is under
// root. Use before creating a file. False when the parent cannot be resolved.
function realParentInside(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string' || !target || !root) return false;
  const fs = require('fs');
  try {
    const rootReal = fs.realpathSync(path.resolve(root));
    const parentReal = fs.realpathSync(path.dirname(path.resolve(target)));
    return parentReal === rootReal || parentReal.startsWith(rootReal + path.sep);
  } catch (_) {
    return false;
  }
}

// True when target itself, as the filesystem resolves it, is under root. Use
// before reading or writing an existing path. False when it cannot be resolved.
function realPathInside(target, root) {
  if (typeof target !== 'string' || typeof root !== 'string' || !target || !root) return false;
  const fs = require('fs');
  try {
    const rootReal = fs.realpathSync(path.resolve(root));
    const targetReal = fs.realpathSync(path.resolve(target));
    return targetReal === rootReal || targetReal.startsWith(rootReal + path.sep);
  } catch (_) {
    return false;
  }
}

module.exports = { resolveInside, isInside, realParentInside, realPathInside };
