'use strict';

// Argument allowlist for every value that reaches a git argv.
//
// Each validator answers { ok: true, value } or { ok: false, reason }. The
// reason is a short lowercase fragment a caller can drop into a sentence, and
// it never repeats the rejected value back, so a refusal cannot become an echo
// of whatever was sent.
//
// validateBranchName / validateRef  a ref name
// validateSha                       a full or abbreviated commit id
// validateStashRef                  stash@{N} or a commit id
// validatePathspec                  a repository-relative path

const MAX_BYTES = 255;
const MAX_PATH_BYTES = 4096;

// Characters git itself refuses in a ref name, plus the ones that open the
// revision grammar.
const NAME_CHARS = /[ ~^?*[\\]/;

const HEX = /^[0-9a-f]{7,64}$/;
const HEX_ANY_CASE = /^[0-9a-fA-F]{7,64}$/;
const STASH = /^stash@\{\d{1,4}\}$/;

function hasControl(v) {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function ok(value) {
  return { ok: true, value };
}

function no(reason) {
  return { ok: false, reason };
}

// The rules every ref-shaped value shares. Returns a reason or null.
function refLikeReason(v) {
  if (typeof v !== 'string') return 'must be text';
  if (!v) return 'must not be empty';
  if (Buffer.byteLength(v, 'utf8') > MAX_BYTES) return 'is longer than 255 bytes';
  if (hasControl(v)) return 'contains a control character';
  if (v.charCodeAt(0) === 0x2d) return 'starts with a dash, which git reads as an option';
  if (v === '@') return 'is a bare at sign, which git reads as a position';
  if (v.includes('@{')) return 'contains a reflog expression';
  if (v.includes('..')) return 'contains a range expression';
  if (v.includes(':')) return 'contains a colon';
  if (v.includes('//')) return 'contains an empty path part';
  if (v.startsWith('/') || v.endsWith('/')) return 'starts or ends with a slash';
  if (v.startsWith('.') || v.endsWith('.')) return 'starts or ends with a dot';
  if (v.endsWith('.lock')) return 'ends with a suffix git reserves';
  if (NAME_CHARS.test(v)) return 'contains a character git does not allow in a name';
  return null;
}

// A branch name. Refuses a bare commit id and HEAD, so a field that promised a
// branch cannot carry a revision.
function validateBranchName(v) {
  const reason = refLikeReason(v);
  if (reason) return no(reason);
  if (v === 'HEAD') return no('is a position, not a branch name');
  if (HEX_ANY_CASE.test(v)) return no('is a commit id, not a branch name');
  return ok(v);
}

// A ref name. HEAD and a commit id are both legitimate here.
function validateRef(v) {
  const reason = refLikeReason(v);
  if (reason) return no(reason);
  return ok(v);
}

// A commit id and nothing else: no revision expression is accepted in a sha
// field, which closes the .., ..., @{, ^ and ~ grammar in one test.
function validateSha(v) {
  if (typeof v !== 'string') return no('must be text');
  if (!HEX.test(v)) return no('is not a commit id');
  return ok(v);
}

// A stash reference: the stash@{N} form the stash list prints, or the commit id
// a stash push hands back.
function validateStashRef(v) {
  if (typeof v !== 'string') return no('must be text');
  if (STASH.test(v) || HEX.test(v)) return ok(v);
  return no('is not a stash reference');
}

// A repository-relative path. A leading colon in any form is pathspec magic,
// which resolves inside the root and so survives a path-confinement check on
// its own. Dot files are ordinary files, so a leading dot passes here; a '.' or
// '..' part does not.
function validatePathspec(v) {
  if (typeof v !== 'string') return no('must be text');
  if (!v) return no('must not be empty');
  if (Buffer.byteLength(v, 'utf8') > MAX_PATH_BYTES) return no('is longer than a path can be');
  if (hasControl(v)) return no('contains a control character');
  if (v.charCodeAt(0) === 0x2d) return no('starts with a dash, which git reads as an option');
  if (v.startsWith(':')) return no('starts with a colon, which git reads as pathspec magic');
  if (v.includes(':')) return no('contains a colon');
  if (v.startsWith('/')) return no('is absolute');
  if (v.endsWith('/')) return no('ends with a slash');
  if (v.includes('//')) return no('contains an empty path part');
  if (v.endsWith('.')) return no('ends with a dot');
  const parts = v.split('/');
  for (const part of parts) {
    if (part === '.' || part === '..') return no('walks out of the repository');
  }
  return ok(v);
}

module.exports = {
  validateBranchName,
  validateRef,
  validateSha,
  validateStashRef,
  validatePathspec,
};
