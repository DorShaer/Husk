'use strict';

// The portable workflow artifact: build one, fingerprint one, and read one a
// stranger wrote.
//
// A .husk.json file carries a workflow graph, a fingerprint of that graph, the
// concrete things it needs in order to run, and receipts from runs on someone
// else's machine. This module is the trust boundary for that file. The boundary
// is the byte: everything inside the file, including its own graphHash and its
// own receipts, comes from a machine this one does not control and is read that
// way.
//
// sanitizeGraph in workflow-graph.js is not used as a trust boundary here. It
// runs in this file after the real checks, to confirm that nothing was lost
// between what was validated and what the run engine will see.
//
// Two invariants this module holds:
//
//   1. No value from a manifest reaches mcp:add, mcp:addMany or
//      mcp:parseSnippet on any code path. requires.mcpServers and
//      requires.skills carry a charset-constrained name, an optional
//      fingerprint and a boolean, and nothing else: no command, no args, no
//      env, no url, no headers. The installer's "add server" affordance opens
//      the empty MCP form and never prefills it.
//
//   2. agentCommand is a bare basename from the supported-agent allowlist,
//      always.
//      The value must already equal its own normalised basename, so anything
//      carrying a separator, an extension or a capital letter is refused
//      rather than rewritten.
//
// The module is pure: no fs, no clock (the caller injects opts.now the way the
// autonomy supervisor does), no Electron, no spawn. That is what lets its
// fixtures run as ordinary unit tests. Reading the file off disk, with its size
// check and its path confinement, belongs to main.js.
//
// Every exported function is total. Any input, including an object whose
// getters throw, yields either a validated result or a structured refusal.

const crypto = require('crypto');
const { stableJson } = require('./stable-json');
// The arithmetic that turns runs into figures, borrowed rather than repeated.
// A shipped log is re-derived through the same aggregation the publisher used,
// so "the numbers disagree" can only ever mean the log and the receipt
// disagree, never that two implementations of a median do.
const WorkflowReceipt = require('./workflow-receipt');
const {
  ALLOWED_AGENT_COMMANDS,
  clipText,
  sanitizeGraph,
  graphToOrderedSteps,
  wfIsAiRouted,
} = require('./workflow-graph');

// ─── the format ──────────────────────────────────────────────────────────

const ARTIFACT_KIND = 'husk.workflow';

// Forward-only. A file declaring a version above this is refused whole, with
// both numbers named, and never partially parsed.
const MAX_ARTIFACT_SCHEMA = 1;

// The prefix is load-bearing and is part of the compared string. When the
// canonicalisation rule changes, old files keep husk-wfg-1 and the reader says
// "canonicalised by an older rule set" rather than "fingerprint mismatch".
const GRAPH_HASH_PREFIX = 'husk-wfg-1:sha256:';

const MAX_ARTIFACT_BYTES = 1024 * 1024;
// Summed across every chain of every receipt, not applied per item.
const MAX_CHAIN_BYTES = 512 * 1024;

const MAX_NODES = 64;
const MAX_EDGES = 256;
const MAX_RECEIPTS = 8;
const MAX_PROMPT = 8192;

// How much log one receipt may carry. Four rows is the floor because a run
// that happened at all leaves a start_run, a workflow_binding, at least one
// step and a run_summary. The two ceilings are the schema's, restated here so
// the reader of a chain and the validator of one share the same numbers.
const MIN_CHAIN_LINES = 4;
const MAX_CHAIN_LINES = 4000;
const MAX_CHAIN_SESSIONS = 32;

// The genesis anchor, declared here rather than imported: audit.js:41 holds the
// same constant, and requiring that module would pull fs into a file whose
// testability argument is that it has none.
// test/unit/workflow-artifact-chain.test.js asserts the two values are equal.
const GENESIS_HASH = '0'.repeat(64);

// The audit row schema this Husk knows how to read (audit.js:39). A row from a
// later version is refused rather than read hopefully, since sid, seq, kind and
// prev are the fields a schema bump is free to redefine.
const AUDIT_ROW_SCHEMA = 1;

// The three rows that give a workflow run its shape, in the order they must
// appear. start_run opens the session, workflow_binding names the graph the run
// executed so the binding sits inside the chain rather than beside it, and
// run_summary closes it, so a session that stops early is visible.
const ROW_START = 'start_run';
const ROW_BINDING = 'workflow_binding';
const ROW_SUMMARY = 'run_summary';

// Every way a shipped log can fail, as a closed set. A caller renders one
// sentence per predicate and a test names the one it expects, so a failure that
// arrived through the wrong predicate is a test failure rather than a passing
// assertion about a message string.
const CHAIN_PREDICATES = [
  'lines-type',
  'empty-log',
  'too-few-lines',
  'too-many-lines',
  'line-type',
  'not-json',
  'row-shape',
  'row-schema',
  'prev-hash',
  'session-ids',
  'session-order',
  'session-count',
  'seq',
  'structure',
  'binding',
  'head',
];

// Ceilings for canonicalProjection, which is also reachable from the export
// side where the graph is local. They sit far above the wire format's caps, so
// they never fire on a real file.
const MAX_PROJECTION_NODES = 4096;
const MAX_PROJECTION_EDGES = 16384;

const NODE_ID_RE = /^n(0|[1-9][0-9]{0,2})$/;
const EDGE_ID_RE = /^e(0|[1-9][0-9]{0,2})$/;
const ARTIFACT_ID_RE = /^wfa_[0-9a-z]{26}$/;
const RECEIPT_ID_RE = /^rcp_[0-9a-f]{16}$/;
const GRAPH_HASH_RE = /^husk-wfg-1:sha256:[0-9a-f]{64}$/;
const FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
const PUBLISHED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Deliberately unanchored at the tail so 2.11.0-beta.3 is a legal huskVersion
// while 2.11 and "latest" are not.
const HUSK_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+/;
// A model id is handed to a third-party CLI's argument parser, so the wire
// format holds it to plain identifier characters. Local free-text model pins
// are untouched; only the wire format is constrained.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUIRE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MARKER_FILE_RE = /^[A-Za-z0-9._/-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const OS_RE = /^[A-Za-z0-9._-]{1,32}$/;
const PUBLISHER_URL_RE = /^https:\/\//;

const BRANCH_MODES = ['parallel', 'ai'];
const PASS_CONTEXTS = ['full', 'last50', 'none'];
// regex is absent: a published workflow routes on plain conditions only.
const CONDITION_TYPES = ['always', 'contains', 'otherwise'];
const VCS_KINDS = ['git', 'none'];
const EVIDENCE_KINDS = ['none', 'inline'];
// The only v1 basis for an outcome count. The UI is contractually bound to
// render it, so the sentence is always "26 of 31 runs finished with a zero
// exit" and never a percentage under the word PASS.
const OUTCOME_BASES = ['process-exit'];
// A coarse bucket rather than a count: an exact count says more about the
// author's repository than it does about the workflow, and two repositories
// are not comparable by it anyway.
const TRACKED_FILES_BUCKETS = ['0', '1-100', '100-1k', '1k-10k', '10k-100k', '100k+'];

const TOP_KEYS = ['kind', 'schemaVersion', 'artifactId', 'revision', 'name', 'description',
  'publishedAt', 'publisher', 'huskVersion', 'graph', 'graphHash', 'requires', 'receipts', 'notes'];
const NODE_KEYS = ['id', 'name', 'agentCommand', 'model', 'branchMode', 'prompt', 'passContext', 'x', 'y'];
const EDGE_KEYS = ['id', 'from', 'to', 'condition'];
const CONDITION_KEYS = ['type', 'value'];
const REQUIRES_KEYS = ['agentCommands', 'models', 'mcpServers', 'skills', 'workspace', 'huskMin'];
const WORKSPACE_KEYS = ['vcs', 'markerFiles', 'commands'];
const RECEIPT_KEYS = ['id', 'graphHash', 'runs', 'runsWindowed', 'window', 'outcomes', 'outcomeBasis',
  'medianDurationMs', 'durationCensored', 'medianTokens', 'environment', 'evidence', 'chain'];
const WINDOW_KEYS = ['firstRunAt', 'lastRunAt'];
const OUTCOME_KEYS = ['completed', 'failed', 'stopped', 'timedOut'];
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreate'];
const ENVIRONMENT_KEYS = ['agentResolved', 'agentVersion', 'modelResolved', 'os', 'huskVersion', 'workspace'];
const ENV_WORKSPACE_KEYS = ['vcs', 'trackedFiles', 'languages'];
const CHAIN_KEYS = ['sessionIds', 'head', 'lineCount', 'lines'];

// The closed refusal enum for reading a file. A renderer keys its title and
// its recovery advice off these strings, so adding one is a UI change and
// removing one breaks a surface. not-artifact doubles as the malformed-scalar
// code: the enum has no separate "malformed", and from the reader's side a
// file whose name is a number is not a Husk workflow. The offending field path
// is always in `detail`.
const REFUSAL_CODES = [
  'too-large',
  'not-json',
  'not-artifact',
  'schema-too-new',
  'too-many-nodes',
  'bad-id',
  'bad-agent',
  'regex-condition',
  'bad-model',
  'edges-dropped',
  'hash-mismatch',
  'receipt-invalid',
  'chain-invalid',
];

// Writing a file has two failure modes the reading enum has no member for: a
// caller that handed us something unusable (our own bug, never a stranger's
// file) and a graph whose step names cannot be routed unambiguously. They are
// a separate closed set so the reader's enum stays exactly what the format
// spec says it is.
const EXPORT_REFUSAL_CODES = REFUSAL_CODES.concat(['bad-input', 'name-collision']);

// ─── small totals ────────────────────────────────────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Own-property reads throughout: only the fields an object carries itself are
// read, and an own "__proto__" data property stays visible to the unknown-key
// check.
function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function get(obj, key) {
  return has(obj, key) ? obj[key] : undefined;
}

function unknownKey(obj, allowed) {
  for (const k of Object.keys(obj)) {
    if (allowed.indexOf(k) === -1) return k;
  }
  return null;
}

// A short, bounded description of a rejected value for the refusal's detail
// slot, never the value itself.
function preview(v) {
  try {
    if (v === null) return 'null';
    if (v === undefined) return 'missing';
    if (typeof v === 'string') return v.length > 80 ? `a string of ${v.length} characters` : JSON.stringify(v);
    if (Array.isArray(v)) return `an array of ${v.length}`;
    if (typeof v === 'object') return 'an object';
    return String(v).slice(0, 80);
  } catch (_) {
    return 'an unreadable value';
  }
}

function refuse(code, message, detail) {
  return {
    ok: false,
    code,
    message: String(message),
    detail: (detail === undefined || detail === null) ? null : String(detail).slice(0, 512),
  };
}

// True when the string carries an unpaired surrogate half, which is not text
// and which no workflow contains. Checked by code unit rather than by regex,
// because the regex form needs a lookbehind and reads like a puzzle.
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = (i + 1 < s.length) ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Length before charset, everywhere.
function badString(v, path, min, max, code) {
  const c = code || 'not-artifact';
  if (typeof v !== 'string') return refuse(c, `${path} must be a string`, preview(v));
  if (v.length < min) return refuse(c, `${path} must be at least ${min} character${min === 1 ? '' : 's'} long`, `length ${v.length}`);
  if (v.length > max) return refuse(c, `${path} must be at most ${max} characters long`, `length ${v.length}`);
  if (hasLoneSurrogate(v)) return refuse(c, `${path} contains an unpaired surrogate`, path);
  return null;
}

function badInt(v, path, min, max, code) {
  const c = code || 'not-artifact';
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return refuse(c, `${path} must be a whole number`, preview(v));
  if (v < min || v > max) return refuse(c, `${path} must be between ${min} and ${max}`, `value ${v}`);
  return null;
}

function badEnum(v, path, allowed, code) {
  const c = code || 'not-artifact';
  if (typeof v !== 'string' || allowed.indexOf(v) === -1) {
    return refuse(c, `${path} must be one of ${allowed.join(', ')}`, preview(v));
  }
  return null;
}

// JSON has a -0 and every consumer of these numbers does not. Normalising at
// projection time keeps it out of the stored artifact rather than leaving it
// for whichever renderer formats it first.
function normInt(v) {
  return v === 0 ? 0 : v;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Basename normalisation, in one place so import and export agree on what a
// basename is. Returns '' when there is nothing usable left.
function normalizeAgentCommand(value) {
  if (typeof value !== 'string') return '';
  const first = value.trim().split(/\s+/)[0];
  if (!first) return '';
  return first.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

// A pattern with no metacharacters means the same thing as a substring test,
// so export can carry it across as `contains` rather than refusing a workflow
// whose author typed a regex out of habit. Anything else is refused by name:
// silently reinterpreting a real pattern would change which branch runs.
function isLiteralPattern(value) {
  if (typeof value !== 'string' || !value.length) return false;
  return !/[\\^$.*+?()[\]{}|]/.test(value);
}

// ─── canonicalisation ────────────────────────────────────────────────────

// canonicalProjection reduces a graph to the part of it that decides what runs:
// the six fields that determine behaviour, plus the shape of the wiring. Layout
// coordinates and locally minted ids stay out, so moving a node on the canvas
// keeps the fingerprint and the receipts attached to it.
//
// Node order is by content hash, with position in graphToOrderedSteps as the
// tie-break, so two authors who built the same workflow in a different order
// publish the same fingerprint. That is also why the ids in a published file
// look shuffled relative to reading order, and why every surface renders step
// names rather than ids.
//
// Step names are inside the hash. wfResolveNext routes AI branches by matching
// the model's ROUTE: line against node.name, so renaming a step is a
// behavioural change. Edge multiplicity and edge order are inside it for the
// same reason, described where they are projected below.
//
// Returns { ok: true, projection, nodes, idMap, hash } or { ok: false, error }.
function canonicalProjection(rawGraph) {
  try {
    const g = sanitizeGraph(rawGraph);
    if (g.nodes.length > MAX_PROJECTION_NODES) {
      return { ok: false, error: `graph has ${g.nodes.length} steps, which is past the ${MAX_PROJECTION_NODES} this can canonicalise` };
    }
    if (g.edges.length > MAX_PROJECTION_EDGES) {
      return { ok: false, error: `graph has ${g.edges.length} connections, which is past the ${MAX_PROJECTION_EDGES} this can canonicalise` };
    }
    if (!g.nodes.length) return { ok: false, error: 'graph has no steps' };

    // The tie-break index. graphToOrderedSteps is breadth-first from the roots
    // in edge-declaration order with disconnected components appended, so it is
    // deterministic for a given graph. Duplicate ids collapse in this map, the
    // first occurrence wins, and anything unmapped sorts last, which keeps the
    // comparator total.
    const tieById = new Map();
    const ordered = graphToOrderedSteps(g);
    for (let i = 0; i < ordered.length; i++) {
      if (!tieById.has(ordered[i].id)) tieById.set(ordered[i].id, i);
    }

    const entries = g.nodes.map((n, index) => {
      const body = {
        agentCommand: n.agentCommand === null ? null : String(n.agentCommand),
        branchMode: n.branchMode,
        model: n.model === null ? null : String(n.model),
        name: n.name,
        passContext: n.passContext,
        prompt: n.prompt,
      };
      return {
        id: n.id,
        node: n,
        body,
        contentHash: sha256Hex(stableJson(body)),
        tie: tieById.has(n.id) ? tieById.get(n.id) : ordered.length,
        index,
      };
    });

    // Position in the source array is the last tie-break, so the order of two
    // nodes identical in content does not rest on the engine's sort being
    // stable.
    entries.sort((a, b) => {
      if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
      if (a.tie !== b.tie) return a.tie - b.tie;
      return a.index - b.index;
    });

    const idMap = new Map();
    for (let i = 0; i < entries.length; i++) idMap.set(entries[i].id, `n${i}`);

    // Edges keep their condition, their endpoints, their multiplicity and their
    // position, and lose only their own ids. All four are behavioural:
    // wfIsAiRouted decides a step is an AI router by counting its outgoing
    // edges (workflow-graph.js:164-168), wfRunStep appends the ROUTE
    // instruction with its target names once an ai-mode step has two of them
    // (main.js:5699-5700), and contextFor concatenates each taken incoming
    // edge's output in edge-declaration order (main.js:5831-5841). A rewiring
    // that changes none of that still moves the hash and detaches the receipts
    // it could have kept.
    const projectedEdges = [];
    for (const e of g.edges) {
      const from = idMap.get(e.from);
      const to = idMap.get(e.to);
      // sanitizeGraph, three lines up, already drops every edge whose endpoints
      // are not nodes, so this skip does not fire through it. It stays so that
      // an unmappable edge is skipped rather than hashed as undefined.
      if (from === undefined || to === undefined) continue;
      projectedEdges.push({
        condition: {
          type: e.condition.type,
          value: e.condition.value,
        },
        from,
        to,
      });
    }

    const projection = {
      edges: projectedEdges,
      nodes: entries.map((e) => e.body),
      v: 1,
    };

    return {
      ok: true,
      projection,
      // The canonical order, carrying the source node with each entry, so the
      // exporter can lay out x/y and pin models without re-deriving the order
      // and risking a different answer.
      nodes: entries.map((e, i) => ({ canonicalId: `n${i}`, sourceId: e.id, source: e.node, body: e.body })),
      idMap,
      hash: GRAPH_HASH_PREFIX + sha256Hex(stableJson(projection)),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) ? String(err.message).slice(0, 200) : 'projection failed' };
  }
}

// graphHash is the fingerprint the file ships and the reader recomputes.
// Returns { ok: true, hash } or { ok: false, error }.
function graphHash(rawGraph) {
  const p = canonicalProjection(rawGraph);
  if (!p.ok) return { ok: false, error: p.error };
  return { ok: true, hash: p.hash };
}

// ─── reading a stranger's file ───────────────────────────────────────────

// parseArtifact takes the file's bytes and nothing else. The size check on disk
// belongs to the caller, since this module has no fs; the length check here
// measures what arrived.
function parseArtifact(bytes) {
  try {
    let text;
    if (typeof bytes === 'string') {
      // Two checks: characters, then bytes. The byte length is the one the file
      // on disk is measured against.
      if (bytes.length > MAX_ARTIFACT_BYTES) {
        return refuse('too-large', `this file is larger than the ${MAX_ARTIFACT_BYTES} byte limit`, `${bytes.length} characters`);
      }
      const size = Buffer.byteLength(bytes, 'utf8');
      if (size > MAX_ARTIFACT_BYTES) {
        return refuse('too-large', `this file is larger than the ${MAX_ARTIFACT_BYTES} byte limit`, `${size} bytes`);
      }
      text = bytes;
    } else if (Buffer.isBuffer(bytes)) {
      if (bytes.length > MAX_ARTIFACT_BYTES) {
        return refuse('too-large', `this file is larger than the ${MAX_ARTIFACT_BYTES} byte limit`, `${bytes.length} bytes`);
      }
      text = bytes.toString('utf8');
    } else {
      return refuse('not-json', 'expected the file contents as a string or a Buffer', preview(bytes));
    }

    let obj;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      return refuse('not-json', 'this file is not valid JSON', err && err.message);
    }
    return validateArtifact(obj);
  } catch (err) {
    return refuse('not-json', 'this file could not be read', err && err.message);
  }
}

// validateArtifact is the order of operations, exactly. Counts before any map,
// ids before sanitizeGraph, the fingerprint before any receipt is believed,
// and an allowlist projection at the end so nothing unrecognised is ever
// carried forward. It is total by construction and by this try/catch.
//
// Every scalar is read from the input exactly once, into a local, and every
// later use, the check, the hash and the returned projection alike, is of that
// local. The input is not always JSON.parse output, since the exported
// signature invites a caller to hand over an object it built, so reading once
// is what makes the checked value and the stored value the same value.
function validateArtifact(input) {
  try {
    return validateArtifactInner(input);
  } catch (err) {
    return refuse('not-artifact', 'this file could not be read as a Husk workflow', err && err.message);
  }
}

function validateArtifactInner(obj) {
  if (!isPlainObject(obj)) return refuse('not-artifact', 'this file is not a JSON object', preview(obj));

  // kind first, before anything else, so a JSON file that happens to have a
  // nodes array is told what it is rather than being structurally sniffed.
  const kind = get(obj, 'kind');
  if (kind !== ARTIFACT_KIND) {
    return refuse('not-artifact', `this file does not declare kind "${ARTIFACT_KIND}"`, preview(kind));
  }

  const schemaVersion = get(obj, 'schemaVersion');
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    return refuse('not-artifact', 'schemaVersion must be a whole number of at least 1', preview(schemaVersion));
  }
  if (schemaVersion > MAX_ARTIFACT_SCHEMA) {
    return refuse('schema-too-new',
      `this file was written for schema version ${schemaVersion} and this Husk reads up to ${MAX_ARTIFACT_SCHEMA}`,
      `file: ${schemaVersion}, supported: ${MAX_ARTIFACT_SCHEMA}`);
  }

  // additionalProperties: false, enforced rather than assumed. An unrecognised
  // top-level key is refused here rather than carried into the store.
  const strayTop = unknownKey(obj, TOP_KEYS);
  if (strayTop !== null) {
    return refuse('not-artifact', 'this file carries a field this Husk does not recognise', `top level: ${JSON.stringify(strayTop).slice(0, 80)}`);
  }

  // Counts, before anything is mapped, sorted or hashed.
  const graph = get(obj, 'graph');
  if (!isPlainObject(graph)) return refuse('not-artifact', 'graph must be an object', preview(graph));
  const strayGraph = unknownKey(graph, ['nodes', 'edges']);
  if (strayGraph !== null) {
    return refuse('not-artifact', 'graph carries a field this Husk does not recognise', `graph: ${JSON.stringify(strayGraph).slice(0, 80)}`);
  }
  const nodes = get(graph, 'nodes');
  const edges = get(graph, 'edges');
  if (!Array.isArray(nodes)) return refuse('not-artifact', 'graph.nodes must be an array', preview(nodes));
  if (!Array.isArray(edges)) return refuse('not-artifact', 'graph.edges must be an array', preview(edges));
  if (nodes.length < 1) return refuse('not-artifact', 'this workflow has no steps', 'graph.nodes is empty');
  if (nodes.length > MAX_NODES) {
    return refuse('too-many-nodes', `this workflow has ${nodes.length} steps and the limit is ${MAX_NODES}`, `graph.nodes: ${nodes.length}`);
  }
  if (edges.length > MAX_EDGES) {
    return refuse('too-many-nodes', `this workflow has ${edges.length} connections and the limit is ${MAX_EDGES}`, `graph.edges: ${edges.length}`);
  }
  const receipts = get(obj, 'receipts');
  if (!Array.isArray(receipts)) return refuse('not-artifact', 'receipts must be an array', preview(receipts));
  if (receipts.length > MAX_RECEIPTS) {
    return refuse('too-many-nodes', `this file carries ${receipts.length} receipts and the limit is ${MAX_RECEIPTS}`, `receipts: ${receipts.length}`);
  }

  // Envelope scalars. Bounded work on a bounded number of fields, each one read
  // into a local here and never read from the input again.
  const artifactId = get(obj, 'artifactId');
  if (typeof artifactId !== 'string' || artifactId.length !== 30 || !ARTIFACT_ID_RE.test(artifactId)) {
    return refuse('bad-id', 'artifactId must be wfa_ followed by 26 lowercase base36 characters', preview(artifactId));
  }
  const revision = get(obj, 'revision');
  let bad = badInt(revision, 'revision', 1, 100000);
  if (bad) return bad;
  const name = get(obj, 'name');
  bad = badString(name, 'name', 1, 80);
  if (bad) return bad;
  const description = has(obj, 'description') ? get(obj, 'description') : null;
  if (description !== null) {
    bad = badString(description, 'description', 0, 280);
    if (bad) return bad;
  }
  const publishedAt = get(obj, 'publishedAt');
  if (typeof publishedAt !== 'string' || publishedAt.length !== 24 || !PUBLISHED_AT_RE.test(publishedAt)) {
    return refuse('not-artifact', 'publishedAt must be an ISO 8601 timestamp with milliseconds', preview(publishedAt));
  }
  const publisher = has(obj, 'publisher') ? get(obj, 'publisher') : null;
  let publisherName = null;
  let publisherUrl = null;
  if (publisher !== null) {
    if (!isPlainObject(publisher)) return refuse('not-artifact', 'publisher must be an object or null', preview(publisher));
    const strayPub = unknownKey(publisher, ['name', 'url']);
    if (strayPub !== null) return refuse('not-artifact', 'publisher carries a field this Husk does not recognise', `publisher: ${JSON.stringify(strayPub).slice(0, 80)}`);
    publisherName = get(publisher, 'name');
    bad = badString(publisherName, 'publisher.name', 1, 64);
    if (bad) return bad;
    publisherUrl = get(publisher, 'url');
    bad = badString(publisherUrl, 'publisher.url', 1, 256);
    if (bad) return bad;
    // https only. The string is rendered and may be opened.
    if (!PUBLISHER_URL_RE.test(publisherUrl)) return refuse('not-artifact', 'publisher.url must start with https://', preview(publisherUrl));
  }
  const huskVersion = get(obj, 'huskVersion');
  bad = badString(huskVersion, 'huskVersion', 1, 32);
  if (bad) return bad;
  if (!HUSK_VERSION_RE.test(huskVersion)) return refuse('not-artifact', 'huskVersion must look like 2.11.0', preview(huskVersion));
  const notes = has(obj, 'notes') ? get(obj, 'notes') : null;
  if (notes !== null) {
    bad = badString(notes, 'notes', 0, 2000);
    if (bad) return bad;
  }

  // Node ids, before any other node field and before sanitizeGraph, so ids are
  // canonical before anything is derived from them.
  const nodeIds = new Set();
  const nodeIdAt = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!isPlainObject(n)) return refuse('not-artifact', `graph.nodes[${i}] must be an object`, preview(n));
    const id = get(n, 'id');
    if (typeof id !== 'string') return refuse('bad-id', `graph.nodes[${i}].id must be a string`, preview(id));
    if (id.length > 4) return refuse('bad-id', `graph.nodes[${i}].id is not a canonical step id`, `length ${id.length}`);
    if (!NODE_ID_RE.test(id)) return refuse('bad-id', `graph.nodes[${i}].id is not a canonical step id`, preview(id));
    if (nodeIds.has(id)) return refuse('bad-id', `two steps share the id ${id}`, `graph.nodes[${i}].id`);
    nodeIds.add(id);
    nodeIdAt[i] = id;
  }

  // Node scalars, then the agent basename. Each value lands in validNodes and
  // the input's node objects are never consulted again: what gets hashed, what
  // gets checked against requires, and what gets returned are all this one copy.
  const validNodes = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const stray = unknownKey(n, NODE_KEYS);
    if (stray !== null) {
      return refuse('not-artifact', 'a step carries a field this Husk does not recognise', `graph.nodes[${i}]: ${JSON.stringify(stray).slice(0, 80)}`);
    }
    const nodeName = get(n, 'name');
    bad = badString(nodeName, `graph.nodes[${i}].name`, 1, 64);
    if (bad) return bad;
    const prompt = get(n, 'prompt');
    bad = badString(prompt, `graph.nodes[${i}].prompt`, 0, MAX_PROMPT);
    if (bad) return bad;
    const branchMode = get(n, 'branchMode');
    bad = badEnum(branchMode, `graph.nodes[${i}].branchMode`, BRANCH_MODES);
    if (bad) return bad;
    const passContext = get(n, 'passContext');
    bad = badEnum(passContext, `graph.nodes[${i}].passContext`, PASS_CONTEXTS);
    if (bad) return bad;

    const model = get(n, 'model');
    if (model !== null) {
      bad = badString(model, `graph.nodes[${i}].model`, 1, 128, 'bad-model');
      if (bad) return bad;
      if (!MODEL_RE.test(model)) {
        return refuse('bad-model', `the model pinned on step "${nodeName}" is not a plain model id`, preview(model));
      }
    }

    // Layout is quantised by the exporter, so coordinates sit on the grid.
    const x = get(n, 'x');
    const y = get(n, 'y');
    bad = badInt(x, `graph.nodes[${i}].x`, 0, 20000) || badInt(y, `graph.nodes[${i}].y`, 0, 20000);
    if (bad) return bad;
    if (x % 20 !== 0 || y % 20 !== 0) {
      return refuse('not-artifact', `graph.nodes[${i}] has a position off the 20 pixel grid`, `x ${x}, y ${y}`);
    }

    // The agent basename. The value must already be its own normalised form:
    // "./claude" normalises to "claude" and is still refused, so the file is
    // shown to its reader as written rather than quietly rewritten.
    const agentCommand = get(n, 'agentCommand');
    if (typeof agentCommand !== 'string') {
      return refuse('bad-agent', `step "${nodeName}" does not name an agent to run`, preview(agentCommand));
    }
    if (agentCommand.length > 32) {
      return refuse('bad-agent', `step "${nodeName}" names an agent this Husk will not run`, `length ${agentCommand.length}`);
    }
    const base = normalizeAgentCommand(agentCommand);
    if (base !== agentCommand || !ALLOWED_AGENT_COMMANDS.has(base)) {
      return refuse('bad-agent',
        `step "${nodeName}" names an agent this Husk will not run`,
        `agentCommand: ${JSON.stringify(agentCommand).slice(0, 80)}`);
    }

    validNodes[i] = {
      id: nodeIdAt[i],
      name: nodeName,
      agentCommand,
      model: model === null ? null : model,
      branchMode,
      prompt,
      passContext,
      x: normInt(x),
      y: normInt(y),
    };
  }

  // Edge ids, then edge scalars, then the regex refusal. Same rule as the
  // nodes: read once, into validEdges.
  const edgeIds = new Set();
  const validEdges = new Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!isPlainObject(e)) return refuse('not-artifact', `graph.edges[${i}] must be an object`, preview(e));
    const stray = unknownKey(e, EDGE_KEYS);
    if (stray !== null) {
      return refuse('not-artifact', 'a connection carries a field this Husk does not recognise', `graph.edges[${i}]: ${JSON.stringify(stray).slice(0, 80)}`);
    }
    const id = get(e, 'id');
    if (typeof id !== 'string') return refuse('bad-id', `graph.edges[${i}].id must be a string`, preview(id));
    if (id.length > 4) return refuse('bad-id', `graph.edges[${i}].id is not a canonical connection id`, `length ${id.length}`);
    if (!EDGE_ID_RE.test(id)) return refuse('bad-id', `graph.edges[${i}].id is not a canonical connection id`, preview(id));
    if (edgeIds.has(id)) return refuse('bad-id', `two connections share the id ${id}`, `graph.edges[${i}].id`);
    edgeIds.add(id);

    const ends = { from: '', to: '' };
    for (const end of ['from', 'to']) {
      const v = get(e, end);
      if (typeof v !== 'string') return refuse('bad-id', `graph.edges[${i}].${end} must be a string`, preview(v));
      if (v.length > 4 || !NODE_ID_RE.test(v)) return refuse('bad-id', `graph.edges[${i}].${end} is not a canonical step id`, preview(v));
      ends[end] = v;
    }

    const condition = get(e, 'condition');
    if (!isPlainObject(condition)) return refuse('not-artifact', `graph.edges[${i}].condition must be an object`, preview(condition));
    const strayCond = unknownKey(condition, CONDITION_KEYS);
    if (strayCond !== null) {
      return refuse('not-artifact', 'a condition carries a field this Husk does not recognise', `graph.edges[${i}].condition: ${JSON.stringify(strayCond).slice(0, 80)}`);
    }
    const type = get(condition, 'type');
    if (type === 'regex') {
      return refuse('regex-condition',
        'this workflow routes on a regular expression, which published workflows cannot carry',
        `graph.edges[${i}].condition`);
    }
    bad = badEnum(type, `graph.edges[${i}].condition.type`, CONDITION_TYPES);
    if (bad) return bad;
    const value = get(condition, 'value');
    bad = badString(value, `graph.edges[${i}].condition.value`, 0, 256);
    if (bad) return bad;

    validEdges[i] = { id, from: ends.from, to: ends.to, condition: { type, value } };
  }

  // sanitizeGraph is what the run engine will see, so anything it drops means
  // the file describes a workflow other than the one that would run. It runs
  // over the validated copy rather than over the input, so the graph that gets
  // fingerprinted is the graph that was checked.
  const sanitized = sanitizeGraph({ nodes: validNodes, edges: validEdges });
  if (sanitized.nodes.length !== nodes.length) {
    return refuse('not-artifact', 'this graph did not survive being read', `${nodes.length} steps in, ${sanitized.nodes.length} out`);
  }
  if (sanitized.edges.length !== edges.length) {
    const lost = edges.length - sanitized.edges.length;
    return refuse('edges-dropped',
      `${lost} connection${lost === 1 ? '' : 's'} in this file point${lost === 1 ? 's' : ''} at a step that is not in it`,
      `${edges.length} connections in, ${sanitized.edges.length} out`);
  }

  // The fingerprint, recomputed from the graph this file actually ships.
  const declaredHash = get(obj, 'graphHash');
  if (typeof declaredHash !== 'string' || declaredHash.length !== GRAPH_HASH_PREFIX.length + 64 || !GRAPH_HASH_RE.test(declaredHash)) {
    return refuse('not-artifact', 'graphHash is not a husk-wfg-1 fingerprint', preview(declaredHash));
  }
  const projection = canonicalProjection(sanitized);
  if (!projection.ok) return refuse('not-artifact', 'this graph could not be fingerprinted', projection.error);
  if (projection.hash !== declaredHash) {
    // Both hashes in full, never truncated. This is the one place a person is
    // asked to decide whether a file is what it says it is.
    return refuse('hash-mismatch',
      'the fingerprint in this file does not match the graph it ships, so its receipts do not belong to this workflow',
      `in the file:   ${declaredHash}\nrecomputed:    ${projection.hash}`);
  }

  // The shape export will not write, refused on the way in as well.
  // wfResolveNext falls back to substring containment when the model's ROUTE:
  // line matches no step name exactly (workflow-graph.js:189-198), so an AI
  // router wired to both "Patch" and "Patch tests" runs whichever of the two
  // the loop reaches first. Export and import apply the same test. The reader's
  // closed enum has no member for it, so the refusal travels as not-artifact
  // with both names in the message.
  const collision = routingCollision(sanitized);
  if (collision) {
    return refuse('not-artifact',
      `the step "${collision.from}" routes to both "${collision.a}" and "${collision.b}", and Husk cannot tell those two names apart`,
      `${collision.a} / ${collision.b}`);
  }

  // The graph is stored in canonical order under canonical ids, not in the
  // order the file happened to list them. Node ids are only pattern-checked,
  // and graphToOrderedSteps seeds its walk from the node array
  // (workflow-graph.js:116-117), which is the order the workflow list, the run
  // view and the imported-workflow consent gate all read. Reprojecting here
  // costs nothing for a file this module wrote, since buildArtifact already
  // emits canonical order, and makes one fingerprint mean one record.
  const idMap = projection.idMap;
  const canonicalNodes = projection.nodes.map((entry, i) => ({
    id: `n${i}`,
    name: entry.source.name,
    agentCommand: entry.source.agentCommand,
    model: entry.source.model,
    branchMode: entry.source.branchMode,
    prompt: entry.source.prompt,
    passContext: entry.source.passContext,
    x: normInt(entry.source.x),
    y: normInt(entry.source.y),
  }));
  const canonicalEdges = validEdges.map((e, i) => ({
    id: `e${i}`,
    from: idMap.get(e.from),
    to: idMap.get(e.to),
    condition: { type: e.condition.type, value: e.condition.value },
  }));

  // requires is checked against the file's own ids, because that is what it
  // was written against, and its model pins are rewritten to the canonical ids
  // afterwards so the returned record is internally consistent.
  const requires = validateRequires(get(obj, 'requires'), validNodes, idMap);
  if (!requires.ok) return requires;

  // Receipts last, and only once the graph they claim to describe has been
  // proven to be the graph in front of us.
  const budget = { bytes: 0 };
  const projectedReceipts = [];
  for (let i = 0; i < receipts.length; i++) {
    const r = validateReceipt(receipts[i], i, declaredHash, budget);
    if (!r.ok) return r;
    projectedReceipts.push(r.receipt);
  }

  // The shipped logs, walked here rather than by whoever draws them. Structure
  // was checked above; this is the part that re-hashes the rows and recomputes
  // the figures from them, and it happens on every read so no surface renders
  // an inline receipt without the answer already in hand.
  //
  // A failure here does not refuse the file. The graph is unaffected by a log
  // that does not hold up, so what collapses is the receipt block, in the
  // vocabulary the checks below use.
  const receiptChecks = projectedReceipts.map((r) => checkReceiptEvidence(r));
  const chainCheck = combineEvidenceChecks(receiptChecks);

  const warnings = [];
  if (!projectedReceipts.length) {
    warnings.push({ code: 'no-receipts', message: 'this workflow ships no run history' });
  } else if (projectedReceipts.every((r) => r.evidence === 'none')) {
    warnings.push({ code: 'attested-only', message: 'every figure in this file is stated by its author with no log attached' });
  } else if (chainCheck.valid !== true) {
    warnings.push({ code: 'evidence-refused', message: 'the log this file attaches does not hold together, so its figures are withheld' });
  } else if (chainCheck.agrees !== true) {
    warnings.push({ code: 'evidence-disagrees', message: 'the log this file attaches does not support the figures declared beside it' });
  }

  // The allowlist projection. Every value here is a local that passed a check
  // above, never a second read of the input, so only recognised and validated
  // values reach the sidecar store and the workflow record.
  const artifact = {
    kind: ARTIFACT_KIND,
    schemaVersion,
    artifactId,
    revision: normInt(revision),
    name,
    description,
    publishedAt,
    publisher: publisher === null ? null : { name: publisherName, url: publisherUrl },
    huskVersion,
    graph: { nodes: canonicalNodes, edges: canonicalEdges },
    graphHash: declaredHash,
    requires: requires.requires,
    receipts: projectedReceipts,
    notes,
  };

  // chainCheck travels beside the artifact rather than inside it, because it is
  // this machine's finding about the file and not a field of the format.
  return { ok: true, artifact, warnings, chainCheck, receiptChecks };
}

// The one sibling-name ambiguity wfResolveNext cannot resolve, found on a
// sanitized graph so export and import share a single definition of it. A
// target whose name trims to nothing is skipped, because the containment
// fallback requires a non-empty name (workflow-graph.js:196).
function routingCollision(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of graph.nodes) {
    if (!wfIsAiRouted(graph, n.id)) continue;
    const targets = graph.edges
      .filter((e) => e.from === n.id)
      .map((e) => (byId.get(e.to) || {}).name || '')
      .map((name) => ({ name, key: name.trim().toLowerCase() }))
      .filter((t) => t.key.length > 0);
    for (let a = 0; a < targets.length; a++) {
      for (let b = a + 1; b < targets.length; b++) {
        const ka = targets[a].key;
        const kb = targets[b].key;
        if (ka.indexOf(kb) !== -1 || kb.indexOf(ka) !== -1) {
          return { from: n.name, a: targets[a].name, b: targets[b].name };
        }
      }
    }
  }
  return null;
}

function validateRequires(requires, nodes, idMap) {
  if (!isPlainObject(requires)) return refuse('not-artifact', 'requires must be an object', preview(requires));
  const stray = unknownKey(requires, REQUIRES_KEYS);
  if (stray !== null) return refuse('not-artifact', 'requires carries a field this Husk does not recognise', `requires: ${JSON.stringify(stray).slice(0, 80)}`);

  const agentCommands = get(requires, 'agentCommands');
  if (!Array.isArray(agentCommands)) return refuse('not-artifact', 'requires.agentCommands must be an array', preview(agentCommands));
  if (agentCommands.length < 1 || agentCommands.length > ALLOWED_AGENT_COMMANDS.size) {
    return refuse('bad-agent', `requires.agentCommands must name between one and ${ALLOWED_AGENT_COMMANDS.size} agents`, `length ${agentCommands.length}`);
  }
  const declaredAgents = new Set();
  const validAgents = new Array(agentCommands.length);
  for (let i = 0; i < agentCommands.length; i++) {
    const a = agentCommands[i];
    if (typeof a !== 'string' || a.length > 32 || !ALLOWED_AGENT_COMMANDS.has(a)) {
      return refuse('bad-agent', 'requires.agentCommands names an agent this Husk will not run', preview(a));
    }
    if (declaredAgents.has(a)) return refuse('bad-agent', `requires.agentCommands lists ${a} twice`, `requires.agentCommands[${i}]`);
    declaredAgents.add(a);
    validAgents[i] = a;
  }
  // The declared requirement and the graph have to agree, because the
  // requirements pane is what the installer reads before deciding.
  const graphAgents = new Set(nodes.map((n) => get(n, 'agentCommand')));
  for (const a of graphAgents) {
    if (!declaredAgents.has(a)) return refuse('bad-agent', `this workflow runs ${a} but does not list it in requires.agentCommands`, `missing: ${a}`);
  }
  for (const a of declaredAgents) {
    if (!graphAgents.has(a)) return refuse('bad-agent', `requires.agentCommands lists ${a}, which no step in this workflow runs`, `unused: ${a}`);
  }

  const models = get(requires, 'models');
  if (!Array.isArray(models)) return refuse('not-artifact', 'requires.models must be an array', preview(models));
  if (models.length > 64) return refuse('bad-model', `requires.models has ${models.length} entries and the limit is 64`, `length ${models.length}`);
  const pinned = new Map();
  for (const n of nodes) {
    const m = get(n, 'model');
    if (m !== null && m !== undefined) pinned.set(get(n, 'id'), m);
  }
  const seenModelNodes = new Set();
  const validModels = new Array(models.length);
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    if (!isPlainObject(m)) return refuse('not-artifact', `requires.models[${i}] must be an object`, preview(m));
    const strayM = unknownKey(m, ['node', 'model']);
    if (strayM !== null) return refuse('not-artifact', 'a model pin carries a field this Husk does not recognise', `requires.models[${i}]: ${JSON.stringify(strayM).slice(0, 80)}`);
    const node = get(m, 'node');
    if (typeof node !== 'string' || node.length > 4 || !NODE_ID_RE.test(node)) {
      return refuse('bad-id', `requires.models[${i}].node is not a canonical step id`, preview(node));
    }
    if (seenModelNodes.has(node)) return refuse('bad-model', `requires.models pins step ${node} twice`, `requires.models[${i}]`);
    seenModelNodes.add(node);
    const model = get(m, 'model');
    const badModel = badString(model, `requires.models[${i}].model`, 1, 128, 'bad-model');
    if (badModel) return badModel;
    if (!MODEL_RE.test(model)) return refuse('bad-model', `requires.models[${i}].model is not a plain model id`, preview(model));
    if (pinned.get(node) !== model) {
      return refuse('bad-model', `requires.models says step ${node} runs a model the graph does not pin`, `requires.models[${i}]`);
    }
    // The pin follows its step into the canonical id space, so requires.models
    // names the ids the stored graph uses.
    validModels[i] = { node: canonicalId(idMap, node), model };
  }
  for (const [nodeId] of pinned) {
    if (!seenModelNodes.has(nodeId)) {
      return refuse('bad-model', `step ${nodeId} pins a model that requires.models does not list`, `missing: ${nodeId}`);
    }
  }

  const mcpServers = validateNamedRequirements(get(requires, 'mcpServers'), 'requires.mcpServers', 'name');
  if (!mcpServers.ok) return mcpServers;
  const skills = validateNamedRequirements(get(requires, 'skills'), 'requires.skills', 'id');
  if (!skills.ok) return skills;

  const workspace = get(requires, 'workspace');
  if (!isPlainObject(workspace)) return refuse('not-artifact', 'requires.workspace must be an object', preview(workspace));
  const strayW = unknownKey(workspace, WORKSPACE_KEYS);
  if (strayW !== null) return refuse('not-artifact', 'requires.workspace carries a field this Husk does not recognise', `requires.workspace: ${JSON.stringify(strayW).slice(0, 80)}`);
  const vcs = get(workspace, 'vcs');
  let bad = badEnum(vcs, 'requires.workspace.vcs', VCS_KINDS);
  if (bad) return bad;
  const markerFiles = get(workspace, 'markerFiles');
  if (!Array.isArray(markerFiles)) return refuse('not-artifact', 'requires.workspace.markerFiles must be an array', preview(markerFiles));
  if (markerFiles.length > 8) return refuse('not-artifact', 'requires.workspace.markerFiles may name at most 8 files', `length ${markerFiles.length}`);
  const validMarkers = new Array(markerFiles.length);
  for (let i = 0; i < markerFiles.length; i++) {
    const f = markerFiles[i];
    bad = badString(f, `requires.workspace.markerFiles[${i}]`, 1, 64);
    if (bad) return bad;
    // A marker is looked for inside the bound working directory on this
    // machine, so it is a plain relative file name. '/' stays legal for
    // "src/index.js"; a leading separator and a ".." segment are refused.
    if (!MARKER_FILE_RE.test(f) || f.indexOf('..') !== -1 || /^[\\/]/.test(f)) {
      return refuse('not-artifact', `requires.workspace.markerFiles[${i}] is not a plain relative file name`, preview(f));
    }
    validMarkers[i] = f;
  }
  const commands = get(workspace, 'commands');
  if (!Array.isArray(commands)) return refuse('not-artifact', 'requires.workspace.commands must be an array', preview(commands));
  if (commands.length > 8) return refuse('not-artifact', 'requires.workspace.commands may name at most 8 commands', `length ${commands.length}`);
  const validCommands = new Array(commands.length);
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    bad = badString(c, `requires.workspace.commands[${i}]`, 1, 128);
    if (bad) return bad;
    validCommands[i] = c;
  }

  const huskMin = get(requires, 'huskMin');
  bad = badString(huskMin, 'requires.huskMin', 1, 32);
  if (bad) return bad;
  if (!HUSK_VERSION_RE.test(huskMin)) return refuse('not-artifact', 'requires.huskMin must look like 2.11.0', preview(huskMin));

  return {
    ok: true,
    requires: {
      agentCommands: validAgents,
      models: validModels,
      mcpServers: mcpServers.items,
      skills: skills.items,
      workspace: {
        vcs,
        markerFiles: validMarkers,
        commands: validCommands,
      },
      huskMin,
    },
  };
}

// A file id in the canonical id space. The fallback fires only for a pin naming
// a step that is not in the file, which requires.models rejects on its own
// terms a few lines later.
function canonicalId(idMap, fileId) {
  const mapped = idMap.get(fileId);
  return mapped === undefined ? fileId : mapped;
}

// One shape for both mcpServers and skills. They differ only in the name of
// their key field, and each entry carries a name, a fingerprint and a boolean,
// which is the whole of what the format holds.
function validateNamedRequirements(list, path, keyField) {
  if (!Array.isArray(list)) return refuse('not-artifact', `${path} must be an array`, preview(list));
  if (list.length > 16) return refuse('not-artifact', `${path} may carry at most 16 entries`, `length ${list.length}`);
  const items = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isPlainObject(item)) return refuse('not-artifact', `${path}[${i}] must be an object`, preview(item));
    const stray = unknownKey(item, [keyField, 'fingerprint', 'optional']);
    if (stray !== null) {
      return refuse('not-artifact', `${path}[${i}] carries a field this Husk does not recognise`, `${path}[${i}]: ${JSON.stringify(stray).slice(0, 80)}`);
    }
    const name = get(item, keyField);
    const bad = badString(name, `${path}[${i}].${keyField}`, 1, 64);
    if (bad) return bad;
    if (!REQUIRE_NAME_RE.test(name)) return refuse('not-artifact', `${path}[${i}].${keyField} is not a plain name`, preview(name));
    if (seen.has(name)) return refuse('not-artifact', `${path} names ${name} twice`, `${path}[${i}]`);
    seen.add(name);
    const fingerprint = has(item, 'fingerprint') ? get(item, 'fingerprint') : null;
    if (fingerprint !== null) {
      if (typeof fingerprint !== 'string' || fingerprint.length !== 71 || !FINGERPRINT_RE.test(fingerprint)) {
        return refuse('not-artifact', `${path}[${i}].fingerprint must be sha256: followed by 64 lowercase hex characters`, preview(fingerprint));
      }
    }
    const optional = has(item, 'optional') ? get(item, 'optional') : false;
    if (typeof optional !== 'boolean') return refuse('not-artifact', `${path}[${i}].optional must be true or false`, preview(optional));
    const projected = { fingerprint, optional };
    projected[keyField] = name;
    items.push(projected);
  }
  return { ok: true, items };
}

// A receipt is a claim, and every cross-field rule here is a way one claim can
// contradict itself. Such a receipt is refused rather than downgraded to
// author-stated: the tier system has no floor below "refused".
function validateReceipt(r, i, topHash, budget) {
  const at = `receipts[${i}]`;
  if (!isPlainObject(r)) return refuse('receipt-invalid', `${at} must be an object`, preview(r));
  const stray = unknownKey(r, RECEIPT_KEYS);
  if (stray !== null) return refuse('receipt-invalid', `${at} carries a field this Husk does not recognise`, `${at}: ${JSON.stringify(stray).slice(0, 80)}`);

  const id = get(r, 'id');
  if (typeof id !== 'string' || id.length !== 20 || !RECEIPT_ID_RE.test(id)) {
    return refuse('receipt-invalid', `${at}.id must be rcp_ followed by 16 hex characters`, preview(id));
  }
  const rh = get(r, 'graphHash');
  if (typeof rh !== 'string' || rh.length !== GRAPH_HASH_PREFIX.length + 64 || !GRAPH_HASH_RE.test(rh)) {
    return refuse('receipt-invalid', `${at}.graphHash is not a husk-wfg-1 fingerprint`, preview(rh));
  }
  if (rh !== topHash) {
    return refuse('receipt-invalid', `${at} was earned on a different workflow than the one in this file`,
      `receipt: ${rh}\nfile:    ${topHash}`);
  }

  const runs = get(r, 'runs');
  let bad = badInt(runs, `${at}.runs`, 1, 10000, 'receipt-invalid');
  if (bad) return bad;
  const runsWindowed = get(r, 'runsWindowed');
  if (typeof runsWindowed !== 'boolean') {
    return refuse('receipt-invalid', `${at}.runsWindowed must be true or false`, preview(runsWindowed));
  }

  const window = get(r, 'window');
  if (!isPlainObject(window)) return refuse('receipt-invalid', `${at}.window must be an object`, preview(window));
  const strayWin = unknownKey(window, WINDOW_KEYS);
  if (strayWin !== null) return refuse('receipt-invalid', `${at}.window carries a field this Husk does not recognise`, `${at}.window: ${JSON.stringify(strayWin).slice(0, 80)}`);
  const windowAt = {};
  for (const k of WINDOW_KEYS) {
    const v = get(window, k);
    bad = badString(v, `${at}.window.${k}`, 1, 24, 'receipt-invalid');
    if (bad) return bad;
    windowAt[k] = v;
  }

  const outcomes = get(r, 'outcomes');
  if (!isPlainObject(outcomes)) return refuse('receipt-invalid', `${at}.outcomes must be an object`, preview(outcomes));
  const strayOut = unknownKey(outcomes, OUTCOME_KEYS);
  if (strayOut !== null) return refuse('receipt-invalid', `${at}.outcomes carries a field this Husk does not recognise`, `${at}.outcomes: ${JSON.stringify(strayOut).slice(0, 80)}`);
  let sum = 0;
  const counted = {};
  for (const k of OUTCOME_KEYS) {
    const v = get(outcomes, k);
    bad = badInt(v, `${at}.outcomes.${k}`, 0, 10000, 'receipt-invalid');
    if (bad) return bad;
    counted[k] = normInt(v);
    sum += v;
  }
  if (sum !== runs) {
    return refuse('receipt-invalid', `${at} counts ${sum} outcomes across ${runs} runs`, `${at}.outcomes`);
  }

  const outcomeBasis = get(r, 'outcomeBasis');
  bad = badEnum(outcomeBasis, `${at}.outcomeBasis`, OUTCOME_BASES, 'receipt-invalid');
  if (bad) return bad;
  const medianDurationMs = get(r, 'medianDurationMs');
  bad = badInt(medianDurationMs, `${at}.medianDurationMs`, 0, 3600000, 'receipt-invalid');
  if (bad) return bad;
  // How many runs hit the per-step SIGKILL. A censored median presented as a
  // median is a specific, correctable lie, so the count travels with it.
  const durationCensored = get(r, 'durationCensored');
  bad = badInt(durationCensored, `${at}.durationCensored`, 0, 10000, 'receipt-invalid');
  if (bad) return bad;

  const tokens = has(r, 'medianTokens') ? get(r, 'medianTokens') : null;
  let countedTokens = null;
  if (tokens !== null) {
    if (!isPlainObject(tokens)) return refuse('receipt-invalid', `${at}.medianTokens must be an object or null`, preview(tokens));
    const strayTok = unknownKey(tokens, TOKEN_KEYS);
    if (strayTok !== null) return refuse('receipt-invalid', `${at}.medianTokens carries a field this Husk does not recognise`, `${at}.medianTokens: ${JSON.stringify(strayTok).slice(0, 80)}`);
    countedTokens = {};
    for (const k of TOKEN_KEYS) {
      const v = get(tokens, k);
      bad = badInt(v, `${at}.medianTokens.${k}`, 0, 1000000000, 'receipt-invalid');
      if (bad) return bad;
      countedTokens[k] = normInt(v);
    }
  }

  const env = get(r, 'environment');
  if (!isPlainObject(env)) return refuse('receipt-invalid', `${at}.environment must be an object`, preview(env));
  const strayEnv = unknownKey(env, ENVIRONMENT_KEYS);
  if (strayEnv !== null) return refuse('receipt-invalid', `${at}.environment carries a field this Husk does not recognise`, `${at}.environment: ${JSON.stringify(strayEnv).slice(0, 80)}`);
  const agentResolved = get(env, 'agentResolved');
  bad = badEnum(agentResolved, `${at}.environment.agentResolved`, Array.from(ALLOWED_AGENT_COMMANDS), 'receipt-invalid');
  if (bad) return bad;
  const agentVersion = get(env, 'agentVersion');
  bad = badString(agentVersion, `${at}.environment.agentVersion`, 0, 32, 'receipt-invalid');
  if (bad) return bad;
  const modelResolved = has(env, 'modelResolved') ? get(env, 'modelResolved') : null;
  if (modelResolved !== null) {
    bad = badString(modelResolved, `${at}.environment.modelResolved`, 1, 128, 'receipt-invalid');
    if (bad) return bad;
    if (!MODEL_RE.test(modelResolved)) return refuse('receipt-invalid', `${at}.environment.modelResolved is not a plain model id`, preview(modelResolved));
  }
  const os = get(env, 'os');
  bad = badString(os, `${at}.environment.os`, 1, 32, 'receipt-invalid');
  if (bad) return bad;
  if (!OS_RE.test(os)) return refuse('receipt-invalid', `${at}.environment.os is not a plain platform name`, preview(os));
  const envVersion = get(env, 'huskVersion');
  bad = badString(envVersion, `${at}.environment.huskVersion`, 1, 32, 'receipt-invalid');
  if (bad) return bad;
  if (!HUSK_VERSION_RE.test(envVersion)) return refuse('receipt-invalid', `${at}.environment.huskVersion must look like 2.11.0`, preview(envVersion));

  const envWs = get(env, 'workspace');
  if (!isPlainObject(envWs)) return refuse('receipt-invalid', `${at}.environment.workspace must be an object`, preview(envWs));
  const strayEnvWs = unknownKey(envWs, ENV_WORKSPACE_KEYS);
  if (strayEnvWs !== null) return refuse('receipt-invalid', `${at}.environment.workspace carries a field this Husk does not recognise`, `${at}.environment.workspace: ${JSON.stringify(strayEnvWs).slice(0, 80)}`);
  const envWsVcs = get(envWs, 'vcs');
  bad = badEnum(envWsVcs, `${at}.environment.workspace.vcs`, VCS_KINDS, 'receipt-invalid');
  if (bad) return bad;
  const trackedFiles = get(envWs, 'trackedFiles');
  bad = badEnum(trackedFiles, `${at}.environment.workspace.trackedFiles`, TRACKED_FILES_BUCKETS, 'receipt-invalid');
  if (bad) return bad;
  const languages = get(envWs, 'languages');
  if (!Array.isArray(languages)) return refuse('receipt-invalid', `${at}.environment.workspace.languages must be an array`, preview(languages));
  if (languages.length > 4) return refuse('receipt-invalid', `${at}.environment.workspace.languages may name at most 4 languages`, `length ${languages.length}`);
  const validLanguages = new Array(languages.length);
  for (let k = 0; k < languages.length; k++) {
    const lang = languages[k];
    bad = badString(lang, `${at}.environment.workspace.languages[${k}]`, 1, 24, 'receipt-invalid');
    if (bad) return bad;
    validLanguages[k] = lang;
  }

  const evidence = get(r, 'evidence');
  bad = badEnum(evidence, `${at}.evidence`, EVIDENCE_KINDS, 'receipt-invalid');
  if (bad) return bad;
  const chain = has(r, 'chain') ? get(r, 'chain') : null;
  if (evidence === 'none' && chain !== null) {
    return refuse('receipt-invalid', `${at} says it ships no log and ships one anyway`, `${at}.evidence is "none"`);
  }
  if (evidence === 'inline' && chain === null) {
    return refuse('receipt-invalid', `${at} says it ships a log and does not`, `${at}.evidence is "inline"`);
  }

  let projectedChain = null;
  if (chain !== null) {
    const c = validateChain(chain, at, budget);
    if (!c.ok) return c;
    projectedChain = c.chain;
  }

  return {
    ok: true,
    receipt: {
      id,
      graphHash: rh,
      runs: normInt(runs),
      runsWindowed,
      window: { firstRunAt: windowAt.firstRunAt, lastRunAt: windowAt.lastRunAt },
      outcomes: {
        completed: counted.completed,
        failed: counted.failed,
        stopped: counted.stopped,
        timedOut: counted.timedOut,
      },
      outcomeBasis,
      medianDurationMs: normInt(medianDurationMs),
      durationCensored: normInt(durationCensored),
      medianTokens: countedTokens === null ? null : {
        input: countedTokens.input,
        output: countedTokens.output,
        cacheRead: countedTokens.cacheRead,
        cacheCreate: countedTokens.cacheCreate,
      },
      environment: {
        agentResolved,
        agentVersion,
        modelResolved,
        os,
        huskVersion: envVersion,
        workspace: {
          vcs: envWsVcs,
          trackedFiles,
          languages: validLanguages,
        },
      },
      evidence,
      chain: projectedChain,
    },
  };
}

// The shipped audit log, structurally only. Whether the chain hashes together
// is verifyArtifactChain's job and lands with the audit rows themselves; what
// happens here is the part that has to happen before anything reads a line:
// bounded counts, bounded strings, and a byte budget summed across every
// receipt in the file rather than applied per item.
function validateChain(chain, at, budget) {
  if (!isPlainObject(chain)) return refuse('chain-invalid', `${at}.chain must be an object or null`, preview(chain));
  const stray = unknownKey(chain, CHAIN_KEYS);
  if (stray !== null) return refuse('chain-invalid', `${at}.chain carries a field this Husk does not recognise`, `${at}.chain: ${JSON.stringify(stray).slice(0, 80)}`);

  const sessionIds = get(chain, 'sessionIds');
  if (!Array.isArray(sessionIds)) return refuse('chain-invalid', `${at}.chain.sessionIds must be an array`, preview(sessionIds));
  if (sessionIds.length < 1 || sessionIds.length > MAX_CHAIN_SESSIONS) {
    return refuse('chain-invalid', `${at}.chain.sessionIds must name between one and ${MAX_CHAIN_SESSIONS} sessions`, `length ${sessionIds.length}`);
  }
  const validSessionIds = new Array(sessionIds.length);
  for (let i = 0; i < sessionIds.length; i++) {
    const sid = sessionIds[i];
    const bad = badString(sid, `${at}.chain.sessionIds[${i}]`, 1, 128, 'chain-invalid');
    if (bad) return bad;
    if (!SESSION_ID_RE.test(sid)) {
      return refuse('chain-invalid', `${at}.chain.sessionIds[${i}] is not a plain session id`, preview(sid));
    }
    validSessionIds[i] = sid;
  }

  const head = get(chain, 'head');
  if (typeof head !== 'string' || head.length !== 71 || !FINGERPRINT_RE.test(head)) {
    return refuse('chain-invalid', `${at}.chain.head must be sha256: followed by 64 lowercase hex characters`, preview(head));
  }

  // Four rows is the floor: a start_run, a workflow_binding, at least one step
  // and a run_summary. An audit log with fewer than that describes no run.
  const lineCount = get(chain, 'lineCount');
  const badCount = badInt(lineCount, `${at}.chain.lineCount`, MIN_CHAIN_LINES, MAX_CHAIN_LINES, 'chain-invalid');
  if (badCount) return badCount;

  const lines = get(chain, 'lines');
  if (!Array.isArray(lines)) return refuse('chain-invalid', `${at}.chain.lines must be an array`, preview(lines));
  if (lines.length > MAX_CHAIN_LINES) return refuse('chain-invalid', `${at}.chain.lines has ${lines.length} rows and the limit is ${MAX_CHAIN_LINES}`, `length ${lines.length}`);
  if (lines.length !== lineCount) {
    return refuse('chain-invalid', `${at}.chain says it holds ${lineCount} rows and holds ${lines.length}`, `${at}.chain.lines`);
  }
  const validLines = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string') return refuse('chain-invalid', `${at}.chain.lines[${i}] must be a string`, preview(line));
    // Measured and added one row at a time, so the budget is checked before
    // each row is counted against it.
    const size = Buffer.byteLength(line, 'utf8');
    if (budget.bytes + size > MAX_CHAIN_BYTES) {
      return refuse('chain-invalid',
        `the logs in this file are larger than the ${MAX_CHAIN_BYTES} byte budget`,
        `${at}.chain.lines[${i}] passes the budget at ${budget.bytes + size} bytes`);
    }
    budget.bytes += size;
    if (hasLoneSurrogate(line)) return refuse('chain-invalid', `${at}.chain.lines[${i}] contains an unpaired surrogate`, `${at}.chain.lines[${i}]`);
    validLines[i] = line;
  }

  return {
    ok: true,
    chain: {
      sessionIds: validSessionIds,
      head,
      lineCount: normInt(lineCount),
      lines: validLines,
    },
  };
}

// ─── reading the shipped log ─────────────────────────────────────────────

// verifyArtifactChain(lines, sessionIds, opts) walks a shipped audit log and
// answers one question: do these rows hold together as the record of the runs
// they claim to be.
//
// It is not verifyAuditChain and it never calls it. That function tests one
// predicate, row.prev === sha256(previous line). Six are applied here:
//
//   1. at least MIN_CHAIN_LINES rows, with an empty log as its own refusal
//      rather than a length one, so a reader is told which of the two happened
//   2. every row's sid equals the session declared for the position it sits in
//   3. every row's seq equals its zero-based index inside its own session
//   4. row 0 of a session is start_run, row 1 is workflow_binding, and neither
//      kind appears anywhere else in it
//   5. the last row of a session is run_summary, so a session that stops early
//      is visible
//   6. the binding row names a graph fingerprint, and when the caller states
//      which one it expects, that exact one
//
// A passing chain means this JSONL is internally well formed and
// self-consistent. That is the whole of the claim, which is why the tier it
// earns is "matches the shipped log" and why the word "verified" appears
// nowhere near it.
//
// Only inline payloads are read. A blob_ref row is an opaque hash here: spilled
// blobs go through Electron safeStorage and are bound to the keychain of the
// machine that wrote them.
//
// sessionIds may be a single id, which is the shape the format ships today, or
// the ordered list of sessions the lines run through. Multiple sessions are
// concatenated in order and each one re-anchors at genesis, because a session
// is one audit.jsonl and each file starts its own chain.
//
// Returns { ok: true, valid: true, lineCount, head, sessionIds, sessions,
// graphHash } where each session is { sessionId, rows }, or { ok: true, valid:
// false, predicate, reason, atIndex } naming the predicate that failed and the
// row it failed at. Total: any input at all yields one of those two rather than
// a throw.
function verifyArtifactChain(lines, sessionIds, opts) {
  try {
    return verifyArtifactChainInner(lines, sessionIds, isPlainObject(opts) ? opts : {});
  } catch (_) {
    // The exception text came from the same input being refused, and a surface
    // would render it, so it does not travel.
    return chainInvalid('lines-type', 'the shipped log raised while it was being read', -1);
  }
}

function chainInvalid(predicate, reason, atIndex) {
  return { ok: true, valid: false, predicate, reason, atIndex };
}

function verifyArtifactChainInner(lines, sessionIds, opts) {
  if (!Array.isArray(lines)) {
    return chainInvalid('lines-type', 'the shipped log is not a list of rows', -1);
  }
  const declared = typeof sessionIds === 'string' ? [sessionIds] : sessionIds;
  if (!Array.isArray(declared) || declared.length < 1 || declared.length > MAX_CHAIN_SESSIONS) {
    return chainInvalid('session-ids', `a shipped log names between one and ${MAX_CHAIN_SESSIONS} sessions`, -1);
  }
  const seenIds = new Set();
  for (let i = 0; i < declared.length; i++) {
    const sid = declared[i];
    if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) {
      return chainInvalid('session-ids', `session ${i} is not a plain session id`, -1);
    }
    // Each declared session id appears once, so one session counts as one run.
    if (seenIds.has(sid)) return chainInvalid('session-ids', `session "${sid}" is named twice`, -1);
    seenIds.add(sid);
  }

  const count = lines.length;
  if (count === 0) {
    return chainInvalid('empty-log', 'the shipped log has no rows in it', -1);
  }
  if (count < MIN_CHAIN_LINES) {
    return chainInvalid('too-few-lines', `the shipped log has ${count} rows and a run leaves at least ${MIN_CHAIN_LINES}`, count - 1);
  }
  if (count > MAX_CHAIN_LINES) {
    return chainInvalid('too-many-lines', `the shipped log has ${count} rows and the limit is ${MAX_CHAIN_LINES}`, MAX_CHAIN_LINES);
  }

  const sessions = [];
  let segment = null;          // the session being walked
  let segmentIndex = -1;
  let prevHash = GENESIS_HASH;
  let graphHash = null;
  const expected = typeof opts.graphHash === 'string' ? opts.graphHash : null;

  for (let i = 0; i < count; i++) {
    const line = lines[i];
    if (typeof line !== 'string') return chainInvalid('line-type', `row ${i} is not a string`, i);
    let row;
    try { row = JSON.parse(line); } catch (_) {
      return chainInvalid('not-json', `row ${i} is not valid JSON`, i);
    }
    if (!isPlainObject(row)) return chainInvalid('row-shape', `row ${i} is not an object`, i);
    const v = get(row, 'v');
    if (v !== AUDIT_ROW_SCHEMA) {
      return chainInvalid('row-schema', `row ${i} is written in audit schema ${preview(v)} and this Husk reads ${AUDIT_ROW_SCHEMA}`, i);
    }
    const sid = get(row, 'sid');
    const seq = get(row, 'seq');
    const kind = get(row, 'kind');
    const prev = get(row, 'prev');
    if (typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) return chainInvalid('row-shape', `row ${i} has no readable session id`, i);
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return chainInvalid('row-shape', `row ${i} has no readable sequence number`, i);
    if (typeof kind !== 'string' || !kind) return chainInvalid('row-shape', `row ${i} does not say what kind of event it is`, i);
    if (typeof prev !== 'string' || prev.length !== 64 || !/^[0-9a-f]{64}$/.test(prev)) {
      return chainInvalid('row-shape', `row ${i} has no readable previous-row hash`, i);
    }

    // A session boundary is where the sid stops being the one being walked, and
    // which session may sit here is decided by the declared list rather than by
    // the rows.
    //
    // Whether the row belongs here is asked before the session it interrupts is
    // closed, so the refusal names the row that arrived rather than the short
    // session left behind.
    if (segment === null || sid !== segment.sessionId) {
      segmentIndex += 1;
      if (segmentIndex >= declared.length) {
        return chainInvalid('session-count', `row ${i} belongs to a session this log does not declare`, i);
      }
      if (sid !== declared[segmentIndex]) {
        return chainInvalid('session-order', `row ${i} names session "${sid}" where "${declared[segmentIndex]}" was declared`, i);
      }
      if (segment !== null) {
        const closed = closeChainSegment(segment);
        if (closed) return closed;
      }
      segment = { sessionId: sid, rows: [], lastIndex: i, kinds: new Map() };
      sessions.push(segment);
      prevHash = GENESIS_HASH;
    }

    if (prev !== prevHash) {
      return chainInvalid('prev-hash', `row ${i} does not follow the row before it`, i);
    }
    if (seq !== segment.rows.length) {
      return chainInvalid('seq', `row ${i} is numbered ${seq} and sits at position ${segment.rows.length} of its session`, i);
    }

    const position = segment.rows.length;
    if (position === 0 && kind !== ROW_START) {
      return chainInvalid('structure', `session "${sid}" opens with a ${kind} row rather than a ${ROW_START}`, i);
    }
    if (position === 1 && kind !== ROW_BINDING) {
      return chainInvalid('structure', `session "${sid}" does not name the graph it ran in its second row`, i);
    }
    if (position === 1) {
      const payload = get(row, 'payload');
      const declaredHash = isPlainObject(payload) ? get(payload, 'graphHash') : null;
      if (typeof declaredHash !== 'string' || !GRAPH_HASH_RE.test(declaredHash)) {
        return chainInvalid('binding', `session "${sid}" does not carry a workflow fingerprint in its binding row`, i);
      }
      if (expected !== null && declaredHash !== expected) {
        return chainInvalid('binding', `session "${sid}" was run against a different workflow than the one this receipt describes`, i);
      }
      // Sessions that disagree with each other are refused even when the caller
      // named no expectation, because a receipt is one claim about one program.
      if (graphHash !== null && declaredHash !== graphHash) {
        return chainInvalid('binding', `session "${sid}" was run against a different workflow than the sessions before it`, i);
      }
      graphHash = declaredHash;
    }
    if (position > 1 && (kind === ROW_START || kind === ROW_BINDING)) {
      return chainInvalid('structure', `session "${sid}" opens a second time at row ${i}`, i);
    }

    segment.kinds.set(kind, (segment.kinds.get(kind) || 0) + 1);
    segment.rows.push(row);
    segment.lastIndex = i;
    prevHash = sha256Hex(line);
  }

  const closed = closeChainSegment(segment);
  if (closed) return closed;
  if (sessions.length !== declared.length) {
    return chainInvalid('session-count', `this log declares ${declared.length} sessions and carries ${sessions.length}`, count - 1);
  }

  const head = `sha256:${prevHash}`;
  if (typeof opts.head === 'string' && opts.head !== head) {
    return chainInvalid('head', 'the head this file states is not the head of the rows it ships', count - 1);
  }

  return {
    ok: true,
    valid: true,
    lineCount: count,
    head,
    graphHash,
    sessionIds: sessions.map((s) => s.sessionId),
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, rows: s.rows })),
  };
}

// The two things about a session that can only be known once it has ended: it
// is long enough to describe a run, and it closed rather than stopped. Returns
// a refusal or null, so the walk above reads as one guard per boundary.
function closeChainSegment(segment) {
  if (!segment) return null;
  const rows = segment.rows;
  if (rows.length < MIN_CHAIN_LINES) {
    return chainInvalid('too-few-lines',
      `session "${segment.sessionId}" has ${rows.length} rows and a run leaves at least ${MIN_CHAIN_LINES}`,
      segment.lastIndex);
  }
  const last = rows[rows.length - 1];
  if (get(last, 'kind') !== ROW_SUMMARY) {
    return chainInvalid('structure',
      `session "${segment.sessionId}" stops without a ${ROW_SUMMARY}, so rows are missing from the end of it`,
      segment.lastIndex);
  }
  if ((segment.kinds.get(ROW_SUMMARY) || 0) !== 1) {
    return chainInvalid('structure',
      `session "${segment.sessionId}" ends more than once`,
      segment.lastIndex);
  }
  return null;
}

// What this machine can and cannot say about one receipt's figures.
//
// The answer travels as { checked, valid, agrees, detail } because those are
// three different states and a surface has to tell them apart. `checked` false
// is a receipt that shipped no log, which is the common case and carries no
// blame. `valid` false is a log that does not hold together. `agrees` false is
// a log that holds together under figures it does not support. Both failures
// collapse the receipt block rather than dropping it a tier.
function checkReceiptEvidence(receipt) {
  if (!receipt || receipt.evidence !== 'inline' || !receipt.chain) {
    return { checked: false, valid: null, agrees: null, detail: null };
  }
  const chain = receipt.chain;
  const walk = verifyArtifactChain(chain.lines, chain.sessionIds, {
    graphHash: receipt.graphHash,
    head: chain.head,
  });
  if (!walk.valid) {
    return {
      checked: true,
      valid: false,
      agrees: null,
      detail: walk.atIndex >= 0 ? `${walk.reason} (row ${walk.atIndex}, ${walk.predicate})` : `${walk.reason} (${walk.predicate})`,
    };
  }
  const derived = WorkflowReceipt.figuresFromChain(walk.sessions);
  if (!derived.ok) {
    return { checked: true, valid: false, agrees: null, detail: derived.error };
  }
  const compared = WorkflowReceipt.compareFigures(receipt, derived.figures);
  if (!compared.agrees) {
    return {
      checked: true,
      valid: true,
      agrees: false,
      detail: compared.differences
        .map((d) => `${d.field}: this file says ${d.declared}, its log says ${d.derived}`)
        .join('\n'),
    };
  }
  return { checked: true, valid: true, agrees: true, detail: null };
}

// One answer for the whole file, because a surface draws one record and asks
// one question of it. Any receipt that failed decides the answer for all of
// them.
function combineEvidenceChecks(checks) {
  const inline = checks.filter((c) => c.checked);
  if (!inline.length) return { checked: false, valid: null, agrees: null, detail: null };
  const broken = inline.find((c) => c.valid !== true);
  if (broken) return broken;
  const disagreeing = inline.find((c) => c.agrees !== true);
  if (disagreeing) return disagreeing;
  return { checked: true, valid: true, agrees: true, detail: null };
}

// ─── writing a file ──────────────────────────────────────────────────────

// The artifact id is derived rather than random so republishing the same
// workflow keeps its identity without any stored state, and so two exports of
// the same workflow from two machines agree. base36 of the first 128 bits is
// at most 25 characters, so the pad to 26 always happens and the charset is
// exactly the [0-9a-z] the format asks for.
function deriveArtifactId(seed) {
  const digest = crypto.createHash('sha256').update('husk-wfa-1:' + String(seed), 'utf8').digest();
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(digest[i]);
  return 'wfa_' + n.toString(36).slice(-26).padStart(26, '0');
}

// Layout survives export as reading order, not as canvas position. x and y are
// raw Drawflow coordinates captured at the author's zoom, so they are
// translated to the origin, rounded to the nearest 20 and clamped.
function quantiseCoordinate(v) {
  if (!Number.isFinite(v)) return 0;
  let q = Math.round(v / 20) * 20;
  if (!Number.isFinite(q) || q < 0) q = 0;
  if (q > 20000) q = 20000;
  return q === 0 ? 0 : q;
}

// buildArtifact turns a local workflow record into the bytes another machine
// will read. It refuses rather than papering over the three cases where the
// local model says less than the file format has to say: an unresolved agent,
// a routing regular expression, and two sibling step names an AI router cannot
// tell apart.
//
// opts:
//   huskVersion   required, the running app's version
//   now           () => ms, injected so this module has no clock
//   publishedAt   an explicit ISO timestamp, wins over now
//   artifactId    an existing id, for republishing
//   revision      integer, defaults to 1
//   publisher     { name, url } or null
//   notes         string or null
//   requires      { mcpServers, skills, workspace, huskMin } author-declared
//   receipts      already-aggregated receipts, [] until the receipt store lands
//
// Returns { ok: true, artifact, warnings } or { ok: false, code, message, detail }.
function buildArtifact(workflow, opts) {
  try {
    return buildArtifactInner(workflow, opts || {});
  } catch (err) {
    return refuse('bad-input', 'this workflow could not be published', err && err.message);
  }
}

function buildArtifactInner(workflow, opts) {
  if (!isPlainObject(workflow)) return refuse('bad-input', 'buildArtifact needs a workflow object', preview(workflow));
  if (!isPlainObject(opts)) return refuse('bad-input', 'buildArtifact options must be an object', preview(opts));
  const warnings = [];

  const huskVersion = get(opts, 'huskVersion');
  if (typeof huskVersion !== 'string' || huskVersion.length > 32 || !HUSK_VERSION_RE.test(huskVersion)) {
    return refuse('bad-input', 'huskVersion must look like 2.11.0', preview(huskVersion));
  }

  const g = sanitizeGraph(get(workflow, 'graph'));
  if (!g.nodes.length) return refuse('bad-input', 'this workflow has no steps to publish', 'graph.nodes is empty');
  if (g.nodes.length > MAX_NODES) {
    return refuse('too-many-nodes', `this workflow has ${g.nodes.length} steps and a published file may carry ${MAX_NODES}`, `${g.nodes.length} steps`);
  }
  if (g.edges.length > MAX_EDGES) {
    return refuse('too-many-nodes', `this workflow has ${g.edges.length} connections and a published file may carry ${MAX_EDGES}`, `${g.edges.length} connections`);
  }
  // sanitizeGraph silently drops a connection whose endpoints are gone. That
  // matches what the run engine does, so the published file is still the
  // workflow that would run here, but the author deserves to be told which
  // part of their canvas did not make it into the file.
  const rawGraph = get(workflow, 'graph');
  const rawEdges = isPlainObject(rawGraph) ? get(rawGraph, 'edges') : null;
  const rawEdgeCount = Array.isArray(rawEdges) ? rawEdges.length : g.edges.length;
  if (rawEdgeCount > g.edges.length) {
    const lost = rawEdgeCount - g.edges.length;
    warnings.push({
      code: 'edges-dropped',
      message: `${lost} connection${lost === 1 ? '' : 's'} pointed at a step that no longer exists and were left out`,
    });
  }

  // Every step must name the agent it was written for. A null resolves at run
  // time to the importer's own config.agentCommand, so a file carrying one
  // would not determine what runs and its receipts would describe a different
  // program.
  for (const n of g.nodes) {
    if (!n.agentCommand) {
      return refuse('bad-agent',
        `the step "${n.name}" does not say which agent it runs, so a published file could not say what it does`,
        `step: ${n.name}`);
    }
    const base = normalizeAgentCommand(n.agentCommand);
    if (!base || !ALLOWED_AGENT_COMMANDS.has(base)) {
      return refuse('bad-agent', `the step "${n.name}" names an agent Husk will not run`, `agentCommand: ${String(n.agentCommand).slice(0, 64)}`);
    }
    // The file carries the bare basename, so it never carries the author's
    // home directory layout either.
    n.agentCommand = base;

    if (n.model !== null && !MODEL_RE.test(n.model)) {
      return refuse('bad-model', `the model pinned on step "${n.name}" cannot be published as written`, `model: ${String(n.model).slice(0, 64)}`);
    }
    if (hasLoneSurrogate(n.name) || hasLoneSurrogate(n.prompt)) {
      return refuse('bad-input', `the step "${n.name}" contains an unpaired surrogate and cannot be published`, `step: ${n.name}`);
    }
  }

  for (const e of g.edges) {
    if (e.condition.type === 'regex') {
      if (isLiteralPattern(e.condition.value)) {
        // A pattern with no metacharacters is a substring test that happens to
        // have been typed as a regex, so it crosses as one. contains matches
        // case-insensitively, which widens the match rather than narrowing it.
        e.condition.type = 'contains';
        warnings.push({
          code: 'regex-downgraded',
          message: `a routing pattern was published as a plain "contains" match on ${e.condition.value}`,
        });
      } else {
        return refuse('regex-condition',
          'this workflow routes on a regular expression, and published workflows cannot carry one',
          `the connection from ${e.from} to ${e.to} matches ${String(e.condition.value).slice(0, 64)}`);
      }
    }
    if (hasLoneSurrogate(e.condition.value)) {
      return refuse('bad-input', 'a routing condition contains an unpaired surrogate and cannot be published', `edge: ${e.id}`);
    }
  }

  // wfResolveNext matches the model's ROUTE: line against node.name, exact
  // first and then by substring containment, so "Patch" and "Patch tests" as
  // two branches of one router are ambiguous and route by whichever the loop
  // reaches first. Publishing refuses that shape, and the reader applies the
  // same test through the same function, so the two sides stay in step.
  const collision = routingCollision(g);
  if (collision) {
    return refuse('name-collision',
      `the step "${collision.from}" routes to both "${collision.a}" and "${collision.b}", and Husk cannot tell those two names apart`,
      'rename one of them before publishing');
  }

  const projection = canonicalProjection(g);
  if (!projection.ok) return refuse('bad-input', 'this workflow could not be fingerprinted', projection.error);

  // Canonical order decides both the ids and the order the nodes are written
  // in, so the file reads the same way on every machine that produces it.
  const ordered = projection.nodes;
  let minX = Infinity;
  let minY = Infinity;
  for (const entry of ordered) {
    if (entry.source.x < minX) minX = entry.source.x;
    if (entry.source.y < minY) minY = entry.source.y;
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(minY)) minY = 0;

  const outNodes = ordered.map((entry) => ({
    id: entry.canonicalId,
    name: entry.source.name,
    agentCommand: entry.source.agentCommand,
    model: entry.source.model,
    branchMode: entry.source.branchMode,
    prompt: entry.source.prompt,
    passContext: entry.source.passContext,
    x: quantiseCoordinate(entry.source.x - minX),
    y: quantiseCoordinate(entry.source.y - minY),
  }));

  // Edge ids are reassigned in canonical order for the same reason node ids
  // are: an id minted from Date.now() is not information about the workflow.
  const outEdges = projection.projection.edges.map((e, i) => ({
    id: `e${i}`,
    from: e.from,
    to: e.to,
    condition: { type: e.condition.type, value: e.condition.value },
  }));

  const name = clampText(get(workflow, 'name'), 'Workflow', 80, warnings, 'name');
  const description = optionalText(get(workflow, 'description'), 280, warnings, 'description');
  const notes = optionalText(get(opts, 'notes'), 2000, warnings, 'notes');

  // A caller republishing an existing artifact passes its id back in. Anything
  // else derives from the local workflow id, so republishing without one still
  // keeps its identity across revisions. Falling back to the fingerprint is the
  // last resort for a workflow record with no id: the id is then stable for
  // that graph and moves when the graph does.
  const given = get(opts, 'artifactId');
  const artifactId = (typeof given === 'string' && ARTIFACT_ID_RE.test(given))
    ? given
    : deriveArtifactId(firstString(get(workflow, 'id')) || projection.hash);

  const revision = has(opts, 'revision') ? get(opts, 'revision') : 1;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 100000) {
    return refuse('bad-input', 'revision must be a whole number between 1 and 100000', preview(revision));
  }

  let publishedAt = get(opts, 'publishedAt');
  if (publishedAt === undefined || publishedAt === null) {
    const nowFn = typeof get(opts, 'now') === 'function' ? get(opts, 'now') : () => Date.now();
    const ms = Number(nowFn());
    if (!Number.isFinite(ms)) return refuse('bad-input', 'the clock returned something that is not a time', preview(ms));
    publishedAt = new Date(ms).toISOString();
  }
  if (typeof publishedAt !== 'string' || !PUBLISHED_AT_RE.test(publishedAt)) {
    return refuse('bad-input', 'publishedAt must be an ISO 8601 timestamp with milliseconds', preview(publishedAt));
  }

  let publisher = get(opts, 'publisher');
  if (publisher === undefined) publisher = null;
  if (publisher !== null) {
    if (!isPlainObject(publisher)) return refuse('bad-input', 'publisher must be an object or null', preview(publisher));
    const pname = get(publisher, 'name');
    const purl = get(publisher, 'url');
    if (typeof pname !== 'string' || pname.length < 1 || pname.length > 64) {
      return refuse('bad-input', 'publisher.name must be 1 to 64 characters', preview(pname));
    }
    if (typeof purl !== 'string' || purl.length > 256 || !PUBLISHER_URL_RE.test(purl)) {
      return refuse('bad-input', 'publisher.url must be an https:// URL of at most 256 characters', preview(purl));
    }
    publisher = { name: pname, url: purl };
  }

  const declared = isPlainObject(get(opts, 'requires')) ? get(opts, 'requires') : {};
  const workspaceIn = isPlainObject(get(declared, 'workspace')) ? get(declared, 'workspace') : {};
  const requires = {
    agentCommands: Array.from(new Set(outNodes.map((n) => n.agentCommand))).sort(),
    models: outNodes.filter((n) => n.model !== null).map((n) => ({ node: n.id, model: n.model })),
    mcpServers: normalizeNamedRequirements(get(declared, 'mcpServers'), 'name'),
    skills: normalizeNamedRequirements(get(declared, 'skills'), 'id'),
    workspace: {
      vcs: get(workspaceIn, 'vcs') === 'git' ? 'git' : 'none',
      markerFiles: normalizeMarkerFiles(get(workspaceIn, 'markerFiles'), warnings),
      commands: normalizeCommands(get(workspaceIn, 'commands'), warnings),
    },
    huskMin: normalizeHuskMin(get(declared, 'huskMin'), huskVersion, warnings),
  };

  const receipts = Array.isArray(get(opts, 'receipts')) ? get(opts, 'receipts') : [];

  const artifact = {
    kind: ARTIFACT_KIND,
    schemaVersion: MAX_ARTIFACT_SCHEMA,
    artifactId,
    revision,
    name,
    description,
    publishedAt,
    publisher,
    huskVersion,
    graph: { nodes: outNodes, edges: outEdges },
    graphHash: projection.hash,
    requires,
    // A receipt claims the graph it was earned on, and the only graph this
    // file can honestly claim is the one just fingerprinted.
    receipts: receipts.map((r) => (isPlainObject(r) ? Object.assign({}, r, { graphHash: projection.hash }) : r)),
    notes,
  };

  // Read back what was just written. Export and import share one definition of
  // a valid file, so a refusal here names a bug in this module rather than a
  // user error, and it surfaces at the moment it is introduced.
  const check = validateArtifact(artifact);
  if (!check.ok) return check;

  // A log this machine attached is a log this machine must be able to walk. The
  // read-back above proves the file is legal; this proves the evidence in it
  // supports the figures printed next to it, which is the only reason to ship a
  // log at all. A receipt this module's own reader would collapse surfaces here
  // rather than on a reader's screen a week later.
  if (check.chainCheck.checked) {
    if (check.chainCheck.valid !== true) {
      return refuse('chain-invalid', 'the log Husk attached to this file does not hold together', check.chainCheck.detail);
    }
    if (check.chainCheck.agrees !== true) {
      return refuse('receipt-invalid', 'the log Husk attached does not support the figures beside it', check.chainCheck.detail);
    }
  }

  return {
    ok: true,
    artifact: check.artifact,
    warnings: warnings.concat(check.warnings),
    chainCheck: check.chainCheck,
  };
}

function firstString() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (typeof v === 'string' && v.length) return v;
  }
  return '';
}

// Local records are not held to the file format's lengths, so a long title is
// shortened and the warning says so. The shortening goes through clipText
// rather than String.slice, so a cut never lands inside an astral character.
function clampText(value, fallback, max, warnings, field) {
  let v = typeof value === 'string' ? value : '';
  if (hasLoneSurrogate(v)) v = '';
  v = v.trim();
  if (!v) return fallback;
  if (v.length > max) {
    warnings.push({ code: 'truncated', message: `${field} was shortened to ${max} characters for the published file` });
    return clipText(v, max);
  }
  return v;
}

function optionalText(value, max, warnings, field) {
  if (typeof value !== 'string') return null;
  let v = hasLoneSurrogate(value) ? '' : value;
  if (!v) return null;
  if (v.length > max) {
    warnings.push({ code: 'truncated', message: `${field} was shortened to ${max} characters for the published file` });
    v = clipText(v, max);
  }
  return v;
}

// The author's declared workspace, reduced to what the format can hold.
//
// These three requirements are clamped and warned about here rather than left
// for the self-check at the bottom of buildArtifactInner. Clamping is the same
// trade normalizeNamedRequirements makes for mcpServers and skills: what the
// format can carry goes in the file, what it cannot is named in a warning, and
// a declaration the author typed as documentation never sinks their export.
function normalizeMarkerFiles(list, warnings) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let dropped = 0;
  for (const raw of list) {
    if (out.length >= 8) { dropped += 1; continue; }
    // The same rule the reader enforces, including the leading separator: a
    // marker is a plain relative file name.
    if (typeof raw !== 'string' || raw.length < 1 || raw.length > 64
      || !MARKER_FILE_RE.test(raw) || raw.indexOf('..') !== -1 || /^[\\/]/.test(raw)) {
      dropped += 1;
      continue;
    }
    out.push(raw);
  }
  if (dropped) {
    warnings.push({
      code: 'requirement-dropped',
      message: `${dropped} declared marker file${dropped === 1 ? '' : 's'} could not be published, because a marker is a plain relative file name of at most 64 characters`,
    });
  }
  return out;
}

function normalizeCommands(list, warnings) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let dropped = 0;
  let shortened = 0;
  for (const raw of list) {
    if (out.length >= 8) { dropped += 1; continue; }
    if (typeof raw !== 'string') { dropped += 1; continue; }
    const trimmed = raw.trim();
    if (!trimmed || hasLoneSurrogate(trimmed)) { dropped += 1; continue; }
    if (trimmed.length > 128) shortened += 1;
    out.push(clipText(trimmed, 128));
  }
  if (dropped) {
    warnings.push({
      code: 'requirement-dropped',
      message: `${dropped} declared build command${dropped === 1 ? '' : 's'} could not be published, because a published file carries at most 8 of them`,
    });
  }
  if (shortened) {
    warnings.push({
      code: 'truncated',
      message: `${shortened} declared build command${shortened === 1 ? ' was' : 's were'} shortened to 128 characters for the published file`,
    });
  }
  return out;
}

function normalizeHuskMin(value, huskVersion, warnings) {
  if (typeof value === 'string' && value.length >= 1 && value.length <= 32 && HUSK_VERSION_RE.test(value)) return value;
  if (value !== undefined && value !== null && value !== '') {
    warnings.push({
      code: 'requirement-dropped',
      message: `the declared minimum Husk version was published as ${huskVersion}, because a minimum has to read like 2.11.0 and fit in 32 characters`,
    });
  }
  return huskVersion;
}

// The author's declared MCP servers and skills, reduced to the only three
// fields the format has. Anything else the caller passed is dropped here
// rather than at validation, so the invariant at the top of this file holds:
// a command or an env never exists in this object at all.
function normalizeNamedRequirements(list, keyField) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const name = get(item, keyField);
    if (typeof name !== 'string' || !REQUIRE_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const fingerprint = get(item, 'fingerprint');
    const projected = {
      fingerprint: (typeof fingerprint === 'string' && FINGERPRINT_RE.test(fingerprint)) ? fingerprint : null,
      optional: get(item, 'optional') === true,
    };
    projected[keyField] = name;
    out.push(projected);
    if (out.length >= 16) break;
  }
  return out;
}

module.exports = {
  ARTIFACT_KIND,
  MAX_ARTIFACT_SCHEMA,
  GRAPH_HASH_PREFIX,
  MAX_ARTIFACT_BYTES,
  MAX_CHAIN_BYTES,
  MAX_NODES,
  MAX_EDGES,
  MAX_RECEIPTS,
  MIN_CHAIN_LINES,
  MAX_CHAIN_LINES,
  MAX_CHAIN_SESSIONS,
  GENESIS_HASH,
  CHAIN_PREDICATES,
  ROW_START,
  ROW_BINDING,
  ROW_SUMMARY,
  REFUSAL_CODES,
  EXPORT_REFUSAL_CODES,
  TRACKED_FILES_BUCKETS,
  canonicalProjection,
  graphHash,
  buildArtifact,
  parseArtifact,
  validateArtifact,
  verifyArtifactChain,
  checkReceiptEvidence,
  // exported for unit tests; not part of the public API.
  _internal: { normalizeAgentCommand, isLiteralPattern, hasLoneSurrogate, quantiseCoordinate, deriveArtifactId },
};
