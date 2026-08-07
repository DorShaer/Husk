'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const I = require('../../src/lib/workflow-install');
const {
  mcpFingerprint,
  skillFingerprint,
  evaluatePreflight,
  runGateDecision,
  normalizeStore,
  normalizeRow,
  sidecarRow,
  pruneStore,
  slugForName,
  artifactFileName,
} = I;
const { compareVersions } = I._internal;

const HASH = `husk-wfg-1:sha256:${'a'.repeat(64)}`;
const PRINT_A = `sha256:${'1'.repeat(64)}`;
const PRINT_B = `sha256:${'2'.repeat(64)}`;

// A validated artifact carries exactly the fields the reader projected, so the
// fixture states the requires block and nothing else: preflight never reads
// the graph, only what the graph declared it needs.
function artifact(requires = {}) {
  return {
    kind: 'husk.workflow',
    schemaVersion: 1,
    name: 'Triage, patch, verify',
    graphHash: HASH,
    graph: { nodes: [], edges: [] },
    receipts: [],
    requires: Object.assign({
      agentCommands: ['claude'],
      models: [],
      mcpServers: [],
      skills: [],
      workspace: { vcs: 'none', markerFiles: [], commands: [] },
      huskMin: '2.10.0',
    }, requires),
  };
}

// A machine where everything the default artifact asks for is present and the
// bound directory is a real, non-home, git-backed folder.
function facts(over = {}) {
  return Object.assign({
    agentsOnPath: { claude: true },
    mcpServers: [],
    skills: [],
    markerFiles: {},
    cwd: '/home/user/code/orbit',
    cwdIsDir: true,
    cwdIsHome: false,
    cwdInWorkTree: true,
    huskVersion: '2.10.2',
  }, over);
}

function findCheck(result, id) {
  assert.equal(result.ok, true);
  const hit = result.checks.find((c) => c.id === id);
  assert.ok(hit, `expected a check with id ${id}, got ${result.checks.map((c) => c.id).join(', ')}`);
  return hit;
}

// ─── fingerprints ────────────────────────────────────────────────────────

test('mcpFingerprint is stable across key order and ignores env', () => {
  const a = mcpFingerprint({ id: 'postgres', command: 'npx', args: ['-y', 'pg-mcp'], env: { PGPASSWORD: 'hunter2' } });
  const b = mcpFingerprint({ args: ['-y', 'pg-mcp'], command: 'npx', env: { PGPASSWORD: 'something-else' }, id: 'other' });
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, b);
});

test('mcpFingerprint separates two servers that differ only in args', () => {
  const a = mcpFingerprint({ command: 'npx', args: ['-y', 'pg-mcp', '--db', 'scratch'] });
  const b = mcpFingerprint({ command: 'npx', args: ['-y', 'pg-mcp', '--db', 'production'] });
  assert.notEqual(a, b);
});

test('mcpFingerprint is null for a remote server, which has no command to hash', () => {
  assert.equal(mcpFingerprint({ id: 'github', transport: 'http', url: 'https://example.com/mcp' }), null);
  assert.equal(mcpFingerprint(null), null);
  assert.equal(mcpFingerprint('claude'), null);
});

test('mcpFingerprint survives a server object that fights back', () => {
  const hostile = { get command() { throw new Error('no'); } };
  assert.equal(mcpFingerprint(hostile), null);
});

test('skillFingerprint hashes bytes and matches across string and Buffer', () => {
  const text = '---\nname: deploy\n---\n\nShip it.\n';
  const a = skillFingerprint(text);
  const b = skillFingerprint(Buffer.from(text, 'utf8'));
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, skillFingerprint(`${text} `));
  assert.equal(skillFingerprint(null), null);
});

// ─── preflight: agents ───────────────────────────────────────────────────

test('an agent missing from PATH blocks, and is never substituted', () => {
  const r = evaluatePreflight(artifact({ agentCommands: ['claude', 'codex'] }), facts({ agentsOnPath: { claude: true, codex: false } }));
  assert.equal(r.ok, true);
  assert.equal(findCheck(r, 'agent:claude').status, 'ok');
  const codex = findCheck(r, 'agent:codex');
  assert.equal(codex.status, 'block');
  assert.equal(codex.tier, 'computed');
  assert.match(codex.title, /codex is not on your PATH/);
  assert.equal(codex.fix.kind, 'install-agent');
  assert.equal(codex.fix.value, 'codex');
  assert.equal(r.blocking, 1);
  // No row anywhere offers another agent in its place.
  for (const c of r.checks) assert.doesNotMatch(String(c.note || ''), /instead|substitute .* for you/i);
});

test('an unanswered PATH probe counts as absent rather than as a pass', () => {
  const r = evaluatePreflight(artifact({ agentCommands: ['aider'] }), facts({ agentsOnPath: {} }));
  assert.equal(findCheck(r, 'agent:aider').status, 'block');
});

// ─── preflight: MCP servers and skills ───────────────────────────────────

test('a required MCP server that is absent blocks; an optional one cautions', () => {
  const required = evaluatePreflight(
    artifact({ mcpServers: [{ name: 'postgres', fingerprint: null, optional: false }] }),
    facts(),
  );
  assert.equal(findCheck(required, 'mcp:postgres').status, 'block');

  const optional = evaluatePreflight(
    artifact({ mcpServers: [{ name: 'postgres', fingerprint: null, optional: true }] }),
    facts(),
  );
  assert.equal(findCheck(optional, 'mcp:postgres').status, 'caution');
});

test('a matching fingerprint is computed-tier ok, a differing one is a caution naming both', () => {
  const match = evaluatePreflight(
    artifact({ mcpServers: [{ name: 'postgres', fingerprint: PRINT_A, optional: false }] }),
    facts({ mcpServers: [{ name: 'postgres', fingerprint: PRINT_A }] }),
  );
  const okRow = findCheck(match, 'mcp:postgres');
  assert.equal(okRow.status, 'ok');
  assert.equal(okRow.tier, 'computed');

  const drift = evaluatePreflight(
    artifact({ mcpServers: [{ name: 'postgres', fingerprint: PRINT_A, optional: false }] }),
    facts({ mcpServers: [{ name: 'postgres', fingerprint: PRINT_B }] }),
  );
  const row = findCheck(drift, 'mcp:postgres');
  assert.equal(row.status, 'caution');
  assert.match(row.title, /it is not the one this was written against/);
  assert.equal(row.detail.declared, PRINT_A);
  assert.equal(row.detail.local, PRINT_B);
});

test('a server present with no author fingerprint drops to the author-states tier', () => {
  const r = evaluatePreflight(
    artifact({ mcpServers: [{ name: 'github', fingerprint: null, optional: false }] }),
    facts({ mcpServers: [{ name: 'github', fingerprint: PRINT_A }] }),
  );
  const row = findCheck(r, 'mcp:github');
  assert.equal(row.status, 'caution');
  assert.equal(row.tier, 'said');
});

test('an MCP fix affordance carries no command, args or env from the manifest', () => {
  const r = evaluatePreflight(
    artifact({ mcpServers: [{ name: 'postgres', fingerprint: null, optional: false }] }),
    facts(),
  );
  const row = findCheck(r, 'mcp:postgres');
  assert.deepEqual(Object.keys(row.fix).sort(), ['kind', 'label']);
  assert.equal(row.fix.kind, 'open-mcp-form');
});

test('skills are checked by id the same way servers are checked by name', () => {
  const r = evaluatePreflight(
    artifact({ skills: [{ id: 'deploy', fingerprint: PRINT_A, optional: false }] }),
    facts({ skills: [{ id: 'deploy', fingerprint: PRINT_A }] }),
  );
  assert.equal(findCheck(r, 'skill:deploy').status, 'ok');

  const missing = evaluatePreflight(
    artifact({ skills: [{ id: 'deploy', fingerprint: PRINT_A, optional: false }] }),
    facts({ skills: [] }),
  );
  assert.equal(findCheck(missing, 'skill:deploy').status, 'block');
});

// ─── preflight: the bound directory ──────────────────────────────────────

test('an unbound directory blocks and offers the picker', () => {
  const r = evaluatePreflight(artifact(), facts({ cwd: null, cwdIsDir: false, cwdInWorkTree: false }));
  const row = findCheck(r, 'cwd');
  assert.equal(row.status, 'block');
  assert.equal(row.fix.kind, 'pick-cwd');
});

test('the home directory is refused as a binding', () => {
  const r = evaluatePreflight(artifact(), facts({ cwd: '/home/user', cwdIsHome: true }));
  assert.equal(findCheck(r, 'cwd').status, 'block');
});

test('a git-declaring workflow blocks outside a work tree and passes inside one', () => {
  const outside = evaluatePreflight(
    artifact({ workspace: { vcs: 'git', markerFiles: [], commands: [] } }),
    facts({ cwdInWorkTree: false }),
  );
  assert.equal(findCheck(outside, 'cwd').status, 'block');

  const inside = evaluatePreflight(
    artifact({ workspace: { vcs: 'git', markerFiles: [], commands: [] } }),
    facts({ cwdInWorkTree: true }),
  );
  assert.equal(findCheck(inside, 'cwd').status, 'ok');
});

test('a marker file present is computed, absent is a caution, unbound is author-stated', () => {
  const ws = { vcs: 'none', markerFiles: ['package.json'], commands: [] };
  const present = evaluatePreflight(artifact({ workspace: ws }), facts({ markerFiles: { 'package.json': true } }));
  const hit = findCheck(present, 'marker:package.json');
  assert.equal(hit.status, 'ok');
  assert.equal(hit.tier, 'computed');

  const absent = evaluatePreflight(artifact({ workspace: ws }), facts({ markerFiles: { 'package.json': false } }));
  assert.equal(findCheck(absent, 'marker:package.json').status, 'caution');

  const unbound = evaluatePreflight(artifact({ workspace: ws }), facts({ cwd: null, cwdIsDir: false }));
  const pending = findCheck(unbound, 'marker:package.json');
  assert.equal(pending.tier, 'said');
});

test('declared commands render as one author-states row and are never run', () => {
  const r = evaluatePreflight(
    artifact({ workspace: { vcs: 'none', markerFiles: [], commands: ['bun test', 'bun run lint'] } }),
    facts(),
  );
  const row = findCheck(r, 'commands');
  assert.equal(row.tier, 'said');
  assert.equal(row.status, 'ok');
  assert.match(row.title, /the author states/);
});

// ─── preflight: models and version ───────────────────────────────────────

test('model pins produce one ok row naming the distinct models', () => {
  const r = evaluatePreflight(
    artifact({ models: [{ node: 'n0', model: 'claude-opus-4-8' }, { node: 'n2', model: 'claude-opus-4-8' }] }),
    facts(),
  );
  const row = findCheck(r, 'models');
  assert.equal(row.status, 'ok');
  assert.equal(row.name, 'claude-opus-4-8');
  assert.match(row.title, /^2 steps pin a model$/);
});

test('no model row exists when nothing is pinned', () => {
  const r = evaluatePreflight(artifact(), facts());
  assert.equal(r.checks.some((c) => c.id === 'models'), false);
});

test('a newer huskMin is a caution rather than a blocker', () => {
  const r = evaluatePreflight(artifact({ huskMin: '3.0.0' }), facts({ huskVersion: '2.10.2' }));
  const row = findCheck(r, 'husk');
  assert.equal(row.status, 'caution');
  assert.equal(r.blocking, 0);
});

test('compareVersions orders by the three numeric components and ignores a suffix', () => {
  assert.ok(compareVersions('2.11.0', '2.10.2') > 0);
  assert.ok(compareVersions('2.10.2', '2.11.0') < 0);
  assert.equal(compareVersions('2.11.0-beta.3', '2.11.0'), 0);
  assert.equal(compareVersions('latest', '2.11.0'), null);
  assert.equal(compareVersions('2.11', '2.11.0'), null);
});

// ─── preflight: totals and totality ──────────────────────────────────────

test('the counts add up to the number of checks', () => {
  const r = evaluatePreflight(
    artifact({
      agentCommands: ['claude', 'codex'],
      models: [{ node: 'n0', model: 'claude-opus-4-8' }],
      mcpServers: [{ name: 'postgres', fingerprint: PRINT_A, optional: false }],
      skills: [{ id: 'deploy', fingerprint: null, optional: true }],
      workspace: { vcs: 'git', markerFiles: ['package.json'], commands: ['bun test'] },
    }),
    facts({ agentsOnPath: { claude: true, codex: false }, markerFiles: { 'package.json': true } }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.blocking + r.cautions + r.oks, r.checks.length);
  // Every row is individually addressable, which is what lets a surface
  // repaint one probe without rebuilding the list.
  assert.equal(new Set(r.checks.map((c) => c.id)).size, r.checks.length);
});

test('every check names a severity and a tier from the closed sets', () => {
  const r = evaluatePreflight(
    artifact({ mcpServers: [{ name: 'postgres', fingerprint: PRINT_A, optional: false }] }),
    facts(),
  );
  for (const c of r.checks) {
    assert.ok(['ok', 'caution', 'block'].includes(c.status), `bad status ${c.status} on ${c.id}`);
    assert.ok(['computed', 'said'].includes(c.tier), `bad tier ${c.tier} on ${c.id}`);
    assert.equal(typeof c.title, 'string');
  }
});

test('evaluatePreflight refuses rather than throws on junk', () => {
  assert.equal(evaluatePreflight(null, facts()).ok, false);
  assert.equal(evaluatePreflight({}, facts()).ok, false);
  assert.equal(evaluatePreflight(artifact(), null).ok, true);
  const hostile = { get requires() { throw new Error('boom'); } };
  const r = evaluatePreflight(hostile, facts());
  assert.equal(r.ok, false);
  // The refusal does not quote the exception: that text came from the same
  // input we are refusing and it would be rendered by a surface downstream.
  assert.doesNotMatch(r.error, /boom/);
});

// ─── the run gate ────────────────────────────────────────────────────────

test('a locally authored workflow is not gated and keeps a null cwd', () => {
  const r = runGateDecision({ sidecar: null, cwd: null });
  assert.deepEqual(r, { ok: true, cwd: null });
});

test('an imported workflow with no consent is refused before anything else is checked', () => {
  const r = runGateDecision({
    sidecar: { origin: 'imported', consentedAt: null, boundCwd: '/home/user/code/orbit' },
    cwd: '/home/user/code/orbit',
    cwdIsDir: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'consent-required');
});

test('an imported workflow with no bound directory is refused', () => {
  const r = runGateDecision({
    sidecar: { origin: 'imported', consentedAt: '2026-02-06T10:00:00.000Z' },
    cwd: null,
  });
  assert.equal(r.code, 'cwd-required');
});

test('an imported workflow bound to HOME is refused', () => {
  const r = runGateDecision({
    sidecar: { origin: 'imported', consentedAt: '2026-02-06T10:00:00.000Z' },
    cwd: '/home/user',
    cwdIsDir: true,
    cwdIsHome: true,
  });
  assert.equal(r.code, 'cwd-is-home');
  assert.equal(r.detail, '/home/user');
});

test('a directory that stopped being one between install and Run is refused', () => {
  const r = runGateDecision({
    sidecar: { origin: 'imported', consentedAt: '2026-02-06T10:00:00.000Z' },
    cwd: '/home/user/code/orbit',
    cwdIsDir: false,
  });
  assert.equal(r.code, 'cwd-not-a-directory');
});

test('a git-declaring imported workflow is refused outside a work tree and passes inside one', () => {
  const sidecar = {
    origin: 'imported',
    consentedAt: '2026-02-06T10:00:00.000Z',
    artifact: { requires: { workspace: { vcs: 'git' } } },
  };
  const outside = runGateDecision({ sidecar, cwd: '/tmp/scratch', cwdIsDir: true, cwdInWorkTree: false });
  assert.equal(outside.code, 'cwd-not-a-work-tree');

  const inside = runGateDecision({ sidecar, cwd: '/home/user/code/orbit', cwdIsDir: true, cwdInWorkTree: true });
  assert.deepEqual(inside, { ok: true, cwd: '/home/user/code/orbit' });
});

test('every run refusal code is in the closed set', () => {
  const cases = [
    { sidecar: { origin: 'imported', consentedAt: null }, cwd: '/x', cwdIsDir: true },
    { sidecar: { origin: 'imported', consentedAt: 'now' }, cwd: null },
    { sidecar: { origin: 'imported', consentedAt: 'now' }, cwd: '/home/user', cwdIsDir: true, cwdIsHome: true },
    { sidecar: { origin: 'imported', consentedAt: 'now' }, cwd: '/gone', cwdIsDir: false },
    {
      sidecar: { origin: 'imported', consentedAt: 'now', artifact: { requires: { workspace: { vcs: 'git' } } } },
      cwd: '/tmp/x',
      cwdIsDir: true,
      cwdInWorkTree: false,
    },
  ];
  for (const input of cases) {
    const r = runGateDecision(input);
    assert.equal(r.ok, false);
    assert.ok(I.RUN_REFUSAL_CODES.includes(r.code), `unexpected code ${r.code}`);
  }
});

test('runGateDecision is total on junk input', () => {
  assert.equal(runGateDecision(null).ok, true);
  assert.equal(runGateDecision(undefined).ok, true);
  assert.equal(runGateDecision({ sidecar: 'imported' }).ok, true);
});

// ─── the sidecar store ───────────────────────────────────────────────────

test('a row whose consentedAt is anything but a non-empty string reads as unconsented', () => {
  for (const value of [undefined, null, '', 0, true, {}, []]) {
    const row = normalizeRow('wf-1', { origin: 'imported', consentedAt: value });
    assert.equal(row.consentedAt, null, `consentedAt ${JSON.stringify(value)} should fail closed`);
    assert.equal(runGateDecision({ sidecar: row, cwd: '/x', cwdIsDir: true }).code, 'consent-required');
  }
});

test('an unrecognised origin normalises to imported, which is the strict side', () => {
  assert.equal(normalizeRow('wf-1', { origin: 'trusted' }).origin, 'imported');
  assert.equal(normalizeRow('wf-1', { origin: 'local' }).origin, 'local');
  assert.equal(normalizeRow('wf-1', { origin: 'imported' }).origin, 'imported');
});

test('normalizeStore drops rows that are not objects and keeps the ones that are', () => {
  const store = normalizeStore({
    version: 1,
    rows: {
      'wf-1': { origin: 'imported', artifact: { kind: 'husk.workflow' }, boundCwd: '/home/user/code/orbit', installedAt: 'x', consentedAt: 'y' },
      'wf-2': 'nope',
      'wf-3': null,
    },
  });
  assert.deepEqual(Object.keys(store.rows), ['wf-1']);
  assert.equal(store.rows['wf-1'].workflowId, 'wf-1');
  assert.equal(store.rows['wf-1'].boundCwd, '/home/user/code/orbit');
  assert.equal(store.version, I.SIDECAR_STORE_VERSION);
});

test('normalizeStore survives junk entirely', () => {
  for (const junk of [null, undefined, 'x', 42, [], { rows: 'x' }, { rows: [] }]) {
    const store = normalizeStore(junk);
    assert.deepEqual(store.rows, {});
  }
});

test('a stored row carries only the five documented fields plus its own id', () => {
  const row = sidecarRow({
    workflowId: 'wf-1',
    origin: 'imported',
    artifact: { kind: 'husk.workflow' },
    boundCwd: '/home/user/code/orbit',
    installedAt: '2026-02-06T10:00:00.000Z',
  });
  assert.deepEqual(Object.keys(row).sort(),
    ['artifact', 'boundCwd', 'consentedAt', 'installedAt', 'origin', 'workflowId']);
  assert.equal(row.consentedAt, null);
});

test('pruneStore removes rows whose workflow is gone and keeps the rest', () => {
  const store = {
    rows: {
      'wf-1': { origin: 'imported' },
      'wf-2': { origin: 'imported' },
      'wf-3': { origin: 'imported' },
    },
  };
  const pruned = pruneStore(store, ['wf-1', 'wf-3']);
  assert.deepEqual(Object.keys(pruned.store.rows).sort(), ['wf-1', 'wf-3']);
  assert.equal(pruned.removed, 1);
});

test('pruneStore with no live ids empties the store', () => {
  const pruned = pruneStore({ rows: { 'wf-1': { origin: 'imported' } } }, []);
  assert.deepEqual(pruned.store.rows, {});
  assert.equal(pruned.removed, 1);
  assert.equal(pruneStore({ rows: {} }, null).removed, 0);
});

// ─── export naming ───────────────────────────────────────────────────────

test('slugForName produces a committable ASCII filename', () => {
  assert.equal(slugForName('Triage, patch, verify'), 'triage-patch-verify');
  assert.equal(slugForName('  Deploy // Prod  '), 'deploy-prod');
  assert.equal(slugForName('日本語'), 'workflow');
  assert.equal(slugForName(''), 'workflow');
  assert.equal(slugForName(null), 'workflow');
  assert.equal(artifactFileName('Triage, patch, verify'), 'triage-patch-verify.husk.json');
});

test('a slug never contains a path separator or a leading dot', () => {
  for (const name of ['../../etc/passwd', '.hidden', 'a/b\\c', '..', '~/secrets']) {
    const slug = slugForName(name);
    assert.doesNotMatch(slug, /[/\\]/, `separator survived in ${slug}`);
    assert.doesNotMatch(slug, /^[.-]/, `leading punctuation survived in ${slug}`);
    assert.match(slug, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test('a very long name is clipped without leaving a trailing dash', () => {
  const slug = slugForName(`${'a'.repeat(70)} tail`);
  assert.ok(slug.length <= 60);
  assert.doesNotMatch(slug, /-$/);
});

// ─── the invariant that has no code to enforce it ────────────────────────────
//
// Installing a workflow must never install an MCP server. A manifest names the
// servers it wants, the install surface reports which are missing, and the
// operator adds them themselves through the MCP page. The gap between "we know
// the name and the command" and "we could just add it for you" is one small
// convenience patch wide, and on the other side of it a shared file gets to
// register a stdio server that runs an arbitrary binary on the importer's
// machine, before anybody has read a single step.
//
// There is no runtime check for this, because the defense is the absence of a
// call. This test is the enforcement: it fails the moment one appears.
test('the install path never reaches an MCP mutation channel', () => {
  const fs = require('fs');
  const path = require('path');
  const forbidden = ['mcp:add', 'mcp:addMany', 'mcp:parseSnippet'];
  const files = [
    'src/lib/workflow-install.js',
    'src/renderer/wfx-install.js',
    'src/renderer/wfx-publish.js',
    'src/renderer/wfx-artifact-ui.js',
  ];
  for (const rel of files) {
    const abs = path.join(__dirname, '..', '..', rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const chan of forbidden) {
      assert.ok(
        !src.includes(chan),
        `${rel} references ${chan}. Installing a workflow must never install an MCP server: report it missing and let the operator add it.`,
      );
    }
  }
});

// ─── a copy is still a stranger's work ───────────────────────────────────────
//
// Every check in this feature reads "did somebody else write this" as the
// PRESENCE of a sidecar row, so anything that produces a workflow without one
// produces a workflow that is trusted by default. Duplicating used to do
// exactly that: the copy carried the stranger's prompts and pinned agents, and
// carried no row, so the consent gate never opened, the run fell back to
// whichever directory was open rather than a bound one, and the auto-approving
// agent flags came back. The gate below is the shape of that hole.
test('a run gate treats a missing sidecar as locally authored, so copies must keep theirs', () => {
  const { runGateDecision } = require('../../src/lib/workflow-install');

  // The property that makes the hole possible, stated so it cannot drift.
  assert.equal(runGateDecision({ sidecar: null, cwd: null }).ok, true);
  assert.equal(runGateDecision({ sidecar: { origin: 'local' }, cwd: null }).ok, true);

  // And the property that closes it: a copy that keeps origin still gates.
  const copied = runGateDecision({
    sidecar: { origin: 'imported', consentedAt: null, boundCwd: '/home/user/proj' },
    cwd: '/home/user/proj',
  });
  assert.equal(copied.ok, false);
  assert.equal(copied.code, 'consent-required');

  // Carrying the consent across would be the same hole with a new id.
  const consented = runGateDecision({
    sidecar: { origin: 'imported', consentedAt: '2026-01-01T00:00:00.000Z', boundCwd: '/home/user/proj' },
    cwd: null,
  });
  assert.equal(consented.ok, false);
  assert.equal(consented.code, 'cwd-required');
});
