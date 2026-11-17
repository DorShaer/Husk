'use strict';

// A shareable bundle: one JSON file carrying a manifest and the files of one
// agent, skill, workflow, prompt or MCP entry. This module validates, packs
// and unpacks. Installing is main.js's job, through the existing importers.
// fs is injected, and every failure is { ok: false, code, error }.

const crypto = require('node:crypto');
const path = require('node:path');
const { stableJson } = require('./stable-json');
const { readBoundedFile } = require('./bounded-file');

const BUNDLE_FORMAT = 'husk-bundle';
const BUNDLE_VERSION = 1;
const KINDS = ['agent', 'skill', 'workflow', 'prompt', 'mcp'];
const FILE_ACCESS = ['none', 'read', 'write'];

const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
// Ceiling for the bundle file itself, base64 overhead included.
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const SKILL_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.js', '.mjs', '.cjs', '.ts', '.py', '.sh'];
const ALLOWED_EXTENSIONS = {
  agent: ['.md'],
  skill: SKILL_EXTENSIONS,
  workflow: ['.json'],
  prompt: ['.md'],
  mcp: ['.json'],
};

function fail(code, error) { return { ok: false, code, error }; }
function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Null when the path is an acceptable relative file path, else the reason.
function pathProblem(p) {
  if (typeof p !== 'string' || !p) return 'a file has no path';
  if (p.length > 240) return `the path "${p.slice(0, 40)}..." is too long`;
  // eslint-disable-next-line no-control-regex -- control characters are the thing being refused
  if (/[\x00-\x1f\x7f]/.test(p)) return 'a file path contains control characters';
  if (p.includes(':')) return 'a file path contains a colon';
  if (p.split('/').some((s) => /[. ]$/.test(s) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))) return 'a file path uses a reserved name';
  if (p.includes('\\')) return `the path "${p}" uses a backslash`;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return `the path "${p}" is absolute`;
  for (const seg of p.split('/')) {
    if (seg === '') return `the path "${p}" has an empty segment`;
    if (seg === '.' || seg === '..') return `the path "${p}" leaves the bundle folder`;
  }
  return null;
}

function validateManifest(m) {
  if (!isPlainObject(m)) return fail('bad-manifest', 'the bundle has no manifest');
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(m.id)) return fail('bad-manifest', 'the manifest id must be lowercase letters, digits, dots, dashes or underscores');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80) return fail('bad-manifest', 'the manifest needs a name of at most 80 characters');
  if (!KINDS.includes(m.kind)) return fail('bad-kind', `the kind must be one of ${KINDS.join(', ')}`);
  if (typeof m.version !== 'string' || !(/^\d+\.\d+\.\d+$/.test(m.version) || /^\d+\.\d+\.\d+[-+][0-9A-Za-z.-]{1,32}$/.test(m.version))) return fail('bad-manifest', 'the version must look like 1.2.3');
  if (typeof m.publisher !== 'string' || !m.publisher.trim() || m.publisher.length > 80) return fail('bad-manifest', 'the manifest needs a publisher of at most 80 characters');
  if (typeof m.description !== 'string' || m.description.length > 500) return fail('bad-manifest', 'the description must be text of at most 500 characters');
  const perms = m.permissions;
  if (!isPlainObject(perms)) return fail('bad-permissions', 'the manifest must declare its permissions');
  if (typeof perms.runsCommands !== 'boolean') return fail('bad-permissions', 'permissions.runsCommands must be true or false');
  if (!Array.isArray(perms.networkHosts) || perms.networkHosts.length > 50
    || !perms.networkHosts.every((h) => typeof h === 'string' && /^[A-Za-z0-9*]([A-Za-z0-9.*-]{0,252})$/.test(h))) {
    return fail('bad-permissions', 'permissions.networkHosts must be a list of host names');
  }
  if (!FILE_ACCESS.includes(perms.fileAccess)) return fail('bad-permissions', `permissions.fileAccess must be one of ${FILE_ACCESS.join(', ')}`);
  return {
    ok: true,
    manifest: {
      id: m.id,
      name: m.name.trim(),
      kind: m.kind,
      version: m.version,
      publisher: m.publisher.trim(),
      description: m.description,
      permissions: { runsCommands: perms.runsCommands, networkHosts: perms.networkHosts.slice(), fileAccess: perms.fileAccess },
    },
  };
}

// The layout each kind's importer reads.
function layoutProblem(kind, paths) {
  if (kind === 'agent') {
    const bad = paths.find((p) => !/^agents\/[^/]+\.md$/.test(p));
    return bad ? `an agent bundle holds only agents/<name>.md files, and "${bad}" is not one` : null;
  }
  if (kind === 'skill') return paths.includes('SKILL.md') ? null : 'a skill bundle needs a SKILL.md at its top level';
  if (paths.length !== 1) return `a ${kind} bundle holds exactly one file`;
  if (paths[0].includes('/')) return `a ${kind} bundle keeps its file at the top level`;
  if (kind === 'prompt' && !/^[a-z][a-z0-9-]*\.md$/.test(paths[0])) return 'a prompt file is named with lowercase letters, digits and dashes, ending in .md';
  if (kind === 'mcp' && paths[0] !== 'mcp.json') return 'an MCP bundle holds one file named mcp.json';
  return null;
}

// The bytes a publisher signs: the manifest and each file's path and hash.
function signingBytes(manifest, files) {
  const list = files.map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return Buffer.from(stableJson({ files: list, format: BUNDLE_FORMAT, manifest }), 'utf8');
}

// One hash for the whole staged content, used as the scan cache key.
function contentHash(files) {
  const list = files.map((f) => ({ path: f.path, sha256: f.sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(Buffer.from(stableJson(list), 'utf8'));
}

function publicKeyFrom(b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch (_) { return null; }
}

// unsigned, verified (key is a trusted publisher), untrusted (signed by a key
// this machine does not list) or invalid (the signature does not match).
function checkSignature(signature, manifest, files, trustedPublishers) {
  if (signature === undefined || signature === null) return { state: 'unsigned', publisher: null };
  if (!isPlainObject(signature) || typeof signature.publicKey !== 'string' || typeof signature.value !== 'string') return { state: 'invalid', publisher: null };
  const key = publicKeyFrom(signature.publicKey);
  if (!key) return { state: 'invalid', publisher: null };
  let good = false;
  try { good = crypto.verify(null, signingBytes(manifest, files), key, Buffer.from(signature.value, 'base64')); } catch (_) {}
  if (!good) return { state: 'invalid', publisher: null };
  const der = key.export({ format: 'der', type: 'spki' });
  for (const t of Array.isArray(trustedPublishers) ? trustedPublishers : []) {
    const tk = t && publicKeyFrom(t.publicKey);
    if (tk && tk.export({ format: 'der', type: 'spki' }).equals(der)) {
      return { state: 'verified', publisher: typeof t.name === 'string' && t.name ? t.name : manifest.publisher };
    }
  }
  return { state: 'untrusted', publisher: null };
}

// Returns { ok, bundle: { manifest, files: [{ path, sha256, size, content }], signature } }
// with content as a Buffer, or the first failure.
function validateBundle(input, opts = {}) {
  if (!isPlainObject(input)) return fail('not-a-bundle', 'that file is not a Husk bundle');
  if (input.format !== BUNDLE_FORMAT) return fail('not-a-bundle', 'that file is not a Husk bundle');
  if (input.formatVersion !== BUNDLE_VERSION) return fail('unsupported-version', 'this bundle was made for a different version of Husk');
  const mv = validateManifest(input.manifest);
  if (!mv.ok) return mv;
  const manifest = mv.manifest;

  if (!Array.isArray(input.files) || !input.files.length) return fail('no-files', 'the bundle has no files');
  if (input.files.length > MAX_FILES) return fail('too-many-files', `the bundle has more than ${MAX_FILES} files`);
  const allowed = ALLOWED_EXTENSIONS[manifest.kind];
  const seen = new Set();
  const files = [];
  let total = 0;
  for (const f of input.files) {
    if (!isPlainObject(f)) return fail('bad-file', 'a file entry is not an object');
    const problem = pathProblem(f.path);
    if (problem) return fail('bad-path', problem);
    if ((f.type !== undefined && f.type !== 'file') || f.link !== undefined || f.target !== undefined) {
      return fail('link-not-allowed', `"${f.path}" is not a regular file`);
    }
    const key = f.path.toLowerCase();
    if (seen.has(key)) return fail('duplicate-path', `"${f.path}" appears more than once`);
    seen.add(key);
    const ext = path.posix.extname(f.path).toLowerCase();
    if (!allowed.includes(ext)) return fail('type-not-allowed', `"${f.path}" is not a file type a ${manifest.kind} bundle may carry`);
    if (typeof f.content !== 'string') return fail('bad-file', `"${f.path}" has no content`);
    if (f.encoding !== undefined && f.encoding !== 'utf8' && f.encoding !== 'base64') return fail('bad-file', `"${f.path}" has an unknown encoding`);
    if (f.encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(f.content)) return fail('bad-file', `"${f.path}" is not valid base64`);
    const content = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8');
    if (content.length > MAX_FILE_BYTES) return fail('file-too-large', `"${f.path}" is larger than ${MAX_FILE_BYTES} bytes`);
    total += content.length;
    if (total > MAX_TOTAL_BYTES) return fail('bundle-too-large', `the bundle's files add up to more than ${MAX_TOTAL_BYTES} bytes`);
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) return fail('bad-hash', `"${f.path}" has no sha256`);
    if (sha256Hex(content) !== f.sha256) return fail('hash-mismatch', `"${f.path}" does not match its sha256`);
    files.push({ path: f.path, sha256: f.sha256, size: content.length, content });
  }
  const layout = layoutProblem(manifest.kind, files.map((f) => f.path));
  if (layout) return fail('bad-layout', layout);

  const signature = checkSignature(input.signature, manifest, files, opts.trustedPublishers);
  if (signature.state === 'invalid') return fail('bad-signature', 'the publisher signature does not match the bundle contents');
  return { ok: true, bundle: { manifest, files, signature } };
}

function parseBundle(text, opts) {
  if (typeof text !== 'string' && !Buffer.isBuffer(text)) return fail('not-a-bundle', 'that file is not a Husk bundle');
  if (Buffer.byteLength(text) > MAX_BUNDLE_BYTES) return fail('bundle-too-large', 'that file is too large to be a Husk bundle');
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch (_) { return fail('not-json', 'that file is not valid JSON'); }
  return validateBundle(parsed, opts);
}

// Build a bundle from a manifest and [{ path, content }]. privateKey, when
// given, is a KeyObject and signs the result. Returns { ok, bundle, text }.
function packBundle(manifest, files, opts = {}) {
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const content = Buffer.isBuffer(f && f.content) ? f.content : Buffer.from(String((f && f.content) ?? ''), 'utf8');
    const text = content.toString('utf8');
    const isText = Buffer.from(text, 'utf8').equals(content);
    out.push(Object.assign(
      { path: f && f.path, sha256: sha256Hex(content) },
      isText ? { content: text } : { encoding: 'base64', content: content.toString('base64') },
    ));
  }
  const bundle = { format: BUNDLE_FORMAT, formatVersion: BUNDLE_VERSION, manifest, files: out };
  const checked = validateBundle(bundle);
  if (!checked.ok) return checked;
  bundle.manifest = checked.bundle.manifest;
  if (opts.privateKey) {
    try {
      bundle.signature = {
        algorithm: 'ed25519',
        publicKey: crypto.createPublicKey(opts.privateKey).export({ format: 'der', type: 'spki' }).toString('base64'),
        value: crypto.sign(null, signingBytes(bundle.manifest, checked.bundle.files), opts.privateKey).toString('base64'),
      };
    } catch (_) { return fail('sign-failed', 'the bundle could not be signed with that key'); }
  }
  return { ok: true, bundle, text: JSON.stringify(bundle, null, 2) };
}

// Read a folder into [{ path, content }], regular files only.
function collectDir(fs, root) {
  const files = [];
  let total = 0;
  let entries = 0;
  const walk = (dir, rel, depth = 0) => {
    if (depth > 16) return fail('folder-too-deep', 'that folder has more than 16 nested levels');
    for (const name of fs.readdirSync(dir).sort()) {
      if (++entries > 1000) return fail('too-many-entries', 'that folder has more than 1000 entries');
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) return fail('link-not-allowed', `"${relPath}" is a link, and a bundle carries regular files only`);
      if (st.isDirectory()) {
        const r = walk(abs, relPath, depth + 1);
        if (r) return r;
        continue;
      }
      if (!st.isFile()) return fail('link-not-allowed', `"${relPath}" is not a regular file`);
      if (st.size > MAX_FILE_BYTES) return fail('file-too-large', `"${relPath}" is larger than ${MAX_FILE_BYTES} bytes`);
      const content = readBoundedFile(abs, MAX_FILE_BYTES, fs);
      total += content.length;
      if (files.length >= MAX_FILES) return fail('too-many-files', `that folder has more than ${MAX_FILES} files`);
      if (total > MAX_TOTAL_BYTES) return fail('bundle-too-large', `that folder's files add up to more than ${MAX_TOTAL_BYTES} bytes`);
      files.push({ path: relPath, content });
    }
    return null;
  };
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) return fail('not-a-folder', 'that path is not a folder');
    const r = walk(root, '');
    if (r) return r;
  } catch (err) { return fail('read-failed', `that folder could not be read: ${err.message}`); }
  return { ok: true, files };
}

// Write validated files into a new private folder under tmpRoot. The live
// location is never the target.
function stageFiles(fs, files, tmpRoot) {
  let dir = null;
  try {
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error('Invalid file count');
    const seen = new Set();
    let total = 0;
    for (const f of files) {
      if (!Buffer.isBuffer(f.content) || f.content.length > MAX_FILE_BYTES) throw new Error('Invalid file size');
      total += f.content.length;
      const name = String(f.path).toLowerCase();
      if (total > MAX_TOTAL_BYTES || seen.has(name)) throw new Error('Invalid staged contents');
      seen.add(name);
    }
    dir = fs.mkdtempSync(path.join(tmpRoot, 'husk-stage-'));
    fs.chmodSync(dir, 0o700);
    for (const f of files) {
      const problem = pathProblem(f.path);
      if (problem) throw new Error(problem);
      const target = path.join(dir, ...f.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, f.content, { flag: 'wx', mode: 0o600 });
    }
    return { ok: true, dir };
  } catch (err) {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
    return fail('stage-failed', `the files could not be staged: ${err.message}`);
  }
}

module.exports = {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  KINDS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_BUNDLE_BYTES,
  ALLOWED_EXTENSIONS,
  pathProblem,
  sha256Hex,
  signingBytes,
  contentHash,
  validateBundle,
  parseBundle,
  packBundle,
  collectDir,
  stageFiles,
};
