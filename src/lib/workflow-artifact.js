'use strict';

// The portable workflow artifact: build one, fingerprint one, and read one a
// stranger wrote.
//
// A .husk.json file carries a workflow graph, a fingerprint of that graph, the
// concrete things it needs in order to run, and receipts from runs on someone
// else's machine. This module is the whole trust boundary for that file. The
// boundary is the byte: everything inside the file, including its own
// graphHash and its own receipts, is attacker-controlled and is treated that
// way.
//
// sanitizeGraph in workflow-graph.js is NOT a trust boundary and is not used
// as one here. It caps six strings, allowlists two enums and one basename, and
// is blind to collection sizes, id types, executable paths and the fact that
// the prompt text it preserves perfectly is the payload. It runs in this file
// only as a belt over the braces, after the real checks, to prove that nothing
// was lost between what we validated and what the run engine will see.
//
// Two invariants that a later convenience patch has to violate on purpose:
//
//   1. NO VALUE FROM A MANIFEST MAY REACH mcp:add, mcp:addMany OR
//      mcp:parseSnippet ON ANY CODE PATH. requires.mcpServers and
//      requires.skills carry a charset-constrained name, an optional
//      fingerprint and a boolean, and nothing else: no command, no args, no
//      env, no url, no headers. A manifest that could describe an MCP server
//      is a manifest that can start a local process with attacker-chosen argv.
//      The installer's "add server" affordance opens the empty MCP form and
//      never prefills it.
//
//   2. agentCommand is a bare basename from a five-entry allowlist, always.
//      isAllowedAgentCommand checks only the basename, so "./claude" and
//      "/tmp/claude" pass it while spawn resolves them against the run's cwd.
//      A repo shipping an executable called claude next to its manifest is
//      remote code execution on the first Run. Here the value must already
//      equal its own normalised basename, so anything carrying a separator,
//      an extension or a capital letter is refused outright rather than
//      quietly rewritten.
//
// The module is pure: no fs, no clock (the caller injects opts.now the way the
// autonomy supervisor does), no Electron, no spawn. That is what lets the
// hostile fixtures run as ordinary unit tests. Reading the file off disk, with
// its size check and its symlink confinement, belongs to main.js.
//
// Every exported function is total. Any input, including a hostile object with
// throwing getters, yields either a validated result or a structured refusal.
// A validator that throws is a validator that crashed the app.

const crypto = require('crypto');
const { stableJson } = require('./stable-json');
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
// both numbers named, and never partially parsed. There is no structural
// sniffing: migrateWorkflow guesses at shape, which is exactly how it would
// read a future artifact as a v1 workflow, drop requires and receipts, and
// report success.
const MAX_ARTIFACT_SCHEMA = 1;

// The prefix is load-bearing and is part of the compared string. When the
// canonicalisation rule changes, old files keep husk-wfg-1 and the reader can
// say "canonicalised by an older rule set, receipts shown as author-stated"
// instead of "fingerprint mismatch", which would read as tampering.
const GRAPH_HASH_PREFIX = 'husk-wfg-1:sha256:';

const MAX_ARTIFACT_BYTES = 1024 * 1024;
// Summed across every chain of every receipt, not applied per item. The
// schema's own per-item maxima multiply out to two gigabytes of schema-legal
// file, which is a denial of service with a passing validator.
const MAX_CHAIN_BYTES = 512 * 1024;

const MAX_NODES = 64;
const MAX_EDGES = 256;
const MAX_RECEIPTS = 8;
const MAX_PROMPT = 8192;

// Safety ceilings for canonicalProjection, which is also reachable from the
// export side where the graph is local rather than hostile. They sit far above
// the wire format's caps so they never fire on a real file; they exist so a
// pathological local graph cannot hang the main process inside a sort.
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
// A model id is handed to a third-party CLI's argument parser. Anything that
// could start a flag, a path or a shell word is out. Local free-text model
// pins are untouched by this; only the wire format is constrained.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUIRE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MARKER_FILE_RE = /^[A-Za-z0-9._/-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const OS_RE = /^[A-Za-z0-9._-]{1,32}$/;
const PUBLISHER_URL_RE = /^https:\/\//;

const BRANCH_MODES = ['parallel', 'ai'];
const PASS_CONTEXTS = ['full', 'last50', 'none'];
// regex is absent on purpose. wfEdgeMatches compiles the value with new RegExp
// in the main process and runs it against agent output, and the same file
// supplies both the pattern and, through the preceding step's prompt, the
// subject. 256 characters is far more than catastrophic backtracking needs.
const CONDITION_TYPES = ['always', 'contains', 'otherwise'];
const VCS_KINDS = ['git', 'none'];
const EVIDENCE_KINDS = ['none', 'inline'];
// The only v1 basis for an outcome count. The UI is contractually bound to
// render it, so the sentence is always "26 of 31 runs finished with a zero
// exit" and never a percentage under the word PASS.
const OUTCOME_BASES = ['process-exit'];
// A coarse bucket rather than a count, because a tracked-file count is a
// fingerprint of the author's repository and is not comparable across two of
// them anyway.
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

// Own-property reads throughout. An object whose prototype supplies `kind`
// would otherwise pass the first check while carrying none of the fields we
// think we validated, and JSON.parse itself will happily give us an own
// "__proto__" data property that the unknown-key check has to be able to see.
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

// A short, bounded description of a rejected value, for the refusal's detail
// slot. Never the value itself: the whole point of some of these refusals is
// that the value is ten megabytes long, and the detail ends up in a DOM node.
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

// JSON.stringify escapes lone surrogates as \udXXX under well-formed
// stringify, so an unpaired half survives a round trip through the file and
// arrives in a prompt that gets handed to a CLI and rendered in a pane. It is
// not text, it is a decoder bug waiting for a consumer, and no honest workflow
// contains one. Checked by code unit rather than by regex because the regex
// form of this needs a lookbehind to be correct and reads like a puzzle.
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

// Length before charset, everywhere, without exception. A ten-megabyte string
// must never reach a matcher, however cheap that matcher looks.
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

// F1's normalisation, in one place so import and export cannot disagree about
// what a basename is. Returns '' when there is nothing usable left.
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

// canonicalProjection reduces a graph to the part of it that decides what runs.
//
// The fingerprint cannot be taken over sanitizeGraph's output as emitted:
// that output carries layout coordinates and node-${Date.now()}-${rand} ids,
// so hashing it directly means dragging a node across the canvas detaches
// every receipt ever earned. What survives here is the six fields that
// determine behaviour, plus the shape of the wiring.
//
// Node order is by content hash, with position in graphToOrderedSteps as the
// tie-break, so two authors who built the same workflow in a different order
// publish the same fingerprint. That is also why the ids in a published file
// look shuffled relative to reading order, and why every surface renders step
// names rather than ids.
//
// Step names are inside the hash on purpose. wfResolveNext routes AI branches
// by matching the model's ROUTE: line against node.name, so a step name is
// executable text and renaming one is a behavioural change. Edge multiplicity
// and edge order are inside it for the same reason, argued where they are
// projected below.
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
    // deterministic for a given graph. Duplicate ids collapse in this map; the
    // first occurrence wins and anything unmapped sorts last, which keeps the
    // comparator total even for a graph the id validator would have refused.
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

    // Position in the source array is the last tie-break. Two nodes identical
    // in content and unreachable in the same way would otherwise depend on the
    // engine's sort being stable, which is true in V8 and is not a contract
    // this file should be resting on.
    entries.sort((a, b) => {
      if (a.contentHash !== b.contentHash) return a.contentHash < b.contentHash ? -1 : 1;
      if (a.tie !== b.tie) return a.tie - b.tie;
      return a.index - b.index;
    });

    const idMap = new Map();
    for (let i = 0; i < entries.length; i++) idMap.set(entries[i].id, `n${i}`);

    // Edges keep their condition, their endpoints, their multiplicity and their
    // position, and lose only their own ids.
    //
    // The format spec asks for the opposite here: collapse exact duplicates,
    // then sort what survives, so that appending a duplicate wire or reversing
    // the edge array leaves the fingerprint alone. Both of those transforms are
    // behavioural, and the run engine is where that is settled rather than here.
    // wfIsAiRouted decides that a step is an AI router by counting its outgoing
    // edges (workflow-graph.js:164-168), and wfRunStep appends the entire ROUTE
    // instruction, target names included, to the agent's system prompt as soon
    // as an ai-mode step has two of them (main.js:5699-5700), so a second
    // identical wire between one pair of steps rewrites the text handed to the
    // CLI. contextFor concatenates each taken incoming edge's output in
    // edge-declaration order (main.js:5831-5841), so reversing the array
    // reverses the order two predecessors' work appears in the next step's
    // prompt. Under the spec's rule those pairs share one fingerprint, which
    // means a receipt earned by one vouches for the other and the whole
    // "these receipts belong to this workflow" claim is not true.
    //
    // The cost of this direction is that a rewiring which changes nothing about
    // what runs, say two unrelated edges swapping places in the array, does move
    // the hash and does detach receipts that could have been kept. That is the
    // safe way for this to be wrong: a fingerprint that moves too eagerly loses
    // history, and a fingerprint that does not move signs off on a program
    // nobody read.
    const projectedEdges = [];
    for (const e of g.edges) {
      const from = idMap.get(e.from);
      const to = idMap.get(e.to);
      // Unreachable while sanitizeGraph, three lines up, is the only source of
      // g: it drops every edge whose endpoints are not nodes, and every node id
      // is a key of the map. It stays because the alternative to skipping an
      // unmappable edge is writing undefined into the thing being hashed.
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

// parseArtifact takes the file's bytes and nothing else. The statSync that
// keeps a two gigabyte file from being read into memory in the first place
// belongs to the caller, because this module has no fs; the length check here
// is the second half of that pair and the only one the drag-drop path gets.
function parseArtifact(bytes) {
  try {
    let text;
    if (typeof bytes === 'string') {
      // Two checks, not one. A string of half a million astral characters is
      // under the character cap and over the byte cap, and the byte cap is the
      // one the file on disk will be measured against.
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
// carried forward. It is total by construction and by this try/catch: the
// input may be a hostile object with getters that throw, and a refusal is
// always a better outcome than a stack trace in the main process.
//
// Every scalar is read from the input exactly once, into a local, and every
// later use, the check, the hash and the returned projection alike, is of that
// local. The input is not always JSON.parse output: the exported signature
// invites a caller to hand over an object it built, and an accessor that
// answers "claude" the first time and "/tmp/claude" the second would otherwise
// put a value no check ever saw into the record that gets installed. A getter
// that throws is caught below and refused loudly; a getter that merely lies has
// to be structurally impossible, and reading once is what makes it so.
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

  // additionalProperties: false, enforced rather than assumed. The existing
  // store carries unknown top-level keys through migrateWorkflow's ...rest and
  // through the update handler's spread, so a key smuggled onto disk once is
  // permanent. A stranger's file is the worst possible place to be generous.
  const strayTop = unknownKey(obj, TOP_KEYS);
  if (strayTop !== null) {
    return refuse('not-artifact', 'this file carries a field this Husk does not recognise', `top level: ${JSON.stringify(strayTop).slice(0, 80)}`);
  }

  // Counts, before anything is mapped over. A hundred thousand nodes must
  // never reach a .map, a sort, or a hash.
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
    // https only. The string is rendered and may be opened; a javascript: or
    // file: publisher URL is a link nobody meant to click.
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

  // Node ids, before any other node field and before sanitizeGraph. Validating
  // them here is what lets us close the id hole without touching a function
  // four other call sites depend on.
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

    // Layout is quantised by the exporter, and a file whose coordinates are
    // not on the grid was not written by that exporter. Refusing is cheap and
    // keeps one fewer shape of number flowing into the canvas.
    const x = get(n, 'x');
    const y = get(n, 'y');
    bad = badInt(x, `graph.nodes[${i}].x`, 0, 20000) || badInt(y, `graph.nodes[${i}].y`, 0, 20000);
    if (bad) return bad;
    if (x % 20 !== 0 || y % 20 !== 0) {
      return refuse('not-artifact', `graph.nodes[${i}] has a position off the 20 pixel grid`, `x ${x}, y ${y}`);
    }

    // The agent basename. The value must already BE its own normalised form:
    // "./claude" normalises to "claude" and is still refused, because a file
    // that carries a path is a file written to exploit a resolver, and
    // quietly rewriting it would hide that from the person deciding whether to
    // install it.
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

  // Belt over braces. sanitizeGraph is what the run engine will see, so if it
  // would drop anything we validated, the file describes a workflow that is
  // not the workflow that would run. An edge pointing at a step that is not in
  // the file is the concrete case. It runs over the validated copy rather than
  // over the input, so the graph that gets fingerprinted is provably the graph
  // that was checked.
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
  // router wired to both "Patch" and "Patch tests" runs whichever of the two the
  // loop reaches first and says nothing about having guessed. buildArtifact
  // refuses to publish that; without the same test here, the one shape Husk will
  // not write is a shape a stranger's file is free to carry and the author of
  // that file simply picks the other side of the boundary. The format spec
  // scopes this rule to export and its closed reader enum has no member for it,
  // so the refusal travels as not-artifact with both names in the message.
  const collision = routingCollision(sanitized);
  if (collision) {
    return refuse('not-artifact',
      `the step "${collision.from}" routes to both "${collision.a}" and "${collision.b}", and Husk cannot tell those two names apart`,
      `${collision.a} / ${collision.b}`);
  }

  // The graph is stored in canonical order under canonical ids, not in the
  // order the file happened to list them. Node ids are only pattern-checked, so
  // a file can carry n0, n7, n2, n999 and can list its steps in any order at
  // all while still matching its own fingerprint, and graphToOrderedSteps seeds
  // its walk from the node array (workflow-graph.js:116-117), which is the
  // order the workflow list, the run view and the imported-workflow consent
  // gate all read. Two files with one fingerprint would then install as two
  // records that read differently, which is precisely what a fingerprint is
  // supposed to rule out. Reprojecting here costs nothing for a file this
  // module wrote, since buildArtifact already emits canonical order, and makes
  // "one fingerprint, one record" true rather than customary.
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

  const warnings = [];
  if (!projectedReceipts.length) {
    warnings.push({ code: 'no-receipts', message: 'this workflow ships no run history' });
  } else if (projectedReceipts.every((r) => r.evidence === 'none')) {
    warnings.push({ code: 'attested-only', message: 'every figure in this file is stated by its author with no log attached' });
  }

  // The allowlist projection. Every value here is a local that passed a check
  // above, never a second read of the input, so nothing unrecognised and
  // nothing unvalidated can reach the sidecar store or the workflow record even
  // if a check is later loosened by accident.
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

  return { ok: true, artifact, warnings };
}

// The one sibling-name ambiguity wfResolveNext cannot resolve, found on a
// sanitized graph so export and import can share a single definition of it and
// cannot drift into disagreeing about which files are publishable. A target
// whose name trims to nothing is skipped, because the containment fallback
// requires a non-empty name (workflow-graph.js:196) and refusing on one would
// refuse a file the engine routes unambiguously.
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
  if (agentCommands.length < 1 || agentCommands.length > 5) {
    return refuse('bad-agent', 'requires.agentCommands must name between one and five agents', `length ${agentCommands.length}`);
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
  // The declared requirement and the graph have to agree. A file that runs
  // gemini while its requirements pane says claude is describing a workflow
  // that is not the one it ships, and the requirements pane is the thing the
  // installer reads before deciding.
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
    // The pin follows its step into the canonical id space. Anything else would
    // leave requires.models pointing at ids the stored graph no longer uses.
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
    // These are checked against the bound working directory on this machine and
    // the answer is rendered back, so a marker is an existence oracle for
    // whatever path it names. "../../.ssh/id_rsa" is the obvious probe and was
    // already refused; "/root/.ssh/id_rsa" is the same probe written the other
    // way, and the charset admitted it because '/' has to be legal for
    // "src/index.js" to be. Whether it escapes depends on whether the caller
    // joins or resolves, which is not a decision this file gets to make.
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

// A file id in the canonical id space. Every id reaching this has been matched
// against NODE_ID_RE and every node id in the graph is a key of the map, so the
// fallback only ever fires for a pin naming a step that is not in the file,
// which requires.models rejects on its own terms a few lines later.
function canonicalId(idMap, fileId) {
  const mapped = idMap.get(fileId);
  return mapped === undefined ? fileId : mapped;
}

// One shape for both mcpServers and skills. They differ only in the name of
// their key field, and they carry a name, a fingerprint and a boolean because
// anything richer is an instruction to install something.
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

// A receipt is a claim, and every cross-field rule here is a way a claim can
// contradict itself. A receipt contradicted by its own contents is worse than
// no receipt, so this refuses rather than downgrading the figures to
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
  if (sessionIds.length < 1 || sessionIds.length > 32) {
    return refuse('chain-invalid', `${at}.chain.sessionIds must name between one and 32 sessions`, `length ${sessionIds.length}`);
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
  // and a run_summary. An audit log with fewer than that describes no run, and
  // an empty one passes the raw chain verifier by doing nothing at all.
  const lineCount = get(chain, 'lineCount');
  const badCount = badInt(lineCount, `${at}.chain.lineCount`, 4, 4000, 'chain-invalid');
  if (badCount) return badCount;

  const lines = get(chain, 'lines');
  if (!Array.isArray(lines)) return refuse('chain-invalid', `${at}.chain.lines must be an array`, preview(lines));
  if (lines.length > 4000) return refuse('chain-invalid', `${at}.chain.lines has ${lines.length} rows and the limit is 4000`, `length ${lines.length}`);
  if (lines.length !== lineCount) {
    return refuse('chain-invalid', `${at}.chain says it holds ${lineCount} rows and holds ${lines.length}`, `${at}.chain.lines`);
  }
  const validLines = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (typeof line !== 'string') return refuse('chain-invalid', `${at}.chain.lines[${i}] must be a string`, preview(line));
    // Measured and added one row at a time so the budget cannot be blown
    // before it is checked. A single row past the whole budget refuses here
    // rather than after a megabyte of concatenation.
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
// raw Drawflow coordinates captured at the author's zoom, so shipping them
// verbatim would ship noise, and shipping them unquantised would move the
// fingerprint every time somebody nudged a node. Translate to the origin,
// round to the nearest 20, clamp.
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
  // time to config.agentCommand || 'claude', so a file carrying one would not
  // determine what runs: a claude-tuned workflow would execute on the
  // importer's gemini and the receipt would describe a different program.
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
        // case-insensitively where a regex did not, which widens the match
        // rather than narrowing it: the alternative is refusing a workflow
        // that behaves identically in every case its author has ever run.
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
  // two branches of one router are mutually ambiguous by construction and
  // mis-route silently. Better to refuse at publish than to ship a workflow
  // that runs the wrong step on somebody else's machine. The reader applies the
  // same test through the same function, so the two sides cannot drift into
  // disagreeing about which files exist.
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
  // that graph and moves when the graph does, which is worse than the
  // alternative and better than random.
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

  // Read back what we just wrote. Export and import share one definition of a
  // valid file, so a refusal here means this module would have published
  // something it would itself refuse to install, which is a bug rather than a
  // user error, and it should surface as one at the moment it is introduced.
  const check = validateArtifact(artifact);
  if (!check.ok) return check;

  return { ok: true, artifact: check.artifact, warnings: warnings.concat(check.warnings) };
}

function firstString() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (typeof v === 'string' && v.length) return v;
  }
  return '';
}

// Local records are not held to the file format's lengths, and refusing to
// publish because a title is long would be a worse answer than shortening it
// and saying so. The shortening goes through clipText rather than String.slice
// because a cut that lands inside an astral character manufactures the very
// unpaired surrogate the self-check below refuses, which turned a long emoji
// title into a reader-side "not-artifact" out of a publish button and blamed
// the author for a half character this function had just created.
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
// These three are the only requirements the caller supplies that used to be
// copied through and measured for the first time by the self-check at the
// bottom of buildArtifactInner, which meant that a build command longer than
// 128 characters, a marker file written as a glob, or a huskMin with trailing
// junk (HUSK_VERSION_RE is unanchored at the tail on purpose, so "1.0.0" plus
// sixty characters matches it and then fails the length cap) came back to the
// publisher as the reader's "not-artifact" code, which is the code that means
// "this file is not a Husk workflow" and has no export-side story at all. They
// are clamped and warned about here, the same trade normalizeNamedRequirements
// already makes for mcpServers and skills: what the format can carry goes in
// the file, what it cannot is named in a warning, and nothing about a
// declaration the author typed as documentation can sink their export.
function normalizeMarkerFiles(list, warnings) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let dropped = 0;
  for (const raw of list) {
    if (out.length >= 8) { dropped += 1; continue; }
    // The same rule the reader enforces, including the leading separator: a
    // marker is resolved against somebody else's working directory, so an
    // absolute path is a probe rather than a build file.
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
// rather than at validation, because the point of the invariant at the top of
// this file is that a command or an env never exists in this object at all.
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
  REFUSAL_CODES,
  EXPORT_REFUSAL_CODES,
  TRACKED_FILES_BUCKETS,
  canonicalProjection,
  graphHash,
  buildArtifact,
  parseArtifact,
  validateArtifact,
  // exported for unit tests; not part of the public API.
  _internal: { normalizeAgentCommand, isLiteralPattern, hasLoneSurrogate, quantiseCoordinate, deriveArtifactId },
};
