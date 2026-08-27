'use strict';

// The artifact ledger: one list of everything a run left behind.
//
// Husk already records two kinds of run, in two stores, with two shapes. A
// workflow run keeps its steps, their durations and the tail of each step's
// scrollback. An autopilot run keeps its goal, the files it touched and what it
// spent. Both are things you might want to read a week later, and until now
// each was only reachable from the page that produced it.
//
// This module is the reader. It invents no store and writes nothing: it takes
// what those two handlers already return and produces one sorted list in one
// shape, so a single surface can show both.
//
// The shape is deliberately lossy in one direction only. Every row carries what
// the two sources agree on, plus a `detail` holding the original untouched, so
// a surface that wants the step list or the halt reason still has it and
// nothing had to be guessed to fit a common shape.
//
// Figures are never invented. A run that recorded no token usage carries null
// rather than zero, because zero is a measurement and null is the absence of
// one, and a ledger that cannot tell them apart is not worth reading.
//
// Pure: no fs, no clock, no Electron.

// What a run ended up as, in words this ledger uses. The two stores spell their
// outcomes differently, so both are mapped onto these rather than shown raw.
const OUTCOMES = ['done', 'failed', 'halted', 'running', 'unknown'];

const SOURCES = ['workflow', 'autopilot'];

// A workflow run's status, as the run engine writes it.
const WORKFLOW_OUTCOME = {
  done: 'done',
  completed: 'done',
  failed: 'failed',
  error: 'failed',
  running: 'running',
  cancelled: 'halted',
  canceled: 'halted',
  stopped: 'halted',
};

// An autopilot session's status, as the audit log writes it.
const AUTOPILOT_OUTCOME = {
  done: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  failed: 'failed',
  error: 'failed',
  halted: 'halted',
  stopped: 'halted',
  cancelled: 'halted',
  running: 'running',
  active: 'running',
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// A number that was actually measured, or null. Zero is a measurement and
// survives; anything unreadable is an absence and says so.
function figure(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function millis(iso) {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? t : 0;
}

function outcome(raw, table) {
  const key = String(raw == null ? '' : raw).toLowerCase().trim();
  return table[key] || 'unknown';
}

// ─── token usage ─────────────────────────────────────────────────────────

// One step's vendor usage report, summed. Only some agents report at all, so an
// absent report is null rather than zero and does not drag a run's total down
// to a number nobody measured.
function stepTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  let total = 0;
  let seen = false;
  for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    const n = Number(usage[key]);
    if (Number.isFinite(n) && n >= 0) { total += n; seen = true; }
  }
  return seen ? total : null;
}

// A run's tokens, which exist only if at least one step reported. A run where
// no step reported carries null, not zero.
function runTokens(steps) {
  if (!Array.isArray(steps)) return null;
  let total = 0;
  let seen = false;
  for (const st of steps) {
    const n = stepTokens(st && st.usage);
    if (n !== null) { total += n; seen = true; }
  }
  return seen ? total : null;
}

// ─── rows ────────────────────────────────────────────────────────────────

function workflowRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, 120);
  if (!id) return null;
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const env = raw.environment && typeof raw.environment === 'object' ? raw.environment : null;
  return {
    key: `workflow:${id}`,
    id,
    source: 'workflow',
    title: str(raw.workflowName, 200) || 'Workflow run',
    outcome: outcome(raw.status, WORKFLOW_OUTCOME),
    startedAt: str(raw.startedAt, 40),
    endedAt: str(raw.finishedAt, 40),
    ms: figure(raw.ms),
    // What this kind of run produced, and what it did not. A workflow run has
    // steps and no file count; the two nulls are what let one list hold both
    // without a column meaning different things in different rows.
    steps: steps.length,
    files: null,
    tokens: runTokens(steps),
    dollars: null,
    agent: env ? str(env.agentResolved, 40) : '',
    workspace: '',
    failedStep: str(raw.failedStep, 200),
    // Only the newest runs keep their scrollback; the rest are a summary, and
    // the row says which it is rather than opening onto an empty log.
    hasLog: steps.some((st) => Array.isArray(st && st.entries) && st.entries.length > 0),
    detail: raw,
  };
}

function autopilotRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.sessionId, 120);
  if (!id) return null;
  return {
    key: `autopilot:${id}`,
    id,
    source: 'autopilot',
    title: str(raw.goal, 200) || 'Autopilot run',
    outcome: outcome(raw.status, AUTOPILOT_OUTCOME),
    startedAt: str(raw.capturedAt, 40),
    endedAt: str(raw.endedAt, 40),
    ms: (millis(raw.endedAt) && millis(raw.capturedAt))
      ? Math.max(0, millis(raw.endedAt) - millis(raw.capturedAt))
      : null,
    steps: null,
    files: figure(raw.fileCount),
    tokens: figure(raw.tokens),
    dollars: figure(raw.dollars),
    agent: str(raw.agent, 40),
    workspace: str(raw.workspaceRoot, 400),
    failedStep: '',
    hasLog: false,
    detail: raw,
  };
}

// ─── the ledger ──────────────────────────────────────────────────────────

// Both stores as one list, newest first.
//
// Ordering is by when a run ended, falling back to when it started, because a
// run still going has no end and belongs at the top rather than the bottom.
function buildLedger({ workflowRuns, autopilotRuns } = {}) {
  const rows = [];
  for (const raw of (Array.isArray(workflowRuns) ? workflowRuns : [])) {
    const row = workflowRow(raw);
    if (row) rows.push(row);
  }
  for (const raw of (Array.isArray(autopilotRuns) ? autopilotRuns : [])) {
    const row = autopilotRow(raw);
    if (row) rows.push(row);
  }
  const when = (r) => (r.outcome === 'running' ? Infinity : (millis(r.endedAt) || millis(r.startedAt)));
  return rows.sort((a, b) => when(b) - when(a) || a.title.localeCompare(b.title));
}

// Rows matching a query, a source and an outcome. Literal matching, over the
// title, the agent and the workspace: a ledger is scanned, and a gapped match
// over a goal sentence answers nothing a reader would recognise.
function filterLedger(rows, { query, source, outcome: want } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const src = SOURCES.includes(source) ? source : '';
  const out = OUTCOMES.includes(want) ? want : '';
  return list.filter((r) => {
    if (src && r.source !== src) return false;
    if (out && r.outcome !== out) return false;
    if (!q) return true;
    return `${r.title} ${r.agent} ${r.workspace}`.toLowerCase().includes(q);
  });
}

// What a set of rows adds up to. Every figure is either measured or absent, and
// the counts say how many rows a total was measured over so a reader can tell a
// small number from a thinly measured one.
function summarise(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const sum = { runs: list.length, done: 0, failed: 0, halted: 0, running: 0 };
  let ms = 0;
  let msRows = 0;
  let tokens = 0;
  let tokenRows = 0;
  let dollars = 0;
  let dollarRows = 0;
  let files = 0;

  for (const r of list) {
    if (Object.prototype.hasOwnProperty.call(sum, r.outcome)) sum[r.outcome] += 1;
    if (r.ms !== null) { ms += r.ms; msRows += 1; }
    if (r.tokens !== null) { tokens += r.tokens; tokenRows += 1; }
    if (r.dollars !== null) { dollars += r.dollars; dollarRows += 1; }
    if (r.files !== null) files += r.files;
  }
  return {
    ...sum,
    ms: msRows ? ms : null,
    msRows,
    tokens: tokenRows ? tokens : null,
    tokenRows,
    dollars: dollarRows ? dollars : null,
    dollarRows,
    files,
  };
}

module.exports = {
  OUTCOMES,
  SOURCES,
  buildLedger,
  filterLedger,
  summarise,
  // exported for unit tests; not part of the public API.
  _internal: { workflowRow, autopilotRow, stepTokens, runTokens, outcome },
};
