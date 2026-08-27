'use strict';

// The workflow registry: reading an index of workflows somebody else publishes.
//
// A registry is one URL to one JSON file listing workflows and where their
// .husk.json files live. There is no account, no upload and no server of ours:
// publishing is committing a file to a repo, and subscribing is pasting that
// repo's raw URL. Anyone can run one, which is the point.
//
// This module is the trust boundary for that index. The boundary is the byte.
// Everything inside the file, including the digests it states about its own
// artifacts, comes from a machine this one does not control and is read that
// way. Two things follow, and they are the whole design:
//
//   1. An index entry is a CLAIM, never a fact. Step counts, agent names,
//      authorship and dates are what a stranger wrote about their own file.
//      Nothing here upgrades a claim by repeating it, and every exported name
//      keeps the word: `claims`. The one thing this machine can settle is
//      whether the bytes it fetched are the bytes the index named, and that is
//      computed here rather than read from the file.
//
//   2. The index grants no new power. An entry names a workflow file; that file
//      goes through workflow-artifact.js exactly as a file picked off disk
//      does, and nothing in an entry can widen what that validator will accept.
//      A registry cannot introduce a step, an agent or an MCP server: it can
//      only point at a file that still has to survive the same gate.
//
// A stated digest that does not match the bytes is a refusal, not a downgrade.
// Contradicted evidence is worse than absent evidence, because absent evidence
// is honest about itself.
//
// The module is pure: no fs, no network, no clock, no Electron. Fetching the
// bytes, with its timeout and its redirect policy, belongs to main.js. That is
// what lets every rule here run as an ordinary unit test.
//
// Every exported function is total. Any input, including an object whose
// getters throw, yields either a validated result or a structured refusal.

const crypto = require('crypto');
const { ALLOWED_AGENT_COMMANDS } = require('./workflow-graph');
const { MAX_NODES } = require('./workflow-artifact');

// ─── the format ──────────────────────────────────────────────────────────

const REGISTRY_KIND = 'husk.registry';

// Forward-only. An index declaring a version above this is refused whole, with
// both numbers named, and never partially parsed.
const MAX_REGISTRY_SCHEMA = 1;

// An index is a catalog, not a payload: it carries names and pointers, so it is
// held to a far smaller ceiling than the artifacts it points at.
const MAX_INDEX_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;

// Field ceilings. A string over its ceiling is clipped rather than refused,
// because an over-long description is a formatting problem and not an attack,
// and refusing the whole index over one would hand any publisher a way to break
// every other entry in it.
const MAX_NAME = 80;
const MAX_DESCRIPTION = 400;
const MAX_AUTHOR = 60;
const MAX_REGISTRY_NAME = 80;
const MAX_TAGS = 8;
const MAX_AGENTS = 6;

// Ids are slugs so that they can sit in a URL, a filename and a DOM id without
// any of the three needing an escaping rule of its own. Both ends are
// alphanumeric, so there is exactly one spelling of any given id and two rows
// cannot differ by a hyphen nobody can see.
const ID_RE = /^[a-z0-9]$|^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const TAG_RE = /^[a-z0-9]$|^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

// Why an index or an entry was refused. Closed, because the browse surface
// keys its recovery copy off these strings.
const REFUSAL_CODES = [
  'not-json',
  'not-object',
  'not-registry',
  'schema-too-new',
  'too-large',
  'no-entries',
  'bad-registry-url',
  'bad-artifact-url',
  'cross-origin-artifact',
  'digest-mismatch',
  'digest-malformed',
];

function refuse(code, message, detail) {
  return {
    ok: false,
    code,
    message: String(message),
    detail: (detail === undefined || detail === null) ? null : String(detail).slice(0, 512),
  };
}

// ─── field readers ───────────────────────────────────────────────────────

// Reads one property off an untrusted object without letting a throwing getter
// take the whole parse down with it.
function get(obj, key) {
  try { return obj[key]; } catch (_) { return undefined; }
}

// A single visible line, clipped. Control characters become a replacement mark
// rather than disappearing, so a name cannot be made to look like a shorter one
// by hiding characters inside it.
function line(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, '\uFFFD').trim().slice(0, max);
}

function slug(value, re) {
  return (typeof value === 'string' && re.test(value)) ? value : '';
}

// An ISO instant, or an empty string. Kept as the author's own text rather than
// reformatted: this is a claim about when they last touched the file, and it is
// displayed as one.
function instant(value) {
  if (typeof value !== 'string') return '';
  const t = Date.parse(value);
  return Number.isFinite(t) ? value.slice(0, 40) : '';
}

// A count the index states about its own workflow. Bounded by the same ceiling
// the artifact validator enforces, so a number no real artifact could have is
// dropped rather than shown.
function count(value, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

// Agent names, narrowed to the ones Husk can actually run. An unknown name is
// dropped rather than shown: the row exists to tell a reader whether this will
// run on their machine, and a name Husk has never heard of answers nothing.
function agents(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value.slice(0, MAX_AGENTS * 4)) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().toLowerCase();
    if (ALLOWED_AGENT_COMMANDS.has(name) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_AGENTS) break;
  }
  return out;
}

function tags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value.slice(0, MAX_TAGS * 4)) {
    const t = slug(typeof raw === 'string' ? raw.trim().toLowerCase() : '', TAG_RE);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ─── URLs ────────────────────────────────────────────────────────────────

// A registry URL a user pasted. https only, and no credentials in it: an index
// that needs a password is not a public catalog, and embedding one in config
// would put it in every log line that ever prints the registry.
function normalizeRegistryUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return refuse('bad-registry-url', 'paste the URL of a registry index', null);
  let url;
  try { url = new URL(raw); } catch (_) {
    return refuse('bad-registry-url', 'that is not a URL', raw.slice(0, 120));
  }
  if (url.protocol !== 'https:') {
    return refuse('bad-registry-url', 'a registry must be served over https', url.protocol);
  }
  if (url.username || url.password) {
    return refuse('bad-registry-url', 'a registry URL may not carry credentials', url.host);
  }
  url.hash = '';
  return { ok: true, url: url.toString() };
}

// Where one entry's artifact lives, resolved against the index that named it.
//
// The result has to be on the index's own origin. Adding a registry is then a
// decision about exactly one host: the catalog cannot quietly source its files
// from somewhere the person who subscribed never agreed to.
function resolveArtifactUrl(entry, indexUrl) {
  const rel = typeof get(entry, 'artifact') === 'string' ? get(entry, 'artifact').trim() : '';
  if (!rel) return refuse('bad-artifact-url', 'this entry does not say where its workflow file is', null);

  let base;
  try { base = new URL(String(indexUrl)); } catch (_) {
    return refuse('bad-registry-url', 'the registry URL is not a URL', String(indexUrl).slice(0, 120));
  }
  let url;
  try { url = new URL(rel, base); } catch (_) {
    return refuse('bad-artifact-url', 'this entry points at something that is not a URL', rel.slice(0, 120));
  }
  if (url.protocol !== 'https:') {
    return refuse('bad-artifact-url', 'a workflow file must be served over https', url.protocol);
  }
  if (url.username || url.password) {
    return refuse('bad-artifact-url', 'a workflow file URL may not carry credentials', url.host);
  }
  if (url.origin !== base.origin) {
    return refuse('cross-origin-artifact',
      'this entry points at a different host than the registry it is listed in',
      `${base.origin} lists ${url.origin}`);
  }
  url.hash = '';
  return { ok: true, url: url.toString() };
}

// ─── digests ─────────────────────────────────────────────────────────────

// Whether the bytes that arrived are the bytes the index named.
//
// This is the one thing about an entry this machine can settle for itself, and
// the only reason the digest is worth carrying. It is not a signature: it says
// the catalog and the file agree, which rules out the file changing underneath
// a catalog nobody updated. It does not say who wrote either, so no caller may
// print the word "verified" off the back of it.
//
// A stated digest that does not match is a refusal. An absent one is not: it
// leaves the entry unattested, which is a thing a surface can say plainly.
function checkArtifactBytes(bytes, entry) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes == null ? '' : bytes), 'utf8');
  const computed = crypto.createHash('sha256').update(buf).digest('hex');

  const stated = typeof get(entry, 'sha256') === 'string' ? get(entry, 'sha256').trim().toLowerCase() : '';
  if (!stated) {
    return { ok: true, digest: computed, attested: false, tier: 'computed' };
  }
  if (!SHA256_RE.test(stated)) {
    return refuse('digest-malformed', 'this entry states a digest that is not a sha256', stated.slice(0, 80));
  }
  if (stated !== computed) {
    return refuse('digest-mismatch',
      'the file that arrived is not the file this registry lists',
      `listed ${stated.slice(0, 16)}…, got ${computed.slice(0, 16)}…`);
  }
  return { ok: true, digest: computed, attested: true, tier: 'computed' };
}

// ─── the index ───────────────────────────────────────────────────────────

// One row of the catalog, with every field carried under `claims` except the id
// and the pointer. The naming is the whole guardrail: a surface that reaches for
// `entry.claims.steps` cannot forget where that number came from.
function readEntry(raw, seen) {
  if (!raw || typeof raw !== 'object') return null;
  const id = slug(typeof get(raw, 'id') === 'string' ? get(raw, 'id').trim() : '', ID_RE);
  if (!id || seen.has(id)) return null;
  const name = line(get(raw, 'name'), MAX_NAME);
  if (!name) return null;
  const artifact = typeof get(raw, 'artifact') === 'string' ? get(raw, 'artifact').trim().slice(0, 512) : '';
  if (!artifact) return null;

  seen.add(id);
  return {
    id,
    artifact,
    sha256: slug(typeof get(raw, 'sha256') === 'string' ? get(raw, 'sha256').trim().toLowerCase() : '', SHA256_RE),
    claims: {
      name,
      description: line(get(raw, 'description'), MAX_DESCRIPTION),
      author: line(get(raw, 'author'), MAX_AUTHOR),
      tags: tags(get(raw, 'tags')),
      agents: agents(get(raw, 'agents')),
      steps: count(get(raw, 'steps'), MAX_NODES),
      updatedAt: instant(get(raw, 'updatedAt')),
    },
  };
}

// Validates an already-parsed index object.
function validateIndex(obj, opts = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return refuse('not-object', 'a registry index is a JSON object', null);
  }
  if (get(obj, 'kind') !== REGISTRY_KIND) {
    return refuse('not-registry', 'this file does not say it is a Husk workflow registry', String(get(obj, 'kind')).slice(0, 80));
  }
  // A number, not something that coerces to one. A file spelling its version as
  // a string is not written to this format, and reading it anyway would mean the
  // next reader has to guess which spellings the last one happened to accept.
  const schema = get(obj, 'schemaVersion');
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema < 1) {
    return refuse('not-registry', 'this registry does not state a schema version', String(schema).slice(0, 40));
  }
  if (schema > MAX_REGISTRY_SCHEMA) {
    return refuse('schema-too-new',
      'this registry is written for a newer Husk than the one running',
      `index says ${schema}, this build reads ${MAX_REGISTRY_SCHEMA}`);
  }

  const rawList = get(obj, 'workflows');
  if (!Array.isArray(rawList)) {
    return refuse('no-entries', 'this registry lists no workflows', null);
  }

  const seen = new Set();
  const entries = [];
  // Reading past the ceiling is pointless work on a file that is already
  // refused below, so the walk stops one entry after it.
  for (const raw of rawList.slice(0, MAX_ENTRIES + 1)) {
    const entry = readEntry(raw, seen);
    if (entry) entries.push(entry);
    if (entries.length > MAX_ENTRIES) break;
  }
  if (entries.length > MAX_ENTRIES) {
    return refuse('too-large', `a registry may list at most ${MAX_ENTRIES} workflows`, `${rawList.length} listed`);
  }
  if (!entries.length) {
    return refuse('no-entries', 'this registry lists no workflows this build can read', `${rawList.length} rejected`);
  }

  return {
    ok: true,
    index: {
      url: typeof opts.url === 'string' ? opts.url : '',
      schemaVersion: schema,
      claims: {
        name: line(get(obj, 'name'), MAX_REGISTRY_NAME),
        updatedAt: instant(get(obj, 'updatedAt')),
      },
      entries,
      // How many rows the file held that this build could not read. Shown
      // rather than swallowed: a catalog that half-loads should say so.
      skipped: Math.max(0, Math.min(rawList.length, MAX_ENTRIES + 1) - entries.length),
    },
  };
}

// Validates raw index bytes: size, JSON, then shape.
function parseIndex(bytes, opts = {}) {
  try {
    let text;
    if (typeof bytes === 'string') {
      const size = Buffer.byteLength(bytes, 'utf8');
      if (size > MAX_INDEX_BYTES) {
        return refuse('too-large', `a registry index is limited to ${MAX_INDEX_BYTES} bytes`, `${size} bytes`);
      }
      text = bytes;
    } else if (Buffer.isBuffer(bytes)) {
      if (bytes.length > MAX_INDEX_BYTES) {
        return refuse('too-large', `a registry index is limited to ${MAX_INDEX_BYTES} bytes`, `${bytes.length} bytes`);
      }
      text = bytes.toString('utf8');
    } else {
      return refuse('not-json', 'expected the index contents as a string or a Buffer', typeof bytes);
    }

    let obj;
    try { obj = JSON.parse(text); } catch (err) {
      return refuse('not-json', 'this registry index is not valid JSON', err && err.message);
    }
    return validateIndex(obj, opts);
  } catch (err) {
    return refuse('not-json', 'this registry index could not be read', err && err.message);
  }
}

// ─── browsing ────────────────────────────────────────────────────────────

// Entries matching a free-text query and an optional tag, newest claim first.
//
// Matching is a literal run of characters over the name, description, author
// and tags. It is deliberately not the palette's gapped matching: a catalog is
// browsed rather than recalled, and a gapped match over a paragraph returns
// rows with no visible connection to what was typed.
function searchEntries(entries, query, tag) {
  const list = Array.isArray(entries) ? entries : [];
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const want = typeof tag === 'string' ? tag.trim().toLowerCase() : '';

  const hit = (e) => {
    if (want && !e.claims.tags.includes(want)) return false;
    if (!q) return true;
    return `${e.claims.name} ${e.claims.description} ${e.claims.author} ${e.claims.tags.join(' ')}`
      .toLowerCase().includes(q);
  };

  return list.filter(hit).sort((a, b) => {
    const at = Date.parse(a.claims.updatedAt || '') || 0;
    const bt = Date.parse(b.claims.updatedAt || '') || 0;
    return bt - at || a.claims.name.localeCompare(b.claims.name);
  });
}

// Every tag in the catalog with how many entries carry it, commonest first.
function tagCounts(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const tally = new Map();
  for (const e of list) for (const t of e.claims.tags) tally.set(t, (tally.get(t) || 0) + 1);
  return [...tally.entries()]
    .map(([tag, n]) => ({ tag, count: n }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

module.exports = {
  REGISTRY_KIND,
  MAX_REGISTRY_SCHEMA,
  MAX_INDEX_BYTES,
  MAX_ENTRIES,
  REFUSAL_CODES,
  normalizeRegistryUrl,
  resolveArtifactUrl,
  checkArtifactBytes,
  validateIndex,
  parseIndex,
  searchEntries,
  tagCounts,
};
