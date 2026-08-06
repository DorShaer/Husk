'use strict';

// The artifact core and the import validator.
//
// Two things are being proven here. The first is that the fingerprint is
// stable under everything that does not change what a workflow does and moves
// under everything that does, because a fingerprint that drifts detaches every
// receipt and a fingerprint that does not move is not a fingerprint.
//
// The second is that the validator is total. Every hostile fixture in
// test/fixtures/artifacts asserts two separate things: that the refusal code
// is the right one, and that getting there did not throw. Those are not the
// same assertion. A validator that throws on a malformed file has handed the
// attacker an unhandled rejection in the main process, and the code being
// right afterwards is no consolation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { stableJson } = require('../../src/lib/stable-json');
const {
  MAX_ARTIFACT_SCHEMA,
  GRAPH_HASH_PREFIX,
  MAX_ARTIFACT_BYTES,
  MAX_CHAIN_BYTES,
  REFUSAL_CODES,
  EXPORT_REFUSAL_CODES,
  canonicalProjection,
  graphHash,
  buildArtifact,
  parseArtifact,
  validateArtifact,
  _internal,
} = require('../../src/lib/workflow-artifact');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'artifacts');

function fixtureBytes(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

function fixtureJson(name) {
  return JSON.parse(fixtureBytes(name).toString('utf8'));
}

// A workflow in the shape the local store holds, which is the shape the
// exporter is handed: author-assigned ids, raw canvas coordinates, no
// requirements block.
function baseGraph() {
  return {
    nodes: [
      { id: 'one', name: 'One', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'do one', passContext: 'full', x: 100, y: 100 },
      { id: 'two', name: 'Two', agentCommand: 'codex', model: 'gpt-5-codex', branchMode: 'parallel', prompt: 'do two', passContext: 'none', x: 300, y: 100 },
      { id: 'three', name: 'Three', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'do three', passContext: 'last50', x: 500, y: 220 },
    ],
    edges: [
      { id: 'x', from: 'one', to: 'two', condition: { type: 'always', value: '' } },
      { id: 'y', from: 'two', to: 'three', condition: { type: 'contains', value: 'GO' } },
    ],
  };
}

function hashOf(graph) {
  const r = graphHash(graph);
  assert.equal(r.ok, true, r.error);
  return r.hash;
}

function buildOpts(over) {
  return Object.assign({
    huskVersion: '2.11.0',
    publishedAt: '2026-02-06T10:02:41.117Z',
  }, over || {});
}

function noThrow(fn) {
  let out;
  let threw = null;
  try {
    out = fn();
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, threw ? `threw ${threw && threw.stack}` : '');
  return out;
}

// ─── the canonical serializer ────────────────────────────────────────────

test('stableJson sorts keys and emits no whitespace', () => {
  assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(stableJson([{ z: 1, a: [3, 2] }]), '[{"a":[3,2],"z":1}]');
  assert.equal(stableJson('x'), '"x"');
  assert.equal(stableJson(null), 'null');
});

test('stableJson is insensitive to key insertion order at every depth', () => {
  const a = { outer: { b: [1, { q: 1, p: 2 }], a: 'x' } };
  const b = { outer: { a: 'x', b: [1, { p: 2, q: 1 }] } };
  assert.equal(stableJson(a), stableJson(b));
});

// ─── fingerprint invariance ──────────────────────────────────────────────

test('the fingerprint survives translating every coordinate', () => {
  const g = baseGraph();
  const moved = baseGraph();
  for (const n of moved.nodes) { n.x += 1000; n.y += 777; }
  assert.equal(hashOf(moved), hashOf(g));
});

test('the fingerprint survives reversing the node array', () => {
  const g = baseGraph();
  const reversed = baseGraph();
  reversed.nodes.reverse();
  assert.equal(hashOf(reversed), hashOf(g));
});

// The format spec asks for edge-array order to be invariant too, and it cannot
// be. contextFor joins each taken incoming edge's output in edge-declaration
// order (main.js:5831-5841), so reversing the array reverses the order two
// predecessors' work appears in the next step's prompt. That is a different
// program, and a fingerprint two different programs share is not a fingerprint.
test('the fingerprint moves when the connection order changes', () => {
  const g = baseGraph();
  const fanIn = baseGraph();
  fanIn.edges = [
    { id: 'x', from: 'one', to: 'three', condition: { type: 'always', value: '' } },
    { id: 'y', from: 'two', to: 'three', condition: { type: 'always', value: '' } },
  ];
  const reversed = baseGraph();
  reversed.edges = fanIn.edges.slice().reverse();
  assert.notEqual(hashOf(reversed), hashOf(fanIn));
  assert.notEqual(hashOf(fanIn), hashOf(g));
});

test('the fingerprint survives renaming every node id and edge id', () => {
  const g = baseGraph();
  const renamed = {
    nodes: g.nodes.map((n, i) => Object.assign({}, n, { id: `zz-${i}-${Math.random()}` })),
    edges: [],
  };
  const idFor = { one: renamed.nodes[0].id, two: renamed.nodes[1].id, three: renamed.nodes[2].id };
  renamed.edges = g.edges.map((e, i) => Object.assign({}, e, { id: `ee-${i}`, from: idFor[e.from], to: idFor[e.to] }));
  assert.equal(hashOf(renamed), hashOf(g));
});

// The other place the format spec asks for an invariance the run engine will
// not honour. wfIsAiRouted decides a step is an AI router by counting its
// outgoing edges (workflow-graph.js:164-168) and wfRunStep appends the ROUTE
// instruction as soon as an ai-mode step has two (main.js:5699-5700), so the
// second identical wire changes the text handed to the CLI.
test('the fingerprint moves when a duplicate connection is appended', () => {
  const g = baseGraph();
  const doubled = baseGraph();
  doubled.edges.push({ id: 'x-again', from: 'one', to: 'two', condition: { type: 'always', value: '' } });
  assert.notEqual(hashOf(doubled), hashOf(g));
});

// Step names are executable text: wfResolveNext routes AI branches by matching
// the model's ROUTE: line against node.name, so renaming a step is a
// behavioural change and has to move the fingerprint.
test('the fingerprint moves when a step is renamed', () => {
  const g = baseGraph();
  const renamed = baseGraph();
  renamed.nodes[0].name = 'One!';
  assert.notEqual(hashOf(renamed), hashOf(g));
});

test('the fingerprint moves when one space is appended to one prompt', () => {
  const g = baseGraph();
  const nudged = baseGraph();
  nudged.nodes[2].prompt += ' ';
  assert.notEqual(hashOf(nudged), hashOf(g));
});

test('the fingerprint moves when a pinned model changes', () => {
  const g = baseGraph();
  const repinned = baseGraph();
  repinned.nodes[1].model = 'gpt-5-codex-mini';
  assert.notEqual(hashOf(repinned), hashOf(g));
});

test('the fingerprint carries the husk-wfg-1 prefix and 64 hex characters', () => {
  const hash = hashOf(baseGraph());
  assert.equal(hash.slice(0, GRAPH_HASH_PREFIX.length), GRAPH_HASH_PREFIX);
  assert.match(hash.slice(GRAPH_HASH_PREFIX.length), /^[0-9a-f]{64}$/);
});

test('canonicalProjection assigns dense ids in content hash order and carries no coordinates', () => {
  const p = canonicalProjection(baseGraph());
  assert.equal(p.ok, true);
  assert.deepEqual(p.nodes.map((n) => n.canonicalId), ['n0', 'n1', 'n2']);
  for (const body of p.projection.nodes) {
    assert.deepEqual(Object.keys(body).sort(), ['agentCommand', 'branchMode', 'model', 'name', 'passContext', 'prompt']);
  }
  const serialized = stableJson(p.projection);
  assert.equal(serialized.includes('"x"'), false);
  assert.equal(serialized.includes('"y"'), false);
});

test('canonicalProjection refuses rather than throwing on junk', () => {
  for (const junk of [null, undefined, 42, 'graph', [], { nodes: 'no' }, { nodes: [] }]) {
    const p = noThrow(() => canonicalProjection(junk));
    assert.equal(p.ok, false);
    assert.equal(typeof p.error, 'string');
  }
});

// ─── writing a file ──────────────────────────────────────────────────────

test('buildArtifact produces a file that re-parses with a matching fingerprint', () => {
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: baseGraph() }, buildOpts());
  assert.equal(r.ok, true, r.message);
  assert.equal(r.artifact.kind, 'husk.workflow');
  assert.equal(r.artifact.schemaVersion, MAX_ARTIFACT_SCHEMA);
  assert.equal(hashOf(r.artifact.graph), r.artifact.graphHash);

  const reread = parseArtifact(JSON.stringify(r.artifact));
  assert.equal(reread.ok, true, reread.message);
  assert.deepEqual(reread.artifact, r.artifact);
});

test('buildArtifact ships no receipts until there is a receipt store', () => {
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: baseGraph() }, buildOpts());
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.artifact.receipts, []);
});

test('buildArtifact assigns the same artifactId to two revisions of one workflow', () => {
  const first = buildArtifact({ id: 'wf-42', name: 'Base', graph: baseGraph() }, buildOpts({ revision: 1 }));
  const grown = baseGraph();
  grown.nodes[0].prompt = 'do one, differently';
  const second = buildArtifact({ id: 'wf-42', name: 'Base', graph: grown }, buildOpts({ revision: 2 }));
  assert.equal(first.ok, true, first.message);
  assert.equal(second.ok, true, second.message);
  assert.equal(second.artifact.artifactId, first.artifact.artifactId);
  assert.notEqual(second.artifact.graphHash, first.artifact.graphHash);
  assert.match(first.artifact.artifactId, /^wfa_[0-9a-z]{26}$/);

  // Republishing hands the existing id back, and a caller who hands back
  // nonsense gets the derived id rather than the nonsense.
  const kept = 'wfa_' + 'q'.repeat(26);
  const republished = buildArtifact({ id: 'wf-42', name: 'Base', graph: baseGraph() }, buildOpts({ artifactId: kept }));
  assert.equal(republished.artifact.artifactId, kept);
  const junked = buildArtifact({ id: 'wf-42', name: 'Base', graph: baseGraph() }, buildOpts({ artifactId: '../../etc/passwd' }));
  assert.equal(junked.artifact.artifactId, first.artifact.artifactId);
});

test('buildArtifact refuses a step that does not name its agent, and names the step', () => {
  const g = baseGraph();
  g.nodes[1].agentCommand = null;
  const r = noThrow(() => buildArtifact({ id: 'wf-1', name: 'Base', graph: g }, buildOpts()));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad-agent');
  assert.ok(r.message.includes('Two'), r.message);
  assert.ok(EXPORT_REFUSAL_CODES.includes(r.code));
});

test('buildArtifact writes the bare basename rather than the author path layout', () => {
  const g = baseGraph();
  g.nodes[0].agentCommand = '/usr/local/bin/Claude';
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: g }, buildOpts());
  assert.equal(r.ok, true, r.message);
  for (const n of r.artifact.graph.nodes) {
    assert.equal(n.agentCommand.includes('/'), false);
  }
  assert.deepEqual(r.artifact.requires.agentCommands.slice().sort(), ['claude', 'codex']);
});

test('buildArtifact carries a literal routing pattern across as a contains match', () => {
  const g = baseGraph();
  g.edges[1].condition = { type: 'regex', value: 'ALL TESTS PASS' };
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: g }, buildOpts());
  assert.equal(r.ok, true, r.message);
  const conditions = r.artifact.graph.edges.map((e) => e.condition.type);
  assert.equal(conditions.includes('regex'), false);
  assert.equal(conditions.includes('contains'), true);
  assert.ok(r.warnings.some((w) => w.code === 'regex-downgraded'));
});

test('buildArtifact refuses a real routing regular expression and names the connection', () => {
  const g = baseGraph();
  g.edges[1].condition = { type: 'regex', value: '^(a+)+$' };
  const r = noThrow(() => buildArtifact({ id: 'wf-1', name: 'Base', graph: g }, buildOpts()));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'regex-condition');
  assert.ok(r.detail.includes('two'), r.detail);
});

test('buildArtifact refuses two sibling step names an AI router cannot tell apart', () => {
  const g = {
    nodes: [
      { id: 'r', name: 'Route', agentCommand: 'claude', model: null, branchMode: 'ai', prompt: 'pick', passContext: 'full', x: 0, y: 0 },
      { id: 'p', name: 'Patch', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'patch', passContext: 'full', x: 0, y: 200 },
      { id: 'pt', name: 'Patch tests', agentCommand: 'claude', model: null, branchMode: 'parallel', prompt: 'patch tests', passContext: 'full', x: 200, y: 200 },
    ],
    edges: [
      { id: 'a', from: 'r', to: 'p', condition: { type: 'always', value: '' } },
      { id: 'b', from: 'r', to: 'pt', condition: { type: 'always', value: '' } },
    ],
  };
  const r = noThrow(() => buildArtifact({ id: 'wf-1', name: 'Ambiguous', graph: g }, buildOpts()));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'name-collision');
  assert.ok(r.message.includes('Patch tests'), r.message);
});

test('buildArtifact translates layout to the origin, quantises it and clamps it', () => {
  const g = baseGraph();
  g.nodes[0].x = 137; g.nodes[0].y = 1281;
  g.nodes[1].x = -40; g.nodes[1].y = 20;
  g.nodes[2].x = 999999; g.nodes[2].y = 41;
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: g }, buildOpts());
  assert.equal(r.ok, true, r.message);
  const xs = r.artifact.graph.nodes.map((n) => n.x);
  const ys = r.artifact.graph.nodes.map((n) => n.y);
  assert.equal(Math.min.apply(null, xs), 0);
  assert.equal(Math.min.apply(null, ys), 0);
  for (const v of xs.concat(ys)) {
    assert.equal(v % 20, 0);
    assert.ok(v >= 0 && v <= 20000, `coordinate ${v} out of range`);
  }
});

test('buildArtifact refuses a caller that supplies no husk version', () => {
  for (const bad of [undefined, null, 42, '2.11', 'latest']) {
    const r = noThrow(() => buildArtifact({ id: 'wf-1', name: 'Base', graph: baseGraph() }, { huskVersion: bad }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad-input');
  }
});

test('buildArtifact refuses junk rather than throwing', () => {
  for (const junk of [null, undefined, 42, 'workflow', [], { graph: null }, { graph: { nodes: [] } }]) {
    const r = noThrow(() => buildArtifact(junk, buildOpts()));
    assert.equal(r.ok, false);
    assert.ok(EXPORT_REFUSAL_CODES.includes(r.code), `unknown code ${r.code}`);
  }
});

test('buildArtifact keeps the clock injectable so the module has none of its own', () => {
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: baseGraph() }, {
    huskVersion: '2.11.0',
    now: () => Date.UTC(2026, 1, 6, 10, 2, 41, 117),
  });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.artifact.publishedAt, '2026-02-06T10:02:41.117Z');
});

test('buildArtifact drops author-declared requirements down to a name, a fingerprint and a flag', () => {
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: baseGraph() }, buildOpts({
    requires: {
      mcpServers: [{ name: 'postgres', command: 'psql', args: ['--danger'], env: { TOKEN: 'secret' }, optional: true }],
      skills: [{ id: 'audit', fingerprint: 'sha256:' + 'a'.repeat(64) }],
      workspace: { vcs: 'git', markerFiles: ['package.json'], commands: ['bun test'] },
    },
  }));
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(Object.keys(r.artifact.requires.mcpServers[0]).sort(), ['fingerprint', 'name', 'optional']);
  const serialized = JSON.stringify(r.artifact);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('--danger'), false);
});

// The declared workspace is documentation the author typed, so anything the
// format cannot hold is clamped and named in a warning. Refusing here would
// surface the reader's "this is not a Husk workflow" code out of a publish
// button for a build command that ran long.
test('buildArtifact clamps a declared workspace rather than refusing to publish', () => {
  const r = buildArtifact({ id: 'wf-1', name: 'Base', graph: baseGraph() }, buildOpts({
    requires: {
      workspace: {
        vcs: 'git',
        markerFiles: ['package.json', 'src/**', '/root/.ssh/id_rsa', '../outside'],
        commands: ['bun test ' + 'x'.repeat(200)],
      },
      huskMin: '1.0.0' + 'x'.repeat(60),
    },
  }));
  assert.equal(r.ok, true, `${r.code}: ${r.message}`);
  assert.deepEqual(r.artifact.requires.workspace.markerFiles, ['package.json']);
  assert.equal(r.artifact.requires.workspace.commands[0].length, 128);
  assert.equal(r.artifact.requires.huskMin, '2.11.0');
  assert.ok(r.warnings.some((w) => w.code === 'requirement-dropped'));
  assert.ok(r.warnings.some((w) => w.code === 'truncated'));
});

// ─── reading a stranger's file ───────────────────────────────────────────

test('parseArtifact accepts the worked example as bytes or as a string', () => {
  const bytes = fixtureBytes('valid-worked-example.json');
  const fromBuffer = parseArtifact(bytes);
  const fromString = parseArtifact(bytes.toString('utf8'));
  assert.equal(fromBuffer.ok, true, fromBuffer.message);
  assert.equal(fromString.ok, true, fromString.message);
  assert.deepEqual(fromBuffer.artifact, fromString.artifact);
  assert.equal(fromBuffer.artifact.graph.nodes.length, 4);
  assert.equal(fromBuffer.warnings.some((w) => w.code === 'no-receipts'), true);
});

test('a file that ships receipts with no log reads as attested only', () => {
  const r = parseArtifact(fixtureBytes('valid-with-receipt.json'));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.artifact.receipts.length, 1);
  assert.equal(r.artifact.receipts[0].outcomeBasis, 'process-exit');
  assert.equal(r.artifact.receipts[0].graphHash, r.artifact.graphHash);
  assert.ok(r.warnings.some((w) => w.code === 'attested-only'));
});

test('a file that ships an inline log keeps every row it declared', () => {
  const r = parseArtifact(fixtureBytes('valid-inline-chain.json'));
  assert.equal(r.ok, true, r.message);
  const chain = r.artifact.receipts[0].chain;
  assert.equal(chain.lines.length, chain.lineCount);
  assert.match(chain.head, /^sha256:[0-9a-f]{64}$/);
});

test('the projection carries nothing the format does not name', () => {
  const raw = fixtureJson('valid-worked-example.json');
  raw.notes = 'kept';
  const r = validateArtifact(raw);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(Object.keys(r.artifact).sort(), [
    'artifactId', 'description', 'graph', 'graphHash', 'huskVersion', 'kind', 'name',
    'notes', 'publishedAt', 'publisher', 'receipts', 'requires', 'revision', 'schemaVersion',
  ]);
  for (const n of r.artifact.graph.nodes) {
    assert.deepEqual(Object.keys(n).sort(), ['agentCommand', 'branchMode', 'id', 'model', 'name', 'passContext', 'prompt', 'x', 'y']);
  }
});

// Node ids are only pattern-checked, and the node array order is what
// graphToOrderedSteps walks from, so two files can share one fingerprint while
// listing their steps in two different orders under two different sets of ids.
// The reader stores the canonical order under canonical ids, which is what
// makes one fingerprint mean one record rather than one family of records.
test('two files with one fingerprint read back as one record', () => {
  const straight = fixtureJson('valid-worked-example.json');
  const shuffled = fixtureJson('valid-worked-example.json');
  shuffled.graph.nodes.reverse();

  const a = validateArtifact(straight);
  const b = validateArtifact(shuffled);
  assert.equal(a.ok, true, a.message);
  assert.equal(b.ok, true, b.message);
  assert.deepEqual(b.artifact.graph, a.artifact.graph);
  assert.deepEqual(b.artifact.requires, a.artifact.requires);
  assert.deepEqual(a.artifact.graph.nodes.map((n) => n.id), ['n0', 'n1', 'n2', 'n3']);
});

test('reading an artifact twice yields the same artifact', () => {
  const once = validateArtifact(fixtureJson('valid-worked-example.json'));
  assert.equal(once.ok, true, once.message);
  const twice = validateArtifact(once.artifact);
  assert.equal(twice.ok, true, twice.message);
  assert.deepEqual(twice.artifact, once.artifact);
});

test('a version from the future is refused whole, with both numbers named', () => {
  const r = parseArtifact(fixtureBytes('schema-too-new.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'schema-too-new');
  assert.ok(r.message.includes('2'), r.message);
  assert.ok(r.message.includes(String(MAX_ARTIFACT_SCHEMA)), r.message);
});

test('a fingerprint mismatch names both hashes in full', () => {
  const r = parseArtifact(fixtureBytes('hash-tampered.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'hash-mismatch');
  const hexes = r.detail.match(/[0-9a-f]{64}/g);
  assert.equal(hexes.length, 2);
});

test('reading a file with a __proto__ key refuses and pollutes nothing', () => {
  const r = parseArtifact(fixtureBytes('proto-key.json'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-artifact');
  assert.equal({}.polluted, undefined);
});

test('every refusal uses the closed enum and carries a printable message', () => {
  const r = parseArtifact(fixtureBytes('agent-dot-slash.json'));
  assert.equal(r.ok, false);
  assert.ok(REFUSAL_CODES.includes(r.code));
  assert.equal(typeof r.message, 'string');
  assert.ok(r.message.length > 0);
  assert.ok(r.detail === null || typeof r.detail === 'string');
});

// ─── totality ────────────────────────────────────────────────────────────

test('validateArtifact refuses every kind of junk without throwing', () => {
  const hostile = [
    null, undefined, 0, 1, NaN, '', 'husk.workflow', true, [], [1, 2, 3],
    new Map(), new Set(), Symbol.iterator, () => 'hi', Object.create(null),
    Object.create({ kind: 'husk.workflow', schemaVersion: 1 }),
    { kind: 'husk.workflow', schemaVersion: 1.5 },
    { kind: 'husk.workflow', schemaVersion: Number.MAX_SAFE_INTEGER },
  ];
  for (let i = 0; i < hostile.length; i++) {
    const r = noThrow(() => validateArtifact(hostile[i]));
    // The label is the index, not the value. A null-prototype object has no
    // toString, so describing the input in the failure message is itself a way
    // to throw inside the test that proves nothing throws.
    assert.equal(r.ok, false, `expected a refusal for hostile input ${i}`);
    assert.ok(REFUSAL_CODES.includes(r.code), `unknown code ${r.code}`);
  }
});

test('validateArtifact refuses an object whose getters throw', () => {
  const trap = { kind: 'husk.workflow', schemaVersion: 1 };
  Object.defineProperty(trap, 'graph', {
    enumerable: true,
    get() { throw new Error('boom'); },
  });
  const r = noThrow(() => validateArtifact(trap));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-artifact');
});

test('parseArtifact refuses non-bytes and invalid JSON without throwing', () => {
  for (const input of [null, undefined, 42, {}, [], () => {}]) {
    const r = noThrow(() => parseArtifact(input));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-json');
  }
  const r = noThrow(() => parseArtifact('{"kind":'));
  assert.equal(r.code, 'not-json');
});

test('an unpaired surrogate never reaches a prompt', () => {
  assert.equal(_internal.hasLoneSurrogate('plain text'), false);
  assert.equal(_internal.hasLoneSurrogate('an emoji \u{1F600} is a pair'), false);
  assert.equal(_internal.hasLoneSurrogate('half \ud800 of one'), true);
  assert.equal(_internal.hasLoneSurrogate('trailing \udc00 half'), true);
});

test('agent command normalisation strips every path form there is', () => {
  const cases = [
    ['claude', 'claude'],
    ['./claude', 'claude'],
    ['/tmp/claude', 'claude'],
    ['..\\claude.exe', 'claude'],
    ['~/x/claude', 'claude'],
    ['CLAUDE.CMD', 'claude'],
    ['claude --dangerously-skip-permissions', 'claude'],
    ['   ', ''],
    [null, ''],
  ];
  for (const [input, want] of cases) {
    assert.equal(_internal.normalizeAgentCommand(input), want, `for ${String(input)}`);
  }
});

test('only a pattern with no metacharacters counts as a literal', () => {
  assert.equal(_internal.isLiteralPattern('ALL TESTS PASS'), true);
  assert.equal(_internal.isLiteralPattern('^(a+)+$'), false);
  assert.equal(_internal.isLiteralPattern('a|b'), false);
  assert.equal(_internal.isLiteralPattern('done.'), false);
  assert.equal(_internal.isLiteralPattern(''), false);
});

// ─── the hostile fixtures ────────────────────────────────────────────────

// Every file in test/fixtures/artifacts is listed here, and the test below
// fails if a fixture appears in the directory without an expectation. A
// hostile input nobody asserted on is a hostile input nobody checked.
const FIXTURE_EXPECTATIONS = {
  'valid-worked-example.json': 'ok',
  'valid-with-receipt.json': 'ok',
  'valid-inline-chain.json': 'ok',
  'malformed-not-json.json': 'not-json',
  'empty-object.json': 'not-artifact',
  'wrong-kind.json': 'not-artifact',
  'unknown-top-key.json': 'not-artifact',
  'proto-key.json': 'not-artifact',
  'schema-too-new.json': 'schema-too-new',
  'node-id-array.json': 'bad-id',
  'duplicate-node-id.json': 'bad-id',
  'agent-dot-slash.json': 'bad-agent',
  'agent-abs-path.json': 'bad-agent',
  'agent-backslash-exe.json': 'bad-agent',
  'agent-tilde.json': 'bad-agent',
  'agent-null.json': 'bad-agent',
  'bad-model.json': 'bad-model',
  'regex-condition.json': 'regex-condition',
  'edge-missing-node.json': 'edges-dropped',
  'hash-tampered.json': 'hash-mismatch',
  'lone-surrogate-prompt.json': 'not-artifact',
  'xy-off-grid.json': 'not-artifact',
  'too-many-receipts.json': 'too-many-nodes',
  'receipt-outcomes-mismatch.json': 'receipt-invalid',
  'receipt-foreign-hash.json': 'receipt-invalid',
  'receipt-inline-no-chain.json': 'receipt-invalid',
  'chain-line-count-mismatch.json': 'chain-invalid',
};

test('every fixture on disk has an expectation', () => {
  const onDisk = fs.readdirSync(FIXTURES).filter((f) => f !== 'oversized-cases.json').sort();
  assert.deepEqual(onDisk, Object.keys(FIXTURE_EXPECTATIONS).sort());
});

for (const name of Object.keys(FIXTURE_EXPECTATIONS)) {
  const expected = FIXTURE_EXPECTATIONS[name];
  const label = expected === 'ok'
    ? `fixture ${name} is accepted and does not throw`
    : `fixture ${name} is refused with ${expected} and does not throw`;
  test(label, () => {
    const bytes = fixtureBytes(name);
    const r = noThrow(() => parseArtifact(bytes));
    if (expected === 'ok') {
      assert.equal(r.ok, true, `${name}: ${r.message} ${r.detail}`);
      assert.equal(Array.isArray(r.warnings), true);
      return;
    }
    assert.equal(r.ok, false, `${name} was accepted and should not have been`);
    assert.equal(r.code, expected, `${name}: ${r.code} ${r.message}`);
    assert.ok(REFUSAL_CODES.includes(r.code));
  });
}

// The four size bombs are declared in oversized-cases.json rather than
// committed: their literal bytes run from two megabytes to fifteen, and
// putting twenty-odd megabytes into every clone of this repository to test
// four refusals is a worse trade than building them here. Two of them are fed
// through parseArtifact because the byte cap is the thing under test; the
// other two go straight to validateArtifact because serialising ten megabytes
// of node id would only ever prove that the byte cap works, which the first
// two already prove.
const OVERSIZED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'oversized-cases.json'), 'utf8'));

function buildOversized(spec) {
  const base = fixtureJson(OVERSIZED.base);
  if (spec.kind === 'padded-notes') {
    base.notes = 'A'.repeat(spec.bytes);
    return { via: 'parse', input: JSON.stringify(base) };
  }
  if (spec.kind === 'long-node-id') {
    base.graph.nodes[0].id = 'n'.repeat(spec.chars);
    return { via: 'validate', input: base };
  }
  if (spec.kind === 'many-nodes') {
    const nodes = new Array(spec.count);
    for (let i = 0; i < spec.count; i++) {
      nodes[i] = {
        id: `n${i}`, name: `S${i}`, agentCommand: 'claude', model: null,
        branchMode: 'parallel', prompt: '', passContext: 'full', x: 0, y: 0,
      };
    }
    base.graph.nodes = nodes;
    base.graph.edges = [];
    return { via: 'validate', input: base };
  }
  if (spec.kind === 'fat-chain') {
    const lines = new Array(spec.lines);
    for (let i = 0; i < spec.lines; i++) lines[i] = 'L'.repeat(spec.lineChars);
    base.receipts = [{
      id: 'rcp_9f02aa41c7d6b380',
      graphHash: base.graphHash,
      runs: 1,
      runsWindowed: false,
      window: { firstRunAt: '2026-01-09T08:11:03.220Z', lastRunAt: '2026-02-06T09:35:00.860Z' },
      outcomes: { completed: 1, failed: 0, stopped: 0, timedOut: 0 },
      outcomeBasis: 'process-exit',
      medianDurationMs: 1000,
      durationCensored: 0,
      medianTokens: null,
      environment: {
        agentResolved: 'claude', agentVersion: '2.1.4', modelResolved: null, os: 'linux',
        huskVersion: '2.11.0', workspace: { vcs: 'git', trackedFiles: '1k-10k', languages: [] },
      },
      evidence: 'inline',
      chain: { sessionIds: ['run-1'], head: 'sha256:' + 'e'.repeat(64), lineCount: spec.lines, lines },
    }];
    return { via: 'parse', input: JSON.stringify(base) };
  }
  throw new Error(`unknown oversized kind ${spec.kind}`);
}

for (const spec of OVERSIZED.cases) {
  test(`oversized ${spec.name} is refused with ${spec.expect} and does not throw`, () => {
    const built = buildOversized(spec);
    const r = noThrow(() => (built.via === 'parse' ? parseArtifact(built.input) : validateArtifact(built.input)));
    assert.equal(r.ok, false);
    assert.equal(r.code, spec.expect, `${spec.name}: ${r.code} ${r.message}`);
  });
}

test('the caps the refusals are measured against are the ones the format declares', () => {
  assert.equal(MAX_ARTIFACT_BYTES, 1024 * 1024);
  assert.equal(MAX_CHAIN_BYTES, 512 * 1024);
  assert.equal(MAX_ARTIFACT_SCHEMA, 1);
});
