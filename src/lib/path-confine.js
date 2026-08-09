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

// realParentInside asks the filesystem where a path's PARENT actually is, and
// whether that is still under root.
//
// The two functions above are string arithmetic. They collapse "..", they never
// read the disk, and so they say nothing about what a name points at. That is
// enough for a path that already exists, because the caller can canonicalize
// the path itself and compare. It is not enough for a path that does not exist
// yet: there is nothing to canonicalize, realpath throws, and a create that
// falls back to the unresolved string writes through whatever the directories
// along it happen to be. A link at any component is then a write outside root
// that every string check approved.
//
// Returns false when the parent cannot be resolved at all, so a caller that
// cannot establish where it is about to write does not write.
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

module.exports = { resolveInside, isInside, realParentInside };
