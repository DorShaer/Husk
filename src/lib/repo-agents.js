'use strict';

// Agent install-from-repo helpers: URL validation, local-path validation,
// and translation of git / filesystem failures into user-facing messages.
// Pure logic, no Electron, so it can be unit tested directly (mirrors
// src/lib/repo-mcp.js).

const fs = require('fs');
const path = require('path');

const MAX_URL_LENGTH = 2048;
const URL_EXAMPLE = 'https://github.com/dev/agent-repo';

// Validate a pasted repository URL. Returns { ok: true, url, dirName } where
// url is the normalized clone target and dirName a filesystem-safe folder
// name, or { ok: false, error } with a message ready for the UI.
function validateRepoUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Enter a repository URL first.' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'That URL is too long to be a repository address.' };
  let u;
  try { u = new URL(raw); } catch (_) {
    return { ok: false, error: `That does not look like a repository URL. Expected something like ${URL_EXAMPLE}.` };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, error: 'Only https:// repository URLs are supported.' };
  }
  if (u.username || u.password) {
    return { ok: false, error: 'Remove the credentials from the URL; only public repositories can be cloned.' };
  }
  const segments = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (!segments.length) {
    return { ok: false, error: `That URL points to a site, not a repository. Expected something like ${URL_EXAMPLE}.` };
  }
  const dirName = [u.hostname, ...segments].join('-').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 200);
  return { ok: true, url: u.href, dirName };
}

// Validate a local repository path. Returns { ok: true, root } with the
// trimmed path, or { ok: false, error } with a friendly message.
function validateLocalRoot(input) {
  const root = String(input || '').trim();
  if (!root) return { ok: false, error: 'Enter a folder path first.' };
  if (!path.isAbsolute(root)) {
    return { ok: false, error: 'Enter a full path starting with / (or use Browse).' };
  }
  let st;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-picked repo root
    st = fs.statSync(root);
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      return { ok: false, error: 'Husk does not have permission to read that folder.' };
    }
    return { ok: false, error: 'That folder does not exist. Check the path and try again.' };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: 'That path is a file. Point Husk at the repository folder instead.' };
  }
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- user-picked repo root
    fs.readdirSync(root);
  } catch (_) {
    return { ok: false, error: 'Husk does not have permission to read that folder.' };
  }
  return { ok: true, root };
}

// Translate a git clone/pull failure into a friendly message. Accepts the
// execFile error (message contains the command line plus stderr) and never
// echoes local paths or the raw command back to the user.
function friendlyCloneError(err) {
  if (!err) return 'Clone failed.';
  if (err.code === 'ENOENT') return 'Git is not installed. Install git and try again.';
  if (err.killed || err.signal === 'SIGTERM') return 'Cloning timed out. Check your connection and try again.';
  const text = String(err.message || '');
  if (/repository .* not found|404/i.test(text)) {
    return 'Repository not found. Check the URL, and make sure the repository is public.';
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled|access denied|403/i.test(text)) {
    // GitHub answers a nonexistent repo with a credential prompt too, so the
    // two cases cannot be told apart without authenticating.
    return 'Repository not found, or it is private. Check the URL; only public repositories can be cloned.';
  }
  if (/Could not resolve host|unable to access|Connection (refused|timed out)|SSL/i.test(text)) {
    return 'Could not reach that host. Check your network connection and the URL.';
  }
  if (/Permission denied|EACCES|could not create work tree/i.test(text)) {
    return 'Husk cannot write to its data folder (permission denied).';
  }
  if (/not a git repository|does not appear to be a git repository/i.test(text)) {
    return 'That URL is not a git repository.';
  }
  // Surface git's own "fatal:" line when there is one; it is the only line
  // that describes the failure without echoing the command or local paths.
  const fatal = text.split('\n').map((l) => l.trim()).find((l) => /^fatal:/i.test(l));
  if (fatal) return `Clone failed. ${fatal.replace(/^fatal:\s*/i, '')}`.slice(0, 200);
  return 'Clone failed. Check the URL and your connection, then try again.';
}

// Translate a filesystem error thrown while scanning a repo into a friendly
// message.
function friendlyScanError(err) {
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
    return 'Husk does not have permission to read that folder.';
  }
  if (err && err.code === 'ENOENT') {
    return 'That folder does not exist. Check the path and try again.';
  }
  if (err && err.code === 'EMFILE') {
    return 'Too many open files. Close some applications and try again.';
  }
  return 'Could not read that folder. Check the path and try again.';
}

module.exports = {
  validateRepoUrl,
  validateLocalRoot,
  friendlyCloneError,
  friendlyScanError,
  URL_EXAMPLE,
};
