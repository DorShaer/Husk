'use strict';

// Remote URL to web URL, as an allowlist.
//
// webUrlFor(remoteUrl, opts) answers an https URL string or null. Every step
// has to pass for a URL to come back: a known transport, a host that survives
// its own re-parse unchanged, no embedded credential, and a path built segment
// by segment from encoded parts. Anything else answers null, because a guess
// here becomes a page the user's browser opens.

const MAX_INPUT = 2048;

// Transports a remote can legitimately use. The output is always https.
const SCHEMES = ['https', 'http', 'ssh', 'git'];

// A host is a run of dot-separated labels and nothing else, so a bracketed
// address, an empty label and any delimiter smuggled into the authority all
// fail here.
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const PORT = /^\d{1,5}$/;
const USER = /^[a-z0-9._-]{1,64}$/i;
const SHA = /^[0-9a-f]{7,64}$/i;

// A remote is one printable run: any space or control byte disqualifies it.
function isTight(s) {
  if (typeof s !== 'string' || !s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return false;
  }
  return true;
}

// A ref or a path may hold a space; a control byte never belongs in either.
function isClean(s) {
  if (typeof s !== 'string' || !s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
}

function familyOf(host) {
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github';
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) return 'gitlab';
  if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) return 'bitbucket';
  return 'generic';
}

function hostAndPath(authority, pathPart) {
  let host = authority;
  const colon = host.indexOf(':');
  if (colon !== -1) {
    const port = host.slice(colon + 1);
    host = host.slice(0, colon);
    if (!PORT.test(port)) return null;
  }
  host = host.toLowerCase();
  if (!HOST.test(host)) return null;
  return { host, path: pathPart };
}

// Split a scheme URL or an scp-style remote into a host and a path. Userinfo is
// refused outright on an http or https remote, where a credential is what it
// would carry, and accepted only as a plain transport user elsewhere.
function splitRemote(raw) {
  const s = raw.trim();
  if (!s || s.length > MAX_INPUT || !isTight(s)) return null;

  const marker = s.indexOf('://');
  if (marker !== -1) {
    const scheme = s.slice(0, marker).toLowerCase();
    if (!SCHEMES.includes(scheme)) return null;
    const rest = s.slice(marker + 3);
    const slash = rest.indexOf('/');
    let authority = slash === -1 ? rest : rest.slice(0, slash);
    const pathPart = slash === -1 ? '' : rest.slice(slash + 1);
    const at = authority.lastIndexOf('@');
    if (at !== -1) {
      const user = authority.slice(0, at);
      authority = authority.slice(at + 1);
      if (scheme === 'http' || scheme === 'https') return null;
      if (!USER.test(user)) return null;
    }
    return hostAndPath(authority, pathPart);
  }

  const scp = s.match(/^([^@/:]+)@([^@/:]+):(.+)$/);
  if (scp) {
    if (!USER.test(scp[1])) return null;
    return hostAndPath(scp[2], scp[3]);
  }
  return null;
}

// Repository path parts: the trailing .git and any surrounding slashes come
// off, and every remaining part has to be an ordinary name.
function repoSegments(pathPart) {
  let p = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.toLowerCase().endsWith('.git')) p = p.slice(0, -4);
  if (!p) return null;
  const segs = p.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') return null;
  }
  return segs;
}

// Parts of a ref or a repository-relative path, each encoded on its own so a
// slash inside a part cannot become a new path level.
function encodeParts(value) {
  const parts = String(value).replace(/^\/+/, '').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null;
    out.push(encodeURIComponent(part));
  }
  return out.length ? out : null;
}

function lineNumber(line) {
  const n = Number(line);
  return Number.isInteger(n) && n > 0 && n <= 10000000 ? n : null;
}

function webUrlFor(remoteUrl, options) {
  try {
    if (typeof remoteUrl !== 'string') return null;
    const opts = options && typeof options === 'object' ? options : {};
    const parsed = splitRemote(remoteUrl);
    if (!parsed) return null;
    const segs = repoSegments(parsed.path);
    if (!segs) return null;

    const family = familyOf(parsed.host);
    const base = 'https://' + parsed.host + '/' + segs.map(encodeURIComponent).join('/');
    const kind = opts.kind || 'repo';
    let url = base;

    if (kind === 'commit') {
      if (typeof opts.sha !== 'string' || !SHA.test(opts.sha)) return null;
      if (family === 'gitlab') url = base + '/-/commit/' + opts.sha;
      else if (family === 'bitbucket') url = base + '/commits/' + opts.sha;
      else url = base + '/commit/' + opts.sha;
    } else if (kind === 'file') {
      if (!isClean(opts.ref) || !isClean(opts.path)) return null;
      const ref = encodeParts(opts.ref);
      const rel = encodeParts(opts.path);
      if (!ref || !rel) return null;
      const tail = ref.join('/') + '/' + rel.join('/');
      if (family === 'gitlab') url = base + '/-/blob/' + tail;
      else if (family === 'bitbucket') url = base + '/src/' + tail;
      else url = base + '/blob/' + tail;
      const line = lineNumber(opts.line);
      if (line) url += family === 'bitbucket' ? '#lines-' + line : '#L' + line;
    } else if (kind !== 'repo') {
      return null;
    }

    // The built URL has to survive its own parse as the same host on https with
    // nothing attached to it.
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (u.hostname !== parsed.host) return null;
    if (u.username || u.password || u.port) return null;
    return u.href;
  } catch (_) {
    return null;
  }
}

module.exports = { webUrlFor };
