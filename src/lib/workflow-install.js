'use strict';

// Installing an imported workflow: the parts that are arithmetic rather than
// I/O.
//
// workflow-artifact.js decides whether a .husk.json is a Husk workflow at all.
// This module answers the next two questions, both about THIS machine rather
// than about the file: will the thing in the file run here, and is this run
// allowed to start. main.js owns every syscall behind those answers (statting a
// marker file, asking git whether a directory is a work tree, walking PATH) and
// hands the results in as plain facts, which is what makes this a unit test.
//
// Two rules run through the file.
//
// A check never degrades and never substitutes. If the manifest asks for codex
// and codex is not here, the answer is "codex is not on your PATH". The three
// severities carry two different facts: `block` is "will not run here",
// `caution` is "will run differently than the receipt describes", `ok` is
// neither.
//
// Every check carries the tier it was earned at, so a surface draws a verdict
// together with where the verdict came from. `computed` means this machine
// measured it just now. `said` means the file's author asserted it: no field in
// a node declares which MCP server or skill a step uses, that fact lives in
// prose inside the prompt, so requires.mcpServers and requires.skills are
// membership claims whose shape is all that can be checked.
//
// Nothing here throws and nothing here reaches the filesystem, the clock or
// Electron. Every read of the artifact is defensive.

const crypto = require('crypto');
const { stableJson } = require('./stable-json');

// The severities, in the order a surface should sort by when it wants the one
// row that stops the install to be findable without reading.
const SEVERITY_RANK = { block: 0, caution: 1, ok: 2 };

// Why a run was refused. Closed, because the consent gate and the install
// sheet both key their recovery copy off these strings.
const RUN_REFUSAL_CODES = [
  // The record says it came from a file and the consent row is not there. Its
  // own code rather than another consent-required, because the cure differs:
  // consent-required is answered by reading the prompts in the gate, and this
  // one is answered by reinstalling from the file.
  'sidecar-missing',
  'consent-required',
  'cwd-required',
  'cwd-is-home',
  'cwd-not-a-directory',
  'cwd-not-a-work-tree',
];

// The sidecar store's own version. Separate from the artifact's schemaVersion
// because they change for unrelated reasons: this one moves when the row shape
// moves, and the row shape is ours rather than the wire's.
const SIDECAR_STORE_VERSION = 1;

const ORIGINS = ['imported', 'local'];

// ─── fingerprints ────────────────────────────────────────────────────────

// An MCP server's identity for comparison purposes, over its command and args
// only. MCP identity in this app is the key in the shared server map, so the
// fingerprint is what turns "you have one with that name" into "you have one
// with that name and it is not this one".
//
// env is excluded: two installations never share the same env, so including it
// would make every legitimate installation mismatch.
//
// A remote server has no command to hash and gets null rather than a hash of
// its URL, so the surface says "cannot compare" rather than showing a tick it
// has not earned.
function mcpFingerprint(server) {
  try {
    if (!server || typeof server !== 'object') return null;
    const command = typeof server.command === 'string' ? server.command : '';
    if (!command) return null;
    const args = Array.isArray(server.args) ? server.args.map((a) => String(a)) : [];
    return `sha256:${sha256Hex(stableJson({ args, command }))}`;
  } catch (_) {
    return null;
  }
}

// A skill's identity is the bytes of its SKILL.md, for the same reason a
// server's is its command line: skill identity today is a directory name under
// the agent's skills folder, and two people's `deploy` skill have nothing in
// common but four letters.
function skillFingerprint(bytes) {
  try {
    if (typeof bytes !== 'string' && !Buffer.isBuffer(bytes)) return null;
    return `sha256:${sha256Hex(bytes)}`;
  } catch (_) {
    return null;
  }
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, Buffer.isBuffer(input) ? undefined : 'utf8').digest('hex');
}

// ─── preflight ───────────────────────────────────────────────────────────

// evaluatePreflight(artifact, facts) turns a validated manifest plus a
// snapshot of this machine into the rows the install sheet draws.
//
// facts, all gathered by main.js:
//   agentsOnPath   { claude: true, codex: false, ... } for the commands the
//                  manifest names. A name absent from the map is treated as
//                  absent from PATH, because an unanswered probe is not a pass.
//   mcpServers     [{ name, fingerprint }] for the servers configured here.
//                  fingerprint may be null when the entry is remote.
//   skills         [{ id, fingerprint }] for the skills installed here.
//   markerFiles    { 'package.json': true } existence in the bound directory.
//   cwd            the absolute bound directory, or null when unbound.
//   cwdIsDir       whether that path is a directory right now.
//   cwdIsHome      whether it resolves to the user's home directory.
//   cwdInWorkTree  whether git calls it part of a work tree.
//   huskVersion    this build's version.
//
// Returns { ok: true, checks, blocking, cautions, oks } or { ok: false, error }.
// Every check has a stable `id` so the surface can key a DOM node off it and
// repaint one row without rebuilding the list.
function evaluatePreflight(artifact, facts) {
  try {
    return evaluatePreflightInner(artifact, facts || {});
  } catch (_) {
    // The message is not quoted back: it came from the same input being
    // refused, and a surface would render it.
    return { ok: false, error: 'preflight could not be computed: an input raised while it was being read' };
  }
}

function evaluatePreflightInner(artifact, facts) {
  if (!isObject(artifact)) return { ok: false, error: 'preflight needs a validated artifact object' };
  const requires = isObject(artifact.requires) ? artifact.requires : null;
  if (!requires) return { ok: false, error: 'this artifact carries no requires block' };

  const checks = [];

  // The directory comes first because it is the only row that changes what
  // every row under it means. A marker file check against no directory is not
  // a failure, it is a question nobody asked yet.
  checks.push(workspaceCheck(requires, facts));

  for (const name of arrayOf(requires.agentCommands)) {
    const present = facts.agentsOnPath && facts.agentsOnPath[name] === true;
    checks.push({
      id: `agent:${name}`,
      kind: 'agent',
      name,
      status: present ? 'ok' : 'block',
      tier: 'computed',
      title: present ? `${name} is on your PATH` : `${name} is not on your PATH`,
      note: present
        ? 'every step that names this agent will run the same program the author ran'
        : 'this workflow names that agent on at least one step, and Husk will not substitute another one for it',
      fix: present ? null : { kind: 'install-agent', label: `Install ${name}`, value: name },
    });
  }

  // One row for the pins rather than one per pinned step. An imported
  // workflow's agentCommand is concrete, so a pin always goes to the vendor it
  // was written for and there is nothing to report per step.
  const models = arrayOf(requires.models);
  if (models.length) {
    const distinct = uniqueStrings(models.map((m) => (isObject(m) ? m.model : null)));
    checks.push({
      id: 'models',
      kind: 'model',
      name: distinct.join(', '),
      status: 'ok',
      tier: 'computed',
      title: `${models.length} step${models.length === 1 ? '' : 's'} pin${models.length === 1 ? 's' : ''} a model`,
      note: `the pins will be passed through: ${distinct.join(', ')}`,
      fix: null,
    });
  }

  for (const req of arrayOf(requires.mcpServers)) {
    checks.push(namedCheck(req, 'name', 'mcp', arrayOf(facts.mcpServers), 'name', {
      absentNote: 'the workflow\'s prompts expect a server with this name; Husk will not add one from a manifest, so add it yourself from the MCP page',
      fix: { kind: 'open-mcp-form', label: 'Add server' },
      thing: 'server',
    }));
  }

  for (const req of arrayOf(requires.skills)) {
    checks.push(namedCheck(req, 'id', 'skill', arrayOf(facts.skills), 'id', {
      absentNote: 'the workflow\'s prompts expect a skill with this name, and Husk cannot install one from a manifest',
      fix: { kind: 'open-skills', label: 'Open skills' },
      thing: 'skill',
    }));
  }

  const workspace = isObject(requires.workspace) ? requires.workspace : {};
  const bound = typeof facts.cwd === 'string' && facts.cwd ? facts.cwd : null;
  for (const marker of arrayOf(workspace.markerFiles)) {
    if (typeof marker !== 'string' || !marker) continue;
    const found = !!(facts.markerFiles && facts.markerFiles[marker] === true);
    checks.push({
      id: `marker:${marker}`,
      kind: 'marker',
      name: marker,
      status: bound ? (found ? 'ok' : 'caution') : 'caution',
      tier: bound ? 'computed' : 'said',
      title: !bound
        ? `${marker} has not been looked for yet`
        : (found ? `${marker} found in ${bound}` : `${marker} is not in ${bound}`),
      note: !bound
        ? 'pick the directory this workflow will run in and Husk will look for it there'
        : (found
          ? 'the author named this file as something their prompts assume'
          : 'the author\'s prompts were written against a project that has this file, so a step that says "run the test suite" may mean a command this directory does not have'),
      fix: bound ? null : { kind: 'pick-cwd', label: 'Choose directory' },
    });
  }

  // Commands are pure prose from the author and there is nothing to check
  // them against, so they get one informational row in the author-states tier
  // rather than a per-command probe that would imply Husk had run them.
  const commands = arrayOf(workspace.commands).filter((c) => typeof c === 'string' && c);
  if (commands.length) {
    checks.push({
      id: 'commands',
      kind: 'command',
      name: commands.join(', '),
      status: 'ok',
      tier: 'said',
      title: `the author states this workflow uses ${commands.join(', ')}`,
      note: 'nothing in a step declares its tooling, so this is the author\'s word and Husk has not run any of it here',
      fix: null,
    });
  }

  checks.push(huskVersionCheck(requires.huskMin, facts.huskVersion));

  let blocking = 0;
  let cautions = 0;
  let oks = 0;
  for (const c of checks) {
    if (c.status === 'block') blocking += 1;
    else if (c.status === 'caution') cautions += 1;
    else oks += 1;
  }
  return { ok: true, checks, blocking, cautions, oks };
}

// The bound-directory row. Every refusal workflows:run can produce about a
// directory has a matching row here, so a user never gets as far as pressing
// Run and being told something the sheet already knew.
function workspaceCheck(requires, facts) {
  const workspace = isObject(requires.workspace) ? requires.workspace : {};
  const needsGit = workspace.vcs === 'git';
  const cwd = typeof facts.cwd === 'string' && facts.cwd ? facts.cwd : null;
  const base = { id: 'cwd', kind: 'workspace', name: cwd || '', tier: 'computed' };

  if (!cwd) {
    return Object.assign(base, {
      status: 'block',
      title: 'this workflow has no directory to run in',
      note: 'an imported workflow never inherits whichever folder you last looked at; it runs where you say and nowhere else',
      fix: { kind: 'pick-cwd', label: 'Choose directory' },
    });
  }
  if (facts.cwdIsHome === true) {
    return Object.assign(base, {
      status: 'block',
      title: 'that is your home directory',
      note: 'a stranger\'s agent steps get edit access to everything under the directory you bind, so the home directory is refused outright',
      fix: { kind: 'pick-cwd', label: 'Choose another' },
    });
  }
  if (facts.cwdIsDir !== true) {
    return Object.assign(base, {
      status: 'block',
      title: 'that path is not a directory',
      note: 'the bound path is resolved and checked again immediately before the first step spawns',
      fix: { kind: 'pick-cwd', label: 'Choose another' },
    });
  }
  if (needsGit && facts.cwdInWorkTree !== true) {
    return Object.assign(base, {
      status: 'block',
      title: 'that directory is not inside a git work tree',
      note: 'this workflow declares it needs version control, which is also what makes an agent\'s edits reviewable and undoable',
      fix: { kind: 'pick-cwd', label: 'Choose another' },
    });
  }
  return Object.assign(base, {
    status: 'ok',
    title: `will run in ${cwd}`,
    note: needsGit
      ? 'inside a git work tree, which is what this workflow declares it needs'
      : 'every step runs here and the path is shown in the run header before the first one starts',
    fix: { kind: 'pick-cwd', label: 'Change' },
  });
}

// One MCP server or one skill, checked against what is installed here. The two
// differ only in which key carries the name, which is why they share this.
function namedCheck(req, keyField, kind, local, localKey, copy) {
  const name = isObject(req) && typeof req[keyField] === 'string' ? req[keyField] : '';
  const optional = isObject(req) && req.optional === true;
  const declared = isObject(req) && typeof req.fingerprint === 'string' ? req.fingerprint : null;
  const id = `${kind}:${name}`;
  const found = local.find((entry) => isObject(entry) && entry[localKey] === name) || null;

  if (!found) {
    return {
      id,
      kind,
      name,
      status: optional ? 'caution' : 'block',
      tier: 'computed',
      title: `you have no ${copy.thing} called ${name}`,
      note: optional
        ? `${copy.absentNote}; the author marked it optional, so the workflow is expected to run without it`
        : copy.absentNote,
      fix: copy.fix,
    };
  }
  const localPrint = typeof found.fingerprint === 'string' ? found.fingerprint : null;
  if (!declared) {
    return {
      id,
      kind,
      name,
      status: 'caution',
      tier: 'said',
      title: `you have a ${copy.thing} called ${name}`,
      note: 'the author shipped no fingerprint for it, so Husk cannot tell whether yours is the one this was written against',
      fix: null,
    };
  }
  if (!localPrint) {
    return {
      id,
      kind,
      name,
      status: 'caution',
      tier: 'said',
      title: `you have a ${copy.thing} called ${name}`,
      note: 'yours cannot be fingerprinted here, so the author\'s fingerprint has nothing to be compared against',
      fix: null,
    };
  }
  if (localPrint === declared) {
    return {
      id,
      kind,
      name,
      status: 'ok',
      tier: 'computed',
      title: `your ${copy.thing} ${name} matches the author's`,
      note: 'the fingerprints are equal over the full 64 characters',
      fix: null,
    };
  }
  // Not a blocker. The workflow still runs; it runs against a different thing
  // than the receipts describe, which is exactly what `caution` is for.
  return {
    id,
    kind,
    name,
    status: 'caution',
    tier: 'computed',
    title: `you have a ${copy.thing} called ${name}; it is not the one this was written against`,
    note: 'the names match and the fingerprints do not, so any run history in this file describes a different setup than yours',
    fix: null,
    detail: { declared, local: localPrint },
  };
}

// huskMin is a caution rather than a blocker. The graph has already been read
// field by field by this build, so the row reports a version difference rather
// than stranding a workflow that runs.
function huskVersionCheck(huskMin, huskVersion) {
  const min = typeof huskMin === 'string' ? huskMin : '';
  const here = typeof huskVersion === 'string' ? huskVersion : '';
  const cmp = compareVersions(here, min);
  if (!min || !here || cmp === null || cmp >= 0) {
    return {
      id: 'husk',
      kind: 'husk',
      name: min || here,
      status: 'ok',
      tier: 'computed',
      title: min ? `written for Husk ${min} or newer` : 'no Husk version was declared',
      note: min ? `you are on ${here}` : '',
      fix: null,
    };
  }
  return {
    id: 'husk',
    kind: 'husk',
    name: min,
    status: 'caution',
    tier: 'computed',
    title: `written for Husk ${min}, and you are on ${here}`,
    note: 'the graph itself has already been read and checked field by field by this build, so this is a note rather than a stop',
    fix: { kind: 'update-husk', label: 'Check for updates' },
  };
}

// Numeric dotted-prefix comparison. Returns a negative number, zero, a
// positive number, or null when either side is not a version. Only the three
// leading numeric components are compared, so 2.11.0-beta.3 orders as 2.11.0.
function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function versionParts(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// ─── the run gate ────────────────────────────────────────────────────────

// runGateDecision decides whether one Run press is allowed to reach spawn.
//
// input:
//   sidecar        the stored row for this workflow, or null when the
//                  workflow was authored here. A null sidecar is the ordinary
//                  local case and passes untouched, so a hand-built workflow
//                  runs with the gate never touching it.
//   cwd            the resolved absolute directory the run would use, or null.
//   cwdIsDir / cwdIsHome / cwdInWorkTree   the same probes preflight used,
//                  re-run at the moment of the press so the answer describes
//                  the directory as it stands now.
//
// Returns { ok: true, cwd } where cwd is null for a locally authored workflow
// (the caller keeps its existing fallback chain in that case), or
// { ok: false, code, message, detail } with code drawn from RUN_REFUSAL_CODES.
function runGateDecision(input) {
  const opts = isObject(input) ? input : {};
  const sidecar = isObject(opts.sidecar) ? opts.sidecar : null;

  // The record's own origin is consulted before the sidecar, because a missing
  // row is not evidence of local authorship.
  //
  // origin is stamped on the record at install, and no manifest and no update
  // can set it. When it says imported and the row is gone, that is an imported
  // workflow whose consent record is lost, and the answer is to refuse.
  const recordOrigin = typeof opts.recordOrigin === 'string' ? opts.recordOrigin : null;
  if (recordOrigin === 'imported' && !sidecar) {
    return refusal('sidecar-missing',
      opts.storeUnreadable === true
        ? 'this workflow came from a file, and the record of what you agreed to could not be read'
        : 'this workflow came from a file, and the record of what you agreed to is gone',
      'reinstall it from the file to review its steps again');
  }

  // Locally authored workflows are not gated. The gate covers prompts that
  // arrived in a file, and a workflow the user typed here did not.
  if (!sidecar || sidecar.origin !== 'imported') return { ok: true, cwd: null };

  if (!sidecar.consentedAt) {
    return refusal('consent-required',
      'this workflow came from a file someone else wrote, and its steps have not been reviewed yet',
      'read the prompts, then confirm to run');
  }

  const cwd = typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : null;
  if (!cwd) {
    return refusal('cwd-required',
      'this workflow has no directory bound to it',
      'an imported workflow runs where you say and never in whichever folder was last open');
  }
  if (opts.cwdIsHome === true) {
    return refusal('cwd-is-home',
      'this workflow is bound to your home directory, which Husk will not run an imported workflow in',
      cwd);
  }
  if (opts.cwdIsDir !== true) {
    return refusal('cwd-not-a-directory',
      'the directory this workflow is bound to is not there any more',
      cwd);
  }
  const needsGit = !!(sidecar.artifact
    && isObject(sidecar.artifact.requires)
    && isObject(sidecar.artifact.requires.workspace)
    && sidecar.artifact.requires.workspace.vcs === 'git');
  if (needsGit && opts.cwdInWorkTree !== true) {
    return refusal('cwd-not-a-work-tree',
      'this workflow declares it needs git, and the directory it is bound to is not inside a work tree',
      cwd);
  }
  return { ok: true, cwd };
}

function refusal(code, message, detail) {
  return {
    ok: false,
    code,
    message: String(message),
    detail: (detail === undefined || detail === null) ? null : String(detail).slice(0, 512),
  };
}

// ─── the sidecar store ───────────────────────────────────────────────────

// One row per workflow that came from a file, keyed by the local workflow id.
//
// The requires and receipts blocks live here rather than on the workflow
// record. workflows:create and workflows:update each apply a field whitelist,
// and keeping the artifact in its own file keyed on the local id means those
// whitelists stay as they are.
function normalizeStore(raw) {
  const store = { version: SIDECAR_STORE_VERSION, rows: {} };
  if (!isObject(raw)) return store;
  const rows = isObject(raw.rows) ? raw.rows : null;
  if (!rows) return store;
  for (const key of Object.keys(rows)) {
    const row = normalizeRow(key, rows[key]);
    if (row) store.rows[key] = row;
  }
  return store;
}

// Normalizes one row read back off disk into the exact field set the gate
// reads, so a partial row from an older build resolves to known values.
function normalizeRow(workflowId, raw) {
  if (typeof workflowId !== 'string' || !workflowId) return null;
  if (!isObject(raw)) return null;
  const origin = ORIGINS.indexOf(raw.origin) === -1 ? 'imported' : raw.origin;
  return {
    workflowId,
    origin,
    artifact: isObject(raw.artifact) ? raw.artifact : null,
    boundCwd: typeof raw.boundCwd === 'string' && raw.boundCwd ? raw.boundCwd : null,
    installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : null,
    // Absence means "not consented". Anything that is not a non-empty string
    // is null here, so the gate asks the user again.
    consentedAt: typeof raw.consentedAt === 'string' && raw.consentedAt ? raw.consentedAt : null,
  };
}

function sidecarRow(input) {
  const opts = isObject(input) ? input : {};
  return normalizeRow(typeof opts.workflowId === 'string' ? opts.workflowId : '', {
    origin: opts.origin,
    artifact: opts.artifact,
    boundCwd: opts.boundCwd,
    installedAt: opts.installedAt,
    consentedAt: opts.consentedAt === undefined ? null : opts.consentedAt,
  });
}

// Deleting a workflow prunes its row, and a row whose workflow is gone for any
// other reason goes with it. Duplicating a workflow mints a new local id and
// never calls this, so a duplicate carries no sidecar row of its own.
function pruneStore(store, liveIds) {
  const normalized = normalizeStore(store);
  const live = new Set(Array.isArray(liveIds) ? liveIds.filter((id) => typeof id === 'string') : []);
  const rows = {};
  let removed = 0;
  for (const key of Object.keys(normalized.rows)) {
    if (live.has(key)) rows[key] = normalized.rows[key];
    else removed += 1;
  }
  return { store: { version: SIDECAR_STORE_VERSION, rows }, removed };
}

// ─── export naming ───────────────────────────────────────────────────────

// The filename a published workflow defaults to. Lowercase, dash-separated and
// ASCII only, so it round-trips through a checkout, a tarball and a review.
function slugForName(name) {
  const base = typeof name === 'string' ? name : '';
  const slug = base
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'workflow';
}

function artifactFileName(name) {
  return `${slugForName(name)}.husk.json`;
}

// ─── small totals ────────────────────────────────────────────────────────

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function arrayOf(v) {
  return Array.isArray(v) ? v : [];
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string' || !v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

module.exports = {
  SEVERITY_RANK,
  RUN_REFUSAL_CODES,
  SIDECAR_STORE_VERSION,
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
  // exported for unit tests; not part of the public API.
  _internal: { compareVersions, versionParts, namedCheck, huskVersionCheck },
};
