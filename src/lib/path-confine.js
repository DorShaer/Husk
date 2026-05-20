'use strict';

const path = require('path');

// resolveInside(root, name) returns an absolute path that is provably
// inside `root`. Throws when `name` is empty, absolute, contains a
// null byte, or would resolve outside `root`. Use whenever a fixed
// root is joined with a name that comes from outside the function.
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

// isInside is the predicate form: true when `target` resolves under `root`.
function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false;
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  return targetAbs === rootAbs || targetAbs.startsWith(rootAbs + path.sep);
}

module.exports = { resolveInside, isInside };
