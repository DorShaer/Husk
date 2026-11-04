'use strict';

// Parser for `git status --porcelain=v1` output.
//
// parsePorcelain(text) turns the machine-readable status into an array of
// { path, status, staged, unstaged } entries. `status` is a human label,
// `staged`/`unstaged` are booleans derived from the two XY status columns.
//
// statusBadge(status) maps a human label to a single-letter badge.

// C-style escapes git emits inside quoted paths, mapped to byte values.
const { unquote } = require('./git-quote');

function labelFor(code) {
  switch (code) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    case 'U': return 'conflicted';
    default: return 'modified';
  }
}

// Unmerged combinations that git reports for merge conflicts.
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function parsePorcelain(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;

  // Records are newline terminated in porcelain=v1 (NUL only with -z).
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length < 3) continue;

    const x = line[0];
    const y = line[1];
    const two = x + y;
    let field = line.slice(3);

    let status;
    let staged;
    let unstaged;

    if (two === '??') {
      status = 'untracked';
      staged = false;
      unstaged = true;
    } else if (two === '!!') {
      status = 'ignored';
      staged = false;
      unstaged = false;
    } else if (x === 'U' || y === 'U' || CONFLICT_CODES.has(two)) {
      status = 'conflicted';
      staged = x !== ' ';
      unstaged = y !== ' ';
    } else {
      staged = x !== ' ';
      unstaged = y !== ' ';
      const primary = x !== ' ' ? x : y;
      status = labelFor(primary);
    }

    let oldPath;
    if (status === 'renamed' || status === 'copied') {
      const arrow = field.indexOf(' -> ');
      if (arrow !== -1) {
        oldPath = unquote(field.slice(0, arrow));
        field = field.slice(arrow + 4);
      }
    }

    const entry = {
      path: unquote(field),
      status,
      staged,
      unstaged,
    };
    if (oldPath) entry.oldPath = oldPath;
    out.push(entry);
  }

  return out;
}

function statusBadge(status) {
  switch (status) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'untracked': return '?';
    case 'renamed': return 'R';
    case 'copied': return 'C';
    case 'type-changed': return 'T';
    case 'conflicted': return 'U';
    case 'ignored': return '!';
    default: return '?';
  }
}

module.exports = {
  parsePorcelain,
  statusBadge,
};
