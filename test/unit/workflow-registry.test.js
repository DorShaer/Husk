'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const R = require('../../src/lib/workflow-registry');

const INDEX_URL = 'https://raw.githubusercontent.com/dorshaer/husk-workflows/main/index.json';

function entry(over = {}) {
  return {
    id: 'triage',
    name: 'Security triage',
    description: 'Fans scanners out and gates on the findings',
    author: 'dorshaer',
    tags: ['security', 'review'],
    agents: ['claude', 'codex'],
    steps: 7,
    updatedAt: '2026-08-01T00:00:00Z',
    artifact: 'workflows/triage.husk.json',
    ...over,
  };
}

function index(over = {}, entries = [entry()]) {
  return { kind: 'husk.registry', schemaVersion: 1, name: 'Husk Workflows', workflows: entries, ...over };
}

const parse = (obj, url = INDEX_URL) => R.parseIndex(JSON.stringify(obj), { url });

// ─── the envelope ────────────────────────────────────────────────────────

test('a well-formed index parses and keeps the URL it came from', () => {
  const r = parse(index());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.index.url, INDEX_URL);
  assert.strictEqual(r.index.schemaVersion, 1);
  assert.strictEqual(r.index.claims.name, 'Husk Workflows');
  assert.strictEqual(r.index.entries.length, 1);
});

test('a file that does not say it is a registry is refused', () => {
  assert.strictEqual(parse(index({ kind: 'husk.workflow' })).code, 'not-registry');
  assert.strictEqual(parse(index({ kind: undefined })).code, 'not-registry');
});

test('an index written for a newer Husk is refused whole, naming both versions', () => {
  const r = parse(index({ schemaVersion: R.MAX_REGISTRY_SCHEMA + 1 }));
  assert.strictEqual(r.code, 'schema-too-new');
  assert.match(r.detail, /index says 2/);
  assert.match(r.detail, /this build reads 1/);
});

test('an index with no schema version is refused rather than assumed to be version 1', () => {
  assert.strictEqual(parse(index({ schemaVersion: undefined })).code, 'not-registry');
  assert.strictEqual(parse(index({ schemaVersion: '1' })).code, 'not-registry');
  assert.strictEqual(parse(index({ schemaVersion: 0 })).code, 'not-registry');
});

test('malformed bytes are refused rather than thrown over', () => {
  assert.strictEqual(R.parseIndex('{not json', { url: INDEX_URL }).code, 'not-json');
  assert.strictEqual(R.parseIndex(null, { url: INDEX_URL }).code, 'not-json');
  assert.strictEqual(R.parseIndex('[]', { url: INDEX_URL }).code, 'not-object');
  assert.strictEqual(R.parseIndex('"a string"', { url: INDEX_URL }).code, 'not-object');
});

test('an index over the byte ceiling is refused before it is parsed', () => {
  const huge = 'x'.repeat(R.MAX_INDEX_BYTES + 1);
  const r = R.parseIndex(huge, { url: INDEX_URL });
  assert.strictEqual(r.code, 'too-large');
});

test('an index listing more than the ceiling is refused rather than truncated', () => {
  const many = [];
  for (let i = 0; i < R.MAX_ENTRIES + 1; i++) many.push(entry({ id: `w-${i}` }));
  assert.strictEqual(parse(index({}, many)).code, 'too-large');
});

test('an object whose getters throw is refused rather than crashing the parse', () => {
  const hostile = { kind: 'husk.registry', schemaVersion: 1, get workflows() { throw new Error('boom'); } };
  const r = R.validateIndex(hostile, { url: INDEX_URL });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'no-entries');
});

// ─── entries are claims ──────────────────────────────────────────────────

test('every describing field lands under claims, never beside the pointer', () => {
  const e = parse(index()).index.entries[0];
  assert.deepStrictEqual(Object.keys(e).sort(), ['artifact', 'claims', 'id', 'sha256']);
  assert.strictEqual(e.claims.steps, 7);
  assert.strictEqual(e.claims.author, 'dorshaer');
});

test('an agent name Husk cannot run is dropped rather than shown', () => {
  const e = parse(index({}, [entry({ agents: ['claude', 'definitely-not-a-cli', 'codex'] })])).index.entries[0];
  assert.deepStrictEqual(e.claims.agents, ['claude', 'codex']);
});

test('a step count no artifact could have is dropped rather than shown', () => {
  assert.strictEqual(parse(index({}, [entry({ steps: 10000 })])).index.entries[0].claims.steps, null);
  assert.strictEqual(parse(index({}, [entry({ steps: -1 })])).index.entries[0].claims.steps, null);
  assert.strictEqual(parse(index({}, [entry({ steps: 'seven' })])).index.entries[0].claims.steps, null);
});

test('control characters in a name become a visible mark rather than vanishing', () => {
  const e = parse(index({}, [entry({ name: 'Sec\u0000urity\u001B triage' })])).index.entries[0];
  assert.ok(!/[\u0000-\u001F\u007F]/.test(e.claims.name));
  assert.match(e.claims.name, /�/);
});

test('an over-long description is clipped, and does not take the index down with it', () => {
  const r = parse(index({}, [entry({ description: 'd'.repeat(5000) }), entry({ id: 'other' })]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.index.entries.length, 2);
  assert.ok(r.index.entries[0].claims.description.length <= 400);
});

test('an entry with no id, no name or no pointer is skipped and counted', () => {
  const r = parse(index({}, [entry(), { name: 'no id', artifact: 'a.json' }, entry({ id: 'x', name: '' })]));
  assert.strictEqual(r.index.entries.length, 1);
  assert.strictEqual(r.index.skipped, 2);
});

test('a duplicate id is skipped, so one row cannot shadow another', () => {
  const r = parse(index({}, [entry(), entry({ name: 'Impostor' })]));
  assert.strictEqual(r.index.entries.length, 1);
  assert.strictEqual(r.index.entries[0].claims.name, 'Security triage');
});

test('an id that is not a slug is skipped', () => {
  for (const id of ['../escape', 'Has Caps', 'trailing-', '', 'a'.repeat(80)]) {
    assert.strictEqual(parse(index({}, [entry({ id })])).code, 'no-entries', `id ${JSON.stringify(id)}`);
  }
});

test('an index whose every row is unreadable says so rather than showing an empty catalog', () => {
  const r = parse(index({}, [{ nonsense: true }, { also: 'nonsense' }]));
  assert.strictEqual(r.code, 'no-entries');
  assert.match(r.detail, /2 rejected/);
});

// ─── URLs ────────────────────────────────────────────────────────────────

test('a registry URL must be https and must not carry credentials', () => {
  assert.strictEqual(R.normalizeRegistryUrl('https://example.com/i.json').ok, true);
  assert.strictEqual(R.normalizeRegistryUrl('http://example.com/i.json').code, 'bad-registry-url');
  assert.strictEqual(R.normalizeRegistryUrl('file:///etc/passwd').code, 'bad-registry-url');
  assert.strictEqual(R.normalizeRegistryUrl('javascript:alert(1)').code, 'bad-registry-url');
  assert.strictEqual(R.normalizeRegistryUrl('data:application/json,{}').code, 'bad-registry-url');
  assert.strictEqual(R.normalizeRegistryUrl('https://u:p@example.com/i.json').code, 'bad-registry-url');
  assert.strictEqual(R.normalizeRegistryUrl('   ').code, 'bad-registry-url');
  assert.strictEqual(R.normalizeRegistryUrl(null).code, 'bad-registry-url');
});

test('a registry URL keeps its query and drops only its fragment', () => {
  const r = R.normalizeRegistryUrl('https://example.com/i.json?ref=main#section');
  assert.strictEqual(r.url, 'https://example.com/i.json?ref=main');
});

test('an artifact pointer resolves against the index that named it', () => {
  const r = R.resolveArtifactUrl(entry(), INDEX_URL);
  assert.strictEqual(r.url, 'https://raw.githubusercontent.com/dorshaer/husk-workflows/main/workflows/triage.husk.json');
});

test('an artifact on another host is refused, so one registry means one host', () => {
  const r = R.resolveArtifactUrl(entry({ artifact: 'https://elsewhere.example/evil.husk.json' }), INDEX_URL);
  assert.strictEqual(r.code, 'cross-origin-artifact');
  assert.match(r.detail, /elsewhere\.example/);
});

test('an artifact pointer may not leave https, whatever scheme it names', () => {
  for (const artifact of ['file:///etc/passwd', 'http://insecure.example/a.json', 'data:application/json,{}']) {
    const r = R.resolveArtifactUrl(entry({ artifact }), INDEX_URL);
    assert.strictEqual(r.ok, false, artifact);
  }
});

test('a pointer that walks up out of the index directory stays on the same host', () => {
  // Traversal is not the threat a URL has; the origin check is what matters,
  // and a walked-up path is still a plain https URL on the same host.
  const r = R.resolveArtifactUrl(entry({ artifact: '../../../other/a.husk.json' }), INDEX_URL);
  assert.strictEqual(r.ok, true);
  assert.match(r.url, /^https:\/\/raw\.githubusercontent\.com\//);
});

test('an entry that says nothing about where its file is, is refused', () => {
  assert.strictEqual(R.resolveArtifactUrl({}, INDEX_URL).code, 'bad-artifact-url');
  assert.strictEqual(R.resolveArtifactUrl(entry({ artifact: '   ' }), INDEX_URL).code, 'bad-artifact-url');
});

// ─── digests ─────────────────────────────────────────────────────────────

const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('bytes matching the stated digest come back attested, computed here', () => {
  const bytes = '{"kind":"husk.workflow"}';
  const r = R.checkArtifactBytes(bytes, { sha256: sha(bytes) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attested, true);
  assert.strictEqual(r.tier, 'computed');
  assert.strictEqual(r.digest, sha(bytes));
});

test('bytes that contradict the stated digest are refused, never downgraded', () => {
  const r = R.checkArtifactBytes('{"kind":"husk.workflow"}', { sha256: sha('something else') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'digest-mismatch');
});

test('a stated digest that is not a sha256 is refused rather than ignored', () => {
  assert.strictEqual(R.checkArtifactBytes('x', { sha256: 'nope' }).code, 'digest-malformed');
  assert.strictEqual(R.checkArtifactBytes('x', { sha256: 'z'.repeat(64) }).code, 'digest-malformed');
  assert.strictEqual(R.checkArtifactBytes('x', { sha256: 'ab'.repeat(20) }).code, 'digest-malformed');
});

test('a digest stated in upper case is read, since hex has no case', () => {
  const bytes = '{"kind":"husk.workflow"}';
  const r = R.checkArtifactBytes(bytes, { sha256: sha(bytes).toUpperCase() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attested, true);
});

test('an entry stating no digest is unattested rather than refused', () => {
  const r = R.checkArtifactBytes('{"kind":"husk.workflow"}', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attested, false);
  assert.strictEqual(r.digest.length, 64);
});

test('the digest is computed over the bytes, whether they arrive as text or as a buffer', () => {
  const text = '{"a":1}';
  assert.strictEqual(
    R.checkArtifactBytes(text, {}).digest,
    R.checkArtifactBytes(Buffer.from(text, 'utf8'), {}).digest,
  );
});

// ─── browsing ────────────────────────────────────────────────────────────

const CATALOG = [
  { id: 'a', artifact: 'a', sha256: '', claims: { name: 'Alpha', description: 'ships a release', author: 'ann', tags: ['release'], agents: [], steps: 2, updatedAt: '2026-01-01T00:00:00Z' } },
  { id: 'b', artifact: 'b', sha256: '', claims: { name: 'Beta', description: 'scans for secrets', author: 'bob', tags: ['security'], agents: [], steps: 3, updatedAt: '2026-06-01T00:00:00Z' } },
  { id: 'c', artifact: 'c', sha256: '', claims: { name: 'Gamma', description: 'reviews a diff', author: 'ann', tags: ['security', 'review'], agents: [], steps: 4, updatedAt: '' } },
];

test('an empty query is the whole catalog, newest claim first, undated last', () => {
  assert.deepStrictEqual(R.searchEntries(CATALOG, '').map((e) => e.id), ['b', 'a', 'c']);
});

test('a query reaches the name, the description, the author and the tags', () => {
  assert.deepStrictEqual(R.searchEntries(CATALOG, 'gamma').map((e) => e.id), ['c']);
  assert.deepStrictEqual(R.searchEntries(CATALOG, 'secrets').map((e) => e.id), ['b']);
  assert.deepStrictEqual(R.searchEntries(CATALOG, 'ann').map((e) => e.id), ['a', 'c']);
  assert.deepStrictEqual(R.searchEntries(CATALOG, 'release').map((e) => e.id), ['a']);
});

test('a tag narrows the catalog, and composes with the query', () => {
  assert.deepStrictEqual(R.searchEntries(CATALOG, '', 'security').map((e) => e.id), ['b', 'c']);
  assert.deepStrictEqual(R.searchEntries(CATALOG, 'diff', 'security').map((e) => e.id), ['c']);
  assert.deepStrictEqual(R.searchEntries(CATALOG, 'diff', 'release').map((e) => e.id), []);
});

test('search is literal, so a gapped run of letters does not answer', () => {
  // "apa" threads through "Alpha" letter by letter but is not a run in it.
  assert.deepStrictEqual(R.searchEntries(CATALOG, 'apa').map((e) => e.id), []);
});

test('tags are counted commonest first', () => {
  assert.deepStrictEqual(R.tagCounts(CATALOG), [
    { tag: 'security', count: 2 },
    { tag: 'release', count: 1 },
    { tag: 'review', count: 1 },
  ]);
});

test('browsing nothing is empty rather than an error', () => {
  assert.deepStrictEqual(R.searchEntries(null, 'x'), []);
  assert.deepStrictEqual(R.tagCounts(undefined), []);
});
